import assert from "node:assert/strict";
import test from "node:test";

import { runChapterAudit } from "../src/orchestration/audit.js";
import {
  buildDeterministicContinuityGuard,
  buildExecutionContract,
} from "../src/orchestration/write.js";

function createStructuredProvider(callLog = []) {
  return {
    async generateText(options = {}) {
      callLog.push({
        feature: options?.metadata?.feature || "",
        auditGroup: options?.metadata?.auditGroup || "",
        preferredAgentSlot: options?.preferredAgentSlot || "",
        agentComplexity: options?.agentComplexity || "",
      });

      const feature = options?.metadata?.feature || "";
      if (feature === "continuity_resolution") {
        return {
          text: JSON.stringify({
            defaultEntryMode: "direct_resume",
            allowedEntryModes: ["direct_resume", "same_scene_later"],
            resumeFrom: "承接上一章留下的直接压力。",
            previousActionPressure: "上一章动作压力仍在场。",
            resolvedActions: ["上一章已完成动作"],
            allowedContinuations: ["本章推进后果"],
            forbiddenReplays: ["不可重演已完成动作"],
            mustReferenceEvidenceRefs: [],
            unsupportedOpenings: [],
            confidence: 0.84,
            reviewRequired: false,
          }),
        };
      }
      if (feature === "execution_contract") {
        return {
          text: JSON.stringify({
            mustLand: ["直接推进结果"],
            carryoverStates: ["只能承接余波"],
            openTensions: ["开放张力继续发酵"],
            sceneDirectives: [
              {
                label: "场景一",
                mission: "推进主线",
                characters: ["李凡"],
                outcome: "局势升级",
                handoff: "压向下一场",
              },
            ],
            hardBoundaries: ["不得重演已完成动作"],
            deferredThreads: ["支线后延"],
            writerWarnings: ["不要把余波写成首次事件"],
            reviewRequired: false,
            confidence: 0.81,
          }),
        };
      }
      if (feature === "chapter_audit") {
        const auditGroup = options?.metadata?.auditGroup || "";
        return {
          text: JSON.stringify({
            summary: `${auditGroup || "default"} 审计通过。`,
            issues: [],
            dimensionSummaries: {},
            sequenceSnapshot: [],
            staleForeshadowings: [],
            nextChapterGuardrails: [],
          }),
        };
      }

      throw new Error(`Unexpected feature: ${feature}`);
    },
  };
}

test("new continuity and execution agents use secondary slot", async () => {
  const calls = [];
  const provider = createStructuredProvider(calls);

  await buildDeterministicContinuityGuard({
    provider,
    store: {
      paths: { chaptersDir: "/tmp" },
      async readText() {
        return "";
      },
    },
    chapterBase: {
      chapterId: "ch015",
      chapterNumber: 15,
      title: "黑货与催命符",
    },
    chapterSlot: {
      mission: "推进伤情后果与黑货查验",
      expectedCarryover: "承接上一章余波",
    },
    committedOutlines: [],
    factContext: null,
  });

  await buildExecutionContract({
    provider,
    project: { title: "测试作品" },
    chapterPlan: {
      chapterId: "ch015",
      title: "黑货与催命符",
      scenes: [{ label: "场景一" }],
    },
    historyPacket: { lastEnding: "上一章余波仍在" },
    governance: { ruleStack: {} },
    factContext: null,
    timelineContext: null,
    continuityGuard: { resumeFrom: "上一章压力", allowedEntryModes: ["direct_resume"] },
  });

  const continuityCall = calls.find((item) => item.feature === "continuity_resolution");
  const executionCall = calls.find((item) => item.feature === "execution_contract");
  assert.equal(continuityCall?.preferredAgentSlot, "secondary");
  assert.equal(executionCall?.preferredAgentSlot, "secondary");
});

test("new audit agents run as three grouped audits with fixed slots", async () => {
  const calls = [];
  const provider = createStructuredProvider(calls);

  await runChapterAudit({
    store: {
      async listChapterMeta() {
        return [];
      },
      paths: { chaptersDir: "/tmp" },
      async readText() {
        return "";
      },
    },
    provider,
    project: {
      title: "测试作品",
      genre: "历史冒险",
      setting: "海上",
      targetWordsPerChapter: 4000,
      researchNotes: "",
    },
    chapterPlan: {
      chapterId: "ch015",
      chapterNumber: 15,
      title: "黑货与催命符",
      povCharacter: "李凡",
      location: "甲板",
      keyEvents: ["推进结果"],
      scenes: [],
      emotionalTone: "高压",
      charactersPresent: ["李凡"],
      continuityAnchors: ["承接上一章余波"],
    },
    chapterDraft: {
      markdown: "# 第十五章\n\n李凡抬手止住众人争声，先看甲板局势，再决定下一步怎么查。",
    },
    historyPacket: { continuityAnchors: ["承接上一章余波"] },
    foreshadowingAdvice: [],
    researchPacket: null,
    styleGuideText: "",
    characterStates: [],
    foreshadowingRegistry: { foreshadowings: [] },
    chapterMetas: [],
    factContext: null,
    timelineContext: null,
    continuityGuard: null,
  });

  const auditCalls = calls.filter((item) => item.feature === "chapter_audit");
  assert.equal(auditCalls.length, 3);
  assert.deepEqual(
    auditCalls.map((item) => item.auditGroup).sort(),
    ["character_threads", "continuity_boundary", "style_pacing"],
  );
  assert.equal(auditCalls.find((item) => item.auditGroup === "continuity_boundary")?.preferredAgentSlot, "primary");
  assert.equal(auditCalls.find((item) => item.auditGroup === "style_pacing")?.preferredAgentSlot, "secondary");
  assert.equal(auditCalls.find((item) => item.auditGroup === "character_threads")?.preferredAgentSlot, "secondary");
});
