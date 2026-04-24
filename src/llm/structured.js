import { createExcerpt, extractJsonObject, safeJsonParse } from "../core/text.js";
import { createProvider } from "./provider.js";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

export function parseStructuredObject(result, label = "StructuredAgent") {
  const parsed = safeJsonParse(extractJsonObject(result?.text || ""), null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 返回了无法解析的 JSON：${createExcerpt(result?.text || "", 240)}`);
  }
  return parsed;
}

export async function generateStructuredObject(provider, {
  label = "StructuredAgent",
  instructions,
  input,
  agentComplexity,
  useReviewModel = false,
  model,
  tools,
  toolChoice,
  include,
  reasoningEffort,
  metadata,
  temperature,
  normalize = null,
} = {}) {
  if (!provider?.generateText) {
    throw new Error(`${label} 缺少可用 provider。`);
  }

  const result = await provider.generateText({
    instructions,
    input,
    agentComplexity,
    useReviewModel,
    model,
    tools,
    toolChoice,
    include,
    reasoningEffort,
    metadata,
    temperature,
  });
  const parsed = parseStructuredObject(result, label);
  return typeof normalize === "function" ? normalize(parsed, result) : parsed;
}

export function createMiniMaxValidationProvider(projectState, {
  rootDir = process.cwd(),
  ...options
} = {}) {
  const provider = createProvider(projectState, {
    ...options,
    rootDir,
    providerIdOverride: "MiniMax",
  });

  if (provider?.settings?.providerId !== "MiniMax") {
    throw new Error(
      `MiniMax 验证 provider 初始化失败，当前实际 provider 为 ${provider?.settings?.providerId || "unknown"}。`,
    );
  }

  return provider;
}

export function ensureMiniMaxValidationProvider(provider, label = "validation") {
  if (provider?.settings?.providerId !== "MiniMax") {
    throw new Error(
      `${label} 只允许使用 MiniMax，当前实际 provider 为 ${provider?.settings?.providerId || "unknown"}。`,
    );
  }
  return provider;
}

export function structuredErrorMessage(error, label = "StructuredAgent") {
  return `${label} 失败：${errorMessage(error)}`;
}
