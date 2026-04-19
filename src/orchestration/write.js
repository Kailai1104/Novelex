import path from "node:path";

import { PLAN_STATUS, REVIEW_TARGETS, WRITE_STATUS } from "../core/defaults.js";
import {
  assembleChapterMarkdown,
  buildChapterMeta,
  buildStyleGuide,
  createSceneDraft,
  reorderChapterScenes,
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
  chapterIdFromNumber,
  createExcerpt,
  extractJsonObject,
  nowIso,
  safeJsonParse,
} from "../core/text.js";
import { createProvider } from "../llm/provider.js";
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
  return (Array.isArray(values) ? values : [])
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (item && typeof item === "object") {
        const term = String(item.term || item.name || "").trim();
        const note = String(item.note || item.definition || item.usage || "").trim();
        return [term, note].filter(Boolean).join("：");
      }
      return "";
    })
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

function collectResearchSources(raw) {
  const seen = new Set();
  const sources = [];

  function pushSource(candidate, fallbackType = "web") {
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
    sources.push({
      title: String(candidate.title || candidate.name || url).trim(),
      url,
      snippet: String(candidate.snippet || candidate.excerpt || candidate.text || "").trim(),
      type: String(candidate.type || fallbackType).trim() || fallbackType,
    });
  }

  function visit(node) {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") {
      return;
    }

    if (node.type === "url_citation" && node.url) {
      pushSource(node, "citation");
    }
    if (node.url_citation && typeof node.url_citation === "object") {
      pushSource(node.url_citation, "citation");
    }
    if (Array.isArray(node.sources)) {
      node.sources.forEach((item) => pushSource(item, "web_search_source"));
    }

    for (const value of Object.values(node)) {
      visit(value);
    }
  }

  visit(raw);
  return sources.slice(0, 10);
}

