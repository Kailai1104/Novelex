import path from "node:path";

import {
  getAuditDimension,
  legacyBucketForDimension,
  resolveAuditDimensions,
} from "../core/audit-dimensions.js";
import { runAuditHeuristics } from "../core/audit-heuristics.js";
import {
  chapterNumberFromId,
  createExcerpt,
  extractJsonObject,
  safeJsonParse,
  unique,
} from "../core/text.js";

const SEVERITY_RANK = {
  info: 1,
  warning: 2,
  critical: 3,
};

const SCORE_PENALTY = {
  critical: 22,
  warning: 8,
  info: 3,
};

const LEGACY_BUCKET_LABELS = {
  consistency: "连续性与边界",
  plausibility: "人物与节奏可信度",
  foreshadowing: "伏笔与旧债推进",
  style: "视角、文风与格式",
};

function severityRank(severity) {
  return SEVERITY_RANK[String(severity || "").trim()] || 0;
}

function compareSeverity(left, right) {
  return severityRank(right?.severity) - severityRank(left?.severity);
}

function loadRecentChapterMetas(chapterMetas = [], currentChapterNumber = 0, limit = 3) {
  return (Array.isArray(chapterMetas) ? chapterMetas : [])
    .filter((meta) => chapterNumberFromId(meta?.chapter_id) < currentChapterNumber)
    .sort((left, right) => chapterNumberFromId(left.chapter_id) - chapterNumberFromId(right.chapter_id))
    .slice(-limit);
}

async function loadRecentChapters(store, chapterMetas = [], currentChapterNumber = 0, limit = 3) {
  const selected = loadRecentChapterMetas(chapterMetas, currentChapterNumber, limit);

  return Promise.all(selected.map(async (meta) => {
    const chapterId = meta.chapter_id;
    const markdown = await store.readText(path.join(store.paths.chaptersDir, `${chapterId}.md`), "");
    const auditDrift = await store.readText(
      path.join(store.paths.chaptersDir, `${chapterId}_audit_drift.md`),
      "",
    );

    return {
      chapterId,
      title: meta.title,
      emotionalTone: meta.emotional_tone || "",
      summary: meta.summary_200 || meta.summary_50 || "",
      markdown,
      auditDrift,
    };
  }));
}

function characterBoundaryNotes(characterStates = [], chapterPlan = null) {
  const present = new Set(chapterPlan?.charactersPresent || []);
  return (Array.isArray(characterStates) ? characterStates : [])
    .filter((state) => present.has(state?.name))
    .map((state) => {
      const knows = Array.isArray(state?.knowledge?.knows) ? state.knowledge.knows.slice(0, 3) : [];
      const unknowns = Array.isArray(state?.knowledge?.does_not_know) ? state.knowledge.does_not_know.slice(0, 2) : [];
      return [
        `${state.name}`,
        knows.length ? `已知=${knows.join("；")}` : "",
        unknowns.length ? `未知=${unknowns.join("；")}` : "",
      ].filter(Boolean).join("｜");
    })
    .filter(Boolean);
}

function renderHeuristicIssues(issues = []) {
  if (!issues.length) {
    return "- 当前未命中显著启发式问题。";
  }

  return issues
    .map((issue) => `- [${issue.severity}] ${issue.id}｜${issue.description}${issue.evidence ? `｜证据:${issue.evidence}` : ""}`)
    .join("\n");
}

function renderRecentChapters(recentChapters = []) {
  if (!recentChapters.length) {
    return "- 无已锁定历史章节。";
  }

  return recentChapters.map((item) => [
    `- ${item.chapterId} ${item.title}`,
    item.summary ? `摘要:${item.summary}` : "",
    item.auditDrift ? `上次漂移提醒:${createExcerpt(item.auditDrift, 140)}` : "",
  ].filter(Boolean).join("｜")).join("\n");
}

function renderSequenceSnapshot(sequenceSnapshot = []) {
  if (!sequenceSnapshot.length) {
    return "- 无序列样本。";
  }

  return sequenceSnapshot
    .map((item) => `${item.chapterId}｜开场=${item.openingType}｜收束=${item.endingType}｜情绪=${item.toneType}`)
    .join("\n");
}

