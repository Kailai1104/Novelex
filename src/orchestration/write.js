import path from "node:path";

import {
  DEFAULT_STYLE_GUIDE_MARKDOWN,
  PLAN_STATUS,
  REVIEW_TARGETS,
  WRITE_STATUS,
} from "../core/defaults.js";
import {
  analyzeCharacterPresence,
  realizedCharactersPresent,
  requiredCharactersConstraint,
} from "../core/character-presence.js";
import { buildContextTrace } from "../core/context-trace.js";
import {
  buildGovernedInputContract,
  runGovernanceAgent,
} from "../core/input-governance.js";
import {
  chapterNumberFromId,
  chapterIdFromNumber,
  composeChapterMarkdown,
  countWordsApprox,
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
import { generateStructuredObject } from "../llm/structured.js";
import { formatMcpErrorMessage } from "../mcp/error.js";
import { getWorkspaceMcpManager, normalizeWebSearchToolResult } from "../mcp/index.js";
import {
  buildOpeningReferencePacket,
  createEmptyOpeningReferencePacket,
  mergeOpeningIntoOutlineContext,
  mergeOpeningIntoWriterContext,
  scopeOpeningReferencePacket,
  scopeOpeningReferencePacketWithAgent,
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
  buildTimelineContextPacket,
  loadTimelineState,
  runTemporalPlanningAgent,
  runTimelineExtractionAgent,
  updateTimelineStateAfterChapter,
} from "../core/timeline.js";
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

const OUTLINE_CONSISTENCY_MAX_ATTEMPTS = 5;
const OUTLINE_CONSISTENCY_AUDIT_RETRIES = 2;
const RESEARCH_MCP_QUERY_TIMEOUT_MS = 8000;

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

async function withOperationTimeout(task, timeoutMs, label = "Operation timed out") {
  const normalizedTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    return task;
  }

  let timer = null;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), normalizedTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

const RESTART_OPENING_PATTERN = /惊醒|醒来|睁眼|睁开眼|刚恢复意识|重新确认|再次确认|我是谁|穿越|身份首次|主角首次|身体危机/u;
const IDENTITY_RECONFIRM_PATTERN = /重新确认身份|再次确认身份|我是谁|自己是谁|刚穿越|刚醒来/u;
const UNCONSCIOUSNESS_PATTERN = /昏迷|昏厥|失去意识|晕了过去|晕过去|意识陷入黑暗|不省人事/u;
const REPLAY_FIRST_CHAPTER_PATTERN = /(第一次|首次).*(立威|证明|确认|亮相|登场|出场|身份|穿越)/u;

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

function stringifyForGovernance(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || "");
  }
}

function evidenceRef(refId, type, source, text) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    return null;
  }
  return {
    refId,
    type,
    source,
    text: createExcerpt(normalizedText, 260),
  };
}

function collectFactEvidenceRefs(facts = [], currentChapterNumber = 1) {
  return (Array.isArray(facts) ? facts : [])
    .filter((fact) => chapterNumberFromId(fact?.chapterId) < currentChapterNumber)
    .map((fact) => evidenceRef(
      fact.factId || `${fact.chapterId || "fact"}_${fact.type || "state"}`,
      fact.status === "open_tension" ? "open_tension" : "canon_fact",
      `novel_state/chapters/${fact.chapterId || "unknown"}_facts.json`,
      `${fact.subject || "主体"}｜${fact.assertion || ""}｜证据:${fact.evidence || ""}`,
    ))
    .filter(Boolean);
}

function renderContinuityGuardMarkdown(guard) {
  if (!guard) {
    return "";
  }

  return [
    `# ${guard.chapterId} 连续性护栏`,
    "",
    "## Entry Mode",
    `- 默认入口：${guard.defaultEntryMode}`,
    `- 允许入口：${(guard.allowedEntryModes || []).join("；") || "无"}`,
    `- 昏迷/失去意识证据：${guard.supportsWakeAfterUnconsciousness ? "有" : "无"}`,
    "",
    "## 上章末尾状态",
    `- 承接压力：${guard.resumeFrom || "无"}`,
    `- 上章动作压力：${guard.previousActionPressure || "无"}`,
    "",
    "## 强制禁止",
    `- ${(guard.forbiddenRestartTerms || []).join("\n- ") || "无"}`,
    "",
    "## 证据引用",
    ...((guard.evidenceRefs || []).slice(0, 8).map((item) => `- [${item.refId}] ${item.type}｜${item.text}`)),
  ].join("\n");
}

async function buildDeterministicContinuityGuard({
  provider,
  store,
  chapterBase,
  chapterSlot,
  committedOutlines = [],
  factContext = null,
}) {
  const chapterNumber = Number(chapterBase?.chapterNumber || 1) || 1;
  const previousChapterId = chapterIdFromNumber(Math.max(1, chapterNumber - 1));
  const previousOutline = [...committedOutlines]
    .filter((item) => Number(item.chapterNumber || 0) < chapterNumber)
    .sort((left, right) => Number(left.chapterNumber || 0) - Number(right.chapterNumber || 0))
    .at(-1) || null;
  const previousPlan = previousOutline?.chapterPlan || null;
  const previousLastScene = Array.isArray(previousPlan?.scenes) ? previousPlan.scenes.at(-1) : null;
  const previousChapterMarkdown = chapterNumber > 1
    ? await store.readText(path.join(store.paths.chaptersDir, `${previousChapterId}.md`), "")
    : "";
  let ledgerFacts = [];
  try {
    ledgerFacts = await loadFactLedger(store);
  } catch {
    ledgerFacts = [];
  }
  const selectedFacts = [
    ...(factContext?.establishedFacts || []),
    ...(factContext?.openTensions || []),
  ];
  const factRefs = collectFactEvidenceRefs([...ledgerFacts, ...selectedFacts], chapterNumber);
  const outlineRefs = [
    evidenceRef(
      `${previousChapterId}_outline_exit`,
      "previous_outline_exit",
      `novel_state/chapters/${previousChapterId}_outline.json`,
      previousPlan?.exitPressure || previousPlan?.nextHook || "",
    ),
    evidenceRef(
      `${previousChapterId}_last_scene`,
      "previous_outline_last_scene",
      `novel_state/chapters/${previousChapterId}_outline.json`,
      [
        previousLastScene?.scenePurpose,
        previousLastScene?.outcome,
        previousLastScene?.handoffToNext,
      ].filter(Boolean).join("；"),
    ),
    evidenceRef(
      `${previousChapterId}_approved_tail`,
      "approved_chapter_tail",
      `novel_state/chapters/${previousChapterId}.md`,
      createExcerpt(previousChapterMarkdown.slice(-1200), 420),
    ),
  ].filter(Boolean);
  const allEvidenceRefs = [...outlineRefs, ...factRefs];
  const evidenceText = allEvidenceRefs.map((item) => item.text).join(" ");
  const fallbackResumeFrom = String(
    previousPlan?.exitPressure ||
    previousPlan?.nextHook ||
    previousLastScene?.handoffToNext ||
    previousLastScene?.outcome ||
    chapterSlot?.expectedCarryover ||
    "承接上一章留下的直接压力。",
  ).trim();
  const fallbackSupportsWake = UNCONSCIOUSNESS_PATTERN.test(evidenceText);
  const fallbackAllowedEntryModes = normalizeStringList([
    "direct_resume",
    "same_scene_later",
    "time_skip_under_pressure",
    "location_shift_with_explicit_transition",
    fallbackSupportsWake ? "wake_after_unconsciousness" : "",
  ], 6);
  const guard = await generateStructuredObject(provider, {
    label: "ContinuityGuardAgent",
    agentComplexity: "simple",
    instructions:
      "你是 Novelex 的 ContinuityGuardAgent。你负责根据上章已锁定细纲、上章正文尾部、canon facts 和当前 chapter slot，为当前章节裁定允许的开场承接方式，并明确禁止的重开/重演模式。不要输出解释，只输出 JSON。",
    input: [
      `当前章节：${chapterBase.chapterId}（第 ${chapterNumber} 章）`,
      `上一章：${previousChapterId || "无"}`,
      `chapter slot：\n${JSON.stringify(chapterSlot || {}, null, 2)}`,
      `上章细纲摘要：\n${JSON.stringify({
        exitPressure: previousPlan?.exitPressure || "",
        nextHook: previousPlan?.nextHook || "",
        lastScene: previousLastScene || null,
      }, null, 2)}`,
      `Fact context：\n${JSON.stringify(factContext || {}, null, 2)}`,
      `证据引用：\n${JSON.stringify(allEvidenceRefs, null, 2)}`,
      `参考默认值：\n${JSON.stringify({
        defaultEntryMode: "direct_resume",
        allowedEntryModes: fallbackAllowedEntryModes,
        supportsWakeAfterUnconsciousness: fallbackSupportsWake,
        resumeFrom: fallbackResumeFrom,
      }, null, 2)}`,
      `请输出 JSON：
{
  "defaultEntryMode": "direct_resume",
  "allowedEntryModes": ["direct_resume", "same_scene_later"],
  "supportsWakeAfterUnconsciousness": false,
  "resumeFrom": "应承接的直接压力",
  "previousActionPressure": "上章动作压力",
  "forbiddenRestartTerms": ["禁止的重开模式1"],
  "mandatoryEvidenceRefs": ["ref_id_1"],
  "unsupportedClaims": ["当前不允许的开场说法"]
}`,
    ].join("\n\n"),
    metadata: {
      feature: "continuity_guard",
      chapterId: chapterBase?.chapterId || "",
    },
    normalize(parsed) {
      const allowedEntryModes = normalizeStringList(parsed.allowedEntryModes, 6);
      const mandatoryEvidenceRefs = normalizeStringList(parsed.mandatoryEvidenceRefs, 8)
        .filter((refId) => allEvidenceRefs.some((item) => item.refId === refId));
      return {
        chapterId: chapterBase.chapterId,
        chapterNumber,
        generatedAt: nowIso(),
        previousChapterId: chapterNumber > 1 ? previousChapterId : "",
        defaultEntryMode: String(parsed.defaultEntryMode || "").trim() || "direct_resume",
        allowedEntryModes: allowedEntryModes.length ? allowedEntryModes : fallbackAllowedEntryModes,
        supportsWakeAfterUnconsciousness: Boolean(parsed.supportsWakeAfterUnconsciousness),
        resumeFrom: String(parsed.resumeFrom || fallbackResumeFrom).trim(),
        previousActionPressure: String(
          parsed.previousActionPressure ||
          previousLastScene?.handoffToNext ||
          previousLastScene?.outcome ||
          previousPlan?.exitPressure ||
          ""
        ).trim(),
        expectedCarryover: chapterSlot?.expectedCarryover || "",
        forbiddenRestartTerms: normalizeStringList(parsed.forbiddenRestartTerms, 8),
        evidenceRefs: allEvidenceRefs,
        mandatoryEvidenceRefs: mandatoryEvidenceRefs.length
          ? mandatoryEvidenceRefs
          : allEvidenceRefs.slice(0, 4).map((item) => item.refId),
        unsupportedClaims: normalizeStringList(parsed.unsupportedClaims, 8),
      };
    },
  });
  guard.markdown = renderContinuityGuardMarkdown(guard);
  return guard;
}

function sanitizeContinuityPlanningWithGuard(continuityPlanning, continuityGuard) {
  const guard = continuityGuard || {};
  const unsupportedClaims = normalizeStringList(continuityPlanning?.unsupportedClaims || [], 8);
  const plannedEntryMode = String(continuityPlanning?.entryMode || "").trim();
  let entryMode = guard.allowedEntryModes?.includes(plannedEntryMode)
    ? plannedEntryMode
    : guard.defaultEntryMode || "direct_resume";
  if (plannedEntryMode === "wake_after_unconsciousness" && !guard.supportsWakeAfterUnconsciousness) {
    unsupportedClaims.push("ContinuityPlannerAgent 提出的醒后承接模式未被连续性护栏批准。");
    entryMode = guard.defaultEntryMode || "direct_resume";
  }

  return {
    ...continuityPlanning,
    entryMode,
    entryLink: String(continuityPlanning?.entryLink || guard.resumeFrom || "承接上一章留下的直接压力。").trim(),
    evidenceRefs: normalizeStringList([
      ...(continuityPlanning?.evidenceRefs || []),
      ...(guard.mandatoryEvidenceRefs || []),
    ], 10),
    unsupportedClaims: normalizeStringList(unsupportedClaims, 8),
    continuityRisks: normalizeStringList([
      ...(continuityPlanning?.continuityRisks || []),
      ...unsupportedClaims.map((item) => `已拦截：${item}`),
    ], 8),
  };
}

function buildOutlineGenerationContract({
  chapterBase,
  chapterSlot,
  continuityGuard,
}) {
  const chapterNumber = Number(chapterBase?.chapterNumber || 1) || 1;
  return {
    chapterId: chapterBase.chapterId,
    chapterNumber,
    generatedAt: nowIso(),
    mustResumeFromPreviousPressure: chapterNumber > 1,
    previousPressure: continuityGuard?.resumeFrom || "",
    forbidRestartOpening: chapterNumber > 1 && !continuityGuard?.supportsWakeAfterUnconsciousness,
    forbidIdentityReconfirmation: chapterNumber > 1,
    forbidReplayFirstChapterConflict: chapterNumber > 1,
    allowedEntryModes: continuityGuard?.allowedEntryModes || ["direct_resume"],
    mandatoryEvidenceRefs: continuityGuard?.mandatoryEvidenceRefs || [],
    chapterSlotMission: chapterSlot?.mission || "",
    expectedCarryover: chapterSlot?.expectedCarryover || "",
    forbidReplayBeats: chapterSlot?.forbidReplayBeats || [],
  };
}

function sanitizeLowerPriorityText(value, replacement, conflicts, source, field, reason) {
  const text = String(value || "").trim();
  if (!text) {
    return text;
  }
  let next = text;
  if (RESTART_OPENING_PATTERN.test(next) || IDENTITY_RECONFIRM_PATTERN.test(next)) {
    conflicts.push({
      source,
      field,
      value: text,
      reason,
      resolution: replacement,
    });
    next = replacement;
  }
  if (REPLAY_FIRST_CHAPTER_PATTERN.test(next)) {
    const rewritten = next.replace(/第一次|首次/g, "更高风险的下一次");
    conflicts.push({
      source,
      field,
      value: text,
      reason: "下位上下文把已完成的首次证明重新写成首次发生。",
      resolution: rewritten,
    });
    next = rewritten;
  }
  return next;
}

function sanitizeLowerPriorityList(values, replacement, conflicts, source, field, reason) {
  return normalizeStringList(values, 12)
    .map((item) => sanitizeLowerPriorityText(item, replacement, conflicts, source, field, reason))
    .filter(Boolean);
}

function resolveOutlineContexts({
  chapterBase,
  chapterSlot,
  stagePlanning,
  historyPlanning,
  continuityPlanning,
  openingReferencePacket,
  continuityGuard,
  outlineGenerationContract,
}) {
  const conflicts = [];
  const replacement = chapterSlot?.mission || continuityGuard?.resumeFrom || "承接上一章压力继续推进，不重开开篇。";
  const restartReason = "上位事实/连续性护栏不支持重开第一章式开场。";
  const resolvedStagePlanning = {
    ...stagePlanning,
    chapterMission: sanitizeLowerPriorityText(stagePlanning?.chapterMission, replacement, conflicts, "stagePlanning", "chapterMission", restartReason),
    requiredBeats: sanitizeLowerPriorityList(stagePlanning?.requiredBeats, replacement, conflicts, "stagePlanning", "requiredBeats", restartReason),
    mustPreserve: sanitizeLowerPriorityList(stagePlanning?.mustPreserve, replacement, conflicts, "stagePlanning", "mustPreserve", restartReason),
    suggestedConflictAxis: sanitizeLowerPriorityList(stagePlanning?.suggestedConflictAxis, replacement, conflicts, "stagePlanning", "suggestedConflictAxis", restartReason),
    titleSignals: sanitizeLowerPriorityList(stagePlanning?.titleSignals, replacement, conflicts, "stagePlanning", "titleSignals", restartReason),
    nextPressure: sanitizeLowerPriorityText(stagePlanning?.nextPressure, chapterSlot?.nextHookSeed || replacement, conflicts, "stagePlanning", "nextPressure", restartReason),
  };
  const resolvedContinuityPlanning = sanitizeContinuityPlanningWithGuard({
    ...continuityPlanning,
    entryLink: sanitizeLowerPriorityText(
      continuityPlanning?.entryLink,
      continuityGuard?.resumeFrom || replacement,
      conflicts,
      "continuityPlanning",
      "entryLink",
      restartReason,
    ),
  }, continuityGuard);

  const openingConflicts = [];
  if (openingReferencePacket?.triggered && openingReferencePacket?.suppressedSections?.length) {
    openingConflicts.push({
      source: "openingReferencePacket",
      field: "suppressedSections",
      value: openingReferencePacket.suppressedSections.join("；"),
      reason: "黄金三章参考按章节位降权，避免 chN>1 继承第一章开场模式。",
      resolution: `保留模式：${openingReferencePacket.referenceMode || "continuation/escalation"}`,
    });
  }

  return {
    stagePlanning: resolvedStagePlanning,
    historyPlanning,
    continuityPlanning: resolvedContinuityPlanning,
    openingReferencePacket,
    contextConflicts: {
      chapterId: chapterBase.chapterId,
      generatedAt: nowIso(),
      precedence: [
        "factContext.establishedFacts",
        "previous selected_chapter_outline exitPressure / last scene outcome",
        "chapter slot",
        "historyPlanning",
        "stagePlanning",
        "openingReferencePacket",
      ],
      conflicts: [...conflicts, ...openingConflicts],
      contractSummary: {
        forbidRestartOpening: outlineGenerationContract?.forbidRestartOpening || false,
        allowedEntryModes: outlineGenerationContract?.allowedEntryModes || [],
        mandatoryEvidenceRefs: outlineGenerationContract?.mandatoryEvidenceRefs || [],
      },
    },
  };
}

function auditChapterOutlineCandidate(candidate, contract = {}, chapterSlot = null, characterKnowledgeBoundary = null) {
  const firstScene = candidate?.chapterPlan?.scenes?.[0] || null;
  const firstSceneText = stringifyForGovernance({
    entryLink: candidate?.chapterPlan?.entryLink,
    label: firstScene?.label,
    focus: firstScene?.focus,
    scenePurpose: firstScene?.scenePurpose,
    inheritsFromPrevious: firstScene?.inheritsFromPrevious,
    outcome: firstScene?.outcome,
    tension: firstScene?.tension,
  });
  const deterministicIssues = [];
  if (contract?.forbidRestartOpening && RESTART_OPENING_PATTERN.test(firstSceneText)) {
    deterministicIssues.push("第一场含有惊醒/醒来/穿越式重开开篇元素，违反 forbidRestartOpening。");
  }
  if (IDENTITY_RECONFIRM_PATTERN.test(firstSceneText)) {
    deterministicIssues.push("第一场重新确认身份或自己是谁，和已定稿连续性冲突。");
  }
  if (REPLAY_FIRST_CHAPTER_PATTERN.test(firstSceneText)) {
    deterministicIssues.push("第一场把已完成的开篇立威/证明重写成首次发生。");
  }
  const knowledgeBoundaryIssues = collectUnsupportedCharacterKnowledgeClaims(candidate, characterKnowledgeBoundary);
  const issues = normalizeStringList([
    ...deterministicIssues,
    ...knowledgeBoundaryIssues,
  ], 12);
  return {
    proposalId: candidate?.proposalId || "",
    passed: issues.length === 0,
    score: issues.length ? Math.max(0, 100 - (issues.length * 35)) : 100,
    issues,
    warnings: [],
    firstSceneText: createExcerpt(firstSceneText, 320),
  };
}

function auditChapterOutlineCandidates(candidates = [], contract = {}, chapterSlot = null, characterKnowledgeBoundary = null) {
  const audits = (Array.isArray(candidates) ? candidates : []).map((candidate) =>
    auditChapterOutlineCandidate(candidate, contract, chapterSlot, characterKnowledgeBoundary));
  const acceptedIds = new Set(audits.filter((item) => item.passed).map((item) => item.proposalId));
  const accepted = candidates.filter((candidate) => acceptedIds.has(candidate.proposalId));
  return {
    generatedAt: nowIso(),
    passed: accepted.length > 0,
    acceptedProposalIds: accepted.map((item) => item.proposalId),
    rejectedProposalIds: audits.filter((item) => !item.passed).map((item) => item.proposalId),
    audits,
    accepted,
  };
}

function normalizeOutlineConsistencySeverity(value, fallback = "warning") {
  const normalized = String(value || "").trim();
  return ["critical", "warning", "info"].includes(normalized) ? normalized : fallback;
}

function outlineConsistencyPenalty(issue) {
  if (issue?.severity === "critical") {
    return 35;
  }
  if (issue?.severity === "warning") {
    return 10;
  }
  return 3;
}

function normalizeOutlineConsistencyIssue(rawIssue, index = 0, source = "semantic") {
  if (!rawIssue || typeof rawIssue !== "object") {
    return null;
  }

  const description = String(rawIssue.description || "").trim();
  if (!description) {
    return null;
  }

  return {
    id: String(rawIssue.id || "").trim() || `outline_consistency_issue_${index + 1}`,
    severity: normalizeOutlineConsistencySeverity(rawIssue.severity),
    category: String(rawIssue.category || "细纲连续性").trim() || "细纲连续性",
    description,
    evidence: String(rawIssue.evidence || "").trim(),
    suggestion: String(rawIssue.suggestion || "").trim(),
    source,
  };
}

