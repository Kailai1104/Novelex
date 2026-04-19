import path from "node:path";

import { createContextSource, mergeContextSources } from "../core/input-governance.js";
import { createExcerpt, extractJsonObject, safeJsonParse, unique } from "../core/text.js";
import { loadOpeningCollectionChunks, runHybridRetrieval } from "./index.js";

function normalizeList(values, limit = 8) {
  return unique((Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)).slice(0, limit);
}

function parseAgentJson(result, label) {
  const parsed = safeJsonParse(extractJsonObject(result?.text || ""), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${label} 返回了无法解析的 JSON。`);
  }
  return parsed;
}

function openingModeLabel(mode) {
  switch (mode) {
    case "plan_draft":
      return "大纲草稿";
    case "plan_final":
      return "最终大纲";
    case "chapter_outline":
      return "前三章细纲";
    case "chapter_write":
      return "前三章正文";
    default:
      return "开头写作";
  }
}

export function createEmptyOpeningReferencePacket(extra = {}) {
  return {
    triggered: false,
    mode: "skipped",
    collectionIds: [],
    queries: [],
    focusAspects: [],
    matches: [],
    openingHooks: [],
    protagonistEntryPatterns: [],
    conflictIgnitionPatterns: [],
    pacingSignals: [],
    chapterEndHookPatterns: [],
    structuralBeats: [],
    avoidPatterns: [],
    summary: "",
    briefingMarkdown: "当前没有可用的黄金三章参考包。",
    warnings: [],
    ...extra,
  };
}

async function runOpeningQueryPlannerAgent({
  provider,
  project,
  mode,
  chapterPlan,
  chapterBase,
  planContext,
  historyContext,
}) {
  const subject = chapterPlan
    ? `${chapterPlan.chapterId} ${chapterPlan.title}`
    : chapterBase
      ? `${chapterBase.chapterId} ${chapterBase.title}`
      : `${project.title} 的开头设计`;

  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 OpeningQueryPlannerAgent。请围绕优秀网文前三章的结构学习，为当前任务生成少量高价值检索问题。重点关注开场钩子、主角亮相、冲突点燃、信息投放顺序、前三章升级节奏与章末牵引。严格避免要求模仿原句。只输出 JSON。",
    input: [
      `作品：${project.title}`,
      `模式：${openingModeLabel(mode)}`,
      `当前任务：${subject}`,
      `题材：${project.genre}`,
      `故事前提：${project.premise}`,
      `主角目标：${project.protagonistGoal}`,
      `计划侧摘要：${planContext?.summaryText || planContext?.briefingMarkdown || "无"}`,
      `历史侧摘要：${historyContext?.contextSummary || historyContext?.briefingMarkdown || "无"}`,
      `请输出 JSON：
{
  "queries": ["检索查询1", "检索查询2"],
  "focusAspects": ["要重点学习的开头结构1", "结构2"]
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "opening_query_planner",
      mode,
      chapterId: chapterPlan?.chapterId || chapterBase?.chapterId || "",
    },
  });

  const parsed = parseAgentJson(result, "OpeningQueryPlannerAgent");
  return {
    queries: normalizeList(parsed.queries, 4),
    focusAspects: normalizeList(parsed.focusAspects, 6),
  };
}

function fallbackOpeningPlanner({ project, mode, chapterPlan, chapterBase, planContext }) {
  const subject = chapterPlan?.title || chapterBase?.title || project.title;
  return {
    queries: normalizeList([
      `${project.genre} 黄金三章 ${subject}`,
      `${project.protagonistGoal} 开场钩子 主角亮相`,
      planContext?.outline?.recommendedFocus || "",
      `${openingModeLabel(mode)} 冲突升级 章末钩子`,
    ], 4),
    focusAspects: normalizeList([
      "第一场如何立问题",
      "主角如何快速建立辨识度与欲望",
      "前三章冲突如何层层抬升",
      "章末钩子怎样连续加压",
    ], 6),
  };
}

async function runOpeningPatternSynthesizerAgent({
  provider,
  project,
  mode,
  planner,
  matches,
}) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 OpeningPatternSynthesizerAgent。你会看到若干优秀网文前三章片段。请把它们压缩成可供 Novelex agent 使用的黄金三章结构参考包，只总结结构方法，不允许鼓励模仿句子。只输出 JSON。",
    input: [
      `作品：${project.title}`,
      `模式：${openingModeLabel(mode)}`,
      `检索重点：${planner.focusAspects.join("；") || "无"}`,
      `命中片段：\n${matches.map((item) => [
        `## ${item.collectionName} / ${item.sourcePath}`,
        `摘录：${item.excerpt}`,
        `正文片段：${createExcerpt(item.text, 520)}`,
      ].join("\n")).join("\n\n")}`,
      `请输出 JSON：
{
  "summary": "总提示",
  "openingHooks": ["开场钩子模式1"],
  "protagonistEntryPatterns": ["主角亮相方式1"],
  "conflictIgnitionPatterns": ["冲突点燃方式1"],
  "pacingSignals": ["前三章节奏信号1"],
  "chapterEndHookPatterns": ["章末牵引模式1"],
  "structuralBeats": ["推荐结构拍点1"],
  "avoidPatterns": ["应避免的问题1"]
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "opening_pattern_synthesizer",
      mode,
    },
  });

  const parsed = parseAgentJson(result, "OpeningPatternSynthesizerAgent");
  return {
    summary: String(parsed.summary || "").trim(),
    openingHooks: normalizeList(parsed.openingHooks, 6),
    protagonistEntryPatterns: normalizeList(parsed.protagonistEntryPatterns, 6),
    conflictIgnitionPatterns: normalizeList(parsed.conflictIgnitionPatterns, 6),
    pacingSignals: normalizeList(parsed.pacingSignals, 6),
    chapterEndHookPatterns: normalizeList(parsed.chapterEndHookPatterns, 6),
    structuralBeats: normalizeList(parsed.structuralBeats, 8),
    avoidPatterns: normalizeList(parsed.avoidPatterns, 8),
  };
}

