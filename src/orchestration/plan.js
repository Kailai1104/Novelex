import { createHash } from "node:crypto";

import { PLAN_STATUS, REVIEW_TARGETS, WRITE_STATUS } from "../core/defaults.js";
import {
  buildCast,
  buildForeshadowingRegistry,
  buildOutlineData,
  buildOutlineDraft,
  buildStructure,
} from "../core/generators.js";
import { createExcerpt, extractJsonObject, nowIso, safeJsonParse } from "../core/text.js";
import { createProvider } from "../llm/provider.js";
import { generateStructuredObject } from "../llm/structured.js";
import { buildOpeningReferencePacket } from "../opening/reference.js";

const CHARACTER_AGENT_CONCURRENCY = 2;
const PLAN_FINAL_CACHE_VERSION = 1;
const STRUCTURE_CRITIC_MAX_ATTEMPTS = 2;
const PRE_APPROVAL_MAX_ATTEMPTS = 2;

function runId(prefix) {
  return `${prefix}-${Date.now()}`;
}

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

function failedStep(id, label, layer, summary, extra = {}) {
  return {
    id,
    label,
    layer,
    status: "failed",
    summary,
    ...extra,
  };
}

async function saveProjectAndRun(store, projectState, run) {
  const savedProject = await store.saveProject(projectState);
  await store.saveRun(run);
  return {
    project: savedProject,
    run,
  };
}

function withHumanNotes(markdown, notes) {
  if (!notes?.length) {
    return markdown;
  }

  return `${markdown}\n## 本轮人类修订意见\n- ${notes.join("\n- ")}\n`;
}

function outlineMarkdownFromDraft(outlineDraft) {
  const feedbackBlock = outlineDraft.feedbackNotes?.length
    ? `\n\n## 本轮修订重点\n- ${outlineDraft.feedbackNotes.join("\n- ")}\n`
    : "";

  return `# 大纲草稿\n\n## 一句话核心梗\n${outlineDraft.coreHook}\n\n## 简纲\n${outlineDraft.shortSynopsis}\n\n## 粗纲\n${outlineDraft.roughSections
    .map((section) => `### ${section.stage}\n${section.content}`)
    .join("\n\n")}${feedbackBlock}\n`;
}

function parseJsonResult(result, label) {
  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${label} 返回了无法解析的 JSON：${createExcerpt(result.text || "", 280)}`);
  }
  return parsed;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function isStructureCriticFailureMessage(message) {
  return /StructureAgent 第 \d+ 阶段未通过 StructureCriticAgent：/.test(String(message || ""));
}

function extractStructureCriticIssues(error) {
  const message = errorMessage(error);
  const match = message.match(/StructureAgent 第 \d+ 阶段未通过 StructureCriticAgent：(.+)/);
  if (!match) {
    return [];
  }

  return uniqueNotes(
    String(match[1] || "")
      .split(/[；\n]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function pickPlanFinalCacheProviderSettings(settings) {
  if (!settings) {
    return null;
  }

  return {
    effectiveMode: settings.effectiveMode,
    baseUrl: settings.baseUrl,
    responseModel: settings.responseModel,
    reviewModel: settings.reviewModel,
    reasoningEffort: settings.reasoningEffort,
  };
}

function createPlanFinalCacheKey(scope, payload) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: PLAN_FINAL_CACHE_VERSION,
        scope,
        payload,
      }),
    )
    .digest("hex");
}

async function loadPlanFinalCacheValue(store, entryName, cacheKey) {
  const cached = await store.loadPlanFinalCacheEntry(entryName, null);
  if (!cached || cached.cacheKey !== cacheKey) {
    return null;
  }

  return Object.prototype.hasOwnProperty.call(cached, "value") ? cached.value : null;
}

async function stagePlanFinalCacheValue(store, entryName, cacheKey, value) {
  await store.stagePlanFinalCacheEntry(entryName, {
    cacheKey,
    savedAt: nowIso(),
    value,
  });
}

async function saveFailedRun(store, run, failure, error) {
  const message = errorMessage(error);
  run.finishedAt = nowIso();
  run.failedAt = run.finishedAt;
  run.status = "failed";
  run.error = {
    stepId: failure.id,
    label: failure.label,
    message,
  };
  run.steps.push(
    failedStep(
      failure.id,
      failure.label,
      "plan",
      message,
      failure.extra || {},
    ),
  );
  run.summary = `Plan Finalization 在 ${failure.label} 失败：${message}`;
  await store.saveRun(run);
}

function clampScore(score, fallback = 70) {
  const normalized = Number(score);
  if (Number.isFinite(normalized)) {
    return Math.max(0, Math.min(100, Math.round(normalized)));
  }
  return fallback;
}

