import assert from "node:assert/strict";
import test from "node:test";

import { runAuditHeuristics } from "../src/core/audit-heuristics.js";
import { buildClosedThreadReactivationIssues } from "../src/orchestration/write.js";
import { runChapterAudit } from "../src/orchestration/audit.js";

function replayMarkdown() {
  return [
    "# 第十五章 黑货与催命符",
    "李凡半跪在甲板上，先把撕下来的麻布死死压住林定海臂上的伤口，又拿木棍和布条绞成简陋绞标，一寸寸勒住血脉，逼着那股热血慢下来。",
    "林定海脸色发白，众水手围成一圈看着李凡继续按、缠、勒，谁都不敢先松手。",
    "许三娘却已经蹲到船舷边，盯着吃水线看了几息，抬头就说船身压得太深，底舱必定有不该有的重物，多半就是黑货。",
    "她又点出盐袋压舱的层次不对，逼得众人不得不回头盯住舱底那一片死沉的黑影。",
  ].join("\n\n");
}

const factContext = {
  establishedFacts: [
    { factId: "fact_ch014_006", subject: "许三娘", assertion: "已指出吃水线异常与底舱重物" },
    { factId: "fact_ch014_007", subject: "林定海", assertion: "李凡已完成第一轮勒脉止血" },
  ],
  openTensions: [
    { factId: "fact_ch014_006", subject: "黑货", assertion: "本章只能推进查验与揭晓，不可重演首次发现" },
    { factId: "fact_ch014_007", subject: "林定海", assertion: "本章只能推进伤情后果，不可重演第一轮止血" },
  ],
};

const continuityGuard = {
  resolvedCarryoverBeats: [
    "李凡已对林定海做第一轮勒脉止血，只能承接伤情后果，不可重新完整演止血",
    "许三娘已指出吃水线异常与底舱重物，只能推进查验/揭晓，不可重新完整演发现过程",
  ],
};

test("audit heuristics flag carryover replay at chapter opening", () => {
  const heuristics = runAuditHeuristics({
    project: {
      title: "测试作品",
      targetWordsPerChapter: 4000,
    },
    chapterPlan: {
      chapterId: "ch015",
      title: "黑货与催命符",
      chapterNumber: 15,
      emotionalTone: "高压",
    },
    chapterDraft: { markdown: replayMarkdown() },
    researchPacket: null,
    foreshadowingRegistry: { foreshadowings: [] },
    recentChapters: [],
    factContext,
    resolvedCarryoverBeats: continuityGuard.resolvedCarryoverBeats,
  });

  const replayIssues = heuristics.issues.filter((item) => item.id === "carryover_replay");
  assert.equal(replayIssues.length >= 2, true);
  assert.equal(replayIssues.every((item) => item.severity === "critical"), true);
  assert.match(replayIssues.map((item) => item.description).join("\n"), /止血|黑货/u);
});

test("runChapterAudit relies on new audit agents for replay findings", async () => {
  const validation = await runChapterAudit({
    store: {
      async listChapterMeta() {
        return [];
      },
      paths: { chaptersDir: "/tmp" },
      async readText() {
        return "";
      },
    },
    provider: {
      async generateText(options = {}) {
        const feature = options?.metadata?.feature || "";
        return {
          text: JSON.stringify({
            summary: options?.metadata?.auditGroup === "continuity_boundary" ? "正文存在上一章动作重演。" : "本组未发现阻断问题。",
            issues: options?.metadata?.auditGroup === "continuity_boundary"
              ? [
                {
                  id: "carryover_replay",
                  severity: "critical",
                  category: "既定事实连续性",
                  description: "章节开头把上一章已经完成的止血与黑货判断重新写成了本章首次事件。",
                  evidence: "李凡重新完整止血 / 许三娘重新指出吃水异常",
                  suggestion: "只能承接伤情后果与开舱查验，不可重新完整演动作首次发生。",
                },
              ]
              : [],
            dimensionSummaries: options?.metadata?.auditGroup === "continuity_boundary"
              ? {
                carryover_replay: "开场存在明显重演。",
                outline_drift: "本章主要动作被写成了重复桥段。",
              }
              : {},
            sequenceSnapshot: [],
            staleForeshadowings: [],
            nextChapterGuardrails: ["只能承接伤情后果，不可重新完整演动作。"],
          }),
        };
      },
    },
    project: {
      title: "测试作品",
      genre: "历史冒险",
      setting: "明末海上",
      targetWordsPerChapter: 4000,
      researchNotes: "",
    },
    chapterPlan: {
      chapterId: "ch015",
      chapterNumber: 15,
      title: "黑货与催命符",
      povCharacter: "李凡",
      location: "海船甲板",
      keyEvents: ["直接开舱查验黑货"],
      scenes: [],
      emotionalTone: "高压",
      charactersPresent: ["李凡", "林定海", "许三娘"],
      continuityAnchors: ["承接上一章余波"],
    },
    chapterDraft: { markdown: replayMarkdown() },
    historyPacket: {
      continuityAnchors: ["上一章已完成第一轮止血与吃水异常判断"],
    },
    foreshadowingAdvice: [],
    researchPacket: null,
    styleGuideText: "",
    characterStates: [],
    foreshadowingRegistry: { foreshadowings: [] },
    chapterMetas: [],
    factContext,
    timelineContext: null,
    continuityGuard,
  });

  assert.equal(validation.auditScope?.enabledDimensions?.some((item) => item.id === "carryover_replay"), true);
  assert.equal(validation.auditScope?.enabledDimensions?.length > 10, true);
  assert.equal(validation.auditGroups?.length, 3);
  assert.equal(validation.heuristics, null);
  assert.equal(validation.issues.some((item) => item.id === "carryover_replay"), true);
  assert.equal(validation.passed, false);
  assert.match(validation.nextChapterGuardrails.join("\n"), /只能承接伤情后果|不可重新完整演/u);
});

test("closed thread reactivation audit does not cross-contaminate separate key events", () => {
  const candidate = {
    proposalId: "proposal_3",
    chapterPlan: {
      dominantThread: "在缺水绝境中维持临时秩序。",
      keyEvents: [
        "林定海高烧半昏迷需水续命。",
        "旧海盗的全面哗变倒计时启动。",
      ],
      nextHook: "若再找不到水源，哗变就会爆发。",
      exitPressure: "断水死局钉死，营地随时失控。",
      scenes: [
        {
          focus: "承接沉船余波与午后暴晒。",
          tension: "众人被饥渴逼到极限。",
          scenePurpose: "交代临时秩序尚未崩溃。",
          inheritsFromPrevious: "承接上章残局。",
          outcome: "李凡暂时稳住场面。",
          handoffToNext: "继续寻找新的活路。",
        },
      ],
    },
  };
  const continuityClosures = {
    mustNotReopen: [
      {
        threadId: "invalidated:lin-dinghai-heavy-weapon",
        label: "林定海：在肉搏中右肩箭伤彻底崩裂，无法再使用重兵器。",
        status: "invalidated",
        summary: "林定海：在肉搏中右肩箭伤彻底崩裂，无法再使用重兵器。",
        keywords: ["林定海", "无法再使用重兵器"],
      },
    ],
  };

  const issues = buildClosedThreadReactivationIssues(candidate, continuityClosures);
  assert.equal(issues.length, 0);
});
