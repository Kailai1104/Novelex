import path from "node:path";

import { createContextSource, mergeContextSources } from "../core/input-governance.js";
import { createExcerpt, extractJsonObject, safeJsonParse, unique } from "../core/text.js";
import { generateTextWithJsonFallback } from "../llm/structured.js";
import { renderWriterContextMarkdown } from "../retrieval/writer-context.js";
import { loadCollectionChunks, runHybridRetrieval } from "./index.js";

const REFERENCE_RECALL_CANDIDATE_LIMIT = 12;
const REFERENCE_ROUTING_SLOT = "secondary";

function normalizeList(values, limit = 8) {
  return unique((Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)).slice(0, limit);
}

function signalTextFromValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return normalizeReferenceSignalList(value, 4).join("；");
  }
  if (typeof value !== "object") {
    return "";
  }

  for (const key of [
    "signal",
    "pattern",
    "summary",
    "description",
    "instruction",
    "guidance",
    "label",
    "text",
    "content",
    "title",
    "name",
    "value",
    "reason",
    "method",
    "beat",
  ]) {
    const candidate = signalTextFromValue(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  const entries = Object.entries(value)
    .map(([key, item]) => {
      const text = signalTextFromValue(item);
      if (!text) {
        return "";
      }
      return key === "type" || key === "kind" ? text : `${key}:${text}`;
    })
    .filter(Boolean);

  return entries.length ? createExcerpt(entries.join("；"), 160) : "";
}

export function normalizeReferenceSignalList(values, limit = 8) {
  const collected = [];
  const visit = (item) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    const text = signalTextFromValue(item);
    if (text && text !== "[object Object]") {
      collected.push(text);
    }
  };

  (Array.isArray(values) ? values : []).forEach(visit);
  return unique(collected).slice(0, limit);
}

export function createEmptyReferencePacket(extra = {}) {
  return {
    triggered: false,
    mode: "skipped",
    collectionIds: [],
    queries: [],
    focusAspects: [],
    mustAvoid: [],
    matches: [],
    styleSignals: [],
    scenePatterns: [],
    avoidPatterns: [],
    summary: "",
    briefingMarkdown: "当前没有可用的范文参考包。",
    warnings: [],
    ...extra,
  };
}

function parseAgentJson(result, label) {
  const parsed = safeJsonParse(extractJsonObject(result?.text || ""), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${label} 返回了无法解析的 JSON。`);
  }
  return parsed;
}

async function runReferenceQueryPlannerAgent({
  provider,
  project,
  chapterPlan,
  planContext,
  historyContext,
  researchPacket,
}) {
  const parsed = await generateTextWithJsonFallback(provider, {
    label: "ReferenceQueryPlannerAgent",
    agentComplexity: "simple",
    preferredAgentSlot: REFERENCE_ROUTING_SLOT,
    instructions:
      "你是 Novelex 的 ReferenceQueryPlannerAgent。请根据当前章节写作任务，给范文检索系统生成少量高价值查询。重点是要检索叙事处理方式、场景组织方式、人物出场节奏、对白/动作推进和氛围写法，而不是事实考据。只输出 JSON。",
    input: [
      `作品：${project.title}`,
      `题材：${project.genre}`,
      `当前章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
      `章纲重点：${chapterPlan.keyEvents.join("；")}`,
      `计划侧摘要：${planContext?.summaryText || planContext?.briefingMarkdown || "无"}`,
      `历史侧摘要：${historyContext?.contextSummary || historyContext?.briefingMarkdown || "无"}`,
      `研究资料包：${researchPacket?.summary || "无"}`,
      `请输出 JSON：
{
  "queries": ["检索查询1", "检索查询2"],
  "focusAspects": ["要重点参考的写法1", "写法2"],
  "mustAvoid": ["本章最该避开的写法1", "写法2"]
}`,
    ].join("\n\n"),
    metadata: {
      feature: "reference_query_planner",
      chapterId: chapterPlan.chapterId,
    },
  });

  return {
    queries: normalizeList(parsed.queries, 4),
    focusAspects: normalizeList(parsed.focusAspects, 6),
    mustAvoid: normalizeList(parsed.mustAvoid, 6),
  };
}