function fallbackOpeningSynthesis({ matches }) {
  return {
    summary: `已从 ${matches.length} 个优秀开头片段中提炼前三章结构规律，只借结构，不借句子。`,
    openingHooks: normalizeList(matches.map((item) => `${item.sourcePath}：开局迅速抛出问题或压力。`), 4),
    protagonistEntryPatterns: ["主角应尽快带着欲望、处境和行动亮相。"],
    conflictIgnitionPatterns: ["第一章尽快让主线冲突落地，不要被背景说明淹没。"],
    pacingSignals: ["前三章要持续加压，每章都要比上一章更具体。"] ,
    chapterEndHookPatterns: ["每章结尾都留下下一步必须立刻处理的新压力。"],
    structuralBeats: [
      "第一场立问题",
      "主角快速亮相并展示欲望/困境",
      "当章内形成真实碰撞",
      "章末抬高下一章压力",
    ],
    avoidPatterns: [
      "避免背景说明过载",
      "避免主角长期被动",
      "避免信息堆砌但没有行动",
      "避免章末没有牵引",
    ],
  };
}

function buildOpeningReferenceMarkdown(packet) {
  if (!packet?.triggered) {
    return "当前没有可用的黄金三章参考包。";
  }

  const matchLines = (packet.matches || [])
    .map((item) => `- ${item.collectionName}/${item.sourcePath}#${item.position?.index ?? 0}｜${item.excerpt}`)
    .join("\n");

  return [
    "# 黄金三章参考包",
    "",
    "- 核心约束：只借结构，不借句子；学习优秀开头如何组织信息、冲突与钩子。",
    `- 模式：${openingModeLabel(packet.mode)}`,
    `- 摘要：${packet.summary || "无"}`,
    `- 检索问题：${(packet.queries || []).join("；") || "无"}`,
    `- 重点学习：${(packet.focusAspects || []).join("；") || "无"}`,
    `- 开场钩子：${(packet.openingHooks || []).join("；") || "无"}`,
    `- 主角亮相：${(packet.protagonistEntryPatterns || []).join("；") || "无"}`,
    `- 冲突点燃：${(packet.conflictIgnitionPatterns || []).join("；") || "无"}`,
    `- 节奏信号：${(packet.pacingSignals || []).join("；") || "无"}`,
    `- 章末牵引：${(packet.chapterEndHookPatterns || []).join("；") || "无"}`,
    `- 结构拍点：${(packet.structuralBeats || []).join("；") || "无"}`,
    `- 避免问题：${(packet.avoidPatterns || []).join("；") || "无"}`,
    "",
    "## 命中片段",
    matchLines || "- 无命中片段。",
  ].join("\n");
}

function toOpeningSource(match) {
  return createContextSource({
    source: path.join("runtime", "opening_collections", match.collectionId, "sources", match.sourcePath),
    reason: "该优秀开头片段被命中，可作为黄金三章结构参考。",
    excerpt: match.excerpt,
  });
}

export function buildOpeningReferenceSources(openingReferencePacket) {
  return mergeContextSources([
    (openingReferencePacket?.matches || []).map(toOpeningSource),
  ], 8);
}

