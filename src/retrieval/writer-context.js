import path from "node:path";

import { requiredCharactersConstraint } from "../core/character-presence.js";
import { createContextSource, mergeContextSources } from "../core/input-governance.js";
import {
  buildFactContextMarkdown,
  buildFactContextPacket,
  loadFactLedger,
  runFactSelectorAgent,
} from "../core/facts.js";
import { createExcerpt, extractJsonObject, nowIso, safeJsonParse, unique } from "../core/text.js";

const OUTLINE_EXCERPT_LIMIT = 4200;
const WORLDBUILDING_EXCERPT_LIMIT = 3400;
const CHARACTER_DOC_EXCERPT_LIMIT = 1000;
const HISTORY_MARKDOWN_EXCERPT_LIMIT = 2200;
const HISTORY_CANDIDATE_EXCERPT_LIMIT = 220;
const MAX_HISTORY_SELECTION = 4;

function stringifyJson(value) {
  return JSON.stringify(value, null, 2);
}

function parseAgentJson(result, label) {
  const parsed = safeJsonParse(extractJsonObject(result?.text || ""), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${label} 返回了无法解析的 JSON：${createExcerpt(result?.text || "", 240)}`);
  }
  return parsed;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function normalizeStringArray(values, limit = 8) {
  return unique((Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)).slice(0, limit);
}

function normalizeNamedNotes(values, fallback = []) {
  const source = Array.isArray(values) ? values : fallback;
  return source
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const name = String(item.name || "").trim();
      if (!name) {
        return null;
      }
      return {
        name,
        onStageRole: String(item.onStageRole || item.role || "").trim(),
        currentNeed: String(item.currentNeed || item.goal || "").trim(),
        voiceNote: String(item.voiceNote || item.voice || "").trim(),
        knowledgeBoundary: String(item.knowledgeBoundary || "").trim(),
        relationshipPressure: String(item.relationshipPressure || "").trim(),
        hiddenPressure: String(item.hiddenPressure || "").trim(),
      };
    })
    .filter(Boolean);
}

function buildSourceEntry(source, reason, excerpt) {
  return createContextSource({ source, reason, excerpt });
}

function buildPlanSelectedSources({
  chapterPlan,
  outlineMarkdown,
  worldbuildingText,
  worldState,
  foreshadowingAdvice,
  styleGuideText,
  styleGuideSourcePath,
  researchPacket,
}) {
  return mergeContextSources([
    [
      buildSourceEntry(
        `novel_state/bundle.json#structureData.chapters.${chapterPlan.chapterId}`,
        "锁定当前章节的章纲、场景规划与连续性锚点。",
        buildChapterPlanSummary(chapterPlan),
      ),
    ],
    outlineMarkdown
      ? [
          buildSourceEntry(
            path.join("novel_state", "outline.md"),
            "提取本章的总纲承诺、阶段目标与暂缓兑现项。",
            outlineMarkdown,
          ),
        ]
      : [],
    worldbuildingText
      ? [
          buildSourceEntry(
            path.join("novel_state", "worldbuilding.md"),
            "约束本章的时代细节、世界规则与现实质感。",
            worldbuildingText,
          ),
        ]
      : [],
    worldState
      ? [
          buildSourceEntry(
            path.join("novel_state", "world_state.json"),
            "承接当前世界状态与公共连续性事实。",
            stringifyJson(worldState),
          ),
        ]
      : [],
    foreshadowingAdvice.length
      ? [
          buildSourceEntry(
            "novel_state/bundle.json#foreshadowingRegistry",
            "筛出本章必须推进或避免写丢的伏笔任务。",
            stringifyJson(foreshadowingAdvice),
          ),
        ]
      : [],
    styleGuideText
      ? [
          buildSourceEntry(
            styleGuideSourcePath || path.join("novel_state", "style_guide.md"),
            "保持章节文风、视角和表达禁忌一致。",
            styleGuideText,
          ),
        ]
      : [],
    researchPacket?.triggered
      ? [
          buildSourceEntry(
            path.join("runtime", "staging", "write", chapterPlan.chapterId, "research_packet.json"),
            "本章存在考据或术语边界，需要额外研究提醒。",
            researchPacket?.briefingMarkdown || researchPacket?.summary || "",
          ),
        ]
      : [],
  ], 10);
}

function buildHistorySelectedSources(selectedCandidates = []) {
  return mergeContextSources([
    selectedCandidates.map((item) => buildSourceEntry(
      path.join("novel_state", "chapters", `${item.chapterId}.md`),
      item.reason || "该历史章节会影响当前章的连续性或情绪承接。",
      [
        item.title,
        item.summary,
        ...(item.continuityAnchors || []).slice(0, 2),
      ].filter(Boolean).join(" | "),
    )),
    selectedCandidates
      .filter((item) => item.auditDrift)
      .map((item) => buildSourceEntry(
        path.join("novel_state", "chapters", `${item.chapterId}_audit_drift.md`),
        "上一章审计留下了明确的漂移提醒，可作为下一章避免重复的护栏。",
        item.auditDrift,
      )),
  ], 10);
}

function stageForChapter(structureData, chapterPlan) {
  return (structureData?.stages || []).find((stage) =>
    Array.isArray(stage?.chapters) && stage.chapters.includes(chapterPlan.chapterId),
  ) || null;
}

function nearbyChapterSummaries(structureData, chapterPlan, window = 1) {
  const chapters = Array.isArray(structureData?.chapters) ? structureData.chapters : [];
  const index = chapters.findIndex((item) => item.chapterId === chapterPlan.chapterId);
  if (index === -1) {
    return [];
  }

  const collected = [];
  for (let cursor = Math.max(0, index - window); cursor <= Math.min(chapters.length - 1, index + window); cursor += 1) {
    const chapter = chapters[cursor];
    collected.push({
      chapterId: chapter.chapterId,
      title: chapter.title,
      stage: chapter.stage,
      povCharacter: chapter.povCharacter,
      keyEvents: chapter.keyEvents,
      nextHook: chapter.nextHook,
      relationToCurrent: cursor === index ? "current" : cursor < index ? "previous" : "next",
    });
  }

  return collected;
}

