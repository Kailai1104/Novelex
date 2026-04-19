import assert from "node:assert/strict";
import test from "node:test";

import { buildContextTrace } from "../src/core/context-trace.js";
import {
  buildContextPackage,
  buildGovernedChapterIntent,
  buildGovernedInputContract,
  buildRuleStack,
} from "../src/core/input-governance.js";

function buildFixture() {
  const chapterPlan = {
    chapterNumber: 12,
    chapterId: "ch012",
    title: "税卡风声",
    povCharacter: "沈砚",
    keyEvents: [
      "沈砚发现税卡盘剥背后牵动军饷链。",
      "港口各方对是否立刻翻账意见分裂。",
    ],
    arcContribution: [
      "主角第一次意识到局部贪腐背后连着更大的军政结构。",
    ],
    nextHook: "沈砚意识到有人在故意拖欠海防军饷。",
    continuityAnchors: [
      "不能提前揭露郑芝龙真正立场。",
    ],
    foreshadowingActions: [
      { id: "fsh_002", action: "water" },
      { id: "fsh_003", action: "resolve" },
    ],
  };

  const planContext = {
    outline: {
      mustPreserve: [
        "必须保留ch013的海防试探钩子。",
      ],
      deferUntilLater: [
        "更大的政争面要延后到ch013再展开。",
      ],
      continuityRisks: [
        "把本章写成全知视角的财政揭秘。",
      ],
      recommendedFocus: "让沈砚先看懂税卡、港口与军饷链之间的裂口。",
    },
    characters: {
      forbiddenLeaks: [
        "不要让配角说出自己不可能知道的朝廷内幕。",
      ],
      writerReminders: [
        "对白要带试探感。",
      ],
    },
    world: {
      continuityAnchors: [
        "税卡与军饷只能先露链条，不可直接给答案。",
      ],
      worldConstraints: [
        "港口财政链必须同时体现军需与海商利益。",
      ],
      styleRules: [
        "动作先于解释。",
      ],
    },
    selectedSources: [
      {
        source: "novel_state/outline.md",
        reason: "锁定本章的目标与延后规则。",
        excerpt: "更大的政争面要延后。",
      },
      {
        source: "novel_state/worldbuilding.md",
        reason: "限制港口税卡与海防背景。",
        excerpt: "港口税卡牵动军需。",
      },
    ],
  };

  const historyPacket = {
    carryOverFacts: [
      "上一章已经确认港口税卡存在异常盘剥。",
    ],
    mustNotContradict: [
      "沈砚此前只见到账面异常，还没拿到幕后证据。",
    ],
    openThreads: [
      "谁在切断海防军饷？",
    ],
    briefingMarkdown: "# 历史衔接\n- 上一章只露出账面异常。",
    selectedSources: [
      {
        source: "novel_state/chapters/ch011.md",
        reason: "承接上一章的账册异常。",
        excerpt: "账目对不上，但幕后人未现身。",
      },
    ],
  };

  const writerContext = {
    briefingMarkdown: "# Writer 上下文\n- 优先落税卡与军饷链。",
    selectedSources: [
      {
        source: "novel_state/outline.md",
        reason: "锁定本章的目标与延后规则。",
        excerpt: "更大的政争面要延后。",
      },
    ],
  };

  const researchPacket = {
    triggered: true,
    briefingMarkdown: "# 研究资料包\n- 晚明港口税卡与海防军饷相关。",
    summary: "确认了晚明沿海税卡与海防军饷的现实关联。",
    factsToUse: [
      "税卡盘剥常与军饷短绌联动。",
    ],
    factsToAvoid: [
      "不要把清中后期制度挪到崇祯年间。",
    ],
    uncertainPoints: [
      "具体票据术语仍需保守书写。",
    ],
    sources: [
      {
        title: "港口与军饷",
        url: "https://example.com/source",
        snippet: "军饷与港税相互牵连。",
      },
    ],
  };

  const foreshadowingAdvice = [
    {
      id: "fsh_001",
      status: "planted",
      urgency: "high",
      last_touched_chapter: "ch005",
      description: "海防黑幕的旧疑云仍未处理。",
      tags: ["海防黑幕"],
    },
    {
      id: "fsh_002",
      status: "planted",
      urgency: "medium",
      last_touched_chapter: "ch010",
      description: "税卡线要继续浇水。",
      tags: ["税卡"],
    },
    {
      id: "fsh_003",
      status: "planted",
      urgency: "medium",
      last_touched_chapter: "ch010",
      description: "军饷链的局部疑问可在本章兑现。",
      tags: ["军饷"],
    },
  ];

  return {
    chapterPlan,
    planContext,
    historyPacket,
    writerContext,
    researchPacket,
    foreshadowingAdvice,
    styleGuideText: "# 风格指南\n- 动作先于解释\n- 对话带试探感\n",
  };
}

