import path from "node:path";

import { createContextSource, mergeContextSources } from "../core/input-governance.js";
import { createExcerpt, extractJsonObject, safeJsonParse, unique } from "../core/text.js";
import { generateStructuredObject } from "../llm/structured.js";
import { renderWriterContextMarkdown } from "../retrieval/writer-context.js";
import { loadOpeningCollectionChunks } from "./index.js";

function normalizeList(values, limit = 8) {
  return unique((Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)).slice(0, limit);
}

function openingSignalTextFromValue(value) {
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
    return normalizeOpeningSignalList(value, 4).join("；");
  }
  if (typeof value !== "object") {
    return "";
  }

  for (const key of [
    "summary",
    "description",
    "signal",
    "pattern",
    "instruction",
    "guidance",
    "text",
    "content",
    "label",
    "title",
    "name",
    "value",
    "reason",
    "beat",
  ]) {
    const candidate = openingSignalTextFromValue(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  const entries = Object.entries(value)
    .map(([key, item]) => {
      const text = openingSignalTextFromValue(item);
      if (!text) {
        return "";
      }
      return key === "type" || key === "kind" ? text : `${key}:${text}`;
    })
    .filter(Boolean);

  return entries.length ? createExcerpt(entries.join("；"), 160) : "";
}

function normalizeOpeningSignalList(values, limit = 8) {
  const collected = [];
  const visit = (item) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    const text = openingSignalTextFromValue(item);
    if (text && text !== "[object Object]") {
      collected.push(text);
    }
  };

  (Array.isArray(values) ? values : []).forEach(visit);
  return unique(collected).slice(0, limit);
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
    openingHooks: normalizeOpeningSignalList(parsed.openingHooks, 6),
    protagonistEntryPatterns: normalizeOpeningSignalList(parsed.protagonistEntryPatterns, 6),
    conflictIgnitionPatterns: normalizeOpeningSignalList(parsed.conflictIgnitionPatterns, 6),
    pacingSignals: normalizeOpeningSignalList(parsed.pacingSignals, 6),
    chapterEndHookPatterns: normalizeOpeningSignalList(parsed.chapterEndHookPatterns, 6),
    structuralBeats: normalizeOpeningSignalList(parsed.structuralBeats, 8),
    avoidPatterns: normalizeOpeningSignalList(parsed.avoidPatterns, 8),
  };
}

