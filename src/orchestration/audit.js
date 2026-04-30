import path from "node:path";

import { requiredCharactersConstraint } from "../core/character-presence.js";
import {
  AUDIT_DIMENSIONS,
  getAuditDimension,
  legacyBucketForDimension,
} from "../core/audit-dimensions.js";
import {
  chapterNumberFromId,
  countWordsApprox,
  createExcerpt,
  unique,
} from "../core/text.js";
import { generateStructuredObject } from "../llm/structured.js";

const SEVERITY_RANK = {
  info: 1,
  warning: 2,
  critical: 3,
};

const LEGACY_BUCKET_LABELS = {
  consistency: "连续性与边界",
  plausibility: "人物与节奏可信度",
  foreshadowing: "伏笔与旧债推进",
  style: "视角、文风与格式",
};
const AUDIT_AGENT_SLOTS = {
  continuity: "primary",
  style: "secondary",
  character: "secondary",
};

const AUDIT_GROUPS = [
  {
    id: "continuity_boundary",
    label: "连续性与边界",
    preferredAgentSlot: AUDIT_AGENT_SLOTS.continuity,
    guidance: "重点核对大纲兑现、既定事实承接、时间线语义、已完成动作重演、信息边界与未来钩子是否被提前透支。",
    dimensionIds: [
      "outline_drift",
      "knowledge_boundary",
      "hook_overpayoff",
      "canon_fact_continuity",
      "carryover_replay",
      "timeline_continuity",
    ],
  },
  {
    id: "style_pacing",
    label: "风格与节奏",
    preferredAgentSlot: AUDIT_AGENT_SLOTS.style,
    guidance: "重点核对视角稳定、元信息泄漏、章节节奏、重复开场、单章篇幅以及最近几章的节奏/风格是否单调或漂移。",
    dimensionIds: [
      "pov_consistency",
      "meta_leak",
      "chapter_pacing",
      "chapter_restart_replay",
      "chapter_word_count",
      "style_drift",
    ],
  },
  {
    id: "character_threads",
    label: "人物与线程推进",
    preferredAgentSlot: AUDIT_AGENT_SLOTS.character,
    guidance: "重点核对人物动机是否可信、伏笔与支线是否推进、研究考据是否准确，以及跨章序列是否持续给出新变化。",
    dimensionIds: [
      "character_plausibility",
      "foreshadowing_progress",
      "research_accuracy",
      "sequence_monotony",
      "subplot_stagnation",
    ],
  },
];

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

function normalizeConfidence(value, fallback = 0.78) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, numeric));
}

