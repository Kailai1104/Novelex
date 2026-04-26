import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createEmptyOpeningReferencePacket,
  mergeOpeningIntoWriterContext,
  scopeOpeningReferencePacket,
} from "../src/opening/reference.js";
import {
  createEmptyReferencePacket,
  mergeReferenceIntoWriterContext,
  normalizeReferenceSignalList,
} from "../src/rag/reference.js";
import { buildWriterPromptPacket } from "../src/orchestration/write.js";
import { createStore } from "../src/utils/store.js";

function baseProject() {
  return {
    title: "测试作品",
    protagonistName: "李凡",
    targetWordsPerChapter: 4000,
  };
}

function baseChapterPlan() {
  return {
    chapterId: "ch002",
    chapterNumber: 2,
    title: "第二章：舵链",
    povCharacter: "林定海",
    dominantThread: "林定海当众授权李凡分派任务，同时内部质疑与外部危机一起升级。",
    threadMode: "single_spine",
    entryLink: "承接上一章追兵暂退但天亮后会返航的压力。",
    exitPressure: "追兵再逼近，船体半残，内部信任仍未稳住。",
    nextHook: "更大的决断已经逼到眼前。",
    keyEvents: [
      "李凡检查舵链并判断可修复性",
      "林定海当众授权李凡分派任务",
      "马会魁公开质疑并被外部危机打断",
    ],
    charactersPresent: ["李凡", "林定海", "马会魁", "众水手"],
    continuityAnchors: [
      "林定海对李凡仍是紧迫性采纳而非信任",
      "船体半残且舵链断裂",
    ],
    scenes: [
      {
        id: "scene_1",
        label: "检查舵链",
        focus: "让李凡用具体动作完成第一次技术判断",
        characters: ["李凡", "林定海", "众水手"],
        outcome: "众人看到李凡不是空口说白话",
        handoffToNext: "林定海必须决定是否把调度权交给李凡",
      },
      {
        id: "scene_2",
        label: "当众授权",
        focus: "林定海在紧迫局势下把任务分派权交给李凡",
        characters: ["李凡", "林定海", "马会魁", "众水手"],
        outcome: "权力关系开始发生变化",
        handoffToNext: "马会魁把敌意抬到台面上",
      },
    ],
  };
}

function baseHistoryPacket() {
  return {
    lastEnding: "上一章末尾，追兵暂退但天亮后会返航。",
    continuityAnchors: [
      "追兵暂退但天亮后会返航",
      "船体半残状态没有解除",
    ],
  };
}

function baseWriterContext() {
  return {
    chapterId: "ch002",
    priorities: ["把授权写成紧迫性采纳，而不是完全信任。"],
    risks: ["不要重复开场，不要把同一场危机从头再演一遍。"],
    selectedSources: [],
    planContextSummary: "计划摘要",
    historyContextSummary: "历史摘要",
    factSummary: "",
    referenceSignals: [],
    openingSignals: [],
  };
}

function baseGovernance() {
  return {
    ruleStack: {
      hardFacts: [
        "POV稳定在 林定海",
        "林定海对李凡仍是紧迫性采纳，而非完全信任",
      ],
      currentTask: [
        "让授权和危机升级落地",
      ],
      deferRules: [
        "不要提前兑现全部通敌嫌疑洗清",
      ],
    },
  };
}

test("normalizeReferenceSignalList removes object noise and keeps readable text", () => {
  const signals = normalizeReferenceSignalList([
    "触觉前置",
    { summary: "先动作后判断" },
    ["", { description: "避免表格化物证描写" }],
    null,
    { ignored: { text: "保留可读嵌套内容" } },
  ], 10);

  assert.equal(signals.includes("触觉前置"), true);
  assert.equal(signals.includes("先动作后判断"), true);
  assert.equal(signals.includes("避免表格化物证描写"), true);
  assert.equal(signals.some((item) => item.includes("保留可读嵌套内容")), true);
  assert.equal(signals.some((item) => item.includes("[object Object]")), false);
});