function deterministicOutlineIssueId(text = "") {
  if (/角色知识边界|情报来源边界|缺少证据支持其知道/u.test(text)) {
    return "outline_character_knowledge_boundary";
  }
  if (/首次证明|首次立威/u.test(text)) {
    return "outline_replay_first_chapter_conflict";
  }
  if (/身份|自己是谁/u.test(text)) {
    return "outline_identity_reconfirmation";
  }
  if (/惊醒|醒来|穿越/u.test(text)) {
    return "outline_restart_opening";
  }
  if (/承接|exitPressure|expectedCarryover/u.test(text)) {
    return "outline_previous_pressure_carryover";
  }
  return "outline_first_scene_continuity";
}

function deterministicOutlineSuggestion(text = "", severity = "critical") {
  if (/角色知识边界|情报来源边界|缺少证据支持其知道/u.test(text)) {
    return "删除由该角色供出/掌握的无证据情报；改用已出场账册、旁证、许三娘或李凡已有判断推进，或保留为未证实疑问。";
  }
  if (/首次证明|首次立威/u.test(text)) {
    return "改写成上一章结果上的更高风险下一步，不要把已完成事件重写成首次发生。";
  }
  if (/身份|自己是谁/u.test(text)) {
    return "删除身份重确认，直接承接上一章已成立的身份和盘面压力。";
  }
  if (/惊醒|醒来|穿越/u.test(text)) {
    return "把开场改成 direct_resume 或明确转场承压，不要复用第一章式冷启动。";
  }
  if (/承接|exitPressure|expectedCarryover/u.test(text)) {
    return "在第一场写清楚上一章留下的动作压力、本章入口和当场目标。";
  }
  return severity === "critical"
    ? "删除与上章承接合同冲突的开场或场景安排。"
    : "补强与上章压力、chapter slot 承接要求之间的显式连接。";
}

function createDeterministicOutlineIssues(candidateAudit) {
  const firstSceneEvidence = String(candidateAudit?.firstSceneText || "").trim();
  const criticalIssues = (candidateAudit?.issues || [])
    .map((description, index) => normalizeOutlineConsistencyIssue({
      id: deterministicOutlineIssueId(description),
      severity: "critical",
      category: "开场承接",
      description,
      evidence: firstSceneEvidence,
      suggestion: deterministicOutlineSuggestion(description, "critical"),
    }, index, "deterministic"))
    .filter(Boolean);
  const warnings = (candidateAudit?.warnings || [])
    .map((description, index) => normalizeOutlineConsistencyIssue({
      id: deterministicOutlineIssueId(description),
      severity: "warning",
      category: "开场承接",
      description,
      evidence: firstSceneEvidence,
      suggestion: deterministicOutlineSuggestion(description, "warning"),
    }, index, "deterministic"))
    .filter(Boolean);

  return [...criticalIssues, ...warnings];
}

function computeOutlineConsistencyScore(issues = [], semanticScore = null) {
  const base = Number.isFinite(Number(semanticScore)) ? Number(semanticScore) : 100;
  const penalty = (Array.isArray(issues) ? issues : [])
    .reduce((sum, issue) => sum + outlineConsistencyPenalty(issue), 0);
  return Math.max(0, Math.min(100, Math.round(base - penalty)));
}

function defaultOutlineConsistencySummary(proposalId, issues = []) {
  const criticalCount = issues.filter((item) => item.severity === "critical").length;
  const warningCount = issues.filter((item) => item.severity === "warning").length;
  const infoCount = issues.filter((item) => item.severity === "info").length;
  if (!criticalCount && !warningCount && !infoCount) {
    return `${proposalId || "候选"} 的细纲连续性检查通过。`;
  }
  const parts = [];
  if (criticalCount) {
    parts.push(`critical ${criticalCount} 条`);
  }
  if (warningCount) {
    parts.push(`warning ${warningCount} 条`);
  }
  if (infoCount) {
    parts.push(`info ${infoCount} 条`);
  }
  return `${proposalId || "候选"} 存在${parts.join("、")}连续性问题。`;
}

function mergeOutlineCandidateAudits(candidates = [], deterministicAudit = {}, semanticAudit = {}) {
  const deterministicMap = new Map((deterministicAudit?.audits || []).map((item) => [item.proposalId, item]));
  const semanticMap = new Map((semanticAudit?.candidateAudits || []).map((item) => [item.proposalId, item]));

  return (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
    const proposalId = String(candidate?.proposalId || `proposal_${index + 1}`).trim() || `proposal_${index + 1}`;
    const deterministicEntry = deterministicMap.get(proposalId) || null;
    const semanticEntry = semanticMap.get(proposalId) || null;
    const issues = [
      ...createDeterministicOutlineIssues(deterministicEntry),
      ...((semanticEntry?.issues || []).map((issue, issueIndex) =>
        normalizeOutlineConsistencyIssue(issue, issueIndex, "semantic")).filter(Boolean)),
    ];
    if (
      !semanticAudit?.auditDegraded &&
      semanticAudit?.source !== "skipped" &&
      deterministicEntry?.passed &&
      !semanticEntry
    ) {
      issues.push(normalizeOutlineConsistencyIssue({
        id: "outline_consistency_missing_semantic_result",
        severity: "critical",
        category: "细纲连续性",
        description: "该候选缺少语义一致性审计结果，不能安全进入正文生成。",
        evidence: proposalId,
        suggestion: "重新执行细纲一致性审计，或进入人工复核。",
      }, issues.length, "semantic"));
    }
    const revisionNotes = normalizeStringList([
      ...issues.map((issue) => issue.suggestion),
      ...(semanticEntry?.revisionNotes || []),
    ], 10);
    const passed = Boolean(!semanticAudit?.auditDegraded && issues.every((issue) => issue.severity !== "critical"));
    const score = computeOutlineConsistencyScore(issues, semanticEntry?.score);

    return {
      proposalId,
      passed,
      score,
      summary: String(semanticEntry?.summary || "").trim() || defaultOutlineConsistencySummary(proposalId, issues),
      issues,
      revisionNotes,
      deterministic: deterministicEntry,
      semantic: semanticEntry,
    };
  });
}

function sortCandidatesByOutlineAudit(candidates = [], candidateAudits = []) {
  const auditById = new Map((Array.isArray(candidateAudits) ? candidateAudits : []).map((item) => [item.proposalId, item]));
  return [...(Array.isArray(candidates) ? candidates : [])].sort((left, right) => {
    const leftAudit = auditById.get(left?.proposalId) || { passed: false, score: 0 };
    const rightAudit = auditById.get(right?.proposalId) || { passed: false, score: 0 };
    if (leftAudit.passed !== rightAudit.passed) {
      return leftAudit.passed ? -1 : 1;
    }
    if (leftAudit.score !== rightAudit.score) {
      return rightAudit.score - leftAudit.score;
    }
    return String(left?.proposalId || "").localeCompare(String(right?.proposalId || ""));
  });
}

function outlineProposalId(proposal = null) {
  return String(proposal?.proposalId || proposal?.id || "").trim();
}

function rawOutlineProposalFromCandidate(candidate = null) {
  const chapterPlan = candidate?.chapterPlan && typeof candidate.chapterPlan === "object"
    ? candidate.chapterPlan
    : null;
  if (!chapterPlan) {
    return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
  }

  return {
    ...candidate,
    title: chapterPlan.title || candidate.title,
    timeInStory: chapterPlan.timeInStory,
    povCharacter: chapterPlan.povCharacter,
    location: chapterPlan.location,
    keyEvents: chapterPlan.keyEvents,
    arcContribution: chapterPlan.arcContribution,
    nextHook: chapterPlan.nextHook,
    emotionalTone: chapterPlan.emotionalTone,
    threadMode: chapterPlan.threadMode,
    dominantThread: chapterPlan.dominantThread,
    entryLink: chapterPlan.entryLink,
    exitPressure: chapterPlan.exitPressure,
    charactersPresent: chapterPlan.charactersPresent,
    continuityAnchors: chapterPlan.continuityAnchors,
    scenes: chapterPlan.scenes,
  };
}

function outlineProposalWithId(proposal = null, proposalId = "") {
  const normalizedProposalId = String(proposalId || outlineProposalId(proposal)).trim();
  const rawProposal = rawOutlineProposalFromCandidate(proposal);
  const originalProposalId = outlineProposalId(rawProposal);
  return {
    ...rawProposal,
    proposalId: normalizedProposalId || originalProposalId,
    repairSourceProposalId: originalProposalId && originalProposalId !== normalizedProposalId
      ? originalProposalId
      : rawProposal.repairSourceProposalId,
  };
}

function outlineProposalIdMatches(sourceProposalId = "", repairedProposalId = "") {
  const sourceId = String(sourceProposalId || "").trim();
  const repairedId = String(repairedProposalId || "").trim();
  if (!sourceId || !repairedId) {
    return false;
  }
  return repairedId === sourceId ||
    repairedId.startsWith(`${sourceId}_`) ||
    repairedId.startsWith(`${sourceId}-`);
}