async function runReferenceSynthesizerAgent({
  provider,
  project,
  chapterPlan,
  planner,
  matches,
}) {
  const parsed = await generateTextWithJsonFallback(provider, {
    label: "ReferenceSynthesizerAgent",
    agentComplexity: "simple",
    preferredAgentSlot: REFERENCE_ROUTING_SLOT,
    instructions:
      "你是 Novelex 的 ReferenceSynthesizerAgent。你会看到若干命中的范文片段。请把它们压缩成 Writer 直接能消费的范文参考包。只总结可借鉴的叙事技法、场景处理、人物推进方式和需要避免的模仿风险，不要鼓励照抄原文。只输出 JSON。",
    input: [
      `作品：${project.title}`,
      `当前章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
      `检索重点：${planner.focusAspects.join("；") || "无"}`,
      `避免事项：${planner.mustAvoid.join("；") || "无"}`,
      `命中片段：\n${matches.map((item) => [
        `## ${item.collectionName} / ${item.sourcePath}`,
        `摘录：${item.excerpt}`,
        `正文片段：${createExcerpt(item.text, 520)}`,
      ].join("\n")).join("\n\n")}`,
      `请输出 JSON：
{
  "summary": "给 Writer 的总提示",
  "styleSignals": ["文风信号1", "文风信号2"],
  "scenePatterns": ["场景推进模式1", "模式2"],
  "avoidPatterns": ["不要模仿的风险1", "风险2"]
}`,
    ].join("\n\n"),
    metadata: {
      feature: "reference_synthesizer",
      chapterId: chapterPlan.chapterId,
    },
  });

  return {
    summary: String(parsed.summary || "").trim(),
    styleSignals: normalizeReferenceSignalList(parsed.styleSignals, 6),
    scenePatterns: normalizeReferenceSignalList(parsed.scenePatterns, 6),
    avoidPatterns: normalizeReferenceSignalList(parsed.avoidPatterns, 6),
  };
}

async function runReferenceRecallAgent({
  provider,
  project,
  chapterPlan,
  planner,
  chunks,
}) {
  const parsed = await generateTextWithJsonFallback(provider, {
    label: "ReferenceRecallAgent",
    agentComplexity: "simple",
    preferredAgentSlot: REFERENCE_ROUTING_SLOT,
    instructions:
      "你是 Novelex 的 ReferenceRecallAgent。你会看到范文库的 chunk 摘要目录。请只挑出最值得进入二次精读的候选片段，重点看叙事技法、场景组织、人物推进和动作/对白节奏，不要挑纯设定说明。只输出 JSON。",
    input: [
      `作品：${project.title}`,
      `当前章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
      `检索问题：${planner.queries.join("；") || "无"}`,
      `重点参考：${planner.focusAspects.join("；") || "无"}`,
      `需要避开：${planner.mustAvoid.join("；") || "无"}`,
      `候选 chunk 目录：\n${chunks.map((item) => `- ${item.chunkId}｜${item.collectionName}/${item.sourcePath}｜摘录:${item.excerpt || createExcerpt(item.text, 120)}`).join("\n")}`,
      `请输出 JSON：
{
  "selectedChunkIds": ["chunk_1", "chunk_2"],
  "reasons": {
    "chunk_1": "为什么适合进入精读"
  }
}`,
    ].join("\n\n"),
    metadata: {
      feature: "reference_recall",
      chapterId: chapterPlan.chapterId,
    },
  });

  const reasons = parsed.reasons && typeof parsed.reasons === "object" ? parsed.reasons : {};
  const selectedIds = new Set((Array.isArray(parsed.selectedChunkIds) ? parsed.selectedChunkIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean));
  return chunks
    .filter((item) => selectedIds.has(item.chunkId))
    .slice(0, 8)
    .map((item) => ({
      ...item,
      recallReason: String(reasons[item.chunkId] || "").trim(),
    }));
}

function buildReferenceMarkdown(packet) {
  if (!packet?.triggered) {
    return "当前没有可用的范文参考包。";
  }

  const matchLines = (packet.matches || [])
    .map((item) => `- ${item.collectionName}/${item.sourcePath}#${item.position?.index ?? 0}｜${item.excerpt}`)
    .join("\n");

  return [
    "# 范文参考包",
    "",
    `- 摘要：${packet.summary || "无"}`,
    `- 检索问题：${(packet.queries || []).join("；") || "无"}`,
    `- 风格信号：${(packet.styleSignals || []).join("；") || "无"}`,
    `- 场景模式：${(packet.scenePatterns || []).join("；") || "无"}`,
    `- 避免模仿：${(packet.avoidPatterns || []).join("；") || "无"}`,
    "",
    "## 命中片段",
    matchLines || "- 无命中片段。",
  ].join("\n");
}

function toReferenceSource(match) {
  return createContextSource({
    source: path.join("runtime", "rag_collections", match.collectionId, "sources", match.sourcePath),
    reason: "该范文片段在混合检索中命中，可作为当前章节的写法参考。",
    excerpt: match.excerpt,
  });
}

export function buildReferenceSources(referencePacket) {
  return mergeContextSources([
    (referencePacket?.matches || []).map(toReferenceSource),
  ], 8);
}

