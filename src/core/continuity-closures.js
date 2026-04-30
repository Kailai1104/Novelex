import {
  chapterNumberFromId,
  createExcerpt,
  extractKeywords,
  nowIso,
  unique,
} from "./text.js";

const INVALIDATED_STATUSES = new Set(["invalidated", "expired"]);
const RESOLVED_STATUSES = new Set(["resolved"]);
const RESOLUTION_PATTERNS = [
  /带回/u,
  /交付/u,
  /取回/u,
  /拿到/u,
  /换到/u,
  /兑过/u,
  /兑清/u,
  /到手/u,
  /运回/u,
  /查明/u,
  /证实/u,
];
const INVALIDATION_PATTERNS = [
  /失效/u,
  /作废/u,
  /成废纸/u,
  /被扣死/u,
  /被按死/u,
  /被封死/u,
  /封锁/u,
  /严禁出海/u,
  /无法/u,
  /不能/u,
  /断绝/u,
  /泡汤/u,
];
const SAFE_CLOSED_PATTERNS = [
  /已(?:经)?/u,
  /失效/u,
  /作废/u,
  /后果/u,
  /余波/u,
  /背景/u,
  /回顾/u,
  /留下/u,
  /无法/u,
  /不能/u,
  /不得/u,
  /只可/u,
  /只剩/u,
];
const REACTIVATION_PATTERNS = [
  /再次|重新|再度|重开|又去/u,
  /(启动|确立|推进|打通|继续|恢复).{0,12}(兑账|兑现|欠票|死线|倒计时|月港|海澄)/u,
  /(去|赴|赶到|直奔|前往).{0,10}(月港|海澄|兑账)/u,
  /(必须|需要|立刻|尽快).{0,12}(兑账|兑现|去月港|去海澄|赶到月港|赶到海澄)/u,
  /(倒计时|死线|期限|窗口).{0,10}(开始|启动|确立|推进)/u,
  /(兑现|兑账).{0,10}(欠票|月港|海澄)/u,
];
const TERM_STOP_WORDS = new Set([
  "当前",
  "章节",
  "本章",
  "上一章",
  "下一章",
  "当前章",
  "阶段",
  "主线",
  "目标",
  "推进",
  "压力",
  "结果",
  "余波",
  "背景",
  "事实",
  "线程",
  "角色",
  "问题",
  "需要",
  "必须",
  "继续",
  "完成",
  "失效",
]);

function normalizeString(value = "") {
  return String(value || "").trim();
}

function cleanTerms(values = [], limit = 32) {
  return unique((Array.isArray(values) ? values : [])
    .map((item) => normalizeString(item))
    .filter((item) => item && !TERM_STOP_WORDS.has(item)))
    .slice(0, limit);
}

function sliceChineseWindows(text = "", limit = 48) {
  const windows = [];
  const matches = String(text || "").match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const token of matches) {
    if (token.length <= 4) {
      windows.push(token);
      continue;
    }
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index <= token.length - size; index += 1) {
        windows.push(token.slice(index, index + size));
        if (windows.length >= limit) {
          return cleanTerms(windows, limit);
        }
      }
    }
  }
  return cleanTerms(windows, limit);
}

function deriveTerms(...values) {
  const rawTexts = values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((item) => normalizeString(item))
    .filter(Boolean);
  return cleanTerms([
    ...extractKeywords(...rawTexts),
    ...rawTexts.flatMap((text) => sliceChineseWindows(text, 40)),
  ], 48);
}