function alignRepairedOutlineProposals(repairedProposals = [], sourceCandidates = []) {
  const sourceList = (Array.isArray(sourceCandidates) ? sourceCandidates : [])
    .filter((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
  const repairedList = (Array.isArray(repairedProposals) ? repairedProposals : [])
    .filter((proposal) => proposal && typeof proposal === "object" && !Array.isArray(proposal));

  if (!sourceList.length) {
    return repairedList;
  }

  const repairedById = new Map();
  repairedList.forEach((proposal, index) => {
    const proposalId = outlineProposalId(proposal);
    if (proposalId && !repairedById.has(proposalId)) {
      repairedById.set(proposalId, { proposal, index });
    }
  });

  const usedIndexes = new Set();
  const aligned = sourceList.map((candidate, candidateIndex) => {
    const expectedProposalId = outlineProposalId(candidate) || `proposal_${candidateIndex + 1}`;
    const exactMatch = repairedById.get(expectedProposalId) || null;
    if (exactMatch && !usedIndexes.has(exactMatch.index)) {
      usedIndexes.add(exactMatch.index);
      return {
        expectedProposalId,
        proposal: outlineProposalWithId(exactMatch.proposal, expectedProposalId),
      };
    }

    return { expectedProposalId, proposal: null };
  });

  aligned.forEach((item) => {
    if (item.proposal) {
      return;
    }
    const fuzzyIndex = repairedList.findIndex((proposal, index) =>
      !usedIndexes.has(index) && outlineProposalIdMatches(item.expectedProposalId, outlineProposalId(proposal)));
    if (fuzzyIndex !== -1) {
      usedIndexes.add(fuzzyIndex);
      item.proposal = outlineProposalWithId(repairedList[fuzzyIndex], outlineProposalId(repairedList[fuzzyIndex]));
    }
  });

  return aligned.map((item, candidateIndex) => {
    if (item.proposal) {
      return item.proposal;
    }

    const fallbackIndex = repairedList.findIndex((proposal, index) => !usedIndexes.has(index));
    if (fallbackIndex !== -1) {
      usedIndexes.add(fallbackIndex);
      return outlineProposalWithId(
        repairedList[fallbackIndex],
        outlineProposalId(repairedList[fallbackIndex]) || item.expectedProposalId,
      );
    }

    const candidate = sourceList[candidateIndex];
    return outlineProposalWithId({
      ...rawOutlineProposalFromCandidate(candidate),
      diffSummary: `${String(candidate?.diffSummary || "").trim()}（修复 Agent 未返回此候选，系统保留原候选以维持请求的方案数。）`.trim(),
    }, item.expectedProposalId);
  });
}

function summarizeOutlineAuditReasons(candidateAudits = [], limit = 10) {
  return normalizeStringList(
    (Array.isArray(candidateAudits) ? candidateAudits : [])
      .flatMap((candidateAudit) =>
        (candidateAudit?.issues || [])
          .filter((issue) => issue.severity === "critical" || issue.severity === "warning")
          .map((issue) => `${candidateAudit.proposalId}:${issue.description}`)),
    limit,
  );
}

function buildOutlineConsistencyAuditInput({
  project,
  chapterBase,
  chapterSlot,
  continuityGuard,
  outlineGenerationContract,
  historyPlanning,
  continuityPlanning,
  factContext,
  timelineContext = null,
  characterKnowledgeBoundary = null,
  committedOutlines = [],
  candidates = [],
}) {
  const factSections = buildFactPromptSections(factContext);
  const previousOutline = [...committedOutlines]
    .filter((item) => Number(item?.chapterNumber || 0) < Number(chapterBase?.chapterNumber || 0))
    .sort((left, right) => Number(left.chapterNumber || 0) - Number(right.chapterNumber || 0))
    .at(-1) || null;

  return [
    projectSummary(project),
    `当前章节：${chapterBase.chapterId}（第 ${chapterBase.chapterNumber} 章）`,
    `章节锚点：${chapterSlot ? JSON.stringify({
      mission: chapterSlot.mission,
      expectedCarryover: chapterSlot.expectedCarryover,
      expectedEscalation: chapterSlot.expectedEscalation,
      forbidReplayBeats: chapterSlot.forbidReplayBeats,
    }) : "无"}`,
    `连续性护栏：${continuityGuard ? JSON.stringify({
      defaultEntryMode: continuityGuard.defaultEntryMode,
      allowedEntryModes: continuityGuard.allowedEntryModes,
      supportsWakeAfterUnconsciousness: continuityGuard.supportsWakeAfterUnconsciousness,
      resumeFrom: continuityGuard.resumeFrom,
      previousActionPressure: continuityGuard.previousActionPressure,
      forbiddenRestartTerms: continuityGuard.forbiddenRestartTerms,
      mandatoryEvidenceRefs: continuityGuard.mandatoryEvidenceRefs,
    }) : "无"}`,
    `细纲生成合同：${outlineGenerationContract ? JSON.stringify(outlineGenerationContract) : "无"}`,
    `历史承接：余波=${historyPlanning?.lastEnding || "无"}｜优先线程=${(historyPlanning?.priorityThreads || []).join("；") || "无"}｜未完线程=${(historyPlanning?.openThreads || []).join("；") || "无"}｜不可冲突点=${(historyPlanning?.mustNotContradict || []).join("；") || "无"}`,
    `章节衔接规划：入口=${continuityPlanning?.entryLink || "无"}｜主承接线程=${continuityPlanning?.dominantCarryoverThread || "无"}｜必须推进到=${continuityPlanning?.mustAdvanceThisChapter || "无"}｜章末递交压力=${continuityPlanning?.exitPressureToNextChapter || "无"}`,
    `必须继承的已定事实：${factSections.establishedFactsLine}`,
    `可以继续发酵但不能改写底层结论的开放张力：${factSections.openTensionsLine}`,
    `时间线合同：\n${timelineContext?.briefingMarkdown || "无"}`,
    `角色知识边界：\n${renderCharacterKnowledgeBoundary(characterKnowledgeBoundary)}`,
    `上一章锁定细纲：\n${previousOutline ? [
      `- 章节：${previousOutline.chapterId} ${previousOutline.title}`,
      `- 主线：${previousOutline.dominantThread || "无"}`,
      `- 关键事件：${(previousOutline.keyEvents || []).join("；") || "无"}`,
      `- 场景链：${(previousOutline.sceneChain || []).join(" || ") || "无"}`,
      `- 章末压力：${previousOutline.exitPressure || previousOutline.nextHook || "无"}`,
    ].join("\n") : "无（当前为开篇章节）"}`,
    `最近锁章摘要：\n${expandCommittedHistoryDetails(committedOutlines, chapterBase, 4) || "无已锁定历史细纲"}`,
    `待审候选：\n${(Array.isArray(candidates) ? candidates : []).map((candidate) => JSON.stringify({
      proposalId: candidate.proposalId,
      summary: candidate.summary,
      rationale: candidate.rationale,
      diffSummary: candidate.diffSummary,
      chapterPlan: candidate.chapterPlan,
    }, null, 2)).join("\n\n") || "无候选"}`,
  ].join("\n\n");
}

async function runChapterOutlineConsistencyAuditAgent({
  provider,
  project,
  chapterBase,
  chapterSlot,
  continuityGuard,
  outlineGenerationContract,
  historyPlanning,
  continuityPlanning,
  factContext,
  timelineContext = null,
  characterKnowledgeBoundary = null,
  committedOutlines = [],
  candidates = [],
}) {
  const result = await provider.generateText({
    agentComplexity: "complex",
    instructions:
      "你是 Novelex 的 ChapterOutlineConsistencyAuditAgent。你负责审计章节细纲候选的整章跨章节一致性。重点检查：已定事实是否被重置、历史事实是否冲突、人物知识是否越界、未完线程是否断裂、章末压力是否真正递交、是否提前兑现未来伏笔、以及中段是否把第一章/上一章已完成事件重演。critical 会阻断进入正文；warning 只提醒。只输出 JSON。",
    input: [
      buildOutlineConsistencyAuditInput({
        project,
        chapterBase,
        chapterSlot,
        continuityGuard,
        outlineGenerationContract,
        historyPlanning,
        continuityPlanning,
        factContext,
        timelineContext,
        characterKnowledgeBoundary,
        committedOutlines,
        candidates,
      }),
      `请输出 JSON：
{
  "summary": "一句话概括本轮细纲一致性审计",
  "candidateAudits": [
    {
      "proposalId": "proposal_1",
      "passed": true,
      "score": 92,
      "summary": "这个候选的一句结论",
      "issues": [
        {
          "id": "canon_fact_continuity",
          "severity": "critical",
          "category": "既定事实连续性",
          "description": "问题描述",
          "evidence": "证据",
          "suggestion": "如何修"
        }
      ],
      "revisionNotes": ["修复建议1", "修复建议2"]
    }
  ]
}`,
    ].join("\n\n"),
    metadata: {
      feature: "chapter_outline_consistency_audit",
      chapterId: chapterBase.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`ChapterOutlineConsistencyAuditAgent 返回了无法解析的 JSON：${createExcerpt(result.text || "", 240)}`);
  }

  return {
    summary: String(parsed.summary || "").trim(),
    candidateAudits: (Array.isArray(parsed.candidateAudits) ? parsed.candidateAudits : [])
      .map((item, index) => ({
        proposalId: String(item?.proposalId || `proposal_${index + 1}`).trim() || `proposal_${index + 1}`,
        passed: Boolean(item?.passed),
        score: Number.isFinite(Number(item?.score)) ? Math.max(0, Math.min(100, Math.round(Number(item.score)))) : 82,
        summary: String(item?.summary || "").trim(),
        issues: (Array.isArray(item?.issues) ? item.issues : [])
          .map((issue, issueIndex) => normalizeOutlineConsistencyIssue(issue, issueIndex, "semantic"))
          .filter(Boolean),
        revisionNotes: normalizeStringList(item?.revisionNotes, 8),
      })),
  };
}

async function runChapterOutlineConsistencyAuditWithRetry(options) {
  let lastError = null;
  for (let attempt = 1; attempt <= OUTLINE_CONSISTENCY_AUDIT_RETRIES; attempt += 1) {
    try {
      const result = await runChapterOutlineConsistencyAuditAgent(options);
      return {
        ...result,
        attempts: attempt,
        auditDegraded: false,
        error: "",
        source: attempt > 1 ? "agent_retry" : "agent",
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    summary: "",
    candidateAudits: [],
    attempts: OUTLINE_CONSISTENCY_AUDIT_RETRIES,
    auditDegraded: true,
    error: lastError instanceof Error ? lastError.message : String(lastError || "Unknown error"),
    source: "degraded",
  };
}

async function runChapterOutlineRepairAgent({
  provider,
  project,
  bundle,
  resources,
  candidates = [],
  candidateAudits = [],
  repairAttempt = 1,
  authorFeedback = "",
}) {
  const factSections = buildFactPromptSections(resources.factContext);
  const result = await provider.generateText({
    agentComplexity: "complex",
    instructions:
      "你是 Novelex 的 ChapterOutlineRepairAgent。你会看到一组细纲候选和它们的一致性审计问题。请在保留可用场景资产、人物焦点和有效推进方向的前提下，修复跨章节连续性冲突。不要删成空壳，不要重开第一章式开场，不要重置已定事实。尽量保留原 proposalId。只输出 JSON。",
    input: [
      projectSummary(project),
      `当前章节：${resources.chapterBase.chapterId}（第 ${resources.chapterBase.chapterNumber} 章）`,
      `修复轮次：第 ${repairAttempt} 轮`,
      `章节锚点：${resources.chapterSlot ? JSON.stringify({
        mission: resources.chapterSlot.mission,
        expectedCarryover: resources.chapterSlot.expectedCarryover,
        expectedEscalation: resources.chapterSlot.expectedEscalation,
        forbidReplayBeats: resources.chapterSlot.forbidReplayBeats,
      }) : "无"}`,
      `连续性护栏：${resources.continuityGuard ? JSON.stringify({
        defaultEntryMode: resources.continuityGuard.defaultEntryMode,
        allowedEntryModes: resources.continuityGuard.allowedEntryModes,
        resumeFrom: resources.continuityGuard.resumeFrom,
        forbiddenRestartTerms: resources.continuityGuard.forbiddenRestartTerms,
        mandatoryEvidenceRefs: resources.continuityGuard.mandatoryEvidenceRefs,
      }) : "无"}`,
      `历史承接：余波=${resources.chapterOutlineContext?.historyPlanning?.lastEnding || "无"}｜优先线程=${(resources.chapterOutlineContext?.historyPlanning?.priorityThreads || []).join("；") || "无"}｜不可冲突点=${(resources.chapterOutlineContext?.historyPlanning?.mustNotContradict || []).join("；") || "无"}`,
      `章节衔接：入口=${resources.chapterOutlineContext?.continuityPlanning?.entryLink || "无"}｜主承接线程=${resources.chapterOutlineContext?.continuityPlanning?.dominantCarryoverThread || "无"}｜章末递交压力=${resources.chapterOutlineContext?.continuityPlanning?.exitPressureToNextChapter || "无"}`,
      `必须继承的已定事实：${factSections.establishedFactsLine}`,
      `可以继续发酵但不能改写底层结论的开放张力：${factSections.openTensionsLine}`,
      `时间线合同：\n${resources.timelineContext?.briefingMarkdown || resources.chapterOutlineContext?.timelineContext?.briefingMarkdown || "无"}`,
      `角色知识边界：\n${renderCharacterKnowledgeBoundary(resources.characterKnowledgeBoundary || resources.chapterOutlineContext?.characterKnowledgeBoundary || null)}`,
      authorFeedback ? `作者补充要求：${authorFeedback}` : "",
      `待修候选数量：${(Array.isArray(candidates) ? candidates : []).length}。必须为每个待修候选返回且仅返回一个修复后 proposal；优先保留原 proposalId，且不得合并或省略候选。`,
      `待修候选 proposalId：${(Array.isArray(candidates) ? candidates : []).map((candidate) => candidate.proposalId).join("、") || "无"}`,
      `待修候选与问题：\n${(Array.isArray(candidates) ? candidates : []).map((candidate) => {
        const audit = (candidateAudits || []).find((item) => item.proposalId === candidate.proposalId) || null;
        return [
          `## ${candidate.proposalId}`,
          `原方案：${JSON.stringify(candidate, null, 2)}`,
          `问题：${(audit?.issues || []).map((issue) => `[${issue.severity}] ${issue.description}`).join("；") || "无"}`,
          `修复要点：${(audit?.revisionNotes || []).join("；") || "无"}`,
        ].join("\n");
      }).join("\n\n") || "无候选"}`,
      `请输出 JSON：
{
  "proposals": [
    {
      "proposalId": "proposal_1",
      "summary": "修复后的一句话概括",
      "rationale": "保留了什么，修掉了什么",
      "diffSummary": "这轮修复最关键的变化",
      "title": "章节标题",
      "timeInStory": "故事时间",
      "povCharacter": "角色名",
      "location": "章节主地点",
      "keyEvents": ["事件1", "事件2"],
      "arcContribution": ["弧光1"],
      "nextHook": "章末钩子",
      "emotionalTone": "情绪基调",
      "threadMode": "single_spine",
      "dominantThread": "本章主线一句话",
      "entryMode": "direct_resume",
      "entryLink": "本章开场承接点",
      "exitPressure": "本章末尾递交给下一章的直接压力",
      "charactersPresent": ["角色A", "角色B"],
      "continuityAnchors": ["连续性锚点1", "连续性锚点2"],
      "evidenceRefs": ["ref_1"],
      "scenes": [
        {
          "label": "场景标签",
          "location": "地点",
          "focus": "场景任务",
          "tension": "张力",
          "characters": ["角色A"],
          "threadId": "main",
          "scenePurpose": "作用",
          "inheritsFromPrevious": "承接",
          "outcome": "结果",
          "handoffToNext": "交棒"
        }
      ]
    }
  ]
}`,
    ].filter(Boolean).join("\n\n"),
    metadata: {
      feature: "chapter_outline_repair",
      chapterId: resources.chapterBase.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`ChapterOutlineRepairAgent 返回了无法解析的 JSON：${createExcerpt(result.text || "", 240)}`);
  }

  const proposals = Array.isArray(parsed.proposals)
    ? parsed.proposals
    : Array.isArray(parsed.candidates)
      ? parsed.candidates
      : [];

  if (!proposals.length) {
    throw new Error("ChapterOutlineRepairAgent 没有返回可用候选。");
  }

  return alignRepairedOutlineProposals(proposals, candidates)
    .map((proposal, index) => normalizeOutlineProposal(proposal, index, {
      chapterBase: resources.chapterBase,
      bundle,
      stagePlanning: resources.chapterOutlineContext.stagePlanning,
      characterPlanning: resources.chapterOutlineContext.characterPlanning,
      historyPlanning: resources.chapterOutlineContext.historyPlanning,
      continuityPlanning: resources.chapterOutlineContext.continuityPlanning,
      factContext: resources.factContext,
      foreshadowingActions: resources.foreshadowingActions,
    }));
}

function buildOutlineConsistencyRunStep(outlineContinuityAudit = {}) {
  const candidateAudits = Array.isArray(outlineContinuityAudit?.candidateAudits)
    ? outlineContinuityAudit.candidateAudits
    : [];
  const criticalCount = candidateAudits.reduce(
    (sum, item) => sum + (item?.issues || []).filter((issue) => issue.severity === "critical").length,
    0,
  );
  const warningCount = candidateAudits.reduce(
    (sum, item) => sum + (item?.issues || []).filter((issue) => issue.severity === "warning").length,
    0,
  );
  const degraded = Boolean(outlineContinuityAudit?.auditDegraded);

  return step(
    "outline_consistency_audit_agent",
    "ChapterOutlineConsistencyAuditAgent",
    "write",
    degraded
      ? `细纲语义一致性审计失败并降级，已停止自动放行。${outlineContinuityAudit?.error ? ` ${outlineContinuityAudit.error}` : ""}`
      : `细纲语义一致性审计完成：critical ${criticalCount} / warning ${warningCount}，通过候选 ${outlineContinuityAudit?.acceptedProposalIds?.length || 0} 个。`,
    {
      preview: createExcerpt(
        String(outlineContinuityAudit?.summary || "") ||
          summarizeOutlineAuditReasons(candidateAudits).join("；") ||
          "无额外审计摘要。",
        180,
      ),
    },
  );
}

function buildOutlineRepairRunSteps(outlineContinuityAudit = {}) {
  return (Array.isArray(outlineContinuityAudit?.attempts) ? outlineContinuityAudit.attempts : [])
    .filter((attempt) => attempt?.repairApplied)
    .map((attempt) => step(
      `outline_repair_agent_${attempt.attempt}`,
      "ChapterOutlineRepairAgent",
      "write",
      `第 ${attempt.attempt} 轮细纲一致性修复已执行。`,
      {
        preview: createExcerpt(
          [
            summarizeOutlineAuditReasons(attempt?.candidateAudits || [], 6).join("；"),
            ...(attempt?.repairNotes || []),
          ].filter(Boolean).join("；") || `候选：${(attempt?.proposalIds || []).join(" / ")}`,
          180,
        ),
      },
    ));
}

async function runChapterOutlineConsistencyLoop({
  provider,
  project,
  bundle,
  resources,
  initialCandidates = [],
  chapterOutlineHistory = [],
  feedback = "",
  keepAllCandidatesOnSuccess = false,
  desiredCandidateCount = null,
}) {
  let currentCandidates = Array.isArray(initialCandidates) ? initialCandidates : [];
  const hasDesiredCandidateCount = desiredCandidateCount !== null && desiredCandidateCount !== undefined && desiredCandidateCount !== "";
  const requestedCandidateCount = Number(desiredCandidateCount);
  const enforceCandidateCount = hasDesiredCandidateCount && Number.isFinite(requestedCandidateCount);
  const targetCandidateCount = enforceCandidateCount
    ? Math.max(1, Math.min(
      OUTLINE_VARIANT_COUNT_LIMITS.max,
      Math.round(requestedCandidateCount),
      Math.max(1, currentCandidates.length),
    ))
    : 1;
  const attempts = [];
  let auditDegraded = false;
  let manualReviewRequired = false;
  let finalCandidateAudits = [];
  let finalAcceptedProposalIds = [];
  let finalRejectedProposalIds = [];
  let lastSummary = "";
  let lastError = "";

  for (let attempt = 1; attempt <= OUTLINE_CONSISTENCY_MAX_ATTEMPTS; attempt += 1) {
    const deterministic = auditChapterOutlineCandidates(
      currentCandidates,
      resources.outlineGenerationContract,
      resources.chapterSlot,
      resources.characterKnowledgeBoundary || resources.chapterOutlineContext?.characterKnowledgeBoundary || null,
    );
    const semanticCandidates = deterministic.accepted;
    const semantic = semanticCandidates.length
      ? await runChapterOutlineConsistencyAuditWithRetry({
        provider,
        project,
        chapterBase: resources.chapterBase,
        chapterSlot: resources.chapterSlot,
        continuityGuard: resources.continuityGuard,
        outlineGenerationContract: resources.outlineGenerationContract,
        historyPlanning: resources.chapterOutlineContext.historyPlanning,
        continuityPlanning: resources.chapterOutlineContext.continuityPlanning,
        factContext: resources.factContext,
        timelineContext: resources.timelineContext || resources.chapterOutlineContext?.timelineContext || null,
        characterKnowledgeBoundary: resources.characterKnowledgeBoundary || resources.chapterOutlineContext?.characterKnowledgeBoundary || null,
        committedOutlines: resources.committedOutlines || [],
        candidates: semanticCandidates,
      })
      : {
        summary: "所有候选都在 deterministic 审计阶段被拦截，未进入语义审计。",
        candidateAudits: [],
        attempts: 0,
        auditDegraded: false,
        error: "",
        source: "skipped",
      };
    const candidateAudits = mergeOutlineCandidateAudits(currentCandidates, deterministic, semantic);
    const acceptedProposalIds = candidateAudits.filter((item) => item.passed).map((item) => item.proposalId);
    const rejectedProposalIds = candidateAudits.filter((item) => !item.passed).map((item) => item.proposalId);
    const repairNotes = summarizeOutlineAuditReasons(candidateAudits, 12);

    finalCandidateAudits = candidateAudits;
    finalAcceptedProposalIds = acceptedProposalIds;
    finalRejectedProposalIds = rejectedProposalIds;
    lastSummary = semantic.summary || defaultOutlineConsistencySummary(resources.chapterBase.chapterId, candidateAudits.flatMap((item) => item.issues || []));
    lastError = semantic.error || "";

    chapterOutlineHistory.push({
      at: nowIso(),
      action: "outline_consistency_audit",
      chapterId: resources.chapterBase.chapterId,
      chapterNumber: resources.chapterBase.chapterNumber,
      attempt,
      acceptedProposalIds,
      rejectedProposalIds,
      auditDegraded: Boolean(semantic.auditDegraded),
      summary: lastSummary,
    });
    if (attempt === 1 && repairNotes.length) {
      chapterOutlineHistory.push({
        at: nowIso(),
        action: "outline_audit_regenerate",
        chapterId: resources.chapterBase.chapterId,
        chapterNumber: resources.chapterBase.chapterNumber,
        reasons: repairNotes,
      });
    }

    attempts.push({
      attempt,
      proposalIds: currentCandidates.map((item) => item.proposalId),
      deterministic,
      semantic: {
        summary: semantic.summary,
        source: semantic.source,
        attempts: semantic.attempts,
        auditDegraded: Boolean(semantic.auditDegraded),
        error: semantic.error,
      },
      candidateAudits,
      acceptedProposalIds,
      rejectedProposalIds,
      repairApplied: false,
      repairNotes: [],
    });

    if (semantic.auditDegraded) {
      auditDegraded = true;
      manualReviewRequired = true;
      break;
    }

    if (acceptedProposalIds.length) {
      const sortedAccepted = sortCandidatesByOutlineAudit(
        currentCandidates.filter((candidate) => acceptedProposalIds.includes(candidate.proposalId)),
        candidateAudits,
      );
      if (acceptedProposalIds.length >= targetCandidateCount || attempt >= OUTLINE_CONSISTENCY_MAX_ATTEMPTS) {
        const hasEnoughAcceptedCandidates = acceptedProposalIds.length >= targetCandidateCount;
        currentCandidates = keepAllCandidatesOnSuccess
          || !enforceCandidateCount
          || !hasEnoughAcceptedCandidates
          ? sortCandidatesByOutlineAudit(currentCandidates, candidateAudits)
          : sortedAccepted.slice(0, targetCandidateCount);
        manualReviewRequired = enforceCandidateCount && !hasEnoughAcceptedCandidates;
        break;
      }

      const rejectedCandidates = currentCandidates.filter((candidate) => rejectedProposalIds.includes(candidate.proposalId));
      if (!rejectedCandidates.length) {
        currentCandidates = keepAllCandidatesOnSuccess
          ? sortCandidatesByOutlineAudit(currentCandidates, candidateAudits)
          : sortedAccepted;
        manualReviewRequired = enforceCandidateCount && acceptedProposalIds.length < targetCandidateCount;
        break;
      }

      try {
        const repairedCandidates = await runChapterOutlineRepairAgent({
          provider,
          project,
          bundle,
          resources,
          candidates: rejectedCandidates,
          candidateAudits,
          repairAttempt: attempt,
          authorFeedback: feedback,
        });
        attempts[attempts.length - 1].repairApplied = true;
        attempts[attempts.length - 1].repairTargetProposalIds = rejectedCandidates.map((candidate) => candidate.proposalId);
        attempts[attempts.length - 1].repairNotes = repairedCandidates.map((candidate) => candidate.diffSummary).filter(Boolean).slice(0, 4);
        chapterOutlineHistory.push({
          at: nowIso(),
          action: "outline_consistency_repair",
          chapterId: resources.chapterBase.chapterId,
          chapterNumber: resources.chapterBase.chapterNumber,
          attempt,
          reasons: repairNotes,
          targetProposalIds: rejectedCandidates.map((candidate) => candidate.proposalId),
        });
        currentCandidates = [
          ...sortedAccepted,
          ...repairedCandidates,
        ].slice(0, targetCandidateCount);
      } catch (error) {
        currentCandidates = sortCandidatesByOutlineAudit(currentCandidates, candidateAudits);
        manualReviewRequired = true;
        lastError = error instanceof Error ? error.message : String(error || "");
        break;
      }
      continue;
    }

    if (attempt >= OUTLINE_CONSISTENCY_MAX_ATTEMPTS) {
      manualReviewRequired = true;
      break;
    }

    try {
      const repairedCandidates = await runChapterOutlineRepairAgent({
        provider,
        project,
        bundle,
        resources,
        candidates: currentCandidates,
        candidateAudits,
        repairAttempt: attempt,
        authorFeedback: feedback,
      });
      attempts[attempts.length - 1].repairApplied = true;
      attempts[attempts.length - 1].repairTargetProposalIds = currentCandidates.map((candidate) => candidate.proposalId);
      attempts[attempts.length - 1].repairNotes = repairedCandidates.map((candidate) => candidate.diffSummary).filter(Boolean).slice(0, 4);
      chapterOutlineHistory.push({
        at: nowIso(),
        action: "outline_consistency_repair",
        chapterId: resources.chapterBase.chapterId,
        chapterNumber: resources.chapterBase.chapterNumber,
        attempt,
        reasons: repairNotes,
        targetProposalIds: currentCandidates.map((candidate) => candidate.proposalId),
      });
      currentCandidates = repairedCandidates;
    } catch (error) {
      manualReviewRequired = true;
      lastError = error instanceof Error ? error.message : String(error || "");
      break;
    }
  }

  const passed = finalAcceptedProposalIds.length > 0 && !manualReviewRequired && !auditDegraded;
  if (manualReviewRequired) {
    chapterOutlineHistory.push({
      at: nowIso(),
      action: "outline_consistency_manual_review",
      chapterId: resources.chapterBase.chapterId,
      chapterNumber: resources.chapterBase.chapterNumber,
      reasons: summarizeOutlineAuditReasons(finalCandidateAudits, 12),
      auditDegraded,
      error: lastError,
    });
  }

  return {
    candidates: currentCandidates,
    chapterOutlineHistory,
    outlineContinuityAudit: {
      generatedAt: nowIso(),
      passed,
      acceptedProposalIds: finalAcceptedProposalIds,
      rejectedProposalIds: finalRejectedProposalIds,
      candidateAudits: finalCandidateAudits,
      attempts,
      manualReviewRequired,
      auditDegraded,
      summary: lastSummary || "细纲一致性审计未产出摘要。",
      error: lastError,
    },
  };
}

function buildGuardedFallbackOutlineCandidate({ resources, bundle }) {
  return normalizeOutlineProposal({
    proposalId: "proposal_guarded_fallback",
    summary: "连续性护栏兜底方案：直接承接上一章压力，不重开开篇。",
    rationale: "所有候选触发重开检测后，由系统按章节锚点和连续性合同生成安全候选。",
    diffSummary: "优先保证承接上一章 exitPressure 与章节锚点。",
    title: resources.chapterBase.title,
    timeInStory: resources.chapterBase.timeInStory,
    povCharacter: resources.chapterBase.povCharacter,
    location: resources.chapterBase.location,
    keyEvents: normalizeStringList([
      resources.outlineGenerationContract?.previousPressure,
      resources.chapterSlot?.mission,
      resources.chapterSlot?.expectedEscalation,
    ], 4),
    arcContribution: normalizeStringList([resources.chapterSlot?.expectedEscalation], 3),
    nextHook: resources.chapterSlot?.nextHookSeed || resources.chapterOutlineContext.stagePlanning.nextPressure,
    emotionalTone: "承压推进",
    threadMode: "single_spine",
    dominantThread: resources.chapterOutlineContext.continuityPlanning.dominantCarryoverThread || resources.chapterSlot?.mission,
    entryLink: resources.outlineGenerationContract?.previousPressure || resources.chapterOutlineContext.continuityPlanning.entryLink,
    exitPressure: resources.chapterSlot?.nextHookSeed || resources.chapterOutlineContext.continuityPlanning.exitPressureToNextChapter,
    charactersPresent: resources.chapterBase.charactersPresent,
    continuityAnchors: normalizeStringList([
      resources.chapterSlot?.expectedCarryover,
      ...(resources.chapterSlot?.forbidReplayBeats || []),
    ], 6),
    scenes: [
      {
        label: "承压续场",
        location: resources.chapterBase.location,
        focus: resources.chapterSlot?.mission || resources.chapterOutlineContext.stagePlanning.chapterMission || "承接上一章压力继续推进。",
        tension: resources.outlineGenerationContract?.previousPressure || "上一章留下的直接压力仍未解除。",
        characters: resources.chapterBase.charactersPresent,
        threadId: "main",
        scenePurpose: "把上一章末尾压力接到本章行动现场。",
        inheritsFromPrevious: resources.outlineGenerationContract?.previousPressure || "承接上一章留下的直接压力。",
        outcome: resources.chapterSlot?.expectedEscalation || "本章主问题被推向更高风险。",
        handoffToNext: resources.chapterSlot?.expectedEscalation || "把升级后的压力交给下一场。",
      },
      {
        label: "升级碰撞",
        location: resources.chapterBase.location,
        focus: resources.chapterSlot?.expectedEscalation || "让当前阶段冲突升级。",
        tension: resources.chapterOutlineContext.stagePlanning.nextPressure || "执行代价继续加重。",
        characters: resources.chapterBase.charactersPresent,
        threadId: "main",
        scenePurpose: "把承接压力推进为本章正面碰撞。",
        inheritsFromPrevious: resources.chapterSlot?.mission || "承接前场确认的问题。",
        outcome: resources.chapterSlot?.nextHookSeed || "新的动作压力成形。",
        handoffToNext: resources.chapterSlot?.nextHookSeed || "把压力递交给下一章。",
      },
    ],
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

function chapterSlotReference(bundle, chapterNumber = 0) {
  const chapterSlots = Array.isArray(bundle?.chapterSlots)
    ? bundle.chapterSlots
    : Array.isArray(bundle?.outlineData?.chapterSlots)
      ? bundle.outlineData.chapterSlots
      : [];
  return chapterSlots.find((slot) => Number(slot?.chapterNumber || chapterNumberValue(slot?.chapterId, 0)) === chapterNumber) || null;
}

function fallbackChapterSlot({ project, chapterNumber, stage, foreshadowingActions = [] }) {
  const chapterId = chapterIdFromNumber(chapterNumber);
  return {
    chapterId,
    chapterNumber,
    stage: stage?.label || `阶段${Math.max(1, Number(project.stageCount) || 1)}`,
    titleHint: `第${chapterNumber}章`,
    mission: chapterNumber <= 1
      ? `建立故事的第一轮动作压力，并启动${stage?.stageGoal || project.protagonistGoal || "主线任务"}。`
      : `承接前章结果，推进${stage?.label || "当前阶段"}当前步的核心任务。`,
    locationSeed: project.setting,
    expectedCarryover: chapterNumber <= 1
      ? "从故事前提与主角当下压力直接切入。"
      : "承接上一章已批准正文与锁章细纲的直接余波，不重开开篇。",
    expectedEscalation: chapterNumber <= 1
      ? `尽快把${stage?.stageGoal || project.protagonistGoal || "主线"}推成真实冲突。`
      : `在上一章结果上继续抬高${stage?.stageGoal || "当前阶段"}的行动代价。`,
    nextHookSeed: stage?.stageGoal || project.protagonistGoal || "",
    forbidReplayBeats: chapterNumber <= 1
      ? ["不要把开篇写成背景说明堆砌。"]
      : [
        "不要重新穿越或重新开篇。",
        "不要惊醒后重新确认身份。",
        "不要把已经完成的第一次证明写成首次发生。",
      ],
    foreshadowingIds: normalizeStringList((foreshadowingActions || []).map((item) => item?.id), 8),
    freshStart: chapterNumber === 1,
  };
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
  chapterSlot = null,
  foreshadowingActions = [],
}) {
  const chapterId = chapterIdFromNumber(chapterNumber);
  const slotKeyEvents = normalizeStringList([
    chapterSlot?.mission,
    chapterSlot?.expectedEscalation,
  ], 4);
  const slotAnchors = normalizeStringList([
    chapterSlot?.expectedCarryover,
    ...(chapterSlot?.forbidReplayBeats || []),
  ], 8);
  return {
    chapterId,
    chapterNumber,
    title: legacyPlan?.title || chapterSlot?.titleHint || `第${chapterNumber}章`,
    stage: stage?.label || chapterSlot?.stage || `阶段${Math.max(1, Number(project.stageCount) || 1)}`,
    timeInStory: legacyPlan?.timeInStory || `第${chapterNumber}章对应故事时间`,
    povCharacter: legacyPlan?.povCharacter || project.protagonistName || "主角",
    location: legacyPlan?.location || chapterSlot?.locationSeed || project.setting,
    keyEvents: Array.isArray(legacyPlan?.keyEvents) ? legacyPlan.keyEvents : slotKeyEvents,
    arcContribution: Array.isArray(legacyPlan?.arcContribution) ? legacyPlan.arcContribution : normalizeStringList([chapterSlot?.expectedEscalation], 3),
    nextHook: legacyPlan?.nextHook || chapterSlot?.nextHookSeed || "",
    emotionalTone: legacyPlan?.emotionalTone || "",
    threadMode: normalizeThreadMode(legacyPlan?.threadMode, "single_spine"),
    dominantThread: legacyPlan?.dominantThread || chapterSlot?.mission || "",
    entryLink: legacyPlan?.entryLink || chapterSlot?.expectedCarryover || "",
    exitPressure: legacyPlan?.exitPressure || legacyPlan?.nextHook || chapterSlot?.nextHookSeed || "",
    charactersPresent: Array.isArray(legacyPlan?.charactersPresent) ? legacyPlan.charactersPresent : [project.protagonistName || "主角"],
    foreshadowingActions,
    continuityAnchors: Array.isArray(legacyPlan?.continuityAnchors) ? legacyPlan.continuityAnchors : slotAnchors,
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
    agentComplexity: "simple",
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
      let toolResult;
      try {
        toolResult = await withOperationTimeout(
          mcpManager.callTool("web_search", { query }, {
            chapterId: chapterPlan.chapterId,
            feature: "research_retriever",
          }),
          RESEARCH_MCP_QUERY_TIMEOUT_MS,
          `MCP web_search query timed out after ${RESEARCH_MCP_QUERY_TIMEOUT_MS}ms.`,
        );
      } catch (error) {
        await mcpManager.closeAll().catch(() => {});
        throw error;
      }
      searchPackets.push(normalizeWebSearchToolResult(toolResult, { query }));
    }

    const sources = collectResearchSources(searchPackets);
    if (!sources.length) {
      throw new Error("ResearchRetriever 没有从 MCP web_search 返回可用来源。");
    }

    const result = await provider.generateText({
      agentComplexity: "complex",
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
        agentComplexity: "complex",
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
    agentComplexity: "simple",
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

async function buildGovernanceResources({
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
  provider,
}) {
  return runGovernanceAgent({
    provider,
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
    agentComplexity: "simple",
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
    timelineContext: rewriteContext.timelineContext || null,
    promptTelemetry: rewriteContext.promptTelemetry || null,
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

const CHARACTER_KNOWLEDGE_AUDIT_TERMS = [
  "孙掌柜",
  "月港",
  "海澄",
  "水寨",
  "兑票",
  "欠票",
  "账册",
  "若昂",
  "陈德科",
  "澳门",
  "马尼拉",
  "唐家",
  "唐鹞",
  "巡船",
  "巡哨船",
  "七星礁",
  "官军",
  "封锁",
  "船由",
  "商引",
  "布防",
  "换防",
  "设伏",
  "眼线",
  "追踪",
  "望远镜",
  "外室",
  "货栈",
  "暗门",
  "茶肆",
  "悬赏",
];
const CHARACTER_KNOWLEDGE_CLAIM_PATTERN =
  /知道|知晓|掌握|清楚|吐露|透露|交代|供出|说出|招认|问出|套出|追问|审问|审讯|逼问|提审|盘问|拷问|隐瞒|藏着|藏住|压着|说漏/u;
const NEGATED_KNOWLEDGE_CLAIM_PATTERN = /不知|不知道|并不知道|无从知道|没有证据|缺乏证据|不支持|不能写成|不得写成|禁止/u;

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCharacterKnowledgeBoundary({ characterStates = [], factContext = null } = {}) {
  const states = Array.isArray(characterStates) ? characterStates : [];
  if (!states.length) {
    return null;
  }

  const facts = [
    ...(factContext?.establishedFacts || []),
    ...(factContext?.openTensions || []),
  ];

  const characters = states
    .map((state) => {
      const name = String(state?.name || "").trim();
      if (!name) {
        return null;
      }
      const relationshipText = Object.values(state?.relationships || {})
        .map((relationship) => [
          relationship?.dynamic,
          relationship?.last_interaction_summary,
        ].filter(Boolean).join("；"))
        .join("；");
      const relevantFacts = facts.filter((fact) => stringifyForGovernance({
        subject: fact?.subject,
        assertion: fact?.assertion,
        evidence: fact?.evidence,
      }).includes(name));
      const corpus = [
        name,
        ...(state?.knowledge?.knows || []),
        ...(state?.knowledge?.does_not_know || []),
        ...(state?.psychological?.key_beliefs || []),
        state?.psychological?.current_goal,
        state?.arc_progress?.arc_note,
        relationshipText,
        ...relevantFacts.map((fact) => `${fact?.subject || ""}｜${fact?.assertion || ""}｜${fact?.evidence || ""}`),
      ].filter(Boolean).join("；");
      const supportedTerms = CHARACTER_KNOWLEDGE_AUDIT_TERMS.filter((term) => corpus.includes(term));
      return {
        name,
        supportedTerms: normalizeStringList(supportedTerms, 20),
        knows: normalizeStringList(state?.knowledge?.knows || [], 8),
        doesNotKnow: normalizeStringList(state?.knowledge?.does_not_know || [], 8),
      };
    })
    .filter(Boolean);

  return {
    generatedAt: nowIso(),
    rule: "角色只能吐露、被审出或主动运用其状态与相关事实中已有证据支持的信息；不得把全局粗纲信息自动视为该角色已知。",
    auditTerms: CHARACTER_KNOWLEDGE_AUDIT_TERMS,
    characters,
  };
}

function renderCharacterKnowledgeBoundary(characterKnowledgeBoundary = null) {
  const characters = Array.isArray(characterKnowledgeBoundary?.characters)
    ? characterKnowledgeBoundary.characters
    : [];
  if (!characters.length) {
    return "无角色知识边界包。";
  }
  return [
    characterKnowledgeBoundary.rule ||
      "角色只能吐露、被审出或主动运用其状态与相关事实中已有证据支持的信息。",
    "硬规则：若某角色的 supportedTerms 中没有某个专名/地点/组织/制度，不得写成该角色知道、吐露、被审出或隐瞒该信息；需要推进时改用账册、旁证、许三娘/李凡已有判断，或写成未证实疑问。",
    ...characters.map((character) => [
      `- ${character.name}`,
      `  supportedTerms：${(character.supportedTerms || []).join("；") || "无"}`,
      `  knows：${(character.knows || []).join("；") || "无"}`,
      `  doesNotKnow：${(character.doesNotKnow || []).join("；") || "无"}`,
    ].join("\n")),
  ].join("\n");
}

function windowSuggestsCharacterKnowledgeClaim(windowText = "", name = "", term = "") {
  const escapedName = escapeRegExp(name);
  const escapedTerm = escapeRegExp(term);
  const nameThenKnowledge = new RegExp(
    `${escapedName}.{0,80}(?:知道|知晓|掌握|清楚|吐露|透露|交代|供出|说出|招认|隐瞒|藏着|藏住|压着|说漏|被审|被问|被逼).{0,80}${escapedTerm}`,
    "u",
  );
  const interrogateCharacterForTerm = new RegExp(
    `(?:审问|审讯|逼问|追问|提审|盘问|拷问|问出|套出).{0,40}${escapedName}.{0,100}${escapedTerm}|${escapedName}.{0,40}(?:审问|审讯|逼问|追问|提审|盘问|拷问|问出|套出).{0,100}${escapedTerm}`,
    "u",
  );
  return nameThenKnowledge.test(windowText) || interrogateCharacterForTerm.test(windowText);
}

function collectUnsupportedCharacterKnowledgeClaims(value, characterKnowledgeBoundary = null) {
  const text = stringifyForGovernance(value);
  const characters = Array.isArray(characterKnowledgeBoundary?.characters)
    ? characterKnowledgeBoundary.characters
    : [];
  if (!text || !characters.length) {
    return [];
  }

  const issues = [];
  for (const character of characters) {
    const name = String(character?.name || "").trim();
    if (!name || !text.includes(name)) {
      continue;
    }
    const supported = new Set(character?.supportedTerms || []);
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const index = text.indexOf(name, searchFrom);
      if (index === -1) {
        break;
      }
      const windowText = text.slice(Math.max(0, index - 90), Math.min(text.length, index + name.length + 120));
      searchFrom = index + name.length;
      if (NEGATED_KNOWLEDGE_CLAIM_PATTERN.test(windowText) || !CHARACTER_KNOWLEDGE_CLAIM_PATTERN.test(windowText)) {
        continue;
      }
      const unsupportedTerms = normalizeStringList(
        CHARACTER_KNOWLEDGE_AUDIT_TERMS.filter((term) =>
          windowText.includes(term) &&
          !supported.has(term) &&
          windowSuggestsCharacterKnowledgeClaim(windowText, name, term)),
        8,
      );
      if (!unsupportedTerms.length) {
        continue;
      }
      issues.push(`角色知识边界：${name} 缺少证据支持其知道、吐露、被审出或隐瞒「${unsupportedTerms.join("、")}」；不要把这些内容写成由${name}供出或掌握。`);
    }
  }

  return normalizeStringList(issues, 12);
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

async function buildDerivedChapterStateArtifacts({
  provider,
  currentCharacterStates,
  chapterPlan,
  project,
  chapterDraft,
  worldStateBase,
  structureData,
  foreshadowingRegistryBase,
}) {
  const presence = await analyzeCharacterPresence({
    provider,
    project,
    chapterPlan,
    markdown: chapterDraft?.markdown || "",
  });
  const effectiveChapterPlan = {
    ...chapterPlan,
    charactersPresent: presence.charactersPresent,
  };

  return generateStructuredObject(provider, {
    label: "ChapterStateDeriverAgent",
    agentComplexity: "complex",
    instructions:
      "你是 Novelex 的 ChapterStateDeriverAgent。你负责在章节正文通过后，基于本章正文、章纲、当前角色状态、世界状态和伏笔注册表，派生新的 character_states、chapter_meta、world_state、foreshadowing_registry。不能重置已成立事实，不能发明正文中没有落地的重大结果。只输出 JSON。",
    input: [
      `作品：${project?.title || ""}`,
      `章节：${chapterPlan?.chapterId || ""} ${chapterPlan?.title || ""}`,
      `原章纲：\n${JSON.stringify(chapterPlan || {}, null, 2)}`,
      `按正文校正后的实际出场角色：\n${JSON.stringify(presence, null, 2)}`,
      `当前角色状态：\n${JSON.stringify(currentCharacterStates || [], null, 2)}`,
      `当前世界状态：\n${JSON.stringify(worldStateBase || {}, null, 2)}`,
      `当前伏笔注册表：\n${JSON.stringify(foreshadowingRegistryBase || {}, null, 2)}`,
      `结构规划：\n${JSON.stringify(structureData || {}, null, 2)}`,
      `章节正文：\n${chapterDraft?.markdown || ""}`,
      `请输出 JSON：
{
  "characterStates": [],
  "chapterMeta": {},
  "worldState": {},
  "foreshadowingRegistry": {}
}`,
    ].join("\n\n"),
    metadata: {
      feature: "chapter_state_derivation",
      chapterId: chapterPlan?.chapterId || "",
    },
    normalize(parsed) {
      const characterStates = Array.isArray(parsed.characterStates) ? parsed.characterStates : [];
      const chapterMeta = parsed.chapterMeta && typeof parsed.chapterMeta === "object"
        ? parsed.chapterMeta
        : {};
      const worldState = parsed.worldState && typeof parsed.worldState === "object"
        ? parsed.worldState
        : {};
      const foreshadowingRegistry = parsed.foreshadowingRegistry && typeof parsed.foreshadowingRegistry === "object"
        ? parsed.foreshadowingRegistry
        : {};

      return {
        characterStates,
        chapterMeta: {
          chapter_id: String(
            chapterMeta.chapter_id ||
            chapterMeta.chapterId ||
            chapterPlan?.chapterId ||
            effectiveChapterPlan?.chapterId ||
            "",
          ).trim(),
          chapterId: String(
            chapterMeta.chapterId ||
            chapterMeta.chapter_id ||
            chapterPlan?.chapterId ||
            effectiveChapterPlan?.chapterId ||
            "",
          ).trim(),
          title: String(chapterMeta.title || effectiveChapterPlan?.title || chapterPlan?.title || "").trim(),
          stage: String(chapterMeta.stage || effectiveChapterPlan?.stage || chapterPlan?.stage || "").trim(),
          time_in_story: String(
            chapterMeta.time_in_story ||
            chapterMeta.timeInStory ||
            effectiveChapterPlan?.timeInStory ||
            chapterPlan?.timeInStory ||
            "",
          ).trim(),
          pov_character: String(
            chapterMeta.pov_character ||
            chapterMeta.povCharacter ||
            effectiveChapterPlan?.povCharacter ||
            chapterPlan?.povCharacter ||
            "",
          ).trim(),
          location: String(chapterMeta.location || effectiveChapterPlan?.location || chapterPlan?.location || "").trim(),
          next_hook: String(
            chapterMeta.next_hook ||
            chapterMeta.nextHook ||
            effectiveChapterPlan?.nextHook ||
            chapterPlan?.nextHook ||
            "",
          ).trim(),
          key_events: Array.isArray(chapterMeta.key_events)
            ? chapterMeta.key_events
            : Array.isArray(chapterMeta.keyEvents)
              ? chapterMeta.keyEvents
              : Array.isArray(effectiveChapterPlan?.keyEvents)
                ? effectiveChapterPlan.keyEvents
                : (chapterPlan?.keyEvents || []),
          characters_present: Array.isArray(chapterMeta.characters_present)
            ? chapterMeta.characters_present
            : Array.isArray(chapterMeta.charactersPresent)
              ? chapterMeta.charactersPresent
              : (effectiveChapterPlan?.charactersPresent || chapterPlan?.charactersPresent || []),
          emotional_tone: String(
            chapterMeta.emotional_tone ||
            chapterMeta.emotionalTone ||
            effectiveChapterPlan?.emotionalTone ||
            chapterPlan?.emotionalTone ||
            "",
          ).trim(),
          ...chapterMeta,
          planned_characters_present: chapterPlan?.charactersPresent || [],
          missing_required_characters: presence.missingRequiredCharacters,
          characters_present: presence.charactersPresent,
        },
        worldState,
        foreshadowingRegistry,
      };
    },
  });
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

async function runStyleGuideDeriverAgent({
  provider,
  project,
  chapterPlan,
  chapterMarkdown = "",
}) {
  const parsed = await generateStructuredObject(provider, {
    label: "StyleGuideDeriverAgent",
    agentComplexity: "complex",
    instructions:
      "你是 Novelex 的 StyleGuideDeriverAgent。你的任务是为当前项目生成可直接给 Writer 使用的 style guide。若提供了首章正文，请优先从正文里提炼稳定文风与叙事禁忌；若没有正文，则基于项目信息和章纲生成一份可执行的临时风格基线。只输出 JSON。",
    input: [
      `作品：${project?.title || ""}`,
      `题材：${project?.genre || ""}`,
      `设定：${project?.setting || ""}`,
      `主题：${project?.theme || ""}`,
      `项目风格备注：${project?.styleNotes || "无"}`,
      `当前章节：${chapterPlan?.chapterId || ""} ${chapterPlan?.title || ""}`,
      `POV：${chapterPlan?.povCharacter || ""}`,
      `章纲重点：${(chapterPlan?.keyEvents || []).join("；") || "无"}`,
      chapterMarkdown ? `章节正文：\n${chapterMarkdown}` : "当前尚无已写正文，请基于项目与章纲先生成临时基线。",
      `请输出 JSON：
{
  "title": "风格指南标题",
  "rules": ["风格规则1", "风格规则2"],
  "antiPatterns": ["应避免的写法1", "写法2"],
  "voiceSummary": "一句概括这部作品当前应保持的声音"
}`,
    ].join("\n\n"),
    metadata: {
      feature: "style_guide_derivation",
      chapterId: chapterPlan?.chapterId || "",
    },
  });

  const rules = normalizeStringList(parsed.rules, 8);
  const antiPatterns = normalizeStringList(parsed.antiPatterns, 6);
  const title = String(parsed.title || "风格指南").trim() || "风格指南";
  const voiceSummary = String(parsed.voiceSummary || "").trim();

  return [
    `# ${title}`,
    voiceSummary ? `- 核心声音：${voiceSummary}` : "",
    ...rules.map((item) => `- ${item}`),
    antiPatterns.length ? "" : "",
    antiPatterns.length ? "## 避免事项" : "",
    ...antiPatterns.map((item) => `- ${item}`),
  ].filter(Boolean).join("\n");
}

async function resolveStyleBaseline(store, provider, project, chapterPlan) {
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

  if (!provider) {
    throw new Error("缺少 provider，无法生成 LLM 风格基线。");
  }

  return {
    styleGuideText: await runStyleGuideDeriverAgent({
      provider,
      project,
      chapterPlan,
    }),
    styleGuideSourcePath: "generated/style_guide_llm.md",
  };
}

function createManualEditValidationSnapshot() {
  return {
    passed: null,
    overallPassed: null,
    score: null,
    summary: "人工直接修改正文后未自动审查，章节保持待审状态。",
    issueCounts: {
      critical: 0,
      warning: 0,
      info: 0,
    },
    activeDimensions: [],
    issues: [],
    dimensionResults: {},
    heuristics: null,
    sequenceSnapshot: [],
    staleForeshadowings: [],
    nextChapterGuardrails: [],
    auditDegraded: false,
    semanticAudit: {
      source: "skipped",
      reason: "manual_direct_edit_no_validation",
      error: null,
      attempts: 0,
    },
    auditDrift: null,
    consistency: null,
    plausibility: null,
    foreshadowing: null,
    style: null,
  };
}

function buildManualEditDerivedState({
  draftBundle,
  chapterPlan,
  chapterDraft,
  fallbackCharacterStates = [],
  fallbackWorldState = null,
  fallbackForeshadowingRegistry = null,
}) {
  const realizedCharacters = realizedCharactersPresent(chapterPlan, chapterDraft?.markdown || "");
  const previousMeta = draftBundle?.chapterMeta && typeof draftBundle.chapterMeta === "object"
    ? draftBundle.chapterMeta
    : {};
  const chapterMeta = {
    ...previousMeta,
    chapter_id: String(
      previousMeta.chapter_id ||
      previousMeta.chapterId ||
      chapterPlan?.chapterId ||
      "",
    ).trim(),
    chapterId: String(
      previousMeta.chapterId ||
      previousMeta.chapter_id ||
      chapterPlan?.chapterId ||
      "",
    ).trim(),
    title: String(previousMeta.title || chapterPlan?.title || "").trim(),
    stage: String(previousMeta.stage || chapterPlan?.stage || "").trim(),
    time_in_story: String(
      previousMeta.time_in_story ||
      previousMeta.timeInStory ||
      chapterPlan?.timeInStory ||
      "",
    ).trim(),
    pov_character: String(
      previousMeta.pov_character ||
      previousMeta.povCharacter ||
      chapterPlan?.povCharacter ||
      "",
    ).trim(),
    location: String(previousMeta.location || chapterPlan?.location || "").trim(),
    next_hook: String(
      previousMeta.next_hook ||
      previousMeta.nextHook ||
      chapterPlan?.nextHook ||
      "",
    ).trim(),
    summary_50: String(
      previousMeta.summary_50 ||
      createExcerpt((chapterPlan?.keyEvents || []).join("；"), 50),
    ).trim(),
    summary_200: String(
      previousMeta.summary_200 ||
      createExcerpt(`${(chapterPlan?.keyEvents || []).join("；")} ${chapterPlan?.nextHook || ""}`, 200),
    ).trim(),
    key_events: Array.isArray(previousMeta.key_events)
      ? previousMeta.key_events
      : Array.isArray(previousMeta.keyEvents)
        ? previousMeta.keyEvents
        : (chapterPlan?.keyEvents || []),
    characters_present: realizedCharacters,
    emotional_tone: String(
      previousMeta.emotional_tone ||
      previousMeta.emotionalTone ||
      chapterPlan?.emotionalTone ||
      "",
    ).trim(),
    foreshadowing_planted: Array.isArray(previousMeta.foreshadowing_planted)
      ? previousMeta.foreshadowing_planted
      : (chapterPlan?.foreshadowingActions || [])
        .filter((item) => item.action === "plant")
        .map((item) => item.id),
    foreshadowing_resolved: Array.isArray(previousMeta.foreshadowing_resolved)
      ? previousMeta.foreshadowing_resolved
      : (chapterPlan?.foreshadowingActions || [])
        .filter((item) => item.action === "resolve")
        .map((item) => item.id),
    continuity_anchors: Array.isArray(previousMeta.continuity_anchors)
      ? previousMeta.continuity_anchors
      : Array.isArray(previousMeta.continuityAnchors)
        ? previousMeta.continuityAnchors
        : (chapterPlan?.continuityAnchors || []),
    word_count: countWordsApprox(chapterDraft?.markdown || ""),
  };

  return {
    chapterMeta,
    characterStates: Array.isArray(draftBundle?.characterStates)
      ? draftBundle.characterStates
      : fallbackCharacterStates,
    worldState: draftBundle?.worldState || fallbackWorldState || null,
    foreshadowingRegistry: draftBundle?.foreshadowingRegistry || fallbackForeshadowingRegistry || null,
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

function parseDossierField(markdown = "", label = "") {
  const escapedLabel = String(label || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(markdown || "").match(new RegExp(`- ${escapedLabel}：(.+)`));
  return String(match?.[1] || "").trim();
}

function collectStyleGuideClauses(styleGuideText = "") {
  return String(styleGuideText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => line.replace(/^[-#>]+\s*/u, "").split(/[；。]/u))
    .map((item) => item.trim())
    .filter((item) => item.length >= 6);
}

function buildWriterStyleSummary(styleGuideText = "", chapterPlan = null) {
  const clauses = collectStyleGuideClauses(styleGuideText);
  const selected = [];
  const pickByPattern = (pattern) => {
    const match = clauses.find((item) => pattern.test(item) && !selected.includes(item));
    if (match) {
      selected.push(createExcerpt(match, 80));
    }
  };

  pickByPattern(/第三人称|限知|POV|视角|旁白/u);
  pickByPattern(/动作|对白|现场|推进|场景/u);
  pickByPattern(/元话语|提纲|总结|说明文/u);
  pickByPattern(/抽象|空泛|概括/u);
  pickByPattern(/章末|钩子|牵引|收束/u);

  if (chapterPlan?.emotionalTone) {
    selected.push(`情绪基调：${chapterPlan.emotionalTone}`);
  }
  selected.push("若风格倾向长句、评述或背景说明，仍须让位于场景推进与节奏合同。");

  return normalizeStringList(selected, 6);
}

function buildSceneWordBudgets(chapterPlan, targetWords = 0) {
  const scenes = Array.isArray(chapterPlan?.scenes) ? chapterPlan.scenes : [];
  if (!scenes.length || !Number.isFinite(targetWords) || targetWords <= 0) {
    return [];
  }

  const base = Math.floor(targetWords / scenes.length);
  let remainder = targetWords - (base * scenes.length);
  return scenes.map((scene, index) => {
    const target = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return {
      index: index + 1,
      sceneId: scene.id || `scene_${index + 1}`,
      label: scene.label || `scene_${index + 1}`,
      targetWords: target,
    };
  });
}

function buildSceneExecutionLines(chapterPlan, sceneBudgets = []) {
  const budgetsByIndex = new Map(sceneBudgets.map((item) => [item.index, item.targetWords]));
  const scenes = Array.isArray(chapterPlan?.scenes) ? chapterPlan.scenes : [];
  if (!scenes.length) {
    return ["- 当前章节没有明确 scene 链，按主线直接推进。"];
  }

  return scenes.map((scene, index) => {
    const budget = budgetsByIndex.get(index + 1);
    const parts = [
      `${index + 1}. ${scene.label}`,
      `任务:${scene.focus || "推进主线"}`,
      Array.isArray(scene.characters) && scene.characters.length ? `出场:${scene.characters.join("、")}` : "",
      scene.outcome ? `结果:${scene.outcome}` : "",
      scene.handoffToNext ? `交棒:${scene.handoffToNext}` : "",
      Number.isFinite(budget) && budget > 0 ? `预算≈${budget}字` : "",
    ].filter(Boolean);
    return `- ${parts.join("｜")}`;
  });
}

function buildResearchBoundaryLines(researchPacket = null) {
  return normalizeStringList([
    ...((researchPacket?.factsToUse || []).map((item) => `可直接写：${item}`)),
    ...((researchPacket?.factsToAvoid || []).map((item) => `避免误写：${item}`)),
    ...((researchPacket?.uncertainPoints || []).map((item) => `未核实时不要写死：${item}`)),
    ...((researchPacket?.termBank || []).slice(0, 2).map((item) => `术语：${item}`)),
  ], 8);
}

function buildOpenTensionLines(factContext = null) {
  return normalizeStringList([
    ...((factContext?.openTensions || []).map((item) =>
      `开放张力[${item.factId}]：${item.subject}｜${item.assertion}`)),
  ], 6);
}

function buildHardConstraintLines(governance = null, factContext = null) {
  return normalizeStringList([
    ...((governance?.ruleStack?.hardFacts || []).slice(0, 8)),
    ...((factContext?.establishedFacts || []).map((item) =>
      `已定事实[${item.factId}]：${item.subject}｜${item.assertion}`)),
  ], 8);
}

function buildCompactCharacterCueLines(characterDossiers = [], characterStateSummary = "") {
  const stateLines = String(characterStateSummary || "")
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/u, "").trim())
    .filter(Boolean);
  const dossierLines = (Array.isArray(characterDossiers) ? characterDossiers : [])
    .map((item) => {
      const name = String(item?.name || "").trim();
      if (!name) {
        return "";
      }
      const voice = parseDossierField(item.markdown, "说话方式");
      const desire = parseDossierField(item.markdown, "核心欲望") || parseDossierField(item.markdown, "当前目标");
      const wound = parseDossierField(item.markdown, "核心伤口");
      const emotion = parseDossierField(item.markdown, "当前情绪");
      return createExcerpt([
        `${name}：`,
        voice ? `说话=${voice}` : "",
        desire ? `欲望=${desire}` : "",
        emotion ? `情绪=${emotion}` : "",
        wound ? `伤口=${wound}` : "",
      ].filter(Boolean).join("｜"), 120);
    })
    .filter(Boolean);

  return normalizeStringList([...dossierLines, ...stateLines], 8);
}

export function buildWriterPromptPacket({
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
  timelineContext = null,
}) {
  const povCharacter = chapterPlan?.povCharacter || project?.protagonistName || "主角";
  const targetWords = Number(project?.targetWordsPerChapter || 0);
  const sceneBudgets = buildSceneWordBudgets(chapterPlan, targetWords);
  const hardConstraints = normalizeStringList([
    requiredCharactersConstraint(chapterPlan),
    ...buildHardConstraintLines(governance, factContext),
  ], 12);
  const openTensions = buildOpenTensionLines(factContext);
  const temporalPlanning = timelineContext?.temporalPlanning || null;
  const timelineContract = normalizeStringList([
    temporalPlanning?.recommendedTransition ? `开场时间承接：${temporalPlanning.recommendedTransition}` : "",
    temporalPlanning ? `时间跳跃：${temporalPlanning.skipAllowed ? "允许，但必须交代逻辑与代价" : "不建议主动跳时"}` : "",
    temporalPlanning?.allowedSkipType ? `允许跳跃方式：${temporalPlanning.allowedSkipType}` : "",
    temporalPlanning?.allowedElapsed ? `可跳过范围：${temporalPlanning.allowedElapsed}` : "",
    temporalPlanning?.skipRationale ? `跳时理由：${temporalPlanning.skipRationale}` : "",
    ...(temporalPlanning?.mustCarryThrough || []).map((item) => `跳过后仍必须保留：${item}`),
    ...(temporalPlanning?.offscreenChangesToMention || []).map((item) => `离屏变化需要交代：${item}`),
    ...(temporalPlanning?.mustNotDo || []).map((item) => `禁止时间处理：${item}`),
    ...((timelineContext?.timelineState?.deadlines || []).slice(0, 4).map((item) => `有效倒计时：${item.label}｜${item.latestStatement || item.narrativeMeaning || item.status}`)),
  ], 12);
  const currentTask = normalizeStringList(governance?.ruleStack?.currentTask || [], 6);
  const deferRules = normalizeStringList(governance?.ruleStack?.deferRules || [], 6);
  const executionReminders = normalizeStringList([
    ...((writerContextPacket?.priorities || []).slice(0, 8)),
    ...((writerContextPacket?.referenceSignals || []).map((item) => `范文信号：${item}`)),
    ...((writerContextPacket?.openingSignals || []).map((item) => `结构信号：${item}`)),
    ...((referencePacket?.warnings || []).map((item) => `范文告警：${item}`)),
    ...((openingReferencePacket?.warnings || []).map((item) => `黄金三章告警：${item}`)),
  ], 8).filter((item) => !hardConstraints.includes(item) && !currentTask.includes(item));
  const riskLines = normalizeStringList([
    ...((writerContextPacket?.risks || []).slice(0, 8)),
    ...deferRules,
  ], 8);
  const researchBoundaryLines = buildResearchBoundaryLines(researchPacket);
  const characterCueLines = buildCompactCharacterCueLines(characterDossiers, characterStateSummary);
  const styleSummary = buildWriterStyleSummary(styleGuideText, chapterPlan);
  const sceneExecutionLines = buildSceneExecutionLines(chapterPlan, sceneBudgets);
  const continuityAnchors = normalizeStringList([
    ...((historyPacket?.continuityAnchors || chapterPlan?.continuityAnchors || []).slice(0, 6)),
  ], 6);
  const pacingContract = normalizeStringList([
    targetWords > 0 ? `目标篇幅约 ${targetWords} 字；若无法兼顾，宁短勿水。` : "优先保证事件链完整，宁短勿水。",
    sceneBudgets.length
      ? `Scene 预算：${sceneBudgets.map((item) => `${item.index}≈${item.targetWords}字`).join("；")}`
      : "",
    "每场只兑现一个主要新增变化：新的信息、关系变化、行动结果或代价至少占一项。",
    "禁止重复建立同一困局、重复解释同一关系状态、重复用对白确认同一信息。",
    "禁止重复开场、重置时间线、把同一场危机重新从头演一遍。",
    "若风格要求鼓励长句、评述或背景说明，也不得盖过场景推进与节奏合同。",
  ], 8);
  const outputLines = [
    `作品：${project.title}`,
    `章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
    `模式：${mode}`,
    `POV：${povCharacter}`,
    "写作要求：直接输出可发布的网络小说正文，不要解释提纲，不要总结主题，不要写“本章将要”“这一章里”这类元话语。",
    "视角要求：全文必须稳定在第三人称有限视角；对白允许第一人称，旁白不允许“我/我们”。",
    "",
    "## 本章任务",
    `- 主线：${chapterPlan.dominantThread || "无"}`,
    `- 上文余波：${createExcerpt(chapterPlan.entryLink || historyPacket?.lastEnding || "承接上一章压力。", 180)}`,
    `- 章末压力：${createExcerpt(chapterPlan.exitPressure || chapterPlan.nextHook || "无", 180)}`,
    `- 必须出场：${requiredCharactersConstraint(chapterPlan).replace(/^本章必须让以下具名角色在正文中实际出场或被直接点名：/u, "") || "无"}`,
    `- 必须落地：${(chapterPlan.keyEvents || []).join("；") || "无"}`,
    `- 伏笔任务：${foreshadowingSummary || "无"}`,
    `- 连续性锚点：${continuityAnchors.join("；") || "无"}`,
    "",
    "## 时间合同",
    `- ${timelineContract.join("\n- ") || "无"}`,
    "",
    "## 节奏合同",
    `- ${pacingContract.join("\n- ") || "无"}`,
    "",
    "## Scene 链",
    ...sceneExecutionLines,
    "",
    "## 硬约束",
    `- ${hardConstraints.join("\n- ") || "无"}`,
  ];

  if (openTensions.length) {
    outputLines.push("", "## 开放张力", `- ${openTensions.join("\n- ")}`);
  }
  if (currentTask.length) {
    outputLines.push("", "## 当前任务", `- ${currentTask.join("\n- ")}`);
  }
  if (executionReminders.length) {
    outputLines.push("", "## 执行提醒", `- ${executionReminders.join("\n- ")}`);
  }
  if (riskLines.length) {
    outputLines.push("", "## 高风险偏差", `- ${riskLines.join("\n- ")}`);
  }
  if (characterCueLines.length) {
    outputLines.push("", "## 角色现场状态", `- ${characterCueLines.join("\n- ")}`);
  }
  if (researchBoundaryLines.length) {
    outputLines.push("", "## 研究边界", `- ${researchBoundaryLines.join("\n- ")}`);
  }
  if (styleSummary.length) {
    outputLines.push("", "## 风格执行摘要", `- ${styleSummary.join("\n- ")}`);
  }
  if (revisionNotes.length) {
    outputLines.push("", `## 人类反馈`, `- ${revisionNotes.join("\n- ")}`);
  }
  if (!sceneExecutionLines.length && sceneBeatSummary) {
    outputLines.push("", "## Scene 兜底摘要", sceneBeatSummary);
  }
  outputLines.push("", "只输出完整章节正文，不要额外解释；若未输出章节标题，系统会自动补齐。");

  return {
    chapterId: chapterPlan?.chapterId || "",
    mode,
    targetWords,
    sceneBudgets,
    hardConstraints,
    openTensions,
    currentTask,
    executionReminders,
    riskLines,
    researchBoundaryLines,
    characterCueLines,
    styleSummary,
    markdown: outputLines.filter(Boolean).join("\n"),
  };
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
  timelineContext = null,
}) {
  return buildWriterPromptPacket({
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
    timelineContext,
  }).markdown;
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
  timelineContext = null,
  promptPacket = null,
}) {
  const normalizedSelection = normalizeChapterSelection(selection);
  const writerPromptPacket = promptPacket || buildWriterPromptPacket({
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
    timelineContext,
  });
  return [
    writerPromptPacket.markdown,
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
  timelineContext = null,
  promptTelemetry = null,
}) {
  const writerPromptPacket = buildWriterPromptPacket({
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
    timelineContext,
  });
  if (promptTelemetry && typeof promptTelemetry === "object") {
    promptTelemetry.writerPromptPacket = writerPromptPacket;
  }
  const result = await provider.generateText({
    agentComplexity: "complex",
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
      timelineContext,
      promptPacket: writerPromptPacket,
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
  timelineContext = null,
  promptTelemetry = null,
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
  const writerPromptPacket = buildWriterPromptPacket({
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
    timelineContext,
  });
  if (promptTelemetry && typeof promptTelemetry === "object") {
    promptTelemetry.writerPromptPacket = writerPromptPacket;
  }

  const input = currentDraft?.markdown
    ? [
        `待修正文：\n${currentDraft.markdown}`,
        writerPromptPacket.markdown,
        mode === "style_repair"
          ? "改写要求：保留章节事实、scene 顺序和场面关系，只修正叙述视角、语言质感与元信息污染。"
          : mode === "validation_repair"
            ? "改写要求：严格依据验证反馈补足真正缺失的事件或因果，让整章更像正文，而不是提纲说明。"
            : targetedRepairMode
              ? "改写要求：只处理当前点名的问题；优先定点修补。若命中重复开场、重复推进或单章节奏拖沓，主动压缩重复段落，收紧到本章必须完成的事件链。"
            : "改写要求：在不偏离既定章节结构的前提下，响应作者反馈，整章重写。",
      ].join("\n\n")
    : writerPromptPacket.markdown;

  const result = await provider.generateText({
    agentComplexity: "complex",
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
  chapterSlot,
  stagePlanning,
  characterPlanning,
  historyPlanning,
  continuityPlanning,
  continuityGuard,
  contextConflicts,
  outlineGenerationContract,
  factContext,
  timelineContext,
  characterKnowledgeBoundary,
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
    "## Chapter Slot",
    `- 标题提示：${chapterSlot?.titleHint || "无"}`,
    `- 章节使命：${chapterSlot?.mission || "无"}`,
    `- 地点种子：${chapterSlot?.locationSeed || "无"}`,
    `- 预期承接：${chapterSlot?.expectedCarryover || "无"}`,
    `- 预期升级：${chapterSlot?.expectedEscalation || "无"}`,
    `- 下一钩子种子：${chapterSlot?.nextHookSeed || "无"}`,
    `- 禁止重演：${(chapterSlot?.forbidReplayBeats || []).join("；") || "无"}`,
    "",
    "## Continuity Guard",
    `- 入口模式：${continuityPlanning.entryMode || continuityGuard?.defaultEntryMode || "direct_resume"}`,
    `- 允许入口：${(outlineGenerationContract?.allowedEntryModes || continuityGuard?.allowedEntryModes || []).join("；") || "无"}`,
    `- 必须承接上章压力：${outlineGenerationContract?.mustResumeFromPreviousPressure ? "是" : "否"}`,
    `- 禁止重开开篇：${outlineGenerationContract?.forbidRestartOpening ? "是" : "否"}`,
    `- 上章压力证据：${continuityGuard?.resumeFrom || "无"}`,
    `- 必引证据：${(outlineGenerationContract?.mandatoryEvidenceRefs || []).join("；") || "无"}`,
    `- 不支持声明：${(continuityPlanning.unsupportedClaims || []).join("；") || "无"}`,
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
    "## 时间线合同",
    timelineContext?.briefingMarkdown || "无",
    "",
    "## 角色知识边界",
    renderCharacterKnowledgeBoundary(characterKnowledgeBoundary),
    "",
    "## 章节衔接",
    `- Entry Mode：${continuityPlanning.entryMode || "direct_resume"}`,
    `- 开场承接：${continuityPlanning.entryLink || "无"}`,
    `- 主承接线程：${continuityPlanning.dominantCarryoverThread || "无"}`,
    `- 可穿插副线程：${(continuityPlanning.subordinateThreads || []).join("；") || "无"}`,
    `- 本章必须推进到：${continuityPlanning.mustAdvanceThisChapter || "无"}`,
    `- 可暂缓：${(continuityPlanning.canPauseThisChapter || []).join("；") || "无"}`,
    `- 章末递交压力：${continuityPlanning.exitPressureToNextChapter || "无"}`,
    `- 连贯性风险：${(continuityPlanning.continuityRisks || []).join("；") || "无"}`,
    `- 证据引用：${(continuityPlanning.evidenceRefs || []).join("；") || "无"}`,
    "",
    "## 本章第一场为什么这样开",
    `- 开法依据：${continuityPlanning.entryLink || continuityGuard?.resumeFrom || chapterSlot?.expectedCarryover || "无"}`,
    `- 引用事实/上章结果：${(outlineGenerationContract?.mandatoryEvidenceRefs || []).join("；") || "无"}`,
    `- 被压制的开篇模式：${(contextConflicts?.conflicts || []).filter((item) => item.source === "openingReferencePacket" || /重开|开篇|惊醒/u.test(item.reason || "")).map((item) => `${item.source}.${item.field || ""}:${item.reason}`).join("；") || "无"}`,
    "",
    "## Context Conflicts",
    `${(contextConflicts?.conflicts || []).map((item) => `- ${item.source}.${item.field || ""}｜${item.reason}｜改为：${item.resolution}`).join("\n") || "- 无"}`,
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

function selectedOutlineSourceFromMode(mode = "") {
  return String(mode || "").trim() === "composed" ? "manual_composed" : "manual_selection";
}

function inferSelectedOutlineSource(selectedChapterOutline = null) {
  const explicitSource = String(selectedChapterOutline?.source || "").trim();
  if (explicitSource) {
    return explicitSource;
  }
  return selectedOutlineSourceFromMode(selectedChapterOutline?.mode);
}

function normalizeLockSyncedForeshadowingActions(baseActions = [], parsed = null) {
  const normalizedBase = Array.isArray(baseActions) ? baseActions : [];
  const rawEntries = Array.isArray(parsed?.foreshadowingActions) ? parsed.foreshadowingActions : [];
  const actionKeys = new Set(
    rawEntries
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        const id = String(item.id || "").trim();
        const action = String(item.action || "").trim();
        return id && action ? `${id}:${action}` : "";
      })
      .filter(Boolean),
  );
  const actionIds = new Set([
    ...(Array.isArray(parsed?.foreshadowingActionIds) ? parsed.foreshadowingActionIds : []),
    ...rawEntries.map((item) => (typeof item === "string" ? item : item?.id)),
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean));

  if (!actionKeys.size && !actionIds.size) {
    return normalizedBase;
  }

  const filtered = normalizedBase.filter((item) => {
    const actionKey = `${String(item?.id || "").trim()}:${String(item?.action || "").trim()}`;
    return actionKeys.size ? actionKeys.has(actionKey) : actionIds.has(String(item?.id || "").trim());
  });

  return filtered.length ? filtered : normalizedBase;
}

function buildLockedOutlineSyncHistoryEntry(selectedChapterOutline = null, syncedOutline = null) {
  return {
    at: nowIso(),
    action: "post_lock_sync",
    source: inferSelectedOutlineSource(selectedChapterOutline),
    sourceMode: String(selectedChapterOutline?.mode || "").trim() || "single",
    selectedProposalId: selectedChapterOutline?.selectedProposalId ?? null,
    selectedSceneRefs: Array.isArray(selectedChapterOutline?.selectedSceneRefs)
      ? selectedChapterOutline.selectedSceneRefs
      : [],
    authorNotes: String(selectedChapterOutline?.authorNotes || "").trim(),
    synchronizedSummary: String(syncedOutline?.summary || "").trim(),
  };
}

async function runLockedChapterOutlineSyncAgent({
  provider,
  project,
  bundle,
  draftBundle,
}) {
  const baseChapterPlan = draftBundle?.chapterPlan || null;
  if (!baseChapterPlan?.chapterId) {
    throw new Error("锁章前缺少当前章节的 chapterPlan，无法同步细纲。");
  }

  const chapterOutlineContext = draftBundle?.chapterOutlineContext || {};
  const selectedChapterOutline = draftBundle?.selectedChapterOutline || null;
  const factSections = buildFactPromptSections(draftBundle?.factContext || null);
  const originalOutlineSummary = selectedChapterOutline
    ? [
      `模式：${selectedChapterOutline.mode || "single"}`,
      `来源：${inferSelectedOutlineSource(selectedChapterOutline)}`,
      `摘要：${selectedChapterOutline.summary || "无"}`,
      `理由：${selectedChapterOutline.rationale || "无"}`,
      `差异说明：${selectedChapterOutline.diffSummary || "无"}`,
      `原 selectedProposalId：${selectedChapterOutline.selectedProposalId || "无"}`,
      `原 selectedSceneRefs：${(selectedChapterOutline.selectedSceneRefs || []).join("；") || "无"}`,
    ].join("\n")
    : "无";
  const currentPlanSummary = [
    `章节：${baseChapterPlan.chapterId} ${baseChapterPlan.title}`,
    `阶段：${baseChapterPlan.stage || "无"}`,
    `POV：${baseChapterPlan.povCharacter || "无"}`,
    `地点：${baseChapterPlan.location || "无"}`,
    `当前关键事件：${(baseChapterPlan.keyEvents || []).join("；") || "无"}`,
    `当前主线：${baseChapterPlan.dominantThread || "无"}`,
    `当前入口承接：${baseChapterPlan.entryLink || "无"}`,
    `当前出口压力：${baseChapterPlan.exitPressure || baseChapterPlan.nextHook || "无"}`,
    `当前场景链：${(baseChapterPlan.scenes || []).map(sceneChainDigest).join(" || ") || "无"}`,
  ].join("\n");
  const outlineContextSummary = [
    `阶段任务：${chapterOutlineContext?.stagePlanning?.chapterMission || "无"}`,
    `必须落地：${(chapterOutlineContext?.stagePlanning?.requiredBeats || []).join("；") || "无"}`,
    `角色压力：${(chapterOutlineContext?.characterPlanning?.relationshipPressures || []).join("；") || "无"}`,
    `历史余波：${chapterOutlineContext?.historyPlanning?.lastEnding || "无"}`,
    `章节衔接：开场承接=${chapterOutlineContext?.continuityPlanning?.entryLink || "无"}｜主承接线程=${chapterOutlineContext?.continuityPlanning?.dominantCarryoverThread || "无"}｜章末递交压力=${chapterOutlineContext?.continuityPlanning?.exitPressureToNextChapter || "无"}`,
  ].join("\n");
  const foreshadowingSummary = (baseChapterPlan.foreshadowingActions || []).length
    ? baseChapterPlan.foreshadowingActions.map((item) => `${item.id}:${item.action}:${item.description || ""}`).join("；")
    : "无";

  const result = await provider.generateText({
    agentComplexity: "complex",
    instructions:
      "你是 Novelex 的 ChapterOutlineSyncAgent。当前章节正文已经通过人工批准，即将锁章。你的任务是以最终正文为唯一事实源，重建一个供后续章节继承的 chapter plan，并覆盖旧细纲。不要改 chapterId、chapterNumber、title、stage，不要把正文里没有落地的情节塞回去，不要生成新的伏笔 ID 或 action。只输出 JSON。",
    input: [
      projectSummary(project),
      `当前章节：${baseChapterPlan.chapterId}（第 ${baseChapterPlan.chapterNumber} 章）`,
      `锁定字段：chapterId=${baseChapterPlan.chapterId}｜chapterNumber=${baseChapterPlan.chapterNumber}｜title=${baseChapterPlan.title}｜stage=${baseChapterPlan.stage}`,
      `原始已选细纲：\n${originalOutlineSummary}`,
      `当前 chapter plan 摘要：\n${currentPlanSummary}`,
      `写作上下文摘要：\n${outlineContextSummary}`,
      `必须继承的已定事实：${factSections.establishedFactsLine}`,
      `可以继续发酵但不能改写底层结论的开放张力：${factSections.openTensionsLine}`,
      `允许沿用或收缩的伏笔动作：${foreshadowingSummary}`,
      `最终批准正文全文：\n${draftBundle?.chapterMarkdown || ""}`,
      `请输出 JSON：
{
  "proposalId": "proposal_lock_sync",
  "summary": "一句话概括按最终正文同步后的章纲",
  "rationale": "为何这样回写",
  "diffSummary": "与原细纲相比最关键的校正点",
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
  "foreshadowingActionIds": ["fsh_001"],
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
      feature: "chapter_outline_lock_sync",
      chapterId: baseChapterPlan.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`ChapterOutlineSyncAgent 返回了无法解析的 JSON：${createExcerpt(result.text || "", 220)}`);
  }

  const syncedOutline = normalizeOutlineProposal({
    ...parsed,
    title: baseChapterPlan.title,
  }, 0, {
    chapterBase: {
      ...baseChapterPlan,
      title: baseChapterPlan.title,
      stage: baseChapterPlan.stage,
    },
    bundle,
    stagePlanning: chapterOutlineContext?.stagePlanning || { chapterMission: "", requiredBeats: [], mustPreserve: [], suggestedConflictAxis: [], nextPressure: "" },
    characterPlanning: chapterOutlineContext?.characterPlanning || { recommendedPov: baseChapterPlan.povCharacter, mustAppear: baseChapterPlan.charactersPresent || [], relationshipPressures: [] },
    historyPlanning: chapterOutlineContext?.historyPlanning || { mustNotContradict: [], lastEnding: "" },
    continuityPlanning: chapterOutlineContext?.continuityPlanning || { entryLink: "", dominantCarryoverThread: "", exitPressureToNextChapter: "", continuityRisks: [] },
    foreshadowingActions: normalizeLockSyncedForeshadowingActions(baseChapterPlan.foreshadowingActions || [], parsed),
  });

  return syncedOutline;
}

async function synchronizeLockedChapterOutline({
  store,
  provider,
  project,
  bundle,
  draftBundle,
}) {
  const syncedOutline = await runLockedChapterOutlineSyncAgent({
    provider,
    project,
    bundle,
    draftBundle,
  });
  const selectedChapterOutline = draftBundle?.selectedChapterOutline || null;
  const synchronizedSelectedChapterOutline = {
    ...(selectedChapterOutline || {}),
    mode: String(selectedChapterOutline?.mode || "").trim() || "single",
    selectedProposalId: selectedChapterOutline?.selectedProposalId ?? null,
    selectedSceneRefs: Array.isArray(selectedChapterOutline?.selectedSceneRefs)
      ? selectedChapterOutline.selectedSceneRefs
      : [],
    authorNotes: String(selectedChapterOutline?.authorNotes || "").trim(),
    summary: syncedOutline.summary,
    rationale: syncedOutline.rationale,
    diffSummary: syncedOutline.diffSummary,
    chapterPlan: syncedOutline.chapterPlan,
    source: "post_lock_sync",
    syncedFrom: {
      source: inferSelectedOutlineSource(selectedChapterOutline),
      mode: String(selectedChapterOutline?.mode || "").trim() || "single",
      selectedProposalId: selectedChapterOutline?.selectedProposalId ?? null,
      selectedSceneRefs: Array.isArray(selectedChapterOutline?.selectedSceneRefs)
        ? selectedChapterOutline.selectedSceneRefs
        : [],
      authorNotes: String(selectedChapterOutline?.authorNotes || "").trim(),
      summary: String(selectedChapterOutline?.summary || "").trim(),
      rationale: String(selectedChapterOutline?.rationale || "").trim(),
      diffSummary: String(selectedChapterOutline?.diffSummary || "").trim(),
      syncedAt: nowIso(),
    },
  };
  const currentCharacterStates = await loadCurrentCharacterStates(store, bundle);
  const derivedState = await buildDerivedChapterStateArtifacts({
    provider,
    currentCharacterStates,
    chapterPlan: syncedOutline.chapterPlan,
    project,
    chapterDraft: { markdown: draftBundle?.chapterMarkdown || "" },
    worldStateBase: bundle.worldState,
    structureData: bundle.structureData,
    foreshadowingRegistryBase: bundle.foreshadowingRegistry,
  });
  const chapterOutlineHistory = [
    ...(draftBundle?.chapterOutlineHistory || []),
    buildLockedOutlineSyncHistoryEntry(selectedChapterOutline, syncedOutline),
  ];

  await store.stageChapterDraft({
    ...draftBundle,
    chapterPlan: syncedOutline.chapterPlan,
    selectedChapterOutline: synchronizedSelectedChapterOutline,
    chapterOutlineHistory,
    chapterMeta: derivedState.chapterMeta,
    characterStates: derivedState.characterStates,
    worldState: derivedState.worldState,
    foreshadowingRegistry: derivedState.foreshadowingRegistry,
  });

  return {
    chapterPlan: syncedOutline.chapterPlan,
    selectedChapterOutline: synchronizedSelectedChapterOutline,
    chapterOutlineHistory,
    derivedState,
  };
}

async function runStagePlanningContextAgent({
  provider,
  project,
  bundle,
  chapterBase,
  chapterSlot,
  stage,
  foreshadowingActions,
  legacyPlan,
  committedOutlines = [],
  factContext = null,
  timelineContext = null,
  continuityGuard = null,
  characterKnowledgeBoundary = null,
}) {
  const factSections = buildFactPromptSections(factContext);
  const result = await provider.generateText({
    agentComplexity: "complex",
    instructions:
      "你是 Novelex 的 StagePlanningContextAgent。你负责把当前章节在全书粗纲与当前阶段中的任务提炼出来，供后续章节细纲候选生成使用。必须服从章节锚点、已定稿历史与连续性护栏；chN>1 默认承接前章，不能重开第一章。不要写正文，不要写章节方案，只输出当前章节的义务、延后项、冲突轴和标题信号。只输出 JSON。",
    input: [
      projectSummary(project),
      `当前章节：${chapterBase.chapterId}（第 ${chapterBase.chapterNumber} 章）`,
      `章节锚点：${chapterSlot ? JSON.stringify({
        mission: chapterSlot.mission,
        expectedCarryover: chapterSlot.expectedCarryover,
        expectedEscalation: chapterSlot.expectedEscalation,
        forbidReplayBeats: chapterSlot.forbidReplayBeats,
      }) : "无"}`,
      `当前阶段：${stage?.label || chapterBase.stage}`,
      `阶段目标：${stage?.stageGoal || stage?.purpose || "无"}`,
      `阶段冲突：${(stage?.stageConflicts || []).join("；") || "无"}`,
      `粗纲：\n${(bundle?.outlineData?.roughSections || []).map((item) => `- ${item.stage}：${item.content}`).join("\n")}`,
      `已定稿历史摘要：\n${summarizeCommittedHistoryForPrompt(committedOutlines).slice(0, 2400) || "无已定稿历史"}`,
      `必须继承的已定事实：${factSections.establishedFactsLine}`,
      `可以继续发酵但不能改写底层结论的开放张力：${factSections.openTensionsLine}`,
      `时间线合同：\n${timelineContext?.briefingMarkdown || "无"}`,
      `角色知识边界：\n${renderCharacterKnowledgeBoundary(characterKnowledgeBoundary)}`,
      `连续性护栏：允许入口=${(continuityGuard?.allowedEntryModes || []).join("；") || "无"}｜禁止重开=${(continuityGuard?.forbiddenRestartTerms || []).join("；") || "无"}｜上章压力=${continuityGuard?.resumeFrom || "无"}`,
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
    agentComplexity: "simple",
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
    agentComplexity: "simple",
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
  chapterSlot = null,
  continuityGuard = null,
  factContext = null,
  timelineContext = null,
  characterKnowledgeBoundary = null,
  previousOutline,
  nextLegacyPlan = null,
}) {
  const previousPlan = previousOutline?.chapterPlan || null;
  const factSections = buildFactPromptSections(factContext);
  const result = await provider.generateText({
    agentComplexity: "complex",
    instructions:
      "你是 Novelex 的 ChapterContinuityAgent。你专门负责章节之间的细粒度衔接：上一章怎么接进来、当前章主承接哪条线、哪些副线只能轻触、以及本章结尾要把什么压力递交给下一章。你只能在提供的证据范围内组织承接方式，不允许自由脑补失去意识、惊醒、重新确认身份等桥段。不要做全书语义总结，不要生成细纲或正文，只输出 JSON。",
    input: [
      projectSummary(project),
      `当前章节：${chapterBase.chapterId}（第 ${chapterBase.chapterNumber} 章）`,
      `章节锚点：${chapterSlot ? JSON.stringify({
        mission: chapterSlot.mission,
        expectedCarryover: chapterSlot.expectedCarryover,
        expectedEscalation: chapterSlot.expectedEscalation,
      }) : "无"}`,
      `本章使命：${stagePlanning.chapterMission || "无"}`,
      `本章必须推进：${(stagePlanning.requiredBeats || []).join("；") || "无"}`,
      `历史优先线程：${(historyPlanning.priorityThreads || []).join("；") || "无"}`,
      `必须继承的已定事实：${factSections.establishedFactsLine}`,
      `可以继续发酵但不能改写底层结论的开放张力：${factSections.openTensionsLine}`,
      `时间线合同：\n${timelineContext?.briefingMarkdown || "无"}`,
      `角色知识边界：\n${renderCharacterKnowledgeBoundary(characterKnowledgeBoundary)}`,
      `连续性护栏：默认入口=${continuityGuard?.defaultEntryMode || "direct_resume"}｜允许入口=${(continuityGuard?.allowedEntryModes || []).join("；") || "无"}｜上章压力=${continuityGuard?.resumeFrom || "无"}｜证据引用=${(continuityGuard?.mandatoryEvidenceRefs || []).join("；") || "无"}`,
      `上一章定稿细纲：\n${previousPlan ? [
        `- 章节：${previousPlan.chapterId} ${previousPlan.title}`,
        `- 主线：${previousPlan.dominantThread || "无"}`,
        `- 场景链：${(previousPlan.scenes || []).map(sceneChainDigest).join(" || ") || "无"}`,
        `- 章末压力：${previousPlan.exitPressure || previousPlan.nextHook || "无"}`,
      ].join("\n") : "无（当前为开篇章节）"}`,
      `下一章旧章卡：${nextLegacyPlan ? `${nextLegacyPlan.chapterId} ${nextLegacyPlan.title}｜钩子:${nextLegacyPlan.nextHook || "无"}` : "无"}`,
      `请输出 JSON：
{
  "entryMode": "direct_resume",
  "entryLink": "本章开头应该承接上一章哪个结果/余波/动作压力",
  "dominantCarryoverThread": "本章主承接线程",
  "subordinateThreads": ["可穿插但不能喧宾夺主的副线程"],
  "mustAdvanceThisChapter": "本章必须推进到什么程度",
  "canPauseThisChapter": ["本章可以暂缓的线程"],
  "exitPressureToNextChapter": "本章结尾要递给下一章的直接压力",
  "continuityRisks": ["最容易断裂或跳线的位置"],
  "evidenceRefs": ["引用的证据 refId"],
  "unsupportedClaims": ["缺乏证据支持的设定或桥段"]
}`,
    ].join("\n\n"),
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
    entryMode: String(parsed.entryMode || "").trim(),
    entryLink: String(parsed.entryLink || "").trim(),
    dominantCarryoverThread: String(parsed.dominantCarryoverThread || "").trim(),
    subordinateThreads: normalizeStringList(parsed.subordinateThreads, 4),
    mustAdvanceThisChapter: String(parsed.mustAdvanceThisChapter || "").trim(),
    canPauseThisChapter: normalizeStringList(parsed.canPauseThisChapter, 4),
    exitPressureToNextChapter: String(parsed.exitPressureToNextChapter || "").trim(),
    continuityRisks: normalizeStringList(parsed.continuityRisks, 5),
    evidenceRefs: normalizeStringList(parsed.evidenceRefs, 8),
    unsupportedClaims: normalizeStringList(parsed.unsupportedClaims, 6),
  };
}

function buildChapterOutlineVariantBriefs(variantCount, diversityPreset = "wide") {
  const profiles = [
    {
      name: "动作承压型",
      focus: "把上一章/本章入口压力直接落成连续动作链，优先写清每场因果交棒。",
      conflictAxis: "外部危险与主角即时决策互相挤压。",
      characterBias: "突出 POV 角色的行动判断和临场控制。",
      endingPressure: "以更急的行动窗口或直接危险收束。",
    },
    {
      name: "人物博弈型",
      focus: "把同一组硬性事件压进人物互不信任、试探和权力交换里。",
      conflictAxis: "盟友/对手/部属的利益与主角目标互相牵制。",
      characterBias: "突出关系压力、话语权争夺和人物选择代价。",
      endingPressure: "以关系条件、承诺代价或权力反噬收束。",
    },
    {
      name: "信息悬疑型",
      focus: "让关键事实、证据、误判风险逐场显影，保持硬事实不被改写。",
      conflictAxis: "已定事实、开放张力和未知信息之间制造推进。",
      characterBias: "突出角色知道什么、不知道什么，以及信息差如何驱动行动。",
      endingPressure: "以新证据、新误判风险或未解谜面收束。",
    },
    {
      name: "资源代价型",
      focus: "围绕资源、时间、秩序或执行成本设计每场升级。",
      conflictAxis: "目标必须推进，但每推进一步都会消耗关键资源或制造新债。",
      characterBias: "突出主角的管理偏执、代价意识和被迫妥协。",
      endingPressure: "以资源缺口、期限压缩或制度后果收束。",
    },
    {
      name: "多线编织型",
      focus: "在不跳线的前提下把主线和一条副线交错推进，明确每次切线因果。",
      conflictAxis: "主线压力与副线余波互相放大，但不得喧宾夺主。",
      characterBias: "突出不同角色在线索切换中的功能差异。",
      endingPressure: "以两条线汇合后的更大压力收束。",
    },
  ];
  const count = Math.max(1, Math.min(OUTLINE_VARIANT_COUNT_LIMITS.max, Math.round(Number(variantCount) || 1)));
  return Array.from({ length: count }, (_, index) => {
    const profile = profiles[index % profiles.length];
    return {
      ...profile,
      index: index + 1,
      proposalId: `proposal_${index + 1}`,
      diversityPreset,
    };
  });
}

function buildChapterOutlineVariantInput({
  project,
  chapterBase,
  chapterSlot = null,
  outlineOptions,
  stagePlanning,
  characterPlanning,
  historyPlanning,
  continuityPlanning,
  continuityGuard = null,
  outlineGenerationContract = null,
  contextConflicts = null,
  factContext = null,
  timelineContext = null,
  characterKnowledgeBoundary = null,
  foreshadowingActions = [],
  styleGuideText,
  openingReferencePacket = null,
  legacyPlan = null,
  feedback = "",
  previousHistory = [],
  variantBrief,
}) {
  const factSections = buildFactPromptSections(factContext);
  return [
    projectSummary(project),
    `当前章节：${chapterBase.chapterId}（第 ${chapterBase.chapterNumber} 章）`,
    `章节锚点：${chapterSlot ? JSON.stringify({
      titleHint: chapterSlot.titleHint,
      mission: chapterSlot.mission,
      expectedCarryover: chapterSlot.expectedCarryover,
      expectedEscalation: chapterSlot.expectedEscalation,
      forbidReplayBeats: chapterSlot.forbidReplayBeats,
    }) : "无"}`,
    `阶段任务：${stagePlanning.chapterMission || "无"}`,
    `必须落地：${(stagePlanning.requiredBeats || []).join("；") || "无"}`,
    `必须保留：${(stagePlanning.mustPreserve || []).join("；") || "无"}`,
    `延后兑现：${(stagePlanning.deferRules || []).join("；") || "无"}`,
    `角色建议：推荐 POV=${characterPlanning.recommendedPov || chapterBase.povCharacter}｜必须登场=${(characterPlanning.mustAppear || []).join("、") || "无"}｜可选登场=${(characterPlanning.optionalCharacters || []).join("、") || "无"}`,
    `关系压力：${(characterPlanning.relationshipPressures || []).join("；") || "无"}`,
    `必须继承的已定事实：${factSections.establishedFactsLine}`,
    `可以继续发酵但不能改写底层结论的开放张力：${factSections.openTensionsLine}`,
    `时间线合同：\n${timelineContext?.briefingMarkdown || "无"}`,
    `角色知识边界：\n${renderCharacterKnowledgeBoundary(characterKnowledgeBoundary)}`,
    `历史承接：事实=${(historyPlanning.carryOverFacts || []).join("；") || "无"}｜优先线程=${(historyPlanning.priorityThreads || []).join("；") || "无"}｜背景线程=${(historyPlanning.backgroundThreads || []).join("；") || "无"}｜压低线程=${(historyPlanning.suppressedThreads || []).join("；") || "无"}｜余波=${historyPlanning.lastEnding || "无"}`,
    `连续性护栏：默认入口=${continuityGuard?.defaultEntryMode || "direct_resume"}｜允许入口=${(continuityGuard?.allowedEntryModes || []).join("；") || "无"}｜必须引用=${(outlineGenerationContract?.mandatoryEvidenceRefs || []).join("；") || "无"}｜上章压力=${continuityGuard?.resumeFrom || "无"}`,
    `章节衔接：开场承接=${continuityPlanning.entryLink || "无"}｜入口模式=${continuityPlanning.entryMode || "direct_resume"}｜主承接线程=${continuityPlanning.dominantCarryoverThread || "无"}｜必须推进到=${continuityPlanning.mustAdvanceThisChapter || "无"}｜章末递交压力=${continuityPlanning.exitPressureToNextChapter || "无"}｜连贯性风险=${(continuityPlanning.continuityRisks || []).join("；") || "无"}｜不支持声明=${(continuityPlanning.unsupportedClaims || []).join("；") || "无"}`,
    `细纲生成合同：${outlineGenerationContract ? JSON.stringify(outlineGenerationContract) : "无"}`,
    `上下文冲突已解：${(contextConflicts?.conflicts || []).map((item) => `${item.source}.${item.field || ""}:${item.reason}->${item.resolution}`).join("；") || "无"}`,
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
    `并发候选模式：本轮共有 ${outlineOptions.variantCount} 个 VariantAgent。你只负责 ${variantBrief.proposalId}，不要生成其他候选，也不要引用其他候选的具体场景。`,
    `当前 Variant：${variantBrief.proposalId}｜${variantBrief.name}`,
    `差异化方向：${variantBrief.focus}`,
    `冲突轴：${variantBrief.conflictAxis}`,
    `人物焦点：${variantBrief.characterBias}`,
    `章末压力偏向：${variantBrief.endingPressure}`,
    "生成要求：先判断本章是 single_spine / dual_spine / braided。若是 single_spine，大多数 scenes 必须服务同一条主线，后一场必须承接前一场的结果、信息或压力；若是 dual_spine 或 braided，每个 scene 必须标明 threadId，并让切线有明确因果，不要机械切场。第一场必须响应“开场承接”和“时间线合同”，末场必须落到“章末递交压力”。如果使用时间跳跃，必须在 timeInStory、entryLink、continuityAnchors 与第一场 inheritsFromPrevious 中说明跳过的故事时间、跳过期间保留的代价和未解决压力；不要为了跳时清空资源、伤势、敌情或倒计时。",
    "硬规则：当 forbidRestartOpening=true 时，第一场不得出现惊醒/醒来/重新确认身份/重新穿越；只有证据允许时才可使用 wake_after_unconsciousness。",
    `请输出 JSON：
{
  "proposal": {
    "proposalId": "${variantBrief.proposalId}",
    "summary": "一句话概括这个方案",
    "rationale": "为什么这样安排",
    "diffSummary": "本 variant 与其他方向最主要的差异",
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
    "entryMode": "direct_resume",
    "entryLink": "本章开场承接点",
    "exitPressure": "本章末尾递交给下一章的直接压力",
    "charactersPresent": ["角色A", "角色B"],
    "continuityAnchors": ["连续性锚点1", "连续性锚点2"],
    "evidenceRefs": ["引用的证据 refId"],
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
}`,
  ].filter(Boolean).join("\n\n");
}

function selectOutlineVariantProposal(parsed, expectedProposalId) {
  const proposals = Array.isArray(parsed?.proposals)
    ? parsed.proposals
    : Array.isArray(parsed?.candidates)
      ? parsed.candidates
      : [];
  const rawProposal = (parsed?.proposal && typeof parsed.proposal === "object" && !Array.isArray(parsed.proposal))
    ? parsed.proposal
    : proposals.find((proposal) => String(proposal?.proposalId || proposal?.id || "").trim() === expectedProposalId) ||
      proposals[0] ||
      (parsed?.title || parsed?.scenes ? parsed : null);

  if (!rawProposal || typeof rawProposal !== "object" || Array.isArray(rawProposal)) {
    return null;
  }

  return {
    ...rawProposal,
    proposalId: expectedProposalId,
  };
}

async function runChapterOutlineVariantAgent(options) {
  const { provider, chapterBase, outlineOptions, variantBrief } = options;
  const result = await provider.generateText({
    agentComplexity: "complex",
    instructions:
      "你是 Novelex 的 ChapterOutlineAgent / ChapterOutlineVariantAgent。你是并发候选生成中的一个独立 variant agent，只生成自己负责的一个章节细纲候选。你必须与其他 variant 在冲突轴、人物焦点、场景链和章末压力上拉开差异，但不能违反已定事实、章节衔接和细纲生成合同。只输出 JSON。",
    input: buildChapterOutlineVariantInput(options),
    temperature: outlineOptions.temperature,
    metadata: {
      feature: "chapter_outline_variant_candidate",
      chapterId: chapterBase.chapterId,
      variantIndex: variantBrief.index,
      proposalId: variantBrief.proposalId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`ChapterOutlineVariantAgent ${variantBrief.proposalId} 返回了无法解析的 JSON：${createExcerpt(result.text || "", 220)}`);
  }

  const proposal = selectOutlineVariantProposal(parsed, variantBrief.proposalId);
  if (!proposal) {
    throw new Error(`ChapterOutlineVariantAgent ${variantBrief.proposalId} 没有返回可用候选。`);
  }

  return normalizeOutlineProposal(proposal, variantBrief.index - 1, options);
}

async function generateChapterOutlineCandidates(options) {
  const { outlineOptions } = options;
  const variantBriefs = buildChapterOutlineVariantBriefs(outlineOptions.variantCount, outlineOptions.diversityPreset);
  const candidates = await Promise.all(
    variantBriefs.map((variantBrief) => runChapterOutlineVariantAgent({
      ...options,
      variantBrief,
    })),
  );

  if (!candidates.length) {
    throw new Error("ChapterOutlineVariantAgent 没有返回可用候选。");
  }

  return candidates;
}

function fallbackStagePlanningContext({ chapterBase, chapterSlot, stage, foreshadowingActions, legacyPlan }) {
  return {
    source: "fallback",
    chapterMission: chapterSlot?.mission || stage?.stageGoal || stage?.purpose || `${chapterBase.chapterId} 需要承接当前阶段的主线推进。`,
    requiredBeats: normalizeStringList([
      chapterSlot?.expectedCarryover,
      chapterSlot?.expectedEscalation,
      ...(legacyPlan?.keyEvents || []),
      ...(foreshadowingActions || []).map((item) => `${item.action}:${item.description}`),
    ], 4),
    mustPreserve: normalizeStringList([
      chapterSlot?.expectedCarryover,
      `阶段保持为 ${chapterBase.stage}`,
      `章节编号保持 ${chapterBase.chapterId}`,
    ], 4),
    deferRules: normalizeStringList([
      ...((stage?.stageConflicts || []).slice(2)),
    ], 4),
    suggestedConflictAxis: normalizeStringList(stage?.stageConflicts || [], 4),
    titleSignals: normalizeStringList([
      ...(legacyPlan?.title ? [legacyPlan.title] : []),
      chapterSlot?.titleHint,
      chapterBase.stage,
    ], 3),
    nextPressure: legacyPlan?.nextHook || chapterSlot?.nextHookSeed || stage?.stageGoal || "",
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
  const chapterSlot = chapterSlotReference(bundle, chapterNumber) || fallbackChapterSlot({
    project,
    chapterNumber,
    stage,
    foreshadowingActions,
  });
  const chapterBase = buildOutlineBaseChapterPlan({
    project,
    chapterNumber,
    stage,
    legacyPlan,
    chapterSlot,
    foreshadowingActions,
  });
  const currentCharacterStates = await loadCurrentCharacterStates(store, bundle);
  const chapterMetas = await store.listChapterMeta();
  const committedOutlines = (await store.listCommittedChapterOutlines())
    .map(chapterOutlineDigest)
    .filter((item) => item.chapterNumber < chapterNumber);
  const { styleGuideText, styleGuideSourcePath } = await resolveStyleBaseline(store, provider, project, chapterBase);

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
  const characterKnowledgeBoundary = buildCharacterKnowledgeBoundary({
    characterStates: currentCharacterStates,
    factContext,
  });

  const continuityGuard = await buildDeterministicContinuityGuard({
    provider,
    store,
    chapterBase,
    chapterSlot,
    committedOutlines,
    factContext,
  });
  const outlineGenerationContract = buildOutlineGenerationContract({
    chapterBase,
    chapterSlot,
    continuityGuard,
  });
  const timelineState = await loadTimelineState(store);
  const previousChapterId = chapterNumber > 1 ? chapterIdFromNumber(chapterNumber - 1) : "";
  const previousChapterTail = previousChapterId
    ? createExcerpt(
      await store.readText(path.join(store.paths.chaptersDir, `${previousChapterId}.md`), ""),
      900,
    )
    : "";
  const temporalPlanning = await runTemporalPlanningAgent({
    provider,
    project,
    chapterPlan: chapterBase,
    timelineState,
    previousOutline: committedOutlines.at(-1) || null,
    previousChapterTail,
    factContext,
  });
  const timelineContext = buildTimelineContextPacket({
    chapterPlan: chapterBase,
    timelineState,
    temporalPlanning,
  });

  stagePlanning = await runStagePlanningContextAgent({
    provider,
    project,
    bundle,
    chapterBase,
    chapterSlot,
    stage,
    foreshadowingActions,
    legacyPlan,
    committedOutlines,
    factContext,
    timelineContext,
    continuityGuard,
    characterKnowledgeBoundary,
  });

  characterPlanning = await runCharacterPlanningContextAgent({
    provider,
    project,
    bundle,
    chapterBase,
    currentCharacterStates,
    stage,
  });

  historyPlanning = await runHistoryPlanningContextAgent({
    provider,
    project,
    chapterBase,
    committedOutlines,
  });

  continuityPlanning = await runChapterContinuityAgent({
    provider,
    project,
    chapterBase,
    stagePlanning,
    historyPlanning,
    chapterSlot,
    continuityGuard,
    factContext,
    timelineContext,
    characterKnowledgeBoundary,
    previousOutline: committedOutlines.at(-1)?.chapterPlan ? committedOutlines.at(-1) : null,
    nextLegacyPlan,
  });
  continuityPlanning = sanitizeContinuityPlanningWithGuard(continuityPlanning, continuityGuard);

  const shouldUseOpeningReference = chapterNumber <= 3 || Boolean(chapterSlot?.freshStart);
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
    openingReferencePacket = await scopeOpeningReferencePacketWithAgent(provider, openingReferencePacket, {
      chapterNumber,
      freshStart: chapterSlot?.freshStart || chapterNumber === 1,
      continuityGuard,
    });
  }
  const resolvedContexts = resolveOutlineContexts({
    chapterBase,
    chapterSlot,
    stagePlanning,
    historyPlanning,
    continuityPlanning,
    openingReferencePacket,
    continuityGuard,
    outlineGenerationContract,
  });
  stagePlanning = resolvedContexts.stagePlanning;
  historyPlanning = resolvedContexts.historyPlanning;
  continuityPlanning = resolvedContexts.continuityPlanning;
  openingReferencePacket = resolvedContexts.openingReferencePacket;
  const contextConflicts = resolvedContexts.contextConflicts;
  const briefingMarkdown = buildOutlineContextMarkdown({
    chapterBase,
    chapterSlot,
    stagePlanning,
    characterPlanning,
    historyPlanning,
    continuityPlanning,
    continuityGuard,
    contextConflicts,
    outlineGenerationContract,
    factContext,
    timelineContext,
    characterKnowledgeBoundary,
    outlineOptions: normalizedOutlineOptions,
    foreshadowingActions,
    legacyPlan,
  });
  const baseContext = {
    chapterId: chapterBase.chapterId,
    chapterNumber,
    generatedAt: nowIso(),
    chapterSlot,
    stagePlanning,
    characterPlanning,
    historyPlanning,
    continuityPlanning,
    continuityGuard,
    contextConflicts,
    outlineGenerationContract,
    factContext,
    timelineContext,
    characterKnowledgeBoundary,
    outlineOptions: normalizedOutlineOptions,
    warnings,
    briefingMarkdown,
    summaryText: createExcerpt(briefingMarkdown, 320),
  };
  const chapterOutlineContext = mergeOpeningIntoOutlineContext(baseContext, openingReferencePacket);

  return {
    chapterBase,
    chapterSlot,
    stage,
    legacyPlan,
    nextLegacyPlan,
    foreshadowingActions,
    currentCharacterStates,
    chapterMetas,
    committedOutlines,
    styleGuideText,
    styleGuideSourcePath,
    continuityGuard,
    contextConflicts,
    outlineGenerationContract,
    openingReferencePacket,
    outlineOptions: normalizedOutlineOptions,
    factContext,
    timelineContext,
    characterKnowledgeBoundary,
    chapterOutlineContext,
  };
}

function buildChapterOutlineResourcesFromDraft({
  draftBundle,
  bundle,
  chapterNumber,
  outlineOptions = null,
  committedOutlines = [],
}) {
  const chapterBase =
    draftBundle?.chapterPlan ||
    (bundle?.structureData?.chapters || []).find((item) => Number(item.chapterNumber || 0) === Number(chapterNumber || 0)) ||
    {};
  const chapterOutlineContext = draftBundle?.chapterOutlineContext || {};
  const factContext = draftBundle?.factContext || chapterOutlineContext?.factContext || null;
  const timelineContext = draftBundle?.timelineContext || chapterOutlineContext?.timelineContext || null;
  const characterKnowledgeBoundary =
    draftBundle?.characterKnowledgeBoundary ||
    chapterOutlineContext?.characterKnowledgeBoundary ||
    buildCharacterKnowledgeBoundary({
      characterStates: draftBundle?.characterStates || [],
      factContext,
    });
  return {
    chapterBase,
    chapterSlot: draftBundle?.chapterSlot || null,
    stage: findStageForChapterNumber(bundle?.structureData, Number(chapterNumber || chapterBase.chapterNumber || 0)),
    legacyPlan: legacyChapterReference(bundle, Number(chapterNumber || chapterBase.chapterNumber || 0)),
    nextLegacyPlan: legacyChapterReference(bundle, Number(chapterNumber || chapterBase.chapterNumber || 0) + 1),
    foreshadowingActions: Array.isArray(chapterBase?.foreshadowingActions) ? chapterBase.foreshadowingActions : [],
    currentCharacterStates: draftBundle?.characterStates || [],
    chapterMetas: [],
    committedOutlines,
    styleGuideText: "",
    styleGuideSourcePath: "",
    continuityGuard: draftBundle?.continuityGuard || chapterOutlineContext?.continuityGuard || null,
    contextConflicts: draftBundle?.contextConflicts || chapterOutlineContext?.contextConflicts || {},
    outlineGenerationContract: draftBundle?.outlineGenerationContract || chapterOutlineContext?.outlineGenerationContract || {},
    openingReferencePacket: draftBundle?.openingReferencePacket || createEmptyOpeningReferencePacket({ mode: "chapter_outline" }),
    outlineOptions: normalizeOutlineOptions(outlineOptions || draftBundle?.reviewState?.outlineOptions || chapterOutlineContext?.outlineOptions || null),
    factContext,
    timelineContext,
    characterKnowledgeBoundary,
    chapterOutlineContext: {
      stagePlanning: chapterOutlineContext.stagePlanning || fallbackStagePlanningContext({
        chapterBase,
        chapterSlot: draftBundle?.chapterSlot || null,
        stage: findStageForChapterNumber(bundle?.structureData, Number(chapterNumber || chapterBase.chapterNumber || 0)),
        foreshadowingActions: Array.isArray(chapterBase?.foreshadowingActions) ? chapterBase.foreshadowingActions : [],
        legacyPlan: legacyChapterReference(bundle, Number(chapterNumber || chapterBase.chapterNumber || 0)),
      }),
      characterPlanning: chapterOutlineContext.characterPlanning || fallbackCharacterPlanningContext({
        bundle,
        chapterBase,
        legacyPlan: legacyChapterReference(bundle, Number(chapterNumber || chapterBase.chapterNumber || 0)),
        currentCharacterStates: draftBundle?.characterStates || [],
      }),
      historyPlanning: chapterOutlineContext.historyPlanning || fallbackHistoryPlanningContext({ committedOutlines }),
      continuityPlanning: chapterOutlineContext.continuityPlanning || buildFallbackContinuityPlanning({
        chapterBase,
        stagePlanning: chapterOutlineContext.stagePlanning || {},
        historyPlanning: chapterOutlineContext.historyPlanning || fallbackHistoryPlanningContext({ committedOutlines }),
        previousOutline: committedOutlines.at(-1)?.chapterPlan ? committedOutlines.at(-1) : null,
        nextLegacyPlan: legacyChapterReference(bundle, Number(chapterNumber || chapterBase.chapterNumber || 0) + 1),
      }),
      continuityGuard: draftBundle?.continuityGuard || chapterOutlineContext?.continuityGuard || null,
      contextConflicts: draftBundle?.contextConflicts || chapterOutlineContext?.contextConflicts || {},
      outlineGenerationContract: draftBundle?.outlineGenerationContract || chapterOutlineContext?.outlineGenerationContract || {},
      factContext,
      timelineContext,
      characterKnowledgeBoundary,
      briefingMarkdown: chapterOutlineContext.briefingMarkdown || "",
      summaryText: chapterOutlineContext.summaryText || "",
      warnings: chapterOutlineContext.warnings || [],
    },
  };
}

function buildChapterOutlinePreparationSteps(resources, candidates = [], outlineContinuityAudit = {}) {
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
      "temporal_planning_agent",
      "TemporalPlanningAgent",
      "write",
      resources.timelineContext?.temporalPlanning?.source === "agent"
        ? "已生成本章时间承接与可用时间跳跃合同。"
        : "时间规划 Agent 不可用，已使用保守时间承接合同。",
      { preview: createExcerpt(resources.timelineContext?.temporalPlanning?.recommendedTransition || resources.timelineContext?.summaryText || "", 180) },
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
    step(
      "continuity_guard",
      "DeterministicContinuityGuard",
      "write",
      "已根据已批准正文、锁章细纲与 canon facts 建立连续性硬护栏。",
      { preview: createExcerpt(resources.continuityGuard?.resumeFrom || "", 180) },
    ),
    step(
      "outline_context_resolver",
      "OutlineContextResolver",
      "write",
      "已按固定优先级解析上下文冲突，压制不受支持的重开开篇 beat。",
      { preview: createExcerpt(JSON.stringify(resources.contextConflicts?.conflicts || []), 180) },
    ),
  ];

  if (resources.openingReferencePacket?.triggered) {
    steps.push(step(
      "opening_reference_packet",
      "OpeningPatternSynthesizerAgent",
      "write",
      `已为 ${resources.chapterBase.chapterId} 提炼黄金三章结构参考。`,
      { preview: createExcerpt(resources.openingReferencePacket.summary || "", 180) },
    ));
  }

  steps.push(
    step(
      "chapter_outline_variant_agents",
      "ChapterOutlineVariantAgents",
      "write",
      `已生成 ${candidates.length} 个章节细纲候选，等待作者选择、组合或反馈重生。`,
      { preview: candidates.map((item) => item.proposalId).join(" / ") },
    ),
    buildOutlineConsistencyRunStep(outlineContinuityAudit),
    ...buildOutlineRepairRunSteps(outlineContinuityAudit),
  );

  return steps;
}

function mergeOutlineCandidatesForManualReview(existingCandidates = [], repairedCandidates = []) {
  const byId = new Map((Array.isArray(existingCandidates) ? existingCandidates : [])
    .map((candidate) => [candidate?.proposalId, candidate]));
  for (const candidate of Array.isArray(repairedCandidates) ? repairedCandidates : []) {
    byId.set(candidate?.proposalId, candidate);
  }
  return sortCandidatesByOutlineAudit([...byId.values()], []);
}

async function stageChapterOutlineManualReview({
  store,
  projectState,
  chapterNumber,
  draftBundle,
  chapterOutlineCandidates,
  chapterOutlineHistory,
  outlineContinuityAudit,
  selectedChapterOutline = null,
}) {
  const blockingOutlineIssues = summarizeOutlineAuditReasons(outlineContinuityAudit?.candidateAudits || [], 12);
  const run = {
    id: runId("write"),
    phase: "write",
    startedAt: nowIso(),
    finishedAt: nowIso(),
    target: REVIEW_TARGETS.CHAPTER_OUTLINE,
    chapterId: draftBundle?.chapterId || draftBundle?.chapterPlan?.chapterId || "",
    steps: [
      buildOutlineConsistencyRunStep(outlineContinuityAudit),
      ...buildOutlineRepairRunSteps(outlineContinuityAudit),
      step(
        "outline_consistency_manual_review",
        "Outline Manual Review",
        "write",
        outlineContinuityAudit?.auditDegraded
          ? "细纲语义审计降级，已停止自动放行并等待人工复核。"
          : `细纲在 ${OUTLINE_CONSISTENCY_MAX_ATTEMPTS} 轮自动修复后仍存在关键连续性冲突，已转入人工复核。`,
        {
          preview: createExcerpt(blockingOutlineIssues.join("；") || outlineContinuityAudit?.summary || "", 180),
        },
      ),
    ],
    summary: outlineContinuityAudit?.auditDegraded
      ? `${draftBundle?.chapterPlan?.chapterId || draftBundle?.chapterId || "当前章节"} 的细纲一致性审计降级，已进入人工复核。`
      : `${draftBundle?.chapterPlan?.chapterId || draftBundle?.chapterId || "当前章节"} 的细纲在自动修复后仍未通过一致性审计，已进入人工复核。`,
  };

  await store.stageChapterDraft({
    ...draftBundle,
    chapterOutlineCandidates,
    chapterOutlineHistory,
    outlineContinuityAudit,
    selectedChapterOutline,
    timelineContext: draftBundle?.timelineContext || draftBundle?.chapterOutlineContext?.timelineContext || null,
    reviewState: {
      ...(draftBundle?.reviewState || {}),
      mode: "outline_review",
      target: REVIEW_TARGETS.CHAPTER_OUTLINE,
      availableProposalIds: (chapterOutlineCandidates || []).map((item) => item.proposalId),
      outlineOptions: draftBundle?.reviewState?.outlineOptions || normalizeOutlineOptions(null),
      lastFeedback: selectedChapterOutline?.authorNotes || draftBundle?.reviewState?.lastFeedback || "",
      manualReviewRequired: true,
      auditDegraded: Boolean(outlineContinuityAudit?.auditDegraded),
      blockingOutlineIssues,
    },
  });
  await store.saveRun(run);

  projectState.phase.write = {
    ...projectState.phase.write,
    status: WRITE_STATUS.CHAPTER_OUTLINE_PENDING_REVIEW,
    pendingReview: {
      target: REVIEW_TARGETS.CHAPTER_OUTLINE,
      chapterId: draftBundle?.chapterPlan?.chapterId || draftBundle?.chapterId || "",
      chapterNumber,
      requestedAt: nowIso(),
      runId: run.id,
    },
    lastRunId: run.id,
    rejectionNotes: blockingOutlineIssues,
  };

  const savedProject = await store.saveProject(projectState);
  return {
    project: savedProject,
    run,
  };
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
    agentComplexity: "complex",
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
      `时间线合同：\n${resources.timelineContext?.briefingMarkdown || resources.chapterOutlineContext?.timelineContext?.briefingMarkdown || "无"}`,
      `角色知识边界：\n${renderCharacterKnowledgeBoundary(resources.characterKnowledgeBoundary || resources.chapterOutlineContext?.characterKnowledgeBoundary || null)}`,
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
  const { styleGuideText, styleGuideSourcePath } = await resolveStyleBaseline(store, provider, project, chapterPlan);
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
  const timelineState = await loadTimelineState(store);
  const chapterNumber = Number(chapterPlan?.chapterNumber || 0);
  const previousChapterId = chapterNumber > 1 ? chapterIdFromNumber(chapterNumber - 1) : "";
  const previousChapterTail = previousChapterId
    ? createExcerpt(await store.readText(path.join(store.paths.chaptersDir, `${previousChapterId}.md`), ""), 900)
    : "";
  const committedOutlines = (await store.listCommittedChapterOutlines())
    .map(chapterOutlineDigest)
    .filter((item) => item.chapterNumber < chapterNumber);
  const temporalPlanning = await runTemporalPlanningAgent({
    provider,
    project,
    chapterPlan,
    timelineState,
    previousOutline: committedOutlines.at(-1) || null,
    previousChapterTail,
    factContext,
  });
  const timelineContext = buildTimelineContextPacket({
    chapterPlan,
    timelineState,
    temporalPlanning,
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
    openingReferencePacket = await scopeOpeningReferencePacketWithAgent(provider, openingReferencePacket, {
      chapterNumber: Number(chapterPlan?.chapterNumber || 0) || 1,
      freshStart: Number(chapterPlan?.chapterNumber || 0) <= 1,
    });
  }
  const writerContextWithReference = mergeReferenceIntoWriterContext(baseWriterContext, referencePacket);
  const writerContext = mergeOpeningIntoWriterContext(writerContextWithReference, openingReferencePacket);
  const governance = await buildGovernanceResources({
    provider,
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
    timelineContext,
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
    timelineContext,
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
      "从锁定大纲中筛选当前章节必须兑现、必须延后与最容易写偏的主轴。",
      { preview: createExcerpt(resources.planContext.outline.recommendedFocus || resources.planContext.summaryText || "", 160) },
    ),
    step(
      "plan_context_character_agent",
      "CharacterContextAgent",
      "write",
      `整理 ${resources.focusedCharacterStates.length} 名登场角色的当前诉求、知识边界与关系压力。`,
      {
        preview: createExcerpt(resources.planContext.characters.writerReminders.join("；"), 180),
      },
    ),
    step(
      "plan_context_world_agent",
      "WorldContextAgent",
      "write",
      "从世界观、世界状态、伏笔与风格指南中筛出本章有效约束。",
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
      resources.historyPacket.relatedChapters.length
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
      resources.historyPacket.relatedChapters.length
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
      "temporal_planning_agent",
      "TemporalPlanningAgent",
      "write",
      resources.timelineContext?.temporalPlanning?.source === "agent"
        ? "已生成本章时间承接与时间跳跃合同，供 Writer 执行。"
        : "时间规划 Agent 不可用，已使用保守时间承接合同。",
      { preview: createExcerpt(resources.timelineContext?.temporalPlanning?.recommendedTransition || resources.timelineContext?.summaryText || "", 180) },
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
      "reference_recall_agent",
      "ReferenceRecallAgent",
      "write",
      resources.referencePacket.triggered
        ? `LLM 检索命中 ${(resources.referencePacket.matches || []).length} 个范文片段，并整理出可借鉴写法。`
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
      "合并计划侧与历史侧上下文，生成 Writer 直写正文所需的上下文包。",
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
    timelineContext: resources.timelineContext,
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
    timelineContext: resources.timelineContext,
    promptTelemetry: {
      writerPromptPacket: null,
    },
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

  const derivedState = await buildDerivedChapterStateArtifacts({
    provider,
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
      "audit_analyzer",
      "AuditAnalyzerAgent",
      "write",
      validation.summary,
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
    chapterSlot: outlineArtifacts?.chapterSlot || null,
    chapterOutlineContext: outlineArtifacts?.chapterOutlineContext || {},
    chapterOutlineCandidates: outlineArtifacts?.chapterOutlineCandidates || [],
    chapterOutlineHistory: outlineArtifacts?.chapterOutlineHistory || [],
    outlineContinuityAudit: outlineArtifacts?.outlineContinuityAudit || {},
    selectedChapterOutline: outlineArtifacts?.selectedChapterOutline || null,
    chapterMarkdown: chapterDraft.markdown,
    sceneDrafts: chapterDraft.sceneDrafts,
    researchPacket: resources.researchPacket,
    referencePacket: resources.referencePacket,
    openingReferencePacket: resources.openingReferencePacket,
    continuityGuard: outlineArtifacts?.continuityGuard || null,
    contextConflicts: outlineArtifacts?.contextConflicts || {},
    outlineGenerationContract: outlineArtifacts?.outlineGenerationContract || {},
    timelineContext: resources.timelineContext || outlineArtifacts?.timelineContext || null,
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
    writerPromptPacket: rewriteContext.promptTelemetry.writerPromptPacket || null,
    factContext: resources.factContext,
    timelineContext: resources.timelineContext,
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
  const initialCandidates = await generateChapterOutlineCandidates({
    provider,
    project: projectState.project,
    bundle,
    chapterBase: resources.chapterBase,
    chapterSlot: resources.chapterSlot,
    outlineOptions: resources.outlineOptions,
    stagePlanning: resources.chapterOutlineContext.stagePlanning,
    characterPlanning: resources.chapterOutlineContext.characterPlanning,
    historyPlanning: resources.chapterOutlineContext.historyPlanning,
    continuityPlanning: resources.chapterOutlineContext.continuityPlanning,
    continuityGuard: resources.continuityGuard,
    outlineGenerationContract: resources.outlineGenerationContract,
    contextConflicts: resources.contextConflicts,
    factContext: resources.factContext,
    timelineContext: resources.timelineContext,
    characterKnowledgeBoundary: resources.characterKnowledgeBoundary,
    foreshadowingActions: resources.foreshadowingActions,
    styleGuideText: resources.styleGuideText,
    openingReferencePacket: resources.openingReferencePacket,
    legacyPlan: resources.legacyPlan,
    feedback,
    previousHistory: chapterOutlineHistory,
  });
  const consistencyResult = await runChapterOutlineConsistencyLoop({
    provider,
    project: projectState.project,
    bundle,
    resources,
    initialCandidates,
    chapterOutlineHistory,
    feedback,
    desiredCandidateCount: outlineOptions ? resources.outlineOptions.variantCount : null,
  });
  const candidates = consistencyResult.candidates;
  const outlineContinuityAudit = consistencyResult.outlineContinuityAudit;

  const historyEntry = {
    at: nowIso(),
    action: previousDraft ? "regenerate" : "generate",
    chapterId: resources.chapterBase.chapterId,
    chapterNumber,
    feedback,
    outlineOptions: resources.outlineOptions,
    proposalIds: candidates.map((item) => item.proposalId),
    outlineContinuityAudit,
  };
  chapterOutlineHistory.push(historyEntry);

  const run = {
    id: runId("write"),
    phase: "write",
    startedAt: nowIso(),
    finishedAt: nowIso(),
    target: REVIEW_TARGETS.CHAPTER_OUTLINE,
    chapterId: resources.chapterBase.chapterId,
    steps: buildChapterOutlinePreparationSteps(resources, candidates, outlineContinuityAudit),
    summary: outlineContinuityAudit.manualReviewRequired
      ? `${resources.chapterBase.chapterId} 的章节细纲候选仍存在跨章节一致性冲突，已进入人工复核。`
      : `${resources.chapterBase.chapterId} 的章节细纲候选已通过一致性审计，等待作者选择或组合。`,
  };

  await store.stageChapterDraft({
    chapterId: resources.chapterBase.chapterId,
    chapterPlan: resources.chapterBase,
    chapterSlot: resources.chapterSlot,
    chapterOutlineContext: resources.chapterOutlineContext,
    chapterOutlineCandidates: candidates,
    chapterOutlineHistory,
    outlineContinuityAudit,
    selectedChapterOutline: null,
    chapterMarkdown: "",
    sceneDrafts: [],
    validation: null,
    openingReferencePacket: resources.openingReferencePacket,
    continuityGuard: resources.continuityGuard,
    contextConflicts: resources.contextConflicts,
    outlineGenerationContract: resources.outlineGenerationContract,
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
    writerPromptPacket: previousDraft?.writerPromptPacket || null,
    factContext: resources.factContext,
    timelineContext: resources.timelineContext,
    providerSnapshot: provider.settings,
    reviewState: {
      mode: "outline_review",
      target: REVIEW_TARGETS.CHAPTER_OUTLINE,
      availableProposalIds: candidates.map((item) => item.proposalId),
      outlineOptions: resources.outlineOptions,
      lastFeedback: feedback || "",
      manualReviewRequired: Boolean(outlineContinuityAudit.manualReviewRequired),
      auditDegraded: Boolean(outlineContinuityAudit.auditDegraded),
      blockingOutlineIssues: summarizeOutlineAuditReasons(outlineContinuityAudit.candidateAudits || [], 12),
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
    rejectionNotes: outlineContinuityAudit.manualReviewRequired
      ? summarizeOutlineAuditReasons(outlineContinuityAudit.candidateAudits || [], 12)
      : feedback ? [feedback] : [],
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

export async function saveManualChapterEdit(
  store,
  {
    chapterBody = "",
  } = {},
) {
  const projectState = await store.loadProject();
  const pending = projectState.phase.write.pendingReview;
  if (!pending?.chapterId) {
    throw new Error("当前没有待审章节。");
  }
  if (String(pending.target || REVIEW_TARGETS.CHAPTER) !== REVIEW_TARGETS.CHAPTER) {
    throw new Error("当前待审节点不是章节正文，不能直接修改正文内容。");
  }

  const bundle = await loadCommittedPlanBundle(store);
  const draftBundle = await store.loadChapterDraft(pending.chapterId);
  if (!draftBundle) {
    throw new Error("找不到待审章节草稿。");
  }

  const chapterPlanBase =
    draftBundle.chapterPlan ||
    bundle.structureData.chapters.find((item) => item.chapterId === pending.chapterId);
  if (!chapterPlanBase) {
    throw new Error(`找不到 ${pending.chapterId} 对应的章纲。`);
  }

  const normalizedBody = String(chapterBody || "").replace(/\r\n?/g, "\n");
  if (!normalizedBody.trim()) {
    throw new Error("章节正文不能为空。");
  }

  const originalMarkdown = String(draftBundle.chapterMarkdown || "");
  const originalParts = splitChapterMarkdown(originalMarkdown, chapterPlanBase.title);
  if (!fragmentChanged(originalParts.body, normalizedBody)) {
    return {
      project: projectState,
      run: null,
      summary: `${pending.chapterId} 的正文没有变化。`,
    };
  }

  const rewrittenDraft = chapterDraftFromExactMarkdown(
    chapterPlanBase,
    composeChapterMarkdown(originalParts.title || chapterPlanBase.title, normalizedBody),
  );
  const currentCharacterStates = await loadCurrentCharacterStates(store, bundle);
  const researchPacket = researchPacketFromDraft(draftBundle);
  const referencePacket = referencePacketFromDraft(draftBundle);
  const openingReferencePacket = openingReferencePacketFromDraft(draftBundle);
  const historyPacket = historyContextFromDraft(draftBundle);
  const writerContext = writerContextFromDraft(draftBundle);
  const governance = governanceFromDraft(draftBundle, chapterPlanBase);
  const factContext = draftBundle?.factContext || null;
  const timelineContext = draftBundle?.timelineContext || draftBundle?.chapterOutlineContext?.timelineContext || null;
  const validation = createManualEditValidationSnapshot();
  const rewrittenState = buildManualEditDerivedState({
    draftBundle,
    chapterPlan: chapterPlanBase,
    chapterDraft: rewrittenDraft,
    fallbackCharacterStates: currentCharacterStates,
    fallbackWorldState: bundle.worldState,
    fallbackForeshadowingRegistry: draftBundle.foreshadowingRegistry || bundle.foreshadowingRegistry,
  });
  const canonFactIssues = [];
  const blockingAuditIssues = [];
  const manualReviewRequired = false;
  const manualReviewStrategy = "";
  const rewriteHistory = [
    ...(draftBundle.rewriteHistory || []),
    {
      at: nowIso(),
      mode: "manual_edit",
      strategy: "human_direct_edit",
      feedback: "",
      sceneIds: [],
      sceneOrder: [],
      selectionPreview: "",
      feedbackSupervisionPassed: true,
      feedbackSupervisionSummary: "人工直接修改正文后未自动审查，已直接回写待审草稿。",
      feedbackSupervisionAttempts: 0,
      blockingFeedbackIssues: [],
    },
  ];

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
    writerPromptPacket: draftBundle?.writerPromptPacket || null,
    factContext,
    timelineContext,
    auditDegraded: Boolean(validation?.auditDegraded),
    repairHistory: draftBundle?.repairHistory || [],
    lastUnresolvedCriticals: [],
    reviewState: {
      mode: "manual_edit",
      strategy: manualReviewRequired ? manualReviewStrategy : "human_direct_edit",
      lastFeedback: "",
      manualReviewRequired,
      manualReviewStrategy,
      auditDegraded: Boolean(validation?.auditDegraded),
      feedbackSupervisionPassed: true,
      feedbackSupervisionSummary: "人工直接修改正文后未自动审查，已直接回写待审草稿。",
      feedbackSupervisionAttempts: 0,
      feedbackSupervisionHistory: [],
      blockingFeedbackIssues: [],
      blockingAuditIssues,
      canonFactIssues,
      repairHistory: draftBundle?.repairHistory || [],
      lastUnresolvedCriticals: [],
      repairStagnated: false,
    },
    rewriteHistory,
  });

  const saveRun = {
    id: runId("write"),
    phase: "write",
    startedAt: nowIso(),
    finishedAt: nowIso(),
    target: REVIEW_TARGETS.CHAPTER,
    chapterId: pending.chapterId,
    summary: `${pending.chapterId} 的人工正文修改已保存，未自动审查，章节保持待审状态。`,
    steps: [
      step(
        "manual_edit_save",
        "Human Direct Edit",
        "write",
        "已保存人工直接修改后的章节正文，并回写待审草稿。",
        {
          preview: createExcerpt(normalizedBody, 120),
        },
      ),
      step(
        "manual_edit_validation",
        "ManualReviewQueue",
        "write",
        "人工直接修改正文后未自动审查，章节保持待审状态。",
        {
          preview: "未自动审查；请在待审界面继续人工确认或重写。",
        },
      ),
    ],
  };
  await store.saveRun(saveRun);

  projectState.phase.write = {
    ...projectState.phase.write,
    status: WRITE_STATUS.CHAPTER_PENDING_REVIEW,
    pendingReview: {
      ...pending,
      requestedAt: nowIso(),
      runId: saveRun.id,
    },
    rejectionNotes: [],
    rewriteHistory,
  };
  const savedProject = await store.saveProject(projectState);

  return {
    project: savedProject,
    run: saveRun,
    summary: `${pending.chapterId} 的人工修改已保存，未自动审查。`,
  };
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
    let reviewResources = null;
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
      reviewResources = resources;
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
    if (!reviewResources) {
      const committedOutlines = (await store.listCommittedChapterOutlines())
        .map(chapterOutlineDigest)
        .filter((item) => item.chapterNumber < pending.chapterNumber);
      reviewResources = buildChapterOutlineResourcesFromDraft({
        draftBundle,
        bundle,
        chapterNumber: pending.chapterNumber,
        outlineOptions: normalizedOutlineOptions,
        committedOutlines,
      });
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
    const selectionConsistencyResult = await runChapterOutlineConsistencyLoop({
      provider,
      project: projectState.project,
      bundle,
      resources: reviewResources,
      initialCandidates: [selectedOutline],
      chapterOutlineHistory: nextOutlineHistory,
      feedback: authorNotes || feedback || "",
    });
    const selectedOutlineAudit = selectionConsistencyResult.outlineContinuityAudit;
    if (selectedOutlineAudit.manualReviewRequired) {
      const nextCandidates = mergeOutlineCandidatesForManualReview(
        existingCandidates,
        selectionConsistencyResult.candidates,
      );
      return stageChapterOutlineManualReview({
        store,
        projectState,
        chapterNumber: pending.chapterNumber,
        draftBundle,
        chapterOutlineCandidates: nextCandidates,
        chapterOutlineHistory: selectionConsistencyResult.chapterOutlineHistory,
        outlineContinuityAudit: selectedOutlineAudit,
        selectedChapterOutline: null,
      });
    }
    selectedOutline = selectionConsistencyResult.candidates[0] || selectedOutline;

    const selectedChapterOutline = {
      mode: reviewAction === "approve_composed" ? "composed" : "single",
      selectedProposalId: reviewAction === "approve_composed" ? null : String(selectedProposalId || "").trim(),
      selectedSceneRefs: normalizedSelectedSceneRefs,
      authorNotes: authorNotes || feedback || "",
      chapterPlan: selectedOutline.chapterPlan,
      summary: selectedOutline.summary,
      rationale: selectedOutline.rationale,
      diffSummary: selectedOutline.diffSummary,
      source: reviewAction === "approve_composed" ? "manual_composed" : "manual_selection",
      syncedFrom: null,
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
        chapterOutlineHistory: selectionConsistencyResult.chapterOutlineHistory,
        outlineContinuityAudit: selectedOutlineAudit,
        selectedChapterOutline,
        chapterSlot: draftBundle.chapterSlot || null,
        continuityGuard: draftBundle.continuityGuard || reviewResources.continuityGuard || null,
        contextConflicts: draftBundle.contextConflicts || reviewResources.contextConflicts || {},
        outlineGenerationContract: draftBundle.outlineGenerationContract || reviewResources.outlineGenerationContract || {},
        timelineContext: draftBundle.timelineContext || reviewResources.timelineContext || reviewResources.chapterOutlineContext?.timelineContext || null,
      },
    });
  }

  if (approved) {
    let lockedChapterPlan;
    let lockedWorldState;
    let lockedForeshadowingRegistry;
    try {
      const synchronizedOutline = await synchronizeLockedChapterOutline({
        store,
        provider,
        project: projectState.project,
        bundle,
        draftBundle,
      });
      lockedChapterPlan = synchronizedOutline.chapterPlan;
      lockedWorldState = synchronizedOutline.derivedState.worldState;
      lockedForeshadowingRegistry = synchronizedOutline.derivedState.foreshadowingRegistry;
    } catch (error) {
      throw new Error(`锁章前细纲同步失败：${error instanceof Error ? error.message : String(error || "")}`);
    }

    await store.commitChapterDraft(pending.chapterId);

    let factExtractionWarning = "";
    try {
      const facts = await runChapterFactExtractionAgent({
        provider,
        project: projectState.project,
        chapterPlan: lockedChapterPlan,
        chapterDraft: { markdown: draftBundle.chapterMarkdown || "" },
      });
      await saveChapterFacts(store, pending.chapterId, facts);
      await appendFactsToLedger(store, pending.chapterId, facts);
    } catch (error) {
      factExtractionWarning = ` Canon facts 提取失败：${createExcerpt(error instanceof Error ? error.message : String(error || ""), 180)}`;
    }
    let timelineExtractionWarning = "";
    try {
      const factLedger = await loadFactLedger(store);
      const previousTimelineState = await loadTimelineState(store);
      const extraction = await runTimelineExtractionAgent({
        provider,
        project: projectState.project,
        chapterPlan: lockedChapterPlan,
        chapterDraft: { markdown: draftBundle.chapterMarkdown || "" },
        previousTimelineState,
        factLedger,
      });
      const nextTimelineState = await updateTimelineStateAfterChapter({
        store,
        extraction,
      });
      lockedWorldState = {
        ...lockedWorldState,
        current_story_time: nextTimelineState.current?.storyTime || lockedWorldState.current_story_time,
        current_primary_location: nextTimelineState.current?.primaryLocation || lockedWorldState.current_primary_location,
      };
    } catch (error) {
      timelineExtractionWarning = ` 时间线提取失败：${createExcerpt(error instanceof Error ? error.message : String(error || ""), 180)}`;
    }

    if (pending.chapterNumber === 1 && !String(projectState.project?.styleFingerprintId || "").trim()) {
      const styleGuide = await runStyleGuideDeriverAgent({
        provider,
        project: projectState.project,
        chapterPlan: lockedChapterPlan,
        chapterMarkdown: draftBundle.chapterMarkdown || "",
      });
      await store.writeText(path.join(store.paths.novelStateDir, "style_guide.md"), styleGuide);
    }

    const committedBundle = {
      ...bundle,
      structureData: {
        ...bundle.structureData,
        chapters: bundle.structureData.chapters.map((chapter) =>
          chapter.chapterId === lockedChapterPlan?.chapterId ? lockedChapterPlan : chapter,
        ),
      },
      worldState: lockedWorldState,
      foreshadowingRegistry: lockedForeshadowingRegistry,
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
      summary: `${pending.chapterId} 已${approvalOverrideRequired ? "在显式 override 后" : ""}锁定，并已按最终正文回写章节细纲，可继续生成下一章。${factExtractionWarning}${timelineExtractionWarning}`,
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
  const { styleGuideText, styleGuideSourcePath } = await resolveStyleBaseline(store, provider, projectState.project, chapterPlanBase);
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
  const timelineContext = draftBundle?.timelineContext || draftBundle?.chapterOutlineContext?.timelineContext || null;
  const promptTelemetry = {
    writerPromptPacket: draftBundle?.writerPromptPacket || null,
  };
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
        timelineContext,
        promptTelemetry,
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
      timelineContext,
    });

    const rewrittenState = await buildDerivedChapterStateArtifacts({
      provider,
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
      writerPromptPacket: promptTelemetry.writerPromptPacket || draftBundle?.writerPromptPacket || null,
      factContext,
      timelineContext,
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
    timelineContext,
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
      timelineContext,
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
    timelineContext,
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
    timelineContext,
    promptTelemetry,
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

  const rewrittenState = await buildDerivedChapterStateArtifacts({
    provider,
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
    writerPromptPacket: promptTelemetry.writerPromptPacket || draftBundle?.writerPromptPacket || null,
    factContext,
    timelineContext,
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
  await store.removeRunsByChapterId(latestChapterId);
  await store.removeReviewsByChapterId(latestChapterId);
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

  const writeReviewTargets = new Set([
    REVIEW_TARGETS.CHAPTER_OUTLINE,
    REVIEW_TARGETS.CHAPTER,
  ]);
  const nextReviewHistory = (projectState.history.reviews || []).filter((review) => {
    if (!writeReviewTargets.has(review?.target)) {
      return true;
    }
    if (remainingMetas.length === 0) {
      return false;
    }
    return String(review?.chapterId || "").trim() !== latestChapterId;
  });
  const remainingWriteRuns = remainingMetas.length === 0
    ? []
    : await store.listRuns("write", 1);

  projectState.phase.write = {
    ...projectState.phase.write,
    status: WRITE_STATUS.IDLE,
    lastRunId: remainingWriteRuns[0]?.id || null,
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