export function mergeReferenceIntoWriterContext(writerContext, referencePacket) {
  if (!referencePacket?.triggered) {
    return writerContext;
  }

  const referenceSources = buildReferenceSources(referencePacket);
  const cleanedStyleSignals = normalizeReferenceSignalList(referencePacket?.styleSignals, 6);
  const cleanedScenePatterns = normalizeReferenceSignalList(referencePacket?.scenePatterns, 6);
  const cleanedAvoidPatterns = normalizeReferenceSignalList(referencePacket?.avoidPatterns, 8);
  const referenceSignals = normalizeReferenceSignalList([
    ...(writerContext?.referenceSignals || []),
    ...cleanedStyleSignals,
    ...cleanedScenePatterns,
  ], 8);
  const priorities = normalizeList([
    ...(writerContext?.priorities || []),
    ...cleanedStyleSignals,
    ...cleanedScenePatterns,
  ], 12);
  const risks = normalizeList([
    ...(writerContext?.risks || []),
    ...cleanedAvoidPatterns,
  ], 12);
  const selectedSources = mergeContextSources([
    writerContext?.selectedSources || [],
    referenceSources,
  ], 16);
  const nextWriterContext = {
    ...writerContext,
    priorities,
    risks,
    selectedSources,
    referenceSignals,
  };
  const markdown = renderWriterContextMarkdown(nextWriterContext);

  return {
    ...nextWriterContext,
    summaryText: createExcerpt(markdown, 320),
    briefingMarkdown: markdown,
  };
}

export async function buildReferencePacket({
  store,
  provider,
  mcpManager,
  project,
  chapterPlan,
  planContext,
  historyContext,
  researchPacket,
}) {
  const collectionIds = normalizeList(project?.ragCollectionIds || [], 12);
  if (!collectionIds.length) {
    return createEmptyReferencePacket({
      reason: "当前项目未绑定范文库。",
    });
  }

  const loaded = await loadCollectionChunks(store, collectionIds);
  const chunks = loaded.flatMap((item) => item.chunks);
  if (!chunks.length) {
    return createEmptyReferencePacket({
      collectionIds,
      reason: "已绑定范文库，但索引为空或还未重建。",
    });
  }

  const warnings = [];
  const planner = await runReferenceQueryPlannerAgent({
    provider,
    project,
    chapterPlan,
    planContext,
    historyContext,
    researchPacket,
  });
  const retrievalQueries = planner.queries.length ? planner.queries : planner.focusAspects;
  let recallCandidates = [];
  try {
    recallCandidates = await runHybridRetrieval({
      queries: retrievalQueries,
      chunks,
      limit: REFERENCE_RECALL_CANDIDATE_LIMIT,
      rootDir: store?.paths?.configRootDir || store?.paths?.workspaceRoot || process.cwd(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown error");
    const fallbackPacket = createEmptyReferencePacket({
      triggered: true,
      mode: "embedding_failed",
      collectionIds,
      queries: planner.queries,
      focusAspects: planner.focusAspects,
      mustAvoid: planner.mustAvoid,
      summary: `范文检索失败：${message}`,
      warnings: ["向量检索失败，已跳过范文参考包。"],
    });
    fallbackPacket.briefingMarkdown = buildReferenceMarkdown(fallbackPacket);
    return fallbackPacket;
  }

  if (!recallCandidates.length) {
    const emptyPacket = createEmptyReferencePacket({
      triggered: true,
      mode: "llm_retrieval",
      collectionIds,
      queries: planner.queries,
      focusAspects: planner.focusAspects,
      mustAvoid: planner.mustAvoid,
      summary: "已执行混合检索，但没有命中可供精读的候选片段。",
      warnings,
    });
    emptyPacket.briefingMarkdown = buildReferenceMarkdown(emptyPacket);
    return emptyPacket;
  }

  const matches = await runReferenceRecallAgent({
    provider,
    project,
    chapterPlan,
    planner,
    chunks: recallCandidates,
  });

  if (!matches.length) {
    const emptyPacket = createEmptyReferencePacket({
      triggered: true,
      mode: "llm_retrieval",
      collectionIds,
      queries: planner.queries,
      focusAspects: planner.focusAspects,
      mustAvoid: planner.mustAvoid,
      summary: "已执行 LLM 范文检索，但没有命中高相关片段。",
      warnings,
    });
    emptyPacket.briefingMarkdown = buildReferenceMarkdown(emptyPacket);
    return emptyPacket;
  }

  const synthesis = await runReferenceSynthesizerAgent({
    provider,
    project,
    chapterPlan,
    planner,
    matches,
  });

  const packet = {
    triggered: true,
    mode: "llm_retrieval",
    collectionIds,
    queries: planner.queries,
    focusAspects: planner.focusAspects,
    mustAvoid: planner.mustAvoid,
    matches: matches.map((item, index) => ({
      chunkId: item.chunkId,
      collectionId: item.collectionId,
      collectionName: item.collectionName,
      sourcePath: item.sourcePath,
      excerpt: item.excerpt,
      text: createExcerpt(item.text, 600),
      position: item.position,
      retrievalRank: index + 1,
      retrievalReason: item.recallReason || "",
    })),
    styleSignals: synthesis.styleSignals,
    scenePatterns: synthesis.scenePatterns,
    avoidPatterns: normalizeList([
      ...synthesis.avoidPatterns,
      ...planner.mustAvoid,
    ], 8),
    summary: synthesis.summary,
    warnings,
  };
  packet.briefingMarkdown = buildReferenceMarkdown(packet);
  return packet;
}