function hasWebSearchEvidence(raw) {
  let used = false;

  function visit(node) {
    if (used || !node) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") {
      return;
    }

    if (
      node.type === "web_search_call" ||
      node.type === "web_search_call_result" ||
      Array.isArray(node.sources) ||
      (node.action && Array.isArray(node.action.sources))
    ) {
      used = true;
      return;
    }

    for (const value of Object.values(node)) {
      visit(value);
      if (used) {
        return;
      }
    }
  }

  visit(raw);
  return used;
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
  provider,
  project,
  chapterPlan,
  plannerPacket,
}) {
  if (!plannerPacket?.triggered || !(plannerPacket.queries || []).length) {
    return createEmptyResearchPacket();
  }

  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 ResearchRetriever。你必须调用 web search 工具，为当前章节检索最相关的外部资料。检索完成后，只输出 JSON，总结当前章节真正该用的事实、该避开的误写、推荐术语、不确定点与来源备注。",
    input: [
      `作品：${project.title}`,
      `题材：${project.genre}`,
      `设定：${project.setting}`,
      `研究备注：${project.researchNotes || "无"}`,
      `当前章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
      `章节地点：${chapterPlan.location}`,
      `故事时间：${chapterPlan.timeInStory}`,
      `检索问题：${plannerPacket.queries.join("；")}`,
      `重点核对：${(plannerPacket.focusFacts || []).join("；") || "无"}`,
      `请输出 JSON：
{
  "summary": "本章研究摘要",
  "factsToUse": ["可直接用于写作的事实1", "事实2"],
  "factsToAvoid": ["需要避免的误写1", "误写2"],
  "termBank": ["术语：解释"],
  "uncertainPoints": ["仍不确定点1"],
  "sourceNotes": ["来源1为什么可信", "来源2说明了什么"]
}`,
    ].join("\n\n"),
    tools: [{ type: "web_search" }],
    toolChoice: "auto",
    include: ["web_search_call.action.sources"],
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

  const sources = collectResearchSources(result.raw);
  if (!hasWebSearchEvidence(result.raw) && !sources.length) {
    throw new Error("ResearchRetriever 没有实际调用 web search 工具。");
  }

  return {
    triggered: true,
    mode: "retrieved",
    summary: String(parsed.summary || "").trim(),
    factsToUse: normalizeResearchTextList(parsed.factsToUse, 8),
    factsToAvoid: normalizeResearchTextList(parsed.factsToAvoid, 6),
    termBank: normalizeResearchTerms(parsed.termBank, 8),
    uncertainPoints: normalizeResearchTextList(parsed.uncertainPoints, 5),
    sourceNotes: normalizeResearchTextList(parsed.sourceNotes, 6),
    sources,
  };
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
    mode: "search_tool",
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
      summary: `ResearchRetriever 调用失败：${error instanceof Error ? error.message : String(error || "")}`,
      sourceNotes: ["模型搜索工具调用失败，本章仍继续写作，但请人工留意考据风险。"],
      briefingMarkdown: buildResearchMarkdown({
        triggered: true,
        summary: `ResearchRetriever 调用失败：${error instanceof Error ? error.message : String(error || "")}`,
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
}) {
  const chapterIntent = buildGovernedChapterIntent({
    chapterPlan,
    planContext,
    historyPacket,
    foreshadowingAdvice,
    researchPacket,
    styleGuideText,
  });
  const contextPackage = buildContextPackage({
    chapterPlan,
    planContext,
    historyPacket,
    writerContext,
    researchPacket,
    referencePacket,
    openingReferencePacket,
  });
  const ruleStack = buildRuleStack({
    chapterPlan,
    chapterIntent,
    planContext,
    historyPacket,
    researchPacket,
    referencePacket,
    openingReferencePacket,
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

function scenePromptInput({
  project,
  chapterPlan,
  scene,
  sceneIndex,
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
}) {
  const currentEvent = chapterPlan.keyEvents[sceneIndex] || chapterPlan.keyEvents.at(-1);
  const povCharacter = chapterPlan.povCharacter || project.protagonistName || "主角";
  const governanceContract = buildGovernedInputContract({
    chapterIntent: governance?.chapterIntent,
    contextPackage: governance?.contextPackage,
    ruleStack: governance?.ruleStack,
  });

  return [
    `作品：${project.title}`,
    `章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
    `模式：${mode}`,
    `POV：${povCharacter}`,
    `硬性视角规则：全文必须使用第三人称有限视角，叙述中只能写“${povCharacter}看见/听见/想到”，禁止使用“我/我们”作为旁白人称；对白里的第一人称不受此限制。`,
    "写法要求：直接输出可发布的网络小说正文，不要解释提纲，不要总结主题，不要写“本章将要”“这一章里”这类元话语。",
    "语言要求：优先用动作、对白、现场反应推进；少写抽象判断、空泛感慨和整段概括性总结。",
    governanceContract ? `治理输入合同：\n${governanceContract}` : "",
    `场景：${scene.label}`,
    `地点：${scene.location}`,
    `焦点：${scene.focus}`,
    `张力：${scene.tension}`,
    `本章主线：${chapterPlan.dominantThread || "无"}`,
    `本章线索结构：${chapterPlan.threadMode || "single_spine"}`,
    `章节入口承接：${chapterPlan.entryLink || historyPacket.lastEnding}`,
    `章节出口压力：${chapterPlan.exitPressure || chapterPlan.nextHook}`,
    `本场所属线程：${scene.threadId || "main"}`,
    `本场情节作用：${scene.scenePurpose || scene.focus}`,
    `本场承接自：${scene.inheritsFromPrevious || historyPacket.lastEnding || "保持与上文自然衔接"}`,
    `本场产出结果：${scene.outcome || "把局势推向下一步"}`,
    `本场交棒给下一场：${scene.handoffToNext || chapterPlan.nextHook || "把问题交给下一场"}`,
    `本场景必须落地的事件：${currentEvent}`,
    `上文衔接：${historyPacket.lastEnding}`,
    `连续性锚点：${historyPacket.continuityAnchors[sceneIndex] || chapterPlan.continuityAnchors[sceneIndex] || "保持与上文自然衔接"}`,
    `本章硬性事件：${chapterPlan.keyEvents.join("；")}`,
    `章末牵引：${chapterPlan.nextHook}`,
    `本章伏笔任务：${foreshadowingSummary || "无"}`,
    `本章角色动态：\n${characterStateSummary || "无"}`,
    `本章场景推进：\n${sceneBeatSummary || "无"}`,
    `研究资料包：\n${researchPacket?.briefingMarkdown || "当前章节无需额外考据。"}`,
    `范文参考包：\n${referencePacket?.briefingMarkdown || "当前没有额外范文参考。"}`,
    `黄金三章参考包：\n${openingReferencePacket?.briefingMarkdown || "当前没有额外黄金三章参考。"}`,
    `整理后的写前上下文：\n${writerContextPacket?.briefingMarkdown || "当前没有额外 Writer 上下文包。"}`,
    `登场角色：${scene.characters?.join("、") || chapterPlan.charactersPresent.join("、")}`,
    `人物一致性档案：\n${characterDossiers.length ? characterDossiers.map((item) => item.markdown).join("\n\n") : "本场暂无可用主角色 dossier。"}`,
    `风格指南：\n${styleGuideText}`,
    `历史衔接摘要：\n${historyPacket.briefingMarkdown || historyPacket.contextSummary || "无额外上下文"}`,
    revisionNotes.length ? `人类修订意见：${revisionNotes.join("；")}` : "",
    "只输出该场景正文，不要额外标题，不要分点，不要附加解释。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function generateSceneDrafts({
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
  existingSceneDrafts = [],
}) {
  const sceneDrafts = [];
  for (let index = 0; index < chapterPlan.scenes.length; index += 1) {
    const scene = chapterPlan.scenes[index];
    const currentSceneDraft = existingSceneDrafts.find((item) => item.sceneId === scene.id);
    const instructions = mode === "style_repair"
      ? "你是 Novelex 的 WriterAgent。下面会给你一段已有场景草稿。请在不改变既定事件、角色关系和冲突走向的前提下，把它改写成真正可发布的网络小说正文。必须严格使用第三人称有限视角，禁止出现旁白第一人称；不要复述提纲，不要写说明文，不要加入场景标题、系统备注或总结性尾巴。输出前自行检查旁白里是否残留“我/我们”。"
      : mode === "validation_repair"
        ? "你是 Novelex 的 WriterAgent。下面会给你一段已有场景草稿和验证反馈。请在保留既定剧情事实、人物关系和冲突方向的前提下，重写这一场，使缺失事件真正落地、人物反应更可信、伏笔更自然、文风更像可发布的网络小说正文。不要输出解释，不要写标题。"
        : "你是 Novelex 的 WriterAgent。请把输入信息转成真正的网络小说正文。保持 POV 稳定、人物声音清晰、段落节奏自然；不要复述提纲，不要写说明文，不要用总结句替代剧情推进。";
    const input = (mode === "style_repair" || mode === "validation_repair") && currentSceneDraft
      ? [
          `待修正文：\n${currentSceneDraft.markdown}`,
          scenePromptInput({
            project,
            chapterPlan,
            scene,
            sceneIndex: index,
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
          }),
          mode === "style_repair"
            ? "改写要求：保留这一场已经成立的事件、人物立场和场面关系，只修正叙述视角、语言质感与元信息污染。"
            : "改写要求：严格依据验证反馈补足真正缺失的事件或因果，让场景更像正文，而不是提纲说明。",
        ].join("\n\n")
      : scenePromptInput({
          project,
          chapterPlan,
          scene,
          sceneIndex: index,
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
        });
    const result = await provider.generateText({
      instructions,
      input,
      metadata: {
        feature: "scene_draft",
        chapterId: chapterPlan.chapterId,
        sceneId: scene.id,
      },
    });

    sceneDrafts.push(
      createSceneDraft({
        chapterPlan,
        scene,
        sceneIndex: index,
        foreshadowingSummary,
        historyPacket,
        revisionNotes,
        overrideText: result.text,
      }),
    );
  }

  return sceneDrafts;
}

