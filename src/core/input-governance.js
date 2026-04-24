import { auditChapterDrift } from "./audit-drift.js";
import { requiredCharactersConstraint } from "./character-presence.js";
import { buildContextTrace } from "./context-trace.js";
import { buildHookAgenda } from "./hook-agenda.js";
import { createExcerpt, unique } from "./text.js";
import { generateStructuredObject } from "../llm/structured.js";

const RULE_PRECEDENCE = ["hardFacts", "softGoals", "deferRules", "currentTask"];

function normalizeList(values, limit = 8) {
  return unique((Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)).slice(0, limit);
}

function normalizeExcerpt(value, maxLength = 220) {
  return createExcerpt(String(value || "").trim(), maxLength);
}

function stringifySource(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  const source = String(entry.source || "").trim();
  if (!source) {
    return "";
  }

  const reason = String(entry.reason || "").trim();
  const excerpt = normalizeExcerpt(entry.excerpt || "");
  return JSON.stringify({
    source,
    reason,
    excerpt,
  });
}

function normalizeRiskAsAvoid(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  if (/^(不要|禁止|不可|避免)/.test(normalized)) {
    return normalized;
  }
  return `避免${normalized}`;
}

function extractStyleGuideSignals(styleGuideText) {
  return String(styleGuideText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
    .slice(0, 4);
}

export function createContextSource({ source, reason, excerpt }) {
  const normalizedSource = String(source || "").trim();
  const normalizedReason = String(reason || "").trim();
  if (!normalizedSource || !normalizedReason) {
    return null;
  }

  return {
    source: normalizedSource,
    reason: normalizedReason,
    excerpt: normalizeExcerpt(excerpt || ""),
  };
}

export function mergeContextSources(groups, limit = 12) {
  const merged = new Map();

  for (const group of Array.isArray(groups) ? groups : []) {
    for (const item of Array.isArray(group) ? group : []) {
      const normalized = createContextSource(item);
      if (!normalized) {
        continue;
      }

      if (!merged.has(normalized.source)) {
        merged.set(normalized.source, normalized);
        continue;
      }

      const existing = merged.get(normalized.source);
      const nextReason = unique([existing.reason, normalized.reason]).join("；");
      const nextExcerpt = existing.excerpt || normalized.excerpt;
      merged.set(normalized.source, {
        source: existing.source,
        reason: nextReason,
        excerpt: nextExcerpt,
      });
    }
  }

  return [...merged.values()].slice(0, limit);
}

export function buildGovernedChapterIntent({
  chapterPlan,
  planContext,
  historyPacket,
  foreshadowingAdvice = [],
  researchPacket,
  styleGuideText,
  factContext = null,
}) {
  const hookAgenda = buildHookAgenda({
    chapterPlan,
    foreshadowingAdvice,
  });
  const conflicts = auditChapterDrift({
    chapterPlan,
    planContext,
    historyPacket,
    foreshadowingAdvice,
    researchPacket,
  });

  return {
    chapter: Number(chapterPlan?.chapterNumber || 0),
    chapterId: String(chapterPlan?.chapterId || "").trim(),
    title: String(chapterPlan?.title || "").trim(),
    goal: String(
      planContext?.outline?.recommendedFocus ||
      chapterPlan?.arcContribution?.[0] ||
      chapterPlan?.keyEvents?.[0] ||
      chapterPlan?.nextHook ||
      "让本章核心任务真正落地。"
    ).trim(),
    mustKeep: normalizeList([
      `POV稳定在 ${chapterPlan?.povCharacter || "当前视角角色"}`,
      requiredCharactersConstraint(chapterPlan),
      ...(planContext?.outline?.mustPreserve || []),
      ...(planContext?.world?.continuityAnchors || []),
      ...(historyPacket?.mustNotContradict || []),
      ...(factContext?.establishedFacts || []).map((f) => `已定事实[${f.factId}]：${f.subject}｜${f.assertion}`),
    ], 14),
    mustAvoid: normalizeList([
      ...(planContext?.characters?.forbiddenLeaks || []),
      ...(planContext?.outline?.deferUntilLater || []).map((item) => `不要提前兑现：${item}`),
      ...(planContext?.outline?.continuityRisks || []).map((item) => normalizeRiskAsAvoid(item)),
      ...(researchPacket?.factsToAvoid || []).map((item) => `不要写成：${item}`),
      ...(researchPacket?.uncertainPoints || []).map((item) => `未核实时不要写死：${item}`),
      ...hookAgenda.avoidNewHookFamilies.map((item) => `存在旧债压力时，不要新增${item}`),
      ...(factContext?.establishedFacts || []).map((f) => `禁止否认/重置已定事实[${f.factId}]：${f.assertion}`),
    ], 14),
    styleEmphasis: normalizeList([
      ...extractStyleGuideSignals(styleGuideText),
      ...(planContext?.world?.styleRules || []),
      ...(planContext?.characters?.writerReminders || []),
    ], 6),
    conflicts,
    hookAgenda,
  };
}

export function buildContextPackage({
  chapterPlan,
  planContext,
  historyPacket,
  writerContext,
  researchPacket,
  referencePacket,
  openingReferencePacket,
  factContext = null,
}) {
  const researchSource = researchPacket?.triggered
    ? createContextSource({
        source: `runtime/staging/write/${chapterPlan?.chapterId || "chapter"}/research_packet.json`,
        reason: "本章存在考据或术语边界，Writer 需要查阅研究资料包。",
        excerpt: researchPacket?.briefingMarkdown || researchPacket?.summary || "",
      })
    : null;
  const referenceSources = (referencePacket?.matches || [])
    .map((item) => createContextSource({
      source: `runtime/rag_collections/${item.collectionId}/sources/${item.sourcePath}`,
      reason: "该范文片段被当前章节混合检索命中，可作为写法参考。",
      excerpt: item.excerpt || item.text || "",
    }))
    .filter(Boolean);
  const openingReferenceSources = (openingReferencePacket?.matches || [])
    .map((item) => createContextSource({
      source: `runtime/opening_collections/${item.collectionId}/sources/${item.sourcePath}`,
      reason: "该优秀开头片段被命中，可作为黄金三章结构参考。",
      excerpt: item.excerpt || item.text || "",
    }))
    .filter(Boolean);
  const factSources = (factContext?.establishedFacts || [])
    .map((item) => createContextSource({
      source: `novel_state/fact_ledger.json`,
      reason: `已定事实[${item.factId}]，来自${item.chapterId}，后文不能否认或重置。`,
      excerpt: item.assertion,
    }))
    .filter(Boolean);

  return {
    chapter: Number(chapterPlan?.chapterNumber || 0),
    chapterId: String(chapterPlan?.chapterId || "").trim(),
    selectedContext: mergeContextSources([
      writerContext?.selectedSources || [],
      planContext?.selectedSources || [],
      historyPacket?.selectedSources || [],
      researchSource ? [researchSource] : [],
      referenceSources,
      openingReferenceSources,
      factSources,
    ], 16),
  };
}

export function buildRuleStack({
  chapterPlan,
  chapterIntent,
  planContext,
  historyPacket,
  researchPacket,
  referencePacket,
  openingReferencePacket,
  factContext = null,
}) {
  const factHardFacts = [];
  const factSoftGoals = [];
  const openingTaskSignals = Number(chapterPlan?.chapterNumber || chapterIntent?.chapter || 0) <= 1
    ? (openingReferencePacket?.structuralBeats || []).slice(0, 1)
    : [];

  if (factContext) {
    for (const fact of factContext.establishedFacts || []) {
      factHardFacts.push(`已定事实[${fact.factId}]：${fact.subject}｜${fact.assertion}`);
    }
    for (const fact of factContext.openTensions || []) {
      factSoftGoals.push(`开放张力[${fact.factId}]：${fact.subject}｜${fact.assertion}（可继续发酵，不可改写底层结论）`);
    }
  }

  return {
    chapter: Number(chapterPlan?.chapterNumber || chapterIntent?.chapter || 0),
    chapterId: String(chapterPlan?.chapterId || chapterIntent?.chapterId || "").trim(),
    precedence: RULE_PRECEDENCE,
    hardFacts: normalizeList([
      ...(chapterIntent?.mustKeep || []),
      ...(historyPacket?.carryOverFacts || []),
      ...(chapterPlan?.continuityAnchors || []),
      ...(planContext?.world?.worldConstraints || []),
      ...(researchPacket?.factsToUse || []).map((item) => `考据事实：${item}`),
      ...factHardFacts,
    ], 18),
    softGoals: normalizeList([
      chapterIntent?.goal || "",
      ...(chapterPlan?.keyEvents || []),
      ...(chapterPlan?.arcContribution || []),
      ...(chapterIntent?.styleEmphasis || []),
      ...(referencePacket?.styleSignals || []).map((item) => `范文风格参考：${item}`),
      ...(referencePacket?.scenePatterns || []).map((item) => `范文场景参考：${item}`),
      ...(openingReferencePacket?.openingHooks || []).map((item) => `黄金三章开场参考：${item}`),
      ...(openingReferencePacket?.protagonistEntryPatterns || []).map((item) => `黄金三章主角亮相：${item}`),
      ...(openingReferencePacket?.conflictIgnitionPatterns || []).map((item) => `黄金三章冲突点燃：${item}`),
      ...(openingReferencePacket?.pacingSignals || []).map((item) => `黄金三章节奏：${item}`),
      ...(openingReferencePacket?.chapterEndHookPatterns || []).map((item) => `黄金三章章末牵引：${item}`),
      ...(openingReferencePacket?.structuralBeats || []).map((item) => `黄金三章结构拍点：${item}`),
      ...(chapterIntent?.hookAgenda?.mustAdvance || []).map((item) => `本章必须推进伏笔 ${item}`),
      ...(chapterIntent?.hookAgenda?.eligibleResolve || []).map((item) => `本章允许兑现伏笔 ${item}`),
      ...factSoftGoals,
    ], 18),
    deferRules: normalizeList([
      ...(planContext?.outline?.deferUntilLater || []),
      ...(chapterIntent?.mustAvoid || []),
      ...(referencePacket?.avoidPatterns || []).map((item) => `范文参考仅借方法，避免：${item}`),
      ...(openingReferencePacket?.avoidPatterns || []).map((item) => `黄金三章参考仅借结构，避免：${item}`),
      ...(chapterIntent?.hookAgenda?.staleDebt || []).map((item) => `旧伏笔 ${item} 已形成 stale debt，本章少开新坑。`),
    ], 14),
    currentTask: normalizeList([
      planContext?.outline?.recommendedFocus || "",
      ...(chapterPlan?.keyEvents || []).slice(0, 3),
      ...openingTaskSignals,
      ...(chapterIntent?.conflicts || []).map((item) => item.resolution),
    ], 8),
  };
}

export async function runGovernanceAgent({
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
  factContext = null,
}) {
  const fallbackIntent = buildGovernedChapterIntent({
    chapterPlan,
    planContext,
    historyPacket,
    foreshadowingAdvice,
    researchPacket,
    styleGuideText,
    factContext,
  });
  const fallbackContextPackage = buildContextPackage({
    chapterPlan,
    planContext,
    historyPacket,
    writerContext,
    researchPacket,
    referencePacket,
    openingReferencePacket,
    factContext,
  });
  const fallbackRuleStack = buildRuleStack({
    chapterPlan,
    chapterIntent: fallbackIntent,
    planContext,
    historyPacket,
    researchPacket,
    referencePacket,
    openingReferencePacket,
    factContext,
  });

  const packet = await generateStructuredObject(provider, {
    label: "GovernanceAgent",
    agentComplexity: "complex",
    instructions:
      "你是 Novelex 的 GovernanceAgent。你的职责是把写作主路径需要的 chapter_intent、context_package 和 rule_stack 统一整理成一份可执行治理包。必须只基于给定上下文做取舍，不要发明新剧情。chapter_intent 负责本章目标与禁区，context_package 负责最值得引用的来源，rule_stack 负责 hardFacts / softGoals / deferRules / currentTask。只输出 JSON。",
    input: [
      `当前章节：${chapterPlan?.chapterId || ""} ${chapterPlan?.title || ""}`,
      `计划侧上下文：\n${planContext?.briefingMarkdown || planContext?.summaryText || "无"}`,
      `历史侧上下文：\n${historyPacket?.briefingMarkdown || historyPacket?.contextSummary || "无"}`,
      `Writer 上下文：\n${writerContext?.briefingMarkdown || writerContext?.summaryText || "无"}`,
      `研究资料包：\n${researchPacket?.briefingMarkdown || researchPacket?.summary || "无"}`,
      `范文参考包：\n${referencePacket?.briefingMarkdown || referencePacket?.summary || "无"}`,
      `黄金三章参考包：\n${openingReferencePacket?.briefingMarkdown || openingReferencePacket?.summary || "无"}`,
      `风格指南：\n${styleGuideText || "无"}`,
      `伏笔建议：\n${JSON.stringify(foreshadowingAdvice || [], null, 2)}`,
      `Canon facts：\n${JSON.stringify(factContext || {}, null, 2)}`,
      `参考输出骨架：
${JSON.stringify({
  chapterIntent: fallbackIntent,
  contextPackage: fallbackContextPackage,
  ruleStack: fallbackRuleStack,
}, null, 2)}`,
      `请输出 JSON：
{
  "chapterIntent": {
    "goal": "一句话目标",
    "mustKeep": ["硬性保留项"],
    "mustAvoid": ["禁止项"],
    "styleEmphasis": ["文风强调"],
    "conflicts": [{"source": "source", "resolution": "怎么处理冲突"}],
    "hookAgenda": {
      "mustAdvance": ["id"],
      "eligibleResolve": ["id"],
      "staleDebt": ["id"],
      "avoidNewHookFamilies": ["家族名"]
    }
  },
  "contextPackage": {
    "selectedContext": [
      {"source": "path", "reason": "为什么要看", "excerpt": "摘录"}
    ]
  },
  "ruleStack": {
    "precedence": ["hardFacts", "softGoals", "deferRules", "currentTask"],
    "hardFacts": ["..."],
    "softGoals": ["..."],
    "deferRules": ["..."],
    "currentTask": ["..."]
  }
}`,
    ].join("\n\n"),
    metadata: {
      feature: "input_governance",
      chapterId: chapterPlan?.chapterId || "",
    },
    normalize(parsed) {
      const rawIntent = parsed.chapterIntent && typeof parsed.chapterIntent === "object"
        ? parsed.chapterIntent
        : {};
      const hookAgenda = rawIntent.hookAgenda && typeof rawIntent.hookAgenda === "object"
        ? rawIntent.hookAgenda
        : {};
      const chapterIntent = {
        ...fallbackIntent,
        goal: String(rawIntent.goal || fallbackIntent.goal || "").trim(),
        mustKeep: normalizeList(rawIntent.mustKeep, 14),
        mustAvoid: normalizeList(rawIntent.mustAvoid, 14),
        styleEmphasis: normalizeList(rawIntent.styleEmphasis, 6),
        conflicts: (Array.isArray(rawIntent.conflicts) ? rawIntent.conflicts : [])
          .map((item) => ({
            source: String(item?.source || "").trim(),
            field: String(item?.field || "").trim(),
            value: String(item?.value || "").trim(),
            reason: String(item?.reason || "").trim(),
            resolution: String(item?.resolution || "").trim(),
          }))
          .filter((item) => item.resolution),
        hookAgenda: {
          mustAdvance: normalizeList(hookAgenda.mustAdvance, 6),
          eligibleResolve: normalizeList(hookAgenda.eligibleResolve, 6),
          staleDebt: normalizeList(hookAgenda.staleDebt, 6),
          avoidNewHookFamilies: normalizeList(hookAgenda.avoidNewHookFamilies, 6),
        },
      };

      const rawContextPackage = parsed.contextPackage && typeof parsed.contextPackage === "object"
        ? parsed.contextPackage
        : {};
      const contextPackage = {
        chapter: Number(chapterPlan?.chapterNumber || 0),
        chapterId: String(chapterPlan?.chapterId || "").trim(),
        selectedContext: mergeContextSources([
          Array.isArray(rawContextPackage.selectedContext) ? rawContextPackage.selectedContext : [],
          fallbackContextPackage.selectedContext || [],
        ], 16),
      };

      const rawRuleStack = parsed.ruleStack && typeof parsed.ruleStack === "object"
        ? parsed.ruleStack
        : {};
      const ruleStack = {
        chapter: Number(chapterPlan?.chapterNumber || 0),
        chapterId: String(chapterPlan?.chapterId || "").trim(),
        precedence: RULE_PRECEDENCE,
        hardFacts: normalizeList(rawRuleStack.hardFacts, 18),
        softGoals: normalizeList(rawRuleStack.softGoals, 18),
        deferRules: normalizeList(rawRuleStack.deferRules, 14),
        currentTask: normalizeList(rawRuleStack.currentTask, 8),
      };

      if (!chapterIntent.mustKeep.length) {
        chapterIntent.mustKeep = fallbackIntent.mustKeep || [];
      }
      if (!ruleStack.hardFacts.length) {
        ruleStack.hardFacts = fallbackRuleStack.hardFacts || [];
      }
      if (!ruleStack.softGoals.length) {
        ruleStack.softGoals = fallbackRuleStack.softGoals || [];
      }

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
    },
  });

  return packet;
}

export function buildGovernedInputContract({
  chapterIntent,
  contextPackage,
  ruleStack,
}) {
  const hookAgenda = chapterIntent?.hookAgenda || {};
  const selectedSources = (contextPackage?.selectedContext || [])
    .slice(0, 6)
    .map((item) => `- ${item.source}｜${item.reason}｜${item.excerpt || "无摘录"}`)
    .join("\n");
  const activeHardFacts = (ruleStack?.hardFacts || []).slice(0, 6).join("；");
  const activeSoftGoals = (ruleStack?.softGoals || []).slice(0, 6).join("；");
  const activeDefers = (ruleStack?.deferRules || []).slice(0, 6).join("；");

  return [
    "## 输入治理契约",
    "- 先 obey chapter intent。`mustKeep` 是硬要求，`mustAvoid` 是禁止项。",
    "- `hardFacts` 不能冲撞，`softGoals` 决定场景重心，`deferRules` 代表本章不能提前兑现的内容。",
    `- 只有 eligibleResolve 中列出的伏笔才能真正回收：${(hookAgenda.eligibleResolve || []).join("、") || "无"}`,
    `- mustAdvance 中列出的伏笔必须有明确推进动作：${(hookAgenda.mustAdvance || []).join("、") || "无"}`,
    `- staleDebt 如非空，先消化旧承诺压力：${(hookAgenda.staleDebt || []).join("、") || "无"}`,
    `- avoidNewHookFamilies 如非空，不要随手再开同类新坑：${(hookAgenda.avoidNewHookFamilies || []).join("、") || "无"}`,
    "",
    "## Chapter Intent",
    `- 目标：${chapterIntent?.goal || "无"}`,
    `- 必须保留：${(chapterIntent?.mustKeep || []).join("；") || "无"}`,
    `- 必须避免：${(chapterIntent?.mustAvoid || []).join("；") || "无"}`,
    `- 风格强调：${(chapterIntent?.styleEmphasis || []).join("；") || "无"}`,
    `- 冲突处理：${(chapterIntent?.conflicts || []).map((item) => item.resolution).join("；") || "无"}`,
    "",
    "## Rule Stack",
    `- hardFacts：${activeHardFacts || "无"}`,
    `- softGoals：${activeSoftGoals || "无"}`,
    `- deferRules：${activeDefers || "无"}`,
    "",
    "## Selected Context Sources",
    selectedSources || "- 当前没有额外上下文来源。",
  ].join("\n");
}

export function serializeContextSourcesForTrace(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((item) => stringifySource(item))
    .filter(Boolean);
}
