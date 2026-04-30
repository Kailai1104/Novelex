import path from "node:path";

import { generateTextWithJsonFallback } from "../llm/structured.js";
import {
  chapterNumberFromId,
  createExcerpt,
  extractJsonObject,
  nowIso,
  safeJsonParse,
  unique,
} from "./text.js";

const FACT_TYPE_VALUES = new Set([
  "order",
  "state",
  "allocation",
  "judgement",
  "relationship",
]);
const FACT_ROUTING_SLOT = "secondary";

const FACT_STATUS_VALUES = new Set(["established", "open_tension"]);

function normalizeFactType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return FACT_TYPE_VALUES.has(normalized) ? normalized : "state";
}

function normalizeFactStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return FACT_STATUS_VALUES.has(normalized) ? normalized : "established";
}

function factId(chapterId, index) {
  return `fact_${chapterId}_${String(index + 1).padStart(3, "0")}`;
}

function normalizeFact(raw, index, chapterId) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const assertion = String(raw.assertion || "").trim();
  if (!assertion) {
    return null;
  }

  return {
    factId: String(raw.factId || "").trim() || factId(chapterId, index),
    chapterId: String(raw.chapterId || "").trim() || chapterId,
    type: normalizeFactType(raw.type),
    subject: String(raw.subject || "").trim() || "未命名主体",
    assertion,
    status: normalizeFactStatus(raw.status),
    durability: String(raw.durability || "").trim() || "until_changed",
    evidence: String(raw.evidence || "").trim() || assertion,
  };
}

function normalizeExtractionResult(parsed, chapterId) {
  const established = (Array.isArray(parsed?.established_facts) ? parsed.established_facts : [])
    .map((item, index) => normalizeFact({ ...item, status: "established" }, index, chapterId))
    .filter(Boolean);

  const tensions = (Array.isArray(parsed?.open_tensions) ? parsed.open_tensions : [])
    .map((item, index) => normalizeFact({ ...item, status: "open_tension" }, established.length + index, chapterId))
    .filter(Boolean);

  return [...established, ...tensions];
}

export async function runChapterFactExtractionAgent({
  provider,
  project,
  chapterPlan,
  chapterDraft,
}) {
  const chapterId = chapterPlan?.chapterId || "ch000";
  const excerpt = createExcerpt(chapterDraft?.markdown || "", 6000);

  const parsed = await generateTextWithJsonFallback(provider, {
    label: "ChapterFactExtractionAgent",
    agentComplexity: "simple",
    preferredAgentSlot: FACT_ROUTING_SLOT,
    instructions:
      "你是 Novelex 的 ChapterFactExtractionAgent。你的任务是从已批准的章节正文中提取结构化 canon facts（既定事实账本）。只输出 JSON，不要解释。",
    input: [
      `作品：${project.title}`,
      `题材：${project.genre}`,
      `章节：${chapterId} ${chapterPlan.title || ""}`,
      `POV：${chapterPlan.povCharacter || ""}`,
      `关键事件：${(chapterPlan.keyEvents || []).join("；")}`,
      `正文节选（前6000字）：\n${excerpt}`,
      "提取要求：",
      "1. established_facts：本章已经定下来的事实或命令，后文不能当成未定事项重写。",
      "2. open_tensions：本章留下的争议、怀疑、隐患，后文可以继续承接，但不能改写已定事实本身。",
      "3. 每条事实必须包含：type（order/state/allocation/judgement/relationship）、subject、assertion、evidence。",
      "4. 允许角色继续争执执行方式/代价/后果，但不允许把已经落地的事实本身重新写成未定事项。",
      `请输出 JSON：\n{\n  "established_facts": [\n    {\n      "type": "order",\n      "subject": "主体",\n      "assertion": "事实陈述",\n      "evidence": "正文中的证据片段"\n    }\n  ],\n  "open_tensions": [\n    {\n      "type": "state",\n      "subject": "主体",\n      "assertion": "开放张力陈述",\n      "evidence": "正文中的证据片段"\n    }\n  ]\n}`,
    ].join("\n\n"),
    metadata: {
      feature: "chapter_fact_extraction",
      chapterId,
    },
  });

  return normalizeExtractionResult(parsed, chapterId);
}

export async function loadChapterFacts(store, chapterId) {
  const filePath = path.join(store.paths.chaptersDir, `${chapterId}_facts.json`);
  const data = await store.readJson(filePath, null);
  if (!data || !Array.isArray(data.facts)) {
    return [];
  }
  return data.facts.map((item, index) => normalizeFact(item, index, chapterId)).filter(Boolean);
}

export async function loadFactLedger(store) {
  const filePath = path.join(store.paths.novelStateDir, "fact_ledger.json");
  const data = await store.readJson(filePath, null);
  if (!data || !Array.isArray(data.facts)) {
    return [];
  }
  return data.facts.map((item, index) => normalizeFact(item, index, item.chapterId || "unknown")).filter(Boolean);
}