export function mergeOpeningIntoWriterContext(writerContext, openingReferencePacket) {
  if (!openingReferencePacket?.triggered) {
    return writerContext;
  }

  const openingSources = buildOpeningReferenceSources(openingReferencePacket);
  const priorities = normalizeList([
    ...(writerContext?.priorities || []),
    ...(openingReferencePacket.openingHooks || []).map((item) => `黄金三章开场参考：${item}`),
    ...(openingReferencePacket.protagonistEntryPatterns || []).map((item) => `黄金三章主角亮相：${item}`),
    ...(openingReferencePacket.conflictIgnitionPatterns || []).map((item) => `黄金三章冲突点燃：${item}`),
    ...(openingReferencePacket.chapterEndHookPatterns || []).map((item) => `黄金三章章末牵引：${item}`),
    ...(openingReferencePacket.structuralBeats || []).map((item) => `黄金三章结构拍点：${item}`),
  ], 16);
  const risks = normalizeList([
    ...(writerContext?.risks || []),
    ...(openingReferencePacket.avoidPatterns || []).map((item) => `黄金三章避免：${item}`),
  ], 16);
  const selectedSources = mergeContextSources([
    writerContext?.selectedSources || [],
    openingSources,
  ], 18);
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
    "## 黄金三章参考包",
    openingReferencePacket.briefingMarkdown || "当前没有额外黄金三章参考。",
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

export function mergeOpeningIntoOutlineContext(chapterOutlineContext, openingReferencePacket) {
  if (!openingReferencePacket?.triggered) {
    return chapterOutlineContext;
  }

  const existingWarnings = Array.isArray(chapterOutlineContext?.warnings)
    ? chapterOutlineContext.warnings
    : [];
  const selectedSources = mergeContextSources([
    chapterOutlineContext?.selectedSources || [],
    buildOpeningReferenceSources(openingReferencePacket),
  ], 16);
  const briefingMarkdown = [
    chapterOutlineContext?.briefingMarkdown || "",
    "",
    "## 黄金三章参考",
    openingReferencePacket.briefingMarkdown || "当前没有额外黄金三章参考。",
  ].join("\n").trim();

  return {
    ...chapterOutlineContext,
    openingReferencePacket,
    selectedSources,
    warnings: normalizeList([
      ...existingWarnings,
      ...(openingReferencePacket.warnings || []),
    ], 10),
    summaryText: createExcerpt(briefingMarkdown, 320),
    briefingMarkdown,
  };
}

export async function buildOpeningReferencePacket({
  store,
  provider,
  project,
  mode,
  chapterPlan = null,
  chapterBase = null,
  planContext = null,
  historyContext = null,
}) {
  const collectionIds = normalizeList(project?.openingCollectionIds || [], 12);
  if (!collectionIds.length) {
    return createEmptyOpeningReferencePacket({
      mode,
      reason: "当前项目未绑定黄金三章参考库。",
    });
  }

  const loaded = await loadOpeningCollectionChunks(store, collectionIds);
  const chunks = loaded.flatMap((item) => item.chunks);
  if (!chunks.length) {
    return createEmptyOpeningReferencePacket({
      mode,
      collectionIds,
      reason: "已绑定黄金三章参考库，但索引为空或还未重建。",
    });
  }

  let planner = fallbackOpeningPlanner({
    project,
    mode,
    chapterPlan,
    chapterBase,
    planContext,
  });
  const warnings = [];

  try {
    planner = await runOpeningQueryPlannerAgent({
      provider,
      project,
      mode,
      chapterPlan,
      chapterBase,
      planContext,
      historyContext,
    });
  } catch (error) {
    warnings.push(`OpeningQueryPlannerAgent 失败，已回退到规则构造查询：${error instanceof Error ? error.message : String(error || "")}`);
  }

  try {
    const matches = await runHybridRetrieval({
      queries: planner.queries,
      chunks,
      limit: 8,
      rootDir: store.paths.configRootDir,
    });

    if (!matches.length) {
      const emptyPacket = createEmptyOpeningReferencePacket({
        triggered: true,
        mode,
        collectionIds,
        queries: planner.queries,
        focusAspects: planner.focusAspects,
        summary: "已执行黄金三章检索，但没有命中高相关片段。",
        warnings,
      });
      emptyPacket.briefingMarkdown = buildOpeningReferenceMarkdown(emptyPacket);
      return emptyPacket;
    }

    let synthesis = fallbackOpeningSynthesis({ matches });
    try {
      synthesis = await runOpeningPatternSynthesizerAgent({
        provider,
        project,
        mode,
        planner,
        matches,
      });
    } catch (error) {
      warnings.push(`OpeningPatternSynthesizerAgent 失败，已回退到规则摘要：${error instanceof Error ? error.message : String(error || "")}`);
    }

    const packet = {
      triggered: true,
      mode,
      collectionIds,
      queries: planner.queries,
      focusAspects: planner.focusAspects,
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
      openingHooks: synthesis.openingHooks,
      protagonistEntryPatterns: synthesis.protagonistEntryPatterns,
      conflictIgnitionPatterns: synthesis.conflictIgnitionPatterns,
      pacingSignals: synthesis.pacingSignals,
      chapterEndHookPatterns: synthesis.chapterEndHookPatterns,
      structuralBeats: synthesis.structuralBeats,
      avoidPatterns: synthesis.avoidPatterns,
      summary: synthesis.summary,
      warnings,
    };
    packet.briefingMarkdown = buildOpeningReferenceMarkdown(packet);
    return packet;
  } catch (error) {
    const packet = createEmptyOpeningReferencePacket({
      triggered: true,
      mode,
      collectionIds,
      queries: planner.queries,
      focusAspects: planner.focusAspects,
      summary: `黄金三章检索失败：${error instanceof Error ? error.message : String(error || "")}`,
      warnings,
    });
    packet.briefingMarkdown = buildOpeningReferenceMarkdown(packet);
    return packet;
  }
}