function renderActiveDimensions(activeDimensions = []) {
  return activeDimensions
    .map((dimension) => [
      `- id=${dimension.id}`,
      `category=${dimension.category}`,
      `focus=${dimension.promptFocus}`,
      `enabled=${dimension.enabledReason}`,
      dimension.window ? `window=${dimension.window}` : "",
    ].filter(Boolean).join("｜"))
    .join("\n");
}

function normalizeIssue(rawIssue, allowedIds = new Set(), source = "semantic") {
  if (!rawIssue || typeof rawIssue !== "object") {
    return null;
  }

  const id = String(rawIssue.id || "").trim();
  if (!id || (allowedIds.size && !allowedIds.has(id))) {
    return null;
  }

  const dimension = getAuditDimension(id);
  if (!dimension) {
    return null;
  }

  const severity = ["critical", "warning", "info"].includes(String(rawIssue.severity || "").trim())
    ? String(rawIssue.severity).trim()
    : "warning";
  const description = String(rawIssue.description || "").trim();
  if (!description) {
    return null;
  }

  return {
    id,
    severity,
    category: String(rawIssue.category || dimension.category).trim() || dimension.category,
    description,
    evidence: String(rawIssue.evidence || "").trim(),
    suggestion: String(rawIssue.suggestion || "").trim(),
    source,
  };
}

function dedupeIssues(issues = []) {
  const merged = new Map();

  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!issue) {
      continue;
    }

    const key = `${issue.id}::${issue.description}`;
    if (!merged.has(key)) {
      merged.set(key, issue);
      continue;
    }

    const existing = merged.get(key);
    const preferred = severityRank(issue.severity) > severityRank(existing.severity) ? issue : existing;
    merged.set(key, {
      ...preferred,
      evidence: unique([existing.evidence, issue.evidence]).filter(Boolean).join(" / "),
      suggestion: unique([existing.suggestion, issue.suggestion]).filter(Boolean).join("；"),
    });
  }

  return [...merged.values()].sort(compareSeverity);
}

function buildCounts(issues = []) {
  return issues.reduce((accumulator, issue) => {
    const severity = String(issue?.severity || "").trim();
    if (severity in accumulator) {
      accumulator[severity] += 1;
    }
    return accumulator;
  }, {
    critical: 0,
    warning: 0,
    info: 0,
  });
}

function computeScore(issues = []) {
  const penalty = issues.reduce((sum, issue) => sum + (SCORE_PENALTY[issue.severity] || 0), 0);
  return Math.max(0, 100 - penalty);
}