function normalizeIssueList(issues) {
  return [...new Set((Array.isArray(issues) ? issues : []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeChecks(checks) {
  return (Array.isArray(checks) ? checks : [])
    .map((check, index) => {
      const name = String(check?.name || "").trim() || `检查项${index + 1}`;
      const detail = String(check?.detail || check?.comment || "").trim() || `${name}需要进一步说明。`;
      return {
        name,
        passed: Boolean(check?.passed),
        detail,
      };
    })
    .filter((check) => check.name && check.detail);
}

function normalizeRubricCriticResult(parsed, label) {
  const issues = normalizeIssueList(parsed.issues);
  const checks = normalizeChecks(parsed.checks);
  const passed = typeof parsed.passed === "boolean" ? parsed.passed : issues.length === 0;
  const summary = String(parsed.summary || "").trim() || (passed ? `${label} 认为当前结果可以继续推进。` : `${label} 认为当前结果仍需修订。`);

  return {
    passed,
    score: clampScore(parsed.score, passed ? 86 : 58),
    summary,
    issues,
    checks,
  };
}

function normalizeReverseCriticResult(parsed, label) {
  const issues = normalizeIssueList(parsed.issues || parsed.divergencePoints);
  const passed = typeof parsed.passed === "boolean" ? parsed.passed : issues.length === 0;
  const summary = String(parsed.summary || "").trim() || (passed ? `${label} 认为正逆向推导基本一致。` : `${label} 认为正逆向推导仍有偏差。`);

  return {
    passed,
    score: clampScore(parsed.score, passed ? 84 : 55),
    summary,
    issues,
    reconstructedHook: String(parsed.reconstructedHook || parsed.reverseHook || "").trim(),
    reconstructedSummary: String(parsed.reconstructedSummary || parsed.reverseSummary || "").trim(),
  };
}

function normalizeStringList(values, limit = 8) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

function normalizeStructureTextSignature(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\d+/g, "")
    .replace(/[\s、，。；：？！!?,.（）()\[\]【】《》“”"'`~\-_/]+/g, "")
    .trim();
}

function duplicateRate(values = []) {
  const signatures = values.map((item) => normalizeStructureTextSignature(item)).filter(Boolean);
  if (signatures.length <= 1) {
    return 0;
  }
  return Number((1 - new Set(signatures).size / signatures.length).toFixed(4));
}

function computeAntiTemplateMetrics(chapters = []) {
  const titleDupRate = duplicateRate(chapters.map((chapter) => chapter.title));
  const hookDupRate = duplicateRate(chapters.map((chapter) => chapter.nextHook));
  const locationDupRate = duplicateRate(chapters.map((chapter) => chapter.location));
  const eventPatternDupRate = duplicateRate(chapters.map((chapter) => (chapter.keyEvents || []).join("｜")));

  return {
    chapterCount: chapters.length,
    titleDupRate,
    hookDupRate,
    locationDupRate,
    eventPatternDupRate,
  };
}

function antiTemplateIssues(metrics) {
  const issues = [];
  if ((metrics?.chapterCount || 0) < 3) {
    return issues;
  }
  if ((metrics?.titleDupRate || 0) >= 0.45) {
    issues.push(`章节标题重复率过高（${metrics.titleDupRate}），需要明显拉开章节功能和命名。`);
  }
  if ((metrics?.hookDupRate || 0) >= 0.45) {
    issues.push(`章末钩子模板重复率过高（${metrics.hookDupRate}），需要轮换钩子类型。`);
  }
  if ((metrics?.locationDupRate || 0) >= 0.6) {
    issues.push(`地点重复率偏高（${metrics.locationDupRate}），需避免只换事件不换场景张力。`);
  }
  if ((metrics?.eventPatternDupRate || 0) >= 0.45) {
    issues.push(`关键事件句式或推进功能高度同构（${metrics.eventPatternDupRate}），需要打散推进模板。`);
  }
  return issues;
}

function normalizeStructureCriticResult(parsed, heuristicIssues = []) {
  const issues = normalizeIssueList([...(Array.isArray(parsed?.issues) ? parsed.issues : []), ...heuristicIssues]);
  const passedByModel = typeof parsed?.passed === "boolean" ? parsed.passed : issues.length === 0;
  const passed = passedByModel && heuristicIssues.length === 0;
  return {
    passed,
    retryRecommended: Boolean(parsed?.retryRecommended) || heuristicIssues.length > 0,
    summary: String(parsed?.summary || "").trim() || (passed ? "结构质量检查通过。" : "结构质量检查未通过。"),
    issues,
    checks: normalizeChecks(parsed?.checks),
  };
}

function projectSummary(project) {
  return [
    `标题：${project.title}`,
    `类型：${project.genre}`,
    `设定：${project.setting}`,
    `故事前提：${project.premise}`,
    `主题：${project.theme}`,
    `主角目标：${project.protagonistGoal}`,
    `研究备注：${project.researchNotes || "无"}`,
    `目标章节数：${project.totalChapters}`,
    `阶段数：${project.stageCount}`,
  ].join("\n");
}

function castSummary(cast) {
  return cast
    .map(
      (character) =>
        `- ${character.name}｜${character.role}｜${character.historicalStatus === "real" ? "真实历史人物" : "虚构人物"}｜欲望：${character.desire}｜弱点：${character.wound}`,
    )
    .join("\n");
}

function openingReferencePromptBlock(openingReferencePacket) {
  return `黄金三章参考包（只借结构，不借句子）：\n${openingReferencePacket?.briefingMarkdown || "当前没有额外黄金三章参考。"}`;
}

function computeStageSpecs(project, outlineDraft) {
  const stageCount = Math.max(1, Number(project.stageCount) || 1);
  const totalChapters = Math.max(stageCount, Number(project.totalChapters) || stageCount);
  const baseSize = Math.floor(totalChapters / stageCount);
  const remainder = totalChapters % stageCount;
  let chapterStart = 1;

  return Array.from({ length: stageCount }, (_, index) => {
    const chapterCount = baseSize + (index < remainder ? 1 : 0);
    const chapterEnd = chapterStart + chapterCount - 1;
    const roughSection = outlineDraft.roughSections[index] || {};
    const spec = {
      stageNumber: index + 1,
      chapterStart,
      chapterEnd,
      chapterCount,
      label: String(roughSection.stage || `阶段${index + 1}`).trim(),
      focus: String(roughSection.content || outlineDraft.shortSynopsis || "").trim(),
    };
    chapterStart = chapterEnd + 1;
    return spec;
  });
}

function chapterIdToNumber(chapterId) {
  const value = Number(String(chapterId || "").replace(/\D/g, ""));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function foreshadowingTouchesStage(item, stageSpec) {
  const chapters = [
    chapterIdToNumber(item?.planned_plant_chapter),
    Number(item?.intended_payoff_chapter || 0),
    ...(Array.isArray(item?.waterAt) ? item.waterAt.map((chapter) => Number(chapter) || 0) : []),
  ].filter((chapter) => chapter > 0);

  return chapters.some((chapter) => chapter >= stageSpec.chapterStart && chapter <= stageSpec.chapterEnd);
}

function foreshadowingTouchesRange(item, chapterStart, chapterEnd) {
  const chapters = [
    chapterIdToNumber(item?.planned_plant_chapter),
    Number(item?.intended_payoff_chapter || 0),
    ...(Array.isArray(item?.waterAt) ? item.waterAt.map((chapter) => Number(chapter) || 0) : []),
  ].filter((chapter) => chapter > 0);

  return chapters.some((chapter) => chapter >= chapterStart && chapter <= chapterEnd);
}

function computeChapterBatchSpecs(stageSpec, batchSize = 5) {
  const size = Math.max(1, Number(batchSize) || 1);
  const batches = [];
  for (let chapterStart = stageSpec.chapterStart; chapterStart <= stageSpec.chapterEnd; chapterStart += size) {
    const chapterEnd = Math.min(stageSpec.chapterEnd, chapterStart + size - 1);
    batches.push({
      batchId: `${stageSpec.stageNumber}_${chapterStart}_${chapterEnd}`,
      chapterStart,
      chapterEnd,
      chapterCount: chapterEnd - chapterStart + 1,
    });
  }
  return batches;
}

async function runWithConcurrency(items, limit, worker) {
  const concurrency = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let cursor = 0;

  async function consume() {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => consume()),
  );

  return results;
}

function stageSummaryMarkdown(structureData) {
  return structureData.stages
    .map((stage) => {
      const stageChapters = structureData.chapters.filter((chapter) => stage.chapters.includes(chapter.chapterId));
      if (!stageChapters.length) {
        return `## ${stage.label}
- 章节范围：${stage.range[0]}-${stage.range[1]}
- 阶段目标：${stage.stageGoal || stage.purpose}
- 主要冲突：${(stage.stageConflicts || []).join("；") || "待推进中的主要矛盾"}`;
      }
      return `## ${stage.label}
- 章节范围：${stage.range[0]}-${stage.range[1]}
- 阶段目标：${stage.stageGoal || stage.purpose}
- 主要冲突：${(stage.stageConflicts || []).join("；") || "待推进中的主要矛盾"}
- 代表章节：
${stageChapters
  .slice(0, 4)
  .map(
    (chapter) =>
      `  - ${chapter.chapterId} ${chapter.title}｜POV:${chapter.povCharacter}｜事件:${chapter.keyEvents.join(" / ")}｜钩子:${chapter.nextHook}`,
  )
  .join("\n")}`;
    })
    .join("\n\n");
}

function castNameList(cast) {
  return cast.map((character) => character.name).join("、");
}

function mergeCastWithAdditions(project, cast, additions) {
  const existingNames = new Set(cast.map((character) => character.name));
  const nextExtras = [];
  let extraIndex = cast.filter((character) => character.roleKey.startsWith("support_extra_")).length + 1;

  for (const raw of additions) {
    const name = String(raw?.name || "").trim();
    if (!name || existingNames.has(name)) {
      continue;
    }
    existingNames.add(name);
    nextExtras.push({
      roleKey: `support_extra_${extraIndex}`,
      role: String(raw?.role || "扩展角色").trim() || "扩展角色",
      name,
      historicalStatus: raw?.historicalStatus === "real" ? "real" : "fictional",
      nameRationale: String(raw?.nameRationale || `${name}是在大纲推进中被明确引入的重要人物。`).trim(),
      tags: Array.isArray(raw?.tags) ? raw.tags : ["剧情推进", "新增角色"],
      voice: String(raw?.voice || "说话方式会根据其身份与功能体现鲜明辨识度。").trim(),
      desire: String(raw?.desire || "在主线推进中争取自己的利益与位置。").trim(),
      wound: String(raw?.wound || "有未被解决的现实压力或性格裂缝。").trim(),
      blindspot: String(raw?.blindspot || "在关键判断上存在明显盲区。").trim(),
      signatureItem: String(raw?.signatureItem || "与其身份相匹配的标志物").trim(),
      appearance: String(raw?.appearance || "具备可识别的外在特征").trim(),
      entryLocation: String(raw?.entryLocation || "大纲指定的首次关键出场地点").trim(),
      relationshipHint: String(raw?.relationshipHint || "与主角及核心班底存在可持续的关系张力。").trim(),
      relationships: raw?.relationships && typeof raw.relationships === "object" ? raw.relationships : {},
    });
    extraIndex += 1;
  }

  return nextExtras.length ? buildCast(project, [...cast, ...nextExtras]) : cast;
}

function projectWithCast(project, cast) {
  const protagonist = cast.find((item) => item.roleKey === "protagonist");
  const ally = cast.find((item) => item.roleKey === "ally");
  const rival = cast.find((item) => item.roleKey === "rival");
  const antagonist = cast.find((item) => item.roleKey === "antagonist");
  const supports = cast
    .filter((item) => item.roleKey.startsWith("support_"))
    .map((item) => item.name)
    .join(", ");

  return {
    ...project,
    protagonistName: protagonist?.name || project.protagonistName || "主角",
    allyName: ally?.name || project.allyName || "盟友",
    rivalName: rival?.name || project.rivalName || "对手",
    antagonistName: antagonist?.name || project.antagonistName || "反派",
    supportingCast: supports || project.supportingCast || "",
  };
}

async function generateCastViaProvider(provider, project, feedbackNotes) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 CharacterPlanningAgent。请根据项目信息为长篇网络小说规划一组最关键的核心角色。你必须先理解题材、时代、世界规则与主角目标，再决定人物的身份、命名和历史真实性约束。只输出 JSON，不要解释。",
    input: [
      projectSummary(project),
      feedbackNotes.length ? `人类修订意见：${feedbackNotes.join("；")}` : "",
      "要求：",
      "1. 必须输出 protagonist、ally、rival、antagonist、support_1、support_2 六个角色。",
      "2. 你要自行判断作品是否需要真实历史人物。如果题材带有真实历史背景，就明确哪些角色是真实历史人物、哪些是虚构人物，并避免杜撰不存在的史实人物。",
      "3. 所有角色都必须直接服务于主角目标，而不是服务于别的题材模板。",
      "4. 不要擅自引入调查真相、旧记录、城市记忆、档案馆阴谋这类未在项目信息中出现的主线。",
      `请输出 JSON：
{
  "characters": [
    {
      "roleKey": "protagonist",
      "role": "主角",
      "name": "角色名",
      "historicalStatus": "real 或 fictional",
      "nameRationale": "命名或身份说明",
      "tags": ["标签1", "标签2", "标签3"],
      "voice": "说话方式",
      "desire": "角色此时最核心的追求",
      "wound": "角色内在伤口或长期弱点",
      "blindspot": "角色认知盲点",
      "signatureItem": "具有辨识度的物件或符号",
      "appearance": "外在辨识度",
      "entryLocation": "初登场位置",
      "relationshipHint": "与主角的核心关系张力"
    }
  ]
}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const parsed = parseJsonResult(result, "CharacterPlanningAgent");
  if (!Array.isArray(parsed.characters) || !parsed.characters.length) {
    throw new Error("CharacterPlanningAgent 没有返回 characters 数组。");
  }
  return buildCast(project, parsed.characters);
}

async function generateOutlineViaProvider(provider, project, cast, feedbackNotes, openingReferencePacket = null) {
  const resolvedProject = projectWithCast(project, cast);
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 OutlineAgent。请为长篇网络小说生成一版高度贴合项目需求的大纲草稿。主轴必须围绕主角目标、题材承诺、主要势力冲突和角色弧光展开。只输出 JSON 对象，不要解释。",
    input: [
      projectSummary(resolvedProject),
      `角色规划：\n${castSummary(cast)}`,
      openingReferencePromptBlock(openingReferencePacket),
      feedbackNotes.length ? `人类修订意见：${feedbackNotes.join("；")}` : "",
      "写作要求：",
      "1. 一句话核心梗必须直接概括主角要做什么、阻力从哪里来、故事会打到什么规模。",
      "2. 简纲必须围绕题材承诺展开。如果是种田/争霸/工业/海权/战争题材，就要写这些，而不是偷换成悬疑调查。",
      "3. 粗纲的阶段数必须等于项目要求的阶段数。",
      "4. 不要引入项目中不存在的悬疑母题、档案馆母题或记忆操控母题。",
      `请输出如下 JSON：
{
  "coreHook": "一句话核心梗",
  "shortSynopsis": "300-500字简纲",
  "roughSections": [
    {"stage": "阶段1·...", "content": "..."},
    {"stage": "阶段2·...", "content": "..."},
    {"stage": "阶段3·...", "content": "..."},
    {"stage": "阶段4·...", "content": "..."}
  ]
}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const parsed = parseJsonResult(result, "OutlineAgent");
  return buildOutlineDraft({
    coreHook: parsed.coreHook,
    shortSynopsis: parsed.shortSynopsis,
    roughSections: parsed.roughSections,
    feedbackNotes,
    provider: {
      model: result.model,
      mode: result.mode,
    },
  });
}

async function expandCastViaProvider(provider, project, cast, outlineDraft, feedbackNotes) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 CastExpansionAgent。请检查当前大纲草稿与现有角色表之间是否存在缺口。如果大纲已经引入了不在 cast 里的持续性人物，或者明显需要补入的长期核心配角，请把他们补全为正式角色条目。只输出 JSON，不要解释。",
    input: [
      projectSummary(project),
      `当前正式 cast：\n${castSummary(cast)}`,
      `当前 cast 角色名单：${castNameList(cast)}`,
      `待审大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      feedbackNotes.length ? `人类修订意见：${feedbackNotes.join("；")}` : "",
      "要求：",
      "1. 只补充真正会在后续章节持续发挥作用的角色，不要把一次性龙套加进来。",
      "2. 如果大纲里没有新增重要角色，就返回空数组。",
      "3. 不要修改现有 cast 中已经存在的角色。",
      "4. 输出的人物信息要足够完整，能直接进入 CharacterAgent 和 StructureAgent 后续链路。",
      `请输出 JSON：
{
  "additionalCharacters": [
    {
      "name": "角色名",
      "role": "扩展角色定位",
      "historicalStatus": "real 或 fictional",
      "nameRationale": "命名或身份说明",
      "tags": ["标签1", "标签2"],
      "voice": "说话方式",
      "desire": "核心追求",
      "wound": "核心伤口",
      "blindspot": "认知盲点",
      "signatureItem": "标志物",
      "appearance": "外在辨识度",
      "entryLocation": "初登场位置",
      "relationshipHint": "与主角或主线的关系张力"
    }
  ]
}`,
    ].filter(Boolean).join("\n\n"),
  });

  const parsed = parseJsonResult(result, "CastExpansionAgent");
  const additions = Array.isArray(parsed.additionalCharacters) ? parsed.additionalCharacters : [];
  return mergeCastWithAdditions(project, cast, additions);
}

async function reviseOutlineViaProvider(provider, project, cast, outlineDraft, criticA, criticB, feedbackNotes, openingReferencePacket = null) {
  const revisionNotes = uniqueNotes([
    ...(criticA.issues || []),
    ...(criticB.issues || []),
    ...(criticB.passed ? [] : ["请让核心梗和阶段粗纲更加同轴。"]),
    ...feedbackNotes,
  ]);

  return reviseOutlineWithNotesViaProvider(
    provider,
    project,
    cast,
    outlineDraft,
    revisionNotes,
    openingReferencePacket,
  );
}

async function reviseOutlineWithNotesViaProvider(provider, project, cast, outlineDraft, revisionNotes, openingReferencePacket = null) {
  const notes = uniqueNotes(revisionNotes || []);

  if (!notes.length) {
    return outlineDraft;
  }

  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 RevisionAgent。请根据 Critic 和人类反馈修订当前大纲草稿。保持题材、主角目标与角色设定不变，只做有针对性的结构修订。只输出 JSON 对象，不要解释。",
    input: [
      projectSummary(project),
      `角色规划：\n${castSummary(cast)}`,
      `当前大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      openingReferencePromptBlock(openingReferencePacket),
      `修订意见：\n- ${notes.join("\n- ")}`,
      `请输出如下 JSON：
{
  "coreHook": "修订后的一句话核心梗",
  "shortSynopsis": "修订后简纲",
  "roughSections": [
    {"stage": "阶段1·...", "content": "..."},
    {"stage": "阶段2·...", "content": "..."}
  ]
}`,
    ].join("\n\n"),
  });

  const parsed = parseJsonResult(result, "RevisionAgent");
  const revised = buildOutlineDraft({
    coreHook: parsed.coreHook,
    shortSynopsis: parsed.shortSynopsis,
    roughSections: parsed.roughSections,
    feedbackNotes: notes,
    provider: {
      model: result.model,
      mode: result.mode,
    },
  });
  revised.revisionNotes = notes;
  return revised;
}

async function critiqueOutlineDraftAViaProvider(provider, project, cast, outlineDraft, openingReferencePacket = null) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 CriticAgent_A。请像资深网络小说策划编辑一样，严格评估当前大纲草稿是否真正贴合项目需求。重点检查：题材承诺、主角目标、主要冲突、角色配置、阶段推进、读者期待。只输出 JSON，不要解释。",
    input: [
      projectSummary(project),
      `角色规划：\n${castSummary(cast)}`,
      `待审大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      openingReferencePromptBlock(openingReferencePacket),
      "评审要求：",
      "1. 不要用固定类型模板去评判，而要基于项目自身题材和目标。",
      "2. issues 必须写成可执行的修订意见，而不是抽象评价。",
      "3. checks 至少给 4 项，且每项都要有 detail。",
      `请输出 JSON：
{
  "passed": true,
  "score": 0,
  "summary": "一句总体判断",
  "issues": ["需要修订的问题1", "需要修订的问题2"],
  "checks": [
    {"name": "题材承诺", "passed": true, "detail": "说明"},
    {"name": "主角目标", "passed": true, "detail": "说明"},
    {"name": "阶段推进", "passed": true, "detail": "说明"},
    {"name": "角色与冲突", "passed": true, "detail": "说明"}
  ]
}`,
    ].join("\n\n"),
    useReviewModel: true,
  });

  return normalizeRubricCriticResult(parseJsonResult(result, "CriticAgent_A"), "CriticAgent_A");
}

async function critiqueOutlineDraftBViaProvider(provider, project, cast, outlineDraft, openingReferencePacket = null) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 CriticAgent_B。请采用逆向重建的方式评估大纲草稿：先只根据草稿重建这本书的题材承诺、主角目标和故事规模，再与原项目要求对比，判断是否偏轴。只输出 JSON，不要解释。",
    input: [
      projectSummary(project),
      `角色规划：\n${castSummary(cast)}`,
      `待审大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      openingReferencePromptBlock(openingReferencePacket),
      "评审要求：",
      "1. reconstructedHook 要用一句话重建你认为这本书真正承诺了什么。",
      "2. reconstructedSummary 要简述你从草稿中逆向读出的主线和升级路径。",
      "3. 如果发现偏轴，issues 要明确指出偏在哪里、该如何纠正。",
      `请输出 JSON：
{
  "passed": true,
  "score": 0,
  "summary": "一句总体判断",
  "reconstructedHook": "你逆向重建出的一句话核心梗",
  "reconstructedSummary": "你逆向重建出的故事简述",
  "issues": ["如果偏轴，这里写修订建议"]
}`,
    ].join("\n\n"),
    useReviewModel: true,
  });

  return normalizeReverseCriticResult(parseJsonResult(result, "CriticAgent_B"), "CriticAgent_B");
}