function textHasAnyPattern(text = "", patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function detectClosureStatus(text = "", explicitStatus = "") {
  const normalizedStatus = normalizeString(explicitStatus).toLowerCase();
  if (INVALIDATED_STATUSES.has(normalizedStatus)) {
    return "invalidated";
  }
  if (RESOLVED_STATUSES.has(normalizedStatus)) {
    return "resolved";
  }
  if (textHasAnyPattern(text, INVALIDATION_PATTERNS)) {
    return "invalidated";
  }
  if (textHasAnyPattern(text, RESOLUTION_PATTERNS)) {
    return "resolved";
  }
  return "";
}

function buildQueryTerms({
  chapterPlan,
  chapterSlot = null,
  stage = null,
  historyPlanning = null,
  timelineState = null,
} = {}) {
  return deriveTerms(
    chapterPlan?.chapterId,
    chapterPlan?.title,
    chapterPlan?.stage,
    chapterPlan?.location,
    chapterPlan?.nextHook,
    chapterPlan?.entryLink,
    chapterPlan?.exitPressure,
    chapterSlot?.mission,
    chapterSlot?.expectedCarryover,
    chapterSlot?.expectedEscalation,
    chapterSlot?.nextHookSeed,
    stage?.stageGoal,
    stage?.purpose,
    stage?.stageConflicts || [],
    historyPlanning?.backgroundThreads || [],
    historyPlanning?.priorityThreads || [],
    historyPlanning?.closedThreads || [],
    timelineState?.openTemporalQuestions || [],
    (timelineState?.deadlines || []).map((item) => item?.label),
    (timelineState?.deadlines || []).map((item) => item?.latestStatement),
  );
}

function matchedQueryTerms(queryTerms = [], text = "") {
  const source = normalizeString(text);
  return cleanTerms((Array.isArray(queryTerms) ? queryTerms : []).filter((term) => source.includes(term)), 8)
    .sort((left, right) => right.length - left.length);
}

function buildThreadId(matchedTerms = [], fallbackTerms = [], status = "") {
  const terms = matchedTerms.length ? matchedTerms : fallbackTerms;
  if (!terms.length) {
    return `${status || "thread"}:generic`;
  }
  return `${status || "thread"}:${terms.slice(0, 3).join("|")}`;
}

function candidateLabel(matchedTerms = [], fallbackText = "") {
  if (matchedTerms.length) {
    return matchedTerms.slice(0, 3).join(" / ");
  }
  return createExcerpt(fallbackText, 48);
}

function createClosureRecord({
  status,
  chapterId,
  sourceRef,
  sourceType,
  text,
  evidence = "",
  queryTerms = [],
}) {
  const matchedTerms = matchedQueryTerms(queryTerms, text);
  const fallbackTerms = deriveTerms(text).slice(0, 4);
  const label = candidateLabel(matchedTerms, text);
  return {
    threadId: buildThreadId(matchedTerms, fallbackTerms, status),
    label,
    status,
    summary: createExcerpt(text, 120),
    sourceType,
    sourceRef,
    chapterId,
    chapterNumber: chapterNumberFromId(chapterId),
    evidence: createExcerpt(evidence || text, 140),
    keywords: cleanTerms([...matchedTerms, ...fallbackTerms], 8),
  };
}

function pushCandidate(candidates, record) {
  if (!record?.threadId || !record?.summary) {
    return;
  }
  candidates.push(record);
}

function maybeCreateFactCandidate(fact, queryTerms = []) {
  const chapterId = normalizeString(fact?.chapterId);
  const text = [fact?.subject, fact?.assertion, fact?.evidence].filter(Boolean).join("｜");
  const status = detectClosureStatus(text, "");
  if (!chapterId || !text || !status) {
    return null;
  }
  if (queryTerms.length && !matchedQueryTerms(queryTerms, text).length && !textHasAnyPattern(text, INVALIDATION_PATTERNS)) {
    return null;
  }
  return createClosureRecord({
    status,
    chapterId,
    sourceRef: normalizeString(fact?.factId) || `fact:${chapterId}`,
    sourceType: "fact",
    text: `${fact?.subject || "线程"}：${fact?.assertion || ""}`,
    evidence: fact?.evidence,
    queryTerms,
  });
}

function maybeCreateDeadlineCandidate(deadline, queryTerms = []) {
  const chapterId = normalizeString(deadline?.latestMentionChapter || deadline?.firstEstablishedChapter);
  const status = detectClosureStatus(
    [deadline?.label, deadline?.latestStatement, deadline?.narrativeMeaning, deadline?.evidence].filter(Boolean).join("｜"),
    deadline?.status,
  );
  if (!chapterId || !status || status === "active") {
    return null;
  }
  const text = `${deadline?.label || "期限"}：${deadline?.latestStatement || deadline?.narrativeMeaning || ""}`;
  if (queryTerms.length && !matchedQueryTerms(queryTerms, text).length && !matchedQueryTerms(queryTerms, deadline?.evidence || "").length) {
    return null;
  }
  return createClosureRecord({
    status,
    chapterId,
    sourceRef: normalizeString(deadline?.id) || `deadline:${chapterId}`,
    sourceType: "deadline",
    text,
    evidence: deadline?.evidence,
    queryTerms,
  });
}

function maybeCreateTimelineSpanCandidate(span, queryTerms = []) {
  const chapterId = normalizeString(span?.chapterId);
  const text = [
    span?.startState,
    span?.endState,
    ...(Array.isArray(span?.resourceClockChanges) ? span.resourceClockChanges : []),
    ...(Array.isArray(span?.offscreenChanges) ? span.offscreenChanges : []),
    ...(Array.isArray(span?.evidence) ? span.evidence : []),
  ].filter(Boolean).join("｜");
  const status = detectClosureStatus(text, "");
  if (!chapterId || !text || !status) {
    return null;
  }
  if (queryTerms.length && !matchedQueryTerms(queryTerms, text).length && !textHasAnyPattern(text, INVALIDATION_PATTERNS)) {
    return null;
  }
  return createClosureRecord({
    status,
    chapterId,
    sourceRef: `timeline:${chapterId}`,
    sourceType: "timeline",
    text: createExcerpt(text, 160),
    evidence: Array.isArray(span?.evidence) ? span.evidence.join("；") : text,
    queryTerms,
  });
}

function selectLatestRecords(records = [], status = "resolved") {
  const byThreadId = new Map();
  for (const record of records.filter((item) => item?.status === status)) {
    const existing = byThreadId.get(record.threadId);
    if (!existing || record.chapterNumber > existing.chapterNumber) {
      byThreadId.set(record.threadId, record);
    }
  }
  return [...byThreadId.values()].sort((left, right) => right.chapterNumber - left.chapterNumber);
}

export function buildClosedThreadRewrite(thread = null) {
  if (!thread) {
    return "只承接该线程留下的后果与现实限制，不把它重新写成当前待完成任务。";
  }
  if (thread.status === "invalidated") {
    return createExcerpt(`${thread.label}已失效，只能承接封锁、代价与后果，不能再写成当前可执行主线。`, 100);
  }
  return createExcerpt(`${thread.label}已完成，只能回收其结果、代价与余波，不能再写成待完成任务。`, 100);
}

export function renderContinuityClosuresMarkdown(continuityClosures = null) {
  const closures = continuityClosures || {};
  const resolvedLines = (closures.resolvedThreads || [])
    .map((item) => `- [${item.sourceRef}] ${item.label}｜${item.summary}`)
    .join("\n");
  const invalidatedLines = (closures.invalidatedThreads || [])
    .map((item) => `- [${item.sourceRef}] ${item.label}｜${item.summary}`)
    .join("\n");
  const backgroundLines = (closures.backgroundOnlyThreads || [])
    .map((item) => `- ${item.label}｜${item.summary}`)
    .join("\n");
  const reopenLines = (closures.mustNotReopen || [])
    .map((item) => `- ${item.label}｜${buildClosedThreadRewrite(item)}`)
    .join("\n");

  return [
    `# ${closures.chapterId || "chapter"} 已关闭线程`,
    "",
    `## 已完成线程（后文只能写后果）`,
    resolvedLines || "- 无",
    "",
    `## 已失效线程（后文不能再当可执行主线）`,
    invalidatedLines || "- 无",
    "",
    `## 只可作为背景引用`,
    backgroundLines || "- 无",
    "",
    `## 不可重开`,
    reopenLines || "- 无",
  ].join("\n");
}

export function buildContinuityClosures({
  chapterPlan,
  factLedger = [],
  timelineState = null,
  historyPlanning = null,
  chapterSlot = null,
  stage = null,
} = {}) {
  const queryTerms = buildQueryTerms({
    chapterPlan,
    chapterSlot,
    stage,
    historyPlanning,
    timelineState,
  });
  const chapterNumber = Number(chapterPlan?.chapterNumber || chapterNumberFromId(chapterPlan?.chapterId));
  const priorFacts = (Array.isArray(factLedger) ? factLedger : [])
    .filter((item) => chapterNumberFromId(item?.chapterId) < chapterNumber);
  const priorSpans = (Array.isArray(timelineState?.chapterSpans) ? timelineState.chapterSpans : [])
    .filter((item) => chapterNumberFromId(item?.chapterId) < chapterNumber);
  const candidates = [];

  for (const fact of priorFacts) {
    pushCandidate(candidates, maybeCreateFactCandidate(fact, queryTerms));
  }
  for (const deadline of timelineState?.deadlines || []) {
    pushCandidate(candidates, maybeCreateDeadlineCandidate(deadline, queryTerms));
  }
  for (const span of priorSpans) {
    pushCandidate(candidates, maybeCreateTimelineSpanCandidate(span, queryTerms));
  }

  const resolvedThreads = selectLatestRecords(candidates, "resolved");
  const invalidatedThreads = selectLatestRecords(candidates, "invalidated");
  const mustNotReopen = [...resolvedThreads, ...invalidatedThreads]
    .sort((left, right) => right.chapterNumber - left.chapterNumber)
    .slice(0, 12);
  const backgroundOnlyThreads = mustNotReopen.map((item) => ({
    ...item,
    guidance: buildClosedThreadRewrite(item),
  }));
  const evidenceRefs = Object.fromEntries(mustNotReopen.map((item) => [item.threadId, [item.sourceRef, item.chapterId].filter(Boolean)]));
  const packet = {
    chapterId: chapterPlan?.chapterId || "",
    generatedAt: nowIso(),
    queryTerms,
    resolvedThreads,
    invalidatedThreads,
    backgroundOnlyThreads,
    mustNotReopen,
    evidenceRefs,
  };
  packet.briefingMarkdown = renderContinuityClosuresMarkdown(packet);
  packet.summaryText = createExcerpt(packet.briefingMarkdown, 320);
  return packet;
}

export function filterTimelineStateWithClosures(timelineState = null, continuityClosures = null) {
  const questions = Array.isArray(timelineState?.openTemporalQuestions)
    ? timelineState.openTemporalQuestions
    : [];
  const mustNotReopen = Array.isArray(continuityClosures?.mustNotReopen)
    ? continuityClosures.mustNotReopen
    : [];
  const filteredQuestions = questions.filter((question) => !findClosedThreadReactivations(question, continuityClosures).length);
  return {
    ...(timelineState || {}),
    deadlines: Array.isArray(timelineState?.deadlines) ? timelineState.deadlines : [],
    openTemporalQuestions: filteredQuestions,
    warnings: Array.isArray(timelineState?.warnings) ? timelineState.warnings : [],
    chapterSpans: Array.isArray(timelineState?.chapterSpans) ? timelineState.chapterSpans : [],
    filteredClosedThreadCount: mustNotReopen.length,
  };
}

export function textReactivatesClosedThread(text = "", thread = null) {
  const source = normalizeString(text);
  if (!source || !thread) {
    return false;
  }
  const keywords = cleanTerms([thread.label, ...(thread.keywords || [])], 12);
  if (!keywords.some((term) => source.includes(term))) {
    return false;
  }
  const danger = textHasAnyPattern(source, REACTIVATION_PATTERNS);
  if (!danger) {
    return false;
  }
  const safeClosedReference = textHasAnyPattern(source, SAFE_CLOSED_PATTERNS);
  return !safeClosedReference || /再次|重新|启动|确立|打通/u.test(source);
}

export function findClosedThreadReactivations(value, continuityClosures = null) {
  const source = Array.isArray(value) ? value.join("；") : normalizeString(value);
  const mustNotReopen = Array.isArray(continuityClosures?.mustNotReopen)
    ? continuityClosures.mustNotReopen
    : [];
  return mustNotReopen.filter((thread) => textReactivatesClosedThread(source, thread));
}