function defaultDimensionSummary(dimension, issues = []) {
  if (!issues.length) {
    return `${dimension.category}检查通过。`;
  }

  const criticalCount = issues.filter((item) => item.severity === "critical").length;
  const warningCount = issues.filter((item) => item.severity === "warning").length;
  const infoCount = issues.filter((item) => item.severity === "info").length;
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

  return `${dimension.category}存在${parts.join("，")}问题。`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function buildDimensionResults(activeDimensions = [], issues = [], llmDimensionSummaries = {}) {
  const results = {};

  for (const dimension of activeDimensions) {
    const dimensionIssues = issues.filter((issue) => issue.id === dimension.id);
    const highest = dimensionIssues.sort(compareSeverity)[0] || null;
    const passed = !dimensionIssues.some((issue) => issue.severity === "critical");
    const llmSummary = String(llmDimensionSummaries?.[dimension.id] || "").trim();

    results[dimension.id] = {
      id: dimension.id,
      category: dimension.category,
      passed,
      severity: highest?.severity || "pass",
      issueCount: dimensionIssues.length,
      summary: llmSummary || defaultDimensionSummary(dimension, dimensionIssues),
      issues: dimensionIssues,
    };
  }

  return results;
}

function issueText(issue, includeSuggestion = true) {
  const parts = [issue.description];
  if (issue.evidence) {
    parts.push(`证据：${issue.evidence}`);
  }
  if (includeSuggestion && issue.suggestion) {
    parts.push(`建议：${issue.suggestion}`);
  }
  return parts.join("｜");
}

function buildLegacyBucket(activeDimensions = [], dimensionResults = {}, issues = [], bucket) {
  const dimensionIds = activeDimensions
    .filter((dimension) => legacyBucketForDimension(dimension.id) === bucket)
    .map((dimension) => dimension.id);
  const bucketIssues = issues.filter((issue) => dimensionIds.includes(issue.id));
  const criticalCount = bucketIssues.filter((issue) => issue.severity === "critical").length;
  const warningCount = bucketIssues.filter((issue) => issue.severity === "warning").length;
  const infoCount = bucketIssues.filter((issue) => issue.severity === "info").length;
  const summaries = dimensionIds
    .map((id) => dimensionResults[id]?.summary)
    .filter(Boolean);

  return {
    passed: criticalCount === 0,
    issues: bucketIssues.map((issue) => issueText(issue)),
    summary: bucketIssues.length
      ? `${LEGACY_BUCKET_LABELS[bucket]}：critical ${criticalCount} / warning ${warningCount} / info ${infoCount}。${summaries.join(" ")}`
      : `${LEGACY_BUCKET_LABELS[bucket]}检查通过。`,
  };
}

function buildSemanticAuditInput({
  project,
  chapterPlan,
  chapterDraft,
  historyPacket,
  foreshadowingAdvice,
  researchPacket,
  styleGuideText,
  activeDimensions,
  heuristics,
  recentChapters,
  characterBoundaryLines,
  factContext,
}) {
  const establishedFacts = (factContext?.establishedFacts || []);
  const openTensions = (factContext?.openTensions || []);
  const factBlock = establishedFacts.length || openTensions.length
    ? [
      "既定事实与开放张力：",
      establishedFacts.length ? `必须继承的已定事实（后文不能否认/重置/重发明）：\n- ${establishedFacts.map((f) => `${f.subject}｜${f.assertion}`).join("\n- ")}` : "",
      openTensions.length ? `可以继续发酵的开放张力（不能改写底层结论）：\n- ${openTensions.map((f) => `${f.subject}｜${f.assertion}`).join("\n- ")}` : "",
    ].filter(Boolean).join("\n\n")
    : "";

  return [
    `作品：${project.title}`,
    `题材：${project.genre}`,
    `设定：${project.setting}`,
    `研究备注：${project.researchNotes || "无"}`,
    `章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
    `POV：${chapterPlan.povCharacter}`,
    `地点：${chapterPlan.location}`,
    `硬性事件：\n- ${chapterPlan.keyEvents.join("\n- ")}`,
    `场景规划：\n- ${chapterPlan.scenes.map((scene) => `${scene.label}｜${scene.focus}｜${scene.tension}`).join("\n- ")}`,
    `章末钩子：${chapterPlan.nextHook}`,
    `本章伏笔任务：\n- ${(chapterPlan.foreshadowingActions || []).map((item) => `${item.id}｜${item.action}｜${item.description}`).join("\n- ") || "无"}`,
    `历史不可冲突点：\n- ${(historyPacket?.mustNotContradict || historyPacket?.continuityAnchors || []).join("\n- ") || "无"}`,
    `角色知识边界：\n- ${characterBoundaryLines.join("\n- ") || "无明确边界说明"}`,
    factBlock ? factBlock : "",
    `研究资料包：\n${researchPacket?.briefingMarkdown || "无"}`,
    `风格指南：\n${styleGuideText || "无"}`,
    `启用维度：\n${renderActiveDimensions(activeDimensions)}`,
    `启发式结果：\n${renderHeuristicIssues(heuristics.issues)}`,
    `最近章节序列：\n${renderRecentChapters(recentChapters)}`,
    `序列特征快照：\n${renderSequenceSnapshot(heuristics.sequenceSnapshot)}`,
    `正文全文：\n${chapterDraft.markdown}`,
  ].filter(Boolean).join("\n\n");
}

async function runSemanticAudit({
  provider,
  project,
  chapterPlan,
  chapterDraft,
  historyPacket,
  foreshadowingAdvice,
  researchPacket,
  styleGuideText,
  activeDimensions,
  heuristics,
  recentChapters,
  characterStates,
  factContext,
}) {
  const characterBoundaryLines = characterBoundaryNotes(characterStates, chapterPlan);
  const input = buildSemanticAuditInput({
    project,
    chapterPlan,
    chapterDraft,
    historyPacket,
    foreshadowingAdvice,
    researchPacket,
    styleGuideText,
    activeDimensions,
    heuristics,
    recentChapters,
    characterBoundaryLines,
    factContext,
  });

  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 AuditOrchestrator。你不是四个投票 Agent，而是一个维度驱动审计器。请只对启用维度做审计，区分 critical / warning / info。critical 代表不修会直接伤到章节成稿质量或连续性；warning 代表提醒但不必卡死；info 只做记录。不要因为措辞与提纲不同就误判。若启发式已经命中问题，你可以沿用，但不要机械重复同一句。只输出 JSON，不要解释。",
    input: [
      input,
      `请输出 JSON：
{
  "summary": "一句话概括本章审计结果",
  "issues": [
    {
      "id": "knowledge_boundary",
      "severity": "critical",
      "category": "信息越界",
      "description": "问题描述",
      "evidence": "正文中的短证据",
      "suggestion": "如何修"
    }
  ],
  "dimensionSummaries": {
    "outline_drift": "该维度的一句结论",
    "character_plausibility": "该维度的一句结论"
  }
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "chapter_audit",
      chapterId: chapterPlan.chapterId,
    },
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`AuditOrchestrator 返回了无法解析的结果：${createExcerpt(result.text, 180)}`);
  }

  const allowedIds = new Set(activeDimensions.map((dimension) => dimension.id));
  const semanticIssues = (Array.isArray(parsed.issues) ? parsed.issues : [])
    .map((issue) => normalizeIssue(issue, allowedIds, "semantic"))
    .filter(Boolean);

  return {
    summary: String(parsed.summary || "").trim(),
    issues: semanticIssues,
    dimensionSummaries:
      parsed.dimensionSummaries && typeof parsed.dimensionSummaries === "object"
        ? parsed.dimensionSummaries
        : {},
  };
}