async function critiqueFinalPlanAViaProvider(
  provider,
  project,
  outlineDraft,
  outlineMarkdown,
  structureData,
  characters,
  worldbuildingMarkdown,
  openingReferencePacket = null,
) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 CriticAgent_A。请像总编审稿一样，评估最终锁定大纲包是否已经具备持续写作能力。重点检查：主线闭环、阶段与章节可执行性、人物弧光可追踪性、世界约束是否支撑写作、是否真正服务项目题材。只输出 JSON，不要解释。",
    input: [
      projectSummary(project),
      `初版大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      `最终锁定大纲：\n${outlineMarkdown}`,
      `结构规划：\n${createExcerpt(structureData.structureMarkdown, 3600)}`,
      `人物摘要：\n${characters.map((character) => `- ${character.name}｜${character.role}｜欲望：${character.desire}｜伤口：${character.wound}`).join("\n")}`,
      `世界观摘要：\n${createExcerpt(worldbuildingMarkdown, 2200)}`,
      openingReferencePromptBlock(openingReferencePacket),
      "评审要求：",
      "1. 不要做形式主义检查，要判断这套资料是否真的足够指导长篇写作。",
      "2. issues 必须是可执行的修补建议。",
      "3. checks 至少给 4 项，且要覆盖结构、人物、世界观、题材兑现。",
      `请输出 JSON：
{
  "passed": true,
  "score": 0,
  "summary": "一句总体判断",
  "issues": ["需要修订的问题1"],
  "checks": [
    {"name": "结构可执行性", "passed": true, "detail": "说明"},
    {"name": "人物弧光", "passed": true, "detail": "说明"},
    {"name": "世界约束", "passed": true, "detail": "说明"},
    {"name": "题材兑现", "passed": true, "detail": "说明"}
  ]
}`,
    ].join("\n\n"),
    useReviewModel: true,
  });

  return normalizeRubricCriticResult(parseJsonResult(result, "CriticAgent_A"), "CriticAgent_A");
}

async function critiqueFinalPlanBViaProvider(provider, project, outlineDraft, outlineMarkdown, structureData, openingReferencePacket = null) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 CriticAgent_B。请采用逆向重建法评估最终锁定大纲包：根据最终大纲与结构规划，重建这本书的主角目标、题材承诺、规模升级路径，再与项目原始要求比较，判断是否偏轴。只输出 JSON，不要解释。",
    input: [
      projectSummary(project),
      `初版大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      `最终锁定大纲：\n${outlineMarkdown}`,
      `结构规划：\n${createExcerpt(structureData.structureMarkdown, 3200)}`,
      openingReferencePromptBlock(openingReferencePacket),
      "评审要求：",
      "1. reconstructedHook 要写出你从最终包中逆向读出的作品核心承诺。",
      "2. reconstructedSummary 要概括规模如何层层升级。",
      "3. issues 要明确指出最终包如果偏离项目，偏离点在哪里。",
      `请输出 JSON：
{
  "passed": true,
  "score": 0,
  "summary": "一句总体判断",
  "reconstructedHook": "逆向重建的一句话核心梗",
  "reconstructedSummary": "逆向重建的规模升级路径",
  "issues": ["如果偏轴，这里写修订建议"]
}`,
    ].join("\n\n"),
    useReviewModel: true,
  });

  return normalizeReverseCriticResult(parseJsonResult(result, "CriticAgent_B"), "CriticAgent_B");
}