function buildProjectSummary(project) {
  return [
    `标题：${project.title}`,
    `类型：${project.genre}`,
    `背景：${project.setting}`,
    `主题：${project.theme}`,
    `主角目标：${project.protagonistGoal}`,
    `风格备注：${project.styleNotes || "无"}`,
    `研究备注：${project.researchNotes || "无"}`,
  ].join("\n");
}

function buildChapterPlanSummary(chapterPlan) {
  const charactersPresent = normalizeStringArray(chapterPlan?.charactersPresent, 12);
  const keyEvents = normalizeStringArray(chapterPlan?.keyEvents, 8);
  const scenes = Array.isArray(chapterPlan?.scenes) ? chapterPlan.scenes : [];
  const arcContribution = normalizeStringArray(chapterPlan?.arcContribution, 8);
  const continuityAnchors = normalizeStringArray(chapterPlan?.continuityAnchors, 8);

  return [
    `章节：${chapterPlan.chapterId} ${chapterPlan.title}`,
    `阶段：${chapterPlan.stage}`,
    `时间：${chapterPlan.timeInStory}`,
    `地点：${chapterPlan.location}`,
    `POV：${chapterPlan.povCharacter}`,
    `登场角色：${charactersPresent.join("、") || "无"}`,
    requiredCharactersConstraint(chapterPlan),
    `硬性事件：\n- ${keyEvents.join("\n- ") || "无"}`,
    `场景规划：\n- ${scenes.map((scene) => `${scene.label}｜${scene.focus}｜${scene.tension}｜出场:${(scene.characters || []).join("、") || "未标注"}`).join("\n- ") || "无"}`,
    `弧光推进：\n- ${arcContribution.join("\n- ") || "无"}`,
    `章末牵引：${chapterPlan.nextHook || "无"}`,
    `连续性锚点：\n- ${continuityAnchors.join("\n- ") || "无"}`,
  ].filter(Boolean).join("\n\n");
}

function buildStageSummary(stage, structureData, chapterPlan) {
  if (!stage) {
    return "暂无阶段摘要。";
  }

  const stageChapters = (structureData?.chapters || [])
    .filter((item) => Array.isArray(stage.chapters) && stage.chapters.includes(item.chapterId));

  const currentIndex = stageChapters.findIndex((item) => item.chapterId === chapterPlan.chapterId);
  const nearby = stageChapters
    .filter((_item, index) => Math.abs(index - currentIndex) <= 1)
    .map((item) => `- ${item.chapterId} ${item.title}｜POV:${item.povCharacter}｜事件:${item.keyEvents.join(" / ")}｜钩子:${item.nextHook}`)
    .join("\n");

  return [
    `阶段：${stage.label}`,
    `阶段目标：${stage.stageGoal || stage.purpose || "暂无"}`,
    `阶段目的：${stage.purpose || "暂无"}`,
    `阶段冲突：${(stage.stageConflicts || []).join("；") || "暂无"}`,
    `当前章节邻近章：\n${nearby || "- 无"}`,
  ].join("\n\n");
}

function relevantForeshadowings(foreshadowingAdvice = [], registry = null, chapterPlan = null) {
  const chapterIds = new Set((chapterPlan?.foreshadowingActions || []).map((item) => item.id));
  const selected = Array.isArray(foreshadowingAdvice) ? [...foreshadowingAdvice] : [];
  const registryItems = Array.isArray(registry?.foreshadowings) ? registry.foreshadowings : [];

  for (const item of registryItems) {
    if (!chapterIds.has(item.id) && item.urgency !== "high") {
      continue;
    }
    if (selected.some((candidate) => candidate.id === item.id)) {
      continue;
    }
    selected.push(item);
  }

  return selected;
}

function fallbackOutlineContext({ bundle, chapterPlan }) {
  const structureData = bundle?.structureData || {};
  const stage = stageForChapter(structureData, chapterPlan);
  const nextChapter = nearbyChapterSummaries(structureData, chapterPlan, 1).find((item) => item.relationToCurrent === "next");

  return {
    source: "fallback",
    storyPromises: normalizeStringArray([
      bundle?.outlineData?.coreHook,
      bundle?.outlineData?.shortSynopsis,
    ], 2),
    stageObjectives: normalizeStringArray([
      stage?.stageGoal,
      stage?.purpose,
      ...(stage?.stageConflicts || []),
    ], 6),
    chapterObligations: normalizeStringArray([
      ...chapterPlan.keyEvents,
      `章末牵引：${chapterPlan.nextHook}`,
    ], 6),
    mustPreserve: normalizeStringArray([
      `POV 必须稳定在 ${chapterPlan.povCharacter}`,
      `章节时间地点保持在 ${chapterPlan.timeInStory} / ${chapterPlan.location}`,
      ...chapterPlan.continuityAnchors,
    ], 6),
    deferUntilLater: normalizeStringArray([
      nextChapter ? `不要提前解决 ${nextChapter.chapterId} 的钩子：${nextChapter.nextHook}` : "",
      "不要提前兑现尚未到本章的阶段升级与终局结果。",
    ], 4),
    continuityRisks: normalizeStringArray([
      ...chapterPlan.continuityAnchors,
      nextChapter ? `后续承接仍需保留：${nextChapter.nextHook}` : "",
    ], 5),
    recommendedFocus: createExcerpt(chapterPlan.arcContribution.join("；") || chapterPlan.keyEvents[0] || "", 120),
  };
}