function extractParagraphs(markdown = "") {
  return String(markdown || "")
    .replace(/^#.+\n+/u, "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildAuditEvidencePacket({ project, chapterPlan, chapterDraft, recentChapters = [] }) {
  const markdown = String(chapterDraft?.markdown || "");
  const paragraphs = extractParagraphs(markdown);
  return {
    wordCount: countWordsApprox(markdown),
    paragraphCount: paragraphs.length,
    requiredCharacters: Array.isArray(chapterPlan?.charactersPresent) ? chapterPlan.charactersPresent : [],
    requiredCharacterRule: requiredCharactersConstraint(chapterPlan) || "",
    openingExcerpt: createExcerpt(paragraphs.slice(0, 2).join("\n\n"), 240),
    endingExcerpt: createExcerpt(paragraphs.slice(-2).join("\n\n"), 240),
    recentChapterSignals: recentChapters.map((item) => ({
      chapterId: item.chapterId,
      title: item.title,
      summary: item.summary,
      emotionalTone: item.emotionalTone,
      excerpt: createExcerpt(item.markdown || "", 180),
    })),
    targetWords: Number(project?.targetWordsPerChapter || 0),
  };
}

function renderAuditDimensionCatalog() {
  return AUDIT_DIMENSIONS
    .map((dimension) => `${dimension.id}｜${dimension.category}｜${dimension.promptFocus}`)
    .join("\n");
}

function activeDimensionsForGroup(activeDimensions = [], group = null) {
  const dimensionIds = new Set(group?.dimensionIds || []);
  return activeDimensions.filter((dimension) => dimensionIds.has(dimension.id));
}

async function runChapterAuditGroupAgent({
  provider,
  project,
  chapterPlan,
  chapterDraft,
  historyPacket,
  researchPacket,
  styleGuideText,
  recentChapters,
  characterStates,
  factContext,
  timelineContext,
  group,
  activeDimensions,
  evidencePacket,
}) {
  const characterBoundaryLines = characterBoundaryNotes(characterStates, chapterPlan);
  const groupDimensions = activeDimensionsForGroup(activeDimensions, group);
  return generateStructuredObject(provider, {
    label: `${group?.label || "Chapter"}AuditAnalyzerAgent`,
    agentComplexity: "complex",
    preferredAgentSlot: group?.preferredAgentSlot || AUDIT_AGENT_SLOTS.continuity,
    instructions:
      `你是 Novelex 的 AuditAnalyzerAgent（${group?.label || "分组"}组）。你负责对章节正文做分方向语义审计，只审计当前分组负责的维度，不要越权评价其他组。${group?.guidance || ""}判断问题时必须结合客观证据包与正文全文。critical 会阻断章节通过。只输出 JSON。`,
    input: [
      `作品：${project.title}`,
      `章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
      `章节计划：\n${JSON.stringify(chapterPlan, null, 2)}`,
      `历史承接：\n${JSON.stringify(historyPacket || {}, null, 2)}`,
      `事实上下文：\n${JSON.stringify(factContext || {}, null, 2)}`,
      `时间线合同：\n${timelineContext?.briefingMarkdown || JSON.stringify(timelineContext || {}, null, 2)}`,
      `研究资料包：\n${JSON.stringify(researchPacket || {}, null, 2)}`,
      `风格指南：\n${styleGuideText || "无"}`,
      `角色知识边界：\n- ${characterBoundaryLines.join("\n- ") || "无明确边界说明"}`,
      `当前分组：${group?.id || "unknown"}｜${group?.label || "未命名分组"}`,
      `分组职责：${group?.guidance || "无额外说明"}`,
      `启用维度：\n${renderActiveDimensions(groupDimensions)}`,
      `客观证据包：\n${JSON.stringify(evidencePacket || {}, null, 2)}`,
      `最近章节序列：\n${renderRecentChapters(recentChapters)}`,
      `正文全文：\n${chapterDraft.markdown}`,
      `请输出 JSON：
{
  "summary": "一句话概括本章审计结果",
  "issues": [
    {
      "id": "carryover_replay",
      "severity": "critical",
      "category": "既定事实连续性",
      "description": "问题描述",
      "evidence": "正文短证据",
      "suggestion": "如何修"
    }
  ],
  "dimensionSummaries": {
    "outline_drift": "该维度的一句结论"
  },
  "sequenceSnapshot": [
    {"chapterId": "ch010", "openingType": "direct_resume", "endingType": "pressure_handoff", "toneType": "tense"}
  ],
  "staleForeshadowings": [
    {"id": "fsh_001", "description": "旧伏笔说明", "chaptersSinceTouch": 3}
  ],
  "nextChapterGuardrails": ["下一章最该避免的偏移1"]
}`,
    ].join("\n\n"),
    metadata: {
      feature: "chapter_audit",
      chapterId: chapterPlan.chapterId,
      auditGroup: group?.id || "",
    },
    normalize(parsed) {
      const allowedIds = new Set(groupDimensions.map((dimension) => dimension.id));
      const issues = (Array.isArray(parsed.issues) ? parsed.issues : [])
        .map((issue) => normalizeIssue(issue, allowedIds, "semantic"))
        .filter(Boolean);
      return {
        summary: String(parsed.summary || "").trim(),
        issues,
        dimensionSummaries:
          parsed.dimensionSummaries && typeof parsed.dimensionSummaries === "object"
            ? parsed.dimensionSummaries
            : {},
        sequenceSnapshot: (Array.isArray(parsed.sequenceSnapshot) ? parsed.sequenceSnapshot : [])
          .map((item) => ({
            chapterId: String(item?.chapterId || "").trim(),
            openingType: String(item?.openingType || "").trim(),
            endingType: String(item?.endingType || "").trim(),
            toneType: String(item?.toneType || "").trim(),
          }))
          .filter((item) => item.chapterId || item.openingType || item.endingType || item.toneType)
          .slice(0, 6),
        staleForeshadowings: (Array.isArray(parsed.staleForeshadowings) ? parsed.staleForeshadowings : [])
          .map((item) => ({
            id: String(item?.id || "").trim(),
            description: String(item?.description || "").trim(),
            chaptersSinceTouch: Math.max(0, Math.round(Number(item?.chaptersSinceTouch) || 0)),
          }))
          .filter((item) => item.id),
        nextChapterGuardrails: unique((Array.isArray(parsed.nextChapterGuardrails) ? parsed.nextChapterGuardrails : [])
          .map((item) => String(item || "").trim())
          .filter(Boolean)).slice(0, 6),
      };
    },
  });
}

async function runChapterAuditGroupWithRetry(input, attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await runChapterAuditGroupAgent(input);
      return {
        ...result,
        groupId: input.group?.id || "",
        groupLabel: input.group?.label || "",
        dimensionIds: [...(input.group?.dimensionIds || [])],
        preferredAgentSlot: input.group?.preferredAgentSlot || "",
        source: attempt > 1 ? "agent_retry" : "agent",
        error: null,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    groupId: input.group?.id || "",
    groupLabel: input.group?.label || "",
    dimensionIds: [...(input.group?.dimensionIds || [])],
    preferredAgentSlot: input.group?.preferredAgentSlot || "",
    summary: "",
    issues: [],
    dimensionSummaries: {},
    sequenceSnapshot: [],
    staleForeshadowings: [],
    nextChapterGuardrails: [],
    source: "error",
    error: errorMessage(lastError),
    attempts,
  };
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
  recentChapters,
  characterBoundaryLines,
  factContext,
  timelineContext,
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
    `必须出场：${requiredCharactersConstraint(chapterPlan) || "无"}`,
    `硬性事件：\n- ${chapterPlan.keyEvents.join("\n- ")}`,
    `场景规划：\n- ${chapterPlan.scenes.map((scene) => `${scene.label}｜${scene.focus}｜${scene.tension}｜出场:${(scene.characters || []).join("、") || "未标注"}`).join("\n- ")}`,
    `章末钩子：${chapterPlan.nextHook}`,
    `本章伏笔任务：\n- ${(chapterPlan.foreshadowingActions || []).map((item) => `${item.id}｜${item.action}｜${item.description}`).join("\n- ") || "无"}`,
    `历史不可冲突点：\n- ${(historyPacket?.mustNotContradict || historyPacket?.continuityAnchors || []).join("\n- ") || "无"}`,
    `角色知识边界：\n- ${characterBoundaryLines.join("\n- ") || "无明确边界说明"}`,
    factBlock ? factBlock : "",
    `时间线上下文：\n${timelineContext?.briefingMarkdown || "无"}`,
    `研究资料包：\n${researchPacket?.briefingMarkdown || "无"}`,
    `风格指南：\n${styleGuideText || "无"}`,
    `启用维度：\n${renderActiveDimensions(activeDimensions)}`,
    `最近章节序列：\n${renderRecentChapters(recentChapters)}`,
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
  recentChapters,
  characterStates,
  factContext,
  timelineContext,
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
    recentChapters,
    characterBoundaryLines,
    factContext,
    timelineContext,
  });

  return generateStructuredObject(provider, {
    label: "AuditAnalyzerAgent",
    agentComplexity: "complex",
    instructions:
      "你是 Novelex 的 AuditAnalyzerAgent。你负责对章节做单一路径语义审计，不依赖启发式兜底。请只对启用维度做审计，区分 critical / warning / info。critical 代表不修会直接伤到章节成稿质量或连续性；warning 代表提醒但不必卡死；info 只做记录。不要因为措辞与提纲不同就误判。只输出 JSON，不要解释。",
    input: [
      input,
      `请输出 JSON：
{
  "summary": "一句话概括本章审计结果",
  "score": 87,
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
  },
  "sequenceSnapshot": [
    {"chapterId": "ch010", "openingType": "direct_resume", "endingType": "pressure_handoff", "toneType": "tense"}
  ],
  "staleForeshadowings": [
    {"id": "fsh_001", "description": "旧伏笔说明", "chaptersSinceTouch": 3}
  ],
  "nextChapterGuardrails": ["下一章最该避免的偏移1", "偏移2"]
}`,
    ].join("\n\n"),
    metadata: {
      feature: "chapter_audit",
      chapterId: chapterPlan.chapterId,
    },
    normalize(parsed) {
      const allowedIds = new Set(activeDimensions.map((dimension) => dimension.id));
      const semanticIssues = (Array.isArray(parsed.issues) ? parsed.issues : [])
        .map((issue) => normalizeIssue(issue, allowedIds, "semantic"))
        .filter(Boolean);

      return {
        summary: String(parsed.summary || "").trim(),
        score: Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0))),
        issues: semanticIssues,
        dimensionSummaries:
          parsed.dimensionSummaries && typeof parsed.dimensionSummaries === "object"
            ? parsed.dimensionSummaries
            : {},
        sequenceSnapshot: (Array.isArray(parsed.sequenceSnapshot) ? parsed.sequenceSnapshot : [])
          .map((item) => ({
            chapterId: String(item?.chapterId || "").trim(),
            openingType: String(item?.openingType || "").trim(),
            endingType: String(item?.endingType || "").trim(),
            toneType: String(item?.toneType || "").trim(),
          }))
          .filter((item) => item.chapterId || item.openingType || item.endingType || item.toneType)
          .slice(0, 6),
        staleForeshadowings: (Array.isArray(parsed.staleForeshadowings) ? parsed.staleForeshadowings : [])
          .map((item) => ({
            id: String(item?.id || "").trim(),
            description: String(item?.description || "").trim(),
            chaptersSinceTouch: Math.max(0, Math.round(Number(item?.chaptersSinceTouch) || 0)),
          }))
          .filter((item) => item.id),
        nextChapterGuardrails: unique((Array.isArray(parsed.nextChapterGuardrails) ? parsed.nextChapterGuardrails : [])
          .map((item) => String(item || "").trim())
          .filter(Boolean)).slice(0, 6),
      };
    },
  });
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

  throw new Error(errorMessage(lastError));
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

function heuristicScore(issues = []) {
  const counts = buildCounts(issues);
  return Math.max(0, Math.min(
    100,
    100 - counts.critical * 25 - counts.warning * 8 - counts.info * 3,
  ));
}

function buildDriftPayload({
  chapterPlan,
  validation,
}) {
  const issues = (validation?.issues || []).filter(
    (issue) => issue.severity === "critical" || issue.severity === "warning",
  );
  const topIssues = issues.slice(0, 4);
  const guardrails = unique([
    ...(validation?.nextChapterGuardrails || []),
    ...topIssues.map((issue) => issue.suggestion),
  ]).filter(Boolean).slice(0, 4);
  const staleForeshadowings = Array.isArray(validation?.staleForeshadowings)
    ? validation.staleForeshadowings
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

function mergeDimensionSummaries(groupResults = []) {
  return groupResults.reduce((accumulator, result) => ({
    ...accumulator,
    ...(result?.dimensionSummaries || {}),
  }), {});
}

function mergeSequenceSnapshots(groupResults = []) {
  return unique(groupResults
    .flatMap((result) => result?.sequenceSnapshot || [])
    .map((item) => `${item.chapterId}::${item.openingType}::${item.endingType}::${item.toneType}`))
    .map((key) => {
      const [chapterId = "", openingType = "", endingType = "", toneType = ""] = key.split("::");
      return { chapterId, openingType, endingType, toneType };
    })
    .filter((item) => item.chapterId || item.openingType || item.endingType || item.toneType)
    .slice(0, 6);
}

function mergeStaleForeshadowings(groupResults = []) {
  const merged = new Map();

  for (const item of groupResults.flatMap((result) => result?.staleForeshadowings || [])) {
    if (!item?.id) {
      continue;
    }
    const existing = merged.get(item.id);
    if (!existing || Number(item.chaptersSinceTouch || 0) > Number(existing.chaptersSinceTouch || 0)) {
      merged.set(item.id, item);
    }
  }

  return [...merged.values()].slice(0, 8);
}

function mergeGroupSummaries(groupResults = []) {
  return unique(groupResults.map((result) => String(result?.summary || "").trim()).filter(Boolean)).join(" ");
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
  timelineContext = null,
  continuityGuard = null,
  skipSemanticAudit = false,
  skippedSemanticSummary = "",
  semanticSkipReason = "",
}) {
  const metas = Array.isArray(chapterMetas) ? chapterMetas : await store.listChapterMeta();
  const recentChapters = await loadRecentChapters(
    store,
    metas,
    Number(chapterPlan?.chapterNumber || 0),
    3,
  );
  const evidencePacket = buildAuditEvidencePacket({
    project,
    chapterPlan,
    chapterDraft,
    recentChapters,
  });

  const auditScope = {
    summary: skipSemanticAudit
      ? String(skippedSemanticSummary || "").trim() || "已跳过正文语义审计，默认记录为全量审计配置。"
      : "AuditScopeAgent 已停用，当前默认全量启用全部审计维度。",
    enabledDimensions: AUDIT_DIMENSIONS.map((dimension) => ({
      id: dimension.id,
      reason: skipSemanticAudit ? "跳过正文语义审计时仍记录为默认全量启用。" : "全量审计默认启用。",
    })),
    evidenceFocus: [],
    reviewRequired: false,
    confidence: 1,
    source: skipSemanticAudit ? "skipped" : "static_full",
    reason: skipSemanticAudit ? String(semanticSkipReason || "").trim() : "full_audit",
  };
  const activeDimensions = AUDIT_DIMENSIONS.map((dimension) => ({
    ...dimension,
    enabledReason: skipSemanticAudit ? "跳过正文语义审计时仍记录为默认全量启用。" : "全量审计默认启用。",
  }));

  const groupAudits = skipSemanticAudit
    ? []
    : await Promise.all(AUDIT_GROUPS.map((group) => runChapterAuditGroupWithRetry({
      provider,
      project,
      chapterPlan,
      chapterDraft,
      historyPacket,
      researchPacket,
      styleGuideText,
      recentChapters,
      characterStates,
      factContext,
      timelineContext,
      group,
      activeDimensions,
      evidencePacket: {
        ...evidencePacket,
        continuityContract: continuityGuard || null,
      },
    })));

  const chapterAudit = skipSemanticAudit
    ? {
      summary: String(skippedSemanticSummary || "").trim() || "已跳过正文语义审计。",
      issues: [],
      dimensionSummaries: {},
      sequenceSnapshot: [],
      staleForeshadowings: [],
      nextChapterGuardrails: [],
      source: "skipped",
      reason: String(semanticSkipReason || "").trim(),
      error: null,
      attempts: 0,
      groups: [],
    }
    : {
      summary: mergeGroupSummaries(groupAudits),
      issues: dedupeIssues(groupAudits.flatMap((item) => item.issues || [])),
      dimensionSummaries: mergeDimensionSummaries(groupAudits),
      sequenceSnapshot: mergeSequenceSnapshots(groupAudits),
      staleForeshadowings: mergeStaleForeshadowings(groupAudits),
      nextChapterGuardrails: unique(groupAudits.flatMap((item) => item.nextChapterGuardrails || [])).slice(0, 8),
      source: "multi_agent",
      reason: "",
      error: groupAudits.filter((item) => item.error).map((item) => `${item.groupLabel}：${item.error}`).join("；"),
      attempts: groupAudits.reduce((max, item) => Math.max(max, Number(item.attempts || 0)), 0),
      groups: groupAudits,
    };

  const issues = dedupeIssues(chapterAudit.issues || []);
  const score = heuristicScore(issues);
  const counts = buildCounts(issues);
  const agentConflicts = skipSemanticAudit
    ? []
    : groupAudits
      .filter((item) => item.error)
      .map((item) => `${item.groupLabel}审计失败，需要人工复核。`);
  const passed = counts.critical === 0 && agentConflicts.length === 0;
  const dimensionResults = buildDimensionResults(
    activeDimensions,
    issues,
    chapterAudit.dimensionSummaries,
  );

  const validation = {
    passed,
    overallPassed: passed,
    score,
    summary: agentConflicts.length
      ? `审计需人工复核：${agentConflicts.join("；")}`
      : buildAuditSummary(issues, score, chapterAudit.summary),
    issueCounts: counts,
    activeDimensions: activeDimensions.map((dimension) => ({
      id: dimension.id,
      category: dimension.category,
      enabledReason: dimension.enabledReason,
      window: dimension.window || null,
    })),
    issues,
    dimensionResults,
    heuristics: null,
    sequenceSnapshot: chapterAudit.sequenceSnapshot || [],
    staleForeshadowings: chapterAudit.staleForeshadowings || [],
    nextChapterGuardrails: unique(chapterAudit.nextChapterGuardrails || []).slice(0, 8),
    auditDegraded: agentConflicts.length > 0,
    auditScope,
    auditEvidencePacket: evidencePacket,
    agentConflicts,
    reviewRequiredReason: agentConflicts.join("；"),
    semanticAudit: {
      source: chapterAudit.source || "agent",
      reason: chapterAudit.reason || "",
      error: chapterAudit.error || null,
      attempts: chapterAudit.attempts || 0,
      groups: (chapterAudit.groups || []).map((item) => ({
        id: item.groupId,
        label: item.groupLabel,
        dimensionIds: item.dimensionIds || [],
        preferredAgentSlot: item.preferredAgentSlot || "",
        source: item.source || "agent",
        error: item.error || null,
        attempts: item.attempts || 0,
      })),
    },
    auditGroups: (chapterAudit.groups || []).map((item) => ({
      id: item.groupId,
      label: item.groupLabel,
      dimensionIds: item.dimensionIds || [],
      preferredAgentSlot: item.preferredAgentSlot || "",
      summary: item.summary || "",
      source: item.source || "agent",
      error: item.error || null,
      attempts: item.attempts || 0,
    })),
    timelineAudit: null,
  };

  validation.consistency = buildLegacyBucket(activeDimensions, dimensionResults, issues, "consistency");
  validation.plausibility = buildLegacyBucket(activeDimensions, dimensionResults, issues, "plausibility");
  validation.foreshadowing = buildLegacyBucket(activeDimensions, dimensionResults, issues, "foreshadowing");
  validation.style = buildLegacyBucket(activeDimensions, dimensionResults, issues, "style");

  const auditDrift = buildDriftPayload({
    chapterPlan,
    validation,
  });

  return {
    ...validation,
    auditDrift,
  };
}
