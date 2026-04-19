import {
  chapterIdFromNumber,
  chapterNumberFromId,
  countWordsApprox,
  createExcerpt,
  extractKeywords,
  nowIso,
  unique,
} from "./text.js";

const CAST_ROLE_BLUEPRINTS = [
  { roleKey: "protagonist", role: "主角" },
  { roleKey: "ally", role: "盟友" },
  { roleKey: "rival", role: "对手 / 感情线" },
  { roleKey: "antagonist", role: "反派" },
  { roleKey: "support_1", role: "支线角色" },
  { roleKey: "support_2", role: "支线角色" },
];

const CORE_ROLE_KEYS = new Set(CAST_ROLE_BLUEPRINTS.map((item) => item.roleKey));

function ensureNonEmptyString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${label} 不能为空。`);
  }
  return normalized;
}

function ensureStringArray(values, label, minimum = 1) {
  const normalized = (Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (normalized.length < minimum) {
    throw new Error(`${label} 至少需要 ${minimum} 项。`);
  }
  return normalized;
}

function normalizeRelationshipEntry(raw, fallbackDynamic) {
  return {
    closeness: Math.max(0, Math.min(10, Number(raw?.closeness ?? 4) || 4)),
    trust: Math.max(0, Math.min(10, Number(raw?.trust ?? 3) || 3)),
    dynamic: ensureNonEmptyString(raw?.dynamic || fallbackDynamic, "人物关系 dynamic"),
  };
}

function castByRole(cast, role) {
  return cast.find((item) => item.roleKey === role);
}

function createRelationshipSeed(cast, selfName) {
  const protagonist = castByRole(cast, "protagonist");
  const ally = castByRole(cast, "ally");
  const rival = castByRole(cast, "rival");
  const antagonist = castByRole(cast, "antagonist");

  const relationshipTable = {};
  for (const character of cast) {
    if (character.name === selfName) {
      continue;
    }

    if (character.name === protagonist?.name) {
      relationshipTable[character.name] = {
        closeness: 7,
        trust: 6,
        dynamic: "围绕主线不断靠近的关系",
      };
      continue;
    }

    if (character.name === ally?.name) {
      relationshipTable[character.name] = {
        closeness: 6,
        trust: 5,
        dynamic: "合作基础正在形成，但仍需共同经历考验。",
      };
      continue;
    }

    if (character.name === rival?.name) {
      relationshipTable[character.name] = {
        closeness: 3,
        trust: 2,
        dynamic: "合作与竞争并存，立场并不稳定。",
      };
      continue;
    }

    if (character.name === antagonist?.name) {
      relationshipTable[character.name] = {
        closeness: 0,
        trust: 0,
        dynamic: "威胁尚未完全现形，但阴影已在逼近",
      };
      continue;
    }

    relationshipTable[character.name] = {
      closeness: 4,
      trust: 3,
      dynamic: "还在判断彼此能否站到同一边",
    };
  }

  return relationshipTable;
}

export function buildCast(project, plannedCharacters = null) {
  const items = Array.isArray(plannedCharacters) ? plannedCharacters : [];
  const byRole = new Map(items.map((item) => [String(item?.roleKey || ""), item]));
  const missingRoles = CAST_ROLE_BLUEPRINTS
    .map((item) => item.roleKey)
    .filter((roleKey) => !byRole.has(roleKey));

  if (missingRoles.length) {
    throw new Error(`角色规划缺少必需角色：${missingRoles.join("、")}`);
  }

  const cast = CAST_ROLE_BLUEPRINTS.map((blueprint) => {
    const raw = byRole.get(blueprint.roleKey);
    return {
      roleKey: blueprint.roleKey,
      role: ensureNonEmptyString(raw.role || blueprint.role, `${blueprint.roleKey}.role`),
      name: ensureNonEmptyString(raw.name, `${blueprint.roleKey}.name`),
      historicalStatus:
        raw.historicalStatus === "real" || raw.historicalStatus === "fictional"
          ? raw.historicalStatus
          : "fictional",
      nameRationale: ensureNonEmptyString(raw.nameRationale, `${blueprint.roleKey}.nameRationale`),
      tags: ensureStringArray(raw.tags, `${blueprint.roleKey}.tags`, 2),
      voice: ensureNonEmptyString(raw.voice, `${blueprint.roleKey}.voice`),
      desire: ensureNonEmptyString(raw.desire, `${blueprint.roleKey}.desire`),
      wound: ensureNonEmptyString(raw.wound, `${blueprint.roleKey}.wound`),
      blindspot: ensureNonEmptyString(raw.blindspot, `${blueprint.roleKey}.blindspot`),
      signatureItem: ensureNonEmptyString(raw.signatureItem, `${blueprint.roleKey}.signatureItem`),
      appearance: ensureNonEmptyString(raw.appearance, `${blueprint.roleKey}.appearance`),
      entryLocation: ensureNonEmptyString(raw.entryLocation, `${blueprint.roleKey}.entryLocation`),
      relationshipHint: String(raw.relationshipHint || "").trim(),
      relationships: raw.relationships && typeof raw.relationships === "object" ? raw.relationships : {},
    };
  });

  const extraCharacters = items
    .filter((item) => !CORE_ROLE_KEYS.has(String(item?.roleKey || "")))
    .map((raw, index) => {
      const roleKey = ensureNonEmptyString(raw.roleKey || `support_extra_${index + 1}`, `support_extra_${index + 1}.roleKey`);
      return {
        roleKey,
        role: ensureNonEmptyString(raw.role || "扩展角色", `${roleKey}.role`),
        name: ensureNonEmptyString(raw.name, `${roleKey}.name`),
        historicalStatus:
          raw.historicalStatus === "real" || raw.historicalStatus === "fictional"
            ? raw.historicalStatus
            : "fictional",
        nameRationale: ensureNonEmptyString(raw.nameRationale, `${roleKey}.nameRationale`),
        tags: ensureStringArray(raw.tags, `${roleKey}.tags`, 2),
        voice: ensureNonEmptyString(raw.voice, `${roleKey}.voice`),
        desire: ensureNonEmptyString(raw.desire, `${roleKey}.desire`),
        wound: ensureNonEmptyString(raw.wound, `${roleKey}.wound`),
        blindspot: ensureNonEmptyString(raw.blindspot, `${roleKey}.blindspot`),
        signatureItem: ensureNonEmptyString(raw.signatureItem, `${roleKey}.signatureItem`),
        appearance: ensureNonEmptyString(raw.appearance, `${roleKey}.appearance`),
        entryLocation: ensureNonEmptyString(raw.entryLocation, `${roleKey}.entryLocation`),
        relationshipHint: String(raw.relationshipHint || "").trim(),
        relationships: raw.relationships && typeof raw.relationships === "object" ? raw.relationships : {},
      };
    });

  const fullCast = [...cast, ...extraCharacters];

  const usedNames = new Set();
  for (const character of fullCast) {
    if (usedNames.has(character.name)) {
      throw new Error(`角色名称重复：${character.name}`);
    }
    usedNames.add(character.name);
  }

  return fullCast.map((character) => {
    const seeded = createRelationshipSeed(fullCast, character.name);
    const merged = {};
    for (const [otherName, seed] of Object.entries(seeded)) {
      merged[otherName] = normalizeRelationshipEntry(character.relationships?.[otherName], seed.dynamic);
      merged[otherName].closeness = character.relationships?.[otherName]?.closeness ?? seed.closeness;
      merged[otherName].trust = character.relationships?.[otherName]?.trust ?? seed.trust;
    }

    return {
      ...character,
      relationships: merged,
    };
  });
}

export function buildOutlineDraft(rawOutline) {
  const feedbackNotes = ensureStringArray(rawOutline.feedbackNotes || [], "outline.feedbackNotes", 0);
  const roughSections = ensureStringArray(
    (rawOutline.roughSections || []).map((section) =>
      section && typeof section === "object"
        ? `${String(section.stage || "").trim()}|||${String(section.content || "").trim()}`
        : "",
    ),
    "outline.roughSections",
    3,
  ).map((item, index) => {
    const [stage, content] = item.split("|||");
    return {
      stage: stage || `阶段${index + 1}`,
      content,
    };
  });

  const outlineMarkdown = `# 大纲草稿\n\n## 一句话核心梗\n${ensureNonEmptyString(rawOutline.coreHook, "outline.coreHook")}\n\n## 简纲\n${ensureNonEmptyString(rawOutline.shortSynopsis, "outline.shortSynopsis")}\n\n## 粗纲\n${roughSections
    .map((section) => `### ${section.stage}\n${section.content}`)
    .join("\n\n")}${feedbackNotes.length ? `\n\n## 本轮修订重点\n- ${feedbackNotes.join("\n- ")}\n` : "\n"}`;

  return {
    generatedAt: nowIso(),
    coreHook: ensureNonEmptyString(rawOutline.coreHook, "outline.coreHook"),
    shortSynopsis: ensureNonEmptyString(rawOutline.shortSynopsis, "outline.shortSynopsis"),
    roughSections,
    feedbackNotes,
    outlineMarkdown,
    provider: rawOutline.provider || null,
  };
}

export function buildForeshadowingRegistry(rawRegistry, totalChapters) {
  const maxChapter = Number(totalChapters) || 1;
  const source = Array.isArray(rawRegistry?.foreshadowings)
    ? rawRegistry.foreshadowings
    : Array.isArray(rawRegistry)
      ? rawRegistry
      : [];

  if (!source.length) {
    throw new Error("ForeshadowingAgent 没有返回有效的伏笔规划。");
  }

  return {
    foreshadowings: source.map((item, index) => {
      const plantAt = Math.max(1, Math.min(maxChapter, Number(item.plantAt || item.plannedPlantAt || 1) || 1));
      const payoffAt = Math.max(
        plantAt,
        Math.min(maxChapter, Number(item.payoffAt || item.intendedPayoffChapter || plantAt) || plantAt),
      );
      const waterAt = unique(
        (Array.isArray(item.waterAt) ? item.waterAt : [])
          .map((chapter) => Number(chapter) || 0)
          .filter((chapter) => chapter > plantAt && chapter < payoffAt)
          .sort((left, right) => left - right),
      );

      return {
        id: ensureNonEmptyString(item.id || `fsh_${String(index + 1).padStart(3, "0")}`, `foreshadowing.${index}.id`),
        type: "planned",
        description: ensureNonEmptyString(item.description, `foreshadowing.${index}.description`),
        planned_plant_chapter: chapterIdFromNumber(plantAt),
        intended_payoff: chapterIdFromNumber(payoffAt),
        intended_payoff_chapter: payoffAt,
        status: "planned",
        planted_chapter: null,
        planted_excerpt: null,
        resolved_chapter: null,
        resolved_excerpt: null,
        last_touched_chapter: null,
        urgency: "low",
        tags: ensureStringArray(item.tags, `foreshadowing.${index}.tags`, 1),
        history: [],
        waterAt,
      };
    }),
  };
}

function buildForeshadowingActionMap(registry) {
  const map = new Map();
  for (const item of registry.foreshadowings) {
    const allActions = [
      { chapter: chapterNumberFromId(item.planned_plant_chapter), action: "plant" },
      ...item.waterAt.map((chapter) => ({ chapter, action: "water" })),
      { chapter: item.intended_payoff_chapter, action: "resolve" },
    ];

    for (const task of allActions) {
      if (!map.has(task.chapter)) {
        map.set(task.chapter, []);
      }
      map.get(task.chapter).push({
        id: item.id,
        action: task.action,
        description: item.description,
      });
    }
  }
  return map;
}

function buildStructureMarkdown(stages, chapters) {
  if (!chapters.length) {
    return `# 结构规划\n\n${stages
      .map(
        (stage) =>
          `## ${stage.label}\n- 阶段目标：${stage.stageGoal || stage.purpose}\n- 阶段目的：${stage.purpose}\n- 章节范围：${stage.range[0]} ~ ${stage.range[1]}\n- 主要冲突：${(stage.stageConflicts || []).join(" / ") || "暂无"}\n`,
      )
      .join("\n")}`;
  }

  return `# 结构规划\n\n${stages
    .map((stage) => {
      const stageChapters = chapters.filter((chapter) => stage.chapters.includes(chapter.chapterId));
      return `## ${stage.label}\n- 目标：${stage.purpose}\n- 章节范围：${stage.range[0]} ~ ${stage.range[1]}\n\n${stageChapters
        .map(
          (chapter) =>
            `### ${chapter.chapterId} ${chapter.title}\n- POV：${chapter.povCharacter}\n- 场景：${chapter.location}\n- 事件：${chapter.keyEvents.join(" / ")}\n- 弧光：${chapter.arcContribution.join(" / ")}\n- 伏笔任务：${chapter.foreshadowingActions.length ? chapter.foreshadowingActions.map((item) => `${item.action}:${item.id}`).join("，") : "暂无"}\n- 章末钩子：${chapter.nextHook}`,
        )
        .join("\n\n")}`;
    })
    .join("\n\n")}\n`;
}

