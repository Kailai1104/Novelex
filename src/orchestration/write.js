import path from "node:path";

import {
  DEFAULT_STYLE_GUIDE_MARKDOWN,
  PLAN_STATUS,
  REVIEW_TARGETS,
  WRITE_STATUS,
} from "../core/defaults.js";
import {
  buildChapterMeta,
  buildStyleGuide,
  updateCharacterStates,
  updateForeshadowingRegistry,
  updateWorldState,
} from "../core/generators.js";
import { buildContextTrace } from "../core/context-trace.js";
import {
  buildContextPackage,
  buildGovernedChapterIntent,
  buildGovernedInputContract,
  buildRuleStack,
} from "../core/input-governance.js";
import {
  chapterNumberFromId,
  chapterIdFromNumber,
  composeChapterMarkdown,
  createExcerpt,
  extractJsonObject,
  locateSelectedText,
  nowIso,
  replaceSelectionInChapterMarkdown,
  safeJsonParse,
  sanitizeRevisionFragment,
  splitChapterMarkdown,
} from "../core/text.js";
import { createProvider } from "../llm/provider.js";
import { formatMcpErrorMessage } from "../mcp/error.js";
import { getWorkspaceMcpManager, normalizeWebSearchToolResult } from "../mcp/index.js";
import {
  buildOpeningReferencePacket,
  createEmptyOpeningReferencePacket,
  mergeOpeningIntoOutlineContext,
  mergeOpeningIntoWriterContext,
} from "../opening/reference.js";
import {
  buildReferencePacket,
  createEmptyReferencePacket,
  mergeReferenceIntoWriterContext,
} from "../rag/reference.js";
import {
  appendFactsToLedger,
  buildFactContextPacket,
  buildCanonFactRevisionNotes,
  collectCanonFactContinuityIssues,
  loadFactLedger,
  rebuildFactLedger,
  runChapterFactExtractionAgent,
  runFactSelectorAgent,
  saveChapterFacts,
} from "../core/facts.js";
import {
  collectAuditRepairNotes,
  needsAuditStyleRepair,
  runChapterAudit,
  summarizeAuditResult,
} from "./audit.js";
import { buildWriterContextBundle } from "../retrieval/writer-context.js";

function runId(prefix) {
  return `${prefix}-${Date.now()}`;
}

const DEFAULT_OUTLINE_OPTIONS = {
  variantCount: 3,
  diversityPreset: "wide",
};

const OUTLINE_VARIANT_COUNT_LIMITS = {
  min: 2,
  max: 5,
};

const OUTLINE_DIVERSITY_PRESETS = {
  standard: {
    temperature: 0.9,
  },
  wide: {
    temperature: 1.15,
  },
};

function step(id, label, layer, summary, extra = {}) {
  return {
    id,
    label,
    layer,
    status: "completed",
    summary,
    ...extra,
  };
}

function normalizeOutlineOptions(options = null) {
  const requestedCount = Number(options?.variantCount);
  const variantCount = Number.isFinite(requestedCount)
    ? Math.max(OUTLINE_VARIANT_COUNT_LIMITS.min, Math.min(OUTLINE_VARIANT_COUNT_LIMITS.max, Math.round(requestedCount)))
    : DEFAULT_OUTLINE_OPTIONS.variantCount;
  const diversityPreset = Object.prototype.hasOwnProperty.call(OUTLINE_DIVERSITY_PRESETS, options?.diversityPreset)
    ? options.diversityPreset
    : DEFAULT_OUTLINE_OPTIONS.diversityPreset;

  return {
    variantCount,
    diversityPreset,
    temperature: OUTLINE_DIVERSITY_PRESETS[diversityPreset].temperature,
  };
}

function normalizeStringList(values, limit = 8) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean))].slice(0, limit);
}

const OUTLINE_THREAD_MODES = new Set(["single_spine", "dual_spine", "braided"]);

function normalizeThreadMode(value, fallback = "single_spine") {
  const normalized = String(value || "").trim();
  return OUTLINE_THREAD_MODES.has(normalized) ? normalized : fallback;
}

function chapterNumberValue(chapterId = "", fallback = 0) {
  const parsed = Number(String(chapterId || "").replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function keywordTokens(values = []) {
  return normalizeStringList(values.flatMap((item) => String(item || "")
    .split(/[；，、,。\s/|:：()（）\[\]\-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)), 48);
}

function sceneChainDigest(scene) {
  if (!scene || typeof scene !== "object") {
    return "";
  }
  return [
    scene.label || "场景",
    scene.scenePurpose || scene.focus || "",
    scene.inheritsFromPrevious ? `承接:${scene.inheritsFromPrevious}` : "",
    scene.outcome ? `结果:${scene.outcome}` : "",
    scene.handoffToNext ? `交棒:${scene.handoffToNext}` : "",
  ].filter(Boolean).join("｜");
}

function chapterOutlineDigest(outline) {
  const chapterPlan = outline?.chapterPlan || outline || {};
  const scenes = Array.isArray(chapterPlan.scenes) ? chapterPlan.scenes : [];
  const dominantThread = String(
    chapterPlan.dominantThread ||
    outline?.summary ||
    chapterPlan.keyEvents?.[0] ||
    chapterPlan.nextHook ||
    "",
  ).trim();
  const openThreads = normalizeStringList([
    chapterPlan.exitPressure,
    chapterPlan.nextHook,
    dominantThread,
    ...scenes.slice(-2).map((scene) => scene.handoffToNext || scene.outcome || ""),
  ], 4);

  return {
    chapterId: chapterPlan.chapterId || "",
    chapterNumber: Number(chapterPlan.chapterNumber || chapterNumberValue(chapterPlan.chapterId, 0)) || 0,
    title: chapterPlan.title || "",
    stage: chapterPlan.stage || "",
    dominantThread,
    threadMode: normalizeThreadMode(chapterPlan.threadMode, "single_spine"),
    charactersPresent: normalizeStringList(chapterPlan.charactersPresent, 8),
    foreshadowingIds: normalizeStringList((chapterPlan.foreshadowingActions || []).map((item) => item?.id), 8),
    continuityAnchors: normalizeStringList(chapterPlan.continuityAnchors, 8),
    keyEvents: normalizeStringList(chapterPlan.keyEvents, 6),
    nextHook: String(chapterPlan.nextHook || "").trim(),
    exitPressure: String(chapterPlan.exitPressure || chapterPlan.nextHook || "").trim(),
    sceneChain: scenes.map(sceneChainDigest).filter(Boolean),
    openThreads,
    chapterPlan,
  };
}

function scoreOutlineRelevance(currentChapterBase, outlineDigest) {
  const currentCharacters = new Set(normalizeStringList(currentChapterBase.charactersPresent, 12));
  const currentForeshadowingIds = new Set(normalizeStringList(
    (currentChapterBase.foreshadowingActions || []).map((item) => item?.id),
    12,
  ));
  const currentTokens = new Set(keywordTokens([
    currentChapterBase.stage,
    currentChapterBase.title,
    currentChapterBase.location,
    currentChapterBase.nextHook,
    ...(currentChapterBase.keyEvents || []),
    ...(currentChapterBase.continuityAnchors || []),
  ]));
  let score = 0;

  if (outlineDigest.stage && outlineDigest.stage === currentChapterBase.stage) {
    score += 4;
  }
  if (outlineDigest.chapterNumber === Math.max(0, currentChapterBase.chapterNumber - 1)) {
    score += 6;
  }

  for (const name of outlineDigest.charactersPresent || []) {
    if (currentCharacters.has(name)) {
      score += 2;
    }
  }
  for (const foreshadowingId of outlineDigest.foreshadowingIds || []) {
    if (currentForeshadowingIds.has(foreshadowingId)) {
      score += 3;
    }
  }
  for (const token of keywordTokens([
    outlineDigest.dominantThread,
    outlineDigest.nextHook,
    outlineDigest.exitPressure,
    ...(outlineDigest.openThreads || []),
    ...(outlineDigest.continuityAnchors || []),
  ])) {
    if (currentTokens.has(token)) {
      score += 1;
    }
  }

  return score;
}

function summarizeCommittedHistoryForPrompt(committedOutlines = []) {
  return committedOutlines
    .map((item) => {
      const sceneChain = (item.sceneChain || []).slice(0, 3).join(" || ") || "无场景链";
      return `- ${item.chapterId} ${item.title}｜阶段:${item.stage || "无"}｜主线:${item.dominantThread || "无"}｜模式:${item.threadMode}｜关键事件:${(item.keyEvents || []).join("；") || "无"}｜场景链:${sceneChain}｜章末压力:${item.exitPressure || item.nextHook || "无"}｜未完线程:${(item.openThreads || []).join("；") || "无"}｜锚点:${(item.continuityAnchors || []).join("；") || "无"}`;
    })
    .join("\n");
}

function expandCommittedHistoryDetails(committedOutlines = [], chapterBase, limit = 4) {
  return [...committedOutlines]
    .map((item) => ({
      ...item,
      relevance: scoreOutlineRelevance(chapterBase, item),
    }))
    .sort((left, right) => {
      if (right.relevance !== left.relevance) {
        return right.relevance - left.relevance;
      }
      return right.chapterNumber - left.chapterNumber;
    })
    .slice(0, limit)
    .map((item) => [
      `## ${item.chapterId} ${item.title}`,
      `阶段：${item.stage || "无"}`,
      `主线：${item.dominantThread || "无"}`,
      `关键事件：${(item.keyEvents || []).join("；") || "无"}`,
      `场景链：${(item.sceneChain || []).join(" || ") || "无"}`,
      `章末压力：${item.exitPressure || item.nextHook || "无"}`,
      `未完线程：${(item.openThreads || []).join("；") || "无"}`,
      `连续性锚点：${(item.continuityAnchors || []).join("；") || "无"}`,
    ].join("\n"))
    .join("\n\n");
}

function buildFallbackContinuityPlanning({ chapterBase, stagePlanning, historyPlanning, previousOutline, nextLegacyPlan }) {
  if (chapterBase.chapterNumber <= 1 || !previousOutline?.chapterPlan) {
    return {
      source: "fallback_opening",
      entryLink: "作为开篇章节，直接从主角当前处境与核心压力切入。",
      dominantCarryoverThread: stagePlanning.chapterMission || historyPlanning.globalTrajectory || "建立本章主线。",
      subordinateThreads: normalizeStringList([
        ...(historyPlanning.backgroundThreads || []),
        ...(historyPlanning.openThreads || []),
      ], 4),
      mustAdvanceThisChapter: stagePlanning.nextPressure || chapterBase.nextHook || "把主线推进到下一步必须行动。",
      canPauseThisChapter: normalizeStringList([
        ...(historyPlanning.suppressedThreads || []),
        ...(historyPlanning.backgroundThreads || []).slice(0, 2),
      ], 4),
      exitPressureToNextChapter: nextLegacyPlan?.nextHook || stagePlanning.nextPressure || chapterBase.nextHook || "给下一章留下明确压力。",
      continuityRisks: normalizeStringList([
        "开篇不要把世界信息一次说完，要让压力先落地。",
        ...((historyPlanning.suppressedThreads || []).slice(0, 2)),
      ], 4),
    };
  }

  const previousPlan = previousOutline.chapterPlan || {};
  const previousLastScene = Array.isArray(previousPlan.scenes) ? previousPlan.scenes.at(-1) : null;
  return {
    source: "fallback",
    entryLink: String(
      previousPlan.exitPressure ||
      previousPlan.nextHook ||
      previousLastScene?.handoffToNext ||
      previousLastScene?.outcome ||
      historyPlanning.lastEnding ||
      "承接上一章留下的直接压力。",
    ).trim(),
    dominantCarryoverThread: String(
      historyPlanning.priorityThreads?.[0] ||
      previousPlan.dominantThread ||
      stagePlanning.chapterMission ||
      "延续上一章主线压力。",
    ).trim(),
    subordinateThreads: normalizeStringList([
      ...(historyPlanning.backgroundThreads || []),
      ...(historyPlanning.openThreads || []),
    ], 4),
    mustAdvanceThisChapter: String(
      stagePlanning.requiredBeats?.[0] ||
      stagePlanning.chapterMission ||
      previousPlan.nextHook ||
      "把上一章留下的问题推进到新的局面。",
    ).trim(),
    canPauseThisChapter: normalizeStringList([
      ...(historyPlanning.suppressedThreads || []),
      ...(historyPlanning.backgroundThreads || []),
    ], 4),
    exitPressureToNextChapter: String(
      nextLegacyPlan?.nextHook ||
      stagePlanning.nextPressure ||
      chapterBase.nextHook ||
      "给下一章留下新的动作压力。",
    ).trim(),
    continuityRisks: normalizeStringList([
      "不要让本章开头与上一章结尾脱节。",
      ...(historyPlanning.suppressedThreads || []).slice(0, 2),
    ], 4),
  };
}

function projectSummary(project) {
  return [
    `标题：${project.title}`,
    `类型：${project.genre}`,
    `背景：${project.setting}`,
    `主题：${project.theme}`,
    `前提：${project.premise}`,
    `主角目标：${project.protagonistGoal}`,
    `风格备注：${project.styleNotes || "无"}`,
    `研究备注：${project.researchNotes || "无"}`,
  ].join("\n");
}

async function loadCommittedPlanBundle(store) {
  const bundlePath = path.join(store.paths.novelStateDir, "bundle.json");
  return store.readJson(bundlePath, null);
}

async function loadCurrentCharacterStates(store, bundle) {
  const states = [];
  for (const character of bundle.characters) {
    const filePath = path.join(store.paths.charactersDir, `${character.name}_state.json`);
    const state = await store.readJson(filePath, character.state);
    states.push(state);
  }
  return states;
}

function findStageForChapterNumber(structureData = {}, chapterNumber = 0) {
  const chapterId = chapterIdFromNumber(chapterNumber);
  return (Array.isArray(structureData?.stages) ? structureData.stages : []).find((stage) => {
    const range = Array.isArray(stage?.range) ? stage.range : [];
    if (range.length === 2 && chapterNumber >= Number(range[0]) && chapterNumber <= Number(range[1])) {
      return true;
    }
    return Array.isArray(stage?.chapters) && stage.chapters.includes(chapterId);
  }) || null;
}

function legacyChapterReference(bundle, chapterNumber = 0) {
  const chapters = Array.isArray(bundle?.structureData?.chapters) ? bundle.structureData.chapters : [];
  return chapters.find((chapter) => Number(chapter.chapterNumber || 0) === chapterNumber) || null;
}

function buildForeshadowingActionsForChapter(registry, chapterNumber = 0) {
  const items = Array.isArray(registry?.foreshadowings) ? registry.foreshadowings : [];
  return items
    .flatMap((item) => {
      const actions = [];
      const plantChapter = Number(String(item?.planned_plant_chapter || "").replace(/[^\d]/g, "")) || 0;
      const payoffChapter = Number(item?.intended_payoff_chapter || 0) || 0;
      const waterChapters = Array.isArray(item?.waterAt) ? item.waterAt.map((chapter) => Number(chapter) || 0) : [];
      if (plantChapter === chapterNumber) {
        actions.push({
          id: item.id,
          action: "plant",
          description: item.description,
        });
      }
      if (waterChapters.includes(chapterNumber)) {
        actions.push({
          id: item.id,
          action: "water",
          description: item.description,
        });
      }
      if (payoffChapter === chapterNumber) {
        actions.push({
          id: item.id,
          action: "resolve",
          description: item.description,
        });
      }
      return actions;
    });
}

function buildOutlineBaseChapterPlan({
  project,
  chapterNumber,
  stage,
  legacyPlan = null,
  foreshadowingActions = [],
}) {
  const chapterId = chapterIdFromNumber(chapterNumber);
  return {
    chapterId,
    chapterNumber,
    title: legacyPlan?.title || `第${chapterNumber}章`,
    stage: stage?.label || `阶段${Math.max(1, Number(project.stageCount) || 1)}`,
    timeInStory: legacyPlan?.timeInStory || `第${chapterNumber}章对应故事时间`,
    povCharacter: legacyPlan?.povCharacter || project.protagonistName || "主角",
    location: legacyPlan?.location || project.setting,
    keyEvents: Array.isArray(legacyPlan?.keyEvents) ? legacyPlan.keyEvents : [],
    arcContribution: Array.isArray(legacyPlan?.arcContribution) ? legacyPlan.arcContribution : [],
    nextHook: legacyPlan?.nextHook || "",
    emotionalTone: legacyPlan?.emotionalTone || "",
    threadMode: normalizeThreadMode(legacyPlan?.threadMode, "single_spine"),
    dominantThread: legacyPlan?.dominantThread || "",
    entryLink: legacyPlan?.entryLink || "",
    exitPressure: legacyPlan?.exitPressure || legacyPlan?.nextHook || "",
    charactersPresent: Array.isArray(legacyPlan?.charactersPresent) ? legacyPlan.charactersPresent : [project.protagonistName || "主角"],
    foreshadowingActions,
    continuityAnchors: Array.isArray(legacyPlan?.continuityAnchors) ? legacyPlan.continuityAnchors : [],
    scenes: Array.isArray(legacyPlan?.scenes) ? legacyPlan.scenes : [],
  };
}

function createEmptyResearchPacket(extra = {}) {
  return {
    triggered: false,
    mode: "skipped",
    reason: "",
    summary: "",
    queries: [],
    focusFacts: [],
    factsToUse: [],
    factsToAvoid: [],
    termBank: [],
    uncertainPoints: [],
    sourceNotes: [],
    sources: [],
    briefingMarkdown: "当前章节无需额外考据。",
    ...extra,
  };
}

function normalizeResearchTextList(values, limit = 6) {
  return (Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeResearchTerms(values, limit = 8) {
  const flattened = [];

  function pushTerm(term, note = "") {
    const normalizedTerm = String(term || "").trim();
    const normalizedNote = String(note || "").trim();
    if (!normalizedTerm && !normalizedNote) {
      return;
    }
    flattened.push([normalizedTerm, normalizedNote].filter(Boolean).join("："));
  }

  function visit(node, sectionLabel = "") {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, sectionLabel));
      return;
    }
    if (typeof node === "string") {
      pushTerm(node);
      return;
    }
    if (typeof node !== "object") {
      return;
    }

    const explicitTerm = String(node.term || node.name || "").trim();
    if (explicitTerm) {
      pushTerm(explicitTerm, node.note || node.definition || node.usage || "");
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") {
        visit(value, key);
        continue;
      }
      pushTerm(key, sectionLabel ? `${sectionLabel}：${String(value || "").trim()}` : value);
    }
  }

  visit(values);

  return flattened
    .filter(Boolean)
    .slice(0, limit);
}

function buildResearchMarkdown(packet) {
  if (!packet?.triggered) {
    return "当前章节无需额外考据。";
  }

  return [
    "# 研究资料包",
    "",
    `- 研究摘要：${packet.summary || "无"}`,
    `- 检索问题：${(packet.queries || []).join("；") || "无"}`,
    `- 建议采用的事实：${(packet.factsToUse || []).join("；") || "无"}`,
    `- 需要避免的误写：${(packet.factsToAvoid || []).join("；") || "无"}`,
    `- 推荐术语：${(packet.termBank || []).join("；") || "无"}`,
    `- 仍不确定点：${(packet.uncertainPoints || []).join("；") || "无"}`,
    `- 来源备注：${(packet.sourceNotes || []).join("；") || "无"}`,
  ].join("\n");
}

function collectResearchSources(searchPackets = []) {
  const seen = new Set();
  const sources = [];

  for (const packet of Array.isArray(searchPackets) ? searchPackets : []) {
    const sourceType = String(packet?.sourceType || "mcp_web_search").trim() || "mcp_web_search";
    for (const result of Array.isArray(packet?.results) ? packet.results : []) {
      const url = String(result?.url || "").trim();
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      sources.push({
        title: String(result?.title || url).trim(),
        url,
        snippet: String(result?.snippet || "").trim(),
        type: sourceType,
      });
      if (sources.length >= 10) {
        return sources;
      }
    }
  }

  return sources;
}

function buildResearchSearchBrief(searchPackets = []) {
  return (Array.isArray(searchPackets) ? searchPackets : [])
    .map((packet) => [
      `## 查询：${packet.query || "未命名查询"}`,
      ...(Array.isArray(packet.results) && packet.results.length
        ? packet.results.map((item, index) => `${index + 1}. ${item.title || item.url}\nURL: ${item.url}\n摘要: ${item.snippet || "无"}`)
        : ["- 无结果"]),
      ...(Array.isArray(packet.textFragments) && packet.textFragments.length
        ? [`附加文本：${packet.textFragments.join(" | ")}`]
        : []),
    ].join("\n"))
    .join("\n\n");
}

function buildResearchRetrieverJsonSchema() {
  return `请输出 JSON：
{
  "summary": "本章研究摘要",
  "factsToUse": ["可直接用于写作的事实1", "事实2"],
  "factsToAvoid": ["需要避免的误写1", "误写2"],
  "termBank": ["术语：解释"],
  "uncertainPoints": ["仍不确定点1"],
  "sourceNotes": ["来源1为什么可信", "来源2说明了什么"]
}`;
}

function buildResearchRetrieverContext({
  project,
  chapterPlan,
  plannerPacket,
}) {
  return [
    `作品：${project.title}`,
    `题材：${project.genre}`,
    `设定：${project.setting}`,
    `研究备注：${project.researchNotes || "无"}`,
    `当前章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
    `章节地点：${chapterPlan.location}`,
    `故事时间：${chapterPlan.timeInStory}`,
    `检索问题：${plannerPacket.queries.join("；")}`,
    `重点核对：${(plannerPacket.focusFacts || []).join("；") || "无"}`,
  ];
}

function buildResearchRetrieverPacket(parsed, sources, extra = {}) {
  return {
    triggered: true,
    mode: "retrieved",
    summary: String(parsed.summary || "").trim(),
    factsToUse: normalizeResearchTextList(parsed.factsToUse, 8),
    factsToAvoid: normalizeResearchTextList(parsed.factsToAvoid, 6),
    termBank: normalizeResearchTerms(parsed.termBank, 8),
    uncertainPoints: normalizeResearchTextList(parsed.uncertainPoints, 5),
    sourceNotes: normalizeResearchTextList(parsed.sourceNotes, 6),
    sources: Array.isArray(sources) ? sources.slice(0, 10) : [],
    ...extra,
  };
}

async function runResearchPlannerAgent({
  provider,
  project,
  chapterPlan,
}) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 ResearchPlannerAgent。请判断当前章节是否真的需要外部检索，并把需要搜索的事实问题拆成少量高价值查询。不要泛泛而谈，只保留会直接影响本章写法的时代细节、术语、礼制、工艺、地理、制度、兵制或生活方式。只输出 JSON。",
    input: [
      `作品：${project.title}`,
      `题材：${project.genre}`,
      `设定：${project.setting}`,
      `研究备注：${project.researchNotes || "无"}`,
      `当前章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
      `故事时间：${chapterPlan.timeInStory}`,
      `章节地点：${chapterPlan.location}`,
      `关键事件：${chapterPlan.keyEvents.join("；")}`,
      `连续性锚点：${chapterPlan.continuityAnchors.join("；") || "无"}`,
      `请输出 JSON：
{
  "triggered": true,
  "reason": "为什么需要或不需要研究",
  "queries": ["检索问题1", "检索问题2"],
  "focusFacts": ["重点核对事实1", "重点核对事实2"],
  "riskFlags": ["最容易写错的点"]
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "research_planner",
      chapterId: chapterPlan.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`ResearchPlannerAgent 返回了无法解析的结果：${createExcerpt(result.text, 160)}`);
  }

  const queries = normalizeResearchTextList(parsed.queries, 4);
  const focusFacts = normalizeResearchTextList(
    [...normalizeResearchTextList(parsed.focusFacts, 6), ...normalizeResearchTextList(parsed.riskFlags, 4)],
    8,
  );

  if (!parsed.triggered || !queries.length) {
    return createEmptyResearchPacket({
      reason: String(parsed.reason || "").trim(),
    });
  }

  return {
    triggered: true,
    mode: "planned",
    reason: String(parsed.reason || "").trim(),
    queries,
    focusFacts,
  };
}

async function runResearchRetriever({
  mcpManager,
  provider,
  project,
  chapterPlan,
  plannerPacket,
}) {
  if (!plannerPacket?.triggered || !(plannerPacket.queries || []).length) {
    return createEmptyResearchPacket();
  }

  try {
    const searchPackets = [];
    for (const query of plannerPacket.queries) {
      const toolResult = await mcpManager.callTool("web_search", { query }, {
        chapterId: chapterPlan.chapterId,
        feature: "research_retriever",
      });
      searchPackets.push(normalizeWebSearchToolResult(toolResult, { query }));
    }

    const sources = collectResearchSources(searchPackets);
    if (!sources.length) {
      throw new Error("ResearchRetriever 没有从 MCP web_search 返回可用来源。");
    }

    const result = await provider.generateText({
      instructions:
        "你是 Novelex 的 ResearchRetriever。你会收到一组已经完成的外部搜索结果。请只基于这些结果输出 JSON，总结当前章节真正该用的事实、该避开的误写、推荐术语、不确定点与来源备注。",
      input: [
        ...buildResearchRetrieverContext({
          project,
          chapterPlan,
          plannerPacket,
        }),
        `MCP web_search 结果：\n${buildResearchSearchBrief(searchPackets)}`,
        buildResearchRetrieverJsonSchema(),
      ].join("\n\n"),
      reasoningEffort: "low",
      metadata: {
        feature: "research_retriever",
        chapterId: chapterPlan.chapterId,
      },
    });

    const parsed = safeJsonParse(extractJsonObject(result.text), null);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`ResearchRetriever 返回了无法解析的结果：${createExcerpt(result.text, 160)}`);
    }

    return buildResearchRetrieverPacket(parsed, sources);
  } catch (mcpError) {
    try {
      const result = await provider.generateText({
        instructions:
          "你是 Novelex 的 ResearchRetriever。请直接调用 web_search 工具检索给定问题，只基于检索结果输出 JSON，总结当前章节真正该用的事实、该避开的误写、推荐术语、不确定点与来源备注。",
        input: [
          ...buildResearchRetrieverContext({
            project,
            chapterPlan,
            plannerPacket,
          }),
          `补充说明：MCP web_search 当前不可用，已改为 provider 级 web_search 回退。请在输出里保留必要的来源说明，并尽量给出可追溯线索。`,
          buildResearchRetrieverJsonSchema(),
        ].join("\n\n"),
        tools: [{ type: "web_search" }],
        toolChoice: "auto",
        include: ["web_search_call.action.sources"],
        reasoningEffort: "low",
        metadata: {
          feature: "research_retriever_provider_fallback",
          chapterId: chapterPlan.chapterId,
        },
      });

      const parsed = safeJsonParse(extractJsonObject(result.text), null);
      if (!parsed || typeof parsed !== "object") {
        throw new Error(`ResearchRetriever provider fallback 返回了无法解析的结果：${createExcerpt(result.text, 160)}`);
      }

      const fallbackSearchPacket = {
        ...normalizeWebSearchToolResult(result.raw, {
          query: plannerPacket.queries.join("；"),
        }),
        sourceType: "provider_web_search",
      };
      const sources = collectResearchSources([fallbackSearchPacket]);
      const sourceNotes = normalizeResearchTextList(
        [
          ...normalizeResearchTextList(parsed.sourceNotes, 5),
          "MCP web_search 不可用，已回退到 provider 级 web_search。",
        ],
        6,
      );

      return buildResearchRetrieverPacket(parsed, sources, {
        mode: "provider_web_search",
        sourceNotes,
      });
    } catch (fallbackError) {
      throw new Error(
        `${formatMcpErrorMessage("MCP web_search", mcpError)}；provider web_search 回退也失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError || "")}`,
      );
    }
  }
}

async function runResearchSynthesizerAgent({
  provider,
  project,
  chapterPlan,
  plannerPacket,
  retrievalPacket,
}) {
  if (!plannerPacket?.triggered) {
    return createEmptyResearchPacket();
  }

  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 ResearchSynthesizerAgent。请把检索结果压缩成 Writer 直接能消费的研究资料包。只保留会影响本章写法的事实、术语、误写风险和未决点。只输出 JSON。",
    input: [
      `作品：${project.title}`,
      `当前章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
      `ResearchPlanner 结果：${JSON.stringify(plannerPacket, null, 2)}`,
      `ResearchRetriever 结果：${JSON.stringify(retrievalPacket, null, 2)}`,
      `请输出 JSON：
{
  "summary": "供写作直接使用的研究摘要",
  "factsToUse": ["事实1", "事实2"],
  "factsToAvoid": ["误写1", "误写2"],
  "termBank": ["术语：解释"],
  "uncertainPoints": ["未决点1"],
  "sourceNotes": ["来源说明1", "来源说明2"]
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "research_synthesizer",
      chapterId: chapterPlan.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`ResearchSynthesizerAgent 返回了无法解析的结果：${createExcerpt(result.text, 160)}`);
  }

  const packet = {
    triggered: true,
    mode: retrievalPacket.mode === "provider_web_search" ? "provider_web_search" : "search_tool",
    reason: plannerPacket.reason || "",
    queries: plannerPacket.queries || [],
    focusFacts: plannerPacket.focusFacts || [],
    summary: String(parsed.summary || retrievalPacket.summary || "").trim(),
    factsToUse: normalizeResearchTextList(parsed.factsToUse || retrievalPacket.factsToUse, 8),
    factsToAvoid: normalizeResearchTextList(parsed.factsToAvoid || retrievalPacket.factsToAvoid, 6),
    termBank: normalizeResearchTerms(parsed.termBank || retrievalPacket.termBank, 8),
    uncertainPoints: normalizeResearchTextList(parsed.uncertainPoints || retrievalPacket.uncertainPoints, 5),
    sourceNotes: normalizeResearchTextList(parsed.sourceNotes || retrievalPacket.sourceNotes, 6),
    sources: Array.isArray(retrievalPacket.sources) ? retrievalPacket.sources.slice(0, 10) : [],
  };

  packet.briefingMarkdown = buildResearchMarkdown(packet);
  return packet;
}

async function buildResearchPacket({
  mcpManager,
  provider,
  project,
  chapterPlan,
}) {
  const plannerPacket = await runResearchPlannerAgent({
    provider,
    project,
    chapterPlan,
  });
  if (!plannerPacket.triggered) {
    return plannerPacket;
  }

  try {
    const retrievalPacket = await runResearchRetriever({
      mcpManager,
      provider,
      project,
      chapterPlan,
      plannerPacket,
    });
    return runResearchSynthesizerAgent({
      provider,
      project,
      chapterPlan,
      plannerPacket,
      retrievalPacket,
    });
  } catch (error) {
    return createEmptyResearchPacket({
      triggered: true,
      mode: "search_failed",
      reason: plannerPacket.reason || "",
      queries: plannerPacket.queries || [],
      focusFacts: plannerPacket.focusFacts || [],
      summary: `ResearchRetriever 调用失败：${error instanceof Error ? formatMcpErrorMessage("ResearchRetriever", error) : String(error || "")}`,
      sourceNotes: ["模型搜索工具调用失败，本章仍继续写作，但请人工留意考据风险。"],
      briefingMarkdown: buildResearchMarkdown({
        triggered: true,
        summary: `ResearchRetriever 调用失败：${error instanceof Error ? formatMcpErrorMessage("ResearchRetriever", error) : String(error || "")}`,
        queries: plannerPacket.queries || [],
        factsToUse: [],
        factsToAvoid: [],
        termBank: [],
        uncertainPoints: plannerPacket.focusFacts || [],
        sourceNotes: ["模型搜索工具调用失败，本章仍继续写作，但请人工留意考据风险。"],
      }),
    });
  }
}

function researchPacketFromDraft(draftBundle) {
  return draftBundle?.researchPacket || createEmptyResearchPacket();
}

function referencePacketFromDraft(draftBundle) {
  return draftBundle?.referencePacket || createEmptyReferencePacket();
}

function openingReferencePacketFromDraft(draftBundle) {
  return draftBundle?.openingReferencePacket || createEmptyOpeningReferencePacket();
}

function emptyHistoryContext() {
  return {
    relatedChapters: [],
    selectedFiles: [],
    continuityAnchors: [],
    carryOverFacts: [],
    emotionalCarryover: [],
    openThreads: [],
    mustNotContradict: [],
    lastEnding: "上一章节的余波还在。",
    retrievalMode: "history-context-agents",
    contextSummary: "当前没有额外历史上下文。",
    briefingMarkdown: "当前没有额外历史上下文。",
  };
}

function historyContextFromDraft(draftBundle) {
  return draftBundle?.historyContext || draftBundle?.retrieval || emptyHistoryContext();
}

function writerContextFromDraft(draftBundle) {
  return draftBundle?.writerContext || {
    briefingMarkdown: "当前没有额外 Writer 上下文包。",
  };
}

function emptyGovernanceArtifacts(chapterPlan = null) {
  const chapterId = String(chapterPlan?.chapterId || "").trim();
  const chapterNumber = Number(chapterPlan?.chapterNumber || 0);

  return {
    chapterIntent: {
      chapter: chapterNumber,
      chapterId,
      title: String(chapterPlan?.title || "").trim(),
      goal: "",
      mustKeep: [],
      mustAvoid: [],
      styleEmphasis: [],
      conflicts: [],
      hookAgenda: {
        mustAdvance: [],
        eligibleResolve: [],
        staleDebt: [],
        avoidNewHookFamilies: [],
      },
    },
    contextPackage: {
      chapter: chapterNumber,
      chapterId,
      selectedContext: [],
    },
    ruleStack: {
      chapter: chapterNumber,
      chapterId,
      precedence: ["hardFacts", "softGoals", "deferRules", "currentTask"],
      hardFacts: [],
      softGoals: [],
      deferRules: [],
      currentTask: [],
    },
    contextTrace: {
      chapter: chapterNumber,
      chapterId,
      selectedDocuments: [],
      promptInputs: [],
      activeRules: {
        hardFacts: [],
        softGoals: [],
        deferRules: [],
        currentTask: [],
      },
      researchSources: [],
      referenceSources: [],
      notes: [],
    },
  };
}

function governanceFromDraft(draftBundle, chapterPlan = null) {
  const fallback = emptyGovernanceArtifacts(chapterPlan || draftBundle?.chapterPlan);
  return {
    chapterIntent: draftBundle?.chapterIntent || fallback.chapterIntent,
    contextPackage: draftBundle?.contextPackage || fallback.contextPackage,
    ruleStack: draftBundle?.ruleStack || fallback.ruleStack,
    contextTrace: draftBundle?.contextTrace || draftBundle?.trace || fallback.contextTrace,
  };
}

function buildGovernanceResources({
  chapterPlan,
  planContext,
  historyPacket,
  writerContext,
  foreshadowingAdvice,
  researchPacket,
  referencePacket,
  openingReferencePacket,
  styleGuideText,
  styleGuideSourcePath,
  factContext = null,
}) {
  const chapterIntent = buildGovernedChapterIntent({
    chapterPlan,
    planContext,
    historyPacket,
    foreshadowingAdvice,
    researchPacket,
    styleGuideText,
    factContext,
  });
  const contextPackage = buildContextPackage({
    chapterPlan,
    planContext,
    historyPacket,
    writerContext,
    researchPacket,
    referencePacket,
    openingReferencePacket,
    factContext,
  });
  const ruleStack = buildRuleStack({
    chapterPlan,
    chapterIntent,
    planContext,
    historyPacket,
    researchPacket,
    referencePacket,
    openingReferencePacket,
    factContext,
  });
  const contextTrace = buildContextTrace({
    chapterPlan,
    chapterIntent,
    contextPackage,
    ruleStack,
    writerContext,
    historyPacket,
    researchPacket,
    referencePacket,
    openingReferencePacket,
    styleGuideText,
    styleGuideSourcePath,
  });

  return {
    chapterIntent,
    contextPackage,
    ruleStack,
    contextTrace,
  };
}

function collectForeshadowingAdvice(registry, chapterPlan) {
  const chapterIds = new Set(chapterPlan.foreshadowingActions.map((item) => item.id));
  return registry.foreshadowings.filter(
    (item) =>
      chapterIds.has(item.id) ||
      (item.urgency === "high" && item.status !== "resolved"),
  );
}

function validationSummary(validation) {
  return summarizeAuditResult(validation);
}

const MAX_AUDIT_AUTO_REPAIR_ATTEMPTS = 3;
const PARTIAL_TARGET_REPAIR_IDS = new Set(["knowledge_boundary", "pov_consistency", "meta_leak"]);
const CHAPTER_TARGET_REPAIR_IDS = new Set(["chapter_restart_replay", "chapter_word_count"]);
const HIGH_VALUE_WARNING_IDS = new Set(["chapter_word_count", "pov_consistency", "meta_leak"]);

function ensureChapterValidationPassed(chapterPlan, validation) {
  if (validation?.overallPassed) {
    return;
  }
  throw new Error(`${chapterPlan?.chapterId || "chapter"} 审计未通过：${validationSummary(validation)}`);
}

function collectCriticalCanonFactIssues(validation) {
  return (validation?.issues || []).filter(
    (issue) => issue.id === "canon_fact_continuity" && issue.severity === "critical",
  );
}

function uniqueTextNotes(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
}

function collectBlockingAuditIssues(validation) {
  return (validation?.issues || []).filter((issue) => issue.severity === "critical");
}

function issueIdentity(issue) {
  return `${issue?.id || ""}::${issue?.description || ""}`;
}

function unresolvedCriticalIssueKeys(validation) {
  return collectBlockingAuditIssues(validation).map(issueIdentity).sort();
}

function unresolvedCriticalIssueSummaries(validation) {
  return collectBlockingAuditIssues(validation).map((issue) => ({
    id: issue.id,
    category: issue.category,
    description: issue.description,
  }));
}

function compactIssueEvidence(evidence = "", limit = 220) {
  return createExcerpt(
    String(evidence || "")
      .replace(/\s*\/\s*/g, " / ")
      .replace(/\s+/g, " ")
      .trim(),
    limit,
  );
}

function buildIssueRepairDirective(issue) {
  const parts = [
    `[${issue.severity}] ${issue.category} / ${issue.id}`,
    `问题：${issue.description}`,
  ];
  if (issue.evidence) {
    parts.push(`证据：${compactIssueEvidence(issue.evidence)}`);
  }
  if (issue.suggestion) {
    parts.push(`目标效果：${issue.suggestion}`);
  }
  return parts.join("｜");
}

function collectStructuredAuditRepairNotes(validation, options = {}) {
  const severityAllowList = Array.isArray(options?.severities) && options.severities.length
    ? new Set(options.severities)
    : new Set(["critical"]);
  const idAllowList = Array.isArray(options?.issueIds) && options.issueIds.length
    ? new Set(options.issueIds)
    : null;

  return uniqueTextNotes((validation?.issues || [])
    .filter((issue) => severityAllowList.has(issue.severity))
    .filter((issue) => !idAllowList || idAllowList.has(issue.id))
    .map(buildIssueRepairDirective));
}

function buildAuditRevisionNotes(validation, factContext = null) {
  const establishedAssertions = (factContext?.establishedFacts || []).map((fact) => fact.assertion);
  const canonFactIssues = collectCriticalCanonFactIssues(validation).length
    ? collectCanonFactContinuityIssues(validation, establishedAssertions)
    : [];
  const canonNotes = canonFactIssues.length
    ? buildCanonFactRevisionNotes(factContext, canonFactIssues)
    : [];

  return uniqueTextNotes([
    ...canonNotes,
    ...collectStructuredAuditRepairNotes(validation, {
      severities: ["critical", "warning"],
    }),
  ]);
}

function buildBlockingAuditReviewPayload(validation, factContext = null) {
  const establishedAssertions = (factContext?.establishedFacts || []).map((fact) => fact.assertion);
  const canonFactIssues = collectCriticalCanonFactIssues(validation).length
    ? collectCanonFactContinuityIssues(validation, establishedAssertions)
    : [];
  const blockingAuditIssues = uniqueTextNotes([
    ...collectBlockingAuditIssues(validation).flatMap((issue) => [issue.description, issue.suggestion]),
    ...canonFactIssues,
  ]);

  return {
    canonFactIssues,
    blockingAuditIssues,
  };
}

function manualReviewStrategyFromValidation(validation) {
  return collectCriticalCanonFactIssues(validation).length
    ? "canon_fact_manual_review"
    : "audit_manual_review";
}

function createFeedbackSupervisionResult(overrides = {}) {
  return {
    enabled: false,
    passed: true,
    summary: "",
    missingItems: [],
    revisionNotes: [],
    evidence: "",
    scopeBlocked: false,
    ...overrides,
  };
}

function normalizeFeedbackTextList(values = [], limit = 8) {
  return uniqueTextNotes(values).slice(0, limit);
}

function buildBlockingFeedbackIssues(feedbackResult = null) {
  if (!feedbackResult?.enabled || feedbackResult.passed) {
    return [];
  }

  return uniqueTextNotes([
    ...normalizeFeedbackTextList(feedbackResult.missingItems, 6),
    ...normalizeFeedbackTextList(feedbackResult.revisionNotes, 6),
    feedbackResult.scopeBlocked
      ? "当前选区无法在不改动选区外文本的前提下完整落实该反馈，需要人工扩大范围或改为整章重写。"
      : "",
  ]);
}

function feedbackIssueKeys(feedbackResult = null) {
  return uniqueTextNotes([
    ...(feedbackResult?.passed ? [] : feedbackResult?.missingItems || []),
    ...(feedbackResult?.passed ? [] : feedbackResult?.revisionNotes || []),
    feedbackResult?.scopeBlocked ? "scope_blocked" : "",
  ]).sort();
}

function manualReviewStrategyFromOutcomes(validation, feedbackResult = null) {
  if (feedbackResult?.enabled && !feedbackResult.passed) {
    return "feedback_manual_review";
  }
  return manualReviewStrategyFromValidation(validation);
}

function manualReviewAgentLabel(strategy = "") {
  if (strategy === "canon_fact_manual_review") {
    return "CanonFactGuardrail";
  }
  if (strategy === "feedback_manual_review") {
    return "FeedbackGuardrail";
  }
  return "AuditGuardrail";
}

function manualReviewSummary(strategy = "") {
  if (strategy === "canon_fact_manual_review") {
    return `章节级 canon facts 冲突在 ${MAX_AUDIT_AUTO_REPAIR_ATTEMPTS} 次自动修正后仍未解决，已转入人工审核。`;
  }
  if (strategy === "feedback_manual_review") {
    return `人类反馈在 ${MAX_AUDIT_AUTO_REPAIR_ATTEMPTS} 轮自动修订后仍未完整落实，已转入人工复审。`;
  }
  return `章节审计在 ${MAX_AUDIT_AUTO_REPAIR_ATTEMPTS} 次自动修正后仍未通过，已转入人工审核。`;
}

function buildFeedbackSupervisionHistoryEntry(result = null) {
  return {
    at: nowIso(),
    passed: Boolean(result?.passed),
    summary: String(result?.summary || "").trim(),
    missingItems: normalizeFeedbackTextList(result?.missingItems, 8),
    revisionNotes: normalizeFeedbackTextList(result?.revisionNotes, 8),
    evidence: String(result?.evidence || "").trim(),
    scopeBlocked: Boolean(result?.scopeBlocked),
  };
}

function feedbackSupervisorInput({
  project,
  chapterPlan,
  feedback = "",
  mode = "rewrite",
  chapterDraft = null,
  candidateText = "",
  selection = null,
  currentDraftMarkdown = "",
}) {
  const normalizedSelection = normalizeChapterSelection(selection);
  const shared = [
    `作品：${project.title}`,
    `章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
    `监督模式：${mode === "partial_rewrite" ? "局部修订" : "整章重写"}`,
    `作者反馈：${feedback || "无"}`,
  ];

  if (mode === "partial_rewrite") {
    return [
      ...shared,
      `原文全文：\n${currentDraftMarkdown}`,
      `原选中文本：\n${normalizedSelection.selectedText}`,
      `选区前文锚点：\n${normalizedSelection.prefixContext || "无"}`,
      `选区后文锚点：\n${normalizedSelection.suffixContext || "无"}`,
      `当前候选替换片段：\n${candidateText || "无"}`,
      "要求：只能基于当前候选替换片段判断它是否落实作者反馈；如果必须修改选区外内容才能完成反馈，请把 scopeBlocked 设为 true。",
      `请输出 JSON：
{
  "passed": true,
  "summary": "一句话结论",
  "missingItems": ["仍未落实的反馈点"],
  "revisionNotes": ["给 RevisionAgent 的直接修订指令"],
  "evidence": "引用候选片段中的短证据",
  "scopeBlocked": false
}`,
    ].join("\n\n");
  }

  return [
    ...shared,
    `当前整章正文：\n${chapterDraft?.markdown || candidateText || ""}`,
    "要求：只判断这版整章是否真正落实了作者反馈；如果没有，请指出未完成项并给出可以直接用于二次 revision 的修订指令。",
    `请输出 JSON：
{
  "passed": true,
  "summary": "一句话结论",
  "missingItems": ["仍未落实的反馈点"],
  "revisionNotes": ["给 WriterAgent 的直接修订指令"],
  "evidence": "引用正文中的短证据",
  "scopeBlocked": false
}`,
  ].join("\n\n");
}

