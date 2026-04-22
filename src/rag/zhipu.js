import { loadCodexApiConfig } from "../config/codex-config.js";

const ZHIPU_EMBEDDING_URL = "https://open.bigmodel.cn/api/paas/v4/embeddings";
const ZHIPU_EMBEDDING_MODEL = "embedding-3";

function buildFakeEmbeddingVector(text) {
  const source = String(text || "");
  return [
    /海|礁|潮/.test(source) ? 1 : 0,
    /港|船|帆/.test(source) ? 1 : 0,
    /对白|命令|短促/.test(source) ? 1 : 0,
    /压迫|紧绷|冷/.test(source) ? 1 : 0,
    Math.min(1, source.length / 400),
    /李凡|主角/.test(source) ? 1 : 0,
  ];
}

export class ZhipuEmbeddingError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ZhipuEmbeddingError";
    this.status = options.status || null;
  }
}

function flattenNumericValues(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenNumericValues(item, output);
    }
    return output;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return output;
    }

    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      try {
        return flattenNumericValues(JSON.parse(trimmed), output);
      } catch {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
          output.push(parsed);
        }
        return output;
      }
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      output.push(parsed);
    }
    return output;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    output.push(parsed);
  }
  return output;
}

function normalizeVector(value) {
  return flattenNumericValues(value, []);
}

function compactPayloadSnippet(payload) {
  try {
    return JSON.stringify(payload).slice(0, 260);
  } catch {
    return String(payload || "").slice(0, 260);
  }
}

function extractEmbeddingVector(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const candidates = [];

  if (Array.isArray(payload.data) && payload.data.length) {
    candidates.push(payload.data[0]?.embedding);
    for (const item of payload.data) {
      candidates.push(item?.embedding);
    }
  }

  candidates.push(
    payload.embedding,
    payload?.data?.embedding,
    payload?.result?.embedding,
    payload?.output?.embedding,
  );

  for (const candidate of candidates) {
    const vector = normalizeVector(candidate);
    if (vector.length) {
      return vector;
    }
  }

  return [];
}

function resolveApiKey(rootDir = process.cwd()) {
  const codexConfig = loadCodexApiConfig(rootDir);
  const fileData = codexConfig.data || {};
  return String(
    fileData.zhipu_api_key ||
    process.env.ZHIPU_API_KEY ||
    "",
  ).trim();
}

async function requestEmbedding(text, rootDir = process.cwd()) {
  const fakeEmbeddingsMode = String(process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS || "").trim();
  if (fakeEmbeddingsMode === "fail") {
    throw new ZhipuEmbeddingError("Zhipu embedding request failed: fake embedding failure");
  }
  if (fakeEmbeddingsMode === "true") {
    return buildFakeEmbeddingVector(text);
  }

  const apiKey = resolveApiKey(rootDir);
  if (!apiKey) {
    throw new ZhipuEmbeddingError("Missing ZHIPU_API_KEY or novelex.codex.toml zhipu_api_key.");
  }

  const response = await fetch(ZHIPU_EMBEDDING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: ZHIPU_EMBEDDING_MODEL,
      input: String(text || ""),
    }),
  });

  const rawText = await response.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = {
      rawText,
    };
  }
  if (!response.ok) {
    throw new ZhipuEmbeddingError(
      `Zhipu embedding request failed: ${response.status} ${payload?.error?.message || payload?.message || payload?.msg || rawText || ""}`.trim(),
      { status: response.status },
    );
  }

  if (
    payload?.error ||
    payload?.code && String(payload.code) !== "200" && String(payload.code) !== "0"
  ) {
    throw new ZhipuEmbeddingError(
      `Zhipu embedding response reported an error: ${payload?.error?.message || payload?.message || payload?.msg || compactPayloadSnippet(payload)}`.trim(),
      { status: response.status },
    );
  }

  const vector = extractEmbeddingVector(payload);
  if (!vector.length) {
    throw new ZhipuEmbeddingError(
      `Zhipu embedding response did not include a usable vector. payload=${compactPayloadSnippet(payload)}`,
      { status: response.status },
    );
  }

  return vector;
}

async function mapWithConcurrency(items, worker, concurrency = 3) {
  const input = Array.isArray(items) ? items : [];
  if (!input.length) {
    return [];
  }

  const results = new Array(input.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < input.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await worker(input[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), input.length) }, () => runWorker()),
  );
  return results;
}

export function createZhipuEmbeddingClient(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  return {
    endpoint: ZHIPU_EMBEDDING_URL,
    model: ZHIPU_EMBEDDING_MODEL,
    isConfigured() {
      if (["true", "fail"].includes(String(process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS || "").trim())) {
        return true;
      }
      return Boolean(resolveApiKey(rootDir));
    },
    async embedText(text) {
      return requestEmbedding(text, rootDir);
    },
    async embedTexts(texts, options = {}) {
      return mapWithConcurrency(
        texts,
        (text) => requestEmbedding(text, rootDir),
        Number(options.concurrency || 3),
      );
    },
  };
}