function buildMinorCharacterRegistry(chapters, knownNames) {
  const registry = new Map();

  for (const chapter of chapters) {
    for (const scene of chapter.scenes) {
      for (const name of scene.characters) {
        if (knownNames.has(name)) {
          continue;
        }

        if (!registry.has(name)) {
          registry.set(name, {
            name,
            role: "次要角色",
            firstAppearanceChapter: chapter.chapterId,
            lastAppearanceChapter: chapter.chapterId,
            chapterIds: new Set(),
            sceneIds: new Set(),
          });
        }

        const item = registry.get(name);
        item.lastAppearanceChapter = chapter.chapterId;
        item.chapterIds.add(chapter.chapterId);
        item.sceneIds.add(scene.id);
      }
    }

    for (const name of chapter.charactersPresent) {
      if (knownNames.has(name)) {
        continue;
      }

      if (!registry.has(name)) {
        registry.set(name, {
          name,
          role: "次要角色",
          firstAppearanceChapter: chapter.chapterId,
          lastAppearanceChapter: chapter.chapterId,
          chapterIds: new Set(),
          sceneIds: new Set(),
        });
      }

      const item = registry.get(name);
      item.lastAppearanceChapter = chapter.chapterId;
      item.chapterIds.add(chapter.chapterId);
    }
  }

  return Array.from(registry.values())
    .map((item) => {
      const chapterIds = [...item.chapterIds].sort();
      const sceneIds = [...item.sceneIds].sort();
      return {
        name: item.name,
        role: item.role,
        firstAppearanceChapter: item.firstAppearanceChapter,
        lastAppearanceChapter: item.lastAppearanceChapter,
        chapterIds,
        sceneIds,
        chapterCount: chapterIds.length,
        sceneCount: sceneIds.length,
        suggestedPromotion: chapterIds.length >= 3,
      };
    })
    .sort((left, right) => left.firstAppearanceChapter.localeCompare(right.firstAppearanceChapter));
}