async function runFeedbackSupervisorAgent({
  provider,
  project,
  chapterPlan,
  feedback = "",
  mode = "rewrite",
  chapterDraft = null,
  candidateText = "",
  selection = null,
  currentDraftMarkdown = "",
}) {
  const normalizedFeedback = String(feedback || "").trim();
  if (!normalizedFeedback) {
    return createFeedbackSupervisionResult();
  }

  const result = await provider.generateText({
    instructions:
      mode === "partial_rewrite"
        ? "你是 Novelex 的 FeedbackSupervisorAgent。你只负责检查当前候选替换片段是否落实了作者反馈。若仍未落实，要指出缺口，并给出新的 revision notes。若必须改动选区外文本才能落实，请明确把 scopeBlocked 设为 true。只输出 JSON。"
        : "你是 Novelex 的 FeedbackSupervisorAgent。你只负责检查当前整章重写是否落实了作者反馈。若仍未落实，要指出缺口，并给出新的 revision notes。整章模式下 scopeBlocked 必须为 false。只输出 JSON。",
    input: feedbackSupervisorInput({
      project,
      chapterPlan,
      feedback: normalizedFeedback,
      mode,
      chapterDraft,
      candidateText,
      selection,
      currentDraftMarkdown,
    }),
    useReviewModel: true,
    metadata: {
      feature: mode === "partial_rewrite" ? "chapter_partial_feedback_supervisor" : "chapter_feedback_supervisor",
      chapterId: chapterPlan.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`FeedbackSupervisorAgent 返回了无法解析的结果：${createExcerpt(result.text, 180)}`);
  }

  const missingItems = normalizeFeedbackTextList(parsed.missingItems, 6);
  const revisionNotes = normalizeFeedbackTextList(parsed.revisionNotes?.length ? parsed.revisionNotes : parsed.missingItems, 8);
  return createFeedbackSupervisionResult({
    enabled: true,
    passed: Boolean(parsed.passed),
    summary: String(parsed.summary || "").trim(),
    missingItems,
    revisionNotes,
    evidence: String(parsed.evidence || "").trim(),
    scopeBlocked: mode === "partial_rewrite" ? Boolean(parsed.scopeBlocked) : false,
  });
}

async function evaluateFeedbackSupervision(feedbackSupervisor = null, chapterDraft = null) {
  if (!feedbackSupervisor?.enabled) {
    return createFeedbackSupervisionResult();
  }

  return runFeedbackSupervisorAgent({
    ...feedbackSupervisor,
    chapterDraft,
  });
}

async function rerunChapterAuditWithContext(auditContext, chapterDraft) {
  return runChapterAudit({
    ...auditContext,
    chapterDraft,
  });
}

async function rewriteChapterDraftWithContext(rewriteContext, chapterDraft, revisionNotes, mode = "validation_repair") {
  return generateChapterDraftText({
    ...rewriteContext,
    revisionNotes,
    mode,
    currentDraft: chapterDraft,
  });
}

function issueRepairCounts(validation) {
  return {
    critical: Number(validation?.issueCounts?.critical || 0),
    warning: Number(validation?.issueCounts?.warning || 0),
    info: Number(validation?.issueCounts?.info || 0),
  };
}

function extractEvidenceCandidates(evidence = "") {
  const raw = String(evidence || "").trim();
  if (!raw) {
    return [];
  }

  const quoted = [...raw.matchAll(/[“"'‘’](.{8,220}?)[”"'‘’]/g)].map((match) => match[1]);
  const split = raw
    .split(/\s*\/\s*|\n+/)
    .map((item) => item.replace(/^[①②③④⑤⑥⑦⑧⑨⑩\d.\-、\s]+/u, "").trim())
    .filter(Boolean);

  return uniqueTextNotes([...quoted, ...split])
    .filter((item) => item.length >= 8)
    .sort((left, right) => right.length - left.length);
}

function buildSelectionFromEvidence(markdown = "", chapterTitle = "", issue = null) {
  const body = splitChapterMarkdown(markdown, chapterTitle).body;
  for (const candidate of extractEvidenceCandidates(issue?.evidence || "")) {
    const index = body.indexOf(candidate);
    if (index < 0) {
      continue;
    }
    return {
      selectedText: candidate,
      prefixContext: body.slice(Math.max(0, index - 80), index),
      suffixContext: body.slice(index + candidate.length, Math.min(body.length, index + candidate.length + 80)),
    };
  }
  return null;
}

function selectTargetedCriticalIssues(validation) {
  return collectBlockingAuditIssues(validation).filter((issue) =>
    PARTIAL_TARGET_REPAIR_IDS.has(issue.id) || CHAPTER_TARGET_REPAIR_IDS.has(issue.id),
  );
}

function selectWarningPolishIssues(validation) {
  return (validation?.issues || []).filter((issue) =>
    issue.severity === "warning" && HIGH_VALUE_WARNING_IDS.has(issue.id),
  );
}

async function applyTargetedPartialRepair({
  rewriteContext,
  chapterDraft,
  issue,
}) {
  const selection = buildSelectionFromEvidence(
    chapterDraft?.markdown || "",
    rewriteContext.chapterPlan?.title || "",
    issue,
  );
  if (!selection?.selectedText) {
    return {
      chapterDraft,
      changed: false,
      applied: false,
      note: "",
    };
  }

  const replacementFragment = await generateChapterPartialRevisionText({
    provider: rewriteContext.provider,
    project: rewriteContext.project,
    chapterPlan: rewriteContext.chapterPlan,
    historyPacket: rewriteContext.historyPacket,
    foreshadowingSummary: rewriteContext.foreshadowingSummary,
    characterStateSummary: rewriteContext.characterStateSummary,
    sceneBeatSummary: rewriteContext.sceneBeatSummary,
    researchPacket: rewriteContext.researchPacket,
    referencePacket: rewriteContext.referencePacket,
    openingReferencePacket: rewriteContext.openingReferencePacket,
    writerContextPacket: rewriteContext.writerContextPacket,
    governance: rewriteContext.governance,
    characterDossiers: rewriteContext.characterDossiers,
    styleGuideText: rewriteContext.styleGuideText,
    feedback: [
      buildIssueRepairDirective(issue),
      "只修这一段，优先把证据里暴露的问题改成符合信息边界/视角边界/正文质感的写法，不要扩写成整章重写。",
    ].join("\n"),
    selection,
    currentDraftMarkdown: chapterDraft.markdown,
    factContext: rewriteContext.factContext || null,
  });
  if (!replacementFragment || !fragmentChanged(selection.selectedText, replacementFragment)) {
    return {
      chapterDraft,
      changed: false,
      applied: true,
      note: buildIssueRepairDirective(issue),
    };
  }

  const replacedMarkdown = replaceSelectionInChapterMarkdown(
    chapterDraft.markdown,
    selection,
    replacementFragment,
    rewriteContext.chapterPlan.title,
  );
  const nextDraft = chapterDraftFromExactMarkdown(
    rewriteContext.chapterPlan,
    composeChapterMarkdown(replacedMarkdown.title, replacedMarkdown.body),
  );

  return {
    chapterDraft: nextDraft,
    changed: chapterBodyChanged(chapterDraft.markdown, nextDraft.markdown, rewriteContext.chapterPlan.title),
    applied: true,
    note: buildIssueRepairDirective(issue),
  };
}

async function applyFocusedChapterRepair({
  rewriteContext,
  chapterDraft,
  issues,
  extraNotes = [],
  mode = "targeted_repair",
}) {
  const revisionNotes = uniqueTextNotes([
    ...(issues || []).map(buildIssueRepairDirective),
    ...uniqueTextNotes(extraNotes || []),
  ]);
  if (!revisionNotes.length) {
    return {
      chapterDraft,
      changed: false,
      notes: [],
    };
  }

  const nextDraft = await rewriteChapterDraftWithContext(
    rewriteContext,
    chapterDraft,
    revisionNotes,
    mode,
  );

  return {
    chapterDraft: nextDraft,
    changed: chapterBodyChanged(chapterDraft.markdown, nextDraft.markdown, rewriteContext.chapterPlan.title),
    notes: revisionNotes,
  };
}

function buildRepairHistoryEntry({
  phase,
  strategy,
  notes,
  beforeValidation,
  afterValidation,
  beforeFeedback = null,
  afterFeedback = null,
  bodyChanged,
  stagnated = false,
}) {
  return {
    at: nowIso(),
    phase,
    strategy,
    notes: uniqueTextNotes(notes),
    before: {
      counts: issueRepairCounts(beforeValidation),
      unresolvedCriticals: unresolvedCriticalIssueSummaries(beforeValidation),
    },
    after: {
      counts: issueRepairCounts(afterValidation),
      unresolvedCriticals: unresolvedCriticalIssueSummaries(afterValidation),
    },
    feedbackBefore: beforeFeedback?.enabled
      ? {
        passed: Boolean(beforeFeedback?.passed),
        missingItems: normalizeFeedbackTextList(beforeFeedback?.missingItems, 6),
        revisionNotes: normalizeFeedbackTextList(beforeFeedback?.revisionNotes, 6),
        scopeBlocked: Boolean(beforeFeedback?.scopeBlocked),
      }
      : null,
    feedbackAfter: afterFeedback?.enabled
      ? {
        passed: Boolean(afterFeedback?.passed),
        missingItems: normalizeFeedbackTextList(afterFeedback?.missingItems, 6),
        revisionNotes: normalizeFeedbackTextList(afterFeedback?.revisionNotes, 6),
        scopeBlocked: Boolean(afterFeedback?.scopeBlocked),
      }
      : null,
    bodyChanged,
    stagnated,
  };
}

async function runValidationRepairs({
  chapterDraft,
  validation,
  auditContext,
  rewriteContext,
  stepPrefix = "writer_revision",
  feedbackSupervisor = null,
}) {
  let currentDraft = chapterDraft;
  let currentValidation = validation;
  let auditAutoRepairAttempts = 0;
  let canonFactAutoRepairAttempts = 0;
  let feedbackSupervisionAttempts = 0;
  const repairSteps = [];
  const repairHistory = [];
  const feedbackSupervisionHistory = [];
  let stagnated = false;
  let currentFeedback = await evaluateFeedbackSupervision(feedbackSupervisor, currentDraft);

  if (currentFeedback.enabled) {
    feedbackSupervisionAttempts += 1;
    feedbackSupervisionHistory.push(buildFeedbackSupervisionHistoryEntry(currentFeedback));
    repairSteps.push(
      step(
        `${stepPrefix}_feedback_${feedbackSupervisionAttempts}`,
        "FeedbackSupervisorAgent",
        "write",
        currentFeedback.passed
          ? "反馈监督通过：当前版本已落实作者反馈。"
          : currentFeedback.scopeBlocked
            ? "反馈监督认为当前反馈无法在既定修改范围内完成，已标记为人工复审候选。"
            : "反馈监督发现仍有作者反馈未落实，已生成下一轮 revision notes。",
        {
          preview: createExcerpt(
            currentFeedback.passed
              ? currentFeedback.summary || "作者反馈已落实。"
              : buildBlockingFeedbackIssues(currentFeedback).join("；") || currentFeedback.summary,
            180,
          ),
        },
      ),
    );
  }

  const phases = [];
  if (selectTargetedCriticalIssues(currentValidation).length) {
    phases.push({
      id: "targeted_critical_repair",
      label: "定向修补",
      strategy: "targeted_critical",
    });
  }
  phases.push({
    id: "validation_repair",
    label: "整章修复",
    strategy: "validation_repair",
  });
  phases.push({
    id: "focused_repair",
    label: "聚焦收尾修补",
    strategy: "focused_repair",
  });

  for (const phase of phases) {
    if (
      auditAutoRepairAttempts >= MAX_AUDIT_AUTO_REPAIR_ATTEMPTS ||
      stagnated ||
      currentFeedback.scopeBlocked ||
      (currentValidation?.overallPassed && currentFeedback.passed)
    ) {
      break;
    }

    const beforeValidation = currentValidation;
    const beforeCriticalKeys = unresolvedCriticalIssueKeys(beforeValidation);
    const beforeFeedback = currentFeedback;
    const beforeFeedbackKeys = feedbackIssueKeys(beforeFeedback);
    const draftBeforePhase = currentDraft;
    let notes = [];
    let changed = false;
    let agentLabel = "WriterAgent";
    let applied = false;

    if (phase.id === "targeted_critical_repair") {
      const targetedIssues = selectTargetedCriticalIssues(currentValidation);
      const partialIssues = targetedIssues.filter((issue) => PARTIAL_TARGET_REPAIR_IDS.has(issue.id));
      const chapterIssues = targetedIssues.filter((issue) => CHAPTER_TARGET_REPAIR_IDS.has(issue.id));
      agentLabel = chapterIssues.length ? "WriterAgent" : "RevisionAgent";

      for (const issue of partialIssues) {
        const partialResult = await applyTargetedPartialRepair({
          rewriteContext,
          chapterDraft: currentDraft,
          issue,
        });
        if (partialResult.applied) {
          applied = true;
          agentLabel = "RevisionAgent";
          notes.push(partialResult.note);
        }
        if (partialResult.changed) {
          currentDraft = partialResult.chapterDraft;
          changed = true;
        }
      }

      if (chapterIssues.length) {
        const focusedResult = await applyFocusedChapterRepair({
          rewriteContext,
          chapterDraft: currentDraft,
          issues: chapterIssues,
          mode: "targeted_repair",
        });
        if (focusedResult.notes.length) {
          applied = true;
          notes.push(...focusedResult.notes);
        }
        if (focusedResult.changed) {
          currentDraft = focusedResult.chapterDraft;
          changed = true;
        }
      }
    } else if (phase.id === "validation_repair") {
      notes = buildAuditRevisionNotes(currentValidation, rewriteContext.factContext || null);
      if (beforeFeedback.enabled && !beforeFeedback.passed) {
        notes = uniqueTextNotes([...notes, ...beforeFeedback.revisionNotes]);
      }
      if (notes.length) {
        applied = true;
        currentDraft = await rewriteChapterDraftWithContext(
          rewriteContext,
          currentDraft,
          notes,
          "validation_repair",
        );
        changed = chapterBodyChanged(
          draftBeforePhase.markdown,
          currentDraft.markdown,
          rewriteContext.chapterPlan.title,
        ) || changed;
      }
    } else {
      const remainingCriticalIssues = collectBlockingAuditIssues(currentValidation);
      const polishIssues = remainingCriticalIssues.length
        ? remainingCriticalIssues
        : selectWarningPolishIssues(currentValidation);
      const focusedResult = await applyFocusedChapterRepair({
        rewriteContext,
        chapterDraft: currentDraft,
        issues: polishIssues,
        extraNotes: beforeFeedback.enabled && !beforeFeedback.passed ? beforeFeedback.revisionNotes : [],
        mode: "targeted_repair",
      });
      notes = focusedResult.notes;
      applied = notes.length > 0;
      if (focusedResult.changed) {
        currentDraft = focusedResult.chapterDraft;
        changed = true;
      }
      agentLabel = "WriterAgent";
      if (!remainingCriticalIssues.length && !polishIssues.length) {
        continue;
      }
    }

    if (!applied) {
      continue;
    }

    auditAutoRepairAttempts += 1;
    if (collectCriticalCanonFactIssues(beforeValidation).length) {
      canonFactAutoRepairAttempts += 1;
    }

    const afterValidation = changed
      ? await rerunChapterAuditWithContext(auditContext, currentDraft)
      : beforeValidation;
    const afterCriticalKeys = unresolvedCriticalIssueKeys(afterValidation);
    const afterFeedback = changed
      ? await evaluateFeedbackSupervision(feedbackSupervisor, currentDraft)
      : beforeFeedback;
    const afterFeedbackKeys = feedbackIssueKeys(afterFeedback);
    if (feedbackSupervisor?.enabled && changed) {
      feedbackSupervisionAttempts += 1;
      feedbackSupervisionHistory.push(buildFeedbackSupervisionHistoryEntry(afterFeedback));
      repairSteps.push(
        step(
          `${stepPrefix}_feedback_${feedbackSupervisionAttempts}`,
          "FeedbackSupervisorAgent",
          "write",
          afterFeedback.passed
            ? "反馈监督通过：当前版本已落实作者反馈。"
            : afterFeedback.scopeBlocked
              ? "反馈监督判断当前反馈超出既定修改范围，已停止自动修订。"
              : "反馈监督发现仍有作者反馈未落实，已更新下一轮 revision notes。",
          {
            preview: createExcerpt(
              afterFeedback.passed
                ? afterFeedback.summary || "作者反馈已落实。"
                : buildBlockingFeedbackIssues(afterFeedback).join("；") || afterFeedback.summary,
              180,
            ),
          },
        ),
      );
    }
    stagnated =
      JSON.stringify(beforeCriticalKeys) === JSON.stringify(afterCriticalKeys) &&
      JSON.stringify(beforeFeedbackKeys) === JSON.stringify(afterFeedbackKeys) &&
      !changed;
    currentValidation = afterValidation;
    currentFeedback = afterFeedback;

    repairHistory.push(buildRepairHistoryEntry({
      phase: phase.label,
      strategy: phase.strategy,
      notes,
      beforeValidation,
      afterValidation,
      beforeFeedback,
      afterFeedback,
      bodyChanged: changed,
      stagnated,
    }));

    repairSteps.push(
      step(
        `${stepPrefix}_${auditAutoRepairAttempts}`,
        agentLabel,
        "write",
        `第 ${auditAutoRepairAttempts} 次自动修正：${phase.label}。`,
        {
          preview: createExcerpt(notes.join("；"), 180),
        },
      ),
    );
  }

  const feedbackSupervisionPassed = !currentFeedback.enabled || currentFeedback.passed;
  const manualReviewRequired = !currentValidation?.overallPassed || !feedbackSupervisionPassed;
  const reviewPayload = buildBlockingAuditReviewPayload(currentValidation, rewriteContext.factContext || null);
  const blockingFeedbackIssues = buildBlockingFeedbackIssues(currentFeedback);

  return {
    chapterDraft: currentDraft,
    validation: currentValidation,
    auditAutoRepairAttempts,
    canonFactAutoRepairAttempts,
    feedbackSupervisionPassed,
    feedbackSupervisionSummary: currentFeedback.summary || "",
    feedbackSupervisionAttempts,
    feedbackSupervisionHistory,
    manualReviewRequired,
    manualReviewStrategy: manualReviewRequired ? manualReviewStrategyFromOutcomes(currentValidation, currentFeedback) : "",
    canonFactIssues: reviewPayload.canonFactIssues,
    blockingAuditIssues: reviewPayload.blockingAuditIssues,
    blockingFeedbackIssues,
    repairHistory,
    lastUnresolvedCriticals: unresolvedCriticalIssueSummaries(currentValidation),
    stagnated,
    repairSteps,
    feedbackResult: currentFeedback,
  };
}

async function runChapterPostProcessing({
  chapterDraft,
  validation = null,
  auditContext,
  rewriteContext,
  stepPrefix = "writer_revision",
  styleRepairStepId = "writer_style_repair",
  feedbackSupervisor = null,
}) {
  let currentDraft = chapterDraft;
  let currentValidation = validation || await rerunChapterAuditWithContext(auditContext, currentDraft);
  const steps = [];

  if (needsAuditStyleRepair(currentValidation)) {
    currentDraft = await generateChapterDraftText({
      ...rewriteContext,
      revisionNotes: collectAuditRepairNotes(currentValidation, {
        dimensionIds: ["pov_consistency", "meta_leak"],
        severities: ["critical", "warning"],
      }),
      mode: "style_repair",
      currentDraft,
    });
    currentValidation = await rerunChapterAuditWithContext(auditContext, currentDraft);
    steps.push(
      step(
        styleRepairStepId,
        "WriterAgent",
        "write",
        "根据风格校验结果强制重写为第三人称有限视角，并清除元信息污染。",
        { preview: createExcerpt(currentDraft.markdown, 180) },
      ),
    );
  }

  const repairResult = await runValidationRepairs({
    chapterDraft: currentDraft,
    validation: currentValidation,
    auditContext,
    rewriteContext,
    stepPrefix,
    feedbackSupervisor,
  });

  return {
    chapterDraft: repairResult.chapterDraft,
    validation: repairResult.validation,
    steps: [...steps, ...(repairResult.repairSteps || [])],
    repairResult,
  };
}

function formatFactPromptList(facts = []) {
  return (Array.isArray(facts) ? facts : [])
    .map((fact) => `[${fact.factId}] ${fact.subject}｜${fact.assertion}`)
    .join("；");
}

function buildFactPromptSections(factContext = null) {
  return {
    establishedFactsLine: formatFactPromptList(factContext?.establishedFacts || []) || "无",
    openTensionsLine: formatFactPromptList(factContext?.openTensions || []) || "无",
    selectionRationale: String(factContext?.selectionRationale || "").trim() || "无",
  };
}

async function selectFactContextForChapter({
  store,
  provider,
  project,
  chapterPlan,
}) {
  try {
    const factLedger = await loadFactLedger(store);
    if (!factLedger.length) {
      return {
        factContext: null,
        warning: "",
      };
    }

    const selection = await runFactSelectorAgent({
      provider,
      project,
      chapterPlan,
      factLedger,
    });

    return {
      factContext: buildFactContextPacket({
        chapterPlan,
        establishedFacts: selection.establishedFacts,
        openTensions: selection.openTensions,
        selectionRationale: selection.selectionRationale,
        catalogStats: selection.catalogStats,
      }),
      warning: "",
    };
  } catch (error) {
    return {
      factContext: null,
      warning: `FactSelectorAgent 失败，已跳过章节级 canon facts：${error instanceof Error ? error.message : String(error || "")}`,
    };
  }
}

function buildDerivedChapterStateArtifacts({
  currentCharacterStates,
  chapterPlan,
  project,
  chapterDraft,
  worldStateBase,
  structureData,
  foreshadowingRegistryBase,
}) {
  const characterStates = updateCharacterStates(
    currentCharacterStates,
    chapterPlan,
    project,
  );
  const chapterMeta = buildChapterMeta(chapterPlan, chapterDraft, characterStates);
  const worldState = updateWorldState(worldStateBase, chapterPlan, structureData);
  const foreshadowingRegistry = updateForeshadowingRegistry(
    foreshadowingRegistryBase,
    chapterPlan,
    chapterDraft,
  );

  return {
    characterStates,
    chapterMeta,
    worldState,
    foreshadowingRegistry,
  };
}

function summarizeForeshadowingAdvice(foreshadowingAdvice = [], chapterPlan = null) {
  if (foreshadowingAdvice.length) {
    return foreshadowingAdvice
      .map((item) => `${item.action || item.status || "track"}:${item.id}`)
      .join("，");
  }
  if (chapterPlan?.foreshadowingActions?.length) {
    return chapterPlan.foreshadowingActions.map((item) => `${item.action}:${item.id}`).join("，");
  }
  return "本章无硬性伏笔任务";
}

function summarizeCharacterStates(characterStates = []) {
  return characterStates
    .map(
      (state) =>
        `- ${state.name}：目标=${state.psychological.current_goal}；情绪=${state.psychological.emotional_state}；位置=${state.physical.location}`,
    )
    .join("\n");
}

function summarizeSceneBeats(chapterPlan) {
  return chapterPlan.scenes
    .map((scene, index) => `${index + 1}. ${scene.label}｜线程:${scene.threadId || "main"}｜任务:${scene.focus}｜作用:${scene.scenePurpose || scene.focus}｜承接:${scene.inheritsFromPrevious || "无"}｜结果:${scene.outcome || "无"}｜交棒:${scene.handoffToNext || "无"}｜张力:${scene.tension}`)
    .join("\n");
}

function normalizeChapterReviewAction(reviewAction, approved) {
  const action = String(reviewAction || "").trim();
  if (approved || action === "approve") {
    return "approve";
  }
  if (!action || action === "rewrite" || action === "local_rewrite" || action === "structural_rewrite") {
    return "rewrite";
  }
  return action;
}

function resolveRewriteStrategy(reviewAction, sceneIds = [], sceneOrder = []) {
  const action = String(reviewAction || "").trim();
  if (action === "local_rewrite" && sceneIds.length) {
    return "scene_patch";
  }
  if (action === "structural_rewrite" || sceneOrder.length) {
    return "chapter_rebuild";
  }
  if (sceneIds.length) {
    return "scene_patch";
  }
  return "chapter_rebuild";
}

function buildFallbackStyleGuide(project, chapterPlan) {
  return [
    "# 预设风格指南",
    `- 叙事视角：${project.styleNotes || "第三人称有限视角"}`,
    `- 题材类型：${project.genre}`,
    `- 世界背景：${project.setting}`,
    `- 本章 POV：${chapterPlan.povCharacter}`,
    "- 直接写网络小说正文，不要解释提纲，不要总结主题，不要写元话语式备注。",
    "- 优先用动作、对白、即时反应推进场景，再补必要环境描写。",
    "- 少用抽象判断句和空泛感慨，章末钩子要落在具体处境或下一步动作上。",
    "- 人物说话要有区分度，语气和选择要符合各自欲望、伤口和关系位置。",
    "- 全文默认使用第三人称有限视角，叙述时不要使用“我”“我们”作为旁白人称。",
  ].join("\n");
}

async function resolveStyleBaseline(store, project, chapterPlan) {
  const selectedStyleId = String(project?.styleFingerprintId || "").trim();
  if (selectedStyleId) {
    const styleFingerprint = await store.loadStyleFingerprint(selectedStyleId);
    const promptMarkdown = String(styleFingerprint?.promptMarkdown || "").trim();
    if (promptMarkdown) {
      return {
        styleGuideText: promptMarkdown,
        styleGuideSourcePath: path.join("runtime", "style_fingerprints", selectedStyleId, "prompt.md"),
      };
    }
  }

  const styleGuide = await store.readText(path.join(store.paths.novelStateDir, "style_guide.md"), "");
  if (styleGuide.trim()) {
    return {
      styleGuideText: styleGuide.trim(),
      styleGuideSourcePath: path.join("novel_state", "style_guide.md"),
    };
  }

  return {
    styleGuideText: buildFallbackStyleGuide(project, chapterPlan),
    styleGuideSourcePath: "generated/style_guide_fallback.md",
  };
}

function buildCharacterDossiers(bundle, chapterPlan, characterStates) {
  const stateByName = new Map(characterStates.map((state) => [state.name, state]));

  return (bundle.characters || [])
    .filter((character) => chapterPlan.charactersPresent.includes(character.name))
    .map((character) => {
      const state = stateByName.get(character.name) || character.state || {};
      const beliefs = Array.isArray(state?.psychological?.key_beliefs)
        ? state.psychological.key_beliefs.join("；")
        : "暂无";

      return {
        name: character.name,
        markdown: [
          `### ${character.name}`,
          `- 角色定位：${character.role}`,
          `- 性格标签：${(character.tags || []).join(" / ") || "暂无"}`,
          `- 说话方式：${character.voice || "暂无"}`,
          `- 核心欲望：${character.desire || "暂无"}`,
          `- 核心伤口：${character.wound || "暂无"}`,
          `- 当前目标：${state?.psychological?.current_goal || "暂无"}`,
          `- 当前情绪：${state?.psychological?.emotional_state || "暂无"}`,
          `- 当前所处位置：${state?.physical?.location || "暂无"}`,
          `- 关键执念：${beliefs}`,
          `- 小传摘要：${createExcerpt(character.biographyMarkdown || "", 140) || "暂无"}`,
          `- 人物线摘要：${createExcerpt(character.storylineMarkdown || "", 140) || "暂无"}`,
        ].join("\n"),
      };
    });
}

function sanitizeChapterMarkdown(title, markdown = "") {
  const body = sanitizeDraftText(markdown)
    .replace(/^#\s+.+\n+/u, "")
    .trim();

  return body ? `# ${title}\n\n${body}` : `# ${title}`;
}

function chapterPromptInput({
  project,
  chapterPlan,
  historyPacket,
  foreshadowingSummary = "",
  characterStateSummary = "",
  sceneBeatSummary = "",
  researchPacket = null,
  referencePacket = null,
  openingReferencePacket = null,
  writerContextPacket = null,
  governance = null,
  characterDossiers = [],
  styleGuideText = "",
  revisionNotes = [],
  mode = "draft",
  factContext = null,
}) {
  const povCharacter = chapterPlan.povCharacter || project.protagonistName || "主角";
  const governanceContract = buildGovernedInputContract({
    chapterIntent: governance?.chapterIntent,
    contextPackage: governance?.contextPackage,
    ruleStack: governance?.ruleStack,
  });
  const sceneBlueprint = (chapterPlan.scenes || [])
    .map((scene, index) => [
      `${index + 1}. ${scene.label}`,
      `地点=${scene.location}`,
      `焦点=${scene.focus}`,
      `张力=${scene.tension}`,
      `作用=${scene.scenePurpose || scene.focus}`,
      `承接=${scene.inheritsFromPrevious || "无"}`,
      `结果=${scene.outcome || "无"}`,
      `交棒=${scene.handoffToNext || "无"}`,
      `人物=${(scene.characters || []).join("、") || "无"}`,
    ].join("｜"))
    .join("\n");

  const establishedFactsLines = (factContext?.establishedFacts || []).length
    ? [
        "既定事实（Canon Facts）——这些是从已批准章节中提取的事实，你必须遵守，不能否认、重置或改写：",
        ...(factContext.establishedFacts || []).map(
          (f) => `- [${f.factId}] ${f.subject}｜${f.assertion}`,
        ),
      ].join("\n")
    : "";
  const openTensionsLines = (factContext?.openTensions || []).length
    ? [
        "开放张力（Open Tensions）——这些是有待继续发酵的悬念，你可以推进但不可改写底层结论：",
        ...(factContext.openTensions || []).map(
          (f) => `- [${f.factId}] ${f.subject}｜${f.assertion}`,
        ),
      ].join("\n")
    : "";

  return [
    `作品：${project.title}`,
    `章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
    `模式：${mode}`,
    `POV：${povCharacter}`,
    `硬性视角规则：全文必须使用第三人称有限视角，叙述中只能写“${povCharacter}看见/听见/想到”，禁止使用“我/我们”作为旁白人称；对白里的第一人称不受此限制。`,
    "写法要求：直接输出可发布的网络小说正文，不要解释提纲，不要总结主题，不要写“本章将要”“这一章里”这类元话语。",
    "语言要求：优先用动作、对白、现场反应推进；少写抽象判断、空泛感慨和整段概括性总结。",
    "结构要求：必须严格按 scene 顺序推进，覆盖每场的职责、结果与交棒，不得重复开场、重置时间线，不能把同一场危机重新从头演一遍。",
    governanceContract ? `治理输入合同：\n${governanceContract}` : "",
    establishedFactsLines || openTensionsLines ? `事实上下文：\n${[establishedFactsLines, openTensionsLines].filter(Boolean).join("\n\n")}` : "",
    `本章主线：${chapterPlan.dominantThread || "无"}`,
    `本章线索结构：${chapterPlan.threadMode || "single_spine"}`,
    `章节入口承接：${chapterPlan.entryLink || historyPacket.lastEnding}`,
    `章节出口压力：${chapterPlan.exitPressure || chapterPlan.nextHook}`,
    `本章必须落地的事件：${chapterPlan.keyEvents.join("；")}`,
    `本章场景蓝图：\n${sceneBlueprint || "无 scene 蓝图"}`,
    `上文衔接：${historyPacket.lastEnding}`,
    `连续性锚点：${(historyPacket.continuityAnchors || chapterPlan.continuityAnchors || []).join("；") || "保持与上文自然衔接"}`,
    `章末牵引：${chapterPlan.nextHook}`,
    `本章伏笔任务：${foreshadowingSummary || "无"}`,
    `本章角色动态：\n${characterStateSummary || "无"}`,
    `本章场景推进：\n${sceneBeatSummary || "无"}`,
    `研究资料包：\n${researchPacket?.briefingMarkdown || "当前章节无需额外考据。"}`,
    `范文参考包：\n${referencePacket?.briefingMarkdown || "当前没有额外范文参考。"}`,
    `黄金三章参考包：\n${openingReferencePacket?.briefingMarkdown || "当前没有额外黄金三章参考。"}`,
    `整理后的写前上下文：\n${writerContextPacket?.briefingMarkdown || "当前没有额外 Writer 上下文包。"}`,
    `登场角色：${chapterPlan.charactersPresent.join("、")}`,
    `人物一致性档案：\n${characterDossiers.length ? characterDossiers.map((item) => item.markdown).join("\n\n") : "本场暂无可用主角色 dossier。"}`,
    `风格指南：\n${styleGuideText}`,
    `历史衔接摘要：\n${historyPacket.briefingMarkdown || historyPacket.contextSummary || "无额外上下文"}`,
    revisionNotes.length ? `人类反馈：${revisionNotes.join("；")}` : "",
    "只输出完整章节正文，不要额外解释；若未输出章节标题，系统会自动补齐。",
  ]
    .filter(Boolean)
    .join("\n");
}

function chapterDraftFromMarkdown(chapterPlan, markdown = "") {
  const normalizedMarkdown = sanitizeChapterMarkdown(chapterPlan.title, markdown);
  return {
    markdown: normalizedMarkdown,
    sceneDrafts: [],
    usedForeshadowings: chapterPlan.foreshadowingActions.map((item) => item.id),
    dialogueCount: (normalizedMarkdown.match(/“/g) || []).length,
  };
}

function chapterDraftFromExactMarkdown(chapterPlan, markdown = "") {
  const normalizedMarkdown = String(markdown || "").replace(/\r\n?/g, "\n");
  return {
    markdown: normalizedMarkdown,
    sceneDrafts: [],
    usedForeshadowings: chapterPlan.foreshadowingActions.map((item) => item.id),
    dialogueCount: (normalizedMarkdown.match(/“/g) || []).length,
  };
}

function normalizeRewriteComparableText(text = "") {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fragmentChanged(originalText = "", nextText = "") {
  return normalizeRewriteComparableText(originalText) !== normalizeRewriteComparableText(nextText);
}

function chapterBodyChanged(originalMarkdown = "", nextMarkdown = "", fallbackTitle = "") {
  const originalBody = splitChapterMarkdown(originalMarkdown, fallbackTitle).body;
  const nextBody = splitChapterMarkdown(nextMarkdown, fallbackTitle).body;
  return fragmentChanged(originalBody, nextBody);
}

function partialRevisionPromptInput({
  project,
  chapterPlan,
  historyPacket,
  foreshadowingSummary = "",
  characterStateSummary = "",
  sceneBeatSummary = "",
  researchPacket = null,
  referencePacket = null,
  openingReferencePacket = null,
  writerContextPacket = null,
  governance = null,
  characterDossiers = [],
  styleGuideText = "",
  feedback = "",
  selection = null,
  currentDraftMarkdown = "",
  factContext = null,
}) {
  const normalizedSelection = normalizeChapterSelection(selection);
  return [
    chapterPromptInput({
      project,
      chapterPlan,
      historyPacket,
      foreshadowingSummary,
      characterStateSummary,
      sceneBeatSummary,
      researchPacket,
      referencePacket,
      openingReferencePacket,
      writerContextPacket,
      governance,
      characterDossiers,
      styleGuideText,
      revisionNotes: [feedback].filter(Boolean),
      mode: "partial_rewrite",
      factContext,
    }),
    `原文全文：\n${currentDraftMarkdown}`,
    `只允许改写的原文片段：\n${normalizedSelection.selectedText}`,
    `选区前文锚点：\n${normalizedSelection.prefixContext || "无"}`,
    `选区后文锚点：\n${normalizedSelection.suffixContext || "无"}`,
    `作者修改要求：${feedback || "按用户选区做精修。"}`,
    "输出要求：只输出替换片段本身，不要输出标题，不要重复未选中的正文，不要解释，不要写代码块围栏。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function generateChapterPartialRevisionText({
  provider,
  project,
  chapterPlan,
  historyPacket,
  foreshadowingSummary = "",
  characterStateSummary = "",
  sceneBeatSummary = "",
  researchPacket = null,
  referencePacket = null,
  openingReferencePacket = null,
  writerContextPacket = null,
  governance = null,
  characterDossiers = [],
  styleGuideText = "",
  feedback = "",
  selection = null,
  currentDraftMarkdown = "",
  factContext = null,
}) {
  const result = await provider.generateText({
    instructions: "你是 Novelex 的 RevisionAgent。你会看到整章写作上下文、原文全文、用户选中的原文片段和修改要求。你只能改写选中的片段，不能修改任何未选中部分。只输出最终替换片段，不要解释。",
    input: partialRevisionPromptInput({
      project,
      chapterPlan,
      historyPacket,
      foreshadowingSummary,
      characterStateSummary,
      sceneBeatSummary,
      researchPacket,
      referencePacket,
      openingReferencePacket,
      writerContextPacket,
      governance,
      characterDossiers,
      styleGuideText,
      feedback,
      selection,
      currentDraftMarkdown,
      factContext,
    }),
    metadata: {
      feature: "chapter_partial_rewrite",
      chapterId: chapterPlan.chapterId,
    },
  });

  return sanitizeRevisionFragment(result.text);
}

async function generateChapterDraftText({
  provider,
  project,
  chapterPlan,
  historyPacket,
  foreshadowingSummary = "",
  characterStateSummary = "",
  sceneBeatSummary = "",
  researchPacket = null,
  referencePacket = null,
  openingReferencePacket = null,
  writerContextPacket = null,
  governance = null,
  characterDossiers = [],
  styleGuideText = "",
  revisionNotes = [],
  mode = "draft",
  currentDraft = null,
  factContext = null,
}) {
  const targetedRepairMode = mode === "targeted_repair";
  const instructions = mode === "style_repair"
    ? "你是 Novelex 的 WriterAgent。下面会给你一整章已有草稿。请在不改变既定事件链、scene 顺序、角色关系和冲突走向的前提下，把它改写成真正可发布的网络小说正文。必须严格使用第三人称有限视角，禁止出现旁白第一人称；不要复述提纲，不要写说明文，不要加入场景标题、系统备注或总结性尾巴。"
    : mode === "validation_repair"
      ? "你是 Novelex 的 WriterAgent。下面会给你一整章已有草稿和验证反馈。请在保留既定剧情事实、scene 顺序、人物关系和冲突方向的前提下，重写整章，使缺失事件真正落地、人物反应更可信、伏笔更自然、文风更像可发布的网络小说正文。不要输出解释。"
      : targetedRepairMode
        ? "你是 Novelex 的 WriterAgent。下面会给你一整章已有草稿和少量聚焦修补目标。请只修这些目标，优先做最小必要改动；如果问题是重复开场、章节过长或节奏拖沓，就压缩重复链路，只保留一条完整事件线。不要输出解释。"
      : mode === "rewrite"
        ? "你是 Novelex 的 WriterAgent。请根据作者反馈重写整章。保持既定 chapter plan、scene 顺序、人物知识边界和章末牵引，同时把语言改得更像可发布的网络小说正文。不要输出解释。"
        : "你是 Novelex 的 WriterAgent。请把输入信息转成完整可发布的网络小说章节正文。保持 POV 稳定、人物声音清晰、段落节奏自然；不要复述提纲，不要写说明文，不要用总结句替代剧情推进。";

  const input = currentDraft?.markdown
    ? [
        `待修正文：\n${currentDraft.markdown}`,
        chapterPromptInput({
          project,
          chapterPlan,
          historyPacket,
          foreshadowingSummary,
          characterStateSummary,
          sceneBeatSummary,
          researchPacket,
          referencePacket,
          openingReferencePacket,
          writerContextPacket,
          governance,
          characterDossiers,
          styleGuideText,
          revisionNotes,
          mode,
          factContext,
        }),
        mode === "style_repair"
          ? "改写要求：保留章节事实、scene 顺序和场面关系，只修正叙述视角、语言质感与元信息污染。"
          : mode === "validation_repair"
            ? "改写要求：严格依据验证反馈补足真正缺失的事件或因果，让整章更像正文，而不是提纲说明。"
            : targetedRepairMode
              ? "改写要求：只处理当前点名的问题；优先定点修补。若命中重复开场、重复推进或单章节奏拖沓，主动压缩重复段落，收紧到本章必须完成的事件链。"
            : "改写要求：在不偏离既定章节结构的前提下，响应作者反馈，整章重写。",
      ].join("\n\n")
    : chapterPromptInput({
        project,
        chapterPlan,
        historyPacket,
        foreshadowingSummary,
        characterStateSummary,
        sceneBeatSummary,
        researchPacket,
        referencePacket,
        openingReferencePacket,
        writerContextPacket,
        governance,
        characterDossiers,
        styleGuideText,
        revisionNotes,
        mode,
        factContext,
      });

  const result = await provider.generateText({
    instructions,
    input,
    metadata: {
      feature: mode === "draft" ? "chapter_draft" : "chapter_rewrite",
      chapterId: chapterPlan.chapterId,
    },
  });

  return chapterDraftFromMarkdown(chapterPlan, result.text);
}

function sanitizeDraftText(markdown = "") {
  return String(markdown || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) =>
      !/^\s*(##+\s*场景|场景\d+[：:]|写作备注：|人工修订重点：|修订补笔：|本章的节奏基调保持在)/.test(line.trim()),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseSceneIdList(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChapterSelection(selection = null) {
  return {
    selectedText: String(selection?.selectedText || "").replace(/\r\n?/g, "\n"),
    prefixContext: String(selection?.prefixContext || "").replace(/\r\n?/g, "\n"),
    suffixContext: String(selection?.suffixContext || "").replace(/\r\n?/g, "\n"),
  };
}

function emptyOutlinePlanningContext() {
  return {
    stagePlanning: {
      source: "empty",
      chapterMission: "",
      requiredBeats: [],
      mustPreserve: [],
      deferRules: [],
      suggestedConflictAxis: [],
      titleSignals: [],
      nextPressure: "",
    },
    characterPlanning: {
      source: "empty",
      recommendedPov: "",
      mustAppear: [],
      optionalCharacters: [],
      relationshipPressures: [],
      forbiddenLeaks: [],
      voiceNotes: [],
    },
    historyPlanning: {
      source: "empty",
      carryOverFacts: [],
      emotionalCarryover: [],
      openThreads: [],
      mustNotContradict: [],
      priorityThreads: [],
      backgroundThreads: [],
      suppressedThreads: [],
      globalTrajectory: "",
      lastEnding: "上一章节的余波还在。",
    },
    continuityPlanning: {
      source: "empty",
      entryLink: "",
      dominantCarryoverThread: "",
      subordinateThreads: [],
      mustAdvanceThisChapter: "",
      canPauseThisChapter: [],
      exitPressureToNextChapter: "",
      continuityRisks: [],
    },
    warnings: [],
    selectedSources: [],
    briefingMarkdown: "",
    summaryText: "",
  };
}

function buildOutlineContextMarkdown({
  chapterBase,
  stagePlanning,
  characterPlanning,
  historyPlanning,
  continuityPlanning,
  factContext,
  outlineOptions,
  foreshadowingActions,
  legacyPlan,
}) {
  const selectedCharacters = normalizeStringList([
    ...characterPlanning.mustAppear,
    ...characterPlanning.optionalCharacters,
  ], 8);
  const factSections = buildFactPromptSections(factContext);

  return [
    `# ${chapterBase.chapterId} 细纲上下文包`,
    "",
    "## 生成参数",
    `- 方案数：${outlineOptions.variantCount}`,
    `- 发散度：${outlineOptions.diversityPreset}`,
    `- 当前阶段：${chapterBase.stage}`,
    "",
    "## 阶段任务",
    `- 本章使命：${stagePlanning.chapterMission || "无"}`,
    `- 必须落地：${(stagePlanning.requiredBeats || []).join("；") || "无"}`,
    `- 必须保留：${(stagePlanning.mustPreserve || []).join("；") || "无"}`,
    `- 延后兑现：${(stagePlanning.deferRules || []).join("；") || "无"}`,
    `- 冲突轴：${(stagePlanning.suggestedConflictAxis || []).join("；") || "无"}`,
    `- 标题信号：${(stagePlanning.titleSignals || []).join("；") || "无"}`,
    `- 下一压力：${stagePlanning.nextPressure || "无"}`,
    "",
    "## 角色与关系",
    `- 推荐 POV：${characterPlanning.recommendedPov || chapterBase.povCharacter}`,
    `- 必须登场：${(characterPlanning.mustAppear || []).join("；") || "无"}`,
    `- 可选登场：${(characterPlanning.optionalCharacters || []).join("；") || "无"}`,
    `- 关系压力：${(characterPlanning.relationshipPressures || []).join("；") || "无"}`,
    `- 声音提醒：${(characterPlanning.voiceNotes || []).join("；") || "无"}`,
    `- 禁止泄漏：${(characterPlanning.forbiddenLeaks || []).join("；") || "无"}`,
    "",
    "## 历史承接",
    `- 上章余波：${historyPlanning.lastEnding || "无"}`,
    `- 必承事实：${(historyPlanning.carryOverFacts || []).join("；") || "无"}`,
    `- 情绪余波：${(historyPlanning.emotionalCarryover || []).join("；") || "无"}`,
    `- 未完线程：${(historyPlanning.openThreads || []).join("；") || "无"}`,
    `- 优先延续线程：${(historyPlanning.priorityThreads || []).join("；") || "无"}`,
    `- 背景线程：${(historyPlanning.backgroundThreads || []).join("；") || "无"}`,
    `- 应压低线程：${(historyPlanning.suppressedThreads || []).join("；") || "无"}`,
    `- 全书推进定位：${historyPlanning.globalTrajectory || "无"}`,
    `- 不可冲突点：${(historyPlanning.mustNotContradict || []).join("；") || "无"}`,
    "",
    "## 章节级 Canon Facts",
    `- 必须继承的已定事实：${factSections.establishedFactsLine}`,
    `- 可以继续发酵但不能改写底层结论的开放张力：${factSections.openTensionsLine}`,
    `- 筛选理由：${factSections.selectionRationale}`,
    "",
    "## 章节衔接",
    `- 开场承接：${continuityPlanning.entryLink || "无"}`,
    `- 主承接线程：${continuityPlanning.dominantCarryoverThread || "无"}`,
    `- 可穿插副线程：${(continuityPlanning.subordinateThreads || []).join("；") || "无"}`,
    `- 本章必须推进到：${continuityPlanning.mustAdvanceThisChapter || "无"}`,
    `- 可暂缓：${(continuityPlanning.canPauseThisChapter || []).join("；") || "无"}`,
    `- 章末递交压力：${continuityPlanning.exitPressureToNextChapter || "无"}`,
    `- 连贯性风险：${(continuityPlanning.continuityRisks || []).join("；") || "无"}`,
    "",
    "## 伏笔与旧章参考",
    `- 本章伏笔任务：${(foreshadowingActions || []).map((item) => `${item.action}:${item.id}`).join("；") || "无"}`,
    `- 旧章参考：${legacyPlan ? `${legacyPlan.chapterId} ${legacyPlan.title}` : "无"}`,
    `- 建议角色池：${selectedCharacters.join("；") || "无"}`,
  ].join("\n");
}

function normalizeSceneList(rawScenes, chapterBase, fallbackCharacters = []) {
  const source = Array.isArray(rawScenes) ? rawScenes : [];
  return source
    .map((scene, index) => {
      if (!scene || typeof scene !== "object") {
        return null;
      }
      const label = String(scene.label || `场景${index + 1}`).trim();
      const location = String(scene.location || chapterBase.location).trim() || chapterBase.location;
      const focus = String(scene.focus || "").trim();
      const tension = String(scene.tension || "").trim();
      const characters = normalizeStringList(
        Array.isArray(scene.characters) ? scene.characters : fallbackCharacters,
        6,
      );
      if (!label || !location || !focus || !tension) {
        return null;
      }
      return {
        label,
        location,
        focus,
        tension,
        characters: characters.length ? characters : normalizeStringList(fallbackCharacters, 6),
        threadId: String(scene.threadId || "main").trim() || "main",
        scenePurpose: String(scene.scenePurpose || focus).trim() || focus,
        inheritsFromPrevious: String(scene.inheritsFromPrevious || "").trim(),
        outcome: String(scene.outcome || "").trim(),
        handoffToNext: String(scene.handoffToNext || "").trim(),
      };
    })
    .filter(Boolean);
}

function buildFallbackOutlineScenes(chapterBase, stagePlanning, characterPlanning, historyPlanning, continuityPlanning) {
  const focusCharacters = normalizeStringList([
    ...characterPlanning.mustAppear,
    ...chapterBase.charactersPresent,
  ], 4);
  const requiredBeats = normalizeStringList([
    ...stagePlanning.requiredBeats,
    ...chapterBase.keyEvents,
  ], 3);
  const fallbackLocations = [
    chapterBase.location,
    chapterBase.location,
    chapterBase.location,
  ];

  return [
    {
      label: "起势场",
      location: fallbackLocations[0],
      focus: requiredBeats[0] || stagePlanning.chapterMission || "建立本章任务与压力来源。",
      tension: historyPlanning.lastEnding || "让本章一开始就带着上章余波。",
      characters: focusCharacters,
      threadId: "main",
      scenePurpose: continuityPlanning.entryLink || "把章节主线接到读者眼前。",
      inheritsFromPrevious: continuityPlanning.entryLink || historyPlanning.lastEnding || "承接上文压力。",
      outcome: requiredBeats[1] || stagePlanning.chapterMission || "主线任务被明确。",
      handoffToNext: requiredBeats[1] || "把矛盾推进到正面碰撞。",
    },
    {
      label: "碰撞场",
      location: fallbackLocations[1],
      focus: requiredBeats[1] || (stagePlanning.suggestedConflictAxis || [])[0] || "让角色围绕核心分歧发生正面碰撞。",
      tension: (characterPlanning.relationshipPressures || [])[0] || "把人物关系和主线压力正面撞上。",
      characters: focusCharacters,
      threadId: "main",
      scenePurpose: continuityPlanning.mustAdvanceThisChapter || "把本章主线往前推一大步。",
      inheritsFromPrevious: requiredBeats[0] || continuityPlanning.entryLink || "承接开场确认的问题。",
      outcome: requiredBeats[2] || stagePlanning.nextPressure || "主线代价与下一步压力成形。",
      handoffToNext: requiredBeats[2] || stagePlanning.nextPressure || "把本章结果转成章末压力。",
    },
    {
      label: "回响场",
      location: fallbackLocations[2],
      focus: requiredBeats[2] || stagePlanning.nextPressure || "把本章结果转成下一步动作压力。",
      tension: chapterBase.nextHook || stagePlanning.nextPressure || "留下明确未完动作与下一章牵引。",
      characters: focusCharacters,
      threadId: "main",
      scenePurpose: continuityPlanning.exitPressureToNextChapter || "把本章结果递交给下一章。",
      inheritsFromPrevious: requiredBeats[1] || "承接上一场的正面碰撞结果。",
      outcome: continuityPlanning.exitPressureToNextChapter || chapterBase.nextHook || stagePlanning.nextPressure || "新的压力已成形。",
      handoffToNext: continuityPlanning.exitPressureToNextChapter || chapterBase.nextHook || stagePlanning.nextPressure || "把问题交给下一章。",
    },
  ];
}

function normalizeOutlineProposal(rawProposal, index, {
  chapterBase,
  bundle,
  stagePlanning,
  characterPlanning,
  historyPlanning,
  continuityPlanning,
  foreshadowingActions,
}) {
  const proposalId = String(rawProposal?.proposalId || rawProposal?.id || `proposal_${index + 1}`).trim() || `proposal_${index + 1}`;
  const castNames = normalizeStringList((bundle?.characters || []).map((character) => character.name), 24);
  const fallbackCharacters = normalizeStringList([
    ...characterPlanning.mustAppear,
    ...chapterBase.charactersPresent,
    characterPlanning.recommendedPov || chapterBase.povCharacter,
  ], 8);
  const scenes = normalizeSceneList(rawProposal?.scenes, chapterBase, fallbackCharacters);
  const baseScenes = scenes.length ? scenes : buildFallbackOutlineScenes(
    chapterBase,
    stagePlanning,
    characterPlanning,
    historyPlanning,
    continuityPlanning,
  );
  const normalizedScenes = baseScenes.map((scene, sceneIndex) => {
    const nextScene = baseScenes[sceneIndex + 1] || null;
    return {
      id: `${chapterBase.chapterId}_scene_${sceneIndex + 1}`,
      proposalId,
      sceneRef: `${proposalId}:scene_${sceneIndex + 1}`,
      label: scene.label,
      location: scene.location,
      focus: scene.focus,
      tension: scene.tension,
      characters: normalizeStringList(scene.characters.length ? scene.characters : fallbackCharacters, 6),
      threadId: String(scene.threadId || "main").trim() || "main",
      scenePurpose: String(scene.scenePurpose || scene.focus).trim() || scene.focus,
      inheritsFromPrevious: String(
        scene.inheritsFromPrevious ||
        (sceneIndex === 0
          ? continuityPlanning.entryLink || historyPlanning.lastEnding || "承接上一章压力。"
          : baseScenes[sceneIndex - 1]?.outcome || baseScenes[sceneIndex - 1]?.handoffToNext || "承接上一场结果。"),
      ).trim(),
      outcome: String(
        scene.outcome ||
        (nextScene
          ? nextScene.focus || nextScene.scenePurpose || "把局势推向下一场。"
          : continuityPlanning.exitPressureToNextChapter || chapterBase.nextHook || stagePlanning.nextPressure || "把压力递给下一章。"),
      ).trim(),
      handoffToNext: String(
        scene.handoffToNext ||
        (nextScene
          ? nextScene.focus || nextScene.scenePurpose || "把问题交给下一场。"
          : continuityPlanning.exitPressureToNextChapter || chapterBase.nextHook || stagePlanning.nextPressure || "把问题交给下一章。"),
      ).trim(),
    };
  });

  const charactersPresent = normalizeStringList([
    ...normalizeStringList(rawProposal?.charactersPresent, 8),
    ...fallbackCharacters,
    ...normalizedScenes.flatMap((scene) => scene.characters),
  ], 8);
  const recommendedPov = String(rawProposal?.povCharacter || characterPlanning.recommendedPov || chapterBase.povCharacter).trim();
  const povCharacter = castNames.includes(recommendedPov) ? recommendedPov : (castNames.includes(chapterBase.povCharacter) ? chapterBase.povCharacter : castNames[0]);
  const keyEvents = normalizeStringList([
    ...normalizeStringList(rawProposal?.keyEvents, 4),
    ...normalizedScenes.map((scene) => scene.focus),
    ...stagePlanning.requiredBeats,
  ], 4);
  const arcContribution = normalizeStringList([
    ...normalizeStringList(rawProposal?.arcContribution, 3),
    ...stagePlanning.suggestedConflictAxis,
    ...characterPlanning.relationshipPressures,
  ], 3);
  const threadMode = normalizeThreadMode(rawProposal?.threadMode, "single_spine");
  const dominantThread = String(
    rawProposal?.dominantThread ||
    continuityPlanning.dominantCarryoverThread ||
    stagePlanning.chapterMission ||
    normalizedScenes[0]?.scenePurpose ||
    "",
  ).trim();
  const continuityAnchors = normalizeStringList([
    ...normalizeStringList(rawProposal?.continuityAnchors, 6),
    ...stagePlanning.mustPreserve,
    ...historyPlanning.mustNotContradict,
    ...continuityPlanning.continuityRisks,
  ], 6);
  const chapterPlan = {
    chapterId: chapterBase.chapterId,
    chapterNumber: chapterBase.chapterNumber,
    title: String(rawProposal?.title || chapterBase.title).trim() || chapterBase.title,
    stage: chapterBase.stage,
    timeInStory: String(rawProposal?.timeInStory || chapterBase.timeInStory).trim() || chapterBase.timeInStory,
    povCharacter,
    location: String(rawProposal?.location || chapterBase.location).trim() || chapterBase.location,
    keyEvents: keyEvents.length ? keyEvents : normalizeStringList([stagePlanning.chapterMission], 1),
    arcContribution: arcContribution.length ? arcContribution : normalizeStringList([stagePlanning.chapterMission], 1),
    nextHook: String(rawProposal?.nextHook || stagePlanning.nextPressure || chapterBase.nextHook || "新的问题已经压到眼前。").trim(),
    emotionalTone: String(rawProposal?.emotionalTone || chapterBase.emotionalTone || "张力渐强").trim(),
    charactersPresent: charactersPresent.length ? charactersPresent : normalizeStringList([povCharacter], 1),
    threadMode,
    dominantThread: dominantThread || stagePlanning.chapterMission || "本章主线待明确。",
    entryLink: String(rawProposal?.entryLink || continuityPlanning.entryLink || historyPlanning.lastEnding || "承接上一章压力。").trim(),
    exitPressure: String(rawProposal?.exitPressure || continuityPlanning.exitPressureToNextChapter || chapterBase.nextHook || stagePlanning.nextPressure || "新的问题已经压到眼前。").trim(),
    foreshadowingActions,
    continuityAnchors: continuityAnchors.length ? continuityAnchors : normalizeStringList([historyPlanning.lastEnding], 1),
    scenes: normalizedScenes,
  };

  return {
    proposalId,
    title: chapterPlan.title,
    summary: String(rawProposal?.summary || createExcerpt(`${chapterPlan.keyEvents.join("；")} ${chapterPlan.nextHook}`, 160)).trim(),
    rationale: String(rawProposal?.rationale || "围绕当前阶段目标与历史余波构造本章推进。").trim(),
    diffSummary: String(rawProposal?.diffSummary || `候选重点：${chapterPlan.scenes.map((scene) => scene.label).join(" / ")}`).trim(),
    chapterPlan,
  };
}

async function runStagePlanningContextAgent({
  provider,
  project,
  bundle,
  chapterBase,
  stage,
  foreshadowingActions,
  legacyPlan,
}) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 StagePlanningContextAgent。你负责把当前章节在全书粗纲与当前阶段中的任务提炼出来，供后续章节细纲候选生成使用。不要写正文，不要写章节方案，只输出当前章节的义务、延后项、冲突轴和标题信号。只输出 JSON。",
    input: [
      projectSummary(project),
      `当前章节：${chapterBase.chapterId}（第 ${chapterBase.chapterNumber} 章）`,
      `当前阶段：${stage?.label || chapterBase.stage}`,
      `阶段目标：${stage?.stageGoal || stage?.purpose || "无"}`,
      `阶段冲突：${(stage?.stageConflicts || []).join("；") || "无"}`,
      `粗纲：\n${(bundle?.outlineData?.roughSections || []).map((item) => `- ${item.stage}：${item.content}`).join("\n")}`,
      `伏笔任务：${foreshadowingActions.length ? foreshadowingActions.map((item) => `${item.action}:${item.id}:${item.description}`).join("；") : "无"}`,
      legacyPlan ? `旧版章卡参考：${legacyPlan.title}｜${legacyPlan.keyEvents.join("；")}｜${legacyPlan.nextHook}` : "旧版章卡参考：无",
      `请输出 JSON：
{
  "chapterMission": "一句话说明本章在阶段中的核心使命",
  "requiredBeats": ["本章必须落地1", "本章必须落地2"],
  "mustPreserve": ["当前章不能写丢的前提"],
  "deferRules": ["不能提前兑现的内容"],
  "suggestedConflictAxis": ["建议强化的冲突轴"],
  "titleSignals": ["标题意象或信号词"],
  "nextPressure": "本章结束后最该留下的下一压力"
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "chapter_outline_stage_context",
      chapterId: chapterBase.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`StagePlanningContextAgent 返回了无法解析的 JSON：${createExcerpt(result.text || "", 220)}`);
  }

  return {
    source: "agent",
    chapterMission: String(parsed.chapterMission || "").trim(),
    requiredBeats: normalizeStringList(parsed.requiredBeats, 6),
    mustPreserve: normalizeStringList(parsed.mustPreserve, 6),
    deferRules: normalizeStringList(parsed.deferRules, 6),
    suggestedConflictAxis: normalizeStringList(parsed.suggestedConflictAxis, 5),
    titleSignals: normalizeStringList(parsed.titleSignals, 5),
    nextPressure: String(parsed.nextPressure || "").trim(),
  };
}

async function runCharacterPlanningContextAgent({
  provider,
  project,
  bundle,
  chapterBase,
  currentCharacterStates,
  stage,
}) {
  const statePackets = (bundle?.characters || []).map((character) => {
    const state = currentCharacterStates.find((item) => item.name === character.name) || character.state || {};
    return [
      `## ${character.name}`,
      `角色定位：${character.role}`,
      `说话方式：${character.voice || "无"}`,
      `核心欲望：${character.desire || "无"}`,
      `核心伤口：${character.wound || "无"}`,
      `当前目标：${state?.psychological?.current_goal || "无"}`,
      `当前情绪：${state?.psychological?.emotional_state || "无"}`,
      `已知：${(state?.knowledge?.knows || []).join("；") || "无"}`,
      `未知：${(state?.knowledge?.does_not_know || []).join("；") || "无"}`,
      `人物线：${createExcerpt(character.storylineMarkdown || "", 160) || "无"}`,
    ].join("\n");
  }).join("\n\n");

  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 CharacterPlanningContextAgent。你负责为当前章节筛选最该出场的人物、推荐 POV、关系压力和禁止泄漏内容。不要生成细纲或正文，只输出 JSON。",
    input: [
      projectSummary(project),
      `当前章节：${chapterBase.chapterId}（第 ${chapterBase.chapterNumber} 章）`,
      `当前阶段：${stage?.label || chapterBase.stage}`,
      `当前角色资料：\n${statePackets}`,
      `请输出 JSON：
{
  "recommendedPov": "推荐 POV 角色",
  "mustAppear": ["本章必须上场的角色"],
  "optionalCharacters": ["可选上场角色"],
  "relationshipPressures": ["本章最值得写的关系压力"],
  "forbiddenLeaks": ["绝不能提前泄漏的内容"],
  "voiceNotes": ["角色写法提醒"]
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "chapter_outline_character_context",
      chapterId: chapterBase.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`CharacterPlanningContextAgent 返回了无法解析的 JSON：${createExcerpt(result.text || "", 220)}`);
  }

  return {
    source: "agent",
    recommendedPov: String(parsed.recommendedPov || "").trim(),
    mustAppear: normalizeStringList(parsed.mustAppear, 6),
    optionalCharacters: normalizeStringList(parsed.optionalCharacters, 6),
    relationshipPressures: normalizeStringList(parsed.relationshipPressures, 6),
    forbiddenLeaks: normalizeStringList(parsed.forbiddenLeaks, 8),
    voiceNotes: normalizeStringList(parsed.voiceNotes, 6),
  };
}

async function runHistoryPlanningContextAgent({
  provider,
  project,
  chapterBase,
  committedOutlines,
}) {
  const priorOutlines = [...committedOutlines]
    .filter((item) => item.chapterNumber < chapterBase.chapterNumber)
    .sort((left, right) => left.chapterNumber - right.chapterNumber);
  const overviewText = summarizeCommittedHistoryForPrompt(priorOutlines);
  const expandedDetails = expandCommittedHistoryDetails(priorOutlines, chapterBase, 4);

  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 HistoryPlanningContextAgent。你负责读取全书已经定稿的章节细纲，从中筛出当前章节真正需要继承的历史语义。你的职责是粗粒度控制：提炼必须延续的事实、情绪、未完线程、优先推进的主线，以及本章该压低存在感的历史线程。不要负责 scene 级衔接，不要生成细纲，只输出 JSON。",
    input: [
      projectSummary(project),
      `当前章节：${chapterBase.chapterId}（第 ${chapterBase.chapterNumber} 章）`,
      `全历史总览：\n${overviewText || "无已定稿历史细纲"}`,
      `重点展开章节：\n${expandedDetails || "无重点章节可展开"}`,
      `请输出 JSON：
{
  "carryOverFacts": ["必须承接的事实"],
  "emotionalCarryover": ["需要延续的情绪余波"],
  "openThreads": ["当前仍未解决的线程"],
  "priorityThreads": ["本章最该延续的历史线程"],
  "backgroundThreads": ["可作为背景存在的线程"],
  "suppressedThreads": ["本章应避免抢戏的历史线程"],
  "mustNotContradict": ["本章不能冲撞的内容"],
  "globalTrajectory": "一句话说明本章在全书历史推进中的位置",
  "lastEnding": "一句话概括上章余波"
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "chapter_outline_history_context",
      chapterId: chapterBase.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`HistoryPlanningContextAgent 返回了无法解析的 JSON：${createExcerpt(result.text || "", 220)}`);
  }

  return {
    source: "agent",
    carryOverFacts: normalizeStringList(parsed.carryOverFacts, 6),
    emotionalCarryover: normalizeStringList(parsed.emotionalCarryover, 4),
    openThreads: normalizeStringList(parsed.openThreads, 5),
    priorityThreads: normalizeStringList(parsed.priorityThreads, 5),
    backgroundThreads: normalizeStringList(parsed.backgroundThreads, 5),
    suppressedThreads: normalizeStringList(parsed.suppressedThreads, 5),
    mustNotContradict: normalizeStringList(parsed.mustNotContradict, 6),
    globalTrajectory: String(parsed.globalTrajectory || "").trim(),
    lastEnding: String(parsed.lastEnding || "").trim() || "上一章节的余波还在。",
  };
}

async function runChapterContinuityAgent({
  provider,
  project,
  chapterBase,
  stagePlanning,
  historyPlanning,
  factContext = null,
  previousOutline,
  nextLegacyPlan = null,
}) {
  const previousPlan = previousOutline?.chapterPlan || null;
  const factSections = buildFactPromptSections(factContext);
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 ChapterContinuityAgent。你专门负责章节之间的细粒度衔接：上一章怎么接进来、当前章主承接哪条线、哪些副线只能轻触、以及本章结尾要把什么压力递交给下一章。不要做全书语义总结，不要生成细纲或正文，只输出 JSON。",
    input: [
      projectSummary(project),
      `当前章节：${chapterBase.chapterId}（第 ${chapterBase.chapterNumber} 章）`,
      `本章使命：${stagePlanning.chapterMission || "无"}`,
      `本章必须推进：${(stagePlanning.requiredBeats || []).join("；") || "无"}`,
      `历史优先线程：${(historyPlanning.priorityThreads || []).join("；") || "无"}`,
      `必须继承的已定事实：${factSections.establishedFactsLine}`,
      `可以继续发酵但不能改写底层结论的开放张力：${factSections.openTensionsLine}`,
      `上一章定稿细纲：\n${previousPlan ? [
        `- 章节：${previousPlan.chapterId} ${previousPlan.title}`,
        `- 主线：${previousPlan.dominantThread || "无"}`,
        `- 场景链：${(previousPlan.scenes || []).map(sceneChainDigest).join(" || ") || "无"}`,
        `- 章末压力：${previousPlan.exitPressure || previousPlan.nextHook || "无"}`,
      ].join("\n") : "无（当前为开篇章节）"}`,
      `下一章旧章卡：${nextLegacyPlan ? `${nextLegacyPlan.chapterId} ${nextLegacyPlan.title}｜钩子:${nextLegacyPlan.nextHook || "无"}` : "无"}`,
      `请输出 JSON：
{
  "entryLink": "本章开头应该承接上一章哪个结果/余波/动作压力",
  "dominantCarryoverThread": "本章主承接线程",
  "subordinateThreads": ["可穿插但不能喧宾夺主的副线程"],
  "mustAdvanceThisChapter": "本章必须推进到什么程度",
  "canPauseThisChapter": ["本章可以暂缓的线程"],
  "exitPressureToNextChapter": "本章结尾要递给下一章的直接压力",
  "continuityRisks": ["最容易断裂或跳线的位置"]
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "chapter_outline_continuity_context",
      chapterId: chapterBase.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`ChapterContinuityAgent 返回了无法解析的 JSON：${createExcerpt(result.text || "", 220)}`);
  }

  return {
    source: "agent",
    entryLink: String(parsed.entryLink || "").trim(),
    dominantCarryoverThread: String(parsed.dominantCarryoverThread || "").trim(),
    subordinateThreads: normalizeStringList(parsed.subordinateThreads, 4),
    mustAdvanceThisChapter: String(parsed.mustAdvanceThisChapter || "").trim(),
    canPauseThisChapter: normalizeStringList(parsed.canPauseThisChapter, 4),
    exitPressureToNextChapter: String(parsed.exitPressureToNextChapter || "").trim(),
    continuityRisks: normalizeStringList(parsed.continuityRisks, 5),
  };
}

async function generateChapterOutlineCandidates({
  provider,
  project,
  bundle,
  chapterBase,
  outlineOptions,
  stagePlanning,
  characterPlanning,
  historyPlanning,
  continuityPlanning,
  factContext = null,
  foreshadowingActions,
  styleGuideText,
  openingReferencePacket = null,
  legacyPlan = null,
  feedback = "",
  previousHistory = [],
}) {
  const factSections = buildFactPromptSections(factContext);
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 ChapterOutlineAgent。请为当前章节一次性生成多个差异明显的细纲候选方案。每个方案都要先判断本章线索结构，再生成可直接进入后续正文生成的完整 chapter plan。方案之间要在冲突轴、主承接线程、人物焦点、章末压力上明显拉开。单线章节要形成连贯的情节链，多线章节要明确每个 scene 属于哪条线以及为何切换。只输出 JSON。",
    input: [
      projectSummary(project),
      `当前章节：${chapterBase.chapterId}（第 ${chapterBase.chapterNumber} 章）`,
      `阶段任务：${stagePlanning.chapterMission || "无"}`,
      `必须落地：${(stagePlanning.requiredBeats || []).join("；") || "无"}`,
      `必须保留：${(stagePlanning.mustPreserve || []).join("；") || "无"}`,
      `延后兑现：${(stagePlanning.deferRules || []).join("；") || "无"}`,
      `角色建议：推荐 POV=${characterPlanning.recommendedPov || chapterBase.povCharacter}｜必须登场=${(characterPlanning.mustAppear || []).join("、") || "无"}｜可选登场=${(characterPlanning.optionalCharacters || []).join("、") || "无"}`,
      `关系压力：${(characterPlanning.relationshipPressures || []).join("；") || "无"}`,
      `必须继承的已定事实：${factSections.establishedFactsLine}`,
      `可以继续发酵但不能改写底层结论的开放张力：${factSections.openTensionsLine}`,
      `历史承接：事实=${(historyPlanning.carryOverFacts || []).join("；") || "无"}｜优先线程=${(historyPlanning.priorityThreads || []).join("；") || "无"}｜背景线程=${(historyPlanning.backgroundThreads || []).join("；") || "无"}｜压低线程=${(historyPlanning.suppressedThreads || []).join("；") || "无"}｜余波=${historyPlanning.lastEnding || "无"}`,
      `章节衔接：开场承接=${continuityPlanning.entryLink || "无"}｜主承接线程=${continuityPlanning.dominantCarryoverThread || "无"}｜必须推进到=${continuityPlanning.mustAdvanceThisChapter || "无"}｜章末递交压力=${continuityPlanning.exitPressureToNextChapter || "无"}｜连贯性风险=${(continuityPlanning.continuityRisks || []).join("；") || "无"}`,
      `伏笔任务：${foreshadowingActions.length ? foreshadowingActions.map((item) => `${item.action}:${item.id}:${item.description}`).join("；") : "无"}`,
      `风格提醒：${createExcerpt(styleGuideText || "", 800) || "无"}`,
      `黄金三章参考包：\n${openingReferencePacket?.briefingMarkdown || "当前没有额外黄金三章参考。"}`,
      legacyPlan ? `旧版章卡参考（仅供参考，不要机械照抄）：${JSON.stringify({
        title: legacyPlan.title,
        povCharacter: legacyPlan.povCharacter,
        location: legacyPlan.location,
        keyEvents: legacyPlan.keyEvents,
        nextHook: legacyPlan.nextHook,
      })}` : "旧版章卡参考：无",
      feedback ? `作者反馈：${feedback}` : "",
      previousHistory.length ? `上一轮生成历史：${createExcerpt(JSON.stringify(previousHistory.slice(-2)), 1200)}` : "",
      "生成要求：先判断本章是 single_spine / dual_spine / braided。若是 single_spine，大多数 scenes 必须服务同一条主线，后一场必须承接前一场的结果、信息或压力；若是 dual_spine 或 braided，每个 scene 必须标明 threadId，并让切线有明确因果，不要机械切场。第一场必须响应“开场承接”，末场必须落到“章末递交压力”。每个 scene 都要说明它承接了什么、产出了什么、把什么问题交给下一场。",
      `请输出 JSON：
{
  "proposals": [
    {
      "proposalId": "proposal_1",
      "summary": "一句话概括这个方案",
      "rationale": "为什么这样安排",
      "diffSummary": "与其他方案最主要的差异",
      "title": "章节标题",
      "timeInStory": "故事时间",
      "povCharacter": "角色名",
      "location": "章节主地点",
      "keyEvents": ["事件1", "事件2", "事件3"],
      "arcContribution": ["弧光1", "弧光2"],
      "nextHook": "章末钩子",
      "emotionalTone": "情绪基调",
      "threadMode": "single_spine",
      "dominantThread": "本章主线一句话",
      "entryLink": "本章开场承接点",
      "exitPressure": "本章末尾递交给下一章的直接压力",
      "charactersPresent": ["角色A", "角色B"],
      "continuityAnchors": ["连续性锚点1", "连续性锚点2"],
      "scenes": [
        {
          "label": "场景标签",
          "location": "地点",
          "focus": "场景任务",
          "tension": "张力",
          "characters": ["角色A", "角色B"],
          "threadId": "main",
          "scenePurpose": "这个 scene 在整章中的作用",
          "inheritsFromPrevious": "这一场承接了什么",
          "outcome": "这一场产出了什么结果",
          "handoffToNext": "把什么问题交给下一场"
        }
      ]
    }
  ]
}`,
    ].join("\n\n"),
    temperature: outlineOptions.temperature,
    metadata: {
      feature: "chapter_outline_candidates",
      chapterId: chapterBase.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`ChapterOutlineAgent 返回了无法解析的 JSON：${createExcerpt(result.text || "", 220)}`);
  }

  const proposals = Array.isArray(parsed.proposals)
    ? parsed.proposals
    : Array.isArray(parsed.candidates)
      ? parsed.candidates
      : [];

  if (!proposals.length) {
    throw new Error("ChapterOutlineAgent 没有返回可用候选。");
  }

  return proposals
    .slice(0, outlineOptions.variantCount)
    .map((proposal, index) => normalizeOutlineProposal(proposal, index, {
      chapterBase,
      bundle,
      stagePlanning,
      characterPlanning,
      historyPlanning,
      continuityPlanning,
      foreshadowingActions,
    }));
}

function fallbackStagePlanningContext({ chapterBase, stage, foreshadowingActions, legacyPlan }) {
  return {
    source: "fallback",
    chapterMission: stage?.stageGoal || stage?.purpose || `${chapterBase.chapterId} 需要承接当前阶段的主线推进。`,
    requiredBeats: normalizeStringList([
      ...(legacyPlan?.keyEvents || []),
      ...(foreshadowingActions || []).map((item) => `${item.action}:${item.description}`),
    ], 4),
    mustPreserve: normalizeStringList([
      `阶段保持为 ${chapterBase.stage}`,
      `章节编号保持 ${chapterBase.chapterId}`,
    ], 4),
    deferRules: normalizeStringList([
      ...((stage?.stageConflicts || []).slice(2)),
    ], 4),
    suggestedConflictAxis: normalizeStringList(stage?.stageConflicts || [], 4),
    titleSignals: normalizeStringList([
      ...(legacyPlan?.title ? [legacyPlan.title] : []),
      chapterBase.stage,
    ], 3),
    nextPressure: legacyPlan?.nextHook || stage?.stageGoal || "",
  };
}

function fallbackCharacterPlanningContext({ bundle, chapterBase, legacyPlan, currentCharacterStates }) {
  const allNames = normalizeStringList((bundle?.characters || []).map((item) => item.name), 12);
  const recentStates = currentCharacterStates.slice(0, 4);
  return {
    source: "fallback",
    recommendedPov: legacyPlan?.povCharacter || chapterBase.povCharacter,
    mustAppear: normalizeStringList(legacyPlan?.charactersPresent || [chapterBase.povCharacter], 4),
    optionalCharacters: normalizeStringList(allNames.filter((name) => !(legacyPlan?.charactersPresent || []).includes(name)), 4),
    relationshipPressures: normalizeStringList(
      recentStates.map((state) => `${state.name}：${state?.arc_progress?.arc_note || state?.psychological?.current_goal || "关系待推进"}`),
      4,
    ),
    forbiddenLeaks: normalizeStringList(
      recentStates.flatMap((state) => (state?.knowledge?.does_not_know || []).slice(0, 1).map((item) => `${state.name}当前不知道：${item}`)),
      6,
    ),
    voiceNotes: normalizeStringList((bundle?.characters || []).slice(0, 4).map((character) => `${character.name}：${character.voice || "保持既有说话方式"}`), 4),
  };
}

function fallbackHistoryPlanningContext({ committedOutlines }) {
  const recentOutlines = [...committedOutlines].slice(-4);
  return {
    source: recentOutlines.length ? "fallback" : "empty",
    carryOverFacts: normalizeStringList(recentOutlines.flatMap((item) => item.keyEvents || []), 5),
    emotionalCarryover: normalizeStringList(recentOutlines.map((item) => item.chapterPlan?.emotionalTone || ""), 3),
    openThreads: normalizeStringList(recentOutlines.flatMap((item) => item.openThreads || []), 4),
    priorityThreads: normalizeStringList(recentOutlines.map((item) => item.dominantThread || ""), 4),
    backgroundThreads: normalizeStringList(recentOutlines.flatMap((item) => item.openThreads || []).slice(1), 4),
    suppressedThreads: [],
    mustNotContradict: normalizeStringList(recentOutlines.flatMap((item) => item.continuityAnchors || []), 6),
    globalTrajectory: recentOutlines.length ? "继续承接已定稿章节形成的主线推进。" : "",
    lastEnding: recentOutlines.at(-1)?.exitPressure || recentOutlines.at(-1)?.nextHook || "上一章节的余波还在。",
  };
}

async function prepareChapterOutlineResources({
  store,
  provider,
  project,
  bundle,
  chapterNumber,
  outlineOptions = null,
}) {
  const normalizedOutlineOptions = normalizeOutlineOptions(outlineOptions);
  const stage = findStageForChapterNumber(bundle?.structureData, chapterNumber);
  const legacyPlan = legacyChapterReference(bundle, chapterNumber);
  const nextLegacyPlan = legacyChapterReference(bundle, chapterNumber + 1);
  const foreshadowingActions = buildForeshadowingActionsForChapter(bundle?.foreshadowingRegistry, chapterNumber);
  const chapterBase = buildOutlineBaseChapterPlan({
    project,
    chapterNumber,
    stage,
    legacyPlan,
    foreshadowingActions,
  });
  const currentCharacterStates = await loadCurrentCharacterStates(store, bundle);
  const chapterMetas = await store.listChapterMeta();
  const committedOutlines = (await store.listCommittedChapterOutlines())
    .map(chapterOutlineDigest)
    .filter((item) => item.chapterNumber < chapterNumber);
  const { styleGuideText, styleGuideSourcePath } = await resolveStyleBaseline(store, project, chapterBase);

  let stagePlanning;
  let characterPlanning;
  let historyPlanning;
  let continuityPlanning;
  const warnings = [];
  const { factContext, warning: factContextWarning } = await selectFactContextForChapter({
    store,
    provider,
    project,
    chapterPlan: chapterBase,
  });

  if (factContextWarning) {
    warnings.push(factContextWarning);
  }

  try {
    stagePlanning = await runStagePlanningContextAgent({
      provider,
      project,
      bundle,
      chapterBase,
      stage,
      foreshadowingActions,
      legacyPlan,
    });
  } catch (error) {
    stagePlanning = fallbackStagePlanningContext({ chapterBase, stage, foreshadowingActions, legacyPlan });
    warnings.push(`StagePlanningContextAgent 失败，已回退到规则摘要：${error instanceof Error ? error.message : String(error || "")}`);
  }

  try {
    characterPlanning = await runCharacterPlanningContextAgent({
      provider,
      project,
      bundle,
      chapterBase,
      currentCharacterStates,
      stage,
    });
  } catch (error) {
    characterPlanning = fallbackCharacterPlanningContext({
      bundle,
      chapterBase,
      legacyPlan,
      currentCharacterStates,
    });
    warnings.push(`CharacterPlanningContextAgent 失败，已回退到角色摘要：${error instanceof Error ? error.message : String(error || "")}`);
  }

  try {
    historyPlanning = await runHistoryPlanningContextAgent({
      provider,
      project,
      chapterBase,
      committedOutlines,
    });
  } catch (error) {
    historyPlanning = fallbackHistoryPlanningContext({ committedOutlines });
    warnings.push(`HistoryPlanningContextAgent 失败，已回退到历史摘要：${error instanceof Error ? error.message : String(error || "")}`);
  }

  try {
    continuityPlanning = await runChapterContinuityAgent({
      provider,
      project,
      chapterBase,
      stagePlanning,
      historyPlanning,
      factContext,
      previousOutline: committedOutlines.at(-1)?.chapterPlan ? committedOutlines.at(-1) : null,
      nextLegacyPlan,
    });
  } catch (error) {
    continuityPlanning = buildFallbackContinuityPlanning({
      chapterBase,
      stagePlanning,
      historyPlanning,
      previousOutline: committedOutlines.at(-1)?.chapterPlan ? committedOutlines.at(-1) : null,
      nextLegacyPlan,
    });
    warnings.push(`ChapterContinuityAgent 失败，已回退到规则化章节衔接：${error instanceof Error ? error.message : String(error || "")}`);
  }

  const briefingMarkdown = buildOutlineContextMarkdown({
    chapterBase,
    stagePlanning,
    characterPlanning,
    historyPlanning,
    continuityPlanning,
    factContext,
    outlineOptions: normalizedOutlineOptions,
    foreshadowingActions,
    legacyPlan,
  });
  const baseContext = {
    chapterId: chapterBase.chapterId,
    chapterNumber,
    generatedAt: nowIso(),
    stagePlanning,
    characterPlanning,
    historyPlanning,
    continuityPlanning,
    factContext,
    warnings,
    briefingMarkdown,
    summaryText: createExcerpt(briefingMarkdown, 320),
  };
  const shouldUseOpeningReference = chapterNumber <= 3;
  let openingReferencePacket = createEmptyOpeningReferencePacket({
    mode: "chapter_outline",
  });
  if (shouldUseOpeningReference) {
    openingReferencePacket = await buildOpeningReferencePacket({
      store,
      provider,
      project,
      mode: "chapter_outline",
      chapterBase,
    });
  }
  const chapterOutlineContext = mergeOpeningIntoOutlineContext(baseContext, openingReferencePacket);

  return {
    chapterBase,
    stage,
    legacyPlan,
    nextLegacyPlan,
    foreshadowingActions,
    currentCharacterStates,
    chapterMetas,
    committedOutlines,
    styleGuideText,
    styleGuideSourcePath,
    openingReferencePacket,
    outlineOptions: normalizedOutlineOptions,
    factContext,
    chapterOutlineContext,
  };
}

function buildChapterOutlinePreparationSteps(resources, candidates = []) {
  const steps = [
    step(
      "stage_planning_context_agent",
      "StagePlanningContextAgent",
      "write",
      resources.chapterOutlineContext.stagePlanning.source === "agent"
        ? "已从粗纲、阶段蓝图与伏笔中提炼当前章节义务。"
        : "StagePlanningContextAgent 不可用，已回退到规则化阶段摘要。",
      { preview: createExcerpt(resources.chapterOutlineContext.stagePlanning.chapterMission || "", 180) },
    ),
    step(
      "character_planning_context_agent",
      "CharacterPlanningContextAgent",
      "write",
      resources.chapterOutlineContext.characterPlanning.source === "agent"
        ? "已整理当前章节最值得上场的人物、关系压力与知识边界。"
        : "CharacterPlanningContextAgent 不可用，已回退到角色状态摘要。",
      { preview: createExcerpt((resources.chapterOutlineContext.characterPlanning.mustAppear || []).join("；"), 180) },
    ),
    step(
      "history_planning_context_agent",
      "HistoryPlanningContextAgent",
      "write",
      resources.chapterOutlineContext.historyPlanning.source === "agent"
        ? "已提炼当前章节必须承接的历史余波与未完线程。"
        : "HistoryPlanningContextAgent 不可用，已回退到已定稿历史摘要。",
      { preview: createExcerpt((resources.chapterOutlineContext.historyPlanning.openThreads || []).join("；"), 180) },
    ),
    step(
      "fact_selector_agent",
      "FactSelectorAgent",
      "write",
      resources.factContext
        ? resources.factContext.catalogStats?.selected
          ? `已从 ${resources.factContext.catalogStats.totalFacts || 0} 条已批准章节事实中筛出 ${resources.factContext.catalogStats.selected} 条供细纲继承。`
          : "事实账本已加载，但当前章节没有命中需要继承的 canon facts。"
        : "当前没有可用的章节级 canon facts，细纲先依赖历史摘要链路。",
      {
        preview: createExcerpt(
          formatFactPromptList(resources.factContext?.establishedFacts || []) ||
            formatFactPromptList(resources.factContext?.openTensions || []),
          180,
        ),
      },
    ),
    step(
      "chapter_continuity_agent",
      "ChapterContinuityAgent",
      "write",
      resources.chapterOutlineContext.continuityPlanning.source === "agent"
        ? "已梳理本章的开场承接、主承接线程与章末递交压力。"
        : "ChapterContinuityAgent 不可用，已回退到规则化章节衔接。",
      { preview: createExcerpt(resources.chapterOutlineContext.continuityPlanning.entryLink || "", 180) },
    ),
  ];

  if (resources.openingReferencePacket?.triggered) {
    steps.push(
      step(
        "opening_reference_packet",
        "OpeningPatternSynthesizerAgent",
        "write",
        `已为 ${resources.chapterBase.chapterId} 提炼黄金三章结构参考。`,
        { preview: createExcerpt(resources.openingReferencePacket.summary || "", 180) },
      ),
    );
  }

  steps.push(
    step(
      "chapter_outline_agent",
      "ChapterOutlineAgent",
      "write",
      `已生成 ${candidates.length} 个章节细纲候选，等待作者选择、组合或反馈重生。`,
      { preview: candidates.map((item) => item.proposalId).join(" / ") },
    ),
  );

  return steps;
}

function renumberComposedScenes(chapterId, scenes = []) {
  return scenes.map((scene, index) => ({
    ...scene,
    id: `${chapterId}_scene_${index + 1}`,
    sceneRef: scene.sceneRef || `${scene.proposalId || "composed"}:scene_${index + 1}`,
  }));
}

function selectProposalById(candidates = [], proposalId = "") {
  return (Array.isArray(candidates) ? candidates : []).find((item) => item.proposalId === proposalId) || null;
}

function collectSelectedScenes(candidates = [], sceneRefs = []) {
  const sceneMap = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    for (const scene of candidate?.chapterPlan?.scenes || []) {
      sceneMap.set(scene.sceneRef, {
        ...scene,
        sourceProposalId: candidate.proposalId,
      });
    }
  }

  return sceneRefs
    .map((sceneRef) => sceneMap.get(sceneRef))
    .filter(Boolean);
}

async function finalizeComposedChapterOutline({
  provider,
  project,
  bundle,
  resources,
  selectedScenes,
  authorNotes = "",
}) {
  const factSections = buildFactPromptSections(resources.factContext);
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 ChapterOutlineFinalizeAgent。作者已经从多个候选细纲里挑出一组 scenes。请把这些 scene 归一化成一个完整可执行的 chapter plan，补齐事件、弧光、钩子、角色名单和连续性锚点。只输出 JSON。",
    input: [
      projectSummary(project),
      `当前章节：${resources.chapterBase.chapterId}（第 ${resources.chapterBase.chapterNumber} 章）`,
      `阶段任务：${resources.chapterOutlineContext.stagePlanning.chapterMission || "无"}`,
      `必须落地：${(resources.chapterOutlineContext.stagePlanning.requiredBeats || []).join("；") || "无"}`,
      `角色压力：${(resources.chapterOutlineContext.characterPlanning.relationshipPressures || []).join("；") || "无"}`,
      `历史余波：${resources.chapterOutlineContext.historyPlanning.lastEnding || "无"}`,
      `必须继承的已定事实：${factSections.establishedFactsLine}`,
      `可以继续发酵但不能改写底层结论的开放张力：${factSections.openTensionsLine}`,
      `章节衔接：开场承接=${resources.chapterOutlineContext.continuityPlanning.entryLink || "无"}｜主承接线程=${resources.chapterOutlineContext.continuityPlanning.dominantCarryoverThread || "无"}｜章末递交压力=${resources.chapterOutlineContext.continuityPlanning.exitPressureToNextChapter || "无"}`,
      `作者备注：${authorNotes || "无"}`,
      `已选 scenes：\n${selectedScenes.map((scene, index) => `${index + 1}. [${scene.sourceProposalId}] ${scene.label}｜${scene.location}｜${scene.focus}｜${scene.tension}｜${scene.characters.join("、")}｜线程:${scene.threadId || "main"}｜承接:${scene.inheritsFromPrevious || "无"}｜结果:${scene.outcome || "无"}｜交棒:${scene.handoffToNext || "无"}`).join("\n")}`,
      `请输出 JSON：
{
  "title": "章节标题",
  "timeInStory": "故事时间",
  "povCharacter": "角色名",
  "location": "章节主地点",
  "keyEvents": ["事件1", "事件2", "事件3"],
  "arcContribution": ["弧光1", "弧光2"],
  "nextHook": "章末钩子",
  "emotionalTone": "情绪基调",
  "threadMode": "single_spine",
  "dominantThread": "本章主线一句话",
  "entryLink": "本章开场承接点",
  "exitPressure": "本章末尾递交给下一章的直接压力",
  "charactersPresent": ["角色A", "角色B"],
  "continuityAnchors": ["连续性锚点1", "连续性锚点2"],
  "scenes": [
    {
      "label": "场景标签",
      "location": "地点",
      "focus": "场景任务",
      "tension": "张力",
      "characters": ["角色A", "角色B"],
      "threadId": "main",
      "scenePurpose": "这个 scene 在整章中的作用",
      "inheritsFromPrevious": "这一场承接了什么",
      "outcome": "这一场产出了什么结果",
      "handoffToNext": "把什么问题交给下一场"
    }
  ]
}`,
    ].join("\n\n"),
    metadata: {
      feature: "chapter_outline_finalize",
      chapterId: resources.chapterBase.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`ChapterOutlineFinalizeAgent 返回了无法解析的 JSON：${createExcerpt(result.text || "", 220)}`);
  }

  const composed = normalizeOutlineProposal(parsed, 0, {
    chapterBase: resources.chapterBase,
    bundle,
    stagePlanning: resources.chapterOutlineContext.stagePlanning,
    characterPlanning: resources.chapterOutlineContext.characterPlanning,
    historyPlanning: resources.chapterOutlineContext.historyPlanning,
    continuityPlanning: resources.chapterOutlineContext.continuityPlanning,
    factContext: resources.factContext,
    foreshadowingActions: resources.foreshadowingActions,
  });
  composed.chapterPlan.scenes = renumberComposedScenes(resources.chapterBase.chapterId, composed.chapterPlan.scenes);
  return composed;
}

function buildComposedOutlineFallback({
  bundle,
  resources,
  selectedScenes,
  authorNotes = "",
}) {
  const baseCandidate = selectProposalById(resources.existingCandidates, selectedScenes[0]?.sourceProposalId || "");
  const baseProposal = baseCandidate || resources.existingCandidates[0];
  const normalizedScenes = renumberComposedScenes(resources.chapterBase.chapterId, selectedScenes);
  return normalizeOutlineProposal({
    proposalId: "proposal_composed",
    summary: authorNotes || "组合自多个候选的 scene 方案。",
    rationale: "根据作者挑选的 scenes 重新组合本章推进。",
    diffSummary: `组合来源：${[...new Set(selectedScenes.map((scene) => scene.sourceProposalId))].join(" / ")}`,
    title: baseProposal?.chapterPlan?.title || resources.chapterBase.title,
    timeInStory: baseProposal?.chapterPlan?.timeInStory || resources.chapterBase.timeInStory,
    povCharacter: baseProposal?.chapterPlan?.povCharacter || resources.chapterBase.povCharacter,
    location: baseProposal?.chapterPlan?.location || resources.chapterBase.location,
    keyEvents: normalizedScenes.map((scene) => scene.focus),
    arcContribution: baseProposal?.chapterPlan?.arcContribution || [],
    nextHook: baseProposal?.chapterPlan?.nextHook || resources.chapterOutlineContext.stagePlanning.nextPressure,
    emotionalTone: baseProposal?.chapterPlan?.emotionalTone || "张力渐强",
    threadMode: baseProposal?.chapterPlan?.threadMode || "single_spine",
    dominantThread: baseProposal?.chapterPlan?.dominantThread || resources.chapterOutlineContext.continuityPlanning.dominantCarryoverThread,
    entryLink: baseProposal?.chapterPlan?.entryLink || resources.chapterOutlineContext.continuityPlanning.entryLink,
    exitPressure: baseProposal?.chapterPlan?.exitPressure || resources.chapterOutlineContext.continuityPlanning.exitPressureToNextChapter,
    charactersPresent: normalizedScenes.flatMap((scene) => scene.characters),
    continuityAnchors: baseProposal?.chapterPlan?.continuityAnchors || [],
    scenes: normalizedScenes,
  }, 0, {
    chapterBase: resources.chapterBase,
    bundle,
    stagePlanning: resources.chapterOutlineContext.stagePlanning,
    characterPlanning: resources.chapterOutlineContext.characterPlanning,
    historyPlanning: resources.chapterOutlineContext.historyPlanning,
    continuityPlanning: resources.chapterOutlineContext.continuityPlanning,
    factContext: resources.factContext,
    foreshadowingActions: resources.foreshadowingActions,
  });
}

async function prepareChapterWriteResources({
  store,
  provider,
  mcpManager,
  project,
  bundle,
  chapterPlan,
}) {
  const chapterMetas = await store.listChapterMeta();
  const currentCharacterStates = await loadCurrentCharacterStates(store, bundle);
  const focusedCharacterStates = currentCharacterStates.filter((state) =>
    chapterPlan.charactersPresent.includes(state.name),
  );
  const characterDossiers = buildCharacterDossiers(bundle, chapterPlan, currentCharacterStates);
  const foreshadowingAdvice = collectForeshadowingAdvice(bundle.foreshadowingRegistry, chapterPlan);
  const { styleGuideText, styleGuideSourcePath } = await resolveStyleBaseline(store, project, chapterPlan);
  const researchPacket = await buildResearchPacket({
    mcpManager,
    provider,
    project,
    chapterPlan,
  });
  const {
    planContext,
    historyContext: historyPacket,
    writerContext: baseWriterContext,
    factContext,
  } = await buildWriterContextBundle({
    store,
    provider,
    project,
    bundle,
    chapterPlan,
    chapterMetas,
    characterStates: currentCharacterStates,
    foreshadowingAdvice,
    styleGuideText,
    styleGuideSourcePath,
    researchPacket,
  });
  const referencePacket = await buildReferencePacket({
    store,
    provider,
    mcpManager,
    project,
    chapterPlan,
    planContext,
    historyContext: historyPacket,
    researchPacket,
  });
  let openingReferencePacket = createEmptyOpeningReferencePacket({
    mode: "chapter_write",
  });
  if (Number(chapterPlan?.chapterNumber || 0) <= 3) {
    openingReferencePacket = await buildOpeningReferencePacket({
      store,
      provider,
      project,
      mode: "chapter_write",
      chapterPlan,
      planContext,
      historyContext: historyPacket,
    });
  }
  const writerContextWithReference = mergeReferenceIntoWriterContext(baseWriterContext, referencePacket);
  const writerContext = mergeOpeningIntoWriterContext(writerContextWithReference, openingReferencePacket);
  const governance = buildGovernanceResources({
    chapterPlan,
    planContext,
    historyPacket,
    writerContext,
    foreshadowingAdvice,
    researchPacket,
    referencePacket,
    openingReferencePacket,
    styleGuideText,
    styleGuideSourcePath,
    factContext,
  });

  const foreshadowingSummary = summarizeForeshadowingAdvice(foreshadowingAdvice, chapterPlan);
  const characterStateSummary = summarizeCharacterStates(focusedCharacterStates);
  const sceneBeatSummary = summarizeSceneBeats(chapterPlan);

  return {
    chapterMetas,
    chapterPlan,
    currentCharacterStates,
    focusedCharacterStates,
    characterDossiers,
    foreshadowingAdvice,
    researchPacket,
    referencePacket,
    openingReferencePacket,
    styleGuideText,
    styleGuideSourcePath,
    planContext,
    historyPacket,
    factContext,
    writerContext,
    governance,
    foreshadowingSummary,
    characterStateSummary,
    sceneBeatSummary,
  };
}

function buildChapterPreparationSteps(resources) {
  const steps = [
    step(
      "plan_context_outline_agent",
      "OutlineContextAgent",
      "write",
      resources.planContext.outline.source === "agent"
        ? "从锁定大纲中筛选当前章节必须兑现、必须延后与最容易写偏的主轴。"
        : "OutlineContextAgent 不可用，已退回结构化大纲 fallback 摘要。",
      { preview: createExcerpt(resources.planContext.outline.recommendedFocus || resources.planContext.summaryText || "", 160) },
    ),
    step(
      "plan_context_character_agent",
      "CharacterContextAgent",
      "write",
      resources.planContext.characters.source === "agent"
        ? `整理 ${resources.focusedCharacterStates.length} 名登场角色的当前诉求、知识边界与关系压力。`
        : `CharacterContextAgent 不可用，已用 ${resources.focusedCharacterStates.length} 名角色的资料卡 fallback 兜底。`,
      {
        preview: createExcerpt(resources.planContext.characters.writerReminders.join("；"), 180),
      },
    ),
    step(
      "plan_context_world_agent",
      "WorldContextAgent",
      "write",
      resources.planContext.world.source === "agent"
        ? "从世界观、世界状态、伏笔与风格指南中筛出本章有效约束。"
        : "WorldContextAgent 不可用，已退回世界状态与风格规则 fallback 摘要。",
      {
        preview: createExcerpt(
          resources.planContext.world.foreshadowingTasks.join("；") || resources.planContext.world.continuityAnchors.join("；"),
          180,
        ),
      },
    ),
    step(
      "history_selector_agent",
      "HistorySelectorAgent",
      "write",
      resources.historyPacket.selectionSource === "fallback"
        ? "HistorySelectorAgent 不可用，已回退到最近章节优先的规则筛选。"
        : resources.historyPacket.relatedChapters.length
          ? `从 ${resources.historyPacket.catalogStats?.totalChapters || resources.historyPacket.relatedChapters.length} 章历史中筛出 ${resources.historyPacket.relatedChapters.length} 章供本章承接。`
          : "当前没有需要额外回看的历史章节。",
      {
        preview: (resources.historyPacket.relatedChapters || [])
          .map((item) => item.chapter_id)
          .join(" / "),
      },
    ),
    step(
      "history_context_agent",
      "HistoryContextAgent",
      "write",
      resources.historyPacket.digestSource === "fallback"
        ? "HistoryContextAgent 不可用，已回退到摘要式历史衔接 fallback。"
        : resources.historyPacket.relatedChapters.length
          ? "整理历史章节中的事实余波、未完线程与不可冲突点。"
          : "当前章节无需承接已完成正文的历史余波。",
      { preview: createExcerpt(resources.historyPacket.contextSummary || "", 180) },
    ),
    step(
      "fact_selector_agent",
      "FactSelectorAgent",
      "write",
      resources.factContext
        ? resources.factContext.catalogStats?.selected
          ? `已从 ${resources.factContext.catalogStats.totalFacts || 0} 条既定事实中筛出 ${resources.factContext.catalogStats.selected} 条写作护栏。`
          : "事实账本已加载，但当前章节没有命中需要继承的 canon facts。"
        : "当前没有可用的章节级 canon facts，Writer 仅依赖摘要与治理链路。",
      {
        preview: createExcerpt(
          formatFactPromptList(resources.factContext?.establishedFacts || []) ||
            formatFactPromptList(resources.factContext?.openTensions || []),
          180,
        ),
      },
    ),
    step(
      "reference_query_planner_agent",
      "ReferenceQueryPlannerAgent",
      "write",
      resources.referencePacket.triggered
        ? "已结合计划侧与历史侧上下文生成范文检索查询。"
        : "当前项目未绑定可用范文库，跳过范文检索。",
      {
        preview: createExcerpt(
          (resources.referencePacket.queries || []).join("；") || resources.referencePacket.summary || "",
          180,
        ),
      },
    ),
    step(
      "reference_hybrid_rag",
      "ReferenceHybridRetriever",
      "write",
      resources.referencePacket.triggered
        ? `混合检索命中 ${(resources.referencePacket.matches || []).length} 个范文片段，并整理出可借鉴写法。`
        : "当前没有可用的范文参考包。",
      {
        preview: createExcerpt(
          (resources.referencePacket.styleSignals || []).join("；") || resources.referencePacket.summary || "",
          180,
        ),
      },
    ),
    step(
      "coordinator_agent",
      "ContextCoordinatorAgent",
      "write",
      resources.writerContext.usedFallback
        ? "合并计划侧与历史侧上下文时检测到 fallback，已把降级信息写入上下文 JSON。"
        : "合并计划侧与历史侧上下文，生成 Writer 直写正文所需的上下文包。",
      { preview: createExcerpt(resources.writerContext.briefingMarkdown, 200) },
    ),
    step(
      "input_governance_builder",
      "InputGovernance",
      "write",
      "生成 chapter intent、context package、rule stack 与 trace，让 Writer 先遵守治理合同再落正文。",
      {
        preview: createExcerpt(
          resources.governance.chapterIntent.goal ||
            resources.governance.ruleStack.currentTask.join("；"),
          180,
        ),
      },
    ),
    step(
      "foreshadowing_agent",
      "ForeshadowingAgent",
      "write",
      resources.foreshadowingAdvice.length
        ? `本章需处理 ${resources.foreshadowingAdvice.length} 条伏笔任务。`
        : "本章以自然浇水为主，无强制收线项。",
    ),
  ];

  if (resources.openingReferencePacket?.triggered) {
    steps.splice(7, 0, step(
      "opening_reference_packet",
      "OpeningPatternSynthesizerAgent",
      "write",
      `已为 ${resources.chapterPlan.chapterId} 提炼黄金三章结构参考。`,
      {
        preview: createExcerpt(
          (resources.openingReferencePacket.structuralBeats || []).join("；") || resources.openingReferencePacket.summary || "",
          180,
        ),
      },
    ));
  }

  if (!resources.researchPacket.triggered) {
    steps.splice(7, 0, step("research_agent", "ResearchAgent", "write", "本章无需外部考据。"));
    return steps;
  }

  steps.splice(
    7,
    0,
    step("research_planner_agent", "ResearchPlannerAgent", "write", resources.researchPacket.reason || "已识别出本章需要外部考据。"),
    step(
      "research_retriever_agent",
      "ResearchRetriever",
      "write",
      resources.researchPacket.summary || "已调用模型搜索工具检索相关资料。",
      {
        preview: createExcerpt((resources.researchPacket.sourceNotes || []).join("；"), 180),
      },
    ),
    step(
      "research_synthesizer_agent",
      "ResearchSynthesizerAgent",
      "write",
      "已将检索结果整理为 Writer 可直接消费的研究资料包。",
      {
        preview: createExcerpt((resources.researchPacket.factsToUse || []).join("；"), 180),
      },
    ),
  );

  return steps;
}

async function generateChapterDraft({
  store,
  provider,
  mcpManager,
  projectState,
  bundle,
  chapterPlan,
  chapterNumber,
  existingRewriteHistory = [],
  outlineArtifacts = null,
}) {
  const resources = await prepareChapterWriteResources({
    store,
    provider,
    mcpManager,
    project: projectState.project,
    bundle,
    chapterPlan,
  });

  const run = {
    id: runId("write"),
    phase: "write",
    startedAt: nowIso(),
    target: REVIEW_TARGETS.CHAPTER,
    chapterId: chapterPlan.chapterId,
    steps: buildChapterPreparationSteps(resources),
  };

  const auditContext = {
    store,
    provider,
    project: projectState.project,
    chapterPlan,
    historyPacket: resources.historyPacket,
    foreshadowingAdvice: resources.foreshadowingAdvice,
    researchPacket: resources.researchPacket,
    styleGuideText: resources.styleGuideText,
    characterStates: resources.currentCharacterStates,
    foreshadowingRegistry: bundle.foreshadowingRegistry,
    chapterMetas: resources.chapterMetas,
    factContext: resources.factContext,
  };
  const rewriteContext = {
    provider,
    project: projectState.project,
    chapterPlan,
    historyPacket: resources.historyPacket,
    foreshadowingSummary: resources.foreshadowingSummary,
    characterStateSummary: resources.characterStateSummary,
    sceneBeatSummary: resources.sceneBeatSummary,
    researchPacket: resources.researchPacket,
    referencePacket: resources.referencePacket,
    openingReferencePacket: resources.openingReferencePacket,
    writerContextPacket: resources.writerContext,
    governance: resources.governance,
    characterDossiers: resources.characterDossiers,
    styleGuideText: resources.styleGuideText,
    factContext: resources.factContext,
  };

  let chapterDraft = await generateChapterDraftText({
    ...rewriteContext,
    revisionNotes: [],
    mode: "draft",
  });
  let validation = await rerunChapterAuditWithContext(auditContext, chapterDraft);

  run.steps.push(
    step(
      "writer_agent",
      "WriterAgent",
      "write",
      "根据章节执行摘要、Writer 上下文包、章纲与历史衔接产出章节草稿。",
      { preview: createExcerpt(chapterDraft.markdown, 200) },
    ),
  );

  const postProcessResult = await runChapterPostProcessing({
    chapterDraft,
    validation,
    auditContext,
    rewriteContext,
    stepPrefix: "writer_revision",
    styleRepairStepId: "writer_style_repair",
  });
  chapterDraft = postProcessResult.chapterDraft;
  validation = postProcessResult.validation;
  const repairResult = postProcessResult.repairResult;
  run.steps.push(...postProcessResult.steps);

  const manualReviewRequired = repairResult.manualReviewRequired;
  const manualReviewStrategy = repairResult.manualReviewStrategy;
  const canonFactIssues = repairResult.canonFactIssues;
  const blockingAuditIssues = repairResult.blockingAuditIssues;

  if (manualReviewRequired) {
    run.steps.push(
      step(
        manualReviewStrategy,
        manualReviewAgentLabel(manualReviewStrategy),
        "write",
        manualReviewSummary(manualReviewStrategy),
        { preview: createExcerpt(blockingAuditIssues.join("；"), 180) },
      ),
    );
  } else {
    ensureChapterValidationPassed(chapterPlan, validation);
  }

  const derivedState = buildDerivedChapterStateArtifacts({
    currentCharacterStates: resources.currentCharacterStates,
    chapterPlan,
    project: projectState.project,
    chapterDraft,
    worldStateBase: bundle.worldState,
    structureData: bundle.structureData,
    foreshadowingRegistryBase: bundle.foreshadowingRegistry,
  });

  run.steps.push(
    step(
      "audit_heuristics",
      "AuditHeuristics",
      "write",
      `启发式检查后得到 critical ${validation.issueCounts.critical} / warning ${validation.issueCounts.warning} / info ${validation.issueCounts.info}。`,
    ),
    step(
      "audit_orchestrator",
      "AuditOrchestrator",
      "write",
      validation.semanticAudit?.source !== "heuristics_only"
        ? validation.summary
        : `AuditOrchestrator 不可用，当前仅依赖启发式审计。${validation.summary}`,
      validation.semanticAudit?.error
        ? { preview: createExcerpt(validation.semanticAudit.error, 180) }
        : {},
    ),
    step(
      "audit_drift",
      "AuditDriftWriter",
      "write",
      createExcerpt(validation.auditDrift?.markdown || "", 180),
    ),
    step(
      "state_update_agent",
      "StateUpdateAgent",
      "write",
      "生成章节元数据，并更新人物状态、世界状态与伏笔注册表。",
    ),
  );

  await store.stageChapterDraft({
    chapterId: chapterPlan.chapterId,
    chapterPlan,
    chapterOutlineContext: outlineArtifacts?.chapterOutlineContext || {},
    chapterOutlineCandidates: outlineArtifacts?.chapterOutlineCandidates || [],
    chapterOutlineHistory: outlineArtifacts?.chapterOutlineHistory || [],
    selectedChapterOutline: outlineArtifacts?.selectedChapterOutline || null,
    chapterMarkdown: chapterDraft.markdown,
    sceneDrafts: chapterDraft.sceneDrafts,
    researchPacket: resources.researchPacket,
    referencePacket: resources.referencePacket,
    openingReferencePacket: resources.openingReferencePacket,
    validation,
    auditDrift: validation.auditDrift,
    chapterMeta: derivedState.chapterMeta,
    characterStates: derivedState.characterStates,
    worldState: derivedState.worldState,
    foreshadowingRegistry: derivedState.foreshadowingRegistry,
    retrieval: resources.historyPacket,
    historyContext: resources.historyPacket,
    planContext: resources.planContext,
    writerContext: resources.writerContext,
    chapterIntent: resources.governance.chapterIntent,
    contextPackage: resources.governance.contextPackage,
    ruleStack: resources.governance.ruleStack,
    contextTrace: resources.governance.contextTrace,
    factContext: resources.factContext,
    providerSnapshot: provider.settings,
    auditDegraded: Boolean(validation?.auditDegraded),
    repairHistory: repairResult.repairHistory,
    lastUnresolvedCriticals: repairResult.lastUnresolvedCriticals,
    reviewState: {
      mode: "initial",
      strategy: manualReviewRequired ? manualReviewStrategy : "chapter_generation",
      manualReviewRequired,
      auditDegraded: Boolean(validation?.auditDegraded),
      auditAutoRepairAttempts: repairResult.auditAutoRepairAttempts,
      canonFactAutoRepairAttempts: repairResult.canonFactAutoRepairAttempts,
      feedbackSupervisionPassed: true,
      feedbackSupervisionSummary: "",
      feedbackSupervisionAttempts: 0,
      feedbackSupervisionHistory: [],
      blockingFeedbackIssues: [],
      blockingAuditIssues,
      canonFactIssues,
      repairHistory: repairResult.repairHistory,
      lastUnresolvedCriticals: repairResult.lastUnresolvedCriticals,
      repairStagnated: repairResult.stagnated,
    },
    rewriteHistory: existingRewriteHistory,
  });

  projectState.phase.write = {
    ...projectState.phase.write,
    status: WRITE_STATUS.CHAPTER_PENDING_REVIEW,
    pendingReview: {
      target: REVIEW_TARGETS.CHAPTER,
      chapterId: chapterPlan.chapterId,
      chapterNumber,
      requestedAt: nowIso(),
      runId: run.id,
    },
    lastRunId: run.id,
    rejectionNotes: manualReviewRequired ? blockingAuditIssues : [],
    rewriteHistory: existingRewriteHistory,
  };

  run.finishedAt = nowIso();
  run.summary = manualReviewRequired
    ? manualReviewStrategy === "canon_fact_manual_review"
      ? `第 ${chapterNumber} 章正文草稿存在未解决的 canon facts 冲突，已停止自动修正并进入人工审核。`
      : manualReviewStrategy === "feedback_manual_review"
        ? `第 ${chapterNumber} 章正文草稿在人类反馈监督后仍有未落实项，已进入人工复审。`
      : `第 ${chapterNumber} 章正文草稿在自动修正后仍未通过审计，已进入人工审核。`
    : `第 ${chapterNumber} 章正文草稿已生成，等待人类审查。`;
  run.validation = validationSummary(validation);

  const savedProject = await store.saveProject(projectState);
  await store.saveRun(run);
  return {
    project: savedProject,
    run,
  };
}

async function stageChapterOutlineReview({
  store,
  provider,
  mcpManager,
  projectState,
  bundle,
  chapterNumber,
  outlineOptions = null,
  feedback = "",
  previousDraft = null,
}) {
  const resources = await prepareChapterOutlineResources({
    store,
    provider,
    project: projectState.project,
    bundle,
    chapterNumber,
    outlineOptions,
  });

  const chapterOutlineHistory = [
    ...((previousDraft?.chapterOutlineHistory || [])),
  ];
  const candidates = await generateChapterOutlineCandidates({
    provider,
    project: projectState.project,
    bundle,
    chapterBase: resources.chapterBase,
    outlineOptions: resources.outlineOptions,
    stagePlanning: resources.chapterOutlineContext.stagePlanning,
    characterPlanning: resources.chapterOutlineContext.characterPlanning,
    historyPlanning: resources.chapterOutlineContext.historyPlanning,
    continuityPlanning: resources.chapterOutlineContext.continuityPlanning,
    foreshadowingActions: resources.foreshadowingActions,
    styleGuideText: resources.styleGuideText,
    openingReferencePacket: resources.openingReferencePacket,
    legacyPlan: resources.legacyPlan,
    feedback,
    previousHistory: chapterOutlineHistory,
  });

  const historyEntry = {
    at: nowIso(),
    action: previousDraft ? "regenerate" : "generate",
    chapterId: resources.chapterBase.chapterId,
    chapterNumber,
    feedback,
    outlineOptions: resources.outlineOptions,
    proposalIds: candidates.map((item) => item.proposalId),
  };
  chapterOutlineHistory.push(historyEntry);

  const run = {
    id: runId("write"),
    phase: "write",
    startedAt: nowIso(),
    finishedAt: nowIso(),
    target: REVIEW_TARGETS.CHAPTER_OUTLINE,
    chapterId: resources.chapterBase.chapterId,
    steps: buildChapterOutlinePreparationSteps(resources, candidates),
    summary: `${resources.chapterBase.chapterId} 的章节细纲候选已生成，等待作者选择或组合。`,
  };

  await store.stageChapterDraft({
    chapterId: resources.chapterBase.chapterId,
    chapterPlan: resources.chapterBase,
    chapterOutlineContext: resources.chapterOutlineContext,
    chapterOutlineCandidates: candidates,
    chapterOutlineHistory,
    selectedChapterOutline: null,
    chapterMarkdown: "",
    sceneDrafts: [],
    validation: null,
    openingReferencePacket: resources.openingReferencePacket,
    worldState: bundle.worldState,
    characterStates: resources.currentCharacterStates,
    foreshadowingRegistry: bundle.foreshadowingRegistry,
    retrieval: historyContextFromDraft(previousDraft),
    historyContext: historyContextFromDraft(previousDraft),
    planContext: previousDraft?.planContext || {},
    writerContext: previousDraft?.writerContext || {},
    chapterIntent: previousDraft?.chapterIntent || {},
    contextPackage: previousDraft?.contextPackage || {},
    ruleStack: previousDraft?.ruleStack || {},
    contextTrace: previousDraft?.contextTrace || previousDraft?.trace || {},
    factContext: resources.factContext,
    providerSnapshot: provider.settings,
    reviewState: {
      mode: "outline_review",
      target: REVIEW_TARGETS.CHAPTER_OUTLINE,
      availableProposalIds: candidates.map((item) => item.proposalId),
      outlineOptions: resources.outlineOptions,
      lastFeedback: feedback || "",
    },
    rewriteHistory: previousDraft?.rewriteHistory || [],
  });
  await store.saveRun(run);

  projectState.phase.write = {
    ...projectState.phase.write,
    status: WRITE_STATUS.CHAPTER_OUTLINE_PENDING_REVIEW,
    pendingReview: {
      target: REVIEW_TARGETS.CHAPTER_OUTLINE,
      chapterId: resources.chapterBase.chapterId,
      chapterNumber,
      requestedAt: nowIso(),
      runId: run.id,
    },
    lastRunId: run.id,
    rejectionNotes: feedback ? [feedback] : [],
  };

  const savedProject = await store.saveProject(projectState);
  return {
    project: savedProject,
    run,
  };
}

export async function runWriteChapter(store, options = {}) {
  const projectState = await store.loadProject();
  const provider = createProvider(projectState, { rootDir: store.paths.configRootDir });
  const mcpManager = getWorkspaceMcpManager({
    rootDir: store.paths.workspaceRoot || store.paths.configRootDir,
    configRootDir: store.paths.configRootDir,
  });
  if (projectState.phase.plan.status !== PLAN_STATUS.LOCKED) {
    throw new Error("大纲尚未锁定，不能进入 Write 阶段。");
  }
  const pendingWriteReview = projectState.phase.write.pendingReview;
  const isLegacyBriefPending =
    pendingWriteReview?.target === "writing_brief" && pendingWriteReview?.chapterId;

  if (pendingWriteReview?.chapterId && !isLegacyBriefPending) {
    throw new Error("当前已有待审写作节点，请先完成审查。");
  }

  const bundle = await loadCommittedPlanBundle(store);
  if (!bundle) {
    throw new Error("缺少已锁定的大纲 bundle.json。");
  }

  if (isLegacyBriefPending) {
    const draftBundle = await store.loadChapterDraft(pendingWriteReview.chapterId);
    const chapterPlan =
      draftBundle?.chapterPlan ||
      bundle.structureData.chapters.find((item) => item.chapterId === pendingWriteReview.chapterId);
    if (!chapterPlan) {
      throw new Error(`找不到 ${pendingWriteReview.chapterId} 对应的章纲。`);
    }

    return generateChapterDraft({
      store,
      provider,
      mcpManager,
      projectState,
      bundle,
      chapterPlan,
      chapterNumber: pendingWriteReview.chapterNumber || chapterPlan.chapterNumber,
      existingRewriteHistory: draftBundle?.rewriteHistory || [],
    });
  }

  const chapterNumber =
    options.chapterNumber ||
    Number(projectState.phase.write.currentChapterNumber || 0) + 1;
  return stageChapterOutlineReview({
    store,
    provider,
    mcpManager,
    projectState,
    bundle,
    chapterNumber,
    outlineOptions: options.outlineOptions || null,
    feedback: "",
    previousDraft: null,
  });
}

export async function reviewChapter(
  store,
  {
    target = "",
    approved,
    feedback,
    reviewAction = approved ? "approve" : "rewrite",
    approvalOverrideAcknowledged = false,
    selectedProposalId = "",
    selectedSceneRefs = [],
    authorNotes = "",
    outlineOptions = null,
    sceneIds = [],
    sceneOrder = [],
    selection = null,
  },
) {
  const projectState = await store.loadProject();
  const pending = projectState.phase.write.pendingReview;
  if (!pending?.chapterId) {
    throw new Error("当前没有待审章节。");
  }

  const bundle = await loadCommittedPlanBundle(store);
  const draftBundle = await store.loadChapterDraft(pending.chapterId);
  if (!draftBundle) {
    throw new Error("找不到待审章节草稿。");
  }
  const provider = createProvider(projectState, { rootDir: store.paths.configRootDir });
  const mcpManager = getWorkspaceMcpManager({
    rootDir: store.paths.workspaceRoot || store.paths.configRootDir,
    configRootDir: store.paths.configRootDir,
  });
  const pendingTarget = String(pending.target || REVIEW_TARGETS.CHAPTER);
  const requestedTarget = String(target || pendingTarget);
  if (requestedTarget !== pendingTarget) {
    throw new Error(`当前待审节点是 ${pendingTarget}，不能按 ${requestedTarget} 审查。`);
  }
  const normalizedSelectedSceneRefs = Array.isArray(selectedSceneRefs) ? selectedSceneRefs : parseSceneIdList(selectedSceneRefs);
  const normalizedSceneIds = Array.isArray(sceneIds) ? sceneIds : parseSceneIdList(sceneIds);
  const normalizedSceneOrder = Array.isArray(sceneOrder) ? sceneOrder : parseSceneIdList(sceneOrder);
  const normalizedSelection = normalizeChapterSelection(selection);
  const rawReviewAction = String(reviewAction || "").trim();
  if (
    pendingTarget === REVIEW_TARGETS.CHAPTER &&
    !approved &&
    (
      rawReviewAction === "local_rewrite" ||
      rawReviewAction === "structural_rewrite" ||
      normalizedSceneIds.length ||
      normalizedSceneOrder.length
    )
  ) {
    throw new Error("章节审查已切换为整章模式，不再支持 local_rewrite、structural_rewrite、sceneIds 或 sceneOrder。");
  }
  const normalizedReviewAction = normalizeChapterReviewAction(reviewAction, approved);
  const rewriteStrategy = approved
    ? null
    : pendingTarget === REVIEW_TARGETS.CHAPTER
      ? normalizedReviewAction === "partial_rewrite"
        ? "selection_patch"
        : "chapter_rewrite"
      : resolveRewriteStrategy(reviewAction, normalizedSceneIds, normalizedSceneOrder);

  if (
    pendingTarget === REVIEW_TARGETS.CHAPTER &&
    !approved &&
    normalizedReviewAction !== "rewrite" &&
    normalizedReviewAction !== "partial_rewrite"
  ) {
    throw new Error(`未知的章节审查动作：${reviewAction}`);
  }
  if (
    pendingTarget === REVIEW_TARGETS.CHAPTER &&
    !approved &&
    normalizedReviewAction === "partial_rewrite" &&
    !normalizedSelection.selectedText.trim()
  ) {
    throw new Error("局部修订需要先选中一段正文。");
  }

  const approvalOverrideRequired = pendingTarget === REVIEW_TARGETS.CHAPTER &&
    approved &&
    (
      draftBundle?.reviewState?.manualReviewRequired ||
      draftBundle?.validation?.overallPassed === false ||
      draftBundle?.reviewState?.feedbackSupervisionPassed === false
    );
  if (approvalOverrideRequired && !approvalOverrideAcknowledged) {
    throw new Error("当前章节审计尚未通过。若仍要锁章，请先在界面中显式确认 override 风险。");
  }

  const approvalOverrideReason = approvalOverrideRequired
    ? String(feedback || "").trim() || "人工确认在未通过审计的情况下仍然锁章。"
    : "";
  const approvalValidationSnapshot = approvalOverrideRequired
    ? {
      overallPassed: Boolean(draftBundle?.validation?.overallPassed),
      summary: validationSummary(draftBundle?.validation),
      issueCounts: draftBundle?.validation?.issueCounts || { critical: 0, warning: 0, info: 0 },
      manualReviewRequired: Boolean(draftBundle?.reviewState?.manualReviewRequired),
      feedbackSupervisionPassed: draftBundle?.reviewState?.feedbackSupervisionPassed !== false,
      feedbackSupervisionSummary: String(draftBundle?.reviewState?.feedbackSupervisionSummary || "").trim(),
      blockingFeedbackIssues: normalizeFeedbackTextList(draftBundle?.reviewState?.blockingFeedbackIssues, 6),
    }
    : null;

  const review = {
    id: runId("review-chapter"),
    target: pendingTarget,
    approved,
    reviewAction: pendingTarget === REVIEW_TARGETS.CHAPTER_OUTLINE ? String(reviewAction || "").trim() : normalizedReviewAction,
    feedback: feedback || "",
    chapterId: pending.chapterId,
    selectedProposalId: String(selectedProposalId || "").trim(),
    selectedSceneRefs: normalizedSelectedSceneRefs,
    authorNotes: authorNotes || "",
    sceneIds: normalizedSceneIds,
    sceneOrder: normalizedSceneOrder,
    selection: normalizedSelection,
    rewriteStrategy,
    approvalOverride: approvalOverrideRequired,
    approvalOverrideReason,
    approvalValidationSnapshot,
    createdAt: nowIso(),
  };

  await store.saveReview(review);
  projectState.history.reviews = [...(projectState.history.reviews || []), review];

  if (pendingTarget === REVIEW_TARGETS.CHAPTER_OUTLINE) {
    const normalizedOutlineOptions = normalizeOutlineOptions(
      outlineOptions || draftBundle?.reviewState?.outlineOptions || draftBundle?.chapterOutlineContext?.outlineOptions || null,
    );
    if (reviewAction === "regenerate") {
      return stageChapterOutlineReview({
        store,
        provider,
        mcpManager,
        projectState,
        bundle,
        chapterNumber: pending.chapterNumber,
        outlineOptions: normalizedOutlineOptions,
        feedback: feedback || authorNotes || "",
        previousDraft: draftBundle,
      });
    }

    const existingCandidates = Array.isArray(draftBundle.chapterOutlineCandidates) ? draftBundle.chapterOutlineCandidates : [];
    if (!existingCandidates.length) {
      throw new Error("当前没有可供选择的细纲候选。");
    }

    let selectedOutline;
    if (reviewAction === "approve_composed") {
      if (!normalizedSelectedSceneRefs.length) {
        throw new Error("组合定稿时至少需要选择一个 sceneRef。");
      }
      const resources = await prepareChapterOutlineResources({
        store,
        provider,
        project: projectState.project,
        bundle,
        chapterNumber: pending.chapterNumber,
        outlineOptions: normalizedOutlineOptions,
      });
      resources.existingCandidates = existingCandidates;
      const selectedScenes = collectSelectedScenes(existingCandidates, normalizedSelectedSceneRefs);
      if (!selectedScenes.length) {
        throw new Error("选中的 sceneRef 无法在当前候选中找到。");
      }
      try {
        selectedOutline = await finalizeComposedChapterOutline({
          provider,
          project: projectState.project,
          bundle,
          resources,
          selectedScenes,
          authorNotes: authorNotes || feedback || "",
        });
      } catch {
        selectedOutline = buildComposedOutlineFallback({
          bundle,
          resources,
          selectedScenes,
          authorNotes: authorNotes || feedback || "",
        });
      }
    } else {
      const proposal = selectProposalById(existingCandidates, String(selectedProposalId || "").trim());
      if (!proposal) {
        throw new Error("请先选择一个候选方案再批准。");
      }
      selectedOutline = {
        ...proposal,
        chapterPlan: {
          ...proposal.chapterPlan,
          scenes: renumberComposedScenes(pending.chapterId, proposal.chapterPlan.scenes),
        },
      };
    }

    const nextOutlineHistory = [
      ...(draftBundle.chapterOutlineHistory || []),
      {
        at: nowIso(),
        action: reviewAction === "approve_composed" ? "approve_composed" : "approve_single",
        selectedProposalId: String(selectedProposalId || "").trim(),
        selectedSceneRefs: normalizedSelectedSceneRefs,
        authorNotes: authorNotes || "",
        feedback: feedback || "",
      },
    ];
    const selectedChapterOutline = {
      mode: reviewAction === "approve_composed" ? "composed" : "single",
      selectedProposalId: reviewAction === "approve_composed" ? null : String(selectedProposalId || "").trim(),
      selectedSceneRefs: normalizedSelectedSceneRefs,
      authorNotes: authorNotes || feedback || "",
      chapterPlan: selectedOutline.chapterPlan,
      summary: selectedOutline.summary,
      rationale: selectedOutline.rationale,
      diffSummary: selectedOutline.diffSummary,
    };

    return generateChapterDraft({
      store,
      provider,
      mcpManager,
      projectState,
      bundle,
      chapterPlan: selectedOutline.chapterPlan,
      chapterNumber: pending.chapterNumber,
      existingRewriteHistory: [],
      outlineArtifacts: {
        chapterOutlineContext: draftBundle.chapterOutlineContext || {},
        chapterOutlineCandidates: existingCandidates,
        chapterOutlineHistory: nextOutlineHistory,
        selectedChapterOutline,
      },
    });
  }

  if (approved) {
    await store.commitChapterDraft(pending.chapterId);

    let factExtractionWarning = "";
    try {
      const facts = await runChapterFactExtractionAgent({
        provider,
        project: projectState.project,
        chapterPlan: draftBundle.chapterPlan,
        chapterDraft: { markdown: draftBundle.chapterMarkdown || "" },
      });
      await saveChapterFacts(store, pending.chapterId, facts);
      await appendFactsToLedger(store, pending.chapterId, facts);
    } catch (error) {
      factExtractionWarning = ` Canon facts 提取失败：${createExcerpt(error instanceof Error ? error.message : String(error || ""), 180)}`;
    }

    if (pending.chapterNumber === 1 && !String(projectState.project?.styleFingerprintId || "").trim()) {
      const styleGuide = buildStyleGuide(projectState.project, {
        markdown: draftBundle.chapterMarkdown,
      });
      await store.writeText(path.join(store.paths.novelStateDir, "style_guide.md"), styleGuide);
    }

    const committedBundle = {
      ...bundle,
      structureData: {
        ...bundle.structureData,
        chapters: bundle.structureData.chapters.map((chapter) =>
          chapter.chapterId === draftBundle.chapterPlan?.chapterId ? draftBundle.chapterPlan : chapter,
        ),
      },
      worldState: draftBundle.worldState,
      foreshadowingRegistry: draftBundle.foreshadowingRegistry,
    };
    await store.writeJson(path.join(store.paths.novelStateDir, "bundle.json"), committedBundle);

    projectState.phase.write = {
      ...projectState.phase.write,
      status: WRITE_STATUS.IDLE,
      pendingReview: null,
      currentChapterNumber: pending.chapterNumber,
      rejectionNotes: [],
      rewriteHistory: [],
    };

    const savedProject = await store.saveProject(projectState);
    return {
      project: savedProject,
      run: null,
      summary: `${pending.chapterId} 已${approvalOverrideRequired ? "在显式 override 后" : ""}锁定，可继续生成下一章。${factExtractionWarning}`,
    };
  }

  const chapterPlanBase =
    draftBundle.chapterPlan ||
    bundle.structureData.chapters.find((item) => item.chapterId === pending.chapterId);
  const currentCharacterStates = await loadCurrentCharacterStates(store, bundle);
  const focusedCharacterStates = currentCharacterStates.filter((state) =>
    chapterPlanBase.charactersPresent.includes(state.name),
  );
  const characterDossiers = buildCharacterDossiers(bundle, chapterPlanBase, currentCharacterStates);
  const foreshadowingAdvice = collectForeshadowingAdvice(bundle.foreshadowingRegistry, chapterPlanBase);
  const researchPacket = researchPacketFromDraft(draftBundle);
  const referencePacket = referencePacketFromDraft(draftBundle);
  const openingReferencePacket = openingReferencePacketFromDraft(draftBundle);
  const { styleGuideText, styleGuideSourcePath } = await resolveStyleBaseline(store, projectState.project, chapterPlanBase);
  const chapterMetas = await store.listChapterMeta();
  const rewriteHistory = [...(draftBundle.rewriteHistory || []), {
    at: nowIso(),
    mode: normalizedReviewAction,
    strategy: rewriteStrategy,
    feedback: feedback || "",
    sceneIds: normalizedSceneIds,
    sceneOrder: normalizedSceneOrder,
    selectionPreview: normalizedReviewAction === "partial_rewrite"
      ? createExcerpt(normalizedSelection.selectedText, 120)
      : "",
  }];
  const currentRewriteHistoryEntry = rewriteHistory.at(-1);
  const historyPacket = historyContextFromDraft(draftBundle);
  const writerContext = writerContextFromDraft(draftBundle);
  const governance = governanceFromDraft(draftBundle, chapterPlanBase);
  const foreshadowingSummary = summarizeForeshadowingAdvice(foreshadowingAdvice, chapterPlanBase);
  const characterStateSummary = summarizeCharacterStates(focusedCharacterStates);
  const sceneBeatSummary = summarizeSceneBeats(chapterPlanBase);

  if (normalizedReviewAction === "partial_rewrite") {
    const factContext = draftBundle?.factContext || null;
    const originalMarkdown = String(draftBundle.chapterMarkdown || "");
    const originalParts = splitChapterMarkdown(originalMarkdown, chapterPlanBase.title);
    const anchoredRange = locateSelectedText(originalParts.body, normalizedSelection);
    let feedbackSupervisionAttempts = 0;
    const feedbackSupervisionHistory = [];
    const partialRewriteSteps = [];
    let latestChangedFragment = "";
    let latestFeedbackResult = createFeedbackSupervisionResult();

    for (let attempt = 1; attempt <= MAX_AUDIT_AUTO_REPAIR_ATTEMPTS; attempt += 1) {
      const revisionFeedback = [
        feedback || "",
        ...(attempt > 1 ? normalizeFeedbackTextList(latestFeedbackResult.revisionNotes, 6) : []),
      ];
      const replacementFragment = await generateChapterPartialRevisionText({
        provider,
        project: projectState.project,
        chapterPlan: chapterPlanBase,
        historyPacket,
        foreshadowingSummary,
        characterStateSummary,
        sceneBeatSummary,
        researchPacket,
        referencePacket,
        openingReferencePacket,
        writerContextPacket: writerContext,
        governance,
        characterDossiers,
        styleGuideText,
        feedback: revisionFeedback.filter(Boolean).join("\n"),
        selection: normalizedSelection,
        currentDraftMarkdown: originalMarkdown,
        factContext,
      });

      if (!replacementFragment) {
        throw new Error(attempt === 1 ? "RevisionAgent 未返回可用的替换片段。" : "RevisionAgent 重试后仍未返回可用的替换片段。");
      }

      const changedFragment = fragmentChanged(normalizedSelection.selectedText, replacementFragment);
      if (changedFragment) {
        latestChangedFragment = replacementFragment;
      }

      partialRewriteSteps.push(
        step(
          attempt === 1 ? "partial_rewrite" : attempt === 2 ? "partial_rewrite_retry" : `partial_rewrite_retry_${attempt - 1}`,
          attempt === 1 ? "RevisionAgent" : `RevisionAgent Retry ${attempt - 1}`,
          "write",
          attempt === 1
            ? "只针对用户选中的正文片段生成替换内容。"
            : "上一轮片段仍未完全满足要求，已在同一选区内继续重写。",
          {
            preview: createExcerpt(replacementFragment, 120),
          },
        ),
      );

      latestFeedbackResult = await runFeedbackSupervisorAgent({
        provider,
        project: projectState.project,
        chapterPlan: chapterPlanBase,
        feedback: feedback || "",
        mode: "partial_rewrite",
        candidateText: replacementFragment,
        selection: normalizedSelection,
        currentDraftMarkdown: originalMarkdown,
      });
      if (!changedFragment) {
        latestFeedbackResult = createFeedbackSupervisionResult({
          ...latestFeedbackResult,
          enabled: true,
          passed: false,
          summary: latestFeedbackResult.summary || "候选替换片段与原选区没有实质差异，仍未落实作者反馈。",
          missingItems: uniqueTextNotes([
            ...latestFeedbackResult.missingItems,
            "当前候选片段没有对选区做出实质改写。",
          ]),
          revisionNotes: uniqueTextNotes([
            ...latestFeedbackResult.revisionNotes,
            "硬性要求：这次只能输出新的替换片段，不能原样重复选中的原文；即使保留原意，也必须实质改写句式、信息落点或节奏，并明确落实修改要求。",
          ]),
          evidence: latestFeedbackResult.evidence || normalizedSelection.selectedText,
          scopeBlocked: false,
        });
      }

      feedbackSupervisionAttempts += 1;
      feedbackSupervisionHistory.push(buildFeedbackSupervisionHistoryEntry(latestFeedbackResult));
      partialRewriteSteps.push(
        step(
          `partial_feedback_supervision_${attempt}`,
          "FeedbackSupervisorAgent",
          "write",
          latestFeedbackResult.passed
            ? "反馈监督通过：当前替换片段已落实作者反馈。"
            : latestFeedbackResult.scopeBlocked
              ? "反馈监督判断当前反馈无法在既定选区内完整完成，已停止自动修订。"
              : "反馈监督发现当前替换片段仍未完整落实作者反馈，已生成下一轮 revision notes。",
          {
            preview: createExcerpt(
              latestFeedbackResult.passed
                ? latestFeedbackResult.summary || "作者反馈已落实。"
                : buildBlockingFeedbackIssues(latestFeedbackResult).join("；") || latestFeedbackResult.summary,
              160,
            ),
          },
        ),
      );

      if (changedFragment && latestFeedbackResult.passed) {
        break;
      }
      if (latestFeedbackResult.scopeBlocked) {
        break;
      }
    }

    const fragmentToApply = latestChangedFragment || normalizedSelection.selectedText;
    const replacedMarkdown = replaceSelectionInChapterMarkdown(
      originalMarkdown,
      normalizedSelection,
      fragmentToApply,
      chapterPlanBase.title,
    );
    const revisedDraft = chapterDraftFromExactMarkdown(
      chapterPlanBase,
      composeChapterMarkdown(replacedMarkdown.title, replacedMarkdown.body),
    );
    const validation = await runChapterAudit({
      store,
      provider,
      project: projectState.project,
      chapterPlan: chapterPlanBase,
      chapterDraft: revisedDraft,
      historyPacket,
      foreshadowingAdvice,
      researchPacket,
      styleGuideText,
      characterStates: currentCharacterStates,
      foreshadowingRegistry: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
      chapterMetas,
      factContext,
    });

    const rewrittenState = buildDerivedChapterStateArtifacts({
      currentCharacterStates,
      chapterPlan: chapterPlanBase,
      project: projectState.project,
      chapterDraft: revisedDraft,
      worldStateBase: bundle.worldState,
      structureData: bundle.structureData,
      foreshadowingRegistryBase: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
    });

    const feedbackSupervisionPassed = !latestFeedbackResult.enabled || latestFeedbackResult.passed;
    const blockingFeedbackIssues = buildBlockingFeedbackIssues(latestFeedbackResult);
    const blockingAuditIssues = buildBlockingAuditReviewPayload(validation, factContext).blockingAuditIssues;
    const manualReviewRequired = !validation?.overallPassed || !feedbackSupervisionPassed;
    const manualReviewStrategy = manualReviewRequired
      ? (feedbackSupervisionPassed ? manualReviewStrategyFromValidation(validation) : "feedback_manual_review")
      : "selection_patch";

    if (currentRewriteHistoryEntry) {
      currentRewriteHistoryEntry.feedbackSupervisionPassed = feedbackSupervisionPassed;
      currentRewriteHistoryEntry.feedbackSupervisionSummary = latestFeedbackResult.summary || "";
      currentRewriteHistoryEntry.feedbackSupervisionAttempts = feedbackSupervisionAttempts;
      currentRewriteHistoryEntry.blockingFeedbackIssues = blockingFeedbackIssues;
    }

    await store.stageChapterDraft({
      ...draftBundle,
      chapterPlan: chapterPlanBase,
      chapterMarkdown: revisedDraft.markdown,
      sceneDrafts: [],
      researchPacket,
      referencePacket,
      openingReferencePacket,
      validation,
      auditDrift: validation.auditDrift,
      chapterMeta: rewrittenState.chapterMeta,
      characterStates: rewrittenState.characterStates,
      worldState: rewrittenState.worldState,
      foreshadowingRegistry: rewrittenState.foreshadowingRegistry,
      retrieval: historyPacket,
      historyContext: historyPacket,
      planContext: draftBundle.planContext || {},
      writerContext,
      chapterIntent: governance.chapterIntent,
      contextPackage: governance.contextPackage,
      ruleStack: governance.ruleStack,
      contextTrace: governance.contextTrace,
      factContext,
      auditDegraded: Boolean(validation?.auditDegraded),
      repairHistory: draftBundle?.repairHistory || [],
      lastUnresolvedCriticals: unresolvedCriticalIssueSummaries(validation),
      reviewState: {
        mode: "partial_rewrite",
        strategy: manualReviewRequired ? manualReviewStrategy : "selection_patch",
        lastFeedback: feedback || "",
        selectionPreview: createExcerpt(normalizedSelection.selectedText, 120),
        selection: normalizedSelection,
        manualReviewRequired,
        manualReviewStrategy: manualReviewRequired ? manualReviewStrategy : "",
        auditDegraded: Boolean(validation?.auditDegraded),
        feedbackSupervisionPassed,
        feedbackSupervisionSummary: latestFeedbackResult.summary || "",
        feedbackSupervisionAttempts,
        feedbackSupervisionHistory,
        blockingFeedbackIssues,
        blockingAuditIssues,
        lastUnresolvedCriticals: unresolvedCriticalIssueSummaries(validation),
      },
      rewriteHistory,
    });

    const rewriteRun = {
      id: runId("write"),
      phase: "write",
      startedAt: nowIso(),
      finishedAt: nowIso(),
      target: REVIEW_TARGETS.CHAPTER,
      chapterId: pending.chapterId,
      summary: manualReviewRequired
        ? manualReviewStrategy === "feedback_manual_review"
          ? `${pending.chapterId} 局部修订后仍有未落实的人类反馈，已进入人工复审。`
          : `${pending.chapterId} 局部修订后仍有未解决审计问题，已进入人工复审。`
        : `${pending.chapterId} 已完成局部修订并回到待审状态。`,
      steps: [
        ...partialRewriteSteps,
        ...(manualReviewRequired
          ? [
              step(
                manualReviewStrategy,
                manualReviewAgentLabel(manualReviewStrategy),
                "write",
                manualReviewSummary(manualReviewStrategy),
                {
                  preview: createExcerpt(
                    (
                      manualReviewStrategy === "feedback_manual_review"
                        ? blockingFeedbackIssues
                        : blockingAuditIssues
                    ).join("；"),
                    160,
                  ),
                },
              ),
            ]
          : []),
        step(
          "partial_rewrite_validation",
          "Validation",
          "write",
          validationSummary(validation),
          {
            preview: createExcerpt(feedback || "", 120),
          },
        ),
      ],
    };
    await store.saveRun(rewriteRun);

    projectState.phase.write = {
      ...projectState.phase.write,
      status: WRITE_STATUS.CHAPTER_PENDING_REVIEW,
      pendingReview: {
        ...pending,
        requestedAt: nowIso(),
        runId: rewriteRun.id,
      },
      rejectionNotes: manualReviewRequired
        ? uniqueTextNotes([
          ...(manualReviewStrategy === "feedback_manual_review" ? blockingFeedbackIssues : []),
          ...(manualReviewStrategy === "feedback_manual_review" ? [] : blockingAuditIssues),
        ])
        : [feedback].filter(Boolean),
      rewriteHistory,
    };
    const savedProject = await store.saveProject(projectState);
    return {
      project: savedProject,
      run: rewriteRun,
      summary: manualReviewRequired
        ? manualReviewStrategy === "feedback_manual_review"
          ? `${pending.chapterId} 已完成局部修订，但反馈仍未完整落实，需要人工确认。`
          : `${pending.chapterId} 已完成局部修订，但审计仍未通过，需要人工确认。`
        : `${pending.chapterId} 已完成局部修订，替换了正文中的选中片段 ${anchoredRange.occurrenceCount > 1 ? "（已通过锚点唯一定位）" : ""}，等待再次审查。`,
    };
  }

  const originalMarkdown = String(draftBundle.chapterMarkdown || "");
  let rewriteRetried = false;
  let rewrittenDraft = await generateChapterDraftText({
    provider,
    project: projectState.project,
    chapterPlan: chapterPlanBase,
    historyPacket,
    foreshadowingSummary,
    characterStateSummary,
    sceneBeatSummary,
    researchPacket,
    referencePacket,
    openingReferencePacket,
    writerContextPacket: writerContext,
    governance,
    characterDossiers,
    styleGuideText,
    revisionNotes: [feedback].filter(Boolean),
    mode: "rewrite",
    currentDraft: {
      markdown: originalMarkdown,
    },
    factContext: draftBundle?.factContext || null,
  });
  const factContext = draftBundle?.factContext || null;

  if (!chapterBodyChanged(originalMarkdown, rewrittenDraft.markdown, chapterPlanBase.title)) {
    rewriteRetried = true;
    rewrittenDraft = await generateChapterDraftText({
      provider,
      project: projectState.project,
      chapterPlan: chapterPlanBase,
      historyPacket,
      foreshadowingSummary,
      characterStateSummary,
      sceneBeatSummary,
      researchPacket,
      referencePacket,
      openingReferencePacket,
      writerContextPacket: writerContext,
      governance,
      characterDossiers,
      styleGuideText,
      revisionNotes: [
        feedback,
        "硬性要求：这次必须输出与待修正文实质不同的新版本，不能原样复述现有草稿；至少要明显改写句式、段落节奏或表达，并落实作者反馈。",
      ].filter(Boolean),
      mode: "rewrite",
      currentDraft: {
        markdown: originalMarkdown,
      },
      factContext: draftBundle?.factContext || null,
    });
  }

  if (!chapterBodyChanged(originalMarkdown, rewrittenDraft.markdown, chapterPlanBase.title)) {
    throw new Error("整章重写未产生有效改动，请把反馈写得更具体一些后重试。");
  }

  const auditContext = {
    store,
    provider,
    project: projectState.project,
    chapterPlan: chapterPlanBase,
    historyPacket,
    foreshadowingAdvice,
    researchPacket,
    styleGuideText,
    characterStates: currentCharacterStates,
    foreshadowingRegistry: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
    chapterMetas,
    factContext,
  };
  const rewriteContext = {
    provider,
    project: projectState.project,
    chapterPlan: chapterPlanBase,
    historyPacket,
    foreshadowingSummary,
    characterStateSummary,
    sceneBeatSummary,
    researchPacket,
    referencePacket,
    openingReferencePacket,
    writerContextPacket: writerContext,
    governance,
    characterDossiers,
    styleGuideText,
    factContext: draftBundle?.factContext || null,
  };

  let validation = await rerunChapterAuditWithContext(auditContext, rewrittenDraft);
  const postProcessResult = await runChapterPostProcessing({
    chapterDraft: rewrittenDraft,
    validation,
    auditContext,
    rewriteContext,
    stepPrefix: "rewrite_validation_repair",
    styleRepairStepId: "rewrite_style_repair",
    feedbackSupervisor: {
      enabled: true,
      provider,
      project: projectState.project,
      chapterPlan: chapterPlanBase,
      feedback: feedback || "",
      mode: "rewrite",
    },
  });
  rewrittenDraft = postProcessResult.chapterDraft;
  validation = postProcessResult.validation;
  const repairResult = postProcessResult.repairResult;

  const manualReviewRequired = repairResult.manualReviewRequired;
  const manualReviewStrategy = repairResult.manualReviewStrategy;
  const canonFactIssues = repairResult.canonFactIssues;
  const blockingAuditIssues = repairResult.blockingAuditIssues;
  const blockingFeedbackIssues = repairResult.blockingFeedbackIssues;

  if (currentRewriteHistoryEntry) {
    currentRewriteHistoryEntry.feedbackSupervisionPassed = repairResult.feedbackSupervisionPassed;
    currentRewriteHistoryEntry.feedbackSupervisionSummary = repairResult.feedbackSupervisionSummary;
    currentRewriteHistoryEntry.feedbackSupervisionAttempts = repairResult.feedbackSupervisionAttempts;
    currentRewriteHistoryEntry.blockingFeedbackIssues = blockingFeedbackIssues;
  }

  if (!manualReviewRequired) {
    ensureChapterValidationPassed(chapterPlanBase, validation);
  }

  const rewrittenState = buildDerivedChapterStateArtifacts({
    currentCharacterStates,
    chapterPlan: chapterPlanBase,
    project: projectState.project,
    chapterDraft: rewrittenDraft,
    worldStateBase: bundle.worldState,
    structureData: bundle.structureData,
    foreshadowingRegistryBase: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
  });

  await store.stageChapterDraft({
    ...draftBundle,
    chapterPlan: chapterPlanBase,
    chapterMarkdown: rewrittenDraft.markdown,
    sceneDrafts: [],
    researchPacket,
    referencePacket,
    openingReferencePacket,
    validation,
    auditDrift: validation.auditDrift,
    chapterMeta: rewrittenState.chapterMeta,
    characterStates: rewrittenState.characterStates,
    worldState: rewrittenState.worldState,
    foreshadowingRegistry: rewrittenState.foreshadowingRegistry,
    retrieval: historyPacket,
    historyContext: historyPacket,
    planContext: draftBundle.planContext || {},
    writerContext,
    chapterIntent: governance.chapterIntent,
    contextPackage: governance.contextPackage,
    ruleStack: governance.ruleStack,
    contextTrace: governance.contextTrace,
    factContext,
    auditDegraded: Boolean(validation?.auditDegraded),
    repairHistory: repairResult.repairHistory,
    lastUnresolvedCriticals: repairResult.lastUnresolvedCriticals,
    reviewState: {
      mode: "rewrite",
      strategy: manualReviewRequired ? manualReviewStrategy : rewriteStrategy,
      lastFeedback: feedback || "",
      manualReviewRequired,
      manualReviewStrategy: manualReviewRequired ? manualReviewStrategy : "",
      auditDegraded: Boolean(validation?.auditDegraded),
      auditAutoRepairAttempts: repairResult.auditAutoRepairAttempts,
      canonFactAutoRepairAttempts: repairResult.canonFactAutoRepairAttempts,
      feedbackSupervisionPassed: repairResult.feedbackSupervisionPassed,
      feedbackSupervisionSummary: repairResult.feedbackSupervisionSummary,
      feedbackSupervisionAttempts: repairResult.feedbackSupervisionAttempts,
      feedbackSupervisionHistory: repairResult.feedbackSupervisionHistory,
      blockingFeedbackIssues,
      blockingAuditIssues,
      canonFactIssues,
      repairHistory: repairResult.repairHistory,
      lastUnresolvedCriticals: repairResult.lastUnresolvedCriticals,
      repairStagnated: repairResult.stagnated,
    },
    rewriteHistory,
  });

  const rewriteRun = {
    id: runId("write"),
    phase: "write",
    startedAt: nowIso(),
    finishedAt: nowIso(),
    target: REVIEW_TARGETS.CHAPTER,
    chapterId: pending.chapterId,
      summary: manualReviewRequired
        ? manualReviewStrategy === "canon_fact_manual_review"
          ? `${pending.chapterId} 重写后仍存在未解决的 canon facts 冲突，已停止自动修正并进入人工审核。`
          : manualReviewStrategy === "feedback_manual_review"
            ? `${pending.chapterId} 重写后仍有未落实的人类反馈，已进入人工复审。`
          : `${pending.chapterId} 重写后在自动修正后仍未通过审计，已进入人工审核。`
        : `${pending.chapterId} 已根据人类反馈重写并回到待审状态。`,
      steps: [
        step(
        "rewrite",
        "WriterAgent",
        "write",
        "根据人类反馈重写整章。",
        { preview: createExcerpt(feedback || "", 160) },
      ),
      ...(rewriteRetried
        ? [
            step(
              "rewrite_retry",
              "WriterAgent Retry",
              "write",
              "首次返回与原稿无实质差异，已自动追加强约束后重写一次。",
              {
                preview: createExcerpt(feedback || "", 160),
              },
            ),
          ]
        : []),
      ...(postProcessResult.steps || []),
      ...(manualReviewRequired
        ? [
            step(
              manualReviewStrategy,
              manualReviewAgentLabel(manualReviewStrategy),
              "write",
              manualReviewSummary(manualReviewStrategy),
              {
                preview: createExcerpt(
                  (
                    manualReviewStrategy === "feedback_manual_review"
                      ? blockingFeedbackIssues
                      : blockingAuditIssues
                  ).join("；"),
                  160,
                ),
              },
            ),
          ]
        : []),
      step("validation_after_rewrite", "Validation", "write", validationSummary(validation)),
    ],
  };
  await store.saveRun(rewriteRun);

  projectState.phase.write = {
    ...projectState.phase.write,
    status: WRITE_STATUS.CHAPTER_PENDING_REVIEW,
      pendingReview: {
        ...pending,
        requestedAt: nowIso(),
        runId: rewriteRun.id,
      },
      rejectionNotes: manualReviewRequired
        ? uniqueTextNotes([
          ...(manualReviewStrategy === "feedback_manual_review" ? blockingFeedbackIssues : []),
          ...(manualReviewStrategy === "feedback_manual_review" ? [] : blockingAuditIssues),
        ])
        : [feedback].filter(Boolean),
      rewriteHistory,
    };
  const savedProject = await store.saveProject(projectState);
  return {
    project: savedProject,
    run: rewriteRun,
    summary: manualReviewRequired
      ? manualReviewStrategy === "canon_fact_manual_review"
        ? `${pending.chapterId} 已完成重写，但仍有 canon facts 冲突需要人工确认。`
        : manualReviewStrategy === "feedback_manual_review"
          ? `${pending.chapterId} 已完成重写，但反馈仍未完整落实，需要人工确认。`
        : `${pending.chapterId} 已完成重写，但审计仍未通过，需要人工确认。`
      : `${pending.chapterId} 已完成重写，等待再次审查。`,
  };
}

export async function deleteLatestLockedChapter(store, { chapterId = "" } = {}) {
  const projectState = await store.loadProject();
  if (projectState.phase.plan.status !== PLAN_STATUS.LOCKED) {
    throw new Error("大纲尚未锁定，不能删除已锁定章节。");
  }
  if (projectState.phase.write.pendingReview?.chapterId) {
    throw new Error("当前有待审写作节点，请先完成审查后再删除已锁定章节。");
  }

  const chapterMetas = await store.listChapterMeta();
  if (!chapterMetas.length) {
    throw new Error("当前还没有已锁定章节。");
  }

  const latestMeta = chapterMetas.at(-1);
  const latestChapterId = String(latestMeta?.chapter_id || "").trim();
  const requestedChapterId = String(chapterId || "").trim();
  if (requestedChapterId && requestedChapterId !== latestChapterId) {
    throw new Error(`只能删除最新锁定章节 ${latestChapterId}，不能删除 ${requestedChapterId}。`);
  }

  const committedBundle = await loadCommittedPlanBundle(store);
  if (!committedBundle) {
    throw new Error("缺少已锁定的大纲 bundle.json。");
  }

  const planFinalBundle = await store.loadPlanFinal();
  const remainingMetas = chapterMetas.slice(0, -1);
  const previousMeta = remainingMetas.at(-1) || null;
  const previousDraft = previousMeta
    ? await store.loadChapterDraft(previousMeta.chapter_id)
    : null;
  if (previousMeta && !previousDraft) {
    throw new Error(`缺少 ${previousMeta.chapter_id} 的章节快照，无法安全回退。`);
  }

  const restoredWorldState =
    previousDraft?.worldState ||
    planFinalBundle?.worldState ||
    committedBundle.worldState;
  const restoredForeshadowingRegistry =
    previousDraft?.foreshadowingRegistry ||
    planFinalBundle?.foreshadowingRegistry ||
    committedBundle.foreshadowingRegistry;
  const restoredCharacterStates = Array.isArray(previousDraft?.characterStates)
    ? previousDraft.characterStates
    : (planFinalBundle?.characters || committedBundle.characters || [])
      .map((character) => character?.state)
      .filter(Boolean);
  const restoredLatestChapterPlan =
    (planFinalBundle?.structureData?.chapters || [])
      .find((chapter) => chapter?.chapterId === latestChapterId) ||
    (committedBundle?.structureData?.chapters || [])
      .find((chapter) => chapter?.chapterId === latestChapterId) ||
    null;
  const restoredStructureChapters = (committedBundle?.structureData?.chapters || []).map((chapter) =>
    chapter?.chapterId === latestChapterId && restoredLatestChapterPlan
      ? restoredLatestChapterPlan
      : chapter,
  );

  await store.removeCommittedChapter(latestChapterId);
  await store.removeChapterDraft(latestChapterId);
  await store.writeJson(path.join(store.paths.novelStateDir, "bundle.json"), {
    ...committedBundle,
    structureData: {
      ...(committedBundle.structureData || {}),
      chapters: restoredStructureChapters,
    },
    worldState: restoredWorldState,
    foreshadowingRegistry: restoredForeshadowingRegistry,
  });
  await store.writeJson(
    path.join(store.paths.novelStateDir, "world_state.json"),
    restoredWorldState || null,
  );
  await store.writeJson(
    path.join(store.paths.novelStateDir, "foreshadowing_registry.json"),
    restoredForeshadowingRegistry || null,
  );
  await store.replaceCharacterStates(restoredCharacterStates);

  if (remainingMetas.length === 0) {
    await store.writeText(path.join(store.paths.novelStateDir, "style_guide.md"), DEFAULT_STYLE_GUIDE_MARKDOWN);
    await store.removeRunsByPhase("write");
    await store.removeReviewsByTargets([
      REVIEW_TARGETS.CHAPTER_OUTLINE,
      REVIEW_TARGETS.CHAPTER,
    ]);
  }

  await rebuildFactLedger(store);

  const nextReviewHistory = remainingMetas.length === 0
    ? (projectState.history.reviews || []).filter((review) =>
      review?.target !== REVIEW_TARGETS.CHAPTER_OUTLINE && review?.target !== REVIEW_TARGETS.CHAPTER,
    )
    : (projectState.history.reviews || []);

  projectState.phase.write = {
    ...projectState.phase.write,
    status: WRITE_STATUS.IDLE,
    lastRunId: remainingMetas.length === 0 ? null : projectState.phase.write.lastRunId,
    pendingReview: null,
    currentChapterNumber: previousMeta ? chapterNumberFromId(previousMeta.chapter_id) : 0,
    rejectionNotes: [],
    rewriteHistory: [],
  };
  projectState.history.reviews = nextReviewHistory;

  const savedProject = await store.saveProject(projectState);
  return {
    project: savedProject,
    run: null,
    summary: `${latestChapterId} 已删除，当前回退到 ${previousMeta?.chapter_id || "未锁章"} 状态。`,
  };
}