async function rewriteChapterForStyle({
  provider,
  project,
  chapterPlan,
  currentDraft,
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
  styleIssues = [],
}) {
  const repairNotes = [
    "硬性修正：全文必须改成第三人称有限视角，禁止旁白使用“我/我们”。",
    "硬性修正：删除一切场景标题、写作备注、人工修订重点、修订补笔等元信息。",
    ...styleIssues,
  ];

  const repairedSceneDrafts = await generateSceneDrafts({
    provider,
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
    revisionNotes: repairNotes,
    mode: "style_repair",
    existingSceneDrafts: currentDraft?.sceneDrafts || [],
  });

  return chapterDraftFromScenes(
    chapterPlan,
    repairedSceneDrafts,
    foreshadowingSummary,
    repairNotes,
  );
}

async function rewriteChapterFromValidation({
  provider,
  project,
  chapterPlan,
  currentDraft,
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
  validation,
}) {
  const repairNotes = collectAuditRepairNotes(validation);

  const repairedSceneDrafts = await generateSceneDrafts({
    provider,
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
    revisionNotes: repairNotes,
    mode: "validation_repair",
    existingSceneDrafts: currentDraft?.sceneDrafts || [],
  });

  return chapterDraftFromScenes(
    chapterPlan,
    repairedSceneDrafts,
    foreshadowingSummary,
    repairNotes,
  );
}

