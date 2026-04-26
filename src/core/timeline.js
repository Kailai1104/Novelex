import path from "node:path";

import {
  chapterNumberFromId,
  createExcerpt,
  nowIso,
  unique,
} from "./text.js";
import { generateStructuredObject } from "../llm/structured.js";

function normalizeString(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeStringArray(values, limit = 8) {
  return unique((Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)).slice(0, limit);
}

function normalizeTimelineEntry(raw = {}, fallbackChapterId = "") {
  const chapterId = normalizeString(raw.chapterId || raw.chapter_id, fallbackChapterId);
  return {
    chapterId,
    title: normalizeString(raw.title),
    timeLabel: normalizeString(raw.timeLabel || raw.time_label),
    startState: normalizeString(raw.startState || raw.start_state),
    endState: normalizeString(raw.endState || raw.end_state),
    timeTransition: normalizeString(raw.timeTransition || raw.time_transition),
    skipType: normalizeString(raw.skipType || raw.skip_type, "none"),
    skipJustification: normalizeString(raw.skipJustification || raw.skip_justification),
    offscreenChanges: normalizeStringArray(raw.offscreenChanges || raw.offscreen_changes, 8),
    activeDeadlines: normalizeStringArray(raw.activeDeadlines || raw.active_deadlines, 8),
    resourceClockChanges: normalizeStringArray(raw.resourceClockChanges || raw.resource_clock_changes, 8),
    unresolvedTemporalQuestions: normalizeStringArray(
      raw.unresolvedTemporalQuestions || raw.unresolved_temporal_questions,
      8,
    ),
    evidence: normalizeStringArray(raw.evidence, 8),
  };
}

function normalizeDeadline(raw = {}) {
  return {
    id: normalizeString(raw.id || raw.name, "deadline"),
    label: normalizeString(raw.label || raw.name, "未命名期限"),
    status: normalizeString(raw.status, "active"),
    firstEstablishedChapter: normalizeString(raw.firstEstablishedChapter || raw.first_established_chapter),
    latestMentionChapter: normalizeString(raw.latestMentionChapter || raw.latest_mention_chapter),
    latestStatement: normalizeString(raw.latestStatement || raw.latest_statement),
    narrativeMeaning: normalizeString(raw.narrativeMeaning || raw.narrative_meaning),
    evidence: normalizeString(raw.evidence),
  };
}

export function createEmptyTimelineState(extra = {}) {
  return {
    generatedAt: nowIso(),
    current: {
      chapterId: "",
      storyTime: "",
      primaryLocation: "",
      temporalPressure: "",
    },
    chapterSpans: [],
    deadlines: [],
    openTemporalQuestions: [],
    warnings: [],
    ...extra,
  };
}

export function normalizeTimelineState(raw = null) {
  if (!raw || typeof raw !== "object") {
    return createEmptyTimelineState();
  }

  const chapterSpans = (Array.isArray(raw.chapterSpans) ? raw.chapterSpans : [])
    .map((item) => normalizeTimelineEntry(item, item?.chapterId || ""))
    .filter((item) => item.chapterId)
    .sort((left, right) => chapterNumberFromId(left.chapterId) - chapterNumberFromId(right.chapterId));

  return {
    generatedAt: normalizeString(raw.generatedAt, nowIso()),
    current: {
      chapterId: normalizeString(raw.current?.chapterId),
      storyTime: normalizeString(raw.current?.storyTime),
      primaryLocation: normalizeString(raw.current?.primaryLocation),
      temporalPressure: normalizeString(raw.current?.temporalPressure),
    },
    chapterSpans,
    deadlines: (Array.isArray(raw.deadlines) ? raw.deadlines : []).map(normalizeDeadline),
    openTemporalQuestions: normalizeStringArray(raw.openTemporalQuestions, 12),
    warnings: normalizeStringArray(raw.warnings, 12),
  };
}

export async function loadTimelineState(store) {
  const filePath = path.join(store.paths.novelStateDir, "timeline_state.json");
  return normalizeTimelineState(await store.readJson(filePath, null));
}

export async function saveTimelineState(store, timelineState) {
  const normalized = normalizeTimelineState({
    ...timelineState,
    generatedAt: nowIso(),
  });
  await store.writeJson(path.join(store.paths.novelStateDir, "timeline_state.json"), normalized);
  return normalized;
}

export async function loadChapterTimeline(store, chapterId) {
  const filePath = path.join(store.paths.chaptersDir, `${chapterId}_timeline.json`);
  const data = await store.readJson(filePath, null);
  return data ? normalizeTimelineEntry(data, chapterId) : null;
}

export function renderTimelineContextMarkdown(timelineContext = {}) {
  const planning = timelineContext.temporalPlanning || {};
  const state = timelineContext.timelineState || createEmptyTimelineState();
  const deadlineLines = (state.deadlines || [])
    .slice(0, 8)
    .map((item) => `- ${item.label}｜${item.status}｜${item.latestStatement || item.narrativeMeaning || "无说明"}`)
    .join("\n");
  const recentLines = (state.chapterSpans || [])
    .slice(-4)
    .map((item) => `- ${item.chapterId}｜${item.timeLabel || "未标注"}｜${item.timeTransition || "无转场"}｜${item.endState || "无结束状态"}`)
    .join("\n");

  return [
    `# ${timelineContext.chapterId || "chapter"} 时间线上下文`,
    "",
    "## 当前时间线",
    `- 当前故事时间：${state.current?.storyTime || "未知"}`,
    `- 当前地点：${state.current?.primaryLocation || "未知"}`,
    `- 当前时间压力：${state.current?.temporalPressure || "无"}`,
    "",
    "## 近期章节",
    recentLines || "- 无已锁定时间线。",
    "",
    "## 有效倒计时",
    deadlineLines || "- 无明确倒计时。",
    "",
    "## 本章时间合同",
    `- 推荐承接：${planning.recommendedTransition || "直接承接上章压力。"}`,
    `- 是否允许跳时：${planning.skipAllowed ? "允许" : "不建议"}`,
    `- 允许跳跃方式：${planning.allowedSkipType || "direct_resume"}`,
    `- 可跳过范围：${planning.allowedElapsed || "不明确"}`,
    `- 跳跃理由：${planning.skipRationale || "无"}`,
    `- 跳过期间必须保留/交代：${(planning.mustCarryThrough || []).join("；") || "无"}`,
    `- 禁止的时间处理：${(planning.mustNotDo || []).join("；") || "无"}`,
  ].join("\n");
}

export function buildTimelineContextPacket({
  chapterPlan,
  timelineState,
  temporalPlanning = null,
}) {
  const packet = {
    chapterId: chapterPlan?.chapterId || "",
    generatedAt: nowIso(),
    timelineState: normalizeTimelineState(timelineState),
    temporalPlanning: temporalPlanning || createFallbackTemporalPlanning({ chapterPlan, timelineState }),
  };
  packet.briefingMarkdown = renderTimelineContextMarkdown(packet);
  packet.summaryText = createExcerpt(packet.briefingMarkdown, 320);
  return packet;
}

function createFallbackTemporalPlanning({ chapterPlan, timelineState }) {
  const state = normalizeTimelineState(timelineState);
  return {
    source: "fallback",
    recommendedTransition: chapterPlan?.entryLink || state.current?.temporalPressure || "承接上一章留下的直接压力。",
    skipAllowed: true,
    allowedSkipType: "direct_resume_or_short_transition",
    allowedElapsed: "可按章节需要短跳，但必须保留上一章压力与资源代价。",
    skipRationale: "缺少 LLM 时间规划结果，采用保守承接。",
    mustCarryThrough: normalizeStringArray([
      state.current?.temporalPressure,
      ...(state.deadlines || []).map((item) => item.latestStatement || item.label),
      ...(state.openTemporalQuestions || []),
    ], 8),
    offscreenChangesToMention: [],
    mustNotDo: ["不要用时间跳跃消除上一章尚未解决的关键压力。"],
    timelineRisks: normalizeStringArray(state.warnings, 6),
  };
}

function timelineStateForPrompt(timelineState) {
  const state = normalizeTimelineState(timelineState);
  return JSON.stringify({
    current: state.current,
    recentChapterSpans: state.chapterSpans.slice(-6),
    deadlines: state.deadlines,
    openTemporalQuestions: state.openTemporalQuestions,
    warnings: state.warnings,
  }, null, 2);
}

export async function runTemporalPlanningAgent({
  provider,
  project,
  chapterPlan,
  timelineState,
  previousOutline = null,
  previousChapterTail = "",
  factContext = null,
}) {
  try {
    return await generateStructuredObject(provider, {
      label: "TemporalPlanningAgent",
      agentComplexity: "simple",
      instructions:
        "你是 Novelex 的 TemporalPlanningAgent。你只负责章节时间承接与时间跳跃规划。时间跳跃是正常叙事工具，不要默认阻止；但必须判断跳跃是否逃避上一章压力、是否保留资源/伤势/敌情/倒计时代价。只输出 JSON。",
      input: [
        `作品：${project.title}`,
        `题材：${project.genre}`,
        `当前章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
        `章纲时间：${chapterPlan.timeInStory || "未标注"}`,
        `章纲入口：${chapterPlan.entryLink || "无"}`,
        `章纲出口压力：${chapterPlan.exitPressure || chapterPlan.nextHook || "无"}`,
        `上一章细纲：\n${previousOutline ? JSON.stringify(previousOutline, null, 2) : "无"}`,
        `上一章正文尾部：\n${previousChapterTail || "无"}`,
        `已定事实/开放张力：\n${factContext?.briefingMarkdown || "无"}`,
        `全局时间线：\n${timelineStateForPrompt(timelineState)}`,
        `请输出 JSON：
{
  "recommendedTransition": "本章开头应如何承接时间与压力",
  "skipAllowed": true,
  "allowedSkipType": "direct_resume / short_skip / pressure_after_skip / stage_jump",
  "allowedElapsed": "允许跳过的故事时间范围或叙事描述",
  "skipRationale": "为什么这样跳或不跳",
  "mustCarryThrough": ["跳过后仍必须保留的压力/资源/伤势/敌情/期限"],
  "offscreenChangesToMention": ["跳过期间需要一句交代的变化"],
  "mustNotDo": ["禁止的时间处理"],
  "timelineRisks": ["本章最容易产生的时间线风险"]
}`,
      ].join("\n\n"),
      metadata: {
        feature: "temporal_planning",
        chapterId: chapterPlan.chapterId,
      },
      normalize(parsed) {
        return {
          source: "agent",
          recommendedTransition: normalizeString(parsed.recommendedTransition, chapterPlan.entryLink || ""),
          skipAllowed: Boolean(parsed.skipAllowed),
          allowedSkipType: normalizeString(parsed.allowedSkipType, "direct_resume"),
          allowedElapsed: normalizeString(parsed.allowedElapsed),
          skipRationale: normalizeString(parsed.skipRationale),
          mustCarryThrough: normalizeStringArray(parsed.mustCarryThrough, 10),
          offscreenChangesToMention: normalizeStringArray(parsed.offscreenChangesToMention, 8),
          mustNotDo: normalizeStringArray(parsed.mustNotDo, 8),
          timelineRisks: normalizeStringArray(parsed.timelineRisks, 8),
        };
      },
    });
  } catch {
    return createFallbackTemporalPlanning({ chapterPlan, timelineState });
  }
}

export async function runTimelineExtractionAgent({
  provider,
  project,
  chapterPlan,
  chapterDraft,
  previousTimelineState = null,
  factLedger = [],
}) {
  return generateStructuredObject(provider, {
    label: "TimelineExtractionAgent",
    agentComplexity: "simple",
    instructions:
      "你是 Novelex 的 TimelineExtractionAgent。你负责从最终批准正文中提取时间线状态，不做规则判断。请识别本章起止时间、时间跳跃、离屏变化、倒计时变化、资源/伤势/敌情等时间压力。只输出 JSON。",
    input: [
      `作品：${project.title}`,
      `题材：${project.genre}`,
      `章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
      `章纲时间：${chapterPlan.timeInStory || "未标注"}`,
      `上一版时间线：\n${timelineStateForPrompt(previousTimelineState)}`,
      `事实账本节选：\n${JSON.stringify((Array.isArray(factLedger) ? factLedger : []).slice(-20), null, 2)}`,
      `最终批准正文：\n${chapterDraft.markdown || ""}`,
      `请输出 JSON：
{
  "chapterTimeline": {
    "timeLabel": "本章整体故事时间",
    "startState": "本章开头时间/地点/压力状态",
    "endState": "本章结尾时间/地点/压力状态",
    "timeTransition": "本章相对上一章的时间承接或跳跃",
    "skipType": "none / short_skip / pressure_after_skip / stage_jump",
    "skipJustification": "若有跳跃，为什么叙事上成立",
    "offscreenChanges": ["跳过期间发生或应理解为发生的变化"],
    "activeDeadlines": ["本章仍有效或被更新的倒计时"],
    "resourceClockChanges": ["资源、伤势、敌情、航程随时间发生的变化"],
    "unresolvedTemporalQuestions": ["后续仍需解释或继承的时间问题"],
    "evidence": ["正文证据短句"]
  },
  "current": {
    "storyTime": "本章结束后的当前故事时间",
    "primaryLocation": "本章结束后的主地点",
    "temporalPressure": "当前最重要的时间压力"
  },
  "deadlines": [
    {
      "id": "deadline_1",
      "label": "期限名",
      "status": "active / resolved / expired / uncertain",
      "firstEstablishedChapter": "ch001",
      "latestMentionChapter": "ch001",
      "latestStatement": "最新期限表述",
      "narrativeMeaning": "这个期限对后文意味着什么",
      "evidence": "证据"
    }
  ],
  "warnings": ["时间线疑点或冲突"],
  "openTemporalQuestions": ["后续需要继承的问题"]
}`,
    ].join("\n\n"),
    metadata: {
      feature: "timeline_extraction",
      chapterId: chapterPlan.chapterId,
    },
    normalize(parsed) {
      const chapterTimeline = normalizeTimelineEntry({
        ...(parsed.chapterTimeline || {}),
        chapterId: chapterPlan.chapterId,
        title: chapterPlan.title,
      }, chapterPlan.chapterId);
      return {
        chapterTimeline,
        current: {
          chapterId: chapterPlan.chapterId,
          storyTime: normalizeString(parsed.current?.storyTime, chapterTimeline.endState || chapterTimeline.timeLabel),
          primaryLocation: normalizeString(parsed.current?.primaryLocation, chapterPlan.location || ""),
          temporalPressure: normalizeString(parsed.current?.temporalPressure),
        },
        deadlines: (Array.isArray(parsed.deadlines) ? parsed.deadlines : []).map(normalizeDeadline),
        warnings: normalizeStringArray(parsed.warnings, 12),
        openTemporalQuestions: normalizeStringArray(parsed.openTemporalQuestions, 12),
      };
    },
  });
}

export async function updateTimelineStateAfterChapter({
  store,
  extraction,
}) {
  const previous = await loadTimelineState(store);
  const chapterTimeline = extraction?.chapterTimeline || null;
  if (!chapterTimeline?.chapterId) {
    return previous;
  }

  const chapterSpans = [
    ...previous.chapterSpans.filter((item) => item.chapterId !== chapterTimeline.chapterId),
    chapterTimeline,
  ].sort((left, right) => chapterNumberFromId(left.chapterId) - chapterNumberFromId(right.chapterId));
  const deadlineById = new Map((previous.deadlines || []).map((item) => [item.id, item]));
  for (const deadline of extraction.deadlines || []) {
    deadlineById.set(deadline.id, deadline);
  }
  const nextState = normalizeTimelineState({
    generatedAt: nowIso(),
    current: extraction.current || previous.current,
    chapterSpans,
    deadlines: [...deadlineById.values()],
    warnings: unique([...(previous.warnings || []), ...(extraction.warnings || [])]).slice(0, 24),
    openTemporalQuestions: unique([
      ...(previous.openTemporalQuestions || []),
      ...(extraction.openTemporalQuestions || []),
      ...(chapterTimeline.unresolvedTemporalQuestions || []),
    ]).slice(0, 24),
  });

  await store.writeJson(
    path.join(store.paths.chaptersDir, `${chapterTimeline.chapterId}_timeline.json`),
    chapterTimeline,
  );
  return saveTimelineState(store, nextState);
}

export async function runTimelineAuditAgent({
  provider,
  project,
  chapterPlan,
  chapterDraft,
  timelineContext = null,
}) {
  return generateStructuredObject(provider, {
    label: "TimelineAuditAgent",
    agentComplexity: "simple",
    instructions:
      "你是 Novelex 的 TimelineAuditAgent。你只用语义判断审查章节时间线，不使用规则。时间跳跃本身是允许的；只有当跳跃逃避压力、消除代价、打乱倒计时或让人物/地点/资源状态不匹配时才报问题。只输出 JSON。",
    input: [
      `作品：${project.title}`,
      `题材：${project.genre}`,
      `章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
      `时间线上下文：\n${timelineContext?.briefingMarkdown || "无"}`,
      `章纲时间：${chapterPlan.timeInStory || "无"}`,
      `章纲入口/出口：${chapterPlan.entryLink || "无"} / ${chapterPlan.exitPressure || chapterPlan.nextHook || "无"}`,
      `正文全文：\n${chapterDraft.markdown || ""}`,
      `请输出 JSON：
{
  "summary": "一句话结论",
  "issues": [
    {
      "severity": "critical / warning / info",
      "description": "问题描述",
      "evidence": "证据",
      "suggestion": "如何修"
    }
  ],
  "nextChapterGuardrails": ["下一章时间线注意事项"]
}`,
    ].join("\n\n"),
    metadata: {
      feature: "timeline_audit",
      chapterId: chapterPlan.chapterId,
    },
    normalize(parsed) {
      return {
        summary: normalizeString(parsed.summary, "时间线审查完成。"),
        issues: (Array.isArray(parsed.issues) ? parsed.issues : [])
          .map((issue) => ({
            id: "timeline_continuity",
            severity: ["critical", "warning", "info"].includes(String(issue?.severity || "").trim())
              ? String(issue.severity).trim()
              : "warning",
            category: "时间线连续性",
            description: normalizeString(issue?.description),
            evidence: normalizeString(issue?.evidence),
            suggestion: normalizeString(issue?.suggestion),
            source: "timeline_agent",
          }))
          .filter((issue) => issue.description),
        nextChapterGuardrails: normalizeStringArray(parsed.nextChapterGuardrails, 6),
      };
    },
  });
}