function fallbackCharacterContext({ bundle, chapterPlan, characterStates }) {
  const stateByName = new Map(characterStates.map((state) => [state.name, state]));
  const relevantCharacters = (bundle?.characters || [])
    .filter((character) => chapterPlan.charactersPresent.includes(character.name));

  const characterNotes = relevantCharacters.map((character) => {
    const state = stateByName.get(character.name) || character.state || {};
    return {
      name: character.name,
      onStageRole: character.role,
      currentNeed: state?.psychological?.current_goal || character.desire || "",
      voiceNote: character.voice || "",
      knowledgeBoundary: [
        ...(state?.knowledge?.knows || []).slice(0, 2),
        ...(state?.knowledge?.does_not_know || []).slice(0, 1).map((item) => `不能直接知道：${item}`),
      ].join("；"),
      relationshipPressure: chapterPlan.charactersPresent
        .filter((name) => name !== character.name)
        .map((name) => `${name}:${character.relationships?.[name]?.dynamic || "关系待推进"}`)
        .join("；"),
      hiddenPressure: state?.arc_progress?.arc_note || character.wound || "",
    };
  });

  return {
    source: "fallback",
    characters: characterNotes,
    groupDynamics: normalizeStringArray([
      `${chapterPlan.povCharacter}需要同时应对${chapterPlan.charactersPresent.join("、")}的不同诉求。`,
      ...chapterPlan.arcContribution,
    ], 6),
    writerReminders: normalizeStringArray([
      "人物说话方式要和既有角色声音一致。",
      "不要让角色跨越自己的知识边界抢答真相。",
      "让关系压力落到动作、对白和让步选择上。",
    ], 6),
    forbiddenLeaks: normalizeStringArray(
      relevantCharacters.flatMap((character) => {
        const state = stateByName.get(character.name) || {};
        return (state?.knowledge?.does_not_know || []).slice(0, 2).map((item) => `${character.name}当前不知道：${item}`);
      }),
      8,
    ),
  };
}

function fallbackWorldContext({ chapterPlan, worldbuildingText, worldState, foreshadowingAdvice, styleGuideText, researchPacket }) {
  return {
    source: "fallback",
    worldConstraints: normalizeStringArray([
      ...((worldState?.public_knowledge || []).slice(0, 2)),
      ...((worldState?.secret_knowledge || []).slice(0, 2)),
      createExcerpt(worldbuildingText, 120),
    ], 6),
    eraDetails: normalizeStringArray([
      chapterPlan.timeInStory,
      chapterPlan.location,
      ...chapterPlan.continuityAnchors.filter((item) => /时间锚点|史实|皇太极|多尔衮/.test(item)),
    ], 5),
    styleRules: normalizeStringArray([
      chapterPlan.emotionalTone ? `情绪基调：${chapterPlan.emotionalTone}` : "",
      styleGuideText ? createExcerpt(styleGuideText, 180) : "",
    ], 4),
    foreshadowingTasks: normalizeStringArray(
      (foreshadowingAdvice || []).map((item) => `${item.id}｜${item.description || item.action || item.status || ""}`),
      6,
    ),
    continuityAnchors: normalizeStringArray([
      ...chapterPlan.continuityAnchors,
      ...((worldState?.upcoming_anchors || []).map((item) => `${item.chapter}：${item.anchor}`)),
    ], 6),
    researchFlags: normalizeStringArray([
      researchPacket?.summary || "",
    ], 3),
  };
}

function fallbackHistorySelection(candidates = []) {
  return candidates
    .slice(-Math.min(MAX_HISTORY_SELECTION, candidates.length))
    .reverse()
    .map((item) => ({
      chapterId: item.chapterId,
      reason: "最近章节最可能影响当前章的连续性与情绪承接。",
    }));
}

function fallbackHistoryDigest({ chapterPlan, selectedCandidates }) {
  const relatedChapters = selectedCandidates.map((item) => ({
    chapter_id: item.chapterId,
    title: item.title,
    summary_200: item.summary,
    key_events: item.keyEvents,
    continuity_anchors: item.continuityAnchors,
    retrieval_rationale: item.reason,
    context_excerpt: item.markdownExcerpt,
  }));
  const continuityAnchors = unique(relatedChapters.flatMap((item) => item.continuity_anchors || [])).slice(0, 8);
  const lastChapter = selectedCandidates[0];

  return {
    source: "fallback",
    selectedChapterIds: selectedCandidates.map((item) => item.chapterId),
    carryOverFacts: normalizeStringArray(selectedCandidates.flatMap((item) => item.keyEvents || []), 6),
    emotionalCarryover: normalizeStringArray([
      lastChapter?.emotionalTone ? `${lastChapter.chapterId} 情绪：${lastChapter.emotionalTone}` : "",
    ], 3),
    openThreads: normalizeStringArray(selectedCandidates.map((item) => item.nextHook), 4),
    mustNotContradict: normalizeStringArray([
      ...continuityAnchors,
      ...selectedCandidates.map((item) => createExcerpt(item.auditDrift || "", 80)),
    ], 8),
    auditDriftWarnings: normalizeStringArray(
      selectedCandidates.map((item) => createExcerpt(item.auditDrift || "", 100)),
      4,
    ),
    lastEnding: lastChapter?.summary50 || lastChapter?.summary || "上一章节的余波还在。",
    relatedChapters,
    continuityAnchors,
  };
}