export function buildStructure(project, cast, rawStructure, registry) {
  const totalChapters = Number(project.totalChapters) || 1;
  const expectedStageCount = Math.max(1, Number(project.stageCount) || 1);
  const rawChapters = Array.isArray(rawStructure?.chapters) ? rawStructure.chapters : [];
  const rawStages = Array.isArray(rawStructure?.stages) ? rawStructure.stages : [];

  if (!rawChapters.length && !rawStages.length) {
    throw new Error("StructureAgent 没有返回有效的阶段规划。");
  }

  const actionMap = buildForeshadowingActionMap(registry);
  const knownNames = new Set(cast.map((character) => character.name));
  const chapters = rawChapters
    .map((chapter, index) => {
      const chapterNumber = Number(chapter.chapterNumber || index + 1);
      const chapterId = chapterIdFromNumber(chapterNumber);
      const scenes = ensureStringArray(
        (chapter.scenes || []).map((scene) =>
          scene && typeof scene === "object"
            ? JSON.stringify(scene)
            : "",
        ),
        `${chapterId}.scenes`,
        2,
      ).map((serialized, sceneIndex) => {
        const scene = JSON.parse(serialized);
        const sceneCharacters = ensureStringArray(scene.characters, `${chapterId}.scene${sceneIndex + 1}.characters`, 1);
        return {
          id: `${chapterId}_scene_${sceneIndex + 1}`,
          label: ensureNonEmptyString(scene.label || `场景${sceneIndex + 1}`, `${chapterId}.scene${sceneIndex + 1}.label`),
          location: ensureNonEmptyString(scene.location || chapter.location, `${chapterId}.scene${sceneIndex + 1}.location`),
          focus: ensureNonEmptyString(scene.focus, `${chapterId}.scene${sceneIndex + 1}.focus`),
          tension: ensureNonEmptyString(scene.tension, `${chapterId}.scene${sceneIndex + 1}.tension`),
          characters: sceneCharacters,
        };
      });
      const charactersPresent = unique([
        ...ensureStringArray(chapter.charactersPresent || chapter.characters_present, `${chapterId}.charactersPresent`, 2),
        ...scenes.flatMap((scene) => scene.characters),
      ]);
      const povCharacter = ensureNonEmptyString(chapter.povCharacter, `${chapterId}.povCharacter`);
      if (!knownNames.has(povCharacter)) {
        throw new Error(`${chapterId} 的 POV 角色必须来自 cast：${povCharacter}`);
      }

      return {
        chapterId,
        chapterNumber,
        title: ensureNonEmptyString(chapter.title, `${chapterId}.title`),
        stage: ensureNonEmptyString(chapter.stage || chapter.stageLabel, `${chapterId}.stage`),
        timeInStory: ensureNonEmptyString(chapter.timeInStory, `${chapterId}.timeInStory`),
        povCharacter,
        location: ensureNonEmptyString(chapter.location, `${chapterId}.location`),
        keyEvents: ensureStringArray(chapter.keyEvents, `${chapterId}.keyEvents`, 2),
        arcContribution: ensureStringArray(chapter.arcContribution, `${chapterId}.arcContribution`, 1),
        nextHook: ensureNonEmptyString(chapter.nextHook, `${chapterId}.nextHook`),
        emotionalTone: ensureNonEmptyString(chapter.emotionalTone, `${chapterId}.emotionalTone`),
        charactersPresent,
        foreshadowingActions: actionMap.get(chapterNumber) || [],
        continuityAnchors: ensureStringArray(chapter.continuityAnchors, `${chapterId}.continuityAnchors`, 1),
        scenes,
      };
    })
    .sort((left, right) => left.chapterNumber - right.chapterNumber);

  if (chapters.length && chapters.length !== totalChapters) {
    throw new Error(`StructureAgent 返回的章纲数量为 ${chapters.length}，但项目要求 ${totalChapters} 章。`);
  }

  const stageSource = rawStages.length
    ? rawStages
    : unique(chapters.map((chapter) => chapter.stage)).map((label) => ({
        label,
        purpose: `${label} 负责推进本阶段核心矛盾与人物变化。`,
      }));

  const stages = stageSource.map((stage, index) => {
    const label = ensureNonEmptyString(stage.label, `stage.${index + 1}.label`);
    const chapterStart = Number(stage.chapterStart || stage.range?.[0] || 0);
    const chapterEnd = Number(stage.chapterEnd || stage.range?.[1] || 0);
    const stageChapters = chapters.filter((chapter) => chapter.stage === label);
    if (!stageChapters.length && (!chapterStart || !chapterEnd)) {
      throw new Error(`阶段 ${label} 缺少章节范围。`);
    }

    const range = stageChapters.length
      ? [stageChapters[0].chapterNumber, stageChapters.at(-1).chapterNumber]
      : [chapterStart, chapterEnd];
    const chapterIds = stageChapters.length
      ? stageChapters.map((chapter) => chapter.chapterId)
      : Array.from({ length: range[1] - range[0] + 1 }, (_, offset) => chapterIdFromNumber(range[0] + offset));

    return {
      stageId: `stage_${index + 1}`,
      label,
      purpose: ensureNonEmptyString(stage.purpose, `stage.${index + 1}.purpose`),
      chapters: chapterIds,
      range,
      stageGoal: String(stage.stageGoal || "").trim(),
      stageConflicts: ensureStringArray(stage.stageConflicts || [], `stage.${index + 1}.stageConflicts`, 0),
    };
  });

  if (stages.length !== expectedStageCount) {
    throw new Error(`StructureAgent 返回的阶段数量为 ${stages.length}，但项目要求 ${expectedStageCount} 个阶段。`);
  }

  const minorCharacters = chapters.length ? buildMinorCharacterRegistry(chapters, knownNames) : [];

  return {
    stages,
    chapters,
    minorCharacters,
    structureMarkdown: buildStructureMarkdown(stages, chapters),
  };
}