async function generateWorldbuildingViaProvider(provider, project, outlineDraft, structureData, finalNotes) {
  try {
    const result = await provider.generateText({
      instructions:
        "你是 Novelex 的 WorldbuildingAgent。请输出一份适合长篇创作持续调用的世界观设定 Markdown。内容必须贴合项目题材、时代和大纲，不得套用固定类型模板。",
      input: [
        projectSummary(project),
        `大纲草稿：\n${outlineDraft.outlineMarkdown}`,
        `结构摘要：\n${createExcerpt(structureData.structureMarkdown, 3000)}`,
        finalNotes.length ? `人类修订意见：${finalNotes.join("；")}` : "",
        "请至少覆盖：时代/制度/地理与势力、资源与生产结构、战争或冲突规则、日常生活质感、人物行动会受到的真实约束、后续写作禁忌。",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });

    const markdown = String(result.text || "").trim();
    if (!markdown) {
      throw new Error("WorldbuildingAgent 返回了空内容。");
    }
    return markdown;
  } catch (error) {
    throw new Error(`WorldbuildingAgent 失败：${errorMessage(error)}`);
  }
}

async function generateFinalOutlineViaProvider(
  provider,
  project,
  outlineDraft,
  structureData,
  characters,
  finalNotes,
  openingReferencePacket = null,
) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 OutlineAgent。请把现有大纲草稿、结构规划、人物弧光整合成最终锁定大纲 Markdown。它必须能直接指导后续写作，而不是概念说明文。",
    input: [
      projectSummary(project),
      `初版大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      `人物摘要：\n${characters.map((character) => `- ${character.name}｜${character.role}｜欲望：${character.desire || "待补"}｜伤口：${character.wound || "待补"}`).join("\n")}`,
      `阶段摘要：\n${stageSummaryMarkdown(structureData)}`,
      openingReferencePromptBlock(openingReferencePacket),
      finalNotes.length ? `人类修订意见：${finalNotes.join("；")}` : "",
      "请输出 Markdown，并至少包含：一句话核心梗、整体简纲、阶段推进、章节节奏、关键角色弧光、主要势力演化、关键伏笔与回收计划。",
      "不要逐章复述 100 章细节，而要基于阶段摘要提炼出可以指导后续写作的高层结构。",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  const markdown = String(result.text || "").trim();
  if (!markdown) {
    throw new Error("OutlineAgent 在最终大纲阶段返回了空内容。");
  }
  return markdown;
}

async function enrichCharactersViaProvider(
  provider,
  project,
  characters,
  outlineDraft,
  structureData,
  finalNotes,
  cacheContext = null,
) {
  const providerSettings = pickPlanFinalCacheProviderSettings(provider.settings);

  return runWithConcurrency(
    characters,
    CHARACTER_AGENT_CONCURRENCY,
    async (character) => {
      const cacheKey = cacheContext
        ? createPlanFinalCacheKey("character_agent", {
            project,
            character,
            outlineDraft,
            structureData,
            finalNotes,
            provider: providerSettings,
          })
        : null;

      if (cacheContext && cacheKey) {
        const cachedCharacter = await loadPlanFinalCacheValue(
          cacheContext.store,
          `characters/${character.name}.json`,
          cacheKey,
        );
        if (cachedCharacter) {
          return cachedCharacter;
        }
      }

      try {
        const result = await provider.generateText({
          instructions:
            "你是 Novelex 的 CharacterAgent。请为给定角色生成可直接写入项目文档的人物资料。只输出 JSON，不要解释。",
          input: [
            projectSummary(project),
            `角色名：${character.name}`,
            `角色定位：${character.role}`,
            `角色基础标签：${character.tags?.join(" / ") || ""}`,
            `角色欲望：${character.desire || ""}`,
            `角色伤口：${character.wound || ""}`,
            `角色盲点：${character.blindspot || ""}`,
            `角色标志物：${character.signatureItem || ""}`,
            `大纲草稿：\n${outlineDraft.outlineMarkdown}`,
            `结构摘要：\n${createExcerpt(structureData.structureMarkdown, 2400)}`,
            finalNotes.length ? `人类修订意见：${finalNotes.join("；")}` : "",
            `请输出 JSON：
{
  "biographyMarkdown": "# ...",
  "profileMarkdown": "# ...",
  "storylineMarkdown": "# ...",
  "state": {
    "name": "${character.name}",
    "updated_after_chapter": "ch000",
    "physical": {
      "location": "初始位置",
      "health": "当前身体状态",
      "appearance_notes": "外观备注"
    },
    "psychological": {
      "current_goal": "当前目标",
      "emotional_state": "当前情绪",
      "stress_level": 4,
      "key_beliefs": ["信念1", "信念2"]
    },
    "relationships": {},
    "knowledge": {
      "knows": ["当前已知信息"],
      "does_not_know": ["当前未知信息"]
    },
    "inventory_and_resources": {
      "money": "资源水平",
      "key_items": ["关键物品"]
    },
    "arc_progress": {
      "current_phase": "弧光阶段",
      "arc_note": "阶段备注"
    }
  }
}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        });

        const parsed = parseJsonResult(result, `CharacterAgent(${character.name})`);

        const enrichedCharacter = {
          ...character,
          biographyMarkdown: String(parsed.biographyMarkdown || "").trim(),
          profileMarkdown: String(parsed.profileMarkdown || "").trim(),
          storylineMarkdown: String(parsed.storylineMarkdown || "").trim(),
          state: {
            ...parsed.state,
            name: character.name,
            relationships: character.relationships,
          },
        };

        if (cacheContext && cacheKey) {
          await stagePlanFinalCacheValue(
            cacheContext.store,
            `characters/${character.name}.json`,
            cacheKey,
            enrichedCharacter,
          );
        }

        return enrichedCharacter;
      } catch (error) {
        throw new Error(`CharacterAgent(${character.name}) 失败：${errorMessage(error)}`);
      }
    },
  );
}

async function generateForeshadowingRegistryViaProvider(provider, project, outlineDraft, cast, finalNotes) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 ForeshadowingPlannerAgent。请围绕当前项目的大纲与角色设计 3 到 8 条长期伏笔。伏笔必须服务主线、势力变化、人物弧光或关键资源争夺。只输出 JSON，不要解释。",
    input: [
      projectSummary(project),
      `角色规划：\n${castSummary(cast)}`,
      `大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      finalNotes.length ? `人类修订意见：${finalNotes.join("；")}` : "",
      `请输出 JSON：
{
  "foreshadowings": [
    {
      "id": "fsh_001",
      "description": "伏笔说明",
      "plantAt": 1,
      "waterAt": [3, 8],
      "payoffAt": 12,
      "tags": ["主线", "势力", "角色名"]
    }
  ]
}`,
    ].join("\n\n"),
  });

  const parsed = parseJsonResult(result, "ForeshadowingPlannerAgent");
  return buildForeshadowingRegistry(parsed, project.totalChapters);
}

async function generateStageBlueprintViaProvider(
  provider,
  project,
  outlineDraft,
  cast,
  foreshadowingRegistry,
  finalNotes,
  stageSpec,
  openingReferencePacket = null,
  retryNotes = [],
) {
  const stageForeshadowings = foreshadowingRegistry.foreshadowings.filter((item) =>
    foreshadowingTouchesStage(item, stageSpec),
  );

  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 StructureAgent。你这次只负责生成一个阶段的阶段蓝图，不生成逐章章纲。请让这一阶段天然体现题材承诺、主角目标和规模升级。只输出 JSON，不要解释。",
    input: [
      projectSummary(project),
      `角色规划：\n${castSummary(cast)}`,
      `主要角色名单（cast）：${castNameList(cast)}`,
      `全书大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      openingReferencePromptBlock(openingReferencePacket),
      `当前负责阶段：第 ${stageSpec.stageNumber} 阶段`,
      `本阶段标签建议：${stageSpec.label}`,
      `本阶段主任务：${stageSpec.focus}`,
      `本阶段负责章节：${stageSpec.chapterStart}-${stageSpec.chapterEnd}（共 ${stageSpec.chapterCount} 章）`,
      `本阶段相关伏笔：\n${stageForeshadowings.length ? stageForeshadowings.map((item) => `- ${item.id}｜plant:${item.planned_plant_chapter}｜payoff:${item.intended_payoff}｜${item.description}`).join("\n") : "暂无硬性伏笔任务"}`,
      finalNotes.length ? `人类修订意见：${finalNotes.join("；")}` : "",
      retryNotes.length ? `结构修订意见：\n- ${retryNotes.join("\n- ")}` : "",
      "要求：",
      "1. 只生成当前阶段的 1 个 stage 对象，不要生成 chapters。",
      "2. 阶段标签要清晰，便于后续逐章调用复用。",
      "3. 阶段目标和冲突要具体，能直接指导后续批量生成章纲。",
      "4. cast 中列出的角色都是主要角色；你可以预留次要角色或群体的出场空间，但不能把新角色设计成新的主角色或 POV 承担者。",
      "5. 阶段蓝图要体现清晰的开局任务、中段爆点和阶段收束方向，而不是泛泛说明。",
      `请输出 JSON：
{
  "stage": {
    "label": "阶段${stageSpec.stageNumber}·...",
    "purpose": "阶段目的",
    "stageGoal": "阶段必须完成的推进",
    "stageConflicts": ["冲突1", "冲突2"]
  }
}`,
    ].join("\n\n"),
  });

  const parsed = parseJsonResult(result, `StructureAgent(stage_blueprint_${stageSpec.stageNumber})`);
  if (!parsed.stage || typeof parsed.stage !== "object") {
    throw new Error(
      `StructureAgent 第 ${stageSpec.stageNumber} 阶段没有返回有效的 stage 对象。`,
    );
  }

  return {
    ...(parsed.stage || {}),
    label: String(parsed?.stage?.label || stageSpec.label).trim() || stageSpec.label,
  };
}