function buildPlanContextMarkdown(chapterPlan, outlineContext, characterContext, worldContext) {
  const characterBlock = (characterContext.characters || [])
    .map((item) => [
      `- ${item.name}｜职责:${item.onStageRole || "待推进"}`,
      item.currentNeed ? `当前诉求:${item.currentNeed}` : "",
      item.voiceNote ? `声音提醒:${item.voiceNote}` : "",
      item.knowledgeBoundary ? `知识边界:${item.knowledgeBoundary}` : "",
      item.relationshipPressure ? `关系压力:${item.relationshipPressure}` : "",
      item.hiddenPressure ? `暗线压力:${item.hiddenPressure}` : "",
    ].filter(Boolean).join("｜"))
    .join("\n");

  return [
    `# ${chapterPlan.chapterId} 计划侧上下文包`,
    "",
    "## 总纲与阶段",
    `- 总纲承诺：${(outlineContext.storyPromises || []).join("；") || "无"}`,
    `- 阶段目标：${(outlineContext.stageObjectives || []).join("；") || "无"}`,
    `- 本章必须兑现：${(outlineContext.chapterObligations || []).join("；") || "无"}`,
    `- 推荐聚焦：${outlineContext.recommendedFocus || "无"}`,
    "",
    "## 人物与关系",
    characterBlock || "- 无",
    `- 群像动力：${(characterContext.groupDynamics || []).join("；") || "无"}`,
    `- 写法提醒：${(characterContext.writerReminders || []).join("；") || "无"}`,
    "",
    "## 世界、风格与伏笔",
    `- 世界约束：${(worldContext.worldConstraints || []).join("；") || "无"}`,
    `- 时代细节：${(worldContext.eraDetails || []).join("；") || "无"}`,
    `- 风格规则：${(worldContext.styleRules || []).join("；") || "无"}`,
    `- 伏笔任务：${(worldContext.foreshadowingTasks || []).join("；") || "无"}`,
    `- 连续性提醒：${(worldContext.continuityAnchors || []).join("；") || "无"}`,
    `- 研究提醒：${(worldContext.researchFlags || []).join("；") || "无"}`,
    "",
    "## 暂缓兑现与风险",
    `- 暂缓兑现：${(outlineContext.deferUntilLater || []).join("；") || "无"}`,
    `- 连续性风险：${(outlineContext.continuityRisks || []).join("；") || "无"}`,
    `- 禁止泄漏：${(characterContext.forbiddenLeaks || []).join("；") || "无"}`,
  ].join("\n");
}

function buildHistoryContextMarkdown(chapterPlan, historyContext) {
  const relatedChapterLines = (historyContext.relatedChapters || [])
    .map((item) => `- ${item.chapter_id} ${item.title}｜${item.summary_200 || item.context_excerpt || "无摘要"}｜原因:${item.retrieval_rationale || "相关"}`)
    .join("\n");

  return [
    `# ${chapterPlan.chapterId} 历史衔接包`,
    "",
    "## 选中的历史章节",
    relatedChapterLines || "- 当前没有可用历史章节。",
    "",
    "## 必须承接的事实",
    `- ${(historyContext.carryOverFacts || []).join("\n- ") || "无"}`,
    "",
    "## 情绪与余波",
    `- ${(historyContext.emotionalCarryover || []).join("\n- ") || historyContext.lastEnding || "上一章节的余波还在。"}`,
    "",
    "## 未完线程",
    `- ${(historyContext.openThreads || []).join("\n- ") || "无"}`,
    "",
    "## 最近审计提醒",
    `- ${(historyContext.auditDriftWarnings || []).join("\n- ") || "无"}`,
    "",
    "## 不可冲突点",
    `- ${(historyContext.mustNotContradict || []).join("\n- ") || "无"}`,
  ].join("\n");
}

export function renderWriterContextMarkdown(writerContext = {}) {
  const selectedSources = Array.isArray(writerContext?.selectedSources)
    ? writerContext.selectedSources
    : [];
  const sourceLines = selectedSources
    .slice(0, 10)
    .map((item) => `- ${item.source}｜${item.reason}｜${item.excerpt || "无摘录"}`)
    .join("\n");
  const sections = [
    `# ${writerContext?.chapterId || "chapter"} Writer 上下文包`,
    "",
    "## 优先落实",
    `- ${((writerContext?.priorities || []).join("\n- ")) || "无"}`,
    "",
    "## 连续性风险",
    `- ${((writerContext?.risks || []).join("\n- ")) || "无"}`,
  ];

  if (writerContext?.factSummary) {
    sections.push(
      "",
      "## 既定事实与开放张力",
      `- ${writerContext.factSummary}`,
    );
  }

  if ((writerContext?.referenceSignals || []).length) {
    sections.push(
      "",
      "## 范文信号",
      `- ${writerContext.referenceSignals.join("\n- ")}`,
    );
  }

  if ((writerContext?.openingSignals || []).length) {
    sections.push(
      "",
      "## 黄金三章抽象信号",
      `- ${writerContext.openingSignals.join("\n- ")}`,
    );
  }

  sections.push(
    "",
    "## 计划摘要",
    `- ${writerContext?.planContextSummary || "无"}`,
    "",
    "## 历史摘要",
    `- ${writerContext?.historyContextSummary || "无"}`,
    "",
    "## 可追溯来源",
    sourceLines || "- 无",
  );

  return sections.join("\n");
}