export function buildWorldbuilding(project, outlineDraft) {
  const markdown = `# 世界观设定\n\n## 项目定位\n- 标题：${project.title}\n- 类型：${project.genre}\n- 背景：${project.setting}\n- 主题：${project.theme}\n\n## 大纲对接\n${outlineDraft.roughSections
    .map((section) => `- ${section.stage}：${section.content}`)
    .join("\n")}\n`;

  return markdown;
}

export function buildCharacterArtifacts(project, cast, structureData) {
  return cast.map((character) => {
    const relatedChapters = structureData.chapters.filter((chapter) =>
      chapter.charactersPresent.includes(character.name),
    );
    const firstStage = relatedChapters[0]?.stage || "阶段1";
    const lastStage = relatedChapters[relatedChapters.length - 1]?.stage || "阶段4";

    const biographyMarkdown = `# ${character.name}·人物小传\n\n${character.name}是本作中的${character.role}。Ta的核心欲望是“${character.desire}”，核心伤口是“${character.wound}”。在故事开始时，${character.name}最习惯的自我保护方式是：${character.blindspot}。\n\n外在辨识度：${character.appearance}\n\n叙事功能：\n- 承接${character.role}对应的情感与行动压力\n- 在主线推进中不断迫使${project.protagonistName}重新做选择\n- 通过个人立场展示“${project.theme}”在不同层面的折射\n`;

    const profileMarkdown = `# ${character.name}·人物资料卡\n\n- 角色定位：${character.role}\n- 性格标签：${character.tags.join(" / ")}\n- 说话方式：${character.voice}\n- 当前最大诉求：${character.desire}\n- 最大盲点：${character.blindspot}\n- 标志物：${character.signatureItem}\n- 初始登场位置：${character.entryLocation}\n`;

    const storylineMarkdown = `# ${character.name}·人物线\n\n- 起点：${firstStage}里，${character.name}主要通过“${character.desire}”与主线接轨。\n- 中段：Ta会在${project.theme}的压力下暴露自己的伤口与立场裂缝。\n- 高点：与${project.protagonistName}的关系在关键章节出现重新定义。\n- 终点：${lastStage}里，${character.name}必须兑现此前所有立场，不再有模糊空间。\n- 关键章节：${relatedChapters
      .slice(0, 6)
      .map((chapter) => `${chapter.chapterId} ${chapter.title}`)
      .join(" / ")}\n`;

    const state = {
      name: character.name,
      updated_after_chapter: "ch000",
      physical: {
        location: character.entryLocation,
        health: "良好",
        appearance_notes: character.appearance,
      },
      psychological: {
        current_goal: character.desire,
        emotional_state: "故事开始前，角色还在为主线压力做准备。",
        stress_level: character.roleKey === "antagonist" ? 2 : 4,
        key_beliefs: [
          "任何关键选择都伴随代价。",
          `角色对“${project.theme.split("、")[0] || project.theme}”有自己的理解。`,
        ],
      },
      relationships: character.relationships,
      knowledge: {
        knows: [
          `${project.setting}的当前局势会持续影响主要人物。`,
          `${project.protagonistName === character.name ? "自己" : project.protagonistName}已经被卷入主线。`,
        ],
        does_not_know: [
          `${project.antagonistName}尚未完全暴露的底牌。`,
          "主线未来会怎样全面扩张。",
        ],
      },
      inventory_and_resources: {
        money: character.roleKey === "antagonist" ? "充足" : "有限但可支配",
        key_items: [character.signatureItem],
      },
      arc_progress: {
        current_phase: "故事开始前夜",
        arc_note: `${character.name}还未被迫面对自己的核心伤口。`,
      },
    };

    return {
      ...character,
      biographyMarkdown,
      profileMarkdown,
      storylineMarkdown,
      state,
    };
  });
}