function chapterDraftFromScenes(chapterPlan, sceneDrafts, foreshadowingSummary = "", revisionNotes = []) {
  const markdown = assembleChapterMarkdown(
    chapterPlan.title,
    sceneDrafts,
    revisionNotes,
    chapterPlan,
  );

  return {
    markdown,
    sceneDrafts,
    usedForeshadowings: chapterPlan.foreshadowingActions.map((item) => item.id),
    dialogueCount: (markdown.match(/“/g) || []).length,
  };
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

async function locallyRewriteScenes({
  provider,
  project,
  chapterPlan,
  draftBundle,
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
  sceneIds,
}) {
  const selectedIds = new Set(sceneIds);
  const rewritten = [];

  for (let index = 0; index < chapterPlan.scenes.length; index += 1) {
    const scene = chapterPlan.scenes[index];
    const current = (draftBundle.sceneDrafts || []).find((item) => item.sceneId === scene.id);
    if (!selectedIds.has(scene.id)) {
      if (!current) {
        throw new Error(`聚焦重写时缺少现有场景草稿：${scene.id}`);
      }
      rewritten.push(current);
      continue;
    }
    const result = await provider.generateText({
      instructions:
        "你是 Novelex 的 WriterAgent。请只重写指定场景，保留既定事件、人物知识边界和 POV，同时把语言改得更像可发布的网络小说正文，不要输出解释。",
      input: [
        `重写目标场景：${scene.id} ${scene.label}`,
        `现有场景文本：${current?.markdown || ""}`,
        `人类反馈：${feedback}`,
        scenePromptInput({
          project,
          chapterPlan,
          scene,
          sceneIndex: index,
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
          revisionNotes: [feedback],
          mode: "rewrite",
        }),
      ].join("\n\n"),
      metadata: {
        feature: "scene_local_rewrite",
        chapterId: chapterPlan.chapterId,
        sceneId: scene.id,
      },
    });

    rewritten.push({
      sceneId: scene.id,
      sceneLabel: scene.label,
      location: scene.location,
      markdown: sanitizeDraftText(result.text),
    });
  }

  return rewritten;
}

function parseSceneIdList(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
  outlineOptions,
  foreshadowingActions,
  legacyPlan,
}) {
  const selectedCharacters = normalizeStringList([
    ...characterPlanning.mustAppear,
    ...characterPlanning.optionalCharacters,
  ], 8);

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
  previousOutline,
  nextLegacyPlan = null,
}) {
  const previousPlan = previousOutline?.chapterPlan || null;
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 ChapterContinuityAgent。你专门负责章节之间的细粒度衔接：上一章怎么接进来、当前章主承接哪条线、哪些副线只能轻触、以及本章结尾要把什么压力递交给下一章。不要做全书语义总结，不要生成细纲或正文，只输出 JSON。",
    input: [
      projectSummary(project),
      `当前章节：${chapterBase.chapterId}（第 ${chapterBase.chapterNumber} 章）`,
      `本章使命：${stagePlanning.chapterMission || "无"}`,
      `本章必须推进：${(stagePlanning.requiredBeats || []).join("；") || "无"}`,
      `历史优先线程：${(historyPlanning.priorityThreads || []).join("；") || "无"}`,
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
  foreshadowingActions,
  styleGuideText,
  openingReferencePacket = null,
  legacyPlan = null,
  feedback = "",
  previousHistory = [],
}) {
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
    foreshadowingActions: resources.foreshadowingActions,
  });
}