function buildWriterContextPacket(chapterPlan, planContext, historyContext, factContext = null) {
  const priorities = normalizeStringArray([
    requiredCharactersConstraint(chapterPlan),
    ...(planContext?.outline?.chapterObligations || []),
    ...(planContext?.world?.foreshadowingTasks || []),
    ...(planContext?.characters?.writerReminders || []),
    ...(historyContext?.carryOverFacts || []),
    ...(historyContext?.openThreads || []),
    ...(historyContext?.auditDriftWarnings || []),
    ...(factContext?.establishedFacts || []).map((f) => `已定事实[${f.factId}]：${f.subject}｜${f.assertion}`),
  ], 12);
  const risks = normalizeStringArray([
    ...(planContext?.outline?.continuityRisks || []),
    ...(planContext?.characters?.forbiddenLeaks || []),
    ...(historyContext?.mustNotContradict || []),
    ...(historyContext?.auditDriftWarnings || []),
    ...(factContext?.establishedFacts || []).map((f) => `禁止否认[${f.factId}]：${f.assertion}`),
  ], 12);
  const generationNotes = normalizeStringArray([
    ...(planContext?.warnings || []),
    ...(historyContext?.warnings || []),
  ], 8);
  const selectedSources = mergeContextSources([
    planContext?.selectedSources || [],
    historyContext?.selectedSources || [],
  ], 12);
  const packet = {
    chapterId: chapterPlan.chapterId,
    generatedAt: nowIso(),
    priorities,
    risks,
    generationNotes,
    usedFallback: generationNotes.length > 0,
    selectedSources,
    planContextSummary: createExcerpt(planContext?.briefingMarkdown || "", 220),
    historyContextSummary: createExcerpt(historyContext?.briefingMarkdown || "", 220),
    factSummary: createExcerpt(factContext?.briefingMarkdown || "", 240),
    referenceSignals: [],
    openingSignals: [],
  };
  const markdown = renderWriterContextMarkdown(packet);

  return {
    ...packet,
    summaryText: createExcerpt(markdown, 320),
    briefingMarkdown: markdown,
  };
}

async function runOutlineContextAgent({
  provider,
  project,
  bundle,
  chapterPlan,
  outlineMarkdown,
}) {
  const structureData = bundle?.structureData || {};
  const stage = stageForChapter(structureData, chapterPlan);
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 OutlineContextAgent。你负责从已锁定的大纲包里，为当前章节筛选真正会影响写作的总纲、阶段与章节上下文。不要复述全书，只保留当前章节必须兑现、必须保留、必须延后、最容易写偏的内容。只输出 JSON。",
    input: [
      buildProjectSummary(project),
      `当前章节：\n${buildChapterPlanSummary(chapterPlan)}`,
      `当前阶段摘要：\n${buildStageSummary(stage, structureData, chapterPlan)}`,
      `全书锁定大纲：\n${createExcerpt(outlineMarkdown || "", OUTLINE_EXCERPT_LIMIT)}`,
      `结构化大纲：\n${stringifyJson({
        coreHook: bundle?.outlineData?.coreHook || "",
        shortSynopsis: bundle?.outlineData?.shortSynopsis || "",
        roughSections: bundle?.outlineData?.roughSections || [],
        nearbyChapters: nearbyChapterSummaries(structureData, chapterPlan, 1),
      })}`,
      `请输出 JSON：
{
  "storyPromises": ["全书承诺1", "全书承诺2"],
  "stageObjectives": ["当前阶段目标1", "当前阶段目标2"],
  "chapterObligations": ["本章必须兑现1", "本章必须兑现2"],
  "mustPreserve": ["不能写丢的设定或状态"],
  "deferUntilLater": ["必须延后到后文兑现的内容"],
  "continuityRisks": ["最容易写偏的地方"],
  "recommendedFocus": "一句话概括本章真正该聚焦的核心"
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "plan_context_outline",
      chapterId: chapterPlan.chapterId,
    },
  });

  const parsed = parseAgentJson(result, "OutlineContextAgent");
  return {
    source: "agent",
    storyPromises: normalizeStringArray(parsed.storyPromises, 4),
    stageObjectives: normalizeStringArray(parsed.stageObjectives, 6),
    chapterObligations: normalizeStringArray(parsed.chapterObligations, 6),
    mustPreserve: normalizeStringArray(parsed.mustPreserve, 6),
    deferUntilLater: normalizeStringArray(parsed.deferUntilLater, 5),
    continuityRisks: normalizeStringArray(parsed.continuityRisks, 6),
    recommendedFocus: String(parsed.recommendedFocus || "").trim(),
  };
}

async function runCharacterContextAgent({
  provider,
  project,
  bundle,
  chapterPlan,
  characterStates,
}) {
  const stateByName = new Map(characterStates.map((state) => [state.name, state]));
  const relevantCharacters = (bundle?.characters || [])
    .filter((character) => chapterPlan.charactersPresent.includes(character.name));

  const characterPackets = relevantCharacters.map((character) => {
    const state = stateByName.get(character.name) || character.state || {};
    return [
      `## ${character.name}`,
      `角色定位：${character.role}`,
      `性格标签：${(character.tags || []).join(" / ")}`,
      `说话方式：${character.voice || "暂无"}`,
      `欲望：${character.desire || "暂无"}`,
      `伤口：${character.wound || "暂无"}`,
      `盲点：${character.blindspot || "暂无"}`,
      `当前目标：${state?.psychological?.current_goal || "暂无"}`,
      `当前情绪：${state?.psychological?.emotional_state || "暂无"}`,
      `关键信念：${(state?.psychological?.key_beliefs || []).join("；") || "暂无"}`,
      `当前已知：${(state?.knowledge?.knows || []).join("；") || "暂无"}`,
      `当前未知：${(state?.knowledge?.does_not_know || []).join("；") || "暂无"}`,
      `人物小传：${createExcerpt(character.biographyMarkdown || "", CHARACTER_DOC_EXCERPT_LIMIT) || "暂无"}`,
      `人物线：${createExcerpt(character.storylineMarkdown || "", CHARACTER_DOC_EXCERPT_LIMIT) || "暂无"}`,
      `资料卡：${createExcerpt(character.profileMarkdown || "", CHARACTER_DOC_EXCERPT_LIMIT) || "暂无"}`,
    ].join("\n");
  }).join("\n\n");

  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 CharacterContextAgent。你负责根据当前章节，从角色资料里筛选 Writer 真正需要的角色写法约束。重点只看：当前诉求、知识边界、人物声音、关系张力、这章最容易写崩的地方。只输出 JSON。",
    input: [
      buildProjectSummary(project),
      `当前章节：\n${buildChapterPlanSummary(chapterPlan)}`,
      `角色资料包：\n${characterPackets || "本章无可用角色资料。"}`,
      `请输出 JSON：
{
  "characters": [
    {
      "name": "角色名",
      "onStageRole": "本章作用",
      "currentNeed": "当前最强诉求",
      "voiceNote": "说话/行动声音提醒",
      "knowledgeBoundary": "当前不能越界知道或说出的内容",
      "relationshipPressure": "本章最重要的关系张力",
      "hiddenPressure": "本章写作时要隐隐带出的内在压力"
    }
  ],
  "groupDynamics": ["群像互动提醒"],
  "writerReminders": ["给 Writer 的角色写法提醒"],
  "forbiddenLeaks": ["绝对不能让角色提前知道/说出/做出的内容"]
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "plan_context_characters",
      chapterId: chapterPlan.chapterId,
    },
  });

  const parsed = parseAgentJson(result, "CharacterContextAgent");
  return {
    source: "agent",
    characters: normalizeNamedNotes(parsed.characters),
    groupDynamics: normalizeStringArray(parsed.groupDynamics, 6),
    writerReminders: normalizeStringArray(parsed.writerReminders, 6),
    forbiddenLeaks: normalizeStringArray(parsed.forbiddenLeaks, 8),
  };
}

async function runWorldContextAgent({
  provider,
  project,
  bundle,
  chapterPlan,
  worldbuildingText,
  worldState,
  foreshadowingAdvice,
  styleGuideText,
  researchPacket,
}) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 WorldContextAgent。你负责从世界观、世界状态、伏笔注册表与风格指南中，筛出当前章节真正需要的世界约束。重点只保留会影响这一章写法的时代细节、世界规则、伏笔任务、风格禁忌与连续性提醒。只输出 JSON。",
    input: [
      buildProjectSummary(project),
      `当前章节：\n${buildChapterPlanSummary(chapterPlan)}`,
      `世界观设定：\n${createExcerpt(worldbuildingText || "", WORLDBUILDING_EXCERPT_LIMIT) || "无"}`,
      `当前世界状态：\n${stringifyJson(worldState || {})}`,
      `当前相关伏笔：\n${stringifyJson(relevantForeshadowings(foreshadowingAdvice, bundle?.foreshadowingRegistry, chapterPlan))}`,
      `当前风格指南：\n${styleGuideText || "无"}`,
      `研究备注：${researchPacket?.summary || "无"}`,
      `请输出 JSON：
{
  "worldConstraints": ["世界约束1", "世界约束2"],
  "eraDetails": ["时代细节1", "时代细节2"],
  "styleRules": ["风格规则1", "风格规则2"],
  "foreshadowingTasks": ["本章要承接的伏笔任务"],
  "continuityAnchors": ["不能写丢的连续性点"],
  "researchFlags": ["需要额外注意的考据点"]
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "plan_context_world",
      chapterId: chapterPlan.chapterId,
    },
  });

  const parsed = parseAgentJson(result, "WorldContextAgent");
  return {
    source: "agent",
    worldConstraints: normalizeStringArray(parsed.worldConstraints, 6),
    eraDetails: normalizeStringArray(parsed.eraDetails, 6),
    styleRules: normalizeStringArray(parsed.styleRules, 6),
    foreshadowingTasks: normalizeStringArray(parsed.foreshadowingTasks, 6),
    continuityAnchors: normalizeStringArray(parsed.continuityAnchors, 6),
    researchFlags: normalizeStringArray(parsed.researchFlags, 4),
  };
}

