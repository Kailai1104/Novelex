import { extractJsonObject, safeJsonParse } from "../core/text.js";

function visitJsonLike(node, visitor, visited = new WeakSet()) {
  if (!node) {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item) => visitJsonLike(item, visitor, visited));
    return;
  }
  if (typeof node !== "object") {
    return;
  }
  if (visited.has(node)) {
    return;
  }
  visited.add(node);

  visitor(node);

  if (Array.isArray(node.content)) {
    for (const item of node.content) {
      if (typeof item?.text === "string") {
        const parsed = safeJsonParse(extractJsonObject(item.text), null);
        if (parsed && typeof parsed === "object") {
          visitJsonLike(parsed, visitor, visited);
        }
      }
      if (item?.json && typeof item.json === "object") {
        visitJsonLike(item.json, visitor, visited);
      }
    }
  }

  for (const value of Object.values(node)) {
    visitJsonLike(value, visitor, visited);
  }
}

function collectResultItems(raw) {
  const seen = new Set();
  const results = [];

  function push(candidate) {
    if (!candidate || typeof candidate !== "object") {
      return;
    }
    const url = String(
      candidate.url ||
      candidate.link ||
      candidate.source_url ||
      candidate.sourceUrl ||
      "",
    ).trim();
    if (!url || seen.has(url)) {
      return;
    }
    seen.add(url);
    results.push({
      title: String(candidate.title || candidate.name || url).trim(),
      url,
      snippet: String(candidate.snippet || candidate.excerpt || candidate.summary || candidate.text || "").trim(),
    });
  }

  visitJsonLike(raw, (node) => {
    if (Array.isArray(node.results)) {
      node.results.forEach(push);
    }
    if (Array.isArray(node.sources)) {
      node.sources.forEach(push);
    }
    if (Array.isArray(node.items)) {
      node.items.forEach(push);
    }
    if ((node.url || node.link) && (node.title || node.name || node.snippet || node.excerpt)) {
      push(node);
    }
  });

  return results;
}

function extractTextFragments(raw) {
  const fragments = [];
  visitJsonLike(raw, (node) => {
    if (typeof node.text === "string" && node.text.trim()) {
      fragments.push(node.text.trim());
    }
  });
  return fragments;
}

export function normalizeWebSearchToolResult(raw, args = {}) {
  const results = collectResultItems(raw).slice(0, 12);
  const query = String(
    args?.query ||
    raw?.structuredContent?.query ||
    raw?.query ||
    "",
  ).trim();

  return {
    query,
    results,
    textFragments: extractTextFragments(raw).slice(0, 12),
    raw,
  };
}

export function normalizeLocalRagToolResult(raw) {
  let structured = raw?.structuredContent;
  if (!structured || typeof structured !== "object") {
    structured = safeJsonParse(
      extractJsonObject(
        raw?.content?.find((item) => typeof item?.text === "string")?.text || "",
      ),
      {},
    ) || {};
  }

  return {
    matches: Array.isArray(structured.matches) ? structured.matches : [],
    summary: String(structured.summary || "").trim(),
    warnings: Array.isArray(structured.warnings) ? structured.warnings.map((item) => String(item || "").trim()).filter(Boolean) : [],
    raw,
  };
}