test("chapter 2 opening references are abstracted before reaching writer-visible prompt", () => {
  const scopedOpeningPacket = scopeOpeningReferencePacket(createEmptyOpeningReferencePacket({
    triggered: true,
    mode: "chapter_write",
    summary: "旧摘要",
    matches: [
      {
        collectionId: "fixture",
        collectionName: "fixture",
        sourcePath: "fixture.txt",
        excerpt: "陈新和刘民有抢药农衣服。",
      },
    ],
    conflictIgnitionPatterns: [
      "生存型冲突：抢劫药农衣服，解决衣不蔽体问题",
      "道德型冲突：刘民有质疑，陈新回应",
    ],
    chapterEndHookPatterns: [
      "第一章结尾钩子：还要抢这些百姓的东西么",
    ],
    structuralBeats: [
      "Beat 2（第二章）：进入村庄→身份渗透→首次原住民接触",
    ],
  }), {
    chapterNumber: 2,
    freshStart: false,
  });
  const writerContext = mergeOpeningIntoWriterContext(baseWriterContext(), scopedOpeningPacket);
  const promptPacket = buildWriterPromptPacket({
    project: baseProject(),
    chapterPlan: baseChapterPlan(),
    historyPacket: baseHistoryPacket(),
    writerContextPacket: writerContext,
    openingReferencePacket: scopedOpeningPacket,
    governance: baseGovernance(),
    characterDossiers: [],
    styleGuideText: "- 第三人称有限视角\n- 对白与动作推进\n- 长句很多，必要时可拉远评述",
  });

  assert.equal(/陈新|刘民有|药农|抢劫药农|Beat 2/u.test(promptPacket.markdown), false);
  assert.equal(
    scopedOpeningPacket.structuralBeats.some((item) => /Beat 2|进入村庄|身份渗透/u.test(item)),
    false,
  );
  assert.match(promptPacket.markdown, /承接上一章余波|当章行动试探/u);
});