test("governance artifacts capture hook pressure, rule stack, and traceable sources", () => {
  const fixture = buildFixture();
  const chapterIntent = buildGovernedChapterIntent({
    chapterPlan: fixture.chapterPlan,
    planContext: fixture.planContext,
    historyPacket: fixture.historyPacket,
    foreshadowingAdvice: fixture.foreshadowingAdvice,
    researchPacket: fixture.researchPacket,
    styleGuideText: fixture.styleGuideText,
  });

  assert.equal(chapterIntent.chapter, 12);
  assert.match(chapterIntent.goal, /税卡|军饷链/);
  assert.ok(chapterIntent.mustKeep.includes("POV稳定在 沈砚"));
  assert.ok(chapterIntent.mustAvoid.some((item) => item.includes("不要提前兑现")));
  assert.deepEqual(chapterIntent.hookAgenda.mustAdvance, ["fsh_002"]);
  assert.deepEqual(chapterIntent.hookAgenda.eligibleResolve, ["fsh_003"]);
  assert.deepEqual(chapterIntent.hookAgenda.staleDebt, ["fsh_001"]);
  assert.deepEqual(chapterIntent.hookAgenda.avoidNewHookFamilies, ["海防黑幕类"]);

  const contextPackage = buildContextPackage({
    chapterPlan: fixture.chapterPlan,
    planContext: fixture.planContext,
    historyPacket: fixture.historyPacket,
    writerContext: fixture.writerContext,
    researchPacket: fixture.researchPacket,
  });
  assert.ok(contextPackage.selectedContext.some((item) => item.source === "novel_state/outline.md"));
  assert.ok(contextPackage.selectedContext.some((item) => item.source.endsWith("research_packet.json")));

  const ruleStack = buildRuleStack({
    chapterPlan: fixture.chapterPlan,
    chapterIntent,
    planContext: fixture.planContext,
    historyPacket: fixture.historyPacket,
    researchPacket: fixture.researchPacket,
  });
  assert.deepEqual(ruleStack.precedence, ["hardFacts", "softGoals", "deferRules", "currentTask"]);
  assert.ok(ruleStack.hardFacts.some((item) => item.includes("POV稳定在")));
  assert.ok(ruleStack.softGoals.some((item) => item.includes("本章必须推进伏笔 fsh_002")));
  assert.ok(ruleStack.deferRules.some((item) => item.includes("旧伏笔 fsh_001")));

  const trace = buildContextTrace({
    chapterPlan: fixture.chapterPlan,
    chapterIntent,
    contextPackage,
    ruleStack,
    writerContext: fixture.writerContext,
    historyPacket: fixture.historyPacket,
    researchPacket: fixture.researchPacket,
    styleGuideText: fixture.styleGuideText,
  });
  assert.ok(trace.selectedDocuments.some((item) => item.source === "novel_state/outline.md"));
  assert.ok(trace.promptInputs.some((item) => item.name === "chapter_intent"));
  assert.ok(trace.promptInputs.some((item) => item.name === "rule_stack"));
  assert.equal(trace.researchSources[0].url, "https://example.com/source");

  const contract = buildGovernedInputContract({
    chapterIntent,
    contextPackage,
    ruleStack,
  });
  assert.match(contract, /输入治理契约/);
  assert.match(contract, /eligibleResolve/);
  assert.match(contract, /Selected Context Sources/);
});