async function generateStructureBatchViaProvider(
  provider,
  project,
  outlineDraft,
  cast,
  finalNotes,
  stageSpec,
  stageBlueprint,
  foreshadowingRegistry,
  batchSpec,
  retryNotes = [],
) {
  const batchForeshadowings = foreshadowingRegistry.foreshadowings.filter((item) =>
    foreshadowingTouchesRange(item, batchSpec.chapterStart, batchSpec.chapterEnd),
  );

  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 StructureAgent。你这次只负责一个阶段中的一小段章节章纲，不负责整本书。请严格按指定章节范围输出详细 JSON。只输出 JSON，不要解释。",
    input: [
      projectSummary(project),
      `角色规划：\n${castSummary(cast)}`,
      `主要角色名单（cast）：${castNameList(cast)}`,
      `全书大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      `当前阶段：第 ${stageSpec.stageNumber} 阶段`,
      `阶段标签：${stageBlueprint.label}`,
      `阶段目的：${stageBlueprint.purpose || stageSpec.focus}`,
      `阶段目标：${stageBlueprint.stageGoal || stageSpec.focus}`,
      `阶段冲突：${(stageBlueprint.stageConflicts || []).join("；") || "请围绕主线冲突展开"}`,
      `当前批次负责章节：${batchSpec.chapterStart}-${batchSpec.chapterEnd}（共 ${batchSpec.chapterCount} 章）`,
      `本批次相关伏笔：\n${batchForeshadowings.length ? batchForeshadowings.map((item) => `- ${item.id}｜plant:${item.planned_plant_chapter}｜payoff:${item.intended_payoff}｜${item.description}`).join("\n") : "暂无硬性伏笔任务"}`,
      finalNotes.length ? `人类修订意见：${finalNotes.join("；")}` : "",
      retryNotes.length ? `结构修订意见：\n- ${retryNotes.join("\n- ")}` : "",
      "要求：",
      "1. 只能输出当前批次的章节，不能多也不能少。",
      "2. chapterNumber 必须严格连续，且全部落在指定范围内。",
      "3. 每章都要给出 POV、地点、关键事件、弧光贡献、章末钩子、连续性锚点和场景列表。",
      "4. chapter.stage 必须与给定阶段标签完全一致。",
      "5. 场景与事件要具体，不要写空泛占位词。",
      `6. chapter.povCharacter 必须从主要角色名单中选择：${castNameList(cast)}。`,
      "7. 允许引入不在 cast 中的次要角色，但这些角色只能作为场景配角或临时功能角色，不能承担 POV、主线弧光或阶段目标的核心推进。",
      "8. arcContribution、关键事件和章末钩子必须围绕主要角色展开；次要角色只负责辅助、阻碍、传话、交易、冲突触发等局部功能。",
      "9. 每章必须体现不同于前后章的推进功能，不能只换地名或数字。",
      "10. 一个批次内不要高频复用同一种章末钩子句式。",
      `请输出 JSON：
{
  "chapters": [
    {
      "chapterNumber": ${batchSpec.chapterStart},
      "title": "章节标题",
      "stage": "${stageBlueprint.label}",
      "timeInStory": "故事时间",
      "povCharacter": "角色名",
      "location": "地点",
      "keyEvents": ["事件1", "事件2"],
      "arcContribution": ["弧光推进"],
      "nextHook": "章末钩子",
      "emotionalTone": "情绪基调",
      "charactersPresent": ["角色A", "角色B"],
      "continuityAnchors": ["细节锚点1", "细节锚点2"],
      "scenes": [
        {
          "label": "场景1",
          "location": "地点",
          "focus": "场景任务",
          "tension": "冲突张力",
          "characters": ["角色A", "角色B"]
        }
      ]
    }
  ]
}`,
    ].join("\n\n"),
  });

  const parsed = parseJsonResult(result, `StructureAgent(batch_${batchSpec.batchId})`);
  const chapters = Array.isArray(parsed.chapters) ? parsed.chapters : [];
  if (chapters.length !== batchSpec.chapterCount) {
    throw new Error(
      `StructureAgent 批次 ${batchSpec.chapterStart}-${batchSpec.chapterEnd} 返回了 ${chapters.length} 章，但预期 ${batchSpec.chapterCount} 章。`,
    );
  }

  const chapterNumbers = chapters
    .map((chapter) => Number(chapter?.chapterNumber || 0))
    .sort((left, right) => left - right);
  const expectedNumbers = Array.from({ length: batchSpec.chapterCount }, (_, index) => batchSpec.chapterStart + index);
  if (JSON.stringify(chapterNumbers) !== JSON.stringify(expectedNumbers)) {
    throw new Error(
      `StructureAgent 批次 ${batchSpec.chapterStart}-${batchSpec.chapterEnd} 返回的 chapterNumber 不连续或越界。`,
    );
  }

  return chapters.map((chapter) => ({
    ...chapter,
    stage: stageBlueprint.label,
  }));
}

async function critiqueStructureOutputViaProvider(
  provider,
  project,
  outlineDraft,
  cast,
  finalNotes,
  stageSpec,
  stageBlueprint,
  chapters = [],
  openingReferencePacket = null,
) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 StructureCriticAgent。请评估当前 StructureAgent 输出是否存在模板化、题材偏离、推进失真、钩子重复、场景空泛、角色驱动不足等问题。优先抓可执行的结构问题。只输出 JSON，不要解释。",
    input: [
      projectSummary(project),
      `角色规划：\n${castSummary(cast)}`,
      `全书大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      openingReferencePromptBlock(openingReferencePacket),
      `当前阶段：第 ${stageSpec.stageNumber} 阶段｜章节 ${stageSpec.chapterStart}-${stageSpec.chapterEnd}`,
      `阶段蓝图：${JSON.stringify(stageBlueprint, null, 2)}`,
      chapters.length ? `待审章节批次：\n${JSON.stringify(chapters, null, 2)}` : "待审对象：阶段蓝图",
      finalNotes.length ? `人类修订意见：${finalNotes.join("；")}` : "",
      `请输出 JSON：
{
  "passed": true,
  "retryRecommended": false,
  "summary": "一句总体判断",
  "issues": ["可执行问题1", "可执行问题2"],
  "checks": [
    {"name": "题材兑现", "passed": true, "detail": "说明"},
    {"name": "推进差异度", "passed": true, "detail": "说明"},
    {"name": "钩子多样性", "passed": true, "detail": "说明"},
    {"name": "角色驱动", "passed": true, "detail": "说明"}
  ]
}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    useReviewModel: true,
  });

  return normalizeStructureCriticResult(
    parseJsonResult(result, "StructureCriticAgent"),
    [],
  );
}

async function deriveChapterSlotsViaProvider(
  provider,
  project,
  outlineDraft,
  structureData,
  foreshadowingRegistry,
) {
  return generateStructuredObject(provider, {
    label: "ChapterSlotDeriverAgent",
    instructions:
      "你是 Novelex 的 ChapterSlotDeriverAgent。请基于锁定大纲、结构规划与伏笔注册表，为每一章生成 Writer 可用的 chapter slot。不要使用固定模板句，必须让每章 mission、carryover、escalation 和禁止重演点与实际结构一致。只输出 JSON。",
    input: [
      projectSummary(project),
      `锁定大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      `结构规划：\n${JSON.stringify(structureData, null, 2)}`,
      `伏笔注册表：\n${JSON.stringify(foreshadowingRegistry, null, 2)}`,
      `请输出 JSON：\n{\n  "chapterSlots": [\n    {\n      "chapterId": "ch001",\n      "chapterNumber": 1,\n      "stage": "阶段1",\n      "titleHint": "标题提示",\n      "mission": "本章任务",\n      "locationSeed": "地点种子",\n      "expectedCarryover": "本章应承接什么",\n      "expectedEscalation": "本章应如何升级",\n      "nextHookSeed": "下一章牵引",\n      "forbidReplayBeats": ["不要重演的 beat"],\n      "foreshadowingIds": ["fsh_001"],\n      "freshStart": true,\n      "stageSeed": "阶段种子"\n    }\n  ]\n}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "chapter_slots",
    },
    normalize(parsed) {
      return (Array.isArray(parsed.chapterSlots) ? parsed.chapterSlots : [])
        .map((slot) => ({
          chapterId: String(slot?.chapterId || "").trim(),
          chapterNumber: Math.max(1, Math.round(Number(slot?.chapterNumber) || 0)),
          stage: String(slot?.stage || "").trim(),
          titleHint: String(slot?.titleHint || "").trim(),
          mission: String(slot?.mission || "").trim(),
          locationSeed: String(slot?.locationSeed || "").trim(),
          expectedCarryover: String(slot?.expectedCarryover || "").trim(),
          expectedEscalation: String(slot?.expectedEscalation || "").trim(),
          nextHookSeed: String(slot?.nextHookSeed || "").trim(),
          forbidReplayBeats: normalizeStringList(slot?.forbidReplayBeats, 8),
          foreshadowingIds: normalizeStringList(slot?.foreshadowingIds, 8),
          freshStart: Boolean(slot?.freshStart),
          stageSeed: String(slot?.stageSeed || "").trim(),
        }))
        .filter((slot) => slot.chapterId && slot.chapterNumber);
    },
  });
}

async function deriveInitialWorldStateViaProvider(
  provider,
  project,
  outlineDraft,
  structureData,
) {
  return generateStructuredObject(provider, {
    label: "InitialWorldStateDeriverAgent",
    instructions:
      "你是 Novelex 的 InitialWorldStateDeriverAgent。请基于项目设定、锁定大纲与结构规划，生成故事开局时的 world_state。不要用空泛模板，要让 public_knowledge、secret_knowledge、active_plotlines、upcoming_anchors 都与真实结构对应。只输出 JSON。",
    input: [
      projectSummary(project),
      `锁定大纲草稿：\n${outlineDraft.outlineMarkdown}`,
      `结构规划：\n${JSON.stringify(structureData, null, 2)}`,
      `请输出 JSON：\n{\n  "current_story_time": "故事时间",\n  "current_primary_location": "主要地点",\n  "active_plotlines": [],\n  "public_knowledge": [],\n  "secret_knowledge": [],\n  "recent_major_events": [],\n  "upcoming_anchors": []\n}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "initial_world_state",
    },
  });
}