async function prepareChapterWriteResources({
  store,
  provider,
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
    provider,
    project,
    chapterPlan,
  });
  const {
    planContext,
    historyContext: historyPacket,
    writerContext: baseWriterContext,
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

  const sceneDrafts = await generateSceneDrafts({
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
    revisionNotes: [],
    mode: "draft",
  });
  let chapterDraft = chapterDraftFromScenes(
    chapterPlan,
    sceneDrafts,
    resources.foreshadowingSummary,
    [],
  );
  let validation = await runChapterAudit({
    store,
    provider,
    project: projectState.project,
    chapterPlan,
    chapterDraft,
    historyPacket: resources.historyPacket,
    foreshadowingAdvice: resources.foreshadowingAdvice,
    researchPacket: resources.researchPacket,
    styleGuideText: resources.styleGuideText,
    characterStates: resources.currentCharacterStates,
    foreshadowingRegistry: bundle.foreshadowingRegistry,
    chapterMetas: resources.chapterMetas,
  });

  run.steps.push(
    step(
      "writer_agent",
      "WriterAgent",
      "write",
      "根据章节执行摘要、Writer 上下文包、章纲与历史衔接产出章节草稿。",
      { preview: createExcerpt(chapterDraft.markdown, 200) },
    ),
  );

  if (needsAuditStyleRepair(validation)) {
    chapterDraft = await rewriteChapterForStyle({
      provider,
      project: projectState.project,
      chapterPlan,
      currentDraft: chapterDraft,
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
      styleIssues: collectAuditRepairNotes(validation, {
        dimensionIds: ["pov_consistency", "meta_leak"],
        severities: ["critical", "warning"],
      }),
    });
    validation = await runChapterAudit({
      store,
      provider,
      project: projectState.project,
      chapterPlan,
      chapterDraft,
      historyPacket: resources.historyPacket,
      foreshadowingAdvice: resources.foreshadowingAdvice,
      researchPacket: resources.researchPacket,
      styleGuideText: resources.styleGuideText,
      characterStates: resources.currentCharacterStates,
      foreshadowingRegistry: bundle.foreshadowingRegistry,
      chapterMetas: resources.chapterMetas,
    });
    run.steps.push(
      step(
        "writer_style_repair",
        "WriterAgent",
        "write",
        "根据风格校验结果强制重写为第三人称有限视角，并清除元信息污染。",
        { preview: createExcerpt(chapterDraft.markdown, 180) },
      ),
    );
  }

  if (!validation.overallPassed) {
    chapterDraft = await rewriteChapterFromValidation({
      provider,
      project: projectState.project,
      chapterPlan,
      currentDraft: chapterDraft,
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
      validation,
    });
    validation = await runChapterAudit({
      store,
      provider,
      project: projectState.project,
      chapterPlan,
      chapterDraft,
      historyPacket: resources.historyPacket,
      foreshadowingAdvice: resources.foreshadowingAdvice,
      researchPacket: resources.researchPacket,
      styleGuideText: resources.styleGuideText,
      characterStates: resources.currentCharacterStates,
      foreshadowingRegistry: bundle.foreshadowingRegistry,
      chapterMetas: resources.chapterMetas,
    });
    run.steps.push(
      step(
        "writer_revision",
        "WriterAgent",
        "write",
        "根据维度审计反馈重写缺失场景并收紧风格。",
        { preview: createExcerpt(chapterDraft.markdown, 180) },
      ),
    );
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
      validation.semanticAudit?.source === "agent"
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
    providerSnapshot: provider.settings,
    reviewState: {
      mode: "initial",
      availableSceneIds: chapterPlan.scenes.map((scene) => scene.id),
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
    rejectionNotes: [],
    rewriteHistory: existingRewriteHistory,
  };

  run.finishedAt = nowIso();
  run.summary = `第 ${chapterNumber} 章正文草稿已生成，等待人类审查。`;
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
    selectedProposalId = "",
    selectedSceneRefs = [],
    authorNotes = "",
    outlineOptions = null,
    sceneIds = [],
    sceneOrder = [],
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
  const pendingTarget = String(pending.target || REVIEW_TARGETS.CHAPTER);
  const requestedTarget = String(target || pendingTarget);
  if (requestedTarget !== pendingTarget) {
    throw new Error(`当前待审节点是 ${pendingTarget}，不能按 ${requestedTarget} 审查。`);
  }
  const normalizedSelectedSceneRefs = Array.isArray(selectedSceneRefs) ? selectedSceneRefs : parseSceneIdList(selectedSceneRefs);
  const normalizedSceneIds = Array.isArray(sceneIds) ? sceneIds : parseSceneIdList(sceneIds);
  const normalizedSceneOrder = Array.isArray(sceneOrder) ? sceneOrder : parseSceneIdList(sceneOrder);
  const normalizedReviewAction = normalizeChapterReviewAction(reviewAction, approved);
  const rewriteStrategy = approved
    ? null
    : resolveRewriteStrategy(reviewAction, normalizedSceneIds, normalizedSceneOrder);

  if (pendingTarget === REVIEW_TARGETS.CHAPTER && !approved && normalizedReviewAction !== "rewrite") {
    throw new Error(`未知的章节审查动作：${reviewAction}`);
  }

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
    rewriteStrategy,
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
      summary: `${pending.chapterId} 已锁定，可继续生成下一章。`,
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
  }];

  if (rewriteStrategy === "scene_patch") {
    if (!normalizedSceneIds.length) {
      throw new Error("按场景聚焦重写时至少需要指定一个 sceneId。");
    }

    const historyPacket = historyContextFromDraft(draftBundle);
    const writerContext = writerContextFromDraft(draftBundle);
    const governance = governanceFromDraft(draftBundle, chapterPlanBase);
    const foreshadowingSummary = summarizeForeshadowingAdvice(foreshadowingAdvice, chapterPlanBase);
    const characterStateSummary = summarizeCharacterStates(focusedCharacterStates);
    const sceneBeatSummary = summarizeSceneBeats(chapterPlanBase);
    const rewrittenSceneDrafts = await locallyRewriteScenes({
      provider,
      project: projectState.project,
      chapterPlan: chapterPlanBase,
      draftBundle,
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
      feedback,
      sceneIds: normalizedSceneIds,
    });

    let rewrittenDraft = chapterDraftFromScenes(
      chapterPlanBase,
      rewrittenSceneDrafts,
      foreshadowingSummary,
      [feedback],
    );
    let validation = await runChapterAudit({
      store,
      provider,
      project: projectState.project,
      chapterPlan: chapterPlanBase,
      chapterDraft: rewrittenDraft,
      historyPacket,
      foreshadowingAdvice,
      researchPacket,
      styleGuideText,
      characterStates: currentCharacterStates,
      foreshadowingRegistry: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
      chapterMetas,
    });
    if (needsAuditStyleRepair(validation)) {
      rewrittenDraft = await rewriteChapterForStyle({
        provider,
        project: projectState.project,
        chapterPlan: chapterPlanBase,
        currentDraft: rewrittenDraft,
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
        styleIssues: collectAuditRepairNotes(validation, {
          dimensionIds: ["pov_consistency", "meta_leak"],
          severities: ["critical", "warning"],
        }),
      });
      validation = await runChapterAudit({
        store,
        provider,
        project: projectState.project,
        chapterPlan: chapterPlanBase,
        chapterDraft: rewrittenDraft,
        historyPacket,
        foreshadowingAdvice,
        researchPacket,
        styleGuideText,
        characterStates: currentCharacterStates,
        foreshadowingRegistry: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
        chapterMetas,
      });
    }
    if (!validation.overallPassed) {
      rewrittenDraft = await rewriteChapterFromValidation({
        provider,
        project: projectState.project,
        chapterPlan: chapterPlanBase,
        currentDraft: rewrittenDraft,
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
        validation,
      });
      validation = await runChapterAudit({
        store,
        provider,
        project: projectState.project,
        chapterPlan: chapterPlanBase,
        chapterDraft: rewrittenDraft,
        historyPacket,
        foreshadowingAdvice,
        researchPacket,
        styleGuideText,
        characterStates: currentCharacterStates,
        foreshadowingRegistry: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
        chapterMetas,
      });
    }

    const scenePatchState = buildDerivedChapterStateArtifacts({
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
      sceneDrafts: rewrittenDraft.sceneDrafts,
      researchPacket,
      referencePacket,
      openingReferencePacket,
      validation,
      auditDrift: validation.auditDrift,
      chapterMeta: scenePatchState.chapterMeta,
      characterStates: scenePatchState.characterStates,
      worldState: scenePatchState.worldState,
      foreshadowingRegistry: scenePatchState.foreshadowingRegistry,
      retrieval: historyPacket,
      historyContext: historyPacket,
      planContext: draftBundle.planContext || {},
      writerContext,
      chapterIntent: governance.chapterIntent,
      contextPackage: governance.contextPackage,
      ruleStack: governance.ruleStack,
      contextTrace: governance.contextTrace,
      reviewState: {
        mode: "rewrite",
        strategy: rewriteStrategy,
        availableSceneIds: chapterPlanBase.scenes.map((scene) => scene.id),
        lastFeedback: feedback || "",
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
      summary: `${pending.chapterId} 已根据人类反馈重写并回到待审状态。`,
      steps: [
        step(
          "rewrite",
          "WriterAgent",
          "write",
          `根据人类反馈聚焦重写场景：${normalizedSceneIds.join("、")}`,
          { preview: createExcerpt(feedback || "", 160) },
        ),
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
      rejectionNotes: [feedback].filter(Boolean),
      rewriteHistory,
    };
    const savedProject = await store.saveProject(projectState);
    return {
      project: savedProject,
      run: rewriteRun,
      summary: `${pending.chapterId} 已完成重写，等待再次审查。`,
    };
  }

  if (rewriteStrategy === "chapter_rebuild") {
    const rewrittenChapterPlan = reorderChapterScenes(chapterPlanBase, normalizedSceneOrder);
    const {
      planContext,
      historyContext: historyPacket,
      writerContext: baseWriterContext,
    } = await buildWriterContextBundle({
      store,
      provider,
      project: projectState.project,
      bundle,
      chapterPlan: rewrittenChapterPlan,
      chapterMetas,
      characterStates: currentCharacterStates,
      foreshadowingAdvice,
      styleGuideText,
      styleGuideSourcePath,
      researchPacket,
    });
    const rebuiltReferencePacket = await buildReferencePacket({
      store,
      provider,
      project: projectState.project,
      chapterPlan: rewrittenChapterPlan,
      planContext,
      historyContext: historyPacket,
      researchPacket,
    });
    let rebuiltOpeningReferencePacket = createEmptyOpeningReferencePacket({
      mode: "chapter_write",
    });
    if (Number(rewrittenChapterPlan?.chapterNumber || 0) <= 3) {
      rebuiltOpeningReferencePacket = await buildOpeningReferencePacket({
        store,
        provider,
        project: projectState.project,
        mode: "chapter_write",
        chapterPlan: rewrittenChapterPlan,
        planContext,
        historyContext: historyPacket,
      });
    }
    const writerContextWithReference = mergeReferenceIntoWriterContext(baseWriterContext, rebuiltReferencePacket);
    const writerContext = mergeOpeningIntoWriterContext(writerContextWithReference, rebuiltOpeningReferencePacket);
    const governance = buildGovernanceResources({
      chapterPlan: rewrittenChapterPlan,
      planContext,
      historyPacket,
      writerContext,
      foreshadowingAdvice,
      researchPacket,
      referencePacket: rebuiltReferencePacket,
      openingReferencePacket: rebuiltOpeningReferencePacket,
      styleGuideText,
      styleGuideSourcePath,
    });
    const foreshadowingSummary = summarizeForeshadowingAdvice(foreshadowingAdvice, rewrittenChapterPlan);
    const characterStateSummary = summarizeCharacterStates(focusedCharacterStates);
    const sceneBeatSummary = summarizeSceneBeats(rewrittenChapterPlan);
    const rewrittenSceneDrafts = await generateSceneDrafts({
      provider,
      project: projectState.project,
      chapterPlan: rewrittenChapterPlan,
      historyPacket,
      foreshadowingSummary,
      characterStateSummary,
      sceneBeatSummary,
      researchPacket,
      referencePacket: rebuiltReferencePacket,
      openingReferencePacket: rebuiltOpeningReferencePacket,
      writerContextPacket: writerContext,
      governance,
      characterDossiers,
      styleGuideText,
      revisionNotes: [feedback].filter(Boolean),
      mode: "rewrite",
    });

    let rewrittenDraft =
      chapterDraftFromScenes(rewrittenChapterPlan, rewrittenSceneDrafts, foreshadowingSummary, [feedback].filter(Boolean));
    let validation = await runChapterAudit({
      store,
      provider,
      project: projectState.project,
      chapterPlan: rewrittenChapterPlan,
      chapterDraft: rewrittenDraft,
      historyPacket,
      foreshadowingAdvice,
      researchPacket,
      styleGuideText,
      characterStates: currentCharacterStates,
      foreshadowingRegistry: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
      chapterMetas,
    });
    if (needsAuditStyleRepair(validation)) {
      rewrittenDraft = await rewriteChapterForStyle({
        provider,
        project: projectState.project,
        chapterPlan: rewrittenChapterPlan,
        currentDraft: rewrittenDraft,
        historyPacket,
        foreshadowingSummary,
        characterStateSummary,
        sceneBeatSummary,
        researchPacket,
        referencePacket: rebuiltReferencePacket,
        openingReferencePacket: rebuiltOpeningReferencePacket,
        writerContextPacket: writerContext,
        governance,
        characterDossiers,
        styleGuideText,
        styleIssues: collectAuditRepairNotes(validation, {
          dimensionIds: ["pov_consistency", "meta_leak"],
          severities: ["critical", "warning"],
        }),
      });
      validation = await runChapterAudit({
        store,
        provider,
        project: projectState.project,
        chapterPlan: rewrittenChapterPlan,
        chapterDraft: rewrittenDraft,
        historyPacket,
        foreshadowingAdvice,
        researchPacket,
        styleGuideText,
        characterStates: currentCharacterStates,
        foreshadowingRegistry: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
        chapterMetas,
      });
    }
    if (!validation.overallPassed) {
      rewrittenDraft = await rewriteChapterFromValidation({
        provider,
        project: projectState.project,
        chapterPlan: rewrittenChapterPlan,
        currentDraft: rewrittenDraft,
        historyPacket,
        foreshadowingSummary,
        characterStateSummary,
        sceneBeatSummary,
        researchPacket,
        referencePacket: rebuiltReferencePacket,
        openingReferencePacket: rebuiltOpeningReferencePacket,
        writerContextPacket: writerContext,
        governance,
        characterDossiers,
        styleGuideText,
        validation,
      });
      validation = await runChapterAudit({
        store,
        provider,
        project: projectState.project,
        chapterPlan: rewrittenChapterPlan,
        chapterDraft: rewrittenDraft,
        historyPacket,
        foreshadowingAdvice,
        researchPacket,
        styleGuideText,
        characterStates: currentCharacterStates,
        foreshadowingRegistry: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
        chapterMetas,
      });
    }

    const rebuiltState = buildDerivedChapterStateArtifacts({
      currentCharacterStates,
      chapterPlan: rewrittenChapterPlan,
      project: projectState.project,
      chapterDraft: rewrittenDraft,
      worldStateBase: bundle.worldState,
      structureData: bundle.structureData,
      foreshadowingRegistryBase: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
    });

    await store.stageChapterDraft({
      ...draftBundle,
      chapterPlan: rewrittenChapterPlan,
      chapterMarkdown: rewrittenDraft.markdown,
      sceneDrafts: rewrittenDraft.sceneDrafts,
      researchPacket,
      referencePacket: rebuiltReferencePacket,
      openingReferencePacket: rebuiltOpeningReferencePacket,
      validation,
      auditDrift: validation.auditDrift,
      chapterMeta: rebuiltState.chapterMeta,
      characterStates: rebuiltState.characterStates,
      worldState: rebuiltState.worldState,
      foreshadowingRegistry: rebuiltState.foreshadowingRegistry,
      retrieval: historyPacket,
      historyContext: historyPacket,
      planContext,
      writerContext,
      chapterIntent: governance.chapterIntent,
      contextPackage: governance.contextPackage,
      ruleStack: governance.ruleStack,
      contextTrace: governance.contextTrace,
      reviewState: {
        mode: "rewrite",
        strategy: rewriteStrategy,
        availableSceneIds: rewrittenChapterPlan.scenes.map((scene) => scene.id),
        lastFeedback: feedback || "",
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
      summary: `${pending.chapterId} 已根据人类反馈重写并回到待审状态。`,
      steps: [
        step(
          "rewrite",
          normalizedSceneOrder.length ? "CoordinatorAgent" : "WriterAgent",
          "write",
          normalizedSceneOrder.length
            ? `根据人类反馈重排场景顺序：${normalizedSceneOrder.join(" -> ")}`
            : "根据人类反馈重建上下文并重写整章。",
          { preview: createExcerpt(feedback || "", 160) },
        ),
        step("writer_after_rewrite", "WriterAgent", "write", "整章已按反馈完成重写。"),
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
      rejectionNotes: [feedback].filter(Boolean),
      rewriteHistory,
    };
    const savedProject = await store.saveProject(projectState);
    return {
      project: savedProject,
      run: rewriteRun,
      summary: `${pending.chapterId} 已完成重写，等待再次审查。`,
    };
  }

  throw new Error(`未能解析重写策略：${reviewAction}`);
}