async function buildHistoryCandidates(store, chapterMetas) {
  const candidates = [];
  for (const meta of chapterMetas) {
    const markdownPath = path.join(store.paths.chaptersDir, `${meta.chapter_id}.md`);
    const markdown = await store.readText(markdownPath, "");
    const auditDrift = await store.readText(
      path.join(store.paths.chaptersDir, `${meta.chapter_id}_audit_drift.md`),
      "",
    );
    candidates.push({
      chapterId: meta.chapter_id,
      title: meta.title,
      stage: meta.stage,
      summary50: meta.summary_50 || "",
      summary: meta.summary_200 || meta.summary_50 || "",
      emotionalTone: meta.emotional_tone || "",
      keyEvents: meta.key_events || [],
      continuityAnchors: meta.continuity_anchors || [],
      nextHook: meta.next_hook || meta.nextHook || meta.summary_200 || meta.summary_50 || "",
      markdown,
      markdownExcerpt: createExcerpt(markdown, HISTORY_CANDIDATE_EXCERPT_LIMIT),
      auditDrift,
      charactersPresent: meta.characters_present || [],
    });
  }
  return candidates;
}

async function runHistorySelectorAgent({
  provider,
  project,
  chapterPlan,
  candidates,
}) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 HistorySelectorAgent。你能看到所有已完成历史章节的摘要。请根据当前章节需求，挑出最值得 Writer 回看的 0 到 4 章。只选真正会影响这一章的连续性、人物余波、未完线程或世界状态的章节。只输出 JSON。",
    input: [
      buildProjectSummary(project),
      `当前章节：\n${buildChapterPlanSummary(chapterPlan)}`,
      `历史章节候选：\n${candidates.map((item) => `- ${item.chapterId} ${item.title}｜阶段:${item.stage}｜人物:${item.charactersPresent.join("、")}｜摘要:${item.summary}｜锚点:${(item.continuityAnchors || []).join(" / ")}｜正文片段:${item.markdownExcerpt || "无"}｜审计漂移:${createExcerpt(item.auditDrift || "无", 80)}`).join("\n") || "无历史章节"}`,
      `请输出 JSON：
{
  "selectedChapterIds": ["ch001", "ch003"],
  "reasons": {
    "ch001": "为什么当前章需要回看它"
  }
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "history_context_select",
      chapterId: chapterPlan.chapterId,
    },
  });

  const parsed = parseAgentJson(result, "HistorySelectorAgent");
  const reasons = parsed.reasons && typeof parsed.reasons === "object" ? parsed.reasons : {};

  return (Array.isArray(parsed.selectedChapterIds) ? parsed.selectedChapterIds : [])
    .map((chapterId) => String(chapterId || "").trim())
    .filter(Boolean)
    .slice(0, MAX_HISTORY_SELECTION)
    .map((chapterId) => ({
      chapterId,
      reason: String(reasons[chapterId] || "与当前章节有连续性关系。").trim(),
    }));
}

async function runHistoryDigestAgent({
  provider,
  project,
  chapterPlan,
  selectedCandidates,
}) {
  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 HistoryContextAgent。你负责阅读被挑中的历史章节，为 Writer 整理当前章节真正需要承接的历史内容。不要复述整章，只保留必须承接的事实、情绪余波、未完线程和不能冲突的点。只输出 JSON。",
    input: [
      buildProjectSummary(project),
      `当前章节：\n${buildChapterPlanSummary(chapterPlan)}`,
      `已选历史章节：\n${selectedCandidates.map((item) => [
        `## ${item.chapterId} ${item.title}`,
        `筛选原因：${item.reason}`,
        `章节摘要：${item.summary}`,
        `关键事件：${(item.keyEvents || []).join("；") || "无"}`,
        `连续性锚点：${(item.continuityAnchors || []).join("；") || "无"}`,
        `审计漂移提醒：\n${item.auditDrift || "无"}`,
        `正文全文：\n${createExcerpt(item.markdown || "", HISTORY_MARKDOWN_EXCERPT_LIMIT) || "无正文"}`,
      ].join("\n")).join("\n\n")}`,
      `请输出 JSON：
{
  "carryOverFacts": ["当前章必须承接的事实"],
  "emotionalCarryover": ["当前章应延续的情绪余波"],
  "openThreads": ["当前章还没解决的历史线程"],
  "mustNotContradict": ["当前章绝不能写冲突的点"],
  "lastEnding": "一句话概括最该继承的上章余波"
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "history_context_digest",
      chapterId: chapterPlan.chapterId,
    },
  });

  const parsed = parseAgentJson(result, "HistoryContextAgent");
  const continuityAnchors = unique([
    ...normalizeStringArray(parsed.mustNotContradict, 8),
    ...selectedCandidates.flatMap((item) => item.continuityAnchors || []),
  ]).slice(0, 8);

  return {
    source: "agent",
    selectedChapterIds: selectedCandidates.map((item) => item.chapterId),
    carryOverFacts: normalizeStringArray(parsed.carryOverFacts, 6),
    emotionalCarryover: normalizeStringArray(parsed.emotionalCarryover, 4),
    openThreads: normalizeStringArray(parsed.openThreads, 5),
    mustNotContradict: normalizeStringArray(parsed.mustNotContradict, 8),
    auditDriftWarnings: normalizeStringArray(
      selectedCandidates.map((item) => createExcerpt(item.auditDrift || "", 100)),
      4,
    ),
    lastEnding: String(parsed.lastEnding || "").trim(),
    relatedChapters: selectedCandidates.map((item) => ({
      chapter_id: item.chapterId,
      title: item.title,
      summary_200: item.summary,
      key_events: item.keyEvents,
      continuity_anchors: item.continuityAnchors,
      retrieval_rationale: item.reason,
      context_excerpt: createExcerpt(item.markdown || "", HISTORY_CANDIDATE_EXCERPT_LIMIT),
    })),
    continuityAnchors,
  };
}