async function generateStructureViaProvider(
  provider,
  project,
  outlineDraft,
  cast,
  foreshadowingRegistry,
  finalNotes,
  openingReferencePacket = null,
  cacheContext = null,
  options = {},
) {
  const allowCriticBypass = Boolean(options.allowCriticBypass);
  const stageSpecs = computeStageSpecs(project, outlineDraft);
  const providerSettings = pickPlanFinalCacheProviderSettings(provider.settings);
  const stageResults = await Promise.all(
    stageSpecs.map(async (stageSpec) => {
      const cacheKey = cacheContext
        ? createPlanFinalCacheKey("structure_stage_blueprint", {
            project,
            outlineDraft,
            cast,
            foreshadowingRegistry,
            finalNotes,
            stageSpec,
            openingReferencePacket,
            provider: providerSettings,
          })
        : null;

      if (cacheContext && cacheKey) {
        const cachedStageBlueprint = await loadPlanFinalCacheValue(
          cacheContext.store,
          `structure/stages/stage_${stageSpec.stageNumber}.json`,
          cacheKey,
        );
        if (cachedStageBlueprint) {
          return {
            stageSpec,
            stageBlueprint: cachedStageBlueprint,
          };
        }
      }

      let retryNotes = [];
      let stageBlueprint = null;
      let unresolvedCriticIssues = [];
      for (let attempt = 0; attempt < STRUCTURE_CRITIC_MAX_ATTEMPTS; attempt += 1) {
        stageBlueprint = await generateStageBlueprintViaProvider(
          provider,
          project,
          outlineDraft,
          cast,
          foreshadowingRegistry,
          finalNotes,
          stageSpec,
          openingReferencePacket,
          retryNotes,
        );
        const critic = await critiqueStructureOutputViaProvider(
          provider,
          project,
          outlineDraft,
          cast,
          finalNotes,
          stageSpec,
          stageBlueprint,
          [],
          openingReferencePacket,
        );
        if (critic.passed) {
          unresolvedCriticIssues = [];
          break;
        }
        unresolvedCriticIssues = uniqueNotes(critic.issues?.length ? critic.issues : [critic.summary]);
        if (attempt < STRUCTURE_CRITIC_MAX_ATTEMPTS - 1 && unresolvedCriticIssues.length) {
          retryNotes = unresolvedCriticIssues;
          continue;
        }
        if (allowCriticBypass && unresolvedCriticIssues.length) {
          break;
        }
        throw new Error(
          `StructureAgent 第 ${stageSpec.stageNumber} 阶段未通过 StructureCriticAgent：${critic.issues.join("；") || critic.summary}`,
        );
      }

      if (cacheContext && cacheKey && !unresolvedCriticIssues.length) {
        await stagePlanFinalCacheValue(
          cacheContext.store,
          `structure/stages/stage_${stageSpec.stageNumber}.json`,
          cacheKey,
          stageBlueprint,
        );
      }

      return {
        stageSpec,
        stageBlueprint,
        unresolvedCriticIssues,
      };
    }),
  );
  const stageBlueprints = stageResults.map((item) => ({
    ...item.stageBlueprint,
    chapterStart: item.stageSpec.chapterStart,
    chapterEnd: item.stageSpec.chapterEnd,
    range: [item.stageSpec.chapterStart, item.stageSpec.chapterEnd],
  }));

  const merged = {
    stages: stageBlueprints,
    chapters: [],
  };

  return {
    ...buildStructure(project, cast, merged, foreshadowingRegistry),
    criticIssues: uniqueNotes(stageResults.flatMap((item) => item.unresolvedCriticIssues || [])),
  };
}

async function applyPreApprovalRevision(
  store,
  provider,
  project,
  draftPayload,
  revisionNotes,
  openingReferencePacket,
  run,
) {
  const notes = uniqueNotes(revisionNotes || []);
  const revisedOutline = await reviseOutlineWithNotesViaProvider(
    provider,
    project,
    draftPayload.cast || [],
    draftPayload.outlineDraft,
    notes,
    openingReferencePacket,
  );
  const revisedCast = await expandCastViaProvider(
    provider,
    project,
    draftPayload.cast || [],
    revisedOutline,
    notes,
  );
  const resolvedProject = projectWithCast(project, revisedCast);
  const criticA = await critiqueOutlineDraftAViaProvider(
    provider,
    resolvedProject,
    revisedCast,
    revisedOutline,
    openingReferencePacket,
  );
  const criticB = await critiqueOutlineDraftBViaProvider(
    provider,
    resolvedProject,
    revisedCast,
    revisedOutline,
    openingReferencePacket,
  );

  const nextDraftPayload = {
    ...draftPayload,
    outlineDraft: revisedOutline,
    outlineMarkdown: revisedOutline.outlineMarkdown,
    cast: revisedCast,
    critics: {
      criticA,
      criticB,
    },
  };

  await store.stagePlanDraft(nextDraftPayload);
  run.steps.push(
    step(
      "preapproval_revision_agent",
      "RevisionAgent",
      "plan",
      "根据预批准 Critic 反馈再次收紧草稿，再整体重建完整 plan 包。",
      { preview: createExcerpt(revisedOutline.outlineMarkdown, 220) },
    ),
    step(
      "preapproval_cast_expansion_agent",
      "CastExpansionAgent",
      "plan",
      "根据预批准修订后的草稿再次同步扩展角色。",
      { preview: castNameList(revisedCast) },
    ),
    step("preapproval_critic_a", "CriticAgent_A", "plan", criticA.summary, { score: criticA.score }),
    step("preapproval_critic_b", "CriticAgent_B", "plan", criticB.summary, { score: criticB.score }),
  );

  return nextDraftPayload;
}

async function buildPreApprovalPlanPackage(
  store,
  projectState,
  provider,
  draftPayload,
  run,
  providerCacheSettings,
  cacheContext,
  options = {},
) {
  const cast = buildCast(projectState.project, draftPayload.cast || []);
  const finalNotes = projectState.phase.plan.rejectionNotes || [];
  let expandedCast = cast;
  let project = projectWithCast(projectState.project, expandedCast);
  const openingReferencePacket = await buildOpeningReferencePacket({
    store,
    provider,
    project,
    mode: "plan_final",
  });

  try {
    const castCacheKey = createPlanFinalCacheKey("cast_expansion_final", {
      project,
      cast,
      outlineDraft: draftPayload.outlineDraft,
      finalNotes,
      provider: providerCacheSettings,
    });
    const cachedExpandedCast = await loadPlanFinalCacheValue(store, "cast.json", castCacheKey);

    if (cachedExpandedCast) {
      expandedCast = cachedExpandedCast;
    } else {
      expandedCast = await expandCastViaProvider(
        provider,
        project,
        cast,
        draftPayload.outlineDraft,
        finalNotes,
      );
      await stagePlanFinalCacheValue(store, "cast.json", castCacheKey, expandedCast);
    }

    project = projectWithCast(projectState.project, expandedCast);
    run.steps.push(
      step(
        "cast_expansion_agent_final",
        "CastExpansionAgent",
        "plan",
        expandedCast.length > cast.length
          ? `根据锁定前大纲再新增 ${expandedCast.length - cast.length} 名扩展角色，确保结构阶段可合法引用。`
          : "最终大纲阶段未发现需要补录的新长期角色。",
        {
          preview:
            expandedCast.length > cast.length
              ? expandedCast
                .slice(cast.length)
                .map((character) => `${character.name}(${character.role})`)
                .join(" / ")
              : castNameList(expandedCast),
        },
      ),
      step(
        "opening_reference_packet",
        "OpeningPatternSynthesizerAgent",
        "plan",
        openingReferencePacket.triggered
          ? "已为最终大纲阶段注入黄金三章结构参考。"
          : "当前未绑定黄金三章参考库，跳过开头结构学习。",
        { preview: createExcerpt(openingReferencePacket.summary || "", 180) },
      ),
    );

    if (expandedCast.length > cast.length) {
      await store.stagePlanDraft({
        ...draftPayload,
        cast: expandedCast,
      });
    }
  } catch (error) {
    await saveFailedRun(store, run, {
      id: "cast_expansion_agent_final",
      label: "CastExpansionAgent",
    }, error);
    throw error;
  }

  let foreshadowingRegistry;
  try {
    const foreshadowingCacheKey = createPlanFinalCacheKey("foreshadowing_registry", {
      project,
      outlineDraft: draftPayload.outlineDraft,
      cast: expandedCast,
      finalNotes,
      provider: providerCacheSettings,
    });
    const cachedForeshadowingRegistry = await loadPlanFinalCacheValue(
      store,
      "foreshadowing_registry.json",
      foreshadowingCacheKey,
    );

    if (cachedForeshadowingRegistry) {
      foreshadowingRegistry = cachedForeshadowingRegistry;
    } else {
      foreshadowingRegistry = await generateForeshadowingRegistryViaProvider(
        provider,
        project,
        draftPayload.outlineDraft,
        expandedCast,
        finalNotes,
      );
      await stagePlanFinalCacheValue(
        store,
        "foreshadowing_registry.json",
        foreshadowingCacheKey,
        foreshadowingRegistry,
      );
    }

    run.steps.push(
      step(
        "foreshadowing_planner_agent",
        "ForeshadowingPlannerAgent",
        "plan",
        `规划 ${foreshadowingRegistry.foreshadowings.length} 条长期伏笔。`,
        {
          preview: foreshadowingRegistry.foreshadowings
            .slice(0, 4)
            .map((item) => `${item.id}:${item.description}`)
            .join(" / "),
        },
      ),
    );
  } catch (error) {
    await saveFailedRun(store, run, {
      id: "foreshadowing_planner_agent",
      label: "ForeshadowingPlannerAgent",
    }, error);
    throw error;
  }

  let structureData;
  try {
      structureData = await generateStructureViaProvider(
        provider,
        project,
        draftPayload.outlineDraft,
      expandedCast,
      foreshadowingRegistry,
        finalNotes,
        openingReferencePacket,
        cacheContext,
        options,
      );
    run.steps.push(
      step(
        "structure_agent",
        "StructureAgent",
        "plan",
        `完成 ${structureData.stages.length} 个阶段的结构规划，章节级细纲改为 Write 阶段生成。`,
        { preview: createExcerpt(structureData.structureMarkdown, 240) },
      ),
    );
  } catch (error) {
    const message = errorMessage(error);
    const stageMatch = message.match(/StructureAgent 第 (\d+) 阶段/);
    await saveFailedRun(
      store,
      run,
      stageMatch
        ? {
            id: `structure_agent_stage_${stageMatch[1]}`,
            label: `StructureAgent Stage ${stageMatch[1]}`,
            extra: { stageNumber: Number(stageMatch[1]) },
          }
        : {
            id: "structure_agent",
            label: "StructureAgent",
          },
      error,
    );
    throw error;
  }

  let characters;
  let worldbuildingMarkdown;
  try {
    const worldbuildingCacheKey = createPlanFinalCacheKey("worldbuilding", {
      project,
      outlineDraft: draftPayload.outlineDraft,
      structureData,
      finalNotes,
      provider: providerCacheSettings,
    });
    const cachedWorldbuildingMarkdown = await loadPlanFinalCacheValue(
      store,
      "worldbuilding.json",
      worldbuildingCacheKey,
    );

    [characters, worldbuildingMarkdown] = await Promise.all([
      enrichCharactersViaProvider(
        provider,
        project,
        expandedCast,
        draftPayload.outlineDraft,
        structureData,
        finalNotes,
        cacheContext,
      ),
      cachedWorldbuildingMarkdown
        ? Promise.resolve(cachedWorldbuildingMarkdown)
        : generateWorldbuildingViaProvider(
            provider,
            project,
            draftPayload.outlineDraft,
            structureData,
            finalNotes,
          ).then(async (markdown) => {
            await stagePlanFinalCacheValue(
              store,
              "worldbuilding.json",
              worldbuildingCacheKey,
              markdown,
            );
            return markdown;
          }),
    ]);
    run.steps.push(
      step(
        "worldbuilding_agent",
        "WorldbuildingAgent",
        "plan",
        "生成世界观设定文档。",
        { preview: createExcerpt(worldbuildingMarkdown, 200) },
      ),
      step(
        "character_agent",
        "CharacterAgent",
        "plan",
        `生成人物小传、资料卡、人物线与初始状态，共 ${characters.length} 名主要角色。`,
        { preview: characters.map((character) => character.name).join(" / ") },
      ),
    );
  } catch (error) {
    const message = errorMessage(error);
    const characterMatch = message.match(/CharacterAgent\((.+?)\)/);
    await saveFailedRun(
      store,
      run,
      characterMatch
        ? {
            id: `character_agent_${characterMatch[1]}`,
            label: `CharacterAgent(${characterMatch[1]})`,
            extra: { characterName: characterMatch[1] },
          }
        : {
            id: /WorldbuildingAgent/.test(message) ? "worldbuilding_agent" : "character_or_worldbuilding_agent",
            label: /WorldbuildingAgent/.test(message) ? "WorldbuildingAgent" : "CharacterAgent / WorldbuildingAgent",
          },
      error,
    );
    throw error;
  }

  const chapterSlots = await deriveChapterSlotsViaProvider(
    provider,
    project,
    draftPayload.outlineDraft,
    structureData,
    foreshadowingRegistry,
  );
  const outlineData = buildOutlineData(project, draftPayload.outlineDraft, structureData, characters, chapterSlots);
  let outlineMarkdown;
  try {
    const outlineCacheKey = createPlanFinalCacheKey("outline_final", {
      project,
      outlineDraft: draftPayload.outlineDraft,
      structureData,
      characters,
      finalNotes,
      openingReferencePacket,
      provider: providerCacheSettings,
    });
    const cachedOutlineMarkdown = await loadPlanFinalCacheValue(
      store,
      "outline.json",
      outlineCacheKey,
    );

    if (cachedOutlineMarkdown) {
      outlineMarkdown = cachedOutlineMarkdown;
    } else {
      outlineMarkdown = await generateFinalOutlineViaProvider(
        provider,
        project,
        draftPayload.outlineDraft,
        structureData,
        characters,
        finalNotes,
        openingReferencePacket,
      );
      await stagePlanFinalCacheValue(store, "outline.json", outlineCacheKey, outlineMarkdown);
    }

    run.steps.push(
      step(
        "outline_agent_final",
        "OutlineAgent",
        "plan",
        "整合阶段摘要和人物弧光，生成最终锁定大纲。",
        { preview: createExcerpt(outlineMarkdown, 220) },
      ),
    );
  } catch (error) {
    await saveFailedRun(store, run, {
      id: "outline_agent_final",
      label: "OutlineAgent",
    }, error);
    throw error;
  }

  const worldState = await deriveInitialWorldStateViaProvider(
    provider,
    project,
    draftPayload.outlineDraft,
    structureData,
  );

  return {
    project,
    expandedCast,
    openingReferencePacket,
    chapterSlots,
    outlineData,
    outlineMarkdown,
    worldbuildingMarkdown,
    structureData,
    worldState,
    foreshadowingRegistry,
    characters,
  };
}

