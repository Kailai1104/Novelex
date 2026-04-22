import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanonFactRevisionNotes,
  buildFactContextMarkdown,
  buildFactContextPacket,
  collectCanonFactContinuityIssues,
} from "../src/core/facts.js";
import {
  buildContextPackage,
  buildGovernedChapterIntent,
  buildGovernedInputContract,
  buildRuleStack,
} from "../src/core/input-governance.js";

test("buildFactContextPacket handles empty establishedFacts and openTensions", () => {
  const packet = buildFactContextPacket({
    chapterPlan: { chapterId: "ch003" },
    establishedFacts: [],
    openTensions: [],
    selectionRationale: "",
    catalogStats: { totalFacts: 0, selected: 0 },
  });
  assert.equal(packet.establishedFacts.length, 0);
  assert.equal(packet.openTensions.length, 0);
  assert.ok(packet.briefingMarkdown.includes("无"));
});

test("buildFactContextPacket builds correct structure", () => {
  const establishedFacts = [
    { factId: "fact_ch001_001", chapterId: "ch001", type: "order", subject: "沈砚", assertion: "沈砚下令彻查税卡", evidence: "证据1" },
    { factId: "fact_ch002_001", chapterId: "ch002", type: "state", subject: "郑芝龙", assertion: "郑芝龙态度暧昧", evidence: "证据2" },
  ];
  const openTensions = [
    { factId: "fact_ch001_002", chapterId: "ch001", type: "state", subject: "税卡", assertion: "税卡背后有更大势力", evidence: "证据3" },
  ];
  const chapterPlan = { chapterId: "ch003", title: "税卡风声" };

  const packet = buildFactContextPacket({
    chapterPlan,
    establishedFacts,
    openTensions,
    selectionRationale: "筛选与本章港口冲突相关的事实。",
    catalogStats: { totalFacts: 5, selected: 3 },
  });

  assert.equal(packet.chapterId, "ch003");
  assert.equal(packet.establishedFacts.length, 2);
  assert.equal(packet.openTensions.length, 1);
  assert.equal(packet.selectionRationale, "筛选与本章港口冲突相关的事实。");
  assert.equal(packet.catalogStats.totalFacts, 5);
  assert.ok(packet.briefingMarkdown.includes("已定事实"));
  assert.ok(packet.briefingMarkdown.includes("开放张力"));
  assert.ok(packet.summaryText.length > 0);
});

test("buildFactContextMarkdown renders established facts and open tensions", () => {
  const establishedFacts = [
    { factId: "fact_ch001_001", chapterId: "ch001", type: "order", subject: "沈砚", assertion: "沈砚下令彻查税卡", evidence: "沈砚皱眉，命人调来底账。" },
  ];
  const openTensions = [
    { factId: "fact_ch001_002", chapterId: "ch001", type: "state", subject: "郑芝龙", assertion: "郑芝龙态度暧昧", evidence: "捋胡须不答。" },
  ];
  const chapterPlan = { chapterId: "ch003" };

  const markdown = buildFactContextMarkdown({
    chapterPlan,
    establishedFacts,
    openTensions,
    selectionRationale: "测试理由",
  });

  assert.ok(markdown.includes("fact_ch001_001"));
  assert.ok(markdown.includes("沈砚下令彻查税卡"));
  assert.ok(markdown.includes("fact_ch001_002"));
  assert.ok(markdown.includes("郑芝龙态度暧昧"));
  assert.ok(markdown.includes("测试理由"));
  assert.ok(markdown.includes("已定事实"));
  assert.ok(markdown.includes("开放张力"));
});

test("collectCanonFactContinuityIssues extracts issues from validation result", () => {
  const validation = {
    issues: [
      { id: "canon_fact_continuity", severity: "critical", description: "正文否定了已定事实：税卡收益被截留七成" },
      { id: "pov_consistency", severity: "warning", description: "视角飘移" },
      { id: "canon_fact_continuity", severity: "warning", description: "新章节引入了与已定事实矛盾的信息" },
    ],
  };

  const issues = collectCanonFactContinuityIssues(validation);
  assert.equal(issues.length, 2);
  assert.ok(issues[0].includes("税卡收益被截留七成"));
  assert.ok(issues[1].includes("矛盾"));
});

test("collectCanonFactContinuityIssues returns empty for no matching issues", () => {
  const validation = {
    issues: [
      { id: "pov_consistency", severity: "warning", description: "视角飘移" },
    ],
  };
  assert.deepEqual(collectCanonFactContinuityIssues(validation), []);
  assert.deepEqual(collectCanonFactContinuityIssues(null), []);
  assert.deepEqual(collectCanonFactContinuityIssues({}, []), []);
});