async function runSemanticAuditWithRetry(input, attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await runSemanticAudit(input);
      return {
        ...result,
        source: attempt > 1 ? "agent_retry" : "agent",
        error: null,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    summary: "",
    issues: [],
    dimensionSummaries: {},
    source: "heuristics_only",
    error: errorMessage(lastError),
    attempts,
  };
}

function buildAuditSummary(issues = [], score = 100, explicitSummary = "") {
  const counts = buildCounts(issues);
  if (explicitSummary && counts.critical === 0) {
    return explicitSummary;
  }
  if (!issues.length) {
    return `审计通过，score=${score}。当前没有 critical 问题。`;
  }

  const topCategories = unique(issues.slice(0, 3).map((issue) => issue.category));
  return `审计发现 critical ${counts.critical} 条、warning ${counts.warning} 条、info ${counts.info} 条，主要集中在${topCategories.join("、")}。score=${score}。`;
}

function buildDriftPayload({
  chapterPlan,
  validation,
  heuristics,
}) {
  const issues = (validation?.issues || []).filter(
    (issue) => issue.severity === "critical" || issue.severity === "warning",
  );
  const topIssues = issues.slice(0, 4);
  const guardrails = unique([
    ...topIssues.map((issue) => issue.suggestion),
    ...topIssues
      .filter((issue) => issue.id === "sequence_monotony")
      .map(() => "下一章主动更换开场或收束模式，不要继续沿用同一钩子模板。"),
  ]).filter(Boolean).slice(0, 4);
  const staleForeshadowings = Array.isArray(heuristics?.staleForeshadowings)
    ? heuristics.staleForeshadowings
    : [];

  const markdown = [
    `# ${chapterPlan.chapterId} 审计漂移提示`,
    "",
    `- 审计结论：${validation.summary}`,
    `- 当前分数：${validation.score}`,
    "",
    "## 这章写偏在哪",
    topIssues.length
      ? topIssues.map((issue) => `- [${issue.severity}] ${issue.category}：${issue.description}`).join("\n")
      : "- 当前没有需要额外强调的偏移项。",
    "",
    "## 下一章最该避免",
    guardrails.length
      ? guardrails.map((item) => `- ${item}`).join("\n")
      : "- 延续当前稳定点，优先避免重复解释和重复钩子。",
    "",
    "## 伏笔欠债",
    staleForeshadowings.length
      ? staleForeshadowings
        .map((item) => `- ${item.id}：${createExcerpt(item.description, 72)}｜已 ${item.chaptersSinceTouch} 章未推进`)
        .join("\n")
      : "- 当前没有明显的旧伏笔拖欠。",
  ].join("\n");

  return {
    chapterId: chapterPlan.chapterId,
    generatedAt: new Date().toISOString(),
    summary: validation.summary,
    score: validation.score,
    focusIssues: topIssues,
    nextChapterGuardrails: guardrails,
    staleForeshadowings,
    markdown,
  };
}

