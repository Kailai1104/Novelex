import path from "node:path";

import { normalizeLocalRagToolResult } from "../mcp/index.js";
import { createContextSource, mergeContextSources } from "../core/input-governance.js";
import { createExcerpt, extractJsonObject, safeJsonParse, unique } from "../core/text.js";
import { loadCollectionChunks } from "./index.js";

function normalizeList(values, limit = 8) {
  return unique((Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)).slice(0, limit);
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
  const result = await provider.generateText({
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
    useReviewModel: true,
    metadata: {
      feature: "reference_query_planner",
      chapterId: chapterPlan.chapterId,
    },
  });

  const parsed = parseAgentJson(result, "ReferenceQueryPlannerAgent");
  return {
    queries: normalizeList(parsed.queries, 4),
    focusAspects: normalizeList(parsed.focusAspects, 6),
    mustAvoid: normalizeList(parsed.mustAvoid, 6),
  };
}

function fallbackReferencePlanner({ chapterPlan, planContext }) {
  return {
    queries: normalizeList([
      `${chapterPlan.title} ${chapterPlan.keyEvents.join(" ")}`,
      chapterPlan.arcContribution.join(" "),
      planContext?.outline?.recommendedFocus || "",
    ], 4),
    focusAspects: normalizeList([
      ...chapterPlan.keyEvents,
      ...(chapterPlan.arcContribution || []),
    ], 6),
    mustAvoid: normalizeList([
      ...(planContext?.outline?.continuityRisks || []),
    ], 6),
  };
}

async function runReferenceSynthesizerAgent({
  provider,
  project,
  chapterPlan,
  planner,
  matches,
}) {
  const result = await provider.generateText({
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
    useReviewModel: true,
    metadata: {
      feature: "reference_synthesizer",
      chapterId: chapterPlan.chapterId,
    },
  });

  const parsed = parseAgentJson(result, "ReferenceSynthesizerAgent");
  return {
    summary: String(parsed.summary || "").trim(),
    styleSignals: normalizeList(parsed.styleSignals, 6),
    scenePatterns: normalizeList(parsed.scenePatterns, 6),
    avoidPatterns: normalizeList(parsed.avoidPatterns, 6),
  };
}

function fallbackReferenceSynthesis({ planner, matches }) {
  return {
    summary: `本章可参考 ${matches.length} 个范文片段的场景组织与语言节奏，但不要直接照抄原句。`,
    styleSignals: normalizeList([
      ...planner.focusAspects,
      ...matches.map((item) => `${item.sourcePath}：${item.excerpt}`),
    ], 6),
    scenePatterns: normalizeList([
      ...matches.map((item) => `${item.sourcePath} 适合参考其场景推进节奏与动作/对白配比。`),
    ], 6),
    avoidPatterns: normalizeList(planner.mustAvoid, 6),
  };
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
  const priorities = normalizeList([
    ...(writerContext?.priorities || []),
    ...(referencePacket.styleSignals || []),
    ...(referencePacket.scenePatterns || []),
  ], 12);
  const risks = normalizeList([
    ...(writerContext?.risks || []),
    ...(referencePacket.avoidPatterns || []),
  ], 12);
  const selectedSources = mergeContextSources([
    writerContext?.selectedSources || [],
    referenceSources,
  ], 16);
  const sourceLines = selectedSources
    .map((item) => `- ${item.source}｜${item.reason}｜${item.excerpt || "无摘录"}`)
    .join("\n");

  const markdown = [
    `# ${writerContext?.chapterId || "chapter"} Writer 上下文包`,
    "",
    "## 优先落实",
    `- ${priorities.join("\n- ") || "无"}`,
    "",
    "## 连续性风险",
    `- ${risks.join("\n- ") || "无"}`,
    "",
    "## 范文参考包",
    referencePacket.briefingMarkdown || "当前没有额外范文参考。",
    "",
    "## 计划侧摘要",
    writerContext?.planContextSummary || "无",
    "",
    "## 历史侧摘要",
    writerContext?.historyContextSummary || "无",
    "",
    "## 可追溯来源",
    sourceLines || "- 无",
  ].join("\n");

  return {
    ...writerContext,
    priorities,
    risks,
    selectedSources,
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

  let planner = fallbackReferencePlanner({ chapterPlan, planContext });
  const warnings = [];
  try {
    planner = await runReferenceQueryPlannerAgent({
      provider,
      project,
      chapterPlan,
      planContext,
      historyContext,
      researchPacket,
    });
  } catch (error) {
    warnings.push(`ReferenceQueryPlannerAgent 失败，已回退到规则构造查询：${error instanceof Error ? error.message : String(error || "")}`);
  }

  try {
    const ragResult = normalizeLocalRagToolResult(await mcpManager.callTool("local_rag", {
      collectionType: "reference",
      collectionIds,
      queries: planner.queries,
      limit: 8,
    }));
    const matches = Array.isArray(ragResult.matches) ? ragResult.matches : [];
    warnings.push(...(ragResult.warnings || []));

    if (!matches.length) {
      const emptyPacket = createEmptyReferencePacket({
        triggered: true,
        mode: "hybrid-rag",
        collectionIds,
        queries: planner.queries,
        focusAspects: planner.focusAspects,
        mustAvoid: planner.mustAvoid,
        summary: ragResult.summary || "已执行范文检索，但没有命中高相关片段。",
        warnings,
      });
      emptyPacket.briefingMarkdown = buildReferenceMarkdown(emptyPacket);
      return emptyPacket;
    }

    let synthesis = fallbackReferenceSynthesis({ planner, matches });
    try {
      synthesis = await runReferenceSynthesizerAgent({
        provider,
        project,
        chapterPlan,
        planner,
        matches,
      });
    } catch (error) {
      warnings.push(`ReferenceSynthesizerAgent 失败，已回退到规则摘要：${error instanceof Error ? error.message : String(error || "")}`);
    }

    const packet = {
      triggered: true,
      mode: "hybrid-rag",
      collectionIds,
      queries: planner.queries,
      focusAspects: planner.focusAspects,
      mustAvoid: planner.mustAvoid,
      matches: matches.map((item) => ({
        chunkId: item.chunkId,
        collectionId: item.collectionId,
        collectionName: item.collectionName,
        sourcePath: item.sourcePath,
        excerpt: item.excerpt,
        text: createExcerpt(item.text, 600),
        position: item.position,
        fusedScore: item.fusedScore,
        vectorScore: item.vectorScore,
        keywordScore: item.keywordScore,
      })),
      styleSignals: synthesis.styleSignals,
      scenePatterns: synthesis.scenePatterns,
      avoidPatterns: normalizeList([
        ...synthesis.avoidPatterns,
        ...planner.mustAvoid,
      ], 8),
      summary: synthesis.summary || ragResult.summary,
      warnings,
    };
    packet.briefingMarkdown = buildReferenceMarkdown(packet);
    return packet;
  } catch (error) {
    const packet = createEmptyReferencePacket({
      triggered: true,
      mode: "embedding_failed",
      collectionIds,
      queries: planner.queries,
      focusAspects: planner.focusAspects,
      mustAvoid: planner.mustAvoid,
      summary: `范文检索失败：${error instanceof Error ? error.message : String(error || "")}`,
      warnings,
    });
    packet.briefingMarkdown = buildReferenceMarkdown(packet);
    return packet;
  }
}