export function buildOutlineData(project, outlineDraft, structureData, characters) {
  return {
    title: project.title,
    coreHook: outlineDraft.coreHook,
    shortSynopsis: outlineDraft.shortSynopsis,
    roughSections: outlineDraft.roughSections,
    stages: structureData.stages,
    chapters: Array.isArray(structureData.chapters) ? structureData.chapters : [],
    minorCharacters: structureData.minorCharacters || [],
    characterArcs: characters.map((character) => ({
      name: character.name,
      role: character.role,
      summary: createExcerpt(character.storylineMarkdown, 200),
    })),
  };
}

export function buildFinalOutlineMarkdown(outlineDraft, structureData, characters) {
  const stagesMarkdown = structureData.stages
    .map((stage) => {
      const chapters = structureData.chapters.filter((chapter) =>
        stage.chapters.includes(chapter.chapterId),
      );
      const chapterBlock = chapters.length
        ? chapters
          .map(
            (chapter) =>
              `- ${chapter.chapterId} ${chapter.title} | POV:${chapter.povCharacter} | 事件:${chapter.keyEvents.join("；")} | 钩子:${chapter.nextHook}`,
          )
          .join("\n")
        : `- 章节范围：${stage.range[0]}-${stage.range[1]}\n- 阶段目标：${stage.stageGoal || stage.purpose}\n- 主要冲突：${(stage.stageConflicts || []).join("；") || "暂无"}`;
      return `### ${stage.label}\n- 目标：${stage.purpose}\n${chapterBlock}`;
    })
    .join("\n\n");

  return `# 锁定大纲\n\n## 一句话核心梗\n${outlineDraft.coreHook}\n\n## 简纲\n${outlineDraft.shortSynopsis}\n\n## 粗纲\n${outlineDraft.roughSections
    .map((section) => `### ${section.stage}\n${section.content}`)
    .join("\n\n")}\n\n## 阶段规划\n${stagesMarkdown}\n\n## 主要人物弧光\n${characters
    .map((character) => `- ${character.name}（${character.role}）：${createExcerpt(character.storylineMarkdown, 120)}`)
    .join("\n")}\n`;
}

export function buildInitialWorldState(project, structureData) {
  if (!Array.isArray(structureData?.chapters) || !structureData.chapters.length) {
    const firstStage = Array.isArray(structureData?.stages) ? structureData.stages[0] : null;
    const nextStage = Array.isArray(structureData?.stages) ? structureData.stages[1] : null;

    return {
      current_story_time: "故事开始前",
      current_primary_location: project.setting,
      active_plotlines: [
        {
          id: "plot_main",
          name: createExcerpt(`${project.protagonistName}围绕主线目标展开行动`, 60),
          status: "进行中",
          progress_note: firstStage?.stageGoal || project.protagonistGoal,
        },
        {
          id: "plot_secondary",
          name: createExcerpt(`${project.protagonistName}与关键关系线的站位变化`, 60),
          status: "进行中",
          progress_note: firstStage?.purpose || project.theme,
        },
        {
          id: "plot_pressure",
          name: createExcerpt(`${project.antagonistName}代表的压力正在逼近`, 60),
          status: "潜行中",
          progress_note: (firstStage?.stageConflicts || [project.premise]).filter(Boolean)[0] || project.premise,
        },
      ],
      public_knowledge: [
        firstStage?.purpose || project.setting,
        firstStage?.stageGoal || project.protagonistGoal,
      ].filter(Boolean),
      secret_knowledge: (firstStage?.stageConflicts || []).slice(0, 2),
      recent_major_events: [
        { chapter: "ch000", event: firstStage?.stageGoal || project.protagonistGoal },
      ],
      upcoming_anchors: nextStage
        ? [{ chapter: chapterIdFromNumber(nextStage.range?.[0] || 1), anchor: nextStage.stageGoal || nextStage.label }]
        : [],
    };
  }

  const firstChapter = structureData.chapters[0];
  const upcoming = structureData.chapters[1];
  const protagonist = firstChapter.povCharacter;
  const rival = structureData.chapters.find((chapter) => chapter.charactersPresent.includes(project.rivalName));
  const antagonist = structureData.chapters.find((chapter) => chapter.charactersPresent.includes(project.antagonistName));

  return {
    current_story_time: firstChapter.timeInStory,
    current_primary_location: firstChapter.location,
    active_plotlines: [
      {
        id: "plot_main",
        name: createExcerpt(`${protagonist}围绕主线目标展开行动`, 60),
        status: "进行中",
        progress_note: firstChapter.keyEvents[0],
      },
      {
        id: "plot_secondary",
        name: createExcerpt(`${project.protagonistName}与关键关系线的站位变化`, 60),
        status: "进行中",
        progress_note: rival?.arcContribution?.[0] || firstChapter.arcContribution[0],
      },
      {
        id: "plot_pressure",
        name: createExcerpt(`${project.antagonistName}代表的压力正在逼近`, 60),
        status: "潜行中",
        progress_note: antagonist?.nextHook || firstChapter.nextHook,
      },
    ],
    public_knowledge: firstChapter.keyEvents.slice(0, 2),
    secret_knowledge: firstChapter.continuityAnchors.slice(0, 2),
    recent_major_events: [
      { chapter: "ch000", event: firstChapter.keyEvents[0] },
    ],
    upcoming_anchors: upcoming
      ? [{ chapter: upcoming.chapterId, anchor: upcoming.nextHook }]
      : [],
  };
}

function sanitizeSceneDraftMarkdown(markdown = "") {
  const normalized = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const filtered = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /^#{2,}\s*场景/.test(trimmed) ||
      /^场景\d+[：:]/.test(trimmed) ||
      /^写作备注：/.test(trimmed) ||
      /^人工修订重点：/.test(trimmed) ||
      /^修订补笔：/.test(trimmed) ||
      /^本章的节奏基调保持在/.test(trimmed)
    ) {
      continue;
    }
    filtered.push(line);
  }

  return filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function createSceneDraft({
  chapterPlan,
  scene,
  sceneIndex,
  foreshadowingSummary = "",
  historyPacket,
  revisionNotes = [],
  overrideText,
}) {
  if (overrideText) {
    return {
      sceneId: scene.id,
      sceneLabel: scene.label,
      location: scene.location,
      markdown: sanitizeSceneDraftMarkdown(overrideText),
    };
  }

  const continuityAnchor =
    historyPacket.continuityAnchors[sceneIndex] || chapterPlan.continuityAnchors[sceneIndex] || "";
  const keyEvent = chapterPlan.keyEvents[sceneIndex] || chapterPlan.keyEvents.at(-1);
  const rewriteFocus = revisionNotes.length
    ? `这一次，${chapterPlan.povCharacter}格外留意“${revisionNotes.join("；")}”带来的情绪变化。`
    : "";
  const scenePresence = scene.characters?.length
    ? `${scene.characters.join("、")}都在场，彼此的站位和沉默本身就是压力。`
    : "在场人物的每一次停顿都让局势更紧。";
  const foreshadowingAnchor = foreshadowingSummary
    ? `本章还要处理这些伏笔任务：${foreshadowingSummary}。`
    : "";

  const markdown = [
    `${scene.location}的空气里带着潮湿与金属味，${continuityAnchor || "灯光把每个人的情绪都照得更清楚"}。${chapterPlan.povCharacter}沿着“${scene.focus}”这条线推进时，注意力始终扣在当前目标上。${scenePresence}${rewriteFocus}`,
    `${chapterPlan.charactersPresent[1] || "对方"}很快把局势往更锋利的方向推去。对方先一步试探，${chapterPlan.povCharacter}没有立刻给出答案，只把目光落在最不愿被提起的细节上。 foreshadowingAnchor`,
    `这一场碰撞最终落在“${keyEvent}”上。${chapterPlan.povCharacter}意识到，眼前的人与事并不是孤立发生，真正逼近自己的，是${chapterPlan.arcContribution[sceneIndex % chapterPlan.arcContribution.length]}。当她离开${scene.location}时，脑海里只剩下一个更明确的念头：${chapterPlan.nextHook}`,
  ]
    .join("\n")
    .replace(" foreshadowingAnchor", foreshadowingAnchor ? ` ${foreshadowingAnchor}` : "");

  return {
    sceneId: scene.id,
    sceneLabel: scene.label,
    location: scene.location,
    markdown,
  };
}

export function assembleChapterMarkdown(title, sceneDrafts, revisionNotes = [], chapterPlan) {
  const paragraphs = [`# ${title}`, ""];

  for (const draft of sceneDrafts) {
    paragraphs.push(sanitizeSceneDraftMarkdown(draft.markdown));
    paragraphs.push("");
  }

  return paragraphs.join("\n");
}