export async function saveChapterFacts(store, chapterId, facts) {
  const normalized = facts
    .map((item, index) => normalizeFact(item, index, chapterId))
    .filter(Boolean);

  const filePath = path.join(store.paths.chaptersDir, `${chapterId}_facts.json`);
  await store.writeJson(filePath, {
    chapterId,
    generatedAt: nowIso(),
    factCount: normalized.length,
    facts: normalized,
  });

  return normalized;
}

export async function rebuildFactLedger(store) {
  const chapterMetas = await store.listChapterMeta();
  const allFacts = [];

  for (const meta of chapterMetas) {
    const facts = await loadChapterFacts(store, meta.chapter_id);
    allFacts.push(...facts);
  }

  const ledger = {
    generatedAt: nowIso(),
    chapterCount: chapterMetas.length,
    factCount: allFacts.length,
    establishedCount: allFacts.filter((f) => f.status === "established").length,
    openTensionCount: allFacts.filter((f) => f.status === "open_tension").length,
    facts: allFacts,
  };

  const filePath = path.join(store.paths.novelStateDir, "fact_ledger.json");
  await store.writeJson(filePath, ledger);
  return ledger;
}

export async function appendFactsToLedger(store, chapterId, facts) {
  const existing = await loadFactLedger(store);
  const filtered = existing.filter((f) => f.chapterId !== chapterId);
  const normalized = facts
    .map((item, index) => normalizeFact(item, index, chapterId))
    .filter(Boolean);

  const merged = [...filtered, ...normalized];
  const ledger = {
    generatedAt: nowIso(),
    chapterCount: unique(merged.map((f) => f.chapterId)).length,
    factCount: merged.length,
    establishedCount: merged.filter((f) => f.status === "established").length,
    openTensionCount: merged.filter((f) => f.status === "open_tension").length,
    facts: merged,
  };

  const filePath = path.join(store.paths.novelStateDir, "fact_ledger.json");
  await store.writeJson(filePath, ledger);
  return ledger;
}