export function summarizeAuditResult(validation) {
  return String(validation?.summary || "").trim() || "审计结果不可用。";
}

export function needsAuditStyleRepair(validation) {
  return (validation?.issues || []).some((issue) =>
    issue.severity === "critical" && ["pov_consistency", "meta_leak"].includes(issue.id),
  );
}

export function collectAuditRepairNotes(validation, options = {}) {
  const severityAllowList = Array.isArray(options?.severities) && options.severities.length
    ? new Set(options.severities)
    : new Set(["critical"]);
  const idAllowList = Array.isArray(options?.dimensionIds) && options.dimensionIds.length
    ? new Set(options.dimensionIds)
    : null;

  return unique((validation?.issues || [])
    .filter((issue) => severityAllowList.has(issue.severity))
    .filter((issue) => !idAllowList || idAllowList.has(issue.id))
    .flatMap((issue) => [issue.description, issue.suggestion].filter(Boolean)));
}

export async function runChapterAudit({
  store,
  provider,
  project,
  chapterPlan,
  chapterDraft,
  historyPacket,
  foreshadowingAdvice,
  researchPacket,
  styleGuideText,
  characterStates = [],
  foreshadowingRegistry = null,
  chapterMetas = null,
  factContext = null,
}) {
  const metas = Array.isArray(chapterMetas) ? chapterMetas : await store.listChapterMeta();
  const recentChapters = await loadRecentChapters(
    store,
    metas,
    Number(chapterPlan?.chapterNumber || 0),
    3,
  );
  const activeDimensions = resolveAuditDimensions({
    project,
    chapterPlan,
    foreshadowingAdvice,
    researchPacket,
    styleGuideText,
    chapterMetas: metas,
    foreshadowingRegistry,
    historyPacket,
    factContext,
  });
  const heuristics = runAuditHeuristics({
    project,
    chapterPlan,
    chapterDraft,
    researchPacket,
    foreshadowingRegistry,
    recentChapters,
  });

  let semantic = {
    summary: "",
    issues: [],
    dimensionSummaries: {},
    source: "agent",
    error: null,
    attempts: 0,
  };

  semantic = await runSemanticAuditWithRetry({
    provider,
    project,
    chapterPlan,
    chapterDraft,
    historyPacket,
    foreshadowingAdvice,
    researchPacket,
    styleGuideText,
    activeDimensions,
    heuristics,
    recentChapters,
    characterStates,
    factContext,
  });

  const issues = dedupeIssues([
    ...heuristics.issues,
    ...semantic.issues,
  ]);
  const score = computeScore(issues);
  const counts = buildCounts(issues);
  const passed = counts.critical === 0;
  const dimensionResults = buildDimensionResults(
    activeDimensions,
    issues,
    semantic.dimensionSummaries,
  );

  const validation = {
    passed,
    overallPassed: passed,
    score,
    summary: buildAuditSummary(issues, score, semantic.summary),
    issueCounts: counts,
    activeDimensions: activeDimensions.map((dimension) => ({
      id: dimension.id,
      category: dimension.category,
      enabledReason: dimension.enabledReason,
      window: dimension.window || null,
    })),
    issues,
    dimensionResults,
    heuristics: {
      metrics: heuristics.metrics,
      sequenceSnapshot: heuristics.sequenceSnapshot,
      staleForeshadowings: heuristics.staleForeshadowings,
    },
    auditDegraded: semantic.source === "heuristics_only",
    semanticAudit: {
      source: semantic.source,
      error: semantic.error,
      attempts: semantic.attempts || 0,
    },
  };

  validation.consistency = buildLegacyBucket(activeDimensions, dimensionResults, issues, "consistency");
  validation.plausibility = buildLegacyBucket(activeDimensions, dimensionResults, issues, "plausibility");
  validation.foreshadowing = buildLegacyBucket(activeDimensions, dimensionResults, issues, "foreshadowing");
  validation.style = buildLegacyBucket(activeDimensions, dimensionResults, issues, "style");

  const auditDrift = buildDriftPayload({
    chapterPlan,
    validation,
    heuristics,
  });

  return {
    ...validation,
    auditDrift,
  };
}