export async function buildPlanContextPacket({
  store,
  provider,
  project,
  bundle,
  chapterPlan,
  characterStates,
  foreshadowingAdvice,
  styleGuideText,
  styleGuideSourcePath,
  researchPacket,
}) {
  const outlineMarkdown = await store.readText(path.join(store.paths.novelStateDir, "outline.md"), "");
  const worldbuildingText = await store.readText(path.join(store.paths.novelStateDir, "worldbuilding.md"), "");
  const worldState = bundle?.worldState || await store.readJson(path.join(store.paths.novelStateDir, "world_state.json"), null);

  const [outline, characters, world] = await Promise.all([
    runOutlineContextAgent({
      provider,
      project,
      bundle,
      chapterPlan,
      outlineMarkdown,
    }),
    runCharacterContextAgent({
      provider,
      project,
      bundle,
      chapterPlan,
      characterStates,
    }),
    runWorldContextAgent({
      provider,
      project,
      bundle,
      chapterPlan,
      worldbuildingText,
      worldState,
      foreshadowingAdvice,
      styleGuideText,
      researchPacket,
    }),
  ]);

  const briefingMarkdown = buildPlanContextMarkdown(chapterPlan, outline, characters, world);
  const selectedSources = buildPlanSelectedSources({
    chapterPlan,
    outlineMarkdown,
    worldbuildingText,
    worldState,
      foreshadowingAdvice: relevantForeshadowings(foreshadowingAdvice, bundle?.foreshadowingRegistry, chapterPlan),
      styleGuideText,
      styleGuideSourcePath,
      researchPacket,
    });
  return {
    chapterId: chapterPlan.chapterId,
    generatedAt: nowIso(),
    outline,
    characters,
    world,
    warnings: [],
    usedFallback: false,
    selectedSources,
    briefingMarkdown,
    summaryText: createExcerpt(briefingMarkdown, 320),
  };
}