export function reorderChapterScenes(chapterPlan, desiredOrder = []) {
  if (!desiredOrder.length) {
    return chapterPlan;
  }

  const sceneMap = new Map(chapterPlan.scenes.map((scene) => [scene.id, scene]));
  const ordered = [];

  for (const sceneId of desiredOrder) {
    if (sceneMap.has(sceneId)) {
      ordered.push(sceneMap.get(sceneId));
      sceneMap.delete(sceneId);
    }
  }

  for (const scene of chapterPlan.scenes) {
    if (sceneMap.has(scene.id)) {
      ordered.push(scene);
      sceneMap.delete(scene.id);
    }
  }

  return {
    ...chapterPlan,
    scenes: ordered,
  };
}

export function buildChapterDraft(
  chapterPlan,
  foreshadowingSummary,
  historyPacket,
  revisionNotes = [],
) {
  const sceneDrafts = chapterPlan.scenes.map((scene, index) =>
    createSceneDraft({
      chapterPlan,
      scene,
      sceneIndex: index,
      foreshadowingSummary,
      historyPacket,
      revisionNotes,
    }),
  );
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

export function runValidations(chapterPlan, chapterDraft, project = null) {
  const issues = {
    consistency: [],
    plausibility: [],
    foreshadowing: [],
    style: [],
  };

  for (const event of chapterPlan.keyEvents) {
    const requiredToken = extractKeywords(event)[0] || event.slice(0, 6);
    if (!chapterDraft.markdown.includes(requiredToken)) {
      issues.consistency.push(`正文中未清晰体现事件“${event}”。`);
    }
  }

  if (!chapterPlan.charactersPresent.some((name) => chapterDraft.markdown.includes(name))) {
    issues.plausibility.push("正文里对登场角色的呈现偏弱。");
  }

  if (chapterPlan.foreshadowingActions.length !== chapterDraft.usedForeshadowings.length) {
    issues.foreshadowing.push("写作中没有完整承接本章计划中的伏笔动作。");
  }

  if ((chapterDraft.markdown.match(/突然/g) || []).length > 2) {
    issues.style.push("“突然”使用次数过多。");
  }

  if (!chapterDraft.markdown.startsWith(`# ${chapterPlan.title}`)) {
    issues.style.push("章节标题格式不正确。");
  }

  if (/写作备注：|人工修订重点：|修订补笔：|本章的节奏基调保持在|^##\s*场景/m.test(chapterDraft.markdown)) {
    issues.style.push("正文泄漏了系统元信息或场景标题。");
  }

  if (/第三人称/.test(project?.styleNotes || "")) {
    const narrativeOnly = chapterDraft.markdown.replace(/“[^”]*”/g, "");
    const firstPersonNarrationCount = (narrativeOnly.match(/(^|[。！？\n])\s*我/g) || []).length;
    if (firstPersonNarrationCount >= 2) {
      issues.style.push("正文叙述视角偏向第一人称，未保持第三人称有限视角。");
    }
  }

  return {
    consistency: {
      passed: issues.consistency.length === 0,
      issues: issues.consistency,
      summary: issues.consistency.length
        ? issues.consistency.join("；")
        : "连续性锚点、事件顺序与章节计划一致。",
    },
    plausibility: {
      passed: issues.plausibility.length === 0,
      issues: issues.plausibility,
      summary: issues.plausibility.length
        ? issues.plausibility.join("；")
        : "角色动机和行为没有明显违和。",
    },
    foreshadowing: {
      passed: issues.foreshadowing.length === 0,
      issues: issues.foreshadowing,
      summary: issues.foreshadowing.length
        ? issues.foreshadowing.join("；")
        : "伏笔植入与收线任务已被承接。",
    },
    style: {
      passed: issues.style.length === 0,
      issues: issues.style,
      summary: issues.style.length ? issues.style.join("；") : "文风和格式保持稳定。",
    },
    overallPassed:
      issues.consistency.length === 0 &&
      issues.plausibility.length === 0 &&
      issues.foreshadowing.length === 0 &&
      issues.style.length === 0,
  };
}

export function reviseChapterDraft(chapterPlan, chapterDraft, validation) {
  const missingLines = [
    ...validation.consistency.issues,
    ...validation.plausibility.issues,
    ...validation.foreshadowing.issues,
    ...validation.style.issues,
  ];

  if (!missingLines.length) {
    return chapterDraft;
  }

  const repairedScenes = (chapterDraft.sceneDrafts || []).map((scene) => ({
    ...scene,
    markdown: sanitizeSceneDraftMarkdown(scene.markdown.replace(/突然/g, "霎时")),
  }));
  return {
    ...chapterDraft,
    sceneDrafts: repairedScenes,
    markdown: assembleChapterMarkdown(
      chapterPlan.title,
      repairedScenes,
      { foreshadowingSummary: chapterDraft.usedForeshadowings?.join("，") || "本章无硬性伏笔任务" },
      [],
      chapterPlan,
    ).replace(/突然/g, "霎时"),
  };
}

function adjustRelationship(base, deltaCloseness, deltaTrust, note) {
  return {
    closeness: Math.max(0, Math.min(10, (base?.closeness || 0) + deltaCloseness)),
    trust: Math.max(0, Math.min(10, (base?.trust || 0) + deltaTrust)),
    dynamic: note || base?.dynamic || "关系仍在变化中",
  };
}

export function updateCharacterStates(currentStates, chapterPlan, project) {
  const byName = Object.fromEntries(currentStates.map((state) => [state.name, state]));
  const updated = currentStates.map((state) => {
    if (!chapterPlan.charactersPresent.includes(state.name)) {
      return state;
    }

    const clone = JSON.parse(JSON.stringify(state));
    clone.updated_after_chapter = chapterPlan.chapterId;
    clone.physical.location = chapterPlan.scenes.at(-1)?.location || chapterPlan.location;
    clone.psychological.current_goal = chapterPlan.nextHook.replace(/。$/, "");
    clone.psychological.emotional_state = chapterPlan.emotionalTone;
    clone.psychological.stress_level = Math.min(
      9,
      Number(clone.psychological.stress_level || 3) + (chapterPlan.stage.includes("裂缝") ? 2 : 1),
    );
    clone.knowledge.knows = unique([
      ...(clone.knowledge.knows || []),
      ...chapterPlan.keyEvents.slice(0, 2),
    ]);
    clone.arc_progress.current_phase = chapterPlan.stage;
    clone.arc_progress.arc_note = chapterPlan.arcContribution.join("；");

    for (const otherName of chapterPlan.charactersPresent.filter((name) => name !== state.name)) {
      clone.relationships[otherName] = adjustRelationship(
        clone.relationships[otherName],
        otherName === project.antagonistName ? -1 : 1,
        otherName === project.antagonistName ? -1 : 1,
        otherName === project.antagonistName
          ? "本章对立更明确了。"
          : "并肩推进让关系向前了一步。",
      );
      clone.relationships[otherName].last_interaction_chapter = chapterPlan.chapterId;
      clone.relationships[otherName].last_interaction_summary = chapterPlan.keyEvents[0];
    }

    return clone;
  });

  return updated.map((state) => byName[state.name] ? state : byName[state.name]);
}

export function buildChapterMeta(chapterPlan, chapterDraft, updatedCharacterStates) {
  const characterStateChanges = {};
  for (const state of updatedCharacterStates) {
    if (!chapterPlan.charactersPresent.includes(state.name)) {
      continue;
    }
    characterStateChanges[state.name] = [
      `情绪转为${state.psychological.emotional_state}`,
      `新目标：${state.psychological.current_goal}`,
    ];
  }

  return {
    chapter_id: chapterPlan.chapterId,
    title: chapterPlan.title,
    stage: chapterPlan.stage,
    time_in_story: chapterPlan.timeInStory,
    pov_character: chapterPlan.povCharacter,
    location: chapterPlan.location,
    next_hook: chapterPlan.nextHook,
    summary_50: createExcerpt(chapterPlan.keyEvents.join("；"), 50),
    summary_200: createExcerpt(`${chapterPlan.keyEvents.join("；")} ${chapterPlan.nextHook}`, 200),
    characters_present: chapterPlan.charactersPresent,
    key_events: chapterPlan.keyEvents,
    emotional_tone: chapterPlan.emotionalTone,
    foreshadowing_planted: chapterPlan.foreshadowingActions
      .filter((item) => item.action === "plant")
      .map((item) => item.id),
    foreshadowing_resolved: chapterPlan.foreshadowingActions
      .filter((item) => item.action === "resolve")
      .map((item) => item.id),
    character_state_changes: characterStateChanges,
    continuity_anchors: chapterPlan.continuityAnchors,
    word_count: countWordsApprox(chapterDraft.markdown),
  };
}

export function updateWorldState(previousWorldState, chapterPlan, structureData) {
  const chapterIndex = structureData.chapters.findIndex((chapter) => chapter.chapterId === chapterPlan.chapterId);
  const nextChapter = structureData.chapters[chapterIndex + 1];

  return {
    ...previousWorldState,
    current_story_time: chapterPlan.timeInStory,
    current_primary_location: chapterPlan.scenes.at(-1)?.location || chapterPlan.location,
    recent_major_events: [
      ...(previousWorldState.recent_major_events || []).slice(-4),
      { chapter: chapterPlan.chapterId, event: chapterPlan.keyEvents[0] },
    ],
    upcoming_anchors: nextChapter
      ? [{ chapter: nextChapter.chapterId, anchor: nextChapter.nextHook }]
      : [],
    active_plotlines: (previousWorldState.active_plotlines || []).map((plot, index) => ({
      ...plot,
      progress_note:
        index === 0 ? chapterPlan.keyEvents[0] : index === 1 ? chapterPlan.arcContribution[1] : chapterPlan.nextHook,
    })),
  };
}

function urgencyFor(item, currentChapterNumber) {
  const remaining = item.intended_payoff_chapter - currentChapterNumber;
  if (remaining <= 2) {
    return "high";
  }
  if (remaining <= 5) {
    return "medium";
  }
  return "low";
}

export function updateForeshadowingRegistry(registry, chapterPlan, chapterDraft) {
  const currentChapterNumber = chapterPlan.chapterNumber;

  return {
    foreshadowings: registry.foreshadowings.map((item) => {
      const action = chapterPlan.foreshadowingActions.find((candidate) => candidate.id === item.id);
      const clone = { ...item, history: [...(item.history || [])] };
      clone.urgency = urgencyFor(clone, currentChapterNumber);

      if (!action) {
        return clone;
      }

      clone.last_touched_chapter = chapterPlan.chapterId;
      clone.history.push({
        chapter: chapterPlan.chapterId,
        action: action.action,
        excerpt: createExcerpt(chapterDraft.markdown, 120),
      });

      if (action.action === "plant") {
        clone.status = "planted";
        clone.planted_chapter = chapterPlan.chapterId;
        clone.planted_excerpt = createExcerpt(chapterDraft.markdown, 120);
      }

      if (action.action === "water") {
        clone.status = clone.status === "planned" ? "planted" : clone.status;
      }

      if (action.action === "resolve") {
        clone.status = "resolved";
        clone.resolved_chapter = chapterPlan.chapterId;
        clone.resolved_excerpt = createExcerpt(chapterDraft.markdown, 120);
      }

      return clone;
    }),
  };
}

export function buildStyleGuide(project, firstChapterDraft) {
  return `# 风格指南（自动提取自第1章）\n\n## 叙述视角与人称\n- 第三人称有限视角，重点跟随${project.protagonistName}\n- 内心描写以内嵌叙述完成，不用额外括号\n\n## 语言风格\n- ${project.styleNotes}\n- 对话要让角色的控制力、试探和留白有辨识度\n- 保持网络小说节奏感，但不滑向现代口癖堆叠\n\n## 节奏特点\n- 每章至少包含一个“信息推进点”、一个“关系推进点”、一个“章末牵引点”\n- 场景中优先使用动作和对话推进，环境描写负责托底氛围\n- 长段抒情不能盖过线索推进\n\n## 禁忌\n- “突然”控制在每章 2 次以内\n- 不用廉价眼泪词替代角色选择\n- 不让角色为了推进剧情而说出自己尚未知晓的内容\n\n## 第1章特征摘要\n- 首章字数（模拟）：${countWordsApprox(firstChapterDraft.markdown)}\n- 首章收束方式：${createExcerpt(firstChapterDraft.markdown.split("\n").slice(-3).join(" "), 120)}\n`;
}