async function runOpeningRecallAgent({
  provider,
  project,
  mode,
  planner,
  chunks,
}) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 OpeningRecallAgent。你会看到优秀网文前三章的 chunk 摘要目录。请只挑出最值得进入二次精读的片段，重点学习开场钩子、主角亮相、冲突点燃、前三章升级和章末牵引。只输出 JSON。",
    input: [
      `作品：${project.title}`,
      `模式：${openingModeLabel(mode)}`,
      `检索问题：${planner.queries.join("；") || "无"}`,
      `重点学习：${planner.focusAspects.join("；") || "无"}`,
      `候选 chunk 目录：\n${chunks.map((item) => `- ${item.chunkId}｜${item.collectionName}/${item.sourcePath}｜摘录:${item.excerpt || createExcerpt(item.text, 120)}`).join("\n")}`,
      `请输出 JSON：
{
  "selectedChunkIds": ["chunk_1", "chunk_2"],
  "reasons": {
    "chunk_1": "为什么值得精读"
  }
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "opening_recall",
      mode,
    },
  });

  const parsed = parseAgentJson(result, "OpeningRecallAgent");
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

const FRESH_START_OPENING_PATTERN = /惊醒|醒来|睁眼|睁开眼|刚恢复意识|重新确认|再次确认|我是谁|穿越|身份首次|主角首次|身体危机/u;
const ABSTRACT_OPENING_SIGNALS = {
  continuation_reference: {
    conflictIgnitionPatterns: [
      "延续上一章已经成立的生存、权力或身份压力，不另起一套开篇型冲突。",
      "让角色在当下危机里用行动证明价值，而不是回头重讲设定。",
    ],
    pacingSignals: [
      "开场 1-2 段直接承接上一章余波，尽快进入本章动作。",
      "每场都必须带来新的信息、代价或关系变化，避免重复确认同一结论。",
    ],
    chapterEndHookPatterns: [
      "章末用未完成决策、新外部压力或更高代价继续加压，不做封闭总结。",
    ],
    structuralBeats: [
      "承接上一章直接余波 -> 当章行动试探 -> 新代价或新风险压上来",
    ],
  },
  escalation_reference: {
    conflictIgnitionPatterns: [],
    pacingSignals: [
      "开场直接进入已存在压力，中段抬高代价，后段递交更大的下一轮冲突。",
      "避免重复亮相、重复证明或重复解释，把篇幅优先留给升级后的行动与后果。",
    ],
    chapterEndHookPatterns: [
      "章末把更高层级的风险或决策压到眼前，让读者自然进入下一章。",
    ],
    structuralBeats: [
      "直接承压 -> 升级碰撞 -> 更大风险或更硬决策递交下一章",
    ],
  },
};

function filterContinuationBeats(values, limit = 6) {
  return normalizeList(values, limit).filter((item) => !FRESH_START_OPENING_PATTERN.test(item));
}

function structuralBeatsForMode(packet, referenceMode) {
  const beats = normalizeList(packet?.structuralBeats || [], 8);
  if (referenceMode === "full_opening_reference") {
    return beats;
  }
  if (referenceMode === "continuation_reference") {
    return filterContinuationBeats(beats, 4);
  }

  const escalationBeats = beats.filter((item) =>
    /升级|加压|兑现|章末|牵引|钩子|冲突|代价|风险|推进/u.test(item) &&
      !FRESH_START_OPENING_PATTERN.test(item),
  );
  return (escalationBeats.length ? escalationBeats : filterContinuationBeats(beats, 3)).slice(0, 4);
}

function abstractOpeningSignalsForMode(referenceMode) {
  return {
    ...(ABSTRACT_OPENING_SIGNALS[referenceMode] || ABSTRACT_OPENING_SIGNALS.escalation_reference),
  };
}

export function scopeOpeningReferencePacket(packet, {
  chapterNumber = 1,
  freshStart = false,
  continuityGuard = null,
} = {}) {
  if (!packet?.triggered) {
    return packet;
  }

  const normalizedChapterNumber = Number(chapterNumber) || 1;
  const isFreshStart = Boolean(freshStart) || normalizedChapterNumber <= 1;
  const referenceMode = isFreshStart
    ? "full_opening_reference"
    : normalizedChapterNumber === 2
      ? "continuation_reference"
      : "escalation_reference";
  const chapterPhase = isFreshStart
    ? "chapter_1"
    : normalizedChapterNumber === 2
      ? "chapter_2"
      : "chapter_3_escalation";

  if (referenceMode === "full_opening_reference") {
    const scoped = {
      ...packet,
      referenceMode,
      applicable_phase: chapterPhase,
      requires_fresh_start: true,
      freshStart: true,
      matches: (packet.matches || []).map((item) => ({
        ...item,
        applicable_phase: chapterPhase,
        requires_fresh_start: true,
      })),
    };
    scoped.briefingMarkdown = buildOpeningReferenceMarkdown(scoped);
    return scoped;
  }

  const baseAvoidPatterns = normalizeList([
    ...(packet.avoidPatterns || []),
    "非开篇章节禁止重新穿越、重新惊醒或重新确认身份。",
    "若连续性护栏未提供昏迷证据，不得采用醒来/恢复意识式开场。",
    "不得把上一章已经完成的第一次立威或首次证明写成首次发生。",
  ], 10);
  const abstractSignals = abstractOpeningSignalsForMode(referenceMode);
  const scoped = {
    ...packet,
    referenceMode,
    applicable_phase: chapterPhase,
    requires_fresh_start: false,
    freshStart: false,
    openingHooks: [],
    protagonistEntryPatterns: [],
    conflictIgnitionPatterns: abstractSignals.conflictIgnitionPatterns,
    pacingSignals: abstractSignals.pacingSignals,
    chapterEndHookPatterns: abstractSignals.chapterEndHookPatterns,
    structuralBeats: abstractSignals.structuralBeats,
    avoidPatterns: baseAvoidPatterns,
    suppressedSections: referenceMode === "continuation_reference"
      ? ["openingHooks", "protagonistEntryPatterns", "sourceSpecificConflictIgnitionPatterns", "sourceSpecificStructuralBeats"]
      : ["openingHooks", "protagonistEntryPatterns", "conflictIgnitionPatterns", "sourceSpecificStructuralBeats"],
    warnings: normalizeList([
      ...(packet.warnings || []),
      `黄金三章参考已按 ${referenceMode} 降权，只保留与连续章节相容的结构项。`,
      "非开篇章节已移除源小说人物名、具体桥段与 Beat 编号，只保留抽象结构信号。",
      ...(!continuityGuard?.supportsWakeAfterUnconsciousness && normalizedChapterNumber > 1
        ? ["连续性护栏未发现昏迷证据，已压制醒来/惊醒式开场参考。"]
        : []),
    ], 12),
    matches: (packet.matches || []).map((item) => ({
      ...item,
      applicable_phase: chapterPhase,
      requires_fresh_start: false,
      })),
  };
  scoped.summary = referenceMode === "continuation_reference"
    ? "非开篇章节仅借“承接上一章余波 -> 当章行动试探 -> 章末继续加压”的抽象结构，不借原书人物与桥段。"
    : "第三章附近仅借“直接承压 -> 冲突升级 -> 章末递交更大风险”的抽象结构，不借原书人物与桥段。";
  scoped.briefingMarkdown = buildOpeningReferenceMarkdown(scoped);
  return scoped;
}

export async function scopeOpeningReferencePacketWithAgent(provider, packet, {
  chapterNumber = 1,
  freshStart = false,
  continuityGuard = null,
} = {}) {
  if (!packet?.triggered) {
    return packet;
  }

  const heuristicScoped = scopeOpeningReferencePacket(packet, {
    chapterNumber,
    freshStart,
    continuityGuard,
  });
  const normalizedChapterNumber = Number(chapterNumber) || 1;
  if (normalizedChapterNumber <= 1) {
    return heuristicScoped;
  }

  return generateStructuredObject(provider, {
    label: "OpeningReferenceScoperAgent",
    instructions:
      "你是 Novelex 的 OpeningReferenceScoperAgent。你负责把黄金三章参考包压缩成适合当前章节位的抽象结构信号。对非第一章，必须主动压制第一章冷启动模板、源小说人物名、具体桥段和 Beat 编号，只保留连续章节也能安全继承的结构方法。只输出 JSON。",
    input: [
      `chapterNumber=${normalizedChapterNumber}`,
      `freshStart=${freshStart ? "true" : "false"}`,
      `continuityGuard=${JSON.stringify(continuityGuard || {}, null, 2)}`,
      `原始 opening packet：\n${JSON.stringify(packet, null, 2)}`,
      `参考默认压缩结果：\n${JSON.stringify(heuristicScoped, null, 2)}`,
      `请输出 JSON：
{
  "summary": "作用说明",
  "openingHooks": [],
  "protagonistEntryPatterns": [],
  "conflictIgnitionPatterns": ["抽象后的冲突点燃方式"],
  "pacingSignals": ["抽象后的节奏信号"],
  "chapterEndHookPatterns": ["抽象后的章末牵引"],
  "structuralBeats": ["抽象后的结构拍点"],
  "avoidPatterns": ["当前章节位必须避免的模式"],
  "warnings": ["附加说明"]
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "opening_reference_scope",
      chapterNumber: normalizedChapterNumber,
    },
    normalize(parsed) {
      const scoped = {
        ...heuristicScoped,
        summary: String(parsed.summary || heuristicScoped.summary || "").trim(),
        openingHooks: normalizeList(parsed.openingHooks, 6),
        protagonistEntryPatterns: normalizeList(parsed.protagonistEntryPatterns, 6),
        conflictIgnitionPatterns: normalizeList(parsed.conflictIgnitionPatterns, 6),
        pacingSignals: normalizeList(parsed.pacingSignals, 6),
        chapterEndHookPatterns: normalizeList(parsed.chapterEndHookPatterns, 6),
        structuralBeats: normalizeList(parsed.structuralBeats, 8),
        avoidPatterns: normalizeList(parsed.avoidPatterns, 10),
        warnings: normalizeList([
          ...(heuristicScoped.warnings || []),
          ...(Array.isArray(parsed.warnings) ? parsed.warnings : []),
        ], 12),
      };
      scoped.briefingMarkdown = buildOpeningReferenceMarkdown(scoped);
      return scoped;
    },
  });
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
  const openingSignals = normalizeOpeningSignalList([
    ...(writerContext?.openingSignals || []),
    ...(openingReferencePacket.conflictIgnitionPatterns || []),
    ...(openingReferencePacket.pacingSignals || []),
    ...(openingReferencePacket.chapterEndHookPatterns || []),
    ...(openingReferencePacket.structuralBeats || []),
  ], 8);
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
  const nextWriterContext = {
    ...writerContext,
    priorities,
    risks,
    selectedSources,
    openingSignals,
  };
  const markdown = renderWriterContextMarkdown(nextWriterContext);

  return {
    ...nextWriterContext,
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

  const warnings = [];
  const planner = await runOpeningQueryPlannerAgent({
    provider,
    project,
    mode,
    chapterPlan,
    chapterBase,
    planContext,
    historyContext,
  });
  const matches = await runOpeningRecallAgent({
    provider,
    project,
    mode,
    planner,
    chunks,
  });

  if (!matches.length) {
    const emptyPacket = createEmptyOpeningReferencePacket({
      triggered: true,
      mode: "llm_retrieval",
      collectionIds,
      queries: planner.queries,
      focusAspects: planner.focusAspects,
      summary: "已执行黄金三章 LLM 检索，但没有命中高相关片段。",
      warnings,
    });
    emptyPacket.briefingMarkdown = buildOpeningReferenceMarkdown(emptyPacket);
    return emptyPacket;
  }

  const synthesis = await runOpeningPatternSynthesizerAgent({
    provider,
    project,
    mode,
    planner,
    matches,
  });

  const packet = {
    triggered: true,
    mode: "llm_retrieval",
    collectionIds,
    queries: planner.queries,
    focusAspects: planner.focusAspects,
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
}