async function runPreApprovalCritics(
  store,
  provider,
  draftPayload,
  packageResult,
  run,
  providerCacheSettings,
) {
  const {
    project,
    outlineMarkdown,
    structureData,
    characters,
    worldbuildingMarkdown,
    openingReferencePacket,
  } = packageResult;

  try {
    const criticACacheKey = createPlanFinalCacheKey("critic_final_a", {
      project,
      outlineDraft: draftPayload.outlineDraft,
      outlineMarkdown,
      structureData,
      characters,
      worldbuildingMarkdown,
      openingReferencePacket,
      provider: providerCacheSettings,
    });
    const criticBCacheKey = createPlanFinalCacheKey("critic_final_b", {
      project,
      outlineDraft: draftPayload.outlineDraft,
      outlineMarkdown,
      structureData,
      openingReferencePacket,
      provider: providerCacheSettings,
    });
    const cachedCriticA = await loadPlanFinalCacheValue(store, "critics/critic_a.json", criticACacheKey);
    const cachedCriticB = await loadPlanFinalCacheValue(store, "critics/critic_b.json", criticBCacheKey);

    const [criticA, criticB] = await Promise.all([
      cachedCriticA
        ? Promise.resolve(cachedCriticA)
        : critiqueFinalPlanAViaProvider(
            provider,
            project,
            draftPayload.outlineDraft,
            outlineMarkdown,
            structureData,
            characters,
            worldbuildingMarkdown,
            openingReferencePacket,
          ).then(async (result) => {
            await stagePlanFinalCacheValue(store, "critics/critic_a.json", criticACacheKey, result);
            return result;
          }),
      cachedCriticB
        ? Promise.resolve(cachedCriticB)
        : critiqueFinalPlanBViaProvider(
            provider,
            project,
            draftPayload.outlineDraft,
            outlineMarkdown,
            structureData,
            openingReferencePacket,
          ).then(async (result) => {
            await stagePlanFinalCacheValue(store, "critics/critic_b.json", criticBCacheKey, result);
            return result;
          }),
    ]);
    run.steps.push(
      step("critic_a_final", "CriticAgent_A", "plan", criticA.summary),
      step("critic_b_final", "CriticAgent_B", "plan", criticB.summary, { score: criticB.score }),
    );

    const issues = uniqueNotes([
      ...(criticA.passed ? [] : criticA.issues || []),
      ...(criticB.passed ? [] : criticB.issues || []),
    ]);

    return {
      criticA,
      criticB,
      passed: criticA.passed && criticB.passed,
      issues,
    };
  } catch (error) {
    const message = errorMessage(error);
    await saveFailedRun(store, run, {
      id: /CriticAgent_B/.test(message) ? "critic_b_final" : "critic_a_final",
      label: /CriticAgent_B/.test(message) ? "CriticAgent_B" : "CriticAgent_A",
    }, error);
    throw error;
  }
}

async function completePreApprovalPlanRun(store, projectState, provider, run, initialDraftPayload) {
  const providerCacheSettings = pickPlanFinalCacheProviderSettings(provider.settings);
  const cacheContext = { store };
  let draftPayload = initialDraftPayload;
  let packageResult = null;
  let preApprovalCritics = null;

  for (let attempt = 0; attempt < PRE_APPROVAL_MAX_ATTEMPTS; attempt += 1) {
    await store.stagePlanDraft(draftPayload);

    try {
      packageResult = await buildPreApprovalPlanPackage(
        store,
        projectState,
        provider,
        draftPayload,
        run,
        providerCacheSettings,
        cacheContext,
        {
          allowCriticBypass: attempt === PRE_APPROVAL_MAX_ATTEMPTS - 1,
        },
      );
    } catch (error) {
      if (attempt < PRE_APPROVAL_MAX_ATTEMPTS - 1 && isStructureCriticFailureMessage(errorMessage(error))) {
        draftPayload = await applyPreApprovalRevision(
          store,
          provider,
          projectState.project,
          draftPayload,
          extractStructureCriticIssues(error),
          null,
          run,
        );
        continue;
      }
      throw error;
    }

    preApprovalCritics = await runPreApprovalCritics(
      store,
      provider,
      draftPayload,
      packageResult,
      run,
      providerCacheSettings,
    );
    const structureCriticIssues = uniqueNotes(packageResult.structureData?.criticIssues || []);
    preApprovalCritics = {
      ...preApprovalCritics,
      issues: uniqueNotes([
        ...structureCriticIssues,
        ...(preApprovalCritics.issues || []),
      ]),
      structureIssues: structureCriticIssues,
      passed: preApprovalCritics.passed && !structureCriticIssues.length,
      autoRevisionExhausted: false,
      attemptCount: attempt + 1,
    };

    if (preApprovalCritics.passed) {
      break;
    }

    if (attempt < PRE_APPROVAL_MAX_ATTEMPTS - 1 && preApprovalCritics.issues.length) {
      draftPayload = await applyPreApprovalRevision(
        store,
        provider,
        projectState.project,
        draftPayload,
        preApprovalCritics.issues,
        packageResult.openingReferencePacket,
        run,
      );
      continue;
    }

    preApprovalCritics = {
      ...preApprovalCritics,
      autoRevisionExhausted: true,
    };
    run.steps.push(
      step(
        "preapproval_handoff",
        "PreApprovalCritics",
        "plan",
        `自动预审已执行 ${attempt + 1} 轮，仍有未解决问题，转交人工终审。`,
        { issues: preApprovalCritics.issues },
      ),
    );
    break;
  }

  await store.stagePlanDraft({
    ...draftPayload,
    preApprovalCritics,
  });

  try {
    await store.stagePlanFinal({
      outlineMarkdown: packageResult.outlineMarkdown,
      outlineData: packageResult.outlineData,
      worldbuildingMarkdown: packageResult.worldbuildingMarkdown,
      structureMarkdown: packageResult.structureData.structureMarkdown,
      structureData: packageResult.structureData,
      chapterSlots: packageResult.chapterSlots,
      characters: packageResult.characters,
      worldState: packageResult.worldState,
      foreshadowingRegistry: packageResult.foreshadowingRegistry,
    });
  } catch (error) {
    await saveFailedRun(store, run, {
      id: "stage_plan_final",
      label: "PlanFinalStaging",
    }, error);
    throw error;
  }

  projectState.project = packageResult.project;
  projectState.phase.plan = {
    ...projectState.phase.plan,
    status: PLAN_STATUS.FINAL_PENDING_REVIEW,
    lastRunId: run.id,
    pendingReview: {
      target: REVIEW_TARGETS.PLAN_FINAL,
      requestedAt: nowIso(),
      runId: run.id,
    },
  };

  run.finishedAt = nowIso();
  run.status = "completed";
  run.summary = preApprovalCritics?.passed
    ? "完整大纲、设定与人物资料已生成，等待单次终审锁定。"
    : `完整 plan 包已生成；自动预审执行 ${preApprovalCritics?.attemptCount || PRE_APPROVAL_MAX_ATTEMPTS} 轮后仍有残留问题，等待人工终审决定锁定或继续修改。`;
  return saveProjectAndRun(store, projectState, run);
}