test("buildCanonFactRevisionNotes includes facts and audit issues", () => {
  const factContext = {
    establishedFacts: [
      { factId: "fact_ch001_001", subject: "沈砚", assertion: "沈砚下令彻查税卡" },
    ],
    openTensions: [
      { factId: "fact_ch001_002", subject: "郑芝龙", assertion: "郑芝龙态度暧昧" },
    ],
  };
  const auditIssues = [
    "正文否定了已定事实：沈砚下令彻查税卡",
  ];

  const notes = buildCanonFactRevisionNotes(factContext, auditIssues);

  assert.ok(notes.some((n) => n.includes("已定事实")));
  assert.ok(notes.some((n) => n.includes("沈砚下令彻查税卡")));
  assert.ok(notes.some((n) => n.includes("开放张力")));
  assert.ok(notes.some((n) => n.includes("郑芝龙态度暧昧")));
  assert.ok(notes.some((n) => n.includes("连续性冲突")));
  assert.ok(notes.some((n) => n.includes("税卡")));
});

test("buildGovernedChapterIntent injects factContext into mustKeep and mustAvoid", () => {
  const chapterPlan = {
    chapterId: "ch012",
    chapterNumber: 12,
    title: "税卡风声",
    povCharacter: "沈砚",
    keyEvents: ["沈砚发现税卡盘剥背后牵动军饷链"],
    arcContribution: ["主角第一次意识到局部贪腐背后连着更大的军政结构"],
    nextHook: "沈砚意识到有人在故意拖欠海防军饷",
  };

  const planContext = {
    outline: { recommendedFocus: "让沈砚先看懂税卡" },
    characters: { forbiddenLeaks: [] },
    world: { continuityAnchors: [], styleRules: [] },
  };

  const historyPacket = {
    mustNotContradict: ["沈砚此前只见到账面异常"],
    carryOverFacts: [],
  };

  const factContext = {
    establishedFacts: [
      { factId: "fact_ch001_001", subject: "沈砚", assertion: "沈砚下令彻查税卡账目" },
    ],
    openTensions: [
      { factId: "fact_ch001_002", subject: "郑芝龙", assertion: "郑芝龙态度暧昧" },
    ],
  };

  const intent = buildGovernedChapterIntent({
    chapterPlan,
    planContext,
    historyPacket,
    factContext,
  });

  assert.ok(intent.mustKeep.some((item) => item.includes("fact_ch001_001")));
  assert.ok(intent.mustKeep.some((item) => item.includes("沈砚下令彻查税卡账目")));
  assert.ok(intent.mustAvoid.some((item) => item.includes("fact_ch001_001")));
  assert.ok(intent.mustAvoid.some((item) => item.includes("禁止否认")));
});

test("buildRuleStack adds factHardFacts and factSoftGoals", () => {
  const chapterPlan = { chapterId: "ch012", chapterNumber: 12, keyEvents: [], arcContribution: [] };
  const chapterIntent = { goal: "彻查税卡", mustKeep: [], mustAvoid: [], styleEmphasis: [] };

  const factContext = {
    establishedFacts: [
      { factId: "fact_ch001_001", subject: "沈砚", assertion: "沈砚下令彻查税卡" },
    ],
    openTensions: [
      { factId: "fact_ch001_002", subject: "郑芝龙", assertion: "郑芝龙态度暧昧" },
    ],
  };

  const ruleStack = buildRuleStack({
    chapterPlan,
    chapterIntent,
    factContext,
  });

  assert.ok(ruleStack.hardFacts.some((f) => f.includes("fact_ch001_001")));
  assert.ok(ruleStack.hardFacts.some((f) => f.includes("沈砚下令彻查税卡")));
  assert.ok(ruleStack.softGoals.some((f) => f.includes("fact_ch001_002")));
  assert.ok(ruleStack.softGoals.some((f) => f.includes("郑芝龙态度暧昧")));
});

test("buildContextPackage includes factContext sources when present", () => {
  const chapterPlan = { chapterId: "ch012", chapterNumber: 12 };

  const factContext = {
    establishedFacts: [
      { factId: "fact_ch001_001", subject: "沈砚", assertion: "沈砚下令彻查税卡" },
    ],
    openTensions: [],
  };

  const contextPackage = buildContextPackage({
    chapterPlan,
    planContext: {},
    historyPacket: {},
    writerContext: {},
    factContext,
  });

  assert.ok(contextPackage.selectedContext.length > 0);
  assert.ok(
    contextPackage.selectedContext.some((item) => item.source.includes("fact_ledger")),
  );
});

test("buildGovernedInputContract includes fact context when present in ruleStack", () => {
  const chapterIntent = {
    goal: "彻查税卡",
    mustKeep: [],
    mustAvoid: [],
    styleEmphasis: [],
    conflicts: [],
    hookAgenda: {
      eligibleResolve: [],
      mustAdvance: [],
      staleDebt: [],
      avoidNewHookFamilies: [],
    },
  };

  const ruleStack = {
    hardFacts: ["已定事实[fact_ch001_001]：沈砚｜沈砚下令彻查税卡"],
    softGoals: ["开放张力[fact_ch001_002]：郑芝龙｜郑芝龙态度暧昧（可继续发酵，不可改写底层结论）"],
    deferRules: [],
    currentTask: [],
  };

  const contract = buildGovernedInputContract({
    chapterIntent,
    contextPackage: { selectedContext: [] },
    ruleStack,
  });

  assert.ok(contract.includes("hardFacts"));
  assert.ok(contract.includes("fact_ch001_001"));
  assert.ok(contract.includes("fact_ch001_002"));
});