test("compact writer prompt excludes raw context markdown and includes pacing contract", () => {
  const promptPacket = buildWriterPromptPacket({
    project: baseProject(),
    chapterPlan: baseChapterPlan(),
    historyPacket: {
      ...baseHistoryPacket(),
      briefingMarkdown: "HISTORY_RAW_MARKER",
    },
    writerContextPacket: {
      ...baseWriterContext(),
      briefingMarkdown: "WRITER_RAW_MARKER",
      planContextSummary: "计划摘要",
      historyContextSummary: "历史摘要",
      referenceSignals: ["短促动作推进"],
      openingSignals: ["承接上一章余波后再升级冲突"],
    },
    governance: baseGovernance(),
    characterDossiers: [
      {
        name: "李凡",
        markdown: [
          "### 李凡",
          "- 说话方式：短句、克制、先给判断再给解释",
          "- 核心欲望：活下来并拿到调度权",
          "- 核心伤口：失控恐惧",
          "- 当前情绪：绷紧",
        ].join("\n"),
      },
    ],
    characterStateSummary: "- 李凡：目标=活下来；情绪=绷紧；位置=甲板",
    researchPacket: {
      briefingMarkdown: "RESEARCH_RAW_MARKER",
      factsToUse: ["链环锈蚀只能写感官判断，不写精确参数"],
      factsToAvoid: ["不要写成拉力值报告"],
      uncertainPoints: ["具体尺寸未核实"],
      termBank: ["帘纹：纸张表面纹理"],
    },
    referencePacket: {
      ...createEmptyReferencePacket(),
      briefingMarkdown: "REFERENCE_RAW_MARKER",
      warnings: ["范文只借方法，不借句子"],
    },
    openingReferencePacket: {
      ...createEmptyOpeningReferencePacket(),
      briefingMarkdown: "OPENING_RAW_MARKER",
      warnings: ["非开篇章节只借抽象结构"],
    },
    styleGuideText: [
      "# 风格",
      "- 以第三人称有限视角为主。",
      "- 优先让动作和对白推进。",
      "- 不要写元话语和提纲感总结。",
      "- 长句很多，必要时会拉远补背景说明。",
    ].join("\n"),
    factContext: {
      establishedFacts: [
        { factId: "fact_1", subject: "林定海", assertion: "对李凡是紧迫性采纳而非信任" },
      ],
      openTensions: [
        { factId: "tension_1", subject: "追兵", assertion: "天亮后会再次逼近" },
      ],
    },
  });

  assert.match(promptPacket.markdown, /目标篇幅约 4000 字/u);
  assert.match(promptPacket.markdown, /## 时间合同/u);
  assert.match(promptPacket.markdown, /每场只兑现一个主要新增变化/u);
  assert.match(promptPacket.markdown, /1≈2000字/u);
  assert.match(promptPacket.markdown, /- 必须出场：李凡、林定海、马会魁/u);
  assert.match(promptPacket.markdown, /本章必须让以下具名角色在正文中实际出场或被直接点名：李凡、林定海、马会魁/u);
  assert.match(promptPacket.markdown, /检查舵链｜任务:让李凡用具体动作完成第一次技术判断｜出场:李凡、林定海、众水手/u);
  assert.equal(/HISTORY_RAW_MARKER|WRITER_RAW_MARKER|RESEARCH_RAW_MARKER|REFERENCE_RAW_MARKER|OPENING_RAW_MARKER/u.test(promptPacket.markdown), false);
});

test("writer prompt includes timeline skip contract when provided", () => {
  const promptPacket = buildWriterPromptPacket({
    project: baseProject(),
    chapterPlan: baseChapterPlan(),
    historyPacket: baseHistoryPacket(),
    writerContextPacket: baseWriterContext(),
    governance: baseGovernance(),
    timelineContext: {
      temporalPlanning: {
        source: "agent",
        recommendedTransition: "短跳到天亮前，但压力仍在场内。",
        skipAllowed: true,
        allowedSkipType: "short_skip",
        allowedElapsed: "数个时辰",
        skipRationale: "跳过重复赶路，保留资源消耗。",
        mustCarryThrough: ["船体半残", "追兵压力"],
        offscreenChangesToMention: ["水手轮值修补"],
        mustNotDo: ["不能让追兵凭空消失"],
      },
      timelineState: {
        deadlines: [
          {
            label: "天亮返航",
            latestStatement: "追兵天亮后会返航",
          },
        ],
      },
    },
  });

  assert.match(promptPacket.markdown, /## 时间合同/u);
  assert.match(promptPacket.markdown, /短跳到天亮前/u);
  assert.match(promptPacket.markdown, /跳过后仍必须保留：船体半残/u);
  assert.match(promptPacket.markdown, /有效倒计时：天亮返航/u);
});

test("project-2 ch002 fixture produces compact writer prompt without polluted names or object noise", async (t) => {
  const fixtureDir = path.join(process.cwd(), "projects", "project-2", "runtime", "staging", "write", "ch002");
  try {
    await fs.access(path.join(fixtureDir, "opening_reference_packet.json"));
    await fs.access(path.join(fixtureDir, "reference_packet.json"));
  } catch {
    t.skip("project-2 ch002 staging fixture is not present in this workspace");
    return;
  }

  const [openingReferencePacket, referencePacket] = await Promise.all([
    fs.readFile(path.join(fixtureDir, "opening_reference_packet.json"), "utf8").then((text) => JSON.parse(text)),
    fs.readFile(path.join(fixtureDir, "reference_packet.json"), "utf8").then((text) => JSON.parse(text)),
  ]);
  const scopedOpeningPacket = scopeOpeningReferencePacket(openingReferencePacket, {
    chapterNumber: 2,
    freshStart: false,
  });
  const writerContextWithReference = mergeReferenceIntoWriterContext(baseWriterContext(), referencePacket);
  const writerContext = mergeOpeningIntoWriterContext(writerContextWithReference, scopedOpeningPacket);
  const promptPacket = buildWriterPromptPacket({
    project: baseProject(),
    chapterPlan: baseChapterPlan(),
    historyPacket: baseHistoryPacket(),
    writerContextPacket: writerContext,
    referencePacket,
    openingReferencePacket: scopedOpeningPacket,
    governance: baseGovernance(),
    characterDossiers: [],
    styleGuideText: "- 第三人称有限视角\n- 优先动作与对白\n- 长句很多，必要时可拉远说明",
  });

  assert.equal(/陈新|刘民有|药农|抢衣服|Beat 2|\[object Object\]/u.test(promptPacket.markdown), false);
  assert.match(promptPacket.markdown, /目标篇幅约 4000 字/u);
});

test("stageChapterDraft persists compact writer prompt artifacts", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-writer-prompt-"));
  const store = await createStore(tempRoot);
  const promptPacket = buildWriterPromptPacket({
    project: baseProject(),
    chapterPlan: baseChapterPlan(),
    historyPacket: baseHistoryPacket(),
    writerContextPacket: baseWriterContext(),
    governance: baseGovernance(),
    characterDossiers: [],
    styleGuideText: "- 第三人称有限视角\n- 优先动作与对白",
  });

  try {
    await store.stageChapterDraft({
      chapterId: "ch002",
      chapterPlan: baseChapterPlan(),
      chapterMarkdown: "# 第二章\n\n测试正文。",
      sceneDrafts: [],
      writerPromptPacket: promptPacket,
    });

    const chapterDir = path.join(tempRoot, "runtime", "staging", "write", "ch002");
    const [savedJson, savedMarkdown] = await Promise.all([
      fs.readFile(path.join(chapterDir, "writer_prompt_packet.json"), "utf8").then((text) => JSON.parse(text)),
      fs.readFile(path.join(chapterDir, "writer_prompt_packet.md"), "utf8"),
    ]);

    assert.equal(savedJson.chapterId, "ch002");
    assert.match(savedMarkdown, /## 节奏合同/u);
    assert.match(savedMarkdown, /每场只兑现一个主要新增变化/u);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