export async function runPlanDraft(store) {
  const projectState = await store.loadProject();
  const project = projectState.project;
  const provider = createProvider(projectState, { rootDir: store.paths.configRootDir });
  const existingDraftPayload = await store.loadPlanDraft();
  const run = {
    id: runId("plan"),
    phase: "plan",
    startedAt: nowIso(),
    target: REVIEW_TARGETS.PLAN_FINAL,
    steps: [],
  };
  const canReuseStagedDraft = Boolean(
    existingDraftPayload?.outlineDraft &&
    !(projectState.phase.plan.rejectionNotes || []).length &&
    (
      projectState.phase.plan.status === PLAN_STATUS.IDLE ||
      projectState.phase.plan.status === PLAN_STATUS.FINAL_REJECTED
    ),
  );

  if (canReuseStagedDraft) {
    run.steps.push(
      step(
        "plan_draft_reuse",
        "PlanDraftReuseAgent",
        "plan",
        "复用最近一次已生成的大纲草稿，直接重建完整 plan 包。",
        { preview: createExcerpt(existingDraftPayload.outlineMarkdown || "", 220) },
      ),
    );
    return completePreApprovalPlanRun(store, projectState, provider, run, existingDraftPayload);
  }

  const cast = await generateCastViaProvider(
    provider,
    project,
    projectState.phase.plan.rejectionNotes || [],
  );
  const resolvedProject = projectWithCast(project, cast);
  const openingReferencePacket = await buildOpeningReferencePacket({
    store,
    provider,
    project: resolvedProject,
    mode: "plan_draft",
  });
  let outlineDraft = await generateOutlineViaProvider(
    provider,
    resolvedProject,
    cast,
    projectState.phase.plan.rejectionNotes || [],
    openingReferencePacket,
  );
  let expandedCast = await expandCastViaProvider(
    provider,
    resolvedProject,
    cast,
    outlineDraft,
    projectState.phase.plan.rejectionNotes || [],
  );
  run.steps.push(
    step(
      "character_planning_agent",
      "CharacterPlanningAgent",
      "plan",
      `使用 ${provider.settings.responseModel} 自动规划主要人物与命名。`,
      {
        preview: cast
          .map(
            (character) =>
              `${character.name}(${character.role}${character.historicalStatus === "real" ? "·史实" : ""})`,
          )
          .join(" / "),
      },
    ),
    step(
      "outline_agent",
      "OutlineAgent",
      "plan",
      `使用 ${provider.settings.responseModel} 生成一句话核心梗、简纲和粗纲草稿。`,
      { preview: createExcerpt(outlineDraft.outlineMarkdown, 220) },
    ),
    step(
      "opening_reference_packet",
      "OpeningPatternSynthesizerAgent",
      "plan",
      openingReferencePacket.triggered
        ? "已为大纲阶段注入黄金三章结构参考。"
        : "当前未绑定黄金三章参考库，跳过开头结构学习。",
      { preview: createExcerpt(openingReferencePacket.summary || "", 180) },
    ),
    step(
      "cast_expansion_agent",
      "CastExpansionAgent",
      "plan",
      expandedCast.length > cast.length
        ? `根据大纲新增 ${expandedCast.length - cast.length} 名扩展角色，补齐正式 cast。`
        : "大纲未引入额外长期角色，沿用当前 cast。",
      {
        preview:
          expandedCast.length > cast.length
            ? expandedCast.slice(cast.length).map((character) => `${character.name}(${character.role})`).join(" / ")
            : castNameList(expandedCast),
      },
    ),
  );

  let criticA = await critiqueOutlineDraftAViaProvider(provider, resolvedProject, expandedCast, outlineDraft, openingReferencePacket);
  let criticB = await critiqueOutlineDraftBViaProvider(provider, resolvedProject, expandedCast, outlineDraft, openingReferencePacket);
  run.steps.push(
    step("critic_a", "CriticAgent_A", "plan", criticA.summary, { score: criticA.score }),
    step("critic_b", "CriticAgent_B", "plan", criticB.summary, { score: criticB.score }),
  );

  if (!criticA.passed || !criticB.passed) {
    outlineDraft = await reviseOutlineViaProvider(
      provider,
      resolvedProject,
      expandedCast,
      outlineDraft,
      criticA,
      criticB,
      projectState.phase.plan.rejectionNotes,
      openingReferencePacket,
    );
    expandedCast = await expandCastViaProvider(
      provider,
      resolvedProject,
      expandedCast,
      outlineDraft,
      projectState.phase.plan.rejectionNotes || [],
    );
    criticA = await critiqueOutlineDraftAViaProvider(provider, resolvedProject, expandedCast, outlineDraft, openingReferencePacket);
    criticB = await critiqueOutlineDraftBViaProvider(provider, resolvedProject, expandedCast, outlineDraft, openingReferencePacket);
    run.steps.push(
      step(
        "revision_agent",
        "RevisionAgent",
        "plan",
        "根据 Critic 反馈收紧核心梗和粗纲的对齐关系。",
        { preview: createExcerpt(outlineDraft.outlineMarkdown, 220) },
      ),
      step(
        "cast_expansion_agent_rerun",
        "CastExpansionAgent",
        "plan",
        "根据修订后的大纲再次同步扩展角色。",
        { preview: castNameList(expandedCast) },
      ),
      step("critic_a_rerun", "CriticAgent_A", "plan", criticA.summary, { score: criticA.score }),
      step("critic_b_rerun", "CriticAgent_B", "plan", criticB.summary, { score: criticB.score }),
    );
  }

  const draftPayload = {
    outlineDraft,
    outlineMarkdown: outlineDraft.outlineMarkdown,
    cast: expandedCast,
    critics: {
      criticA,
      criticB,
    },
  };
  await store.stagePlanDraft(draftPayload);
  return completePreApprovalPlanRun(store, projectState, provider, run, draftPayload);
}

export async function runPlanFinalization(store) {
  const projectState = await store.loadProject();
  const provider = createProvider(projectState, { rootDir: store.paths.configRootDir });
  const run = {
    id: runId("plan"),
    phase: "plan",
    startedAt: nowIso(),
    target: REVIEW_TARGETS.PLAN_FINAL,
    steps: [],
  };
  const draftPayload = await store.loadPlanDraft();
  if (!draftPayload?.outlineDraft) {
    throw new Error("尚未生成大纲草稿，无法进入完整大纲阶段。");
  }
  return completePreApprovalPlanRun(store, projectState, provider, run, draftPayload);
}

export async function reviewPlanDraft(store, { approved, feedback }) {
  const projectState = await store.loadProject();

  if (approved && projectState.phase.plan.status === PLAN_STATUS.FINAL_PENDING_REVIEW) {
    return {
      project: projectState,
      run: null,
      summary: "完整大纲已进入单次终审，无需再批准草稿节点。",
    };
  }

  const review = {
    id: runId("review-plan-draft"),
    target: REVIEW_TARGETS.PLAN_DRAFT,
    approved,
    feedback: feedback || "",
    createdAt: nowIso(),
  };

  await store.saveReview(review);
  projectState.history.reviews = [...(projectState.history.reviews || []), review];

  if (approved) {
    const previousPlanPhase = clonePlanPhase(projectState.phase.plan);
    projectState.phase.plan = {
      ...projectState.phase.plan,
      status: PLAN_STATUS.DRAFT_APPROVED,
      pendingReview: null,
      rejectionNotes: [],
    };
    await store.saveProject(projectState);
    try {
      return await runPlanFinalization(store);
    } catch (error) {
      await store.clearPlanFinal();
      if (isStructureCriticFailureMessage(errorMessage(error))) {
        const structureIssues = extractStructureCriticIssues(error);
        const rejectionNotes = uniqueNotes([
          ...(previousPlanPhase.rejectionNotes || []),
          ...structureIssues,
        ]);
        projectState.phase.plan = {
          ...previousPlanPhase,
          status: PLAN_STATUS.DRAFT_REJECTED,
          pendingReview: null,
          rejectionNotes,
        };
        await store.saveProject(projectState);
        try {
          return await runPlanDraft(store);
        } catch (rerunError) {
          projectState.phase.plan = {
            ...previousPlanPhase,
            rejectionNotes,
          };
          await store.saveProject(projectState);
          throw rerunError;
        }
      }

      projectState.phase.plan = previousPlanPhase;
      await store.saveProject(projectState);
      throw error;
    }
  }

  const previousPlanPhase = clonePlanPhase(projectState.phase.plan);
  projectState.phase.plan = {
    ...projectState.phase.plan,
    status: PLAN_STATUS.DRAFT_REJECTED,
    pendingReview: null,
    rejectionNotes: uniqueNotes([...(projectState.phase.plan.rejectionNotes || []), feedback]),
  };

  await store.saveProject(projectState);
  try {
    return await runPlanDraft(store);
  } catch (error) {
    projectState.phase.plan = previousPlanPhase;
    await store.saveProject(projectState);
    throw error;
  }
}

export async function reviewPlanFinal(store, { approved, feedback }) {
  const projectState = await store.loadProject();
  const review = {
    id: runId("review-plan-final"),
    target: REVIEW_TARGETS.PLAN_FINAL,
    approved,
    feedback: feedback || "",
    createdAt: nowIso(),
  };

  await store.saveReview(review);
  projectState.history.reviews = [...(projectState.history.reviews || []), review];

  if (approved) {
    await store.commitPlanFinal();
    await store.clearPlanFinalCache();
    projectState.phase.plan = {
      ...projectState.phase.plan,
      status: PLAN_STATUS.LOCKED,
      lockedAt: nowIso(),
      pendingReview: null,
      rejectionNotes: [],
    };
    projectState.phase.write = {
      ...projectState.phase.write,
      status: WRITE_STATUS.IDLE,
      pendingReview: null,
      currentChapterNumber: 0,
    };
    const savedProject = await store.saveProject(projectState);
    return {
      project: savedProject,
      run: null,
      summary: "大纲已锁定，系统可以进入 Write 阶段。",
    };
  }

  const previousPlanPhase = clonePlanPhase(projectState.phase.plan);
  projectState.phase.plan = {
    ...projectState.phase.plan,
    status: PLAN_STATUS.FINAL_REJECTED,
    pendingReview: null,
    rejectionNotes: uniqueNotes([...(projectState.phase.plan.rejectionNotes || []), feedback]),
  };

  await store.saveProject(projectState);
  try {
    return await runPlanDraft(store);
  } catch (error) {
    projectState.phase.plan = previousPlanPhase;
    await store.clearPlanFinal();
    await store.saveProject(projectState);
    throw error;
  }
}

function uniqueNotes(notes) {
  return [...new Set(notes.filter(Boolean))];
}

function clonePlanPhase(planPhase) {
  return {
    ...planPhase,
    pendingReview: planPhase?.pendingReview ? { ...planPhase.pendingReview } : null,
    rejectionNotes: [...(planPhase?.rejectionNotes || [])],
  };
}