export async function buildHistoryContextPacket({
  store,
  provider,
  project,
  chapterPlan,
  chapterMetas,
}) {
  const candidates = await buildHistoryCandidates(store, chapterMetas);
  if (!candidates.length) {
    const emptyContext = {
      source: "empty",
      selectedChapterIds: [],
      carryOverFacts: [],
      emotionalCarryover: [],
      openThreads: [],
      auditDriftWarnings: [],
      mustNotContradict: [],
      lastEnding: "上一章节的余波还在。",
      relatedChapters: [],
      continuityAnchors: [],
    };
    const briefingMarkdown = buildHistoryContextMarkdown(chapterPlan, emptyContext);
    return {
      queryText: createExcerpt(buildChapterPlanSummary(chapterPlan), 220),
      relatedChapters: [],
      selectedFiles: [],
      continuityAnchors: [],
      carryOverFacts: [],
      emotionalCarryover: [],
      openThreads: [],
      auditDriftWarnings: [],
      mustNotContradict: [],
      lastEnding: "上一章节的余波还在。",
      retrievalMode: "history-context-agents",
      catalogStats: {
        totalChapters: 0,
        selected: 0,
      },
      selectedSources: [],
      contextSummary: "当前没有可供承接的历史章节。",
      briefingMarkdown,
      warnings: [],
      selectionSource: "empty",
      digestSource: "empty",
      usedFallback: false,
    };
  }

  const warnings = [];
  const selected = await runHistorySelectorAgent({
    provider,
    project,
    chapterPlan,
    candidates,
  });
  const selectionSource = "agent";

  const selectedCandidates = selected
    .map((item) => {
      const candidate = candidates.find((candidateItem) => candidateItem.chapterId === item.chapterId);
      if (!candidate) {
        return null;
      }
      return {
        ...candidate,
        reason: item.reason,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_HISTORY_SELECTION);

  if (!selectedCandidates.length) {
    const emptySelection = {
      source: "empty",
      selectedChapterIds: [],
      carryOverFacts: [],
      emotionalCarryover: [],
      openThreads: [],
      auditDriftWarnings: [],
      mustNotContradict: [],
      lastEnding: "上一章节的余波还在。",
      relatedChapters: [],
      continuityAnchors: [],
    };
    const briefingMarkdown = buildHistoryContextMarkdown(chapterPlan, emptySelection);
    return {
      queryText: createExcerpt(buildChapterPlanSummary(chapterPlan), 220),
      relatedChapters: [],
      selectedFiles: [],
      continuityAnchors: [],
      carryOverFacts: [],
      emotionalCarryover: [],
      openThreads: [],
      auditDriftWarnings: [],
      mustNotContradict: [],
      lastEnding: "上一章节的余波还在。",
      retrievalMode: "history-context-agents",
      catalogStats: {
        totalChapters: candidates.length,
        selected: 0,
      },
      selectedSources: [],
      contextSummary: "历史章节筛选后，当前章无需额外承接旧章全文。",
      briefingMarkdown,
      warnings,
      selectionSource,
      digestSource: "empty",
      usedFallback: warnings.length > 0,
    };
  }

  const digest = await runHistoryDigestAgent({
    provider,
    project,
    chapterPlan,
    selectedCandidates,
  });
  const digestSource = "agent";

  const briefingMarkdown = buildHistoryContextMarkdown(chapterPlan, digest);
  const selectedSources = buildHistorySelectedSources(selectedCandidates);
  return {
    queryText: createExcerpt(buildChapterPlanSummary(chapterPlan), 220),
    relatedChapters: digest.relatedChapters,
    selectedFiles: selectedCandidates.map((item) => ({
      id: item.chapterId,
      kind: "chapter_history",
      path: path.join("novel_state", "chapters", `${item.chapterId}.md`),
      name: `${item.chapterId} ${item.title}`,
      description: item.summary,
      retrieval_score: Number((1 - selectedCandidates.indexOf(item) * 0.15).toFixed(4)),
      retrieval_rationale: item.reason,
      context_excerpt: createExcerpt(item.markdown || "", HISTORY_CANDIDATE_EXCERPT_LIMIT),
    })),
    continuityAnchors: digest.continuityAnchors,
    carryOverFacts: digest.carryOverFacts,
    emotionalCarryover: digest.emotionalCarryover,
    openThreads: digest.openThreads,
    mustNotContradict: digest.mustNotContradict,
    lastEnding: digest.lastEnding || selectedCandidates[0]?.summary50 || "上一章节的余波还在。",
    retrievalMode: "history-context-agents",
    catalogStats: {
      totalChapters: candidates.length,
      selected: selectedCandidates.length,
    },
    selectedSources,
    contextSummary: createExcerpt(briefingMarkdown, 320),
    briefingMarkdown,
    warnings,
    selectionSource,
    digestSource,
    usedFallback: warnings.length > 0,
  };
}

export async function buildWriterContextBundle({
  store,
  provider,
  project,
  bundle,
  chapterPlan,
  chapterMetas,
  characterStates,
  foreshadowingAdvice,
  styleGuideText,
  styleGuideSourcePath,
  researchPacket,
}) {
  const [planContext, historyContext] = await Promise.all([
    buildPlanContextPacket({
      store,
      provider,
      project,
      bundle,
      chapterPlan,
      characterStates,
      foreshadowingAdvice,
      styleGuideText,
      styleGuideSourcePath,
      researchPacket,
    }),
    buildHistoryContextPacket({
      store,
      provider,
      project,
      chapterPlan,
      chapterMetas,
    }),
  ]);

  let factContext = null;
  try {
    const factLedger = await loadFactLedger(store);
    if (factLedger.length > 0) {
      const selection = await runFactSelectorAgent({
        provider,
        project,
        chapterPlan,
        factLedger,
      });
      factContext = buildFactContextPacket({
        chapterPlan,
        establishedFacts: selection.establishedFacts,
        openTensions: selection.openTensions,
        selectionRationale: selection.selectionRationale,
        catalogStats: selection.catalogStats,
      });
    }
  } catch {
    factContext = null;
  }

  const writerContext = buildWriterContextPacket(chapterPlan, planContext, historyContext, factContext);
  return {
    planContext,
    historyContext,
    writerContext,
    factContext,
  };
}