function buildFactQueryText(chapterPlan) {
  return [
    chapterPlan.chapterId,
    chapterPlan.title,
    chapterPlan.stage,
    chapterPlan.location,
    ...(chapterPlan.keyEvents || []),
    ...(chapterPlan.charactersPresent || []),
    chapterPlan.nextHook,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function runFactSelectorAgent({
  provider,
  project,
  chapterPlan,
  factLedger,
}) {
  const chapterId = chapterPlan?.chapterId || "ch000";
  const queryText = buildFactQueryText(chapterPlan);

  const candidateFacts = (Array.isArray(factLedger) ? factLedger : [])
    .filter((f) => chapterNumberFromId(f.chapterId) < chapterNumberFromId(chapterId));

  if (!candidateFacts.length) {
    return {
      selectedFacts: [],
      establishedFacts: [],
      openTensions: [],
      queryText: createExcerpt(queryText, 220),
      selectionRationale: "没有已批准章节的前置事实。",
      catalogStats: { totalFacts: 0, selected: 0 },
    };
  }

  const factDescriptions = candidateFacts
    .map((f) => `- ${f.factId}｜${f.chapterId}｜${f.status}｜type=${f.type}｜subject=${f.subject}｜assertion=${f.assertion}`)
    .join("\n");

  const parsed = await generateTextWithJsonFallback(provider, {
    label: "FactSelectorAgent",
    agentComplexity: "simple",
    preferredAgentSlot: FACT_ROUTING_SLOT,
    instructions:
      "你是 Novelex 的 FactSelectorAgent。请从已批准章节的事实账本中，挑出与当前章节最相关的一组事实。只输出 JSON，不要解释。",
    input: [
      `作品：${project.title}`,
      `题材：${project.genre}`,
      `当前章节：${chapterId} ${chapterPlan.title || ""}`,
      `POV：${chapterPlan.povCharacter || ""}`,
      `关键事件：${(chapterPlan.keyEvents || []).join("；")}`,
      `登场角色：${(chapterPlan.charactersPresent || []).join("、")}`,
      `章末钩子：${chapterPlan.nextHook || ""}`,
      `候选事实（共 ${candidateFacts.length} 条）：\n${factDescriptions}`,
      `请输出 JSON：\n{\n  "selectedFactIds": ["fact_ch001_001", "fact_ch002_003"],\n  "rationale": "为什么这些事实与当前章节相关",\n  "establishedFocus": "必须继承的已定事实摘要",\n  "tensionFocus": "可以继续发酵的开放张力摘要"\n}`,
    ].join("\n\n"),
    metadata: {
      feature: "fact_selector",
      chapterId,
    },
  });

  if (!Array.isArray(parsed.selectedFactIds)) {
    throw new Error(`FactSelectorAgent 返回了无效结果：selectedFactIds 不是数组`);
  }

  const selectedIds = new Set(parsed.selectedFactIds.map((id) => String(id || "").trim()).filter(Boolean));
  const selectedFacts = candidateFacts.filter((f) => selectedIds.has(f.factId));
  const establishedFacts = selectedFacts.filter((f) => f.status === "established");
  const openTensions = selectedFacts.filter((f) => f.status === "open_tension");

  return {
    selectedFacts,
    establishedFacts,
    openTensions,
    queryText: createExcerpt(queryText, 220),
    selectionRationale: String(parsed.rationale || "").trim() || "根据当前章节需求筛选相关事实。",
    establishedFocus: String(parsed.establishedFocus || "").trim() || "",
    tensionFocus: String(parsed.tensionFocus || "").trim() || "",
    catalogStats: {
      totalFacts: candidateFacts.length,
      selected: selectedFacts.length,
    },
  };
}

export function buildFactContextMarkdown({
  chapterPlan,
  establishedFacts,
  openTensions,
  closedThreads = [],
  selectionRationale,
}) {
  const establishedLines = establishedFacts.length
    ? establishedFacts.map((f) => `- [${f.factId}] ${f.subject}｜${f.assertion}${f.evidence ? `｜证据：${createExcerpt(f.evidence, 60)}` : ""}`).join("\n")
    : "- 无";

  const tensionLines = openTensions.length
    ? openTensions.map((f) => `- [${f.factId}] ${f.subject}｜${f.assertion}${f.evidence ? `｜证据：${createExcerpt(f.evidence, 60)}` : ""}`).join("\n")
    : "- 无";
  const closedLines = closedThreads.length
    ? closedThreads.map((item) => `- [${item.sourceRef || item.factId || item.threadId}] ${item.label || item.subject || "已关闭线程"}｜${item.summary || item.assertion || ""}`).join("\n")
    : "- 无";

  return [
    `# ${chapterPlan?.chapterId || "chapter"} Fact Context`,
    "",
    `## 筛选理由`,
    selectionRationale || "根据当前章节需求筛选。",
    "",
    `## 必须继承的已定事实（${establishedFacts.length} 条）`,
    "后文不能当成未定事项重写，不能否认、重置、重发明。",
    establishedLines,
    "",
    `## 可以继续发酵的开放张力（${openTensions.length} 条）`,
    "允许角色继续争执执行方式/代价/后果，但不能改写底层结论。",
    tensionLines,
    "",
    `## 已完成/已失效线程（不可重开，${closedThreads.length} 条）`,
    "这些线程只能回收后果、余波或失效代价，不能重新写成当前待完成任务。",
    closedLines,
  ].join("\n");
}

export function buildFactContextPacket({
  chapterPlan,
  establishedFacts,
  openTensions,
  closedThreads = [],
  selectionRationale,
  catalogStats,
}) {
  const briefingMarkdown = buildFactContextMarkdown({
    chapterPlan,
    establishedFacts,
    openTensions,
    closedThreads,
    selectionRationale,
  });

  return {
    chapterId: chapterPlan?.chapterId || "",
    generatedAt: nowIso(),
    establishedFacts: establishedFacts.map((f) => ({
      factId: f.factId,
      chapterId: f.chapterId,
      type: f.type,
      subject: f.subject,
      assertion: f.assertion,
      evidence: f.evidence,
    })),
    openTensions: openTensions.map((f) => ({
      factId: f.factId,
      chapterId: f.chapterId,
      type: f.type,
      subject: f.subject,
      assertion: f.assertion,
      evidence: f.evidence,
    })),
    closedThreads: closedThreads.map((item) => ({
      threadId: item.threadId,
      label: item.label,
      status: item.status,
      summary: item.summary,
      chapterId: item.chapterId,
      sourceRef: item.sourceRef,
      evidence: item.evidence,
    })),
    selectionRationale: String(selectionRationale || "").trim(),
    catalogStats: catalogStats || { totalFacts: 0, selected: 0 },
    briefingMarkdown,
    summaryText: createExcerpt(briefingMarkdown, 320),
  };
}

export function collectCanonFactContinuityIssues(validation, _establishedFactAssertions = []) {
  if (!validation?.issues?.length) {
    return [];
  }

  return validation.issues
    .filter((issue) => issue.id === "canon_fact_continuity")
    .map((issue) => issue.description);
}

export function buildCanonFactRevisionNotes(factContext, auditIssues = []) {
  const notes = [];

  if (factContext?.establishedFacts?.length) {
    notes.push("必须遵守的已定事实：");
    for (const fact of factContext.establishedFacts) {
      notes.push(`- ${fact.subject}：${fact.assertion}`);
    }
  }

  if (factContext?.openTensions?.length) {
    notes.push("可以继续发酵但不能改写底层结论的开放张力：");
    for (const fact of factContext.openTensions) {
      notes.push(`- ${fact.subject}：${fact.assertion}`);
    }
  }

  if (auditIssues.length) {
    notes.push("审计发现的连续性冲突：");
    for (const issue of auditIssues) {
      notes.push(`- ${issue}`);
    }
  }

  return notes;
}
