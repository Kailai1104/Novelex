import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveCodexApiConfig } from "../src/config/codex-config.js";
import { runAuditHeuristics } from "../src/core/audit-heuristics.js";
import { assembleChapterMarkdown, buildStructure, runValidations } from "../src/core/generators.js";
import { buildStyleFingerprintSummary, renderStyleFingerprintPrompt } from "../src/core/style-fingerprint.js";
import { createProvider, resolveProviderSettings } from "../src/llm/provider.js";
import { closeAllWorkspaceMcpManagers } from "../src/mcp/index.js";
import { buildOpeningReferencePacket } from "../src/opening/reference.js";
import { generateStyleFingerprint } from "../src/orchestration/style-fingerprint.js";
import { reviewPlanDraft, reviewPlanFinal, runPlanDraft } from "../src/orchestration/plan.js";
import { deleteLatestLockedChapter, reviewChapter, runWriteChapter, saveManualChapterEdit } from "../src/orchestration/write.js";
import { rebuildOpeningCollectionIndex } from "../src/opening/index.js";
import { rebuildRagCollectionIndex } from "../src/rag/index.js";
import { createZhipuEmbeddingClient } from "../src/rag/zhipu.js";
import { createStore } from "../src/utils/store.js";
import { createProjectWorkspace, deleteProjectWorkspace, listProjects } from "../src/utils/workspace.js";

const FIXTURE_RUNTIME_SERVER = path.join(process.cwd(), "test", "fixtures", "mcp", "runtime-server.js");

test.afterEach(async () => {
  await closeAllWorkspaceMcpManagers();
});

async function withIsolatedProviderEnv(callback) {
  const keys = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "KIMI_API_KEY",
    "KIMI_BASE_URL",
    "MOONSHOT_API_KEY",
    "MOONSHOT_BASE_URL",
    "MINIMAX_API_KEY",
    "MINIMAX_BASE_URL",
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL",
    "NOVAI_API_KEY",
    "NOVAI_BASE_URL",
    "NOVELEX_PROVIDER_MODE",
    "NOVELEX_MODEL",
    "NOVELEX_REVIEW_MODEL",
    "NOVELEX_CODEX_MODEL",
    "NOVELEX_REASONING_EFFORT",
    "NOVELEX_FORCE_STREAM",
    "NOVELEX_FAKE_ZHIPU_EMBEDDINGS",
    "ZHIPU_API_KEY",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  for (const key of keys) {
    delete process.env[key];
  }

  try {
    return await callback();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function extractInputText(input) {
  return (Array.isArray(input) ? input : [])
    .flatMap((message) => message?.content || [])
    .map((item) => item?.text || "")
    .join("\n");
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function saveFixtureWebSearchMcpConfig(rootDir, overrides = {}) {
  saveCodexApiConfig(rootDir, {
    model_provider: "OpenAI",
    model: "gpt-5.4",
    review_model: "gpt-5.4",
    codex_model: "gpt-5.3-codex",
    disable_response_storage: true,
    model_providers: {
      OpenAI: {
        name: "OpenAI",
        base_url: "https://openai.example/v1",
        wire_api: "responses",
        api_key: "openai-key",
        response_model: "gpt-5.4",
        review_model: "gpt-5.4",
        codex_model: "gpt-5.3-codex",
      },
      MiniMax: {
        name: "MiniMax",
        base_url: "https://api.minimaxi.com/v1",
        wire_api: "chat_completions",
        api_key: "minimax-key",
        response_model: "MiniMax-M2.5-highspeed",
        review_model: "MiniMax-M2.5-highspeed",
        codex_model: "MiniMax-M2.5-highspeed",
      },
    },
    mcp: {
      enabled: true,
      servers: {
        web_search: {
          enabled: true,
          transport: "stdio",
          command: process.execPath,
          args: [path.join(process.cwd(), "test", "fixtures", "mcp", "web-search-server.js")],
          startup_timeout_ms: 5000,
          call_timeout_ms: 5000,
          env: {},
        },
      },
    },
    ...overrides,
  });
}

function hangingSseResponse(chunks, contentType = "text/event-stream; charset=utf-8") {
  const encoder = new TextEncoder();
  let controllerRef = null;

  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
    },
    cancel() {
      if (!controllerRef) {
        return;
      }
      try {
        controllerRef.close();
      } catch {
        // The parser may already have cancelled the reader.
      }
    },
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
      },
    }),
    close() {
      if (!controllerRef) {
        return;
      }
      try {
        controllerRef.close();
      } catch {
        // Ignore double-close during test teardown.
      }
    },
  };
}

async function withTimeout(promise, ms, label = "timeout") {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function buildEmbeddingVector(text) {
  const source = String(text || "");
  return [
    /海|礁|潮/.test(source) ? 1 : 0,
    /港|船|帆/.test(source) ? 1 : 0,
    /对白|命令|短促/.test(source) ? 1 : 0,
    /压迫|紧绷|冷/.test(source) ? 1 : 0,
    Math.min(1, source.length / 400),
    /李凡|主角/.test(source) ? 1 : 0,
  ];
}

function chapterTitle(number) {
  return `第${number}章·推进与扩张 ${number}`;
}

function buildWriterStubChapter(event, feedback = "") {
  const normalizedEvent = String(event || "推进关键事件").trim();
  const feedbackLine = String(feedback || "").trim();
  const body = [
    `赤屿内港的风一阵紧过一阵，棚顶绳结被扯得吱呀作响。李凡没有浪费任何时间，站到长桌尽头就把今日真正要落地的事直接摁到桌面上：${normalizedEvent}。账册、草图、值哨名单和船坞进度全摊开之后，屋里的人很快都明白，这不是讨论要不要做，而是讨论谁先扛、谁现在就去做、谁若拖慢一步就要替所有人的代价负责。`,
    `他先点的是粮、火药和木料的流向。过去还能靠经验和人情勉强维持的环节，在局势升高之后都成了明面上的漏洞。李凡把几处最容易被人卡住的节点逐条挑出来，要求各组从今日起按同一套口径回报，不准再拿“差不多”“应该够用”这种话混过去。顾骁本想先说海防哨位的问题，话到嘴边又停住，因为他也看出来了，一旦补给和工坊节奏对不上，外面的试探还没压进来，内部就会先自己垮出一道口子。`,
    `宋应星把手边草图翻到最后两页，直接把最费工、最耗时、却又最不能省的几处标红。他没有用一堆空泛的术语替众人减压，而是把每一处工序背后的后果讲得极清楚：哪一道少做了半日，下一批成品就会虚；哪一处偷了料，真正出事时就不是修补，而是整套安排一起塌下去。李凡听完没有立刻表态，只让他把可提前并行的部分单独列出来，因为眼下要争的不是纸面最漂亮的方案，而是在风险已经逼近时，仍然能撑住推进的次序。`,
    `屋里的气氛真正绷紧，是在顾骁把前线巡检带回来的消息抛出来之后。外头的人还没有正式翻脸，但试探的手已经伸得足够深，连码头装卸的节奏、值夜换岗的空窗都被人摸得差不多了。李凡没有顺着这股火气把人推去硬碰，而是先把能立刻补上的口子一件件钉住：谁去盯工坊夜班，谁去重新校账，谁去把最慢的那条船腾出装药空间，谁去把外头的眼线故意引到错误的方向。命令一层层压下去，众人才第一次感觉到，这场会并不是要把压力说清楚，而是要把压力变成一套立刻执行的动作。`,
    `有人还是提出了质疑，担心这样一来前头后头都会吃紧，稍有不慎就会把刚稳住的盘面再次扯裂。李凡没有压人，也没有用一句“必须如此”把问题盖过去。他把账上还能挪动的余地、眼下最不能失手的节点和拖延之后一定会更贵的代价摆在一起，让每个人自己看清哪条路其实更险。${feedbackLine ? `他还顺手把“${feedbackLine}”这条要求压进分工里，明确谁负责补现场反应，谁负责把前后因果当场做实，免得执行落到最后又剩空口概括。` : "他说得并不激烈，但每一句都往最硬的地方落，听的人很难再拿侥幸心态替自己留退路。"}等到最后一个问题被摊开时，屋里的犹豫已经少了大半，取而代之的是一种被迫进入实战的清醒。`,
    `真正让众人改变态度的，不是李凡语气有多重，而是他把代价分配得足够具体。多备一批火药意味着今晚就要截掉别处的人手；提前赶出那几件器具，就意味着某条原本能缓一缓的修补必须往后让；把港口的盘查再收紧一层，短时间内就会得罪原本还能两边说话的人。每一步都有痛感，每一步也都在告诉众人，所谓扩张从来不是多拿一点好处，而是先决定愿意为哪条路付出更重的成本。这样的判断一旦做下，就不能再靠明日的运气替今日收尾。`,
    `会商推进到中段，门外又送来一份新报。消息不长，却足够让人心里一沉：外部那股势力并没有被眼前的表面秩序哄住，反而在等他们自己露出更明显的疲态。宋应星听完只问了一句工坊最慢的那道工序还能不能提速，顾骁则直接去看值哨名单里哪一段最容易被人钻过去。李凡把两人的反应收在眼里，没有再重复刚才说过的话，只把最关键的一条补上去：既然对面已经开始按他们的弱点试探，那本章这一步就不能只求稳住，必须把回应做成足以改变对方判断的结果。`,
    `于是后面的分工彻底从“准备”变成了“执行”。有人被赶去仓口重排装运次序，有人拿着临时更改的清单去追工坊夜班，还有人被派去盯住那些最可能在关键时刻失手的中间环节。顾骁出门前停了一下，低声问李凡是不是要把海面上的布置一并提前。李凡没有立刻答应，只说先把手里能控制的动作做满，再把那一线真正压到对面眼前。这个回答听上去保守，实际却比空喊强硬得多，因为它意味着接下来每一个环节都得按真正开局的标准执行，而不是再拿试探当借口。`,
    `临散之前，李凡把所有人的目光重新拉回那张摊开的桌面。他没有总结气氛，也没有说什么漂亮话，只把已经定下的次序又压了一遍：先补最容易失血的口子，再让能出结果的动作尽快出结果，最后把回应抬到足够让下一轮试探改道的程度。屋里一时间没人再接话，只有风从棚口灌进来，带得纸页边角轻轻翻动。众人各自领命出去时，都知道今晚之后盘面不会恢复轻松，可也正因为这一轮没有被拖成空耗，原本散乱的压力第一次被拧成了同一个方向。`,
    `等到港口灯火次第亮起，赤屿内外的节奏已经和几个时辰前完全不同。工坊那边的锤声比往常更密，值夜的人手重新补上，连最容易被忽略的转运空档都被悄悄填平。李凡站在高处往下看，没有把这点变化当成胜势，因为他知道真正的麻烦还没上桌。可至少到了这一刻，他已经把“${normalizedEvent}”从一句必须完成的提纲，压成了所有人都能感到疼、也都不得不往前推的现实动作。更远处的黑潮仍在逼近，而下一轮更硬的条件，也已经在夜色里摆到了门口。`,
  ];

  return body.join("\n\n");
}

function buildStructureResponse(totalChapters) {
  const titleVariants = ["潮窗立桩", "暗港试火", "灰契落锚", "夜航换旗", "税簿见血", "哨船折返", "硝池开闸", "封港试锋"];
  const locationVariants = ["赤屿内港", "南坡火药坊", "北汊炮台", "税仓议事棚", "黑水道外缘", "铜山税港", "狼山口前哨", "海州外海"];
  const hookVariants = [
    "新的盟友条件已经摆上桌面。",
    "下一轮潮窗只剩半夜。",
    "账上的缺口突然暴露出来。",
    "前线传来的坏消息压住了所有人。",
    "更大的势力试探正在逼近。",
    "这一仗背后的代价开始浮出水面。",
    "下一章必须立刻改变原定部署。",
    "局势在看似平静处突然翻面。",
  ];
  const eventVariants = [
    ["李凡压实据点底盘并校准工坊流程", "宋应星把技术方案往可执行方向收紧", "局势因此获得新的推进空间"],
    ["李凡围绕税粮和补给重新分配资源", "郑芝龙带着交易与试探一起压上来", "主线因此出现更高阶的利益碰撞"],
    ["李凡把前线动作和后方账目绑定起来", "顾骁要求更快的出击窗口", "盘面因为指挥选择而变得更危险"],
    ["李凡推动新一轮扩军与整编", "多尔衮的外部压力逼近边界", "人物关系和战略判断都被同时拉紧"],
    ["李凡处理内部摩擦与扩张代价", "宋应星交出新的军工进展", "下一步推进必须建立在真实成本上"],
    ["李凡借一次试探战校验防线", "郑芝龙重新谈判分润与站位", "主角不得不重新定义合作边界"],
    ["李凡把资源线和人心线一起往前推", "顾骁带来更激进的执行方案", "阶段中段的爆点开始被提前点亮"],
    ["李凡在收束阶段前清理关键隐患", "外部势力的条件突然改变", "章末牵引因此转向更大的决断"],
  ];
  const stageCount = 4;
  const chaptersPerStage = Math.ceil(totalChapters / stageCount);
  const stages = Array.from({ length: stageCount }, (_, index) => ({
    label: `阶段${index + 1}·阶段推进 ${index + 1}`,
    purpose: `负责完成第 ${index + 1} 段核心推进，并抬升局势规模。`,
    stageGoal: `完成阶段${index + 1}的关键目标。`,
    stageConflicts: [`阶段${index + 1}冲突A`, `阶段${index + 1}冲突B`],
  }));

  const chapters = Array.from({ length: totalChapters }, (_, index) => {
    const chapterNumber = index + 1;
    const stageIndex = Math.min(stageCount - 1, Math.floor(index / chaptersPerStage));
    const titleVariant = titleVariants[index % titleVariants.length];
    const locationVariant = locationVariants[index % locationVariants.length];
    const hookVariant = hookVariants[index % hookVariants.length];
    const eventVariant = eventVariants[index % eventVariants.length];
    return {
      chapterNumber,
      title: `${chapterTitle(chapterNumber)}·${titleVariant}`,
      stage: stages[stageIndex].label,
      timeInStory: `故事第${chapterNumber}日`,
      povCharacter: chapterNumber % 5 === 0 ? "郑芝龙" : "李凡",
      location: `${locationVariant}·区段${(chapterNumber % 3) + 1}`,
      keyEvents: [
        `${eventVariant[0]}（第${chapterNumber}章）`,
        `${eventVariant[1]}（第${chapterNumber}章）`,
        `${eventVariant[2]}（第${chapterNumber}章）`,
      ],
      arcContribution: [
        `李凡在第${chapterNumber}章学会用更大的盘面思考问题`,
        `${chapterNumber % 2 === 0 ? "宋应星" : "郑芝龙"}与主角的关系出现新变化`,
      ],
      nextHook: `第${chapterNumber}章钩子：${hookVariant}`,
      emotionalTone: chapterNumber % 2 === 0 ? "稳中带压" : "持续拉升",
      charactersPresent: [
        "李凡",
        "宋应星",
        chapterNumber % 3 === 0 ? "顾骁" : chapterNumber % 2 === 0 ? "多尔衮" : "郑芝龙",
      ],
      continuityAnchors: [`第${chapterNumber}章锚点A`, `第${chapterNumber}章锚点B`],
      scenes: [
        {
          label: "开局推进",
          location: `${locationVariant}·前场`,
          focus: `建立第${chapterNumber}章的行动目标`,
          tension: "让局势快速进入主冲突",
          characters: ["李凡", chapterNumber % 3 === 0 ? "顾骁" : "宋应星"],
        },
        {
          label: "正面碰撞",
          location: `${locationVariant}·冲突点`,
          focus: `围绕第${chapterNumber}章核心资源与势力发生碰撞`,
          tension: "人物立场与利益正面撞上",
          characters: ["李凡", chapterNumber % 2 === 0 ? "多尔衮" : "郑芝龙"],
        },
        {
          label: "章末回响",
          location: `${locationVariant}·后场`,
          focus: "让章末钩子落地",
          tension: "留下新的战略悬念",
          characters: ["李凡", "宋应星"],
        },
      ],
    };
  });

  return { stages, chapters };
}

function buildStageStructureResponse(totalChapters, chapterStart, chapterEnd) {
  const full = buildStructureResponse(totalChapters);
  const chapters = full.chapters.filter(
    (chapter) => chapter.chapterNumber >= chapterStart && chapter.chapterNumber <= chapterEnd,
  );
  const firstStageLabel = chapters[0]?.stage || `阶段1·阶段推进 1`;
  const stage = full.stages.find((item) => item.label === firstStageLabel) || {
    label: firstStageLabel,
    purpose: `${firstStageLabel}负责推进当前阶段任务。`,
    stageGoal: `${firstStageLabel}阶段目标`,
    stageConflicts: ["阶段冲突A", "阶段冲突B"],
  };

  return {
    stage,
    chapters,
  };
}

test("buildStructure allows minor characters outside cast and records them", () => {
  const structure = buildStructure(
    { totalChapters: 1, stageCount: 1 },
    [{ name: "李凡" }, { name: "宋应星" }],
    {
      chapters: [
        {
          chapterNumber: 1,
          title: "第一章",
          stage: "阶段1",
          timeInStory: "故事第一日",
          povCharacter: "李凡",
          location: "主舞台",
          keyEvents: ["李凡见到次要角色郑森", "局势因此出现新波动"],
          arcContribution: ["李凡意识到海上线索正在变复杂"],
          nextHook: "郑森带来的消息会改变下一章布局。",
          emotionalTone: "压迫中带着试探",
          charactersPresent: ["李凡", "宋应星", "郑森"],
          continuityAnchors: ["郑森首次带来海上情报"],
          scenes: [
            {
              label: "相见",
              location: "码头",
              focus: "郑森带着新消息出现",
              tension: "李凡需要判断郑森是否可信",
              characters: ["李凡", "郑森"],
            },
            {
              label: "议事",
              location: "工坊",
              focus: "李凡与宋应星消化这份情报",
              tension: "决定是否采纳郑森路线",
              characters: ["李凡", "宋应星", "郑森"],
            },
          ],
        },
      ],
      stages: [
        {
          label: "阶段1",
          purpose: "建立新线索",
          stageGoal: "把海上线索带入主线",
          stageConflicts: ["信任风险"],
        },
      ],
    },
    { foreshadowings: [] },
  );

  assert.equal(structure.chapters[0].povCharacter, "李凡");
  assert.equal(structure.minorCharacters.length, 1);
  assert.deepEqual(structure.minorCharacters[0], {
    name: "郑森",
    role: "次要角色",
    firstAppearanceChapter: "ch001",
    lastAppearanceChapter: "ch001",
    chapterIds: ["ch001"],
    sceneIds: ["ch001_scene_1", "ch001_scene_2"],
    chapterCount: 1,
    sceneCount: 2,
    suggestedPromotion: false,
  });
});

test("buildStructure still requires POV characters to come from cast", () => {
  assert.throws(
    () =>
      buildStructure(
        { totalChapters: 1, stageCount: 1 },
        [{ name: "李凡" }, { name: "宋应星" }],
        {
          chapters: [
            {
              chapterNumber: 1,
              title: "第一章",
              stage: "阶段1",
              timeInStory: "故事第一日",
              povCharacter: "郑森",
              location: "主舞台",
              keyEvents: ["郑森主导了本章推进", "李凡被动接招"],
              arcContribution: ["主角没有拿到叙事主导权"],
              nextHook: "局势开始偏离主线。",
              emotionalTone: "不稳定",
              charactersPresent: ["李凡", "郑森"],
              continuityAnchors: ["郑森视角进入主线"],
              scenes: [
                {
                  label: "开局",
                  location: "码头",
                  focus: "郑森先出场",
                  tension: "错误地把次要角色抬成 POV",
                  characters: ["郑森", "李凡"],
                },
                {
                  label: "对话",
                  location: "工坊",
                  focus: "郑森继续掌控场面",
                  tension: "主角被边缘化",
                  characters: ["郑森", "李凡"],
                },
              ],
            },
          ],
          stages: [
            {
              label: "阶段1",
              purpose: "建立新线索",
              stageGoal: "把海上线索带入主线",
              stageConflicts: ["信任风险"],
            },
          ],
        },
        { foreshadowings: [] },
      ),
    /ch001 的 POV 角色必须来自 cast：郑森/,
  );
});

test("assembleChapterMarkdown keeps the final chapter free of scene headings and meta notes", () => {
  const markdown = assembleChapterMarkdown(
    "第一章",
    [
      { sceneLabel: "开局", markdown: "李凡推门进去，先看见灯，再看见人。" },
      { sceneLabel: "碰撞", markdown: "宋应星把账册一合，直接把问题摊到了桌上。" },
    ],
    [],
    {
      emotionalTone: "稳中带压",
      nextHook: "下一步麻烦已经逼近",
    },
  );

  assert.match(markdown, /^# 第一章/);
  assert.ok(!markdown.includes("## 开局"));
  assert.ok(!markdown.includes("写作备注："));
  assert.ok(!markdown.includes("本章的节奏基调保持在"));
});

test("runValidations flags meta leakage and first-person narration in third-person projects", () => {
  const validation = runValidations(
    {
      title: "第一章",
      keyEvents: ["李凡来到赤屿", "顾骁提出劫粮"],
      charactersPresent: ["李凡", "顾骁"],
      foreshadowingActions: [],
    },
    {
      markdown: "# 第一章\n\n我先醒过来，看到顾骁站在门口。\n\n## 场景1：开局\n\n写作备注：这里应该更紧张。",
      usedForeshadowings: [],
    },
    {
      styleNotes: "第三人称有限视角。",
    },
  );

  assert.equal(validation.style.passed, false);
  assert.match(validation.style.summary, /系统元信息|第三人称有限视角/);
  assert.ok(
    validation.style.issues.some((item) => item.includes("系统元信息")) ||
      validation.style.issues.some((item) => item.includes("第一人称")),
  );
});

test("runValidations flags missing planned named characters", () => {
  const validation = runValidations(
    {
      title: "第一章",
      keyEvents: ["李凡稳住船身", "林定海下令清舱"],
      charactersPresent: ["李凡", "林定海", "众水手"],
      foreshadowingActions: [],
    },
    {
      markdown: "# 第一章\n\n李凡压住舵链，几名水手跟着扑上来稳船。",
      usedForeshadowings: [],
    },
  );

  assert.equal(validation.plausibility.passed, false);
  assert.match(validation.plausibility.summary, /林定海/u);
});

async function withStubbedOpenAI(callback) {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousZhipuKey = process.env.ZHIPU_API_KEY;
  const previousFakeEmbeddings = process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.ZHIPU_API_KEY = "test-zhipu-key";
  process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS = "true";

  globalThis.fetch = async (_url, options = {}) => {
    const targetUrl = String(_url || "");
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input) || String(payload.input || "");

    if (targetUrl.includes("open.bigmodel.cn/api/paas/v4/embeddings")) {
      return jsonResponse({
        data: [
          {
            embedding: buildEmbeddingVector(payload.input),
          },
        ],
      });
    }

    if (instructions.includes("CharacterPlanningAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          characters: [
            {
              roleKey: "protagonist",
              role: "主角",
              name: "李凡",
              historicalStatus: "fictional",
              nameRationale: "现代穿越者，方便承接主角目标。",
              tags: ["理性", "执行力", "扩张意识"],
              voice: "说话直截了当，偏行动导向。",
              desire: "完成主角目标并扩张自己的势力版图。",
              wound: "害怕失控，必须用结果证明自己。",
              blindspot: "容易高估自己的掌控力。",
              signatureItem: "一本写满技术草图的手册",
              appearance: "总把衣袖卷起，像随时要开始干活。",
              entryLocation: "主角起势之地",
              relationshipHint: "他必须自己扛起局面。",
            },
            {
              roleKey: "ally",
              role: "盟友",
              name: "宋应星",
              historicalStatus: "real",
              nameRationale: "工艺与技术线的关键支点。",
              tags: ["工匠气", "务实", "博学"],
              voice: "解释问题时耐心而具体。",
              desire: "推动技术落地并借主角扩展实践空间。",
              wound: "长期怀才不遇。",
              blindspot: "有时低估政治危险。",
              signatureItem: "批注密密麻麻的手稿",
              appearance: "衣冠整洁，眼神专注。",
              entryLocation: "工坊与书院之间",
              relationshipHint: "既是智囊，也是现实约束的提醒者。",
            },
            {
              roleKey: "rival",
              role: "对手 / 感情线",
              name: "郑芝龙",
              historicalStatus: "real",
              nameRationale: "海上贸易与武装网络的竞争者。",
              tags: ["精明", "多线下注", "海权意识"],
              voice: "说话留有余地，像在谈价。",
              desire: "确保自己的海上利益不被主角吞并。",
              wound: "信任成本极高。",
              blindspot: "容易把所有关系都理解成交易。",
              signatureItem: "海图与港口账册",
              appearance: "衣着讲究，带海风里的压迫感。",
              entryLocation: "港口与舰队据点",
              relationshipHint: "既可能合作，也随时可能翻脸。",
            },
            {
              roleKey: "antagonist",
              role: "反派",
              name: "多尔衮",
              historicalStatus: "real",
              nameRationale: "外部军事与政治压力的核心代表。",
              tags: ["强势", "统筹", "扩张性"],
              voice: "措辞简练，压迫感强。",
              desire: "以更强的军政力量压倒所有对手。",
              wound: "只相信强权与结果。",
              blindspot: "低估地方势力重新组织的速度。",
              signatureItem: "军令与地图",
              appearance: "气场冷硬，像随时准备下令。",
              entryLocation: "敌对军政中枢",
              relationshipHint: "主线最大的外部高压来源。",
            },
            {
              roleKey: "support_1",
              role: "支线角色",
              name: "朱由检",
              historicalStatus: "real",
              nameRationale: "旧秩序的关键节点。",
              tags: ["焦灼", "多疑", "承担旧体制压力"],
              voice: "语气克制但带紧绷感。",
              desire: "维持摇摇欲坠的既有秩序。",
              wound: "局势失控感过强。",
              blindspot: "常被旧体制拖累判断。",
              signatureItem: "批红与奏疏",
              appearance: "疲惫却仍强撑威仪。",
              entryLocation: "朝堂中心",
              relationshipHint: "既需要主角成果，又忌惮主角坐大。",
            },
            {
              roleKey: "support_2",
              role: "支线角色",
              name: "李自成",
              historicalStatus: "real",
              nameRationale: "另一股不可忽视的争霸势力。",
              tags: ["强攻", "民变", "机会主义"],
              voice: "直来直往，压着怒气。",
              desire: "抢在各方之前夺取更大地盘与资源。",
              wound: "始终缺稳定秩序支撑。",
              blindspot: "容易忽视长期治理成本。",
              signatureItem: "军旗与檄文",
              appearance: "粗粝强硬，带着战场感。",
              entryLocation: "前线势力范围",
              relationshipHint: "在乱局中既是威胁也是变量。",
            },
          ],
        }),
      });
    }

    if (instructions.includes("CriticAgent_A") && inputText.includes("待审大纲草稿")) {
      return jsonResponse({
        output_text: JSON.stringify({
          passed: true,
          score: 92,
          summary: "大纲草稿已经围绕主角目标、题材承诺和阶段升级路径建立起清晰主线，可以进入下一步。",
          issues: [],
          checks: [
            { name: "题材承诺", passed: true, detail: "种田、工业、海权和争霸承诺都已经直接写进核心梗与简纲。" },
            { name: "主角目标", passed: true, detail: "主角要做什么、为什么扩张、最终打到什么规模都很清楚。" },
            { name: "阶段推进", passed: true, detail: "四个阶段呈现出明显的规模抬升和战略升级。" },
            { name: "角色与冲突", passed: true, detail: "关键角色与外部势力都在为主线施压，而不是游离在外。" },
          ],
        }),
      });
    }

    if (instructions.includes("CriticAgent_B") && inputText.includes("待审大纲草稿")) {
      return jsonResponse({
        output_text: JSON.stringify({
          passed: true,
          score: 90,
          summary: "从草稿逆向重建出的作品承诺与原项目目标保持一致，没有出现题材偏轴。",
          reconstructedHook: "李凡通过种田、工业和海陆军扩张积累国力，并在明末多方争霸中争夺问鼎中原的资格。",
          reconstructedSummary: "故事会先做经营和生产底盘，再把工业、海权和军事体系滚大，最后进入全国级别的争霸与秩序重建。",
          issues: [],
        }),
      });
    }

    if (instructions.includes("RevisionAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          coreHook: "李凡以种田、工业与海陆军建设为根基，在明末乱世拉起自有势力，并在明廷、流寇与女真三方夹击中争夺问鼎中原的资格。",
          shortSynopsis: "李凡穿越到明末后，不再满足于只求生存，而是决定从生产、工业与军备三线同时起势，把自己的地盘、舰队和制度一步步做大。在宋应星等关键人物的帮助下，他会先解决粮食、工坊、军械和港口的问题，再把海上贸易、沿岸据点和陆上动员体系串成真正的国家机器。\n\n随着郑芝龙、多尔衮、李自成以及崇祯朝廷等势力轮番施压，李凡必须在合作、吞并、对抗和借势之间不断重新选边。故事的重心不在调查谜团，而在如何把资源、技术、军队、制度和人心整合起来，形成足以改写时代格局的新力量。\n\n主线将围绕“扩产、扩军、扩权、扩张”持续抬升规模：从一地经营，到海陆并进，再到全国级别的争霸。李凡最终要面对的问题不是能否看清真相，而是他是否有能力把自己打造出的秩序推到天下层面。",
          roughSections: [
            { stage: "阶段1·起势立盘", content: "李凡完成立足、屯田、工坊与基本武装的搭建，并拿下第一批真正可控的资源与人手。" },
            { stage: "阶段2·海陆扩编", content: "李凡把工业、舰队、训练和据点经营结合起来，在海陆两线同时扩大影响力，并首次与多方势力正面博弈。" },
            { stage: "阶段3·三线争霸", content: "李凡在明廷、流寇、女真之间周旋与开战，把此前经营成果全面转化为军政优势。" },
            { stage: "阶段4·问鼎中原", content: "李凡完成最终势力整合，在大战与制度重建中决定自己能否真正问鼎天下。" },
          ],
        }),
      });
    }

    if (instructions.includes("FeedbackSupervisorAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          passed: true,
          summary: "当前版本已经落实作者反馈。",
          missingItems: [],
          revisionNotes: [],
          evidence: "",
          scopeBlocked: false,
        }),
      });
    }

    if (
      instructions.includes("OutlineAgent") &&
      !instructions.includes("ChapterOutlineAgent") &&
      !instructions.includes("ChapterOutlineFinalizeAgent") &&
      inputText.includes("请输出如下 JSON")
    ) {
      return jsonResponse({
        output_text: JSON.stringify({
          coreHook: "李凡以种田、工业和海陆军建设为底盘，在明末乱世中同时与明廷、流寇和女真角力，最终争夺问鼎中原的资格。",
          shortSynopsis: "李凡穿越到明末后，决定先解决生存与生产问题，再把技术、工业、军备和海运变成自己的真实力量。随着工坊、港口、军械和地盘不断扩张，他不再只是一个想活下去的人，而是一个有机会改写时代格局的新势力组织者。\n\n宋应星会为李凡补足技术与工艺体系，顾骁则会逐步成长为负责船厂、炮台和海防组织的长期执行骨干；郑芝龙代表海权竞争与合作压力，多尔衮则代表最强的外部军事威胁。与此同时，崇祯朝廷与李自成等势力不断改变战场形势，让李凡必须在经营、扩张、谈判、吞并和战争之间迅速完成升级。\n\n故事将围绕“扩产、扩军、扩权、扩张”四个层面持续抬升规模，从一地经营走向天下争霸。主角的核心矛盾不是追查谜团，而是如何把资源、制度、军队与人心整合成足以问鼎中原的完整力量。",
          roughSections: [
            { stage: "阶段1·起势立盘", content: "李凡从最初的立足点开始，通过屯田、工坊、基础军械和组织训练建立稳定底盘，同时把第一批关键人物与资源拉到自己旗下，并让顾骁开始负责船厂秩序与炮队雏形。" },
            { stage: "阶段2·海陆扩编", content: "李凡把工业产能、海上通路、舰队建设和陆上据点联动起来，让经营成果第一次转化成区域级别的军事与财政优势，顾骁也在此阶段成为海防体系的骨干。" },
            { stage: "阶段3·三线争霸", content: "李凡在明廷、流寇与女真之间周旋、交易与开战，把此前积累的生产与军备能力全面转成战略纵深。" },
            { stage: "阶段4·问鼎中原", content: "李凡完成势力整合、制度重建和大战决胜，在最高规模的战争与秩序竞争中决定自己是否能够真正问鼎天下。" },
          ],
        }),
      });
    }

    if (instructions.includes("CastExpansionAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          additionalCharacters: [
            {
              name: "顾骁",
              role: "海防骨干 / 船厂执行者",
              historicalStatus: "fictional",
              nameRationale: "大纲明确让他承担船厂、炮台和海防组织的长期执行功能。",
              tags: ["执行力", "军务", "海防"],
              voice: "措辞简短，偏执行汇报。",
              desire: "把李凡的海防与船厂体系真正落到地面。",
              wound: "早年在海上混战中失去旧部，极度厌恶失控。",
              blindspot: "习惯以军事效率压过人情与缓冲。",
              signatureItem: "不离手的巡防册与火器清单",
              appearance: "常穿方便行动的短打，身上带着海风和硝烟味。",
              entryLocation: "船厂与海防炮台之间",
              relationshipHint: "是主角的重要执行骨干，但会逼迫主角面对扩军成本。",
            },
          ],
        }),
      });
    }

    if (
      instructions.includes("OutlineAgent") &&
      !instructions.includes("ChapterOutlineAgent") &&
      !instructions.includes("ChapterOutlineFinalizeAgent")
    ) {
      return jsonResponse({
        output_text: "# 锁定大纲\n\n## 一句话核心梗\n李凡通过种田、工业和海陆军建设完成势力扩张，并在多方争霸中争夺问鼎中原的资格。\n\n## 整体简纲\n故事从经营起势一路抬升到天下争霸，所有主线都围绕资源、军备、制度和战争规模扩张展开。\n\n## 阶段推进\n- 阶段1：起势立盘\n- 阶段2：海陆扩编\n- 阶段3：三线争霸\n- 阶段4：问鼎中原\n\n## 关键角色弧光\n- 李凡：从经营者成长为真正的争霸者。\n- 宋应星：从技术支持者成长为体系建设核心。\n- 郑芝龙：在合作与竞争之间不断重排站位。\n",
      });
    }

    if (instructions.includes("ForeshadowingPlannerAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          foreshadowings: [
            { id: "fsh_001", description: "李凡最初建立的工坊体系其实隐藏着进一步扩产的关键瓶颈。", plantAt: 1, waterAt: [4, 8], payoffAt: 12, tags: ["工业", "主线"] },
            { id: "fsh_002", description: "宋应星带来的某项工艺突破将直接决定后续军备升级速度。", plantAt: 2, waterAt: [6, 10], payoffAt: 16, tags: ["技术", "宋应星"] },
            { id: "fsh_003", description: "郑芝龙对李凡的态度会随着海权格局变化发生决定性转折。", plantAt: 3, waterAt: [9, 15], payoffAt: 20, tags: ["海权", "郑芝龙"] },
          ],
        }),
      });
    }

    if (instructions.includes("StructureAgent")) {
      const totalChaptersMatch = inputText.match(/目标章节数：(\d+)/);
      const totalChapters = Number(totalChaptersMatch?.[1] || 24);
      if (inputText.includes("当前批次负责章节")) {
        const batchRangeMatch = inputText.match(/当前批次负责章节：(\d+)-(\d+)/);
        const chapterStart = Number(batchRangeMatch?.[1] || 1);
        const chapterEnd = Number(batchRangeMatch?.[2] || totalChapters);
        return jsonResponse({
          output_text: JSON.stringify({
            chapters: buildStageStructureResponse(totalChapters, chapterStart, chapterEnd).chapters,
          }),
        });
      }

      if (inputText.includes("本阶段负责章节")) {
        const stageRangeMatch = inputText.match(/本阶段负责章节：(\d+)-(\d+)/);
        const chapterStart = Number(stageRangeMatch?.[1] || 1);
        const chapterEnd = Number(stageRangeMatch?.[2] || totalChapters);
        return jsonResponse({
          output_text: JSON.stringify({
            stage: buildStageStructureResponse(totalChapters, chapterStart, chapterEnd).stage,
          }),
        });
      }

      const stageRangeMatch = inputText.match(/本阶段负责章节：(\d+)-(\d+)/);
      const chapterStart = Number(stageRangeMatch?.[1] || 1);
      const chapterEnd = Number(stageRangeMatch?.[2] || totalChapters);
      return jsonResponse({
        output_text: JSON.stringify(buildStageStructureResponse(totalChapters, chapterStart, chapterEnd)),
      });
    }

    if (instructions.includes("StructureCriticAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          passed: true,
          retryRecommended: false,
          summary: "结构输出具备题材兑现、推进差异度和钩子变化，可以继续进入后续流程。",
          issues: [],
          checks: [
            { name: "题材兑现", passed: true, detail: "当前结构仍然围绕项目承诺推进，没有跑偏成别的题材。" },
            { name: "推进差异度", passed: true, detail: "章节与阶段各自承担不同推进功能，没有明显换皮重复。" },
            { name: "钩子多样性", passed: true, detail: "章末牵引没有陷入单一句式模板。" },
            { name: "角色驱动", passed: true, detail: "关键推进仍由主要角色承担，不是功能角色在硬推情节。" },
          ],
        }),
      });
    }

    if (instructions.includes("WorldbuildingAgent")) {
      return jsonResponse({
        output_text: "# 世界观设定\n\n## 时代与格局\n- 故事发生在多方势力同时角逐的高压时代。\n- 生产、军备、港口、贸易和制度建设共同决定势力上限。\n\n## 写作约束\n- 所有重大推进都要落到资源、制度、军队和地盘变化上。\n- 每次扩张都必须伴随代价与反噬。\n",
      });
    }

    if (instructions.includes("CharacterAgent")) {
      const nameMatch = inputText.match(/角色名：(.+)/);
      const name = (nameMatch?.[1] || "角色").trim();
      return jsonResponse({
        output_text: JSON.stringify({
          biographyMarkdown: `# ${name}·人物小传\n\n${name}在本作中承担关键推进职责，其行动始终与主线目标紧密相连。`,
          profileMarkdown: `# ${name}·人物资料卡\n\n- 核心功能：推动主线与势力格局变化\n- 当前状态：已进入主要矛盾`,
          storylineMarkdown: `# ${name}·人物线\n\n- 起点：从既有立场进入主线。\n- 中段：在更大的局势压力下被迫调整选择。\n- 高点：在关键章节完成立场兑现。\n- 关键章节：ch001 ${chapterTitle(1)} / ch006 ${chapterTitle(6)}`,
          state: {
            name,
            updated_after_chapter: "ch000",
            physical: {
              location: "主舞台",
              health: "良好",
              appearance_notes: `${name}具备鲜明辨识度`,
            },
            psychological: {
              current_goal: `${name}正在围绕主线推进自己的目标`,
              emotional_state: "谨慎而紧绷",
              stress_level: 4,
              key_beliefs: ["任何推进都伴随代价", "局势必须靠行动改写"],
            },
            relationships: {},
            knowledge: {
              knows: [`${name}知道主线冲突已经启动`],
              does_not_know: [`${name}尚不知道最终局势会如何全面升级`],
            },
            inventory_and_resources: {
              money: "有限但可调配",
              key_items: [`${name}的关键物品`],
            },
            arc_progress: {
              current_phase: "主线启动前夜",
              arc_note: `${name}尚未完成自己的关键选择`,
            },
          },
        }),
      });
    }

    if (instructions.includes("CriticAgent_A")) {
      return jsonResponse({
        output_text: JSON.stringify({
          passed: true,
          score: 94,
          summary: "最终锁定大纲包已经具备持续写作能力，结构、人物和世界约束彼此支撑。",
          issues: [],
          checks: [
            { name: "结构可执行性", passed: true, detail: "阶段与逐章目标清晰，后续写作可以直接按章推进。" },
            { name: "人物弧光", passed: true, detail: "主要人物都有明确欲望、伤口和阶段推进位置。" },
            { name: "世界约束", passed: true, detail: "世界观文档提供了资源、军备和制度层面的稳定约束。" },
            { name: "题材兑现", passed: true, detail: "最终包持续兑现经营、扩军和争霸题材，不存在跑偏。" },
          ],
        }),
      });
    }

    if (instructions.includes("CriticAgent_B")) {
      return jsonResponse({
        output_text: JSON.stringify({
          passed: true,
          score: 91,
          summary: "从最终锁定大纲包逆推出来的主线承诺与项目目标保持一致，规模升级路径清楚。",
          reconstructedHook: "主角以经营、工业和海陆军建设壮大势力，并在乱世多方争霸中走向问鼎。",
          reconstructedSummary: "项目会从地方经营升级到区域扩张，再进入跨势力大战与最终天下竞争。",
          issues: [],
        }),
      });
    }

    if (instructions.includes("OutlineContextAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          storyPromises: ["主角要通过经营、工业和扩张持续抬高盘面。", "每一章都要让争霸主线继续推进。"],
          stageObjectives: ["当前阶段要把局势从立足点推进到更大规模竞争。", "资源、制度和人物关系要同步升级。"],
          chapterObligations: ["本章必须把简纲中的核心推进写实落地。", "章末必须把下一步扩张压力抬出来。"],
          mustPreserve: ["保持当前 POV、时间地点与既定事件顺序。"],
          deferUntilLater: ["不能提前解决后续阶段的大规模胜负。"],
          continuityRisks: ["不要把资源升级写成轻松完成。", "不要提前透支下一章钩子。"],
          recommendedFocus: "把本章写成一次有代价的推进，而不是平推说明。",
        }),
      });
    }

    if (instructions.includes("CharacterContextAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          characters: [
            {
              name: "李凡",
              onStageRole: "本章的推进核心",
              currentNeed: "尽快把资源和人手组织成可执行方案",
              voiceNote: "说话直接、判断快，但不会轻易暴露底牌",
              knowledgeBoundary: "不能直接知道所有对手后续安排",
              relationshipPressure: "既要压住郑芝龙的试探，也要接住宋应星的技术节奏",
              hiddenPressure: "每次扩张都在逼他承担更大代价",
            },
          ],
          groupDynamics: ["合作与试探要同时存在，不能一团和气。"],
          writerReminders: ["人物对白要服务博弈，不要写成说明书。", "角色行动要体现各自诉求差异。"],
          forbiddenLeaks: ["李凡不能直接说出尚未公开的终局信息。"],
        }),
      });
    }

    if (instructions.includes("WorldContextAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          worldConstraints: ["所有推进都要落到资源、制度、军备和地盘变化上。", "每次扩张都必须伴随代价与反噬。"],
          eraDetails: ["故事处于高压乱世，多方势力同时角逐。", "港口、工坊和军备线彼此牵动。"],
          styleRules: ["正文保持第三人称有限视角。", "避免提纲式复述，要把压力落进场景。"],
          foreshadowingTasks: ["plant:fsh_001", "track:fsh_002"],
          continuityAnchors: ["章末要保留下一步扩张的悬念。"],
          researchFlags: ["涉及时代细节时不要写得太现代。"],
        }),
      });
    }

    if (instructions.includes("ResearchPlannerAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          triggered: true,
          reason: "本章涉及明末海防、港口与时代术语，存在明显考据需求。",
          queries: [
            "明末福建沿海港口常见的海防与贸易场景细节",
            "明末港口与海商相关常见称呼、文书与组织说法",
          ],
          focusFacts: [
            "港口、船厂、海防炮台相关说法是否合时代",
            "人物对官府、海商与军务的称呼是否失真",
          ],
          riskFlags: ["不要写出现代化港务管理术语。"],
        }),
      });
    }

    if (instructions.includes("ResearchRetriever")) {
      assert.equal(Array.isArray(payload.tools), false);
      assert.match(inputText, /MCP web_search 结果：/);
      assert.match(inputText, /明代海防研究资料/);
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "明末福建沿海场景应强调港口、船厂、巡检、营汛与海商网络的混杂秩序，避免现代港务和公司化表达。",
          factsToUse: [
            "港口与船厂往往和巡检、营汛、防务组织连在一起，不是现代化单一运营空间。",
            "海商势力与地方军政力量关系复杂，合作与戒备并存。",
          ],
          factsToAvoid: [
            "不要使用现代企业管理、码头调度中心、安保系统之类说法。",
            "不要把明末港口写成高度标准化的近代工业港。",
          ],
          termBank: [
            "营汛：沿海驻防与汛地体系",
            "巡检：基层巡防与缉查职责相关称呼",
          ],
          uncertainPoints: ["具体官职细分仍需按具体地域继续核实。"],
          sourceNotes: [
            "来源交叉提到沿海防务与海商网络并存。",
            "地方志和史料性文章都强调场景的军商混杂属性。",
          ],
        }),
      });
    }

    if (instructions.includes("ResearchSynthesizerAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "本章港口与海防场景应写出军商混杂、秩序紧绷的明末沿海质感，避免近代港务或现代管理语言。",
          factsToUse: [
            "港口、船厂、巡检和防务组织往往彼此纠缠。",
            "海商与地方军政之间既交易又互相防范。",
          ],
          factsToAvoid: [
            "不要出现现代港务公司、流水线港口调度等说法。",
            "不要把场景写成现代工业化海港。",
          ],
          termBank: [
            "营汛：沿海驻防与汛地体系",
            "巡检：基层巡防与缉查职责相关称呼",
          ],
          uncertainPoints: ["具体官职层级仍需谨慎，不要乱下定论。"],
          sourceNotes: [
            "检索结果集中强调军商混杂和地方防务色彩。",
            "术语应尽量贴近明末沿海治理语境。",
          ],
        }),
      });
    }

    if (instructions.includes("ChapterOutlineFinalizeAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          title: "第1章·拼接定稿",
          timeInStory: "故事第1日",
          povCharacter: "李凡",
          location: "赤屿内港·议事棚",
          keyEvents: ["李凡先稳住局面", "郑芝龙抛出条件", "章末把压力抬高"],
          arcContribution: ["李凡开始学会用交易换空间", "郑芝龙的试探更明确了"],
          nextHook: "新的交易条件已经逼到眼前。",
          emotionalTone: "稳中带压",
          threadMode: "single_spine",
          dominantThread: "李凡必须先稳住局面，再接住外部试探。",
          entryLink: "承接上一章留下的高压盘面与未定交易。",
          exitPressure: "新的交易条件已经逼到眼前。",
          charactersPresent: ["李凡", "宋应星", "郑芝龙"],
          continuityAnchors: ["必须承接上一章留下的压力"],
          scenes: [
            {
              label: "拼接开局",
              location: "赤屿内港·议事棚",
              focus: "把各方目标摆上桌面",
              tension: "先用秩序压住场面",
              characters: ["李凡", "宋应星"],
              threadId: "main",
              scenePurpose: "接住上一章余波并明确本章主问题",
              inheritsFromPrevious: "承接上一章抬高后的高压局面",
              outcome: "李凡先把局势压稳",
              handoffToNext: "把试探推到正面交锋",
            },
            {
              label: "拼接碰撞",
              location: "赤屿内港·码头",
              focus: "让交易与试探正面碰撞",
              tension: "把合作与防备同时拉高",
              characters: ["李凡", "郑芝龙"],
              threadId: "main",
              scenePurpose: "把主线推进到新的交易压力",
              inheritsFromPrevious: "承接前场稳局后必须面对的外部条件",
              outcome: "新的合作条件被摆上桌面",
              handoffToNext: "把更高压力递给下一章",
            },
          ],
        }),
      });
    }

    if (instructions.includes("ChapterOutlineConsistencyAuditAgent")) {
      const proposalIds = [...new Set(
        [...inputText.matchAll(/proposal_[\w-]+/g)].map((match) => match[0]).filter(Boolean),
      )].slice(0, 5);
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "细纲整章一致性检查通过。",
          candidateAudits: (proposalIds.length ? proposalIds : ["proposal_1"]).map((proposalId) => ({
            proposalId,
            passed: true,
            score: 92,
            summary: `${proposalId} 没有发现阻断性的跨章节一致性问题。`,
            issues: [],
            revisionNotes: [],
          })),
        }),
      });
    }

    if (instructions.includes("ChapterOutlineRepairAgent")) {
      const chapterMatch = inputText.match(/当前章节：ch(\d+)/);
      const chapterNumber = Number(chapterMatch?.[1] || 1);
      const proposalIds = [...new Set(
        [...inputText.matchAll(/proposal_[\w-]+/g)].map((match) => match[0]).filter(Boolean),
      )].slice(0, 3);
      return jsonResponse({
        output_text: JSON.stringify({
          proposals: (proposalIds.length ? proposalIds : ["proposal_1"]).map((proposalId, index) => ({
            proposalId,
            summary: "修复后直接承接上一章压力，删除重开式开场和事实重置。",
            rationale: "保留原候选的冲突轴和人物焦点，只修复跨章节连续性冲突。",
            diffSummary: `第 ${index + 1} 个候选已改成直接承压推进。`,
            title: `第${chapterNumber}章·续压修复`,
            timeInStory: `故事第${chapterNumber}日`,
            povCharacter: "李凡",
            location: "赤屿内港",
            keyEvents: ["承接上一章压力", "把执行代价推到台前", "章末留下更急压力"],
            arcContribution: ["李凡在更高风险下继续掌控局面"],
            nextHook: "更急的行动窗口已经逼到眼前。",
            emotionalTone: "承压推进",
            threadMode: "single_spine",
            dominantThread: "承接上一章压力继续推进，不重开开篇。",
            entryMode: "direct_resume",
            entryLink: "承接上一章留下的高压盘面与执行压力。",
            exitPressure: "更急的行动窗口已经逼到眼前。",
            charactersPresent: ["李凡", "宋应星", "郑芝龙"],
            continuityAnchors: ["承接上一章压力", "不得重置已定事实"],
            evidenceRefs: ["ch001_outline_exit"],
            scenes: [
              {
                label: "承压续场",
                location: "赤屿内港·议事棚",
                focus: "把上一章留下的压力接到当前行动现场",
                tension: "执行窗口正在收紧",
                characters: ["李凡", "宋应星"],
                threadId: "main",
                scenePurpose: "承接上一章余波并明确本章主问题",
                inheritsFromPrevious: "承接上一章留下的高压盘面与执行压力",
                outcome: "本章主问题被推进到更具体的执行代价",
                handoffToNext: "把外部试探推向正面回应",
              },
              {
                label: "抬高代价",
                location: "赤屿内港·码头",
                focus: "把主线推向更高风险的执行选择",
                tension: "外部试探和内部代价同时压上来",
                characters: ["李凡", "郑芝龙"],
                threadId: "main",
                scenePurpose: "让主线继续升级并递交章末压力",
                inheritsFromPrevious: "承接前场确认后的即时后果",
                outcome: "下一步行动窗口被压缩",
                handoffToNext: "把更急的行动窗口递给下一章",
              },
            ],
          })),
        }),
      });
    }

    if (instructions.includes("ChapterOutlineAgent")) {
      const chapterMatch = inputText.match(/当前章节：ch(\d+)/);
      const chapterNumber = Number(chapterMatch?.[1] || 1);
      return jsonResponse({
        output_text: JSON.stringify({
          proposals: [
            {
              proposalId: "proposal_1",
              summary: "先稳局，再谈条件，最后把章末压力压实。",
              rationale: "用相对稳健的推进兑现本章义务。",
              diffSummary: "重心放在秩序与试探并行。",
              title: `第${chapterNumber}章·潮窗试探`,
              timeInStory: `故事第${chapterNumber}日`,
              povCharacter: "李凡",
              location: "赤屿内港",
              keyEvents: ["李凡压住场面", "郑芝龙带着条件出现", "章末留下下一步交易压力"],
              arcContribution: ["李凡的主导力更明确", "合作关系带上更高成本"],
              nextHook: "新的盟友条件已经摆上桌面。",
              emotionalTone: "稳中带压",
              threadMode: "single_spine",
              dominantThread: "李凡先稳住局面，再接住外部试探并把压力抬高。",
              entryLink: "承接上一章留下的高压盘面与资源压力。",
              exitPressure: "新的盟友条件已经摆上桌面。",
              charactersPresent: ["李凡", "宋应星", "郑芝龙"],
              continuityAnchors: ["上一章的高压余波还在", "本章不能轻松完成扩张"],
              scenes: [
                {
                  label: "稳住开局",
                  location: "赤屿内港·议事棚",
                  focus: "建立本章任务与资源压力",
                  tension: "先把局势收紧",
                  characters: ["李凡", "宋应星"],
                  threadId: "main",
                  scenePurpose: "接住余波并明确本章主问题",
                  inheritsFromPrevious: "承接上一章留下的高压与资源压力",
                  outcome: "李凡先把局势稳住并明晰目标",
                  handoffToNext: "把外部试探引到桌面上",
                },
                {
                  label: "当面试探",
                  location: "赤屿内港·码头",
                  focus: "让郑芝龙带着条件压上来",
                  tension: "合作与防备一起拉高",
                  characters: ["李凡", "郑芝龙"],
                  threadId: "main",
                  scenePurpose: "让主线进入正面博弈",
                  inheritsFromPrevious: "承接稳局之后必须回应的外部条件",
                  outcome: "新的合作条件与代价被提出",
                  handoffToNext: "把条件转成章末压力",
                },
                {
                  label: "章末留压",
                  location: "赤屿内港·后场",
                  focus: "把这次推进的代价落地",
                  tension: "让下一步压力真正成形",
                  characters: ["李凡", "宋应星"],
                  threadId: "main",
                  scenePurpose: "把本章结果递交给下一章",
                  inheritsFromPrevious: "承接当面试探后不得不做的判断",
                  outcome: "新的盟友条件成为下一步必须处理的问题",
                  handoffToNext: "把更高压力交给下一章",
                },
              ],
            },
            {
              proposalId: "proposal_2",
              summary: "把冲突前置，让本章更快进入碰撞。",
              rationale: "用更激烈的开场拉大候选差异。",
              diffSummary: "重心放在冲突前置和更硬的章末回响。",
              title: `第${chapterNumber}章·暗港压价`,
              timeInStory: `故事第${chapterNumber}日`,
              povCharacter: "李凡",
              location: "赤屿内港",
              keyEvents: ["郑芝龙先发制人", "李凡被迫现场改方案", "章末逼出更急的后续动作"],
              arcContribution: ["李凡必须更快应变", "关系压力被提前点燃"],
              nextHook: "下一轮潮窗只剩半夜。",
              emotionalTone: "持续拉升",
              threadMode: "dual_spine",
              dominantThread: "外部试探与内部执行压力同时挤压李凡。",
              entryLink: "承接上一章留下的高压盘面与执行缺口。",
              exitPressure: "下一轮潮窗只剩半夜。",
              charactersPresent: ["李凡", "郑芝龙", "顾骁"],
              continuityAnchors: ["不能回避扩张代价", "必须承接前章留下的关系试探"],
              scenes: [
                {
                  label: "冲突开门",
                  location: "赤屿内港·码头",
                  focus: "一开场就让外部条件压上桌面",
                  tension: "不给主角从容整理的时间",
                  characters: ["李凡", "郑芝龙"],
                  threadId: "external_probe",
                  scenePurpose: "先把外部试探推到台前",
                  inheritsFromPrevious: "承接上一章留下的高压与未完成试探",
                  outcome: "外部条件突然压上桌面",
                  handoffToNext: "逼主角立刻重排内部执行",
                },
                {
                  label: "现场改局",
                  location: "赤屿内港·议事棚",
                  focus: "让李凡当场重排资源与人手",
                  tension: "每个选择都要付代价",
                  characters: ["李凡", "顾骁", "宋应星"],
                  threadId: "internal_pressure",
                  scenePurpose: "把内部执行压力推到极限",
                  inheritsFromPrevious: "承接外部条件压上来后的即时后果",
                  outcome: "内部执行代价彻底显形",
                  handoffToNext: "把双线压力汇总成章末倒计时",
                },
                {
                  label: "夜潮逼近",
                  location: "赤屿内港·堤口",
                  focus: "把下一步行动窗口压缩到眼前",
                  tension: "让章末带着明确倒计时",
                  characters: ["李凡", "顾骁"],
                  threadId: "main",
                  scenePurpose: "把两条线汇总成章末决断压力",
                  inheritsFromPrevious: "承接外部压价与内部改局的叠加后果",
                  outcome: "行动窗口被压缩成明确倒计时",
                  handoffToNext: "把倒计时交给下一章",
                },
              ],
            },
          ],
        }),
      });
    }

    if (instructions.includes("ReferenceQueryPlannerAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          queries: [
            "海风 礁岸 压迫感 短促对白",
            "港口 海防 命令感 场景推进",
          ],
          focusAspects: [
            "用海风、潮声、礁岸和硬质动作建立压迫感",
            "对白要短，命令和试探交错推进局势",
          ],
          mustAvoid: [
            "不要照抄原句",
            "不要把范文写法变成提纲说明",
          ],
        }),
      });
    }

    if (instructions.includes("ReferenceSynthesizerAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "可以参考命令式对白、冷硬海风意象和动作先行的推进方式，但不要照抄原句。",
          styleSignals: [
            "海风、潮声、礁石等硬质意象优先落到动作和触感上。",
            "对白短促，尽量让命令和试探承担推进。",
          ],
          scenePatterns: [
            "先给环境压迫，再给人物动作反应，最后把冲突落到一句短对白。",
            "每一小段都要让局势更紧，而不是做解释性停顿。",
          ],
          avoidPatterns: [
            "不要连续堆砌抒情句",
            "不要直接复用命中片段的原句结构",
          ],
        }),
      });
    }

    if (instructions.includes("StyleFingerprintAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          perspective: "第三人称近贴视角，叙述紧跟主角当下感知，几乎不离场外评判。",
          diction: "白话直给但带一点冷硬压迫感，少用花哨词，关键词会反复钉住局势。",
          syntaxRhythm: "短中句交替，推进处更短更硬，情绪拐点会突然收束。",
          rhetoricImagery: "意象集中在金属、风压、潮气、冷光等硬质感官上，修辞克制。",
          dialogueHabits: "对白句子偏短，带命令、试探和留白，不做大段解释。",
          emotionalTemperature: "整体偏冷，情绪不外放，但紧张感持续顶着场景走。",
          sceneMomentum: "场景以动作和即时反应推进，信息跟着冲突往前抖出来。",
          chapterClosure: "章末常用新的风险或更大的压力收住，而不是抒情总结。",
          prohibitions: ["不要写成全知抒情旁白。", "不要把对白写成长篇说明书。"],
          recommendations: ["多用动作和反应承接信息。", "让章末停在具体风险上。"],
        }),
      });
    }

    if (instructions.includes("HistorySelectorAgent")) {
      const selectedChapterIds = [...inputText.matchAll(/^- (ch\d+)/gm)]
        .map((match) => match[1])
        .slice(0, 2);
      return jsonResponse({
        output_text: JSON.stringify({
          selectedChapterIds,
          reasons: Object.fromEntries(
            selectedChapterIds.map((chapterId) => [chapterId, `${chapterId} 的结局会直接影响当前章的开场状态。`]),
          ),
        }),
      });
    }

    if (instructions.includes("FactSelectorAgent")) {
      const selectedFactIds = [...new Set([...inputText.matchAll(/fact_ch\d+_\d+/g)]
        .map((match) => match[0])
        .filter(Boolean))]
        .slice(0, 3);
      return jsonResponse({
        output_text: JSON.stringify({
          selectedFactIds,
          rationale: "这些既定事实会直接影响当前章节的执行与冲突写法。",
          establishedFocus: "延续前章已经落地的命令与判断。",
          tensionFocus: "保留前章留下的风险与争执余波。",
        }),
      });
    }

    if (instructions.includes("ChapterFactExtractionAgent")) {
      const chapterMatch = inputText.match(/章节：(ch\d+)/);
      const chapterId = chapterMatch?.[1] || "ch001";
      return jsonResponse({
        output_text: JSON.stringify({
          established_facts: [
            {
              type: "order",
              subject: "李凡",
              assertion: `${chapterId} 已经明确下令火药与易燃物必须垫高远火摆放。`,
              evidence: "主角已经把命令当场讲清并要求所有人执行。",
            },
            {
              type: "allocation",
              subject: "船上人手",
              assertion: `${chapterId} 已经完成当章核心人手与任务分派。`,
              evidence: "正文里已经把谁去做什么安排下去了。",
            },
          ],
          open_tensions: [
            {
              type: "judgement",
              subject: "反对者",
              assertion: `${chapterId} 留下了对新规矩的不满与观望，后续可以继续发酵。`,
              evidence: "仍有人在等主角的安排出问题。",
            },
          ],
        }),
      });
    }

    if (instructions.includes("ChapterOutlineSyncAgent")) {
      const chapterMatch = inputText.match(/当前章节：(ch\d+)/);
      const chapterId = chapterMatch?.[1] || "ch001";
      const chapterNumber = Number(chapterId.replace(/[^\d]/g, "") || 1);
      const selectedForeshadowingIds = [...new Set(
        [...inputText.matchAll(/fsh_\d+/g)].map((match) => match[0]).filter(Boolean),
      )].slice(0, 1);
      return jsonResponse({
        output_text: JSON.stringify({
          proposalId: "proposal_lock_sync",
          summary: "按最终正文重建的锁章细纲会把已落地压力重新压实。",
          rationale: "最终正文已经把命令、执行和后续压力写得比原细纲更具体，需要回写给后续章节继承。",
          diffSummary: "从原候选的泛化试探，改成以最终正文中已经落地的命令与后续压力为主。",
          timeInStory: `故事第${chapterNumber}日·锁章定稿`,
          povCharacter: "李凡",
          location: "赤屿内港·锁章定稿版",
          keyEvents: ["李凡把最终命令压实到执行层", "宋应星把方案直接钉到现场", "章末留下锁章后的下一步硬压力"],
          arcContribution: ["李凡的控制力开始转成具体代价", "合作关系被压进执行层面"],
          nextHook: "锁章后的下一步压力已经钉死。",
          emotionalTone: "冷硬压迫",
          threadMode: "single_spine",
          dominantThread: "锁章正文确认李凡把局势压实，并把更高压力递给下一章。",
          entryLink: "承接锁章正文里已经落地的直接命令与现场余波。",
          exitPressure: "锁章后的下一步压力已经钉死。",
          charactersPresent: ["李凡", "宋应星", "郑芝龙"],
          continuityAnchors: ["必须以最终正文为准", "不能回退到旧章纲"],
          foreshadowingActionIds: selectedForeshadowingIds,
          scenes: [
            {
              label: "锁章压实",
              location: "赤屿内港·议事棚",
              focus: "把最终正文里的直接命令压成现场共识",
              tension: "所有人都知道这次不能再留余地",
              characters: ["李凡", "宋应星"],
              threadId: "main",
              scenePurpose: "让锁章后的事实成为下章必须继承的起点",
              inheritsFromPrevious: "承接最终正文里已经落地的命令与安排",
              outcome: "现场执行链被彻底钉死",
              handoffToNext: "把更高一级的压力推到郑芝龙面前",
            },
            {
              label: "锁章递压",
              location: "赤屿内港·码头",
              focus: "把更高压力直接递给下一章",
              tension: "合作与代价一起压上桌面",
              characters: ["李凡", "郑芝龙"],
              threadId: "main",
              scenePurpose: "把锁章正文的结果递交给下一章",
              inheritsFromPrevious: "承接执行链被钉死后的外部回应",
              outcome: "下一步硬压力已经摆到所有人面前",
              handoffToNext: "把锁章后的下一步压力交给下一章",
            },
          ],
        }),
      });
    }

    if (instructions.includes("HistoryContextAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          carryOverFacts: ["上一章确立的资源调度仍在推进。", "人物之间的新试探关系需要继续承接。"],
          emotionalCarryover: ["上一章抬高盘面后的高压感仍未散去。"],
          openThreads: ["扩张带来的新压力还没有真正解决。"],
          mustNotContradict: ["不能否认上一章已经把局势推高。"],
          lastEnding: "上一章把盘面抬高后的压力仍在延续。",
        }),
      });
    }

    if (instructions.includes("StagePlanningContextAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          chapterMission: "把当前阶段的推进义务真正落到本章行动上。",
          requiredBeats: ["把资源与人手重新组织成可执行方案", "让合作与试探同时发生", "章末抬高下一步压力"],
          mustPreserve: ["保持当前章节围绕扩张主线推进", "不要把代价写成轻松解决"],
          deferRules: ["不能提前解决后续阶段的大规模胜负"],
          suggestedConflictAxis: ["秩序与风险并行", "合作与防备并行"],
          titleSignals: ["潮窗", "压价", "试探"],
          nextPressure: "新的交易与扩张压力已经逼到眼前。",
        }),
      });
    }

    if (instructions.includes("CharacterPlanningContextAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          recommendedPov: "李凡",
          mustAppear: ["李凡", "宋应星"],
          optionalCharacters: ["郑芝龙", "顾骁"],
          relationshipPressures: ["李凡既要压住郑芝龙的试探，也要接住宋应星的执行节奏"],
          forbiddenLeaks: ["不能提前泄漏终局胜负", "不能让角色直接知道未来全局"],
          voiceNotes: ["对白要围绕博弈和执行，不要写成说明书。"],
        }),
      });
    }

    if (instructions.includes("HistoryPlanningContextAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          carryOverFacts: ["上一章确立的资源调度仍在推进。", "新的合作关系仍不稳定。"],
          emotionalCarryover: ["上一章抬高盘面后的高压感仍未散去。"],
          openThreads: ["扩张带来的新压力还没有真正解决。"],
          priorityThreads: ["先稳住局面，再接住外部试探。"],
          backgroundThreads: ["人物关系中的互相试探仍在持续。"],
          suppressedThreads: ["不要让远期大决战抢走本章戏份。"],
          mustNotContradict: ["不能否认上一章已经把局势推高。"],
          globalTrajectory: "本章负责把上一章抬高的盘面转成更具体的行动压力。",
          lastEnding: "上一章把盘面抬高后的压力仍在延续。",
        }),
      });
    }

    if (instructions.includes("ChapterContinuityAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          entryLink: "承接上一章抬高后的高压盘面与未完成试探。",
          dominantCarryoverThread: "先稳局，再接住外部试探并把压力抬高。",
          subordinateThreads: ["人物关系中的互相试探可以轻触，但不要抢戏。"],
          mustAdvanceThisChapter: "把外部试探从背景信号推进成必须回应的正面压力。",
          canPauseThisChapter: ["远期大决战", "过深的终局布局"],
          exitPressureToNextChapter: "新的盟友条件已经摆上桌面。",
          continuityRisks: ["不要让开场与上一章结尾脱节。", "不要把副线写成主线。"],
        }),
      });
    }

    if (instructions.includes("FileRetrievalAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          selectedIds: ["world_state", "foreshadowing_registry", "style_guide"],
          reasons: {
            world_state: "需要把握当前宏观局势。",
            foreshadowing_registry: "需要承接章节伏笔任务。",
            style_guide: "需要维持既有写作约束。",
          },
        }),
      });
    }

    if (instructions.includes("RevisionAgent")) {
      const selectionMatch = inputText.match(/只允许改写的原文片段：\n([\s\S]*?)\n\n选区前文锚点：/);
      const feedbackMatch = inputText.match(/作者修改要求：(.+)/);
      const selectedText = String(selectionMatch?.[1] || "局部片段").trim();
      const feedback = (feedbackMatch?.[1] || "").trim();
      return jsonResponse({
        output_text: `修订后：${selectedText}${feedback ? `（已按“${feedback}”调整）` : "（已做局部精修）"}`,
      });
    }

    if (instructions.includes("WriterAgent")) {
      const eventMatch = inputText.match(/本(?:场景|章)(?:对应|必须落地的)事件：(.+)/) || inputText.match(/^\-\s*必须落地：(.+)$/m);
      const feedbackMatch = inputText.match(/人类反馈：(.+)/) || inputText.match(/^##\s*人类反馈[\s\S]*?^\-\s*(.+)$/m);
      const event = (eventMatch?.[1] || "推进关键事件").trim();
      const feedback = (feedbackMatch?.[1] || "").trim();
      return jsonResponse({
        output_text: buildWriterStubChapter(event, feedback),
      });
    }

    if (instructions.includes("ConsistencyAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          passed: true,
          summary: "正文已经自然兑现本章硬性事件，不需要原句复现。",
          issues: [],
        }),
      });
    }

    if (instructions.includes("PlausibilityAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          passed: true,
          summary: "人物动机、反应与环境约束整体可信。",
          issues: [],
        }),
      });
    }

    if (instructions.includes("ForeshadowingCheckAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          passed: true,
          summary: "本章已承接既定伏笔任务，并保留后续牵引。",
          issues: [],
        }),
      });
    }

    if (instructions.includes("StyleAgent")) {
      const auditedText = inputText.split(/\n\n正文全文：\n/u).at(-1) || inputText;
      const narrativeOnly = auditedText.replace(/“[^”]*”/g, "");
      const hasFirstPersonNarration = /(^|[。！？\n])\s*我/.test(narrativeOnly);
      const hasMetaLeakage = /写作备注：|人工修订重点：|修订补笔：|本章的节奏基调保持在|^##\s*场景/m.test(auditedText);
      const issues = [];
      if (hasFirstPersonNarration) {
        issues.push("正文叙述视角偏向第一人称，未保持第三人称有限视角。");
      }
      if (hasMetaLeakage) {
        issues.push("正文泄漏了系统元信息或场景标题。");
      }
      return jsonResponse({
        output_text: JSON.stringify({
          passed: issues.length === 0,
          summary: issues.length ? issues.join("；") : "文风和格式保持稳定。",
          issues,
        }),
      });
    }

    if (instructions.includes("AuditOrchestrator")) {
      const auditedText = inputText.split(/\n\n正文全文：\n/u).at(-1) || inputText;
      const narrativeOnly = auditedText.replace(/“[^”]*”/g, "");
      const hasFirstPersonNarration = /(^|[。！？\n])\s*我/.test(narrativeOnly);
      const hasMetaLeakage = /写作备注：|人工修订重点：|修订补笔：|本章将|这一章里|^##\s*场景/m.test(auditedText);
      const issues = [];

      if (hasFirstPersonNarration) {
        issues.push({
          id: "pov_consistency",
          severity: "critical",
          category: "视角一致性",
          description: "正文叙述视角偏向第一人称，未稳定保持第三人称有限视角。",
          evidence: "旁白中出现了第一人称叙述。",
          suggestion: "把旁白改回第三人称有限视角。",
        });
      }
      if (hasMetaLeakage) {
        issues.push({
          id: "meta_leak",
          severity: "critical",
          category: "元信息泄漏",
          description: "正文混入了元信息、场景标题或提纲式说明语。",
          evidence: "输入中存在明显元话语。",
          suggestion: "删除元信息句式，只保留正文叙事。",
        });
      }

      return jsonResponse({
        output_text: JSON.stringify({
          summary: issues.length ? "审计发现需要修正的关键问题。" : "审计通过。",
          issues,
          dimensionSummaries: {
            outline_drift: "本章硬性事件兑现稳定。",
            character_plausibility: "人物反应整体可信。",
            chapter_pacing: "单章节奏没有明显失控。",
          },
        }),
      });
    }

    throw new Error(`Unhandled stub prompt: ${instructions}`);
  };

  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
    if (previousZhipuKey === undefined) {
      delete process.env.ZHIPU_API_KEY;
    } else {
      process.env.ZHIPU_API_KEY = previousZhipuKey;
    }
    if (previousFakeEmbeddings === undefined) {
      delete process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS;
    } else {
      process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS = previousFakeEmbeddings;
    }
  }
}

function chapterIdFromNumber(number) {
  return `ch${String(number).padStart(3, "0")}`;
}

async function runWriteChapterThroughOutline(store, options = {}) {
  const outlineRun = await runWriteChapter(store, options.runOptions || {});
  assert.equal(outlineRun.project.phase.write.status, "chapter_outline_pending_review");

  const chapterNumber = outlineRun.project.phase.write.pendingReview?.chapterNumber || 1;
  const chapterId = chapterIdFromNumber(chapterNumber);
  const outlineDraft = await store.loadChapterDraft(chapterId);
  const selectedProposalId = options.selectedProposalId || outlineDraft.chapterOutlineCandidates?.[0]?.proposalId;

  assert.ok(Array.isArray(outlineDraft.chapterOutlineCandidates));
  assert.ok(outlineDraft.chapterOutlineCandidates.length >= 1);

  return reviewChapter(store, {
    target: "chapter_outline",
    approved: options.approved ?? true,
    reviewAction: options.reviewAction || "approve_single",
    selectedProposalId,
    selectedSceneRefs: options.selectedSceneRefs || [],
    authorNotes: options.authorNotes || "",
    feedback: options.feedback || "",
    outlineOptions: options.outlineOptions || null,
  });
}

async function lockNextChapter(store, options = {}) {
  const writeRun = await runWriteChapterThroughOutline(store, options);
  assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  return reviewChapter(store, {
    target: "chapter",
    approved: true,
    feedback: "",
  });
}

test("style fingerprint prompt rendering keeps key dimensions and prohibitions stable", () => {
  const fingerprint = {
    perspective: "第三人称近贴视角",
    diction: "白话直给，冷硬克制",
    syntaxRhythm: "短中句交替",
    rhetoricImagery: "意象集中在金属与潮气",
    dialogueHabits: "对白短促，带试探",
    emotionalTemperature: "整体偏冷",
    sceneMomentum: "以动作和反应推进",
    chapterClosure: "以风险收束章末",
    prohibitions: ["不要写成全知抒情旁白。", "不要把对白写成长篇说明书。"],
    recommendations: ["多用动作和反应承接信息。", "让章末停在具体风险上。"],
  };
  const summary = buildStyleFingerprintSummary("冷峻近贴视角", fingerprint);
  const prompt = renderStyleFingerprintPrompt({
    name: "冷峻近贴视角",
    summary,
    fingerprint,
  });

  assert.match(prompt, /风格指纹指令：冷峻近贴视角/);
  assert.match(prompt, /## 叙述视角与贴脸距离/);
  assert.match(prompt, /第三人称近贴视角/);
  assert.match(prompt, /## 明确禁忌/);
  assert.match(prompt, /不要把对白写成长篇说明书/);
});

test("Novelex workflows can complete a full draft-and-approve cycle", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-"));
  const store = await createStore(tempRoot);

  const draftRun = await runPlanDraft(store);
  assert.equal(draftRun.project.phase.plan.status, "final_pending_review");
  const stagedDraft = await store.loadPlanDraft();
  assert.ok(Array.isArray(stagedDraft.cast));
  assert.ok(stagedDraft.cast.some((character) => character.name === "顾骁"));

  const locked = await reviewPlanFinal(store, {
    approved: true,
    feedback: "",
  });
  assert.equal(locked.project.phase.plan.status, "locked");
  const finalBundle = await store.loadPlanFinal();
  assert.equal(finalBundle.structureData.chapters.length, 0);
  assert.equal(finalBundle.outlineData.chapters.length, 0);
  assert.ok(Array.isArray(finalBundle.chapterSlots));
  assert.ok(finalBundle.chapterSlots.length > 0);
  assert.ok(Array.isArray(finalBundle.outlineData.chapterSlots));
  assert.ok(finalBundle.outlineData.chapterSlots.length > 0);
  assert.ok(await store.exists(path.join(tempRoot, "novel_state", "chapter_slots.json")));

  const outlineRun = await runWriteChapter(store);
  assert.equal(outlineRun.project.phase.write.status, "chapter_outline_pending_review");
  const outlineDraft = await store.loadChapterDraft("ch001");
  assert.ok(outlineDraft.chapterOutlineContext?.stagePlanning);
  assert.ok(Array.isArray(outlineDraft.chapterOutlineCandidates));
  assert.ok(outlineDraft.chapterOutlineCandidates.length >= 2);
  assert.equal(outlineDraft.reviewState?.target, "chapter_outline");

  const writeRun = await reviewChapter(store, {
    target: "chapter_outline",
    approved: true,
    reviewAction: "approve_single",
    selectedProposalId: outlineDraft.chapterOutlineCandidates[0].proposalId,
    feedback: "",
  });
  assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  const stagedChapterDraft = await store.loadChapterDraft("ch001");
  assert.ok(stagedChapterDraft.planContext?.briefingMarkdown);
  assert.ok(stagedChapterDraft.writerContext?.briefingMarkdown);
  assert.ok(stagedChapterDraft.chapterIntent?.goal);
  assert.ok(Array.isArray(stagedChapterDraft.contextPackage?.selectedContext));
  assert.ok(Array.isArray(stagedChapterDraft.ruleStack?.hardFacts));
  assert.equal(stagedChapterDraft.contextTrace?.chapterId, "ch001");
  assert.equal(stagedChapterDraft.historyContext?.retrievalMode, "history-context-agents");
  assert.equal("writingBriefMarkdown" in stagedChapterDraft, false);
  assert.deepEqual(stagedChapterDraft.sceneDrafts, []);
  assert.equal(stagedChapterDraft.reviewState?.strategy, "chapter_generation");
  assert.match(stagedChapterDraft.chapterMarkdown || "", /第一章|第一十|# /);

  const chapterLocked = await reviewChapter(store, {
    target: "chapter",
    approved: true,
    feedback: "",
  });
  const lockedStagedChapterDraft = await store.loadChapterDraft("ch001");

  assert.equal(chapterLocked.project.phase.write.currentChapterNumber, 1);

  const chapterPath = path.join(tempRoot, "novel_state", "chapters", "ch001.md");
  const committedOutlinePath = path.join(tempRoot, "novel_state", "chapters", "ch001_outline.json");
  const styleGuidePath = path.join(tempRoot, "novel_state", "style_guide.md");
  const writerContextPath = path.join(tempRoot, "runtime", "staging", "write", "ch001", "writer_context.md");
  const planContextPath = path.join(tempRoot, "runtime", "staging", "write", "ch001", "plan_context.json");
  const historyContextPath = path.join(tempRoot, "runtime", "staging", "write", "ch001", "history_context.json");
  const chapterIntentPath = path.join(tempRoot, "runtime", "staging", "write", "ch001", "chapter_intent.json");
  const contextPackagePath = path.join(tempRoot, "runtime", "staging", "write", "ch001", "context_package.json");
  const ruleStackPath = path.join(tempRoot, "runtime", "staging", "write", "ch001", "rule_stack.json");
  const tracePath = path.join(tempRoot, "runtime", "staging", "write", "ch001", "trace.json");
  const outlineContextPath = path.join(tempRoot, "runtime", "staging", "write", "ch001", "outline_context.json");
  const outlineCandidatesPath = path.join(tempRoot, "runtime", "staging", "write", "ch001", "outline_candidates.json");
  const selectedOutlinePath = path.join(tempRoot, "runtime", "staging", "write", "ch001", "selected_chapter_outline.json");

  const chapterExists = await fs.readFile(chapterPath, "utf8");
  const committedOutlineExists = JSON.parse(await fs.readFile(committedOutlinePath, "utf8"));
  const styleGuideExists = await fs.readFile(styleGuidePath, "utf8");
  const writerContextExists = await fs.readFile(writerContextPath, "utf8");
  const planContextExists = JSON.parse(await fs.readFile(planContextPath, "utf8"));
  const historyContextExists = JSON.parse(await fs.readFile(historyContextPath, "utf8"));
  const chapterIntentExists = JSON.parse(await fs.readFile(chapterIntentPath, "utf8"));
  const contextPackageExists = JSON.parse(await fs.readFile(contextPackagePath, "utf8"));
  const ruleStackExists = JSON.parse(await fs.readFile(ruleStackPath, "utf8"));
  const traceExists = JSON.parse(await fs.readFile(tracePath, "utf8"));
  const outlineContextExists = JSON.parse(await fs.readFile(outlineContextPath, "utf8"));
  const outlineCandidatesExists = JSON.parse(await fs.readFile(outlineCandidatesPath, "utf8"));
  const selectedOutlineExists = JSON.parse(await fs.readFile(selectedOutlinePath, "utf8"));

  assert.match(chapterExists, /第一章|第一十|# /);
  assert.match(styleGuideExists, /风格指南/);
  assert.match(writerContextExists, /Writer 上下文包/);
  assert.ok(planContextExists.outline);
  assert.equal(historyContextExists.retrievalMode, "history-context-agents");
  assert.equal(chapterIntentExists.chapterId, "ch001");
  assert.ok(Array.isArray(contextPackageExists.selectedContext));
  assert.ok(Array.isArray(ruleStackExists.hardFacts));
  assert.equal(traceExists.chapterId, "ch001");
  assert.equal(outlineContextExists.chapterId, "ch001");
  assert.ok(outlineContextExists.continuityPlanning);
  assert.ok(Array.isArray(outlineCandidatesExists));
  assert.equal(outlineCandidatesExists[0].chapterPlan.threadMode, "single_spine");
  assert.ok(outlineCandidatesExists[0].chapterPlan.scenes[0].inheritsFromPrevious);
  assert.equal(selectedOutlineExists.mode, "single");
  assert.equal(selectedOutlineExists.selectedProposalId, outlineDraft.chapterOutlineCandidates[0].proposalId);
  assert.equal(selectedOutlineExists.source, "post_lock_sync");
  assert.equal(selectedOutlineExists.syncedFrom.source, "manual_selection");
  assert.match(selectedOutlineExists.chapterPlan.dominantThread, /锁章正文确认/);
  assert.equal(committedOutlineExists.chapterPlan.threadMode, "single_spine");
  assert.ok(committedOutlineExists.chapterPlan.entryLink);
  assert.equal(committedOutlineExists.source, "post_lock_sync");
  assert.match(committedOutlineExists.chapterPlan.dominantThread, /锁章正文确认/);
  assert.deepEqual(lockedStagedChapterDraft.chapterMeta.key_events, committedOutlineExists.chapterPlan.keyEvents);
  assert.equal(lockedStagedChapterDraft.chapterMeta.next_hook, committedOutlineExists.chapterPlan.nextHook);
  assert.deepEqual(
    lockedStagedChapterDraft.foreshadowingRegistry.foreshadowings
      .filter((item) => item.last_touched_chapter === "ch001")
      .map((item) => item.id),
    committedOutlineExists.chapterPlan.foreshadowingActions.map((item) => item.id),
  );
})));

test("chapter outline audit repairs rejected candidates to preserve requested count", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-outline-count-repair-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  let outlineCalls = 0;
  const outlineVariants = [];
  let auditCalls = 0;
  let repairCalls = 0;

  const makeProposal = (proposalId, index) => ({
    proposalId,
    summary: `方案 ${index} 承接开篇压力。`,
    rationale: "保持穿越醒觉、船上危机和追船压力都在同一条因果链上。",
    diffSummary: `第 ${index} 个候选的冲突轴不同。`,
    title: `第一章·候选${index}`,
    timeInStory: "故事第一日",
    povCharacter: "李凡",
    location: "铜山外海",
    keyEvents: ["李凡在进水底舱醒觉", "用理工判断稳住船", "追船压力逼近"],
    arcContribution: ["李凡用行动争取临时指挥权"],
    nextHook: "追船动向仍未明。",
    emotionalTone: "窒息高压",
    threadMode: "single_spine",
    dominantThread: "李凡必须在沉船危机里证明自己还有用。",
    entryMode: "direct_resume",
    entryLink: "无前章，从李凡意识在海水灌入底舱的瞬间浮起切入。",
    exitPressure: "追船动向仍未明。",
    charactersPresent: ["李凡", "林定海"],
    continuityAnchors: ["船、火药、口粮、活口都不能消失"],
    scenes: [
      {
        label: `候选${index}开场`,
        location: "铜山外海·进水底舱",
        focus: "让李凡在海水灌入时完成意识重组。",
        tension: "窒息、进水和船员敌意同时压上来。",
        characters: ["李凡", "林定海"],
        threadId: "main",
        scenePurpose: "直接切入开篇身体危机。",
        inheritsFromPrevious: "无前章，从海水灌入底舱的瞬间切入。",
        outcome: "李凡确认处境并抓住第一条自救判断。",
        handoffToNext: "把压舱和火药风险交给下一场。",
      },
    ],
  });

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("ChapterOutlineAgent") && inputText.includes("当前章节：ch001")) {
      outlineCalls += 1;
      outlineVariants.push(inputText.match(/当前 Variant：(proposal_\d+)/)?.[1] || "");
      return jsonResponse({
        output_text: JSON.stringify({
          proposals: [makeProposal("proposal_1", 1), makeProposal("proposal_2", 2), makeProposal("proposal_3", 3)],
        }),
      });
    }

    if (instructions.includes("ChapterOutlineConsistencyAuditAgent") && inputText.includes("当前章节：ch001")) {
      auditCalls += 1;
      const proposalIds = auditCalls === 1
        ? ["proposal_1", "proposal_2", "proposal_3"]
        : ["proposal_1", "proposal_2_repaired", "proposal_3"];
      return jsonResponse({
        output_text: JSON.stringify({
          summary: auditCalls === 1 ? "两个候选需要修复。" : "所有候选已通过。",
          candidateAudits: proposalIds.map((proposalId) => {
            const passed = auditCalls > 1 || proposalId === "proposal_1";
            return {
              proposalId,
              passed,
              score: passed ? 91 : 40,
              summary: passed ? "连续性通过。" : "入口或章末压力需要修复。",
              issues: passed ? [] : [
                {
                  id: "outline_contract_conflict",
                  severity: "critical",
                  category: "细纲合同",
                  description: "未严格承接开篇入口合同。",
                  evidence: proposalId,
                  suggestion: "保留差异方向，但改写入口和章末压力。",
                },
              ],
              revisionNotes: passed ? [] : ["改写入口和章末压力。"],
            };
          }),
        }),
      });
    }

    if (instructions.includes("ChapterOutlineRepairAgent") && inputText.includes("当前章节：ch001")) {
      repairCalls += 1;
      return jsonResponse({
        output_text: JSON.stringify({
          proposals: [makeProposal("proposal_2_repaired", 2)],
        }),
      });
    }

    return previousFetch(url, options);
  };

  try {
    await runWriteChapter(store, {
      outlineOptions: { variantCount: 3, diversityPreset: "wide" },
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  const outlineDraft = await store.loadChapterDraft("ch001");
  assert.equal(outlineCalls, 3);
  assert.deepEqual(outlineVariants, ["proposal_1", "proposal_2", "proposal_3"]);
  assert.equal(outlineDraft.chapterOutlineCandidates.length, 3);
  assert.deepEqual(outlineDraft.chapterOutlineCandidates.map((candidate) => candidate.proposalId), [
    "proposal_1",
    "proposal_2_repaired",
    "proposal_3",
  ]);
  assert.equal(outlineDraft.outlineContinuityAudit.manualReviewRequired, false);
  assert.equal(auditCalls, 2);
  assert.equal(repairCalls, 1);
})));

test("chapter approval blocks locking when post-lock outline sync fails", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-lock-sync-fail-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);

  const bundlePath = path.join(tempRoot, "novel_state", "bundle.json");
  const bundleBefore = await fs.readFile(bundlePath, "utf8");
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    if (instructions.includes("ChapterOutlineSyncAgent")) {
      return jsonResponse({
        output_text: "not valid json",
      });
    }
    return previousFetch(url, options);
  };

  try {
    await assert.rejects(
      reviewChapter(store, {
        target: "chapter",
        approved: true,
        feedback: "",
      }),
      /锁章前细纲同步失败/u,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  const projectState = await store.loadProject();
  const bundleAfter = await fs.readFile(bundlePath, "utf8");
  assert.equal(projectState.phase.write.currentChapterNumber, 0);
  assert.equal(projectState.phase.write.status, "chapter_pending_review");
  assert.equal(projectState.phase.write.pendingReview?.chapterId, "ch001");
  assert.equal(bundleAfter, bundleBefore);
  await assert.rejects(fs.access(path.join(tempRoot, "novel_state", "chapters", "ch001.md")));
  await assert.rejects(fs.access(path.join(tempRoot, "novel_state", "chapters", "ch001_outline.json")));
})));

test("deleteLatestLockedChapter removes the latest committed chapter and restores prior write state", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-delete-latest-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanFinal(store, {
    approved: true,
    feedback: "",
  });

  await lockNextChapter(store);

  const deleted = await deleteLatestLockedChapter(store, { chapterId: "ch001" });
  assert.equal(deleted.project.phase.write.currentChapterNumber, 0);
  assert.equal(deleted.project.phase.write.pendingReview, null);
  assert.equal(deleted.project.phase.write.lastRunId, null);

  await assert.rejects(fs.access(path.join(tempRoot, "novel_state", "chapters", "ch001.md")));
  await assert.rejects(fs.access(path.join(tempRoot, "novel_state", "chapters", "ch001_meta.json")));
  await assert.rejects(fs.access(path.join(tempRoot, "novel_state", "chapters", "ch001_facts.json")));

  const styleGuideAfterDelete = await fs.readFile(path.join(tempRoot, "novel_state", "style_guide.md"), "utf8");
  assert.match(styleGuideAfterDelete, /待第1章通过后生成/);

  const factLedger = JSON.parse(await fs.readFile(path.join(tempRoot, "novel_state", "fact_ledger.json"), "utf8"));
  assert.equal(factLedger.chapterCount, 0);
  assert.equal(factLedger.factCount, 0);

  const chapterMetas = await store.listChapterMeta();
  assert.equal(chapterMetas.length, 0);
  assert.deepEqual(await store.listRuns("write"), []);
  assert.ok(
    deleted.project.history.reviews.every((review) =>
      review.target !== "chapter" && review.target !== "chapter_outline"
    ),
  );

  const rerun = await runWriteChapter(store);
  assert.equal(rerun.project.phase.write.pendingReview?.chapterId, "ch001");
})));

test("deleteLatestLockedChapter rejects deleting a non-latest committed chapter", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-delete-order-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanFinal(store, {
    approved: true,
    feedback: "",
  });

  await lockNextChapter(store);
  await lockNextChapter(store);

  await assert.rejects(
    deleteLatestLockedChapter(store, { chapterId: "ch001" }),
    /只能删除最新锁定章节 ch002/,
  );

  const chapterMetas = await store.listChapterMeta();
  assert.equal(chapterMetas.length, 2);
  assert.equal(chapterMetas.at(-1)?.chapter_id, "ch002");
})));

test("chapter approval extracts canon facts into chapter sidecars and the global ledger", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-facts-commit-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);
  await reviewChapter(store, {
    target: "chapter",
    approved: true,
    feedback: "",
  });

  const chapterFacts = JSON.parse(await fs.readFile(path.join(tempRoot, "novel_state", "chapters", "ch001_facts.json"), "utf8"));
  const factLedger = JSON.parse(await fs.readFile(path.join(tempRoot, "novel_state", "fact_ledger.json"), "utf8"));

  assert.equal(chapterFacts.chapterId, "ch001");
  assert.ok(chapterFacts.factCount >= 1);
  assert.ok(Array.isArray(chapterFacts.facts));
  assert.ok(chapterFacts.facts.some((item) => item.status === "established"));
  assert.ok(factLedger.factCount >= chapterFacts.factCount);
  assert.ok(factLedger.facts.some((item) => item.chapterId === "ch001"));
})));

test("later outline prompts expose canon fact sections and trigger fact selection", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-facts-prompts-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);
  await reviewChapter(store, {
    target: "chapter",
    approved: true,
    feedback: "",
  });

  const previousFetch = globalThis.fetch;
  let outlinePrompt = "";
  let factSelectorCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input) || String(payload.input || "");

    if (instructions.includes("FactSelectorAgent") && inputText.includes("当前章节：ch002")) {
      factSelectorCalls += 1;
    }
    if (!outlinePrompt && instructions.includes("ChapterOutlineAgent") && inputText.includes("当前章节：ch002")) {
      outlinePrompt = inputText;
    }

    return previousFetch(url, options);
  };

  try {
    await runWriteChapterThroughOutline(store);
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.match(outlinePrompt, /必须继承的已定事实：/);
  assert.match(outlinePrompt, /可以继续发酵但不能改写底层结论的开放张力：/);
  assert.ok(factSelectorCalls >= 1);
})));

test("plan final approval only commits locally without triggering model calls", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-final-approve-local-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);

  const previousFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    modelCalls += 1;
    return previousFetch(url, options);
  };

  try {
    const locked = await reviewPlanFinal(store, {
      approved: true,
      feedback: "",
    });
    assert.equal(locked.project.phase.plan.status, "locked");
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(modelCalls, 0);
})));

test("chapter outline scene composition finalizes into a writer-ready chapter plan", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-outline-compose-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const outlineRun = await runWriteChapter(store);
  assert.equal(outlineRun.project.phase.write.status, "chapter_outline_pending_review");

  const outlineDraft = await store.loadChapterDraft("ch001");
  const selectedSceneRefs = [
    outlineDraft.chapterOutlineCandidates[0].chapterPlan.scenes[0].sceneRef,
    outlineDraft.chapterOutlineCandidates[1].chapterPlan.scenes[1].sceneRef,
  ];

  const writeRun = await reviewChapter(store, {
    target: "chapter_outline",
    approved: true,
    reviewAction: "approve_composed",
    selectedSceneRefs,
    authorNotes: "保留第一案的开局和第二案的现场改局。",
    feedback: "",
  });

  assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");

  const stagedDraft = await store.loadChapterDraft("ch001");
  assert.equal(stagedDraft.selectedChapterOutline.mode, "composed");
  assert.equal(stagedDraft.selectedChapterOutline.selectedProposalId, null);
  assert.equal(stagedDraft.chapterPlan.chapterId, "ch001");
  assert.equal(stagedDraft.chapterPlan.scenes.length, 2);
  assert.equal(stagedDraft.chapterPlan.threadMode, "single_spine");
  assert.ok(stagedDraft.chapterPlan.entryLink);
  assert.ok(stagedDraft.chapterPlan.scenes[0].inheritsFromPrevious);
  assert.deepEqual(
    stagedDraft.chapterPlan.scenes.map((scene) => scene.sceneRef),
    ["proposal_1:scene_1", "proposal_1:scene_2"],
  );
  assert.match(stagedDraft.chapterMarkdown || "", /李凡没有浪费任何时间/);
})));

test("chapter outline planning reads committed outline history and continuity prompts", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-outline-continuity-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  await runWriteChapterThroughOutline(store);
  await reviewChapter(store, { target: "chapter", approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  let sawHistoryPlanningPrompt = false;
  let sawContinuityPrompt = false;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (!sawHistoryPlanningPrompt && instructions.includes("HistoryPlanningContextAgent")) {
      sawHistoryPlanningPrompt = true;
      assert.match(inputText, /全历史总览：/);
      assert.match(inputText, /ch001/);
      assert.match(inputText, /锁章正文确认李凡把局势压实/);
    }

    if (!sawContinuityPrompt && instructions.includes("ChapterContinuityAgent")) {
      sawContinuityPrompt = true;
      assert.match(inputText, /上一章定稿细纲：/);
      assert.match(inputText, /章节：ch001/);
      assert.match(inputText, /锁章正文确认李凡把局势压实/);
      assert.match(inputText, /锁章后的下一步压力已经钉死/);
    }

    return previousFetch(url, options);
  };

  try {
    const outlineRun = await runWriteChapter(store);
    assert.equal(outlineRun.project.phase.write.status, "chapter_outline_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  const outlineDraft = await store.loadChapterDraft("ch002");
  assert.equal(sawHistoryPlanningPrompt, true);
  assert.equal(sawContinuityPrompt, true);
  assert.ok(outlineDraft.chapterOutlineContext?.historyPlanning?.priorityThreads?.length);
  assert.ok(outlineDraft.chapterOutlineContext?.continuityPlanning?.entryLink);
})));

test("chapter outline continuity guard blocks third chapter restart openings", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-outline-restart-guard-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  await lockNextChapter(store);
  await lockNextChapter(store);

  const previousFetch = globalThis.fetch;
  let badOutlineCallCount = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);
    const isChapterThree = inputText.includes("当前章节：ch003");

    if (isChapterThree && instructions.includes("StagePlanningContextAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          chapterMission: "第一次惊醒后重新确认身份，并重新证明自己能够立足。",
          requiredBeats: ["惊醒确认自己穿越", "第一次立威证明自己", "重新进入开篇危机"],
          mustPreserve: ["重新确认身份"],
          deferRules: ["不能提前解决终局"],
          suggestedConflictAxis: ["身体危机型开场"],
          titleSignals: ["惊醒", "身份"],
          nextPressure: "再次醒来后面对新的危机。",
        }),
      });
    }

    if (isChapterThree && instructions.includes("ChapterContinuityAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          entryMode: "wake_after_unconsciousness",
          entryLink: "李凡从昏迷里惊醒，重新确认自己是谁。",
          dominantCarryoverThread: "重新开篇确认身份。",
          subordinateThreads: ["身体危机"],
          mustAdvanceThisChapter: "第一次证明自己能控制局面。",
          canPauseThisChapter: ["上一章压力"],
          exitPressureToNextChapter: "重新确认身份后的危机扩大。",
          continuityRisks: ["可能需要解释为何昏迷。"],
          evidenceRefs: [],
          unsupportedClaims: [],
        }),
      });
    }

    if (isChapterThree && instructions.includes("ChapterOutlineAgent")) {
      badOutlineCallCount += 1;
      if (badOutlineCallCount === 1) {
        return jsonResponse({
          output_text: JSON.stringify({
            proposals: [
              {
                proposalId: "proposal_bad_1",
                summary: "错误地重开开篇。",
                rationale: "误用第一章模板。",
                diffSummary: "惊醒重置。",
                title: "第三章·惊醒",
                timeInStory: "故事第三日",
                povCharacter: "李凡",
                location: "赤屿内港",
                keyEvents: ["李凡惊醒", "重新确认自己是谁", "第一次证明自己"],
                arcContribution: ["重新开篇"],
                nextHook: "新的危机出现。",
                emotionalTone: "恍惚",
                threadMode: "single_spine",
                dominantThread: "重新确认身份。",
                entryLink: "李凡惊醒后重新确认自己是谁。",
                exitPressure: "新的危机出现。",
                charactersPresent: ["李凡", "宋应星"],
                continuityAnchors: ["惊醒", "重新确认身份"],
                scenes: [
                  {
                    label: "惊醒",
                    location: "赤屿内港",
                    focus: "李凡醒来并重新确认自己是谁",
                    tension: "身体危机",
                    characters: ["李凡"],
                    threadId: "main",
                    scenePurpose: "重开开篇",
                    inheritsFromPrevious: "从昏迷惊醒",
                    outcome: "重新确认身份",
                    handoffToNext: "第一次证明自己",
                  },
                ],
              },
              {
                proposalId: "proposal_bad_2",
                summary: "同样错误地重演第一章。",
                rationale: "误用身体危机开场。",
                diffSummary: "醒来重置。",
                title: "第三章·再醒",
                timeInStory: "故事第三日",
                povCharacter: "李凡",
                location: "赤屿内港",
                keyEvents: ["李凡醒来", "再次确认穿越", "首次立威"],
                arcContribution: ["重新开篇"],
                nextHook: "新的危机出现。",
                emotionalTone: "恍惚",
                threadMode: "single_spine",
                dominantThread: "再次确认穿越。",
                entryLink: "李凡醒来，再次确认穿越。",
                exitPressure: "新的危机出现。",
                charactersPresent: ["李凡"],
                continuityAnchors: ["醒来", "首次立威"],
                scenes: [
                  {
                    label: "醒来",
                    location: "赤屿内港",
                    focus: "李凡醒来，再次确认穿越",
                    tension: "身体危机",
                    characters: ["李凡"],
                    threadId: "main",
                    scenePurpose: "重演第一章",
                    inheritsFromPrevious: "醒来",
                    outcome: "首次立威",
                    handoffToNext: "进入危机",
                  },
                ],
              },
            ],
          }),
        });
      }

      return jsonResponse({
        output_text: JSON.stringify({
          proposals: [
            {
              proposalId: "proposal_guarded_1",
              summary: "直接承接 ch002 章末压力，把高压盘面推向更具体的执行代价。",
              rationale: "按连续性护栏承接前章。",
              diffSummary: "不重开，直接续压。",
              title: "第三章·续压",
              timeInStory: "故事第三日",
              povCharacter: "李凡",
              location: "赤屿内港",
              keyEvents: ["承接上一章高压盘面", "把资源缺口推成执行代价", "章末留下更急压力"],
              arcContribution: ["李凡在更高风险下继续主导局面"],
              nextHook: "更急的执行窗口已经压到眼前。",
              emotionalTone: "承压推进",
              threadMode: "single_spine",
              dominantThread: "承接 ch002 压力继续推进。",
              entryMode: "direct_resume",
              entryLink: "承接上一章留下的高压盘面与资源压力。",
              exitPressure: "更急的执行窗口已经压到眼前。",
              charactersPresent: ["李凡", "宋应星"],
              continuityAnchors: ["承接上一章压力", "不重开身份确认"],
              evidenceRefs: ["ch002_outline_exit"],
              scenes: [
                {
                  label: "承压续场",
                  location: "赤屿内港",
                  focus: "承接上一章留下的高压与资源压力",
                  tension: "执行窗口正在缩短",
                  characters: ["李凡", "宋应星"],
                  threadId: "main",
                  scenePurpose: "把 ch002 章末压力接到当前行动现场",
                  inheritsFromPrevious: "承接上一章留下的高压盘面与资源压力",
                  outcome: "本章主问题转成更具体的执行代价",
                  handoffToNext: "把外部试探压到正面回应",
                },
              ],
            },
          ],
        }),
      });
    }

    return previousFetch(url, options);
  };

  try {
    const outlineRun = await runWriteChapter(store);
    assert.equal(outlineRun.project.phase.write.status, "chapter_outline_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  const outlineDraft = await store.loadChapterDraft("ch003");
  const firstSceneText = JSON.stringify(outlineDraft.chapterOutlineCandidates[0]?.chapterPlan?.scenes?.[0] || {});

  assert.ok(outlineDraft.chapterSlot?.titleHint);
  assert.ok(outlineDraft.chapterSlot?.mission);
  assert.ok(outlineDraft.chapterSlot?.locationSeed);
  assert.ok(outlineDraft.chapterSlot?.expectedCarryover);
  assert.notEqual(outlineDraft.chapterOutlineContext?.continuityPlanning?.entryMode, "wake_after_unconsciousness");
  assert.doesNotMatch(JSON.stringify(outlineDraft.chapterOutlineContext?.stagePlanning || {}), /第一次|惊醒|重新确认身份/);
  assert.doesNotMatch(firstSceneText, /惊醒|醒来|睁眼确认自己是谁|重新确认自己是谁/);
  assert.match(firstSceneText, /承接|上一章|高压|压力/);
  assert.equal(outlineDraft.continuityGuard?.supportsWakeAfterUnconsciousness, false);
  assert.ok(outlineDraft.chapterOutlineHistory.some((item) => item.action === "outline_audit_regenerate"));
  assert.ok(await store.exists(path.join(tempRoot, "runtime", "staging", "write", "ch003", "continuity_guard.json")));
  assert.ok(await store.exists(path.join(tempRoot, "runtime", "staging", "write", "ch003", "context_conflicts.json")));
  assert.ok(await store.exists(path.join(tempRoot, "runtime", "staging", "write", "ch003", "outline_generation_contract.json")));
})));

test("chapter outline consistency audit repairs mid-chapter canon fact resets", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-outline-canon-repair-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await lockNextChapter(store);

  const previousFetch = globalThis.fetch;
  let repairCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("ChapterOutlineAgent") && inputText.includes("当前章节：ch002")) {
      return jsonResponse({
        output_text: JSON.stringify({
          proposals: [
            {
              proposalId: "proposal_bad_fact",
              summary: "第一场承接正确，但中段重置上一章事实。",
              rationale: "故意制造 canon fact 冲突。",
              diffSummary: "中段把既定火药规矩当成第一次提出。",
              title: "第二章·错把旧令当新规",
              timeInStory: "故事第2日",
              povCharacter: "李凡",
              location: "赤屿内港",
              keyEvents: ["承接上一章压力", "把上一章火药规矩当成第一次提出", "章末留下压力"],
              arcContribution: ["李凡继续主导局面"],
              nextHook: "外部压力继续压来。",
              emotionalTone: "承压推进",
              threadMode: "single_spine",
              dominantThread: "承接上一章压力，但错误重置火药规矩。",
              entryMode: "direct_resume",
              entryLink: "承接上一章留下的高压盘面与执行压力。",
              exitPressure: "外部压力继续压来。",
              charactersPresent: ["李凡", "宋应星"],
              continuityAnchors: ["承接上一章压力"],
              scenes: [
                {
                  label: "承压续场",
                  location: "赤屿内港·议事棚",
                  focus: "承接上一章留下的压力",
                  tension: "执行窗口正在收紧",
                  characters: ["李凡", "宋应星"],
                  threadId: "main",
                  scenePurpose: "接住上一章余波",
                  inheritsFromPrevious: "承接上一章留下的高压盘面与执行压力",
                  outcome: "压力被接到当前现场",
                  handoffToNext: "转入火药摆放争议",
                },
                {
                  label: "错误重置",
                  location: "赤屿内港·库棚",
                  focus: "把上一章已经落实的火药规矩重新当成第一次临时新提出来",
                  tension: "既定事实被重置",
                  characters: ["李凡"],
                  threadId: "main",
                  scenePurpose: "制造事实冲突",
                  inheritsFromPrevious: "承接前场压力",
                  outcome: "火药规矩被写成第一次提出",
                  handoffToNext: "章末留压",
                },
              ],
            },
          ],
        }),
      });
    }

    if (instructions.includes("ChapterOutlineConsistencyAuditAgent") && inputText.includes("proposal_repaired_fact")) {
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "修复后没有阻断性连续性冲突。",
          candidateAudits: [
            {
              proposalId: "proposal_repaired_fact",
              passed: true,
              score: 91,
              summary: "已承接上一章既定事实。",
              issues: [],
              revisionNotes: [],
            },
          ],
        }),
      });
    }

    if (instructions.includes("ChapterOutlineConsistencyAuditAgent") && inputText.includes("第一次临时新提出来")) {
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "细纲中段重置了上一章已定事实。",
          candidateAudits: ["proposal_1", "proposal_2", "proposal_3"].map((proposalId) => ({
              proposalId,
              passed: false,
              score: 35,
              summary: "中段把上一章已落地命令写成首次提出。",
              issues: [
                {
                  id: "canon_fact_continuity",
                  severity: "critical",
                  category: "既定事实连续性",
                  description: "把上一章已经落实的火药摆放命令重新写成首次提出的新规。",
                  evidence: "第一次临时新提出来",
                  suggestion: "保留执行争执和后果，不要重置命令本身。",
                },
              ],
              revisionNotes: ["删除“第一次提出”，改成执行后果继续发酵。"],
            })),
        }),
      });
    }

    if (instructions.includes("ChapterOutlineRepairAgent") && inputText.includes("第一次临时新提出来")) {
      repairCalls += 1;
      return jsonResponse({
        output_text: JSON.stringify({
          proposals: [
            {
              proposalId: "proposal_repaired_fact",
              summary: "修复为承接上一章已定火药规矩的执行后果。",
              rationale: "不重置命令，只写执行代价继续发酵。",
              diffSummary: "把首次提出改成旧命令的后果延续。",
              title: "第二章·旧令压场",
              timeInStory: "故事第2日",
              povCharacter: "李凡",
              location: "赤屿内港",
              keyEvents: ["承接上一章压力", "火药旧令引发执行代价", "章末留下外部压力"],
              arcContribution: ["李凡必须承受已定命令的后果"],
              nextHook: "外部压力继续压来。",
              emotionalTone: "承压推进",
              threadMode: "single_spine",
              dominantThread: "承接上一章旧令后果继续推进。",
              entryMode: "direct_resume",
              entryLink: "承接上一章留下的高压盘面与执行压力。",
              exitPressure: "外部压力继续压来。",
              charactersPresent: ["李凡", "宋应星"],
              continuityAnchors: ["火药规矩已在上一章落地，不能重置"],
              evidenceRefs: ["fact_ch001_001"],
              scenes: [
                {
                  label: "旧令余波",
                  location: "赤屿内港·库棚",
                  focus: "让上一章火药规矩的执行后果继续发酵",
                  tension: "旧令带来的成本压到现场",
                  characters: ["李凡", "宋应星"],
                  threadId: "main",
                  scenePurpose: "承接上一章既定命令的后果",
                  inheritsFromPrevious: "承接上一章留下的高压盘面与执行压力",
                  outcome: "旧令的执行代价显形",
                  handoffToNext: "把外部压力推到章末",
                },
              ],
            },
          ],
        }),
      });
    }

    return previousFetch(url, options);
  };

  try {
    const outlineRun = await runWriteChapter(store);
    assert.equal(outlineRun.project.phase.write.status, "chapter_outline_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  const outlineDraft = await store.loadChapterDraft("ch002");
  assert.equal(repairCalls, 1);
  assert.equal(outlineDraft.chapterOutlineCandidates[0].proposalId, "proposal_repaired_fact");
  assert.equal(outlineDraft.outlineContinuityAudit.manualReviewRequired, false);
  assert.ok(outlineDraft.chapterOutlineHistory.some((item) => item.action === "outline_consistency_repair"));
})));

test("chapter outline consistency repair can pass on the third audit round", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-outline-third-pass-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await lockNextChapter(store);

  const previousFetch = globalThis.fetch;
  let auditCalls = 0;
  let repairCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("ChapterOutlineConsistencyAuditAgent") && inputText.includes("当前章节：ch002")) {
      auditCalls += 1;
      const proposalId = [...inputText.matchAll(/proposal_[\w-]+/g)].map((match) => match[0]).at(-1) || "proposal_1";
      return jsonResponse({
        output_text: JSON.stringify({
          summary: auditCalls < 3 ? "仍有残留连续性冲突。" : "第三轮已修复。",
          candidateAudits: [
            {
              proposalId,
              passed: auditCalls >= 3,
              score: auditCalls >= 3 ? 90 : 40,
              summary: auditCalls >= 3 ? "已通过。" : "仍需修。",
              issues: auditCalls >= 3 ? [] : [
                {
                  id: "history_thread_break",
                  severity: "critical",
                  category: "历史线程",
                  description: "未承接上一章留下的压力。",
                  evidence: "缺少上章压力",
                  suggestion: "补上上章压力和章末交棒。",
                },
              ],
              revisionNotes: auditCalls >= 3 ? [] : ["补上上章压力和章末交棒。"],
            },
          ],
        }),
      });
    }

    if (instructions.includes("ChapterOutlineRepairAgent") && inputText.includes("当前章节：ch002")) {
      repairCalls += 1;
      return previousFetch(url, options);
    }

    return previousFetch(url, options);
  };

  try {
    await runWriteChapter(store);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const outlineDraft = await store.loadChapterDraft("ch002");
  assert.equal(auditCalls, 3);
  assert.equal(repairCalls, 2);
  assert.equal(outlineDraft.outlineContinuityAudit.manualReviewRequired, false);
  assert.equal(outlineDraft.outlineContinuityAudit.attempts.length, 3);
  assert.equal(outlineDraft.chapterOutlineHistory.filter((item) => item.action === "outline_consistency_repair").length, 2);
})));

test("chapter outline consistency audit enters manual review after five failing rounds", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-outline-manual-after-five-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await lockNextChapter(store);

  const previousFetch = globalThis.fetch;
  let auditCalls = 0;
  let repairCalls = 0;
  let writerCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("WriterAgent")) {
      writerCalls += 1;
    }

    if (instructions.includes("ChapterOutlineConsistencyAuditAgent") && inputText.includes("当前章节：ch002")) {
      auditCalls += 1;
      const proposalId = [...inputText.matchAll(/proposal_[\w-]+/g)].map((match) => match[0]).at(-1) || "proposal_1";
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "持续存在阻断性连续性冲突。",
          candidateAudits: [
            {
              proposalId,
              passed: false,
              score: 30,
              summary: "仍然重置历史事实。",
              issues: [
                {
                  id: "canon_fact_continuity",
                  severity: "critical",
                  category: "既定事实连续性",
                  description: "仍然把上一章已定事实重置成新信息。",
                  evidence: "重置既定事实",
                  suggestion: "彻底删除事实重置。",
                },
              ],
              revisionNotes: ["彻底删除事实重置。"],
            },
          ],
        }),
      });
    }

    if (instructions.includes("ChapterOutlineRepairAgent") && inputText.includes("当前章节：ch002")) {
      repairCalls += 1;
      return previousFetch(url, options);
    }

    return previousFetch(url, options);
  };

  let outlineRun;
  try {
    outlineRun = await runWriteChapter(store);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const outlineDraft = await store.loadChapterDraft("ch002");
  assert.equal(outlineRun.project.phase.write.status, "chapter_outline_pending_review");
  assert.equal(outlineDraft.reviewState.manualReviewRequired, true);
  assert.equal(outlineDraft.outlineContinuityAudit.manualReviewRequired, true);
  assert.equal(outlineDraft.outlineContinuityAudit.attempts.length, 5);
  assert.equal(auditCalls, 5);
  assert.equal(repairCalls, 4);
  assert.equal(writerCalls, 0);
})));

test("composed chapter outline finalization is re-audited before writer generation", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-outline-compose-reaudit-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  await runWriteChapter(store);
  const outlineDraft = await store.loadChapterDraft("ch001");
  const selectedSceneRefs = [
    outlineDraft.chapterOutlineCandidates[0].chapterPlan.scenes[0].sceneRef,
    outlineDraft.chapterOutlineCandidates[1].chapterPlan.scenes[1].sceneRef,
  ];

  const previousFetch = globalThis.fetch;
  let sawFinalize = false;
  let writerCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("ChapterOutlineFinalizeAgent")) {
      sawFinalize = true;
      return jsonResponse({
        output_text: JSON.stringify({
          title: "第1章·错误拼接",
          timeInStory: "故事第1日",
          povCharacter: "李凡",
          location: "赤屿内港",
          keyEvents: ["重置已发生事件"],
          arcContribution: ["错误重置"],
          nextHook: "错误压力。",
          emotionalTone: "混乱",
          threadMode: "single_spine",
          dominantThread: "错误重置历史。",
          entryLink: "承接压力。",
          exitPressure: "错误压力。",
          charactersPresent: ["李凡"],
          continuityAnchors: ["错误重置"],
          scenes: [
            {
              label: "错误拼接",
              location: "赤屿内港",
              focus: "把已发生事件重新写成未发生",
              tension: "历史冲突",
              characters: ["李凡"],
              threadId: "main",
              scenePurpose: "制造冲突",
              inheritsFromPrevious: "承接压力",
              outcome: "历史被重置",
              handoffToNext: "错误压力",
            },
          ],
        }),
      });
    }

    if (instructions.includes("ChapterOutlineConsistencyAuditAgent") && sawFinalize) {
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "组合细纲最终稿存在历史冲突。",
          candidateAudits: [
            {
              proposalId: "proposal_1",
              passed: false,
              score: 25,
              summary: "组合稿重置历史。",
              issues: [
                {
                  id: "history_fact_conflict",
                  severity: "critical",
                  category: "历史事实冲突",
                  description: "组合细纲把已经发生的事件重新写成未发生。",
                  evidence: "重新写成未发生",
                  suggestion: "按已锁章节事实重接 scene。",
                },
              ],
              revisionNotes: ["按已锁章节事实重接 scene。"],
            },
          ],
        }),
      });
    }

    if (instructions.includes("WriterAgent")) {
      writerCalls += 1;
    }

    return previousFetch(url, options);
  };

  let reviewRun;
  try {
    reviewRun = await reviewChapter(store, {
      target: "chapter_outline",
      approved: true,
      reviewAction: "approve_composed",
      selectedSceneRefs,
      authorNotes: "组合后需要复审。",
      feedback: "",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  const nextDraft = await store.loadChapterDraft("ch001");
  assert.equal(reviewRun.project.phase.write.status, "chapter_outline_pending_review");
  assert.equal(nextDraft.reviewState.manualReviewRequired, true);
  assert.equal(nextDraft.outlineContinuityAudit.manualReviewRequired, true);
  assert.equal(writerCalls, 0);
})));

test("style fingerprints are stored globally, editable, and reusable across projects", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-style-library-"));
  const first = await createProjectWorkspace(workspaceRoot, "Alpha Style");
  const second = await createProjectWorkspace(workspaceRoot, "Beta Style");
  const firstStore = await createStore(first.root, { workspaceRoot });
  const secondStore = await createStore(second.root, { workspaceRoot });

  const generated = await generateStyleFingerprint(firstStore, {
    name: "冷峻近贴视角",
    sampleText: "海风沿着礁壁刮过去，甲板上的铁件互相磕碰，声音硬得像在催命。李凡没有回头，只盯着前方那一道越来越近的黑线。",
  });

  assert.match(generated.promptMarkdown, /风格指纹指令：冷峻近贴视角/);
  assert.match(generated.promptMarkdown, /不要写成全知抒情旁白/);

  const styleId = generated.metadata.id;
  const sharedInSecondStore = await secondStore.loadStyleFingerprint(styleId);
  assert.equal(sharedInSecondStore?.metadata?.id, styleId);

  const updated = await secondStore.updateStyleFingerprint(styleId, {
    name: "冷峻近贴视角·修订版",
    summary: buildStyleFingerprintSummary("冷峻近贴视角·修订版", sharedInSecondStore.fingerprint),
    promptMarkdown: `${sharedInSecondStore.promptMarkdown}\n- 让压迫感更多落在听觉与动作上。`,
  });
  assert.match(updated.promptMarkdown, /听觉与动作/);

  const listedFromFirst = await firstStore.listStyleFingerprints();
  assert.ok(listedFromFirst.some((item) => item.id === styleId && item.name === "冷峻近贴视角·修订版"));

  const firstProject = await firstStore.loadProject();
  await firstStore.saveProject({
    ...firstProject,
    project: {
      ...firstProject.project,
      styleFingerprintId: styleId,
    },
  });

  const secondProject = await secondStore.loadProject();
  await secondStore.saveProject({
    ...secondProject,
    project: {
      ...secondProject.project,
      styleFingerprintId: null,
    },
  });

  assert.equal((await firstStore.loadProject()).project.styleFingerprintId, styleId);
  assert.equal((await secondStore.loadProject()).project.styleFingerprintId, null);
})));

test("chapter review uses a unified rewrite action", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-rewrite-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);

  const rewriteRun = await reviewChapter(store, {
    target: "chapter",
    approved: false,
    reviewAction: "rewrite",
    feedback: "加强整章压迫感和人物试探。",
  });
  assert.equal(rewriteRun.project.phase.write.status, "chapter_pending_review");

  const rewrittenDraft = await store.loadChapterDraft("ch001");
  assert.equal(rewrittenDraft.reviewState.mode, "rewrite");
  assert.equal(rewrittenDraft.reviewState.strategy, "chapter_rewrite");
  assert.equal(rewrittenDraft.reviewState.feedbackSupervisionPassed, true);
  assert.equal(rewrittenDraft.reviewState.feedbackSupervisionAttempts >= 1, true);
  assert.equal(rewrittenDraft.rewriteHistory.length, 1);
  assert.equal(rewrittenDraft.rewriteHistory[0].feedbackSupervisionPassed, true);
  assert.deepEqual(rewrittenDraft.sceneDrafts, []);
  assert.match(rewrittenDraft.chapterMarkdown, /加强整章压迫感和人物试探|李凡没有浪费任何时间|推进已经把盘面往更大的方向抬高了/);

  await assert.rejects(
    () =>
      reviewChapter(store, {
        target: "chapter",
        approved: false,
        reviewAction: "local_rewrite",
        feedback: "只动第一场。",
        sceneIds: ["ch001_scene_1"],
      }),
    /章节审查已切换为整章模式/,
  );

  await assert.rejects(
    () =>
      reviewChapter(store, {
        target: "chapter",
        approved: false,
        reviewAction: "rewrite",
        feedback: "重排一下。",
        sceneOrder: ["ch001_scene_3", "ch001_scene_1", "ch001_scene_2"],
      }),
    /章节审查已切换为整章模式/,
  );
})));

test("chapter rewrite retries when the first rewrite is a no-op", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-rewrite-retry-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);

  const originalDraft = await store.loadChapterDraft("ch001");
  const previousFetch = globalThis.fetch;
  let rewriteCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("WriterAgent") && inputText.includes("待修正文：")) {
      rewriteCalls += 1;
      if (rewriteCalls === 1) {
        return jsonResponse({
          output_text: originalDraft.chapterMarkdown,
        });
      }
      return jsonResponse({
        output_text: "# 第一章\n\n李凡把呼吸压稳，先盯住最要命的破口，再逼所有人跟上他的节奏。\n这一次他没有重复旧话，而是按“加强整章压迫感和人物试探。”把每一步都推到更险的位置。\n甲板上的人谁也不敢先松那口气，因为下一步只会更狠。",
      });
    }

    return previousFetch(url, options);
  };

  try {
    const rewriteRun = await reviewChapter(store, {
      target: "chapter",
      approved: false,
      reviewAction: "rewrite",
      feedback: "加强整章压迫感和人物试探。",
    });

    assert.equal(rewriteRun.project.phase.write.status, "chapter_pending_review");
    assert.ok(rewriteRun.run.steps.some((item) => item.id === "rewrite_retry"));
    assert.ok(rewriteRun.run.steps.some((item) => item.label === "FeedbackSupervisorAgent"));
  } finally {
    globalThis.fetch = previousFetch;
  }

  const rewrittenDraft = await store.loadChapterDraft("ch001");
  assert.equal(rewriteCalls, 2);
  assert.notEqual(rewrittenDraft.chapterMarkdown, originalDraft.chapterMarkdown);
  assert.match(rewrittenDraft.chapterMarkdown, /每一步都推到更险的位置/);
})));

test("chapter review supports partial rewrite with revision agent context and selection-only replacement", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-partial-rewrite-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);

  const originalDraft = await store.loadChapterDraft("ch001");
  const originalTitle = originalDraft.chapterMarkdown.split("\n")[0];
  const originalBody = originalDraft.chapterMarkdown.replace(/^#.+\n\n/u, "");
  const originalLines = originalBody.split("\n");
  const selectedText = originalLines[1];
  const prefixContext = `${originalLines[0]}\n`;
  const suffixContext = `\n${originalLines.slice(2).join("\n")}`;

  const previousFetch = globalThis.fetch;
  let sawRevisionPrompt = false;
  let writerCallsAfterSelection = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("RevisionAgent")) {
      sawRevisionPrompt = true;
      assert.match(inputText, /原文全文：/);
      assert.match(inputText, /只允许改写的原文片段：/);
      assert.match(inputText, /作者修改要求：把这一段压得更紧，增加试探感。/);
      assert.match(inputText, /风格指南：/);
      assert.match(inputText, /整理后的写前上下文：/);
      assert.match(inputText, /历史衔接摘要：/);
      assert.match(inputText, /输出要求：只输出替换片段本身/);
      return jsonResponse({
        output_text: "替换片段：李凡把话压得更低，先试出对方的底，再把下一步逼近眼前。",
      });
    }

    if (instructions.includes("WriterAgent")) {
      writerCallsAfterSelection += 1;
    }

    return previousFetch(url, options);
  };

  try {
    const rewriteRun = await reviewChapter(store, {
      target: "chapter",
      approved: false,
      reviewAction: "partial_rewrite",
      feedback: "把这一段压得更紧，增加试探感。",
      selection: {
        selectedText,
        prefixContext,
        suffixContext,
      },
    });

    assert.equal(rewriteRun.project.phase.write.status, "chapter_pending_review");
    assert.ok(rewriteRun.run.steps.some((item) => item.id === "partial_rewrite"));
  } finally {
    globalThis.fetch = previousFetch;
  }

  const rewrittenDraft = await store.loadChapterDraft("ch001");
  const rewrittenBody = rewrittenDraft.chapterMarkdown.replace(/^#.+\n\n/u, "");
  const rewrittenLines = rewrittenBody.split("\n");
  assert.equal(sawRevisionPrompt, true);
  assert.equal(writerCallsAfterSelection, 0);
  assert.equal(rewrittenDraft.chapterMarkdown.split("\n")[0], originalTitle);
  assert.equal(rewrittenLines[0], originalLines[0]);
  assert.equal(rewrittenLines[2], originalLines[2]);
  assert.equal(rewrittenDraft.reviewState.mode, "partial_rewrite");
  assert.equal(rewrittenDraft.reviewState.strategy, "selection_patch");
  assert.equal(rewrittenDraft.reviewState.feedbackSupervisionPassed, true);
  assert.equal(rewrittenDraft.rewriteHistory.length, 1);
  assert.equal(rewrittenDraft.rewriteHistory[0].mode, "partial_rewrite");
  assert.equal(rewrittenDraft.rewriteHistory[0].feedbackSupervisionPassed, true);
  assert.match(rewrittenLines[1], /李凡把话压得更低/);
  assert.doesNotMatch(rewrittenLines[1], new RegExp(selectedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
})));

test("chapter review supports saving direct human edits to the staged chapter body", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-manual-edit-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);

  const originalDraft = await store.loadChapterDraft("ch001");
  const originalTitle = originalDraft.chapterMarkdown.split("\n\n")[0];
  const originalBody = originalDraft.chapterMarkdown.replace(/^#.+\n\n/u, "");
  const editedBody = `${originalBody}\n\n李凡把最后一句压得更稳，先把试探藏进了呼吸里。`;
  const previousFetch = globalThis.fetch;
  let manualEditFetchCalls = 0;

  globalThis.fetch = async (...args) => {
    manualEditFetchCalls += 1;
    return previousFetch(...args);
  };

  try {
    const saveRun = await saveManualChapterEdit(store, {
      chapterBody: editedBody,
    });

    assert.equal(saveRun.project.phase.write.status, "chapter_pending_review");
    assert.ok(saveRun.run?.steps?.some((item) => item.id === "manual_edit_save"));
    assert.equal(manualEditFetchCalls, 0);

    const savedDraft = await store.loadChapterDraft("ch001");
    assert.equal(savedDraft.chapterMarkdown.split("\n\n")[0], originalTitle);
    assert.match(savedDraft.chapterMarkdown, /李凡把最后一句压得更稳/);
    assert.equal(savedDraft.reviewState.mode, "manual_edit");
    assert.equal(savedDraft.reviewState.feedbackSupervisionPassed, true);
    assert.equal(savedDraft.validation.semanticAudit.source, "heuristics_only");
    assert.equal(savedDraft.rewriteHistory.at(-1)?.mode, "manual_edit");
  } finally {
    globalThis.fetch = previousFetch;
  }
})));

test("partial rewrite retries when the first revision is a no-op", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-partial-rewrite-retry-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);

  const originalDraft = await store.loadChapterDraft("ch001");
  const originalBody = originalDraft.chapterMarkdown.replace(/^#.+\n\n/u, "");
  const originalLines = originalBody.split("\n");
  const selectedText = originalLines[1];
  const prefixContext = `${originalLines[0]}\n`;
  const suffixContext = `\n${originalLines.slice(2).join("\n")}`;

  const previousFetch = globalThis.fetch;
  let revisionCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("RevisionAgent")) {
      revisionCalls += 1;
      if (revisionCalls === 1) {
        return jsonResponse({
          output_text: selectedText,
        });
      }
      assert.match(inputText, /不能原样重复选中的原文/);
      return jsonResponse({
        output_text: "李凡没有立刻把话说满，只把真正致命的那一步压到众人眼前。",
      });
    }

    return previousFetch(url, options);
  };

  try {
    const rewriteRun = await reviewChapter(store, {
      target: "chapter",
      approved: false,
      reviewAction: "partial_rewrite",
      feedback: "把这一段压得更紧，增加试探感。",
      selection: {
        selectedText,
        prefixContext,
        suffixContext,
      },
    });

    assert.equal(rewriteRun.project.phase.write.status, "chapter_pending_review");
    assert.ok(rewriteRun.run.steps.some((item) => item.id === "partial_rewrite_retry"));
  } finally {
    globalThis.fetch = previousFetch;
  }

  const rewrittenDraft = await store.loadChapterDraft("ch001");
  assert.equal(revisionCalls, 2);
  assert.equal(rewrittenDraft.reviewState.feedbackSupervisionAttempts, 2);
  assert.match(rewrittenDraft.chapterMarkdown, /李凡没有立刻把话说满/);
  assert.doesNotMatch(rewrittenDraft.chapterMarkdown, new RegExp(selectedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
})));

test("chapter rewrite enters feedback manual review after three unresolved supervision rounds", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-feedback-manual-review-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);

  const previousFetch = globalThis.fetch;
  let writerCalls = 0;
  let feedbackCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("FeedbackSupervisorAgent")) {
      feedbackCalls += 1;
      return jsonResponse({
        output_text: JSON.stringify({
          passed: false,
          summary: "压迫感仍然不够，人物试探还没有真正压到场上。",
          missingItems: ["整章压迫感仍然偏弱。", "人物试探还不够锋利。"],
          revisionNotes: ["把场上压迫感继续压高，让每一步都更危险。", "让人物试探带出更明确的风险与博弈。"],
          evidence: "局势看起来仍然偏稳，没有真正逼近失控。",
          scopeBlocked: false,
        }),
      });
    }

    if (instructions.includes("WriterAgent") && inputText.includes("待修正文：")) {
      writerCalls += 1;
      return jsonResponse({
        output_text: `# 第一章\n\n李凡把呼吸压稳，先盯住最要命的破口，再把第 ${writerCalls} 轮应对往更险处推。\n他知道局面还不够狠，于是每一句试探都压得更低，却仍没有真正把所有人的退路逼断。\n甲板上的风越刮越硬，但这一轮局势还没有被彻底顶到失控边缘。`,
      });
    }

    return previousFetch(url, options);
  };

  try {
    const rewriteRun = await reviewChapter(store, {
      target: "chapter",
      approved: false,
      reviewAction: "rewrite",
      feedback: "加强整章压迫感和人物试探。",
    });

    assert.equal(rewriteRun.project.phase.write.status, "chapter_pending_review");
    assert.ok(rewriteRun.run.steps.some((item) => item.id === "feedback_manual_review"));
  } finally {
    globalThis.fetch = previousFetch;
  }

  const rewrittenDraft = await store.loadChapterDraft("ch001");
  assert.equal(writerCalls >= 3, true);
  assert.equal(feedbackCalls >= 3, true);
  assert.equal(rewrittenDraft.reviewState.strategy, "feedback_manual_review");
  assert.equal(rewrittenDraft.reviewState.manualReviewRequired, true);
  assert.equal(rewrittenDraft.reviewState.feedbackSupervisionPassed, false);
  assert.ok(rewrittenDraft.reviewState.blockingFeedbackIssues.length >= 1);
})));

test("partial rewrite stops at feedback manual review when supervision says the selection is too narrow", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-partial-scope-blocked-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);

  const originalDraft = await store.loadChapterDraft("ch001");
  const originalBody = originalDraft.chapterMarkdown.replace(/^#.+\n\n/u, "");
  const originalLines = originalBody.split("\n");
  const selectedText = originalLines[1];
  const prefixContext = `${originalLines[0]}\n`;
  const suffixContext = `\n${originalLines.slice(2).join("\n")}`;

  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");

    if (instructions.includes("RevisionAgent")) {
      return jsonResponse({
        output_text: "李凡把话压得更低，先把刀锋递到桌面上，却还没动到后续真正要变的盘面。",
      });
    }

    if (instructions.includes("FeedbackSupervisorAgent")) {
      return jsonResponse({
        output_text: JSON.stringify({
          passed: false,
          summary: "这条反馈需要改到选区外的承接与结果段，当前选区内无法完整完成。",
          missingItems: ["选区后的承接段也必须同步改写，当前反馈无法只靠这一段完成。"],
          revisionNotes: ["如果坚持局部修订，需要人工重新选择更大的连续片段。"],
          evidence: "当前替换片段只改了局部语气，没有改到后续结果链。",
          scopeBlocked: true,
        }),
      });
    }

    return previousFetch(url, options);
  };

  try {
    const rewriteRun = await reviewChapter(store, {
      target: "chapter",
      approved: false,
      reviewAction: "partial_rewrite",
      feedback: "把这一段压得更紧，并让后续结果直接接上这次试探。",
      selection: {
        selectedText,
        prefixContext,
        suffixContext,
      },
    });

    assert.equal(rewriteRun.project.phase.write.status, "chapter_pending_review");
    assert.ok(rewriteRun.run.steps.some((item) => item.id === "feedback_manual_review"));
  } finally {
    globalThis.fetch = previousFetch;
  }

  const rewrittenDraft = await store.loadChapterDraft("ch001");
  assert.equal(rewrittenDraft.reviewState.strategy, "feedback_manual_review");
  assert.equal(rewrittenDraft.reviewState.feedbackSupervisionPassed, false);
  assert.ok(rewrittenDraft.reviewState.blockingFeedbackIssues.some((item) => /选区/u.test(item)));

  await assert.rejects(
    () => reviewChapter(store, {
      target: "chapter",
      approved: true,
      feedback: "",
    }),
    /显式确认 override 风险/,
  );
})));

test("chapter generation uses a single WriterAgent pass on a clean draft", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-single-pass-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  let chapterWriterCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (
      instructions.includes("WriterAgent") &&
      /^章节：ch001 /m.test(inputText) &&
      !/模式：style_repair|模式：validation_repair/u.test(inputText) &&
      !inputText.includes("待修正文：")
    ) {
      chapterWriterCalls += 1;
    }

    return previousFetch(url, options);
  };

  try {
    const writeRun = await runWriteChapterThroughOutline(store);
    assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  const stagedDraft = await store.loadChapterDraft("ch001");
  assert.equal(chapterWriterCalls, 1);
  assert.deepEqual(stagedDraft.sceneDrafts, []);
})));

test("canon fact conflicts stop after two auto-repairs and return to manual review", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-canon-manual-review-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);
  await reviewChapter(store, {
    target: "chapter",
    approved: true,
    feedback: "",
  });

  const previousFetch = globalThis.fetch;
  let chapterWriterCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input) || String(payload.input || "");

    if (instructions.includes("WriterAgent") && inputText.includes("章节：ch002")) {
      chapterWriterCalls += 1;
      return jsonResponse({
        output_text: "李凡把话一压，又把上一章已经落实的火药规矩重新当成第一次临时新提出来。",
      });
    }

    if (instructions.includes("AuditOrchestrator") && inputText.includes("ch002")) {
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "审计发现章节级 canon facts 连续性冲突。",
          issues: [
            {
              id: "canon_fact_continuity",
              severity: "critical",
              category: "连续性与边界",
              description: "把上一章已经落地的火药摆放命令重新写成了首次提出的新规。",
              evidence: "本章把既定命令重新定义成未定事项。",
              suggestion: "保留争执后果，但不要重开既定命令本身。",
            },
          ],
          dimensionSummaries: {
            canon_fact_continuity: "本章重置了上一章已经建立的章节级既定事实。",
          },
        }),
      });
    }

    return previousFetch(url, options);
  };

  let writeRun;
  try {
    writeRun = await runWriteChapterThroughOutline(store);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const stagedChapterDraft = await store.loadChapterDraft("ch002");
  assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  assert.equal(stagedChapterDraft.reviewState?.strategy, "canon_fact_manual_review");
  assert.equal(stagedChapterDraft.reviewState?.manualReviewRequired, true);
  assert.equal(stagedChapterDraft.reviewState?.canonFactAutoRepairAttempts, 2);
  assert.ok(Array.isArray(stagedChapterDraft.reviewState?.canonFactIssues));
  assert.ok(stagedChapterDraft.reviewState.canonFactIssues.length >= 1);
  assert.ok(writeRun.project.phase.write.rejectionNotes.length >= 1);
  assert.match(writeRun.run.summary, /人工审核/u);
  assert.ok(chapterWriterCalls >= 3);
})));

test("audit heuristics flag repeated chapter restarts as critical issues", () => {
  const badChapter = [
    "# 第一章 先把那扇炮门关上",
    "方向盘顶进胸口的那一下还没来得及疼完，一声炮震就把李凡从黑里砸醒。",
    "船板猛地一斜，他半张脸拍进冰冷咸水里，唐鹞的炮声和甲板上的喊杀一起压了过来。",
    "林定海把刀架在他下巴上，问昨夜那盏灯是给谁打的，马会魁在旁边嚷着通敌的先砍。",
    "李凡盯着右舷那扇炮门，咬死不是船底全裂了，只要再看两三浪，水涨就会慢下来。",
    "白灯迎面撞来，轮胎尖叫，玻璃炸碎。",
    "下一瞬又是一门炮在耳边开花，他猛地睁眼，咸水、木船和甲板把同一场海上险局重新拍回脸上。",
    "这一次还是崇祯二年铜山外海，唐鹞在后头咬着，林定海与马会魁仍在为通敌嫌疑争执。",
    "他又一次喊先把那扇炮门关上，说不是船底裂了，只要水涨慢下来，就证明右舷腰间才是倒灌口。",
  ].join("\n\n");

  const heuristics = runAuditHeuristics({
    chapterPlan: {
      chapterId: "ch001",
      title: "先把那扇炮门关上",
      chapterNumber: 1,
      emotionalTone: "高压",
    },
    chapterDraft: { markdown: badChapter },
    researchPacket: null,
    foreshadowingRegistry: { foreshadowings: [] },
    recentChapters: [],
  });

  const replayIssue = heuristics.issues.find((item) => item.id === "chapter_restart_replay");
  assert.equal(replayIssue?.severity, "critical");
});

test("audit heuristics flag missing planned named characters as outline drift", () => {
  const heuristics = runAuditHeuristics({
    chapterPlan: {
      chapterId: "ch001",
      title: "风急夜港",
      chapterNumber: 1,
      emotionalTone: "高压",
      charactersPresent: ["李凡", "林定海", "许三娘", "众水手"],
    },
    chapterDraft: {
      markdown: "# 风急夜港\n\n李凡一手按住桅索，许三娘抱着账册从棚口闯进来，众水手跟着奔向船舷。",
    },
    researchPacket: null,
    foreshadowingRegistry: { foreshadowings: [] },
    recentChapters: [],
  });

  const issue = heuristics.issues.find((item) => item.id === "outline_drift");
  assert.equal(issue?.severity, "critical");
  assert.match(issue?.description || "", /林定海/u);
});

test("chapter generation sends stitched replay drafts to manual review after targeted and full auto-repairs", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-replay-audit-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const badChapter = [
    "# 第一章 先把那扇炮门关上",
    "方向盘顶进胸口的那一下还没来得及疼完，一声炮震就把李凡从黑里砸醒。",
    "船板猛地一斜，他半张脸拍进冰冷咸水里，唐鹞的炮声和甲板上的喊杀一起压了过来。",
    "林定海把刀架在他下巴上，问昨夜那盏灯是给谁打的，马会魁在旁边嚷着通敌的先砍。",
    "李凡盯着右舷那扇炮门，咬死不是船底全裂了，只要再看两三浪，水涨就会慢下来。",
    "白灯迎面撞来，轮胎尖叫，玻璃炸碎。",
    "下一瞬又是一门炮在耳边开花，他猛地睁眼，咸水、木船和甲板把同一场海上险局重新拍回脸上。",
    "这一次还是崇祯二年铜山外海，唐鹞在后头咬着，林定海与马会魁仍在为通敌嫌疑争执。",
    "他又一次喊先把那扇炮门关上，说不是船底裂了，只要水涨慢下来，就证明右舷腰间才是倒灌口。",
  ].join("\n\n");

  const previousFetch = globalThis.fetch;
  let writerCalls = 0;
  let targetedRepairCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input) || String(payload.input || "");

    if (instructions.includes("WriterAgent")) {
      writerCalls += 1;
      if (inputText.includes("模式：targeted_repair")) {
        targetedRepairCalls += 1;
      }
      return jsonResponse({
        output_text: badChapter,
      });
    }

    return previousFetch(url, options);
  };

  let writeRun;
  try {
    writeRun = await runWriteChapterThroughOutline(store);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const stagedChapterDraft = await store.loadChapterDraft("ch001");
  assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  assert.equal(stagedChapterDraft.reviewState?.strategy, "audit_manual_review");
  assert.equal(stagedChapterDraft.reviewState?.manualReviewRequired, true);
  assert.equal(stagedChapterDraft.reviewState?.auditAutoRepairAttempts, 3);
  assert.ok(Array.isArray(stagedChapterDraft.reviewState?.blockingAuditIssues));
  assert.ok(stagedChapterDraft.reviewState.blockingAuditIssues.length >= 1);
  assert.ok(writerCalls >= 4);
  assert.ok(targetedRepairCalls >= 1);
  assert.match(writeRun.run.summary, /人工审核/u);
})));

test("chapter generation sends critically short drafts to manual review after targeted and focused auto-repairs", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-word-count-manual-review-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const projectState = await store.loadProject();
  projectState.project.targetWordsPerChapter = 800;
  await store.saveProject(projectState);

  const previousFetch = globalThis.fetch;
  let writerCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");

    if (instructions.includes("WriterAgent")) {
      writerCalls += 1;
      return jsonResponse({
        output_text: "李凡只说了一句先稳住。",
      });
    }

    return previousFetch(url, options);
  };

  let writeRun;
  try {
    writeRun = await runWriteChapterThroughOutline(store);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const stagedChapterDraft = await store.loadChapterDraft("ch001");
  assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  assert.equal(stagedChapterDraft.reviewState?.strategy, "audit_manual_review");
  assert.equal(stagedChapterDraft.reviewState?.manualReviewRequired, true);
  assert.equal(stagedChapterDraft.reviewState?.auditAutoRepairAttempts, 3);
  assert.ok(Array.isArray(stagedChapterDraft.reviewState?.blockingAuditIssues));
  assert.ok(stagedChapterDraft.reviewState.blockingAuditIssues.some((item) => /字数/u.test(item)));
  assert.ok((stagedChapterDraft.validation?.issues || []).some((item) => item.id === "chapter_word_count"));
  assert.ok(writerCalls >= 4);
  assert.match(writeRun.run.summary, /人工审核/u);
})));

test("chapter approval requires explicit override acknowledgement when audit is still failing", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-approval-override-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const badChapter = [
    "# 第一章 先把那扇炮门关上",
    "方向盘顶进胸口的那一下还没来得及疼完，一声炮震就把李凡从黑里砸醒。",
    "白灯迎面撞来，轮胎尖叫，玻璃炸碎。",
    "下一瞬又是一门炮在耳边开花，他猛地睁眼，咸水、木船和甲板把同一场海上险局重新拍回脸上。",
  ].join("\n\n");

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    if (instructions.includes("WriterAgent")) {
      return jsonResponse({ output_text: badChapter });
    }
    return previousFetch(url, options);
  };

  try {
    await runWriteChapterThroughOutline(store);
  } finally {
    globalThis.fetch = previousFetch;
  }

  await assert.rejects(
    reviewChapter(store, {
      target: "chapter",
      approved: true,
      feedback: "",
    }),
    /显式确认 override 风险/u,
  );

  const locked = await reviewChapter(store, {
    target: "chapter",
    approved: true,
    feedback: "人工确认保留当前版本。",
    approvalOverrideAcknowledged: true,
  });
  assert.equal(locked.project.phase.write.currentChapterNumber, 1);

  const projectState = await store.loadProject();
  const overrideReview = projectState.history.reviews.at(-1);
  assert.equal(overrideReview?.approvalOverride, true);
  assert.equal(overrideReview?.approvalOverrideReason, "人工确认保留当前版本。");
  assert.equal(overrideReview?.approvalValidationSnapshot?.overallPassed, false);
})));

test("knowledge boundary issues are repaired via targeted revision before full-chapter rewrite", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-knowledge-boundary-repair-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  let revisionCalls = 0;
  let targetedRepairCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input) || String(payload.input || "");

    if (instructions.includes("WriterAgent") && /^章节：ch001 /m.test(inputText)) {
      if (inputText.includes("模式：targeted_repair")) {
        targetedRepairCalls += 1;
      }
      return jsonResponse({
        output_text: [
          "# 第一章：铜山外海",
          "许三娘把账册亮出来，冷声说他和岸上的人有往来，有欠票、有暗号、有交易记录。",
          "李凡心里一沉。通敌。原来那个李凡通敌。",
          "他甚至不知道许三娘为什么要把这东西亮给他看。",
        ].join("\n\n"),
      });
    }

    if (instructions.includes("RevisionAgent")) {
      revisionCalls += 1;
      return jsonResponse({
        output_text: "李凡没有立刻接话。他脑子里一片空白，只知道账册上的名字是自己，可那些欠票和暗号，他一个都认不出来。",
      });
    }

    if (instructions.includes("AuditOrchestrator") && inputText.includes("通敌。原来那个李凡通敌。")) {
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "审计发现信息越界。",
          issues: [
            {
              id: "knowledge_boundary",
              severity: "critical",
              category: "信息越界",
              description: "李凡立刻接受了原主通敌这一结论，越过了当前信息边界。",
              evidence: "‘通敌。原来那个李凡通敌。’ / ‘他甚至不知道许三娘为什么要把这东西亮给他看。’",
              suggestion: "把反应改成困惑、搜索记忆、暂不下结论。",
            },
          ],
          dimensionSummaries: {
            knowledge_boundary: "当前李凡的判断速度超过了他应有的信息掌握程度。",
          },
        }),
      });
    }

    if (instructions.includes("AuditOrchestrator")) {
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "审计通过。",
          issues: [],
          dimensionSummaries: {},
        }),
      });
    }

    return previousFetch(url, options);
  };

  let writeRun;
  try {
    writeRun = await runWriteChapterThroughOutline(store);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const stagedChapterDraft = await store.loadChapterDraft("ch001");
  assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  assert.equal(stagedChapterDraft.validation?.overallPassed, true);
  assert.equal(stagedChapterDraft.reviewState?.auditAutoRepairAttempts, 1);
  assert.equal(revisionCalls, 1);
  assert.equal(targetedRepairCalls, 0);
  assert.match(stagedChapterDraft.chapterMarkdown || "", /李凡没有立刻接话/);
})));

test("WriterAgent prompt includes chapter character dossiers", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-writer-dossier-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  let checkedPrompt = false;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (!checkedPrompt && instructions.includes("WriterAgent")) {
      checkedPrompt = true;
      assert.match(inputText, /人物一致性档案/);
      assert.match(inputText, /### 李凡/);
      assert.match(inputText, /说话方式：/);
      assert.match(inputText, /核心欲望：/);
      assert.match(inputText, /小传摘要：/);
      assert.match(inputText, /人物线摘要：/);
      assert.match(inputText, /当前目标：/);
      assert.match(inputText, /风格指南：/);
      assert.match(inputText, /整理后的写前上下文：/);
      assert.match(inputText, /Writer 上下文包/);
      assert.match(inputText, /计划侧摘要/);
      assert.match(inputText, /历史衔接摘要：/);
      assert.match(inputText, /本章主线：/);
      assert.match(inputText, /本场承接自：/);
      assert.match(inputText, /本场交棒给下一场：/);
    }

    return previousFetch(url, options);
  };

  try {
    const writeRun = await runWriteChapterThroughOutline(store);
    assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
    assert.equal(checkedPrompt, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
})));

test("opening collections are stored and buildOpeningReferencePacket handles empty indexes", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-opening-store-"));
  const store = await createStore(tempRoot);

  const collection = await store.createOpeningCollection("黄金三章样例库");
  assert.ok(await store.exists(path.join(collection.sourceDir, "..", "metadata.json")));
  assert.ok(await store.exists(path.join(collection.sourceDir, "..", "index.json")));
  assert.ok(await store.exists(path.join(collection.sourceDir, "..", "chunks.jsonl")));

  const projectState = await store.loadProject();
  await store.saveProject({
    ...projectState,
    project: {
      ...projectState.project,
      openingCollectionIds: [collection.id],
    },
  });

  const savedProject = await store.loadProject();
  assert.deepEqual(savedProject.project.openingCollectionIds, [collection.id]);

  const provider = createProvider(savedProject, { rootDir: tempRoot });
  const packet = await buildOpeningReferencePacket({
    store,
    provider,
    project: savedProject.project,
    mode: "plan_draft",
  });

  assert.equal(packet.triggered, false);
  assert.match(packet.reason || "", /索引为空|未重建/);
})));

test("opening collections feed plan prompts and first three chapter writer prompts only", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-opening-integration-"));
  const store = await createStore(tempRoot);

  const collection = await store.createOpeningCollection("强钩子开头范文");
  await fs.writeFile(
    path.join(collection.sourceDir, "opening.md"),
    [
      "第一章里，主角一开场就撞上生死压力，几句动作和短对白立刻把问题抛出来。",
      "第二章继续加码，让主角的欲望、代价和敌意都更具体。",
      "第三章章末必须再抬一次钩子，让读者知道下一步麻烦更大。",
    ].join("\n\n"),
    "utf8",
  );
  await rebuildOpeningCollectionIndex({
    store,
    collectionId: collection.id,
  });

  const initialProject = await store.loadProject();
  await store.saveProject({
    ...initialProject,
    project: {
      ...initialProject.project,
      openingCollectionIds: [collection.id],
    },
  });

  const previousFetch = globalThis.fetch;
  let sawPlanOpeningPrompt = false;
  let sawChapterOneOpeningPrompt = false;
  let sawChapterFourOpeningPrompt = false;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (!sawPlanOpeningPrompt && instructions.includes("OutlineAgent") && /黄金三章参考包/.test(inputText)) {
      sawPlanOpeningPrompt = true;
      assert.match(inputText, /强钩子开头范文/);
      assert.match(inputText, /只借结构，不借句子/);
    }

    if (instructions.includes("WriterAgent") && /^章节：ch001 /m.test(inputText)) {
      sawChapterOneOpeningPrompt = true;
      assert.match(inputText, /黄金三章参考包：/);
      assert.match(inputText, /开场钩子|主角亮相|结构拍点/);
    }

    if (instructions.includes("WriterAgent") && /^章节：ch004 /m.test(inputText)) {
      sawChapterFourOpeningPrompt = true;
      assert.doesNotMatch(inputText, /强钩子开头范文/);
    }

    return previousFetch(url, options);
  };

  try {
    await runPlanDraft(store);
    assert.equal(sawPlanOpeningPrompt, true);

    await reviewPlanDraft(store, { approved: true, feedback: "" });
    await reviewPlanFinal(store, { approved: true, feedback: "" });

    await runWriteChapterThroughOutline(store);
    const stagedChapterOne = await store.loadChapterDraft("ch001");
    assert.equal(stagedChapterOne.openingReferencePacket?.triggered, true);
    assert.ok((stagedChapterOne.contextPackage?.selectedContext || []).some((item) => item.source.includes("runtime/opening_collections")));
    assert.ok((stagedChapterOne.ruleStack?.softGoals || []).some((item) => item.includes("黄金三章")));
    assert.ok(await store.exists(path.join(tempRoot, "runtime", "staging", "write", "ch001", "opening_reference_packet.json")));
    await reviewChapter(store, {
      target: "chapter",
      approved: true,
      feedback: "",
    });

    await runWriteChapterThroughOutline(store, {
      runOptions: {
        chapterNumber: 4,
      },
    });
    const stagedChapterFour = await store.loadChapterDraft("ch004");
    assert.equal(stagedChapterFour.openingReferencePacket?.triggered, false);
    assert.equal(sawChapterOneOpeningPrompt, true);
    assert.equal(sawChapterFourOpeningPrompt, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
})));

test("RAG collection rebuild decodes gb18030 text and feeds reference packet into WriterAgent", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-rag-"));
  const store = await createStore(tempRoot);

  const collection = await store.createRagCollection("晚明海防范文");
  const repeatedNiHao = Buffer.from("c4e3bac3", "hex");
  const gb18030Buffer = Buffer.concat(Array.from({ length: 450 }, () => repeatedNiHao));
  await fs.writeFile(path.join(collection.sourceDir, "gb18030_sample.txt"), gb18030Buffer);
  await fs.writeFile(
    path.join(collection.sourceDir, "scene_ref.md"),
    Array.from({ length: 60 }, () => "海风压在礁岸上，命令短促，人物先动作后开口，潮声里带着压迫感。").join("\n\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(collection.sourceDir, "port_ref.md"),
    Array.from({ length: 60 }, () => "港口与海防混在一起，帆影、船板和短对白一起推进局势，句子偏冷硬。").join("\n\n"),
    "utf8",
  );

  const rebuilt = await rebuildRagCollectionIndex({
    store,
    collectionId: collection.id,
  });
  assert.equal(rebuilt.index.sourceFiles.some((item) => item.encoding === "gb18030"), true);
  assert.ok(rebuilt.index.chunkCount > 0);

  const chunkRows = await store.readRagCollectionChunks(collection.id, []);
  assert.ok(chunkRows.some((item) => item.sourcePath === "gb18030_sample.txt" && item.text.includes("你好")));

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const projectState = await store.loadProject();
  await store.saveProject({
    ...projectState,
    project: {
      ...projectState.project,
      ragCollectionIds: [collection.id],
    },
  });

  const previousFetch = globalThis.fetch;
  let sawReferencePrompt = false;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (!sawReferencePrompt && instructions.includes("WriterAgent")) {
      sawReferencePrompt = true;
      assert.match(inputText, /范文参考包/);
      assert.match(inputText, /晚明海防范文/);
      assert.match(inputText, /海风、潮声、礁石/);
    }

    return previousFetch(url, options);
  };

  try {
    const writeRun = await runWriteChapterThroughOutline(store);
    assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
    assert.equal(sawReferencePrompt, true);

    const staged = await store.loadChapterDraft("ch001");
    assert.equal(staged.referencePacket?.triggered, true);
    assert.ok((staged.referencePacket?.matches || []).length > 0);
    assert.ok((staged.contextPackage?.selectedContext || []).some((item) => item.source.includes("runtime/rag_collections")));
    assert.ok(staged.referencePacket?.matches.every((item) => item.collectionId === collection.id));

    const perSource = new Map();
    for (const match of staged.referencePacket.matches || []) {
      const key = match.sourcePath;
      perSource.set(key, (perSource.get(key) || 0) + 1);
    }
    assert.ok([...perSource.values()].every((count) => count <= 2));

    const referencePacketPath = path.join(tempRoot, "runtime", "staging", "write", "ch001", "reference_packet.json");
    const referencePacket = JSON.parse(await fs.readFile(referencePacketPath, "utf8"));
    assert.equal(referencePacket.triggered, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
})));

test("embedding failure degrades to reference_packet fallback without blocking write", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-rag-fallback-"));
  const store = await createStore(tempRoot);

  const collection = await store.createRagCollection("失败回退范文库");
  await fs.writeFile(
    path.join(collection.sourceDir, "sample.md"),
    Array.from({ length: 40 }, () => "海风、船板和短对白一起把局势推紧。").join("\n\n"),
    "utf8",
  );
  await rebuildRagCollectionIndex({
    store,
    collectionId: collection.id,
  });

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const projectState = await store.loadProject();
  await store.saveProject({
    ...projectState,
    project: {
      ...projectState.project,
      ragCollectionIds: [collection.id],
    },
  });

  const previousFetch = globalThis.fetch;
  const previousFakeEmbeddings = process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS;
  process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS = "fail";
  globalThis.fetch = async (url, options = {}) => {
    if (String(url || "").includes("open.bigmodel.cn/api/paas/v4/embeddings")) {
      return new Response(JSON.stringify({ message: "embedding unavailable" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }
    return previousFetch(url, options);
  };

  try {
    const writeRun = await runWriteChapterThroughOutline(store);
    assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");

    const staged = await store.loadChapterDraft("ch001");
    assert.equal(staged.referencePacket?.mode, "embedding_failed");
    assert.match(staged.referencePacket?.summary || "", /范文检索失败|Zhipu embedding request failed/);
    assert.match(staged.chapterMarkdown || "", /李凡没有浪费任何时间/);
  } finally {
    if (previousFakeEmbeddings === undefined) {
      delete process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS;
    } else {
      process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS = previousFakeEmbeddings;
    }
    globalThis.fetch = previousFetch;
  }
})));

test("selected style fingerprints feed WriterAgent and prevent first chapter from overwriting the old style guide", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-style-integration-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const generated = await generateStyleFingerprint(store, {
    name: "冷峻近贴视角",
    sampleText: "海风裹着盐粒抽在脸上，礁岸尽头的火光忽明忽暗，像有人把刀背贴到了夜色里。李凡停住脚，先听，再动。",
  });
  const styleId = generated.metadata.id;
  const projectState = await store.loadProject();
  await store.saveProject({
    ...projectState,
    project: {
      ...projectState.project,
      styleFingerprintId: styleId,
    },
  });

  const previousFetch = globalThis.fetch;
  let sawWriterPrompt = false;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (!sawWriterPrompt && instructions.includes("WriterAgent")) {
      sawWriterPrompt = true;
      assert.match(inputText, /风格指南：\n# 风格指纹指令：冷峻近贴视角/);
      assert.match(inputText, /不要写成全知抒情旁白/);
    }

    return previousFetch(url, options);
  };

  try {
    await runWriteChapterThroughOutline(store);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const stagedDraft = await store.loadChapterDraft("ch001");
  assert.ok(
    stagedDraft.contextTrace.selectedDocuments.some((item) => item.source === `runtime/style_fingerprints/${styleId}/prompt.md`),
  );
  assert.ok(
    stagedDraft.contextTrace.promptInputs.some((item) => item.source === `runtime/style_fingerprints/${styleId}/prompt.md`),
  );
  assert.equal(sawWriterPrompt, true);

  await reviewChapter(store, {
    target: "chapter",
    approved: true,
    feedback: "",
  });

  const styleGuideText = await fs.readFile(path.join(tempRoot, "novel_state", "style_guide.md"), "utf8");
  assert.match(styleGuideText, /待第1章通过后生成/);
})));

test("ResearchRetriever uses MCP web search and passes research findings to WriterAgent", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-research-agent-"));
  saveFixtureWebSearchMcpConfig(tempRoot);
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  let sawResearchRetriever = false;
  let sawWriterResearchPrompt = false;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("ResearchRetriever")) {
      sawResearchRetriever = true;
      assert.equal(Array.isArray(payload.tools), false);
      assert.equal(Array.isArray(payload.include), false);
      assert.match(inputText, /MCP web_search 结果：/);
      assert.match(inputText, /明代海防研究资料/);
    }

    if (instructions.includes("WriterAgent") && !sawWriterResearchPrompt) {
      sawWriterResearchPrompt = true;
      assert.match(inputText, /研究资料包：/);
      assert.match(inputText, /军商混杂/);
      assert.match(inputText, /不要出现现代港务公司/);
      assert.match(inputText, /营汛：沿海驻防与汛地体系/);
    }

    return previousFetch(url, options);
  };

  try {
    const writeRun = await runWriteChapterThroughOutline(store);
    assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  const stagedDraft = await store.loadChapterDraft("ch001");
  assert.equal(sawResearchRetriever, true);
  assert.equal(sawWriterResearchPrompt, true);
  assert.equal(stagedDraft.researchPacket?.mode, "search_tool");
  assert.ok(Array.isArray(stagedDraft.researchPacket?.sources));
  assert.ok(stagedDraft.researchPacket.sources.length >= 1);
  assert.match(stagedDraft.researchPacket?.briefingMarkdown || "", /研究资料包/);
})));

test("ResearchRetriever falls back to provider web search when MCP web_search fails", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-research-provider-fallback-"));
  saveFixtureWebSearchMcpConfig(tempRoot, {
    mcp: {
      enabled: true,
      servers: {
        web_search: {
          enabled: true,
          transport: "stdio",
          command: process.execPath,
          args: [FIXTURE_RUNTIME_SERVER],
          startup_timeout_ms: 5000,
          call_timeout_ms: 5000,
          env: {
            FIXTURE_MODE: "crash",
            FIXTURE_TOOL_NAME: "web_search",
          },
        },
      },
    },
  });
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  let sawProviderFallbackRetriever = false;
  let sawFallbackSynthesizer = false;
  let sawWriterResearchPrompt = false;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("ResearchRetriever") && Array.isArray(payload.tools)) {
      sawProviderFallbackRetriever = true;
      assert.deepEqual(payload.tools, [{ type: "web_search" }]);
      assert.deepEqual(payload.include, ["web_search_call.action.sources"]);
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "provider web search 研究摘要：本章要写出军商混杂、港汛牵连的明末沿海秩序。",
          factsToUse: [
            "港口、船厂、巡检与营汛通常是缠在一起运作的，不是现代分工明确的港务系统。",
            "海商与地方军政关系复杂，既互用也互防。",
          ],
          factsToAvoid: [
            "不要出现现代港务公司、调度中心或安保系统等表达。",
          ],
          termBank: [
            "营汛：沿海驻防与汛地体系",
          ],
          uncertainPoints: [
            "具体官职细分仍需按地域继续核实。",
          ],
          sourceNotes: [
            "provider web_search 已返回可追溯来源。",
          ],
        }),
        output: [
          {
            content: [
              {
                type: "web_search_call",
                action: {
                  sources: [
                    {
                      title: "明代海防研究资料",
                      url: "https://example.com/provider-ming-haifang",
                      snippet: "沿海卫所、巡检与港口贸易互相交织。",
                    },
                    {
                      title: "福建海商与港口秩序",
                      url: "https://example.com/provider-fujian-port",
                      snippet: "海商网络与地方防务呈复杂共生关系。",
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
    }

    if (instructions.includes("ResearchSynthesizerAgent")) {
      sawFallbackSynthesizer = true;
      assert.match(inputText, /provider_web_search/);
      assert.match(inputText, /MCP web_search 不可用，已回退到 provider 级 web_search。/);
      return jsonResponse({
        output_text: JSON.stringify({
          summary: "本章港口与海防场景应写出军商混杂、港汛牵连的明末沿海质感。",
          factsToUse: [
            "港口、船厂、巡检和营汛彼此纠缠。",
            "海商与地方军政既交易又互相防备。",
          ],
          factsToAvoid: [
            "不要出现现代港务管理语言。",
          ],
          termBank: [
            "营汛：沿海驻防与汛地体系",
          ],
          uncertainPoints: [
            "具体官职层级仍需谨慎。",
          ],
          sourceNotes: [
            "MCP web_search 不可用，已回退到 provider 级 web_search。",
            "provider web_search 已返回可追溯来源。",
          ],
        }),
      });
    }

    if (instructions.includes("WriterAgent") && !sawWriterResearchPrompt) {
      sawWriterResearchPrompt = true;
      assert.match(inputText, /研究资料包：/);
      assert.match(inputText, /军商混杂/);
      assert.match(inputText, /营汛：沿海驻防与汛地体系/);
      assert.match(inputText, /MCP web_search 不可用，已回退到 provider 级 web_search。/);
    }

    return previousFetch(url, options);
  };

  try {
    const writeRun = await runWriteChapterThroughOutline(store);
    assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  const stagedDraft = await store.loadChapterDraft("ch001");
  assert.equal(sawProviderFallbackRetriever, true);
  assert.equal(sawFallbackSynthesizer, true);
  assert.equal(sawWriterResearchPrompt, true);
  assert.equal(stagedDraft.researchPacket?.mode, "provider_web_search");
  assert.ok(Array.isArray(stagedDraft.researchPacket?.sources));
  assert.ok(stagedDraft.researchPacket.sources.length >= 1);
  assert.match(
    (stagedDraft.researchPacket?.sourceNotes || []).join("；"),
    /provider 级 web_search|provider web_search/,
  );
})));

test("ResearchRetriever preserves MCP web search evidence when responses are forced to stream", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-research-agent-stream-"));
  saveFixtureWebSearchMcpConfig(tempRoot, {
    model_provider: "Compat",
    model: "compat-responses",
    review_model: "compat-responses",
    codex_model: "compat-responses",
    force_stream: true,
    disable_response_storage: true,
    model_providers: {
      Compat: {
        name: "Compat",
        base_url: "https://compat.example/v1",
        wire_api: "responses",
        api_key: "compat-key",
        response_model: "compat-responses",
        review_model: "compat-responses",
        codex_model: "compat-responses",
      },
      OpenAI: {
        name: "OpenAI",
        base_url: "https://capi.quan2go.com/openai",
        wire_api: "responses",
        api_key: "test-key",
        response_model: "gpt-5.4",
        review_model: "gpt-5.4",
        codex_model: "gpt-5.3-codex",
      },
    },
  });

  const store = await createStore(tempRoot);

  const previousFetch = globalThis.fetch;
  const openStreams = [];
  let sawStreamedResearchRetriever = false;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("ResearchRetriever")) {
      sawStreamedResearchRetriever = true;
      assert.equal(payload.stream, true);
      assert.equal(Array.isArray(payload.tools), false);
      assert.match(inputText, /MCP web_search 结果：/);
      const streamedRetrieverText = JSON.stringify({
        summary: "明末福建沿海场景应强调港口、船厂、巡检、营汛与海商网络的混杂秩序，避免现代港务和公司化表达。",
        factsToUse: [
          "港口与船厂往往和巡检、营汛、防务组织连在一起，不是现代化单一运营空间。",
          "海商势力与地方军政力量关系复杂，合作与戒备并存。",
        ],
        factsToAvoid: [
          "不要使用现代企业管理、码头调度中心、安保系统之类说法。",
          "不要把明末港口写成高度标准化的近代工业港。",
        ],
        termBank: [
          "营汛：沿海驻防与汛地体系",
          "巡检：基层巡防与缉查职责相关称呼",
        ],
        uncertainPoints: ["具体官职细分仍需按具体地域继续核实。"],
        sourceNotes: [
          "来源交叉提到沿海防务与海商网络并存。",
          "地方志和史料性文章都强调场景的军商混杂属性。",
        ],
      });

      const stream = hangingSseResponse(
        [
          "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_research_stream\",\"output\":[],\"output_text\":\"\"}}\n\n",
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: streamedRetrieverText })}\n\n`,
          "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_research_stream\",\"output\":[],\"output_text\":\"\"}}\n\n",
        ],
        "text/plain; charset=utf-8",
      );
      openStreams.push(stream);
      return stream.response;
    }

    if (payload.stream === true) {
      const baseResponse = await previousFetch(url, options);
      const basePayload = await baseResponse.json();
      const stream = hangingSseResponse(
        [
          "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_generic_stream\",\"output\":[],\"output_text\":\"\"}}\n\n",
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: String(basePayload.output_text || ""),
          })}\n\n`,
          "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_generic_stream\",\"output\":[],\"output_text\":\"\"}}\n\n",
        ],
        "text/plain; charset=utf-8",
      );
      openStreams.push(stream);
      return stream.response;
    }

    return previousFetch(url, options);
  };

  try {
    await runPlanDraft(store);
    await reviewPlanDraft(store, { approved: true, feedback: "" });
    await reviewPlanFinal(store, { approved: true, feedback: "" });
    const writeRun = await runWriteChapterThroughOutline(store);
    assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  } finally {
    for (const stream of openStreams) {
      stream.close();
    }
    globalThis.fetch = previousFetch;
  }

  const stagedDraft = await store.loadChapterDraft("ch001");
  assert.equal(sawStreamedResearchRetriever, true);
  assert.equal(stagedDraft.researchPacket?.mode, "search_tool");
  assert.ok(Array.isArray(stagedDraft.researchPacket?.sources));
  assert.equal(stagedDraft.researchPacket.sources.length, 2);
  assert.match(stagedDraft.researchPacket?.summary || "", /军商混杂|明末沿海/);
})));

test("ResearchPlannerAgent still runs for non-historical chapters", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-research-planner-all-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const projectState = await store.loadProject();
  await store.saveProject({
    ...projectState,
    project: {
      ...projectState.project,
      genre: "都市成长",
      setting: "现代沿海城市创业故事",
      researchNotes: "",
    },
  });

  const previousFetch = globalThis.fetch;
  let sawResearchPlanner = false;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");

    if (instructions.includes("ResearchPlannerAgent")) {
      sawResearchPlanner = true;
    }

    return previousFetch(url, options);
  };

  try {
    const writeRun = await runWriteChapterThroughOutline(store);
    assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(sawResearchPlanner, true);
})));

test("history context agents feed prior chapters into later WriterAgent runs", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-history-context-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  await runWriteChapterThroughOutline(store);
  await reviewChapter(store, { target: "chapter", approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  let sawHistorySelector = false;
  let sawHistoryDigest = false;
  let sawWriterPrompt = false;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("HistorySelectorAgent")) {
      sawHistorySelector = true;
    }
    if (instructions.includes("HistoryContextAgent")) {
      sawHistoryDigest = true;
    }
    if (!sawWriterPrompt && instructions.includes("WriterAgent")) {
      sawWriterPrompt = true;
      assert.match(inputText, /历史衔接摘要：/);
      assert.match(inputText, /ch001/);
      assert.match(inputText, /上一章把盘面抬高后的压力仍在延续/);
    }

    return previousFetch(url, options);
  };

  try {
    const writeRun = await runWriteChapterThroughOutline(store);
    assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  const stagedDraft = await store.loadChapterDraft("ch002");
  assert.equal(sawHistorySelector, true);
  assert.equal(sawHistoryDigest, true);
  assert.equal(sawWriterPrompt, true);
  assert.ok(stagedDraft.historyContext?.selectedFiles?.some((item) => item.id === "ch001"));
  assert.match(stagedDraft.historyContext?.briefingMarkdown || "", /ch001/);
  assert.match(stagedDraft.writerContext?.briefingMarkdown || "", /历史侧摘要/);
})));

test("history fallback consumes stored next_hook instead of summary text", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-history-hook-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  await runWriteChapterThroughOutline(store);
  const firstDraft = await store.loadChapterDraft("ch001");
  await reviewChapter(store, { target: "chapter", approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");

    if (instructions.includes("HistoryContextAgent")) {
      throw new Error("simulated history digest failure");
    }

    return previousFetch(url, options);
  };

  try {
    await runWriteChapterThroughOutline(store);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const secondDraft = await store.loadChapterDraft("ch002");
  assert.equal(secondDraft.historyContext.usedFallback, true);
  assert.ok(secondDraft.historyContext.openThreads.includes(firstDraft.chapterPlan.nextHook));
})));

test("runWriteChapter uses a dimension-driven audit orchestrator for chapter review", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-dimension-audit-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  let sawAuditOrchestrator = false;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");

    if (instructions.includes("AuditOrchestrator")) {
      sawAuditOrchestrator = true;
    }

    return previousFetch(url, options);
  };

  try {
    const writeRun = await runWriteChapterThroughOutline(store);
    const stagedDraft = await store.loadChapterDraft("ch001");
    assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
    assert.equal(sawAuditOrchestrator, true);
    assert.equal(typeof stagedDraft.validation?.score, "number");
    assert.equal(Array.isArray(stagedDraft.validation?.issues), true);
    assert.equal(Array.isArray(stagedDraft.validation?.activeDimensions), true);
    assert.ok(stagedDraft.validation?.activeDimensions?.some((item) => item.id === "outline_drift"));
    assert.ok(stagedDraft.validation?.activeDimensions?.some((item) => item.id === "chapter_pacing"));
  } finally {
    globalThis.fetch = previousFetch;
  }
})));

test("write run and audit results surface fallback usage instead of hiding it", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-fallback-visibility-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });
  await runWriteChapterThroughOutline(store);
  await reviewChapter(store, { target: "chapter", approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");

    if (
      instructions.includes("OutlineContextAgent") ||
      instructions.includes("HistorySelectorAgent") ||
      instructions.includes("HistoryContextAgent") ||
      instructions.includes("AuditOrchestrator")
    ) {
      throw new Error(`simulated failure for ${instructions}`);
    }

    return previousFetch(url, options);
  };

  let writeRun;
  try {
    writeRun = await runWriteChapterThroughOutline(store);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const stagedDraft = await store.loadChapterDraft("ch002");
  assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
  assert.ok(writeRun.run.steps.some((item) => /fallback|退回/.test(item.summary)));
  assert.equal(stagedDraft.planContext.usedFallback, true);
  assert.equal(stagedDraft.historyContext.usedFallback, true);
  assert.equal(stagedDraft.writerContext.usedFallback, true);
  assert.equal(stagedDraft.validation.auditDegraded, true);
  assert.equal(stagedDraft.validation.semanticAudit.source, "heuristics_only");
  assert.equal(stagedDraft.reviewState?.auditDegraded, true);
  assert.match(writeRun.run.steps.find((item) => item.id === "audit_orchestrator")?.summary || "", /仅依赖启发式审计/);
})));

test("runWriteChapter automatically repairs first-person drafts into third-person narration", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-style-repair-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  await reviewPlanDraft(store, { approved: true, feedback: "" });
  await reviewPlanFinal(store, { approved: true, feedback: "" });

  const previousFetch = globalThis.fetch;
  let initialWriterCalls = 0;
  let styleRepairCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("WriterAgent")) {
      if (/模式：style_repair/.test(inputText) || inputText.includes("待修正文：")) {
        styleRepairCalls += 1;
        return jsonResponse({
          output_text: [
            "李凡先看见顾骁按住刀柄，随后又看见郑芝龙把一箱盐票放上桌面。",
            "他没有急着开口，只顺着账册上的缺口往下查，把“李凡推进第1章的核心经营与扩张任务”和“郑芝龙带来新的资源与压力”都逼成了眼前的选择。",
            "等众人的呼吸一点点压紧，局势在第1章末尾进一步升级，连门外的风声都像是在催他把下一步走快。",
          ].join("\n"),
        });
      }

      initialWriterCalls += 1;
      return jsonResponse({
        output_text: [
          "我先看见顾骁把手按在刀柄上。",
          "我知道“李凡推进第1章的核心经营与扩张任务”已经压到了眼前，连“郑芝龙带来新的资源与压力”也一起涌了上来。",
          "我抬头的时候，局势在第1章末尾进一步升级。",
        ].join("\n"),
      });
    }

    return previousFetch(url, options);
  };

  try {
    const writeRun = await runWriteChapterThroughOutline(store);
    assert.equal(writeRun.project.phase.write.status, "chapter_pending_review");
    const stagedDraft = await store.loadChapterDraft("ch001");

    assert.ok(initialWriterCalls > 0);
    assert.ok(styleRepairCalls > 0);
    assert.ok(writeRun.run.steps.some((item) => item.id === "writer_style_repair"));

    const narrativeOnly = stagedDraft.chapterMarkdown.replace(/“[^”]*”/g, "");
    assert.ok(!/(^|[。！？\n])\s*我/g.test(narrativeOnly));
    assert.match(stagedDraft.chapterMarkdown, /李凡先看见顾骁按住刀柄/);
  } finally {
    globalThis.fetch = previousFetch;
  }
})));

test("plan draft approval rolls back cleanly when finalization fails", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-plan-rollback-"));
  const store = await createStore(tempRoot);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    if (instructions.includes("ForeshadowingPlannerAgent")) {
      throw new Error("simulated finalization failure");
    }
    return previousFetch(url, options);
  };

  try {
    await assert.rejects(
      () => runPlanDraft(store),
      /simulated finalization failure/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  const reloaded = await store.loadProject();
  assert.equal(reloaded.phase.plan.status, "idle");
  assert.equal(reloaded.phase.plan.pendingReview, null);
  assert.equal(await store.loadPlanFinal(), null);

  const planRuns = await store.listRuns("plan", 10);
  const failedRun = planRuns.find((run) => run.target === "plan_final" && run.status === "failed");
  assert.ok(failedRun);
  assert.equal(failedRun.error?.label, "ForeshadowingPlannerAgent");
  assert.match(failedRun.summary || "", /Plan Finalization 在 ForeshadowingPlannerAgent 失败/);
})));

test("plan finalization retries structure critique once even without retryRecommended", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-structure-critic-retry-"));
  const store = await createStore(tempRoot);

  const previousFetch = globalThis.fetch;
  let structureCriticCalls = 0;
  let failedOnce = false;
  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");

    if (instructions.includes("StructureCriticAgent")) {
      structureCriticCalls += 1;
      if (!failedOnce) {
        failedOnce = true;
        return jsonResponse({
          output_text: JSON.stringify({
            passed: false,
            retryRecommended: false,
            summary: "当前阶段主线仍然过散，需要收束。",
            issues: ["请把当前阶段收束为一条主链，并把关键转折的埋设提前。"],
            checks: [
              { name: "题材兑现", passed: true, detail: "题材没有跑偏。" },
              { name: "推进差异度", passed: false, detail: "多个转折并列争抢主线。" },
              { name: "钩子多样性", passed: true, detail: "钩子问题不明显。" },
              { name: "角色驱动", passed: false, detail: "关键推进仍需进一步聚焦。" },
            ],
          }),
        });
      }
    }

    return previousFetch(url, options);
  };

  try {
    const finalRun = await runPlanDraft(store);
    assert.equal(finalRun.project.phase.plan.status, "final_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(
    structureCriticCalls > 4,
    `expected StructureCriticAgent to be called more than 4 times, got ${structureCriticCalls}`,
  );
})));

test("plan draft approval auto-reruns draft revision when structure critique blocks finalization", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-structure-critic-reroute-"));
  const store = await createStore(tempRoot);

  const previousFetch = globalThis.fetch;
  let failedOnce = false;
  let rerouted = null;
  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (!failedOnce && instructions.includes("StructureCriticAgent") && inputText.includes("当前阶段：第 4 阶段")) {
      failedOnce = true;
      return jsonResponse({
        output_text: JSON.stringify({
          passed: false,
          retryRecommended: false,
          summary: "阶段4仍然需要回炉。",
          issues: [
            "把阶段4收束为财政/补给危机主链",
            "在阶段3尾补强黑盐票流通、制度副作用和海门地形伏笔",
          ],
          checks: [
            { name: "题材兑现", passed: true, detail: "题材方向正确。" },
            { name: "推进差异度", passed: false, detail: "阶段4并行主线过多。" },
            { name: "钩子多样性", passed: true, detail: "钩子并非主要问题。" },
            { name: "角色驱动", passed: false, detail: "关键对立需要进一步聚焦。" },
          ],
        }),
      });
    }

    return previousFetch(url, options);
  };

  try {
    rerouted = await runPlanDraft(store);
    assert.equal(rerouted.run.target, "plan_final");
    assert.equal(rerouted.project.phase.plan.status, "final_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  const reloaded = await store.loadProject();
  assert.equal(reloaded.phase.plan.status, "final_pending_review");
  const revisedDraft = await store.loadPlanDraft();
  assert.ok(revisedDraft.preApprovalCritics);

  const planRuns = await store.listRuns("plan", 10);
  const failedRun = planRuns.find((run) => run.target === "plan_final" && run.status === "failed");
  assert.equal(failedRun, undefined);
})));

test("plan run enters final review after two unresolved StructureCritic rounds", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-structure-critic-handoff-"));
  const store = await createStore(tempRoot);

  const previousFetch = globalThis.fetch;
  let stage4CriticCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("StructureCriticAgent") && inputText.includes("当前阶段：第 4 阶段")) {
      stage4CriticCalls += 1;
      return jsonResponse({
        output_text: JSON.stringify({
          passed: false,
          retryRecommended: false,
          summary: "阶段4主线仍需收束。",
          issues: [
            "把阶段4压回一条财政/补给危机主链",
            "提前埋下黑盐票兑现、授权副作用和海门地形的伏笔",
          ],
          checks: [
            { name: "题材兑现", passed: true, detail: "题材方向没有跑偏。" },
            { name: "推进差异度", passed: false, detail: "阶段4并行主线依然偏多。" },
            { name: "钩子多样性", passed: true, detail: "钩子不算重复。" },
            { name: "角色驱动", passed: false, detail: "最终对立还需要更聚焦。" },
          ],
        }),
      });
    }

    return previousFetch(url, options);
  };

  try {
    const finalRun = await runPlanDraft(store);
    assert.equal(finalRun.project.phase.plan.status, "final_pending_review");
    assert.match(finalRun.run.summary || "", /自动预审执行 2 轮后仍有残留问题/);
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(stage4CriticCalls >= 2, `expected stage 4 StructureCritic to run at least 2 times, got ${stage4CriticCalls}`);

  const stagedDraft = await store.loadPlanDraft();
  assert.equal(stagedDraft.preApprovalCritics.passed, false);
  assert.equal(stagedDraft.preApprovalCritics.autoRevisionExhausted, true);
  assert.ok(stagedDraft.preApprovalCritics.structureIssues.includes("把阶段4压回一条财政/补给危机主链"));

  const stagedFinal = await store.loadPlanFinal();
  assert.ok(stagedFinal);
})));

test("plan run enters final review after two unresolved final critic rounds", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-final-critic-handoff-"));
  const store = await createStore(tempRoot);

  const previousFetch = globalThis.fetch;
  let finalCriticACalls = 0;
  let finalCriticBCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");

    if (instructions.includes("你是 Novelex 的 CriticAgent_A。请像总编审稿一样，评估最终锁定大纲包")) {
      finalCriticACalls += 1;
      return jsonResponse({
        output_text: JSON.stringify({
          passed: false,
          score: 68,
          summary: "最终包仍缺少几处关键实场面承托。",
          issues: ["给税饷、护航、封港和夺硫黄补足对应实场面，避免中段制度议题悬空。"],
          checks: [
            { name: "结构可执行性", passed: false, detail: "中段落地场面不足。" },
            { name: "人物弧光", passed: true, detail: "人物关系线仍可追踪。" },
            { name: "世界约束", passed: true, detail: "世界约束整体可用。" },
            { name: "题材兑现", passed: true, detail: "题材承诺仍然成立。" },
          ],
        }),
      });
    }

    if (instructions.includes("你是 Novelex 的 CriticAgent_B。请采用逆向重建法评估最终锁定大纲包")) {
      finalCriticBCalls += 1;
      return jsonResponse({
        output_text: JSON.stringify({
          passed: false,
          score: 70,
          summary: "规模升级清晰，但中段兑现偏文案化。",
          reconstructedHook: "乱世海商借财政与补给危机逼出海上决战。",
          reconstructedSummary: "主角先借财政枢纽立足，再被裂盟与断供推向终局会战。",
          issues: ["把几处制度争执改成可视化的劫运、封港、撤运与反包围场面。"],
        }),
      });
    }

    return previousFetch(url, options);
  };

  try {
    const finalRun = await runPlanDraft(store);
    assert.equal(finalRun.project.phase.plan.status, "final_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(finalCriticACalls, 2);
  assert.equal(finalCriticBCalls, 2);

  const stagedDraft = await store.loadPlanDraft();
  assert.equal(stagedDraft.preApprovalCritics.passed, false);
  assert.equal(stagedDraft.preApprovalCritics.autoRevisionExhausted, true);
  assert.ok(stagedDraft.preApprovalCritics.issues.some((item) => /实场面|封港|劫运/.test(item)));
})));

test("plan finalization reuses cached artifacts after a later-step failure", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-plan-cache-reuse-"));
  const store = await createStore(tempRoot);

  const previousFetch = globalThis.fetch;
  const counts = {
    cast: 0,
    foreshadowing: 0,
    structure: 0,
    worldbuilding: 0,
    character: 0,
    outline: 0,
  };
  const originalStagePlanFinal = store.stagePlanFinal;
  let shouldFailStageOnce = true;

  store.stagePlanFinal = async (...args) => {
    if (shouldFailStageOnce) {
      shouldFailStageOnce = false;
      throw new Error("simulated final staging failure");
    }
    return originalStagePlanFinal(...args);
  };

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");

    if (instructions.includes("CastExpansionAgent")) {
      counts.cast += 1;
    } else if (instructions.includes("ForeshadowingPlannerAgent")) {
      counts.foreshadowing += 1;
    } else if (instructions.includes("StructureAgent")) {
      counts.structure += 1;
    } else if (instructions.includes("WorldbuildingAgent")) {
      counts.worldbuilding += 1;
    } else if (instructions.includes("CharacterAgent")) {
      counts.character += 1;
    } else if (instructions.includes("OutlineAgent")) {
      counts.outline += 1;
    }

    return previousFetch(url, options);
  };

  try {
    await assert.rejects(
      () => runPlanDraft(store),
      /simulated final staging failure/,
    );

    const snapshot = { ...counts };
    const finalRun = await runPlanDraft(store);
    assert.equal(finalRun.project.phase.plan.status, "final_pending_review");

    assert.equal(counts.cast - snapshot.cast, 0);
    assert.equal(counts.foreshadowing - snapshot.foreshadowing, 0);
    assert.equal(counts.structure - snapshot.structure, 0);
    assert.equal(counts.worldbuilding - snapshot.worldbuilding, 0);
    assert.equal(counts.character - snapshot.character, 0);
    assert.equal(counts.outline - snapshot.outline, 0);
  } finally {
    store.stagePlanFinal = originalStagePlanFinal;
    globalThis.fetch = previousFetch;
  }
})));

test("provider retries with a lean payload after repeated 5xx responses", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-provider-lean-"));
  const previousFetch = globalThis.fetch;

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://example.com";
  process.env.NOVELEX_PROVIDER_MODE = "openai-responses";

  const seenPayloads = [];
  let callCount = 0;

  globalThis.fetch = async (_url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    seenPayloads.push(payload);
    callCount += 1;

    if (callCount <= 5) {
      return new Response("Internal Server Error", {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    return jsonResponse({ output_text: "lean retry success" });
  };

  try {
    const provider = createProvider(
      {
        providerMode: "openai-responses",
        providerConfig: {
          responseModel: "gpt-5.4",
        },
      },
      { rootDir: tempRoot },
    );

    const result = await provider.generateText({
      instructions: "测试 provider 精简重试",
      input: "hello",
      tools: [{ type: "web_search" }],
      toolChoice: "auto",
      include: ["web_search_call.action.sources"],
      metadata: {
        feature: "provider_test",
      },
    });

    assert.equal(result.text, "lean retry success");
    assert.equal(callCount, 6);
    assert.ok("metadata" in seenPayloads[0]);
    assert.ok("reasoning" in seenPayloads[0]);
    assert.ok("store" in seenPayloads[0]);
    assert.ok(!("metadata" in seenPayloads.at(-1)));
    assert.ok(!("reasoning" in seenPayloads.at(-1)));
    assert.ok(!("store" in seenPayloads.at(-1)));
    assert.deepEqual(seenPayloads.at(-1).tools, [{ type: "web_search" }]);
    assert.equal(seenPayloads.at(-1).tool_choice, "auto");
    assert.deepEqual(seenPayloads.at(-1).include, ["web_search_call.action.sources"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("provider keeps retrying overloaded 529 responses beyond the standard attempt limit", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-provider-overload-success-"));
  const previousFetch = globalThis.fetch;

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://example.com";
  process.env.NOVELEX_PROVIDER_MODE = "openai-responses";

  let callCount = 0;

  globalThis.fetch = async () => {
    callCount += 1;

    if (callCount <= 6) {
      return new Response(JSON.stringify({
        type: "error",
        error: {
          type: "overloaded_error",
          message: "当前时段请求拥挤",
          http_code: "529",
        },
      }), {
        status: 529,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }

    return jsonResponse({ output_text: "overload retry success" });
  };

  try {
    const provider = createProvider(
      {
        providerMode: "openai-responses",
        providerConfig: {
          responseModel: "gpt-5.4",
        },
      },
      {
        rootDir: tempRoot,
        overloadRetryWindowMs: 200,
        overloadBaseDelayMs: 1,
        overloadMaxDelayMs: 1,
        overloadJitterRatio: 0,
      },
    );

    const result = await provider.generateText({
      instructions: "测试 overloaded 重试成功",
      input: "hello",
    });

    assert.equal(result.text, "overload retry success");
    assert.equal(callCount, 7);
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("provider stops overloaded retries once the overload window expires", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-provider-overload-deadline-"));
  const previousFetch = globalThis.fetch;

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://example.com";
  process.env.NOVELEX_PROVIDER_MODE = "openai-responses";

  let callCount = 0;

  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({
      type: "error",
      error: {
        type: "overloaded_error",
        message: "当前时段请求拥挤",
        http_code: "529",
      },
    }), {
      status: 529,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  };

  try {
    const provider = createProvider(
      {
        providerMode: "openai-responses",
        providerConfig: {
          responseModel: "gpt-5.4",
        },
      },
      {
        rootDir: tempRoot,
        overloadRetryWindowMs: 15,
        overloadBaseDelayMs: 10,
        overloadMaxDelayMs: 10,
        overloadJitterRatio: 0,
      },
    );

    await assert.rejects(
      provider.generateText({
        instructions: "测试 overloaded 截止窗口",
        input: "hello",
      }),
      (error) => {
        assert.equal(error?.overloaded, true);
        assert.match(String(error?.message || ""), /\b529\b/);
        return true;
      },
    );

    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("provider limits concurrent requests through a shared queue", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-provider-concurrency-limit-"));
  const previousFetch = globalThis.fetch;

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://example.com";
  process.env.NOVELEX_PROVIDER_MODE = "openai-responses";

  let activeRequests = 0;
  let maxActiveRequests = 0;
  let callCount = 0;

  globalThis.fetch = async (_url, _options = {}) => {
    callCount += 1;
    const currentCall = callCount;
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 15));
    activeRequests -= 1;
    return jsonResponse({ output_text: `queued-${currentCall}` });
  };

  try {
    const provider = createProvider(
      {
        providerMode: "openai-responses",
        providerConfig: {
          responseModel: "gpt-5.4",
        },
      },
      {
        rootDir: tempRoot,
        maxConcurrency: 1,
      },
    );

    const results = await Promise.all([
      provider.generateText({ instructions: "queue-a", input: "a" }),
      provider.generateText({ instructions: "queue-b", input: "b" }),
      provider.generateText({ instructions: "queue-c", input: "c" }),
    ]);

    assert.equal(results.length, 3);
    assert.equal(callCount, 3);
    assert.ok(
      maxActiveRequests <= 1,
      `expected provider concurrency to stay at 1 or below, got ${maxActiveRequests}`,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("provider retries without temperature when the model rejects that parameter", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-provider-temperature-"));
  const previousFetch = globalThis.fetch;

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://example.com";
  process.env.NOVELEX_PROVIDER_MODE = "openai-responses";

  const seenPayloads = [];
  let callCount = 0;

  globalThis.fetch = async (_url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    seenPayloads.push(payload);
    callCount += 1;

    if (callCount === 1) {
      return new Response(JSON.stringify({
        error: {
          message: "temperature is unsupported for this model",
        },
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }

    return jsonResponse({ output_text: "temperature retry success" });
  };

  try {
    const provider = createProvider(
      {
        providerMode: "openai-responses",
        providerConfig: {
          responseModel: "gpt-5.4",
        },
      },
      { rootDir: tempRoot },
    );

    const result = await provider.generateText({
      instructions: "测试 temperature 回退",
      input: "hello",
      temperature: 1.15,
    });

    assert.equal(result.text, "temperature retry success");
    assert.equal(callCount, 2);
    assert.equal(seenPayloads[0].temperature, 1.15);
    assert.ok(!Object.prototype.hasOwnProperty.call(seenPayloads[1], "temperature"));
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("responses providers stop reading once response.completed arrives even if the socket stays open", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-provider-stream-complete-"));
  const previousFetch = globalThis.fetch;

  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://capi.quan2go.com/openai";
  process.env.NOVELEX_PROVIDER_MODE = "openai-responses";

  const stream = hangingSseResponse(
    [
      "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_123\",\"output\":[],\"output_text\":\"\"}}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_123\",\"output\":[],\"output_text\":\"\"}}\n\n",
    ],
    "text/plain; charset=utf-8",
  );

  globalThis.fetch = async () => stream.response;

  try {
    const provider = createProvider(
      {
        providerMode: "openai-responses",
        providerConfig: {
          responseModel: "gpt-5.4",
          forceStream: true,
        },
      },
      { rootDir: tempRoot },
    );

    const result = await withTimeout(
      provider.generateText({
        instructions: "测试 response.completed 终止流",
        input: "hello",
      }),
      250,
      "provider did not resolve after response.completed",
    );

    assert.equal(result.text, "OK");
  } finally {
    stream.close();
    globalThis.fetch = previousFetch;
  }
}));

test("chat completion compatible providers still handle standard JSON responses", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-chat-provider-json-"));
  const previousFetch = globalThis.fetch;

  saveCodexApiConfig(tempRoot, {
    model_provider: "Compat",
    model: "compat-chat",
    review_model: "compat-chat",
    codex_model: "compat-chat",
    model_providers: {
      Compat: {
        name: "Compat",
        base_url: "https://compat.example/v1",
        wire_api: "chat_completions",
        api_key: "compat-key",
        response_model: "compat-chat",
        review_model: "compat-chat",
        codex_model: "compat-chat",
      },
    },
  });

  let seenUrl = "";
  let seenPayload = null;
  globalThis.fetch = async (url, options = {}) => {
    seenUrl = String(url || "");
    seenPayload = JSON.parse(String(options.body || "{}"));
    return jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello",
          },
        },
      ],
    });
  };

  try {
    const provider = createProvider({}, { rootDir: tempRoot });
    const result = await provider.generateText({
      instructions: "测试 chat completion JSON 响应",
      input: "hello",
    });

    assert.equal(result.text, "Hello");
    assert.equal(seenUrl, "https://compat.example/v1/chat/completions");
    assert.equal(seenPayload.model, "compat-chat");
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("plan finalization labels the exact CharacterAgent when one role generation fails", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-character-failure-"));
  const store = await createStore(tempRoot);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("CharacterAgent") && inputText.includes("角色名：顾骁")) {
      throw new Error("simulated character provider failure");
    }

    return previousFetch(url, options);
  };

  try {
    await assert.rejects(
      () => runPlanDraft(store),
      /CharacterAgent\(顾骁\) 失败：.*simulated character provider failure/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  const planRuns = await store.listRuns("plan", 10);
  const failedRun = planRuns.find((run) => run.target === "plan_final" && run.status === "failed");
  assert.ok(failedRun);
  assert.equal(failedRun.error?.label, "CharacterAgent(顾骁)");
  assert.match(failedRun.summary || "", /Plan Finalization 在 CharacterAgent\(顾骁\) 失败/);
})));

test("plan finalization throttles CharacterAgent concurrency", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-character-concurrency-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);

  const previousFetch = globalThis.fetch;
  let activeCharacterRequests = 0;
  let maxCharacterRequests = 0;

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");

    if (instructions.includes("CharacterAgent")) {
      activeCharacterRequests += 1;
      maxCharacterRequests = Math.max(maxCharacterRequests, activeCharacterRequests);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        return await previousFetch(url, options);
      } finally {
        activeCharacterRequests -= 1;
      }
    }

    return previousFetch(url, options);
  };

  try {
    const finalRun = await reviewPlanDraft(store, { approved: true, feedback: "" });
    assert.equal(finalRun.project.phase.plan.status, "final_pending_review");
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(
    maxCharacterRequests <= 2,
    `expected CharacterAgent concurrency to stay at 2 or below, got ${maxCharacterRequests}`,
  );
})));

test("plan finalization reuses successful CharacterAgent outputs after one role fails", async () => withIsolatedProviderEnv(async () => withStubbedOpenAI(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-character-cache-"));
  const store = await createStore(tempRoot);

  await runPlanDraft(store);
  const stagedDraft = await store.loadPlanDraft();
  const lastCharacterName = stagedDraft.cast.at(-1)?.name;
  assert.equal(lastCharacterName, "顾骁");

  const previousFetch = globalThis.fetch;
  const originalStagePlanFinalCacheEntry = store.stagePlanFinalCacheEntry;
  const characterCallCounts = {};
  let shouldFailCharacterCacheOnce = true;

  store.stagePlanFinalCacheEntry = async (entryName, payload) => {
    if (entryName === "characters/顾骁.json" && shouldFailCharacterCacheOnce) {
      shouldFailCharacterCacheOnce = false;
      throw new Error("simulated character cache write failure");
    }
    return originalStagePlanFinalCacheEntry(entryName, payload);
  };

  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    const instructions = String(payload.instructions || "");
    const inputText = extractInputText(payload.input);

    if (instructions.includes("CharacterAgent")) {
      const nameMatch = inputText.match(/角色名：(.+)/);
      const name = String(nameMatch?.[1] || "").trim();
      characterCallCounts[name] = (characterCallCounts[name] || 0) + 1;
    }

    return previousFetch(url, options);
  };

  try {
    await assert.rejects(
      () => runPlanDraft(store),
      /CharacterAgent\(顾骁\) 失败：.*simulated character cache write failure/,
    );

    const snapshot = { ...characterCallCounts };
    const finalRun = await runPlanDraft(store);
    assert.equal(finalRun.project.phase.plan.status, "final_pending_review");

    const retryDelta = (characterCallCounts[lastCharacterName] || 0) - (snapshot[lastCharacterName] || 0);
    assert.ok(retryDelta >= 1, `expected failed character ${lastCharacterName} to be retried`);

    for (const character of stagedDraft.cast) {
      const name = character.name;
      const delta = (characterCallCounts[name] || 0) - (snapshot[name] || 0);
      assert.ok(delta <= 1, `expected cached retry count for ${name} to stay at 1 or below, got ${delta}`);
    }
  } finally {
    store.stagePlanFinalCacheEntry = originalStagePlanFinalCacheEntry;
    globalThis.fetch = previousFetch;
  }
})));

test("dedicated codex config file is used as the primary provider source", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-config-"));
  await fs.writeFile(
    path.join(tempRoot, "novelex.codex.toml"),
    `
model_provider = "OpenAI"
model = "gpt-5.4"
review_model = "gpt-5.4"
codex_model = "gpt-5.3-codex"
model_reasoning_effort = "xhigh"
disable_response_storage = true
api_key = "test-key"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://capi.quan2go.com/openai"
wire_api = "responses"
requires_openai_auth = true
`,
    "utf8",
  );

  const settings = resolveProviderSettings(
    {
      providerMode: "openai-responses",
      providerConfig: {
        responseModel: "runtime-model",
        reviewModel: "runtime-review",
        codexResponseModel: "runtime-codex",
        reasoningEffort: "low",
      },
    },
    tempRoot,
  );

  assert.equal(settings.configSource, "codex_file");
  assert.equal(settings.configLoaded, true);
  assert.equal(settings.providerName, "OpenAI");
  assert.equal(settings.configuredMode, "openai-responses");
  assert.equal(settings.effectiveMode, "openai-responses");
  assert.equal(settings.responseModel, "gpt-5.4");
  assert.equal(settings.reviewModel, "gpt-5.4");
  assert.equal(settings.codexResponseModel, "gpt-5.3-codex");
  assert.equal(settings.reasoningEffort, "xhigh");
  assert.equal(settings.disableResponseStorage, true);
  assert.equal(settings.baseUrl, "https://capi.quan2go.com/openai");
  assert.equal(settings.hasApiKey, true);
  assert.equal(settings.availableProviders.length, 1);
}));

test("provider settings ignore unsupported Kimi entries but keep MiniMax from codex config", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-unsupported-provider-config-"));
  saveCodexApiConfig(tempRoot, {
    model_provider: "Kimi",
    model: "kimi-for-coding",
    review_model: "kimi-for-coding",
    codex_model: "kimi-for-coding",
    model_reasoning_effort: "medium",
    disable_response_storage: true,
    model_providers: {
      OpenAI: {
        name: "OpenAI",
        base_url: "https://openai.example/v1",
        wire_api: "responses",
        api_key: "openai-key",
        response_model: "gpt-5.4",
        review_model: "gpt-5.4",
        codex_model: "gpt-5.3-codex",
      },
      Kimi: {
        name: "Kimi",
        base_url: "https://api.kimi.com/coding/v1",
        wire_api: "chat_completions",
        api_key: "kimi-key",
        response_model: "kimi-for-coding",
        review_model: "kimi-for-coding",
        codex_model: "kimi-for-coding",
      },
      MiniMax: {
        name: "MiniMax",
        base_url: "https://api.minimaxi.com/v1",
        wire_api: "chat_completions",
        api_key: "minimax-key",
        response_model: "MiniMax-M2.5",
        review_model: "MiniMax-M2.5",
        codex_model: "MiniMax-M2.5",
      },
    },
  });

  const settings = resolveProviderSettings(
    {
      providerConfig: {
        responseModel: "runtime-model",
        reviewModel: "runtime-review",
        codexResponseModel: "runtime-codex",
      },
    },
    tempRoot,
  );

  assert.equal(settings.providerId, "OpenAI");
  assert.equal(settings.providerName, "OpenAI");
  assert.equal(settings.configuredMode, "openai-responses");
  assert.equal(settings.effectiveMode, "openai-responses");
  assert.equal(settings.baseUrl, "https://openai.example/v1");
  assert.equal(settings.responseModel, "gpt-5.4");
  assert.equal(settings.reviewModel, "gpt-5.4");
  assert.equal(settings.codexResponseModel, "gpt-5.3-codex");
  assert.equal(settings.hasApiKey, true);
  assert.deepEqual(
    settings.availableProviders.map((item) => item.id),
    ["OpenAI", "MiniMax"],
  );
}));

test("MiniMax provider settings default to a conservative max concurrency", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-minimax-max-concurrency-"));
  saveCodexApiConfig(tempRoot, {
    model_provider: "MiniMax",
    model: "MiniMax-M2.7",
    review_model: "MiniMax-M2.7",
    codex_model: "MiniMax-M2.7",
    model_providers: {
      MiniMax: {
        name: "MiniMax",
        base_url: "https://api.minimaxi.com/v1",
        wire_api: "chat_completions",
        api_key: "minimax-key",
        response_model: "MiniMax-M2.7",
        review_model: "MiniMax-M2.7",
        codex_model: "MiniMax-M2.7",
      },
    },
  });

  const settings = resolveProviderSettings({}, tempRoot);
  assert.equal(settings.providerId, "MiniMax");
  assert.equal(settings.maxConcurrency, 2);
  assert.equal(settings.requestTimeoutMs, 300000);
  assert.equal(settings.overloadRetryWindowMs, 1800000);
}));

test("MiniMax provider settings honor explicit timeout and retry-window overrides from config", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-minimax-timeout-config-"));
  saveCodexApiConfig(tempRoot, {
    model_provider: "MiniMax",
    model: "MiniMax-M2.7",
    review_model: "MiniMax-M2.7",
    codex_model: "MiniMax-M2.7",
    model_providers: {
      MiniMax: {
        name: "MiniMax",
        base_url: "https://api.minimaxi.com/v1",
        wire_api: "chat_completions",
        api_key: "minimax-key",
        response_model: "MiniMax-M2.7",
        review_model: "MiniMax-M2.7",
        codex_model: "MiniMax-M2.7",
        max_concurrency: 1,
        request_timeout_ms: 420000,
        overload_retry_window_ms: 2700000,
      },
    },
  });

  const settings = resolveProviderSettings({}, tempRoot);
  assert.equal(settings.providerId, "MiniMax");
  assert.equal(settings.maxConcurrency, 1);
  assert.equal(settings.requestTimeoutMs, 420000);
  assert.equal(settings.overloadRetryWindowMs, 2700000);
}));

test("Gemini provider settings use NovAI chat completions defaults", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-gemini-provider-config-"));
  saveCodexApiConfig(tempRoot, {
    model_provider: "Gemini",
    model_providers: {
      Gemini: {
        api_key: "novai-key",
      },
    },
  });

  const settings = resolveProviderSettings({}, tempRoot);
  assert.equal(settings.providerId, "Gemini");
  assert.equal(settings.providerName, "Gemini");
  assert.equal(settings.configuredMode, "openai-chat-completions");
  assert.equal(settings.effectiveMode, "openai-chat-completions");
  assert.equal(settings.apiStyle, "chat_completions");
  assert.equal(settings.baseUrl, "https://us.novaiapi.com/v1");
  assert.equal(settings.responseModel, "gemini-3.1-pro-preview");
  assert.equal(settings.reviewModel, "gemini-3.1-pro-preview");
  assert.equal(settings.codexResponseModel, "gemini-3.1-pro-preview");
  assert.equal(settings.maxConcurrency, 1);
  assert.equal(settings.requestTimeoutMs, 300000);
  assert.equal(settings.overloadRetryWindowMs, 1800000);
  assert.equal(settings.hasApiKey, true);
}));

test("MiniMax native web search is preferred when the active provider supports it", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-minimax-tool-provider-"));
  saveCodexApiConfig(tempRoot, {
    model_provider: "MiniMax",
    model: "MiniMax-M2.5-highspeed",
    review_model: "MiniMax-M2.5-highspeed",
    codex_model: "MiniMax-M2.5-highspeed",
    model_providers: {
      OpenAI: {
        name: "OpenAI",
        base_url: "https://openai.example/v1",
        wire_api: "responses",
        api_key: "openai-key",
        response_model: "gpt-5.4",
        review_model: "gpt-5.4",
        codex_model: "gpt-5.3-codex",
      },
      MiniMax: {
        name: "MiniMax",
        base_url: "https://api.minimaxi.com/v1",
        wire_api: "chat_completions",
        api_key: "minimax-key",
        response_model: "MiniMax-M2.5-highspeed",
        review_model: "MiniMax-M2.5-highspeed",
        codex_model: "MiniMax-M2.5-highspeed",
      },
    },
  });

  const previousFetch = globalThis.fetch;
  const seenCalls = [];
  let openAiCalled = false;

  globalThis.fetch = async (url, options = {}) => {
    const targetUrl = String(url || "");
    const payload = JSON.parse(String(options.body || "{}"));
    seenCalls.push({ targetUrl, payload });

    if (targetUrl === "https://api.minimaxi.com/v1/chat/completions" && Array.isArray(payload.plugins)) {
      return jsonResponse({
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "来自 MiniMax 原生搜索",
                factsToUse: ["港口与巡检体系紧密相连。"],
                factsToAvoid: ["不要写成现代化港务公司。"],
                termBank: ["营汛：沿海驻防体系"],
                uncertainPoints: ["具体官职仍需结合地区核实。"],
                sourceNotes: ["MiniMax 原生搜索已触发。"],
              }),
            },
          },
        ],
      });
    }

    if (
      targetUrl === "https://api.minimaxi.com/v1/chat/completions" &&
      Array.isArray(payload.tools) &&
      payload.tools.some((item) => item?.type === "web_search")
    ) {
      return jsonResponse({
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "plugin_web_search",
                    arguments: "{\"query_key\":\"明末福建沿海港口与海防术语\"}",
                  },
                },
              ],
            },
          },
        ],
      });
    }

    if (targetUrl === "https://openai.example/v1/responses") {
      openAiCalled = true;
      return jsonResponse({ output_text: "openai fallback" });
    }

    return previousFetch(url, options);
  };

  try {
    const provider = createProvider({}, { rootDir: tempRoot });
    const result = await provider.generateText({
      instructions: "test MiniMax native search",
      input: "请联网搜索并输出 JSON。",
      tools: [{ type: "web_search" }],
      toolChoice: "auto",
    });

    assert.match(result.text, /来自 MiniMax 原生搜索/);
    assert.equal(openAiCalled, false);
    assert.equal(result.raw?.native_web_search_requested, true);
    assert.ok(result.raw?.native_web_search_probe);
    assert.ok(
      seenCalls.some(
        (entry) =>
          entry.targetUrl === "https://api.minimaxi.com/v1/chat/completions" &&
          Array.isArray(entry.payload.plugins) &&
          entry.payload.plugins.includes("plugin_web_search"),
      ),
    );
    assert.ok(
      seenCalls.some(
        (entry) =>
          entry.targetUrl === "https://api.minimaxi.com/v1/chat/completions" &&
          Array.isArray(entry.payload.tools) &&
          entry.payload.tools.some((item) => item?.type === "web_search"),
      ),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("web search falls back to OpenAI GPT for providers without native search", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-tool-provider-"));
  saveCodexApiConfig(tempRoot, {
    model_provider: "Compat",
    model: "compat-chat",
    review_model: "compat-chat",
    codex_model: "compat-chat",
    model_providers: {
      OpenAI: {
        name: "OpenAI",
        base_url: "https://openai.example/v1",
        wire_api: "responses",
        api_key: "openai-key",
        response_model: "gpt-5.4",
        review_model: "gpt-5.4",
        codex_model: "gpt-5.3-codex",
      },
      Compat: {
        name: "Compat",
        base_url: "https://compat.example/v1",
        wire_api: "chat_completions",
        api_key: "compat-key",
        response_model: "compat-chat",
        review_model: "compat-chat",
        codex_model: "compat-chat",
      },
    },
  });

  const previousFetch = globalThis.fetch;
  let seenUrl = "";
  let seenPayload = null;
  globalThis.fetch = async (url, options = {}) => {
    seenUrl = String(url || "");
    seenPayload = JSON.parse(String(options.body || "{}"));
    return jsonResponse({ output_text: "search result" });
  };

  try {
    const provider = createProvider({}, { rootDir: tempRoot });
    const result = await provider.generateText({
      instructions: "test web search routing",
      input: "hello",
      tools: [{ type: "web_search" }],
      toolChoice: "auto",
      include: ["web_search_call.action.sources"],
    });

    assert.equal(result.text, "search result");
    assert.equal(seenUrl, "https://openai.example/v1/responses");
    assert.equal(seenPayload.model, "gpt-5.4");
    assert.deepEqual(seenPayload.tools, [{ type: "web_search" }]);
    assert.equal(seenPayload.tool_choice, "auto");
    assert.deepEqual(seenPayload.include, ["web_search_call.action.sources"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("zhipu embedding client can read zhipu_api_key from dedicated codex config file", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-zhipu-config-"));
  await fs.writeFile(
    path.join(tempRoot, "novelex.codex.toml"),
    `
zhipu_api_key = "zhipu-from-config"
`,
    "utf8",
  );

  const previousFetch = globalThis.fetch;
  let seenAuthHeader = "";
  globalThis.fetch = async (_url, options = {}) => {
    seenAuthHeader = String(options.headers?.Authorization || "");
    return jsonResponse({
      data: [
        {
          embedding: [0.1, 0.2, 0.3],
        },
      ],
    });
  };

  try {
    const client = createZhipuEmbeddingClient({ rootDir: tempRoot });
    assert.equal(client.isConfigured(), true);
    const vector = await client.embedText("测试");
    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
    assert.equal(seenAuthHeader, "Bearer zhipu-from-config");
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("zhipu embedding client accepts stringified embedding arrays", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-zhipu-string-vector-"));
  await fs.writeFile(
    path.join(tempRoot, "novelex.codex.toml"),
    `
zhipu_api_key = "zhipu-from-config"
`,
    "utf8",
  );

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: "embedding-3",
    object: "list",
    data: [
      {
        index: 0,
        object: "embedding",
        embedding: ["0.1", "0.2", "0.3"],
      },
    ],
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });

  try {
    const client = createZhipuEmbeddingClient({ rootDir: tempRoot });
    const vector = await client.embedText("测试");
    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("zhipu embedding client surfaces business errors returned in 200 responses", async () => withIsolatedProviderEnv(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-zhipu-business-error-"));
  await fs.writeFile(
    path.join(tempRoot, "novelex.codex.toml"),
    `
zhipu_api_key = "zhipu-from-config"
`,
    "utf8",
  );

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: "1213",
    msg: "quota exceeded",
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });

  try {
    const client = createZhipuEmbeddingClient({ rootDir: tempRoot });
    await assert.rejects(
      () => client.embedText("测试"),
      /quota exceeded/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("workspace supports multiple isolated projects", async () => withIsolatedProviderEnv(async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-workspace-"));

  const first = await createProjectWorkspace(workspaceRoot, "Alpha Project");
  const second = await createProjectWorkspace(workspaceRoot, "Beta Project");

  const firstStore = await createStore(first.root, { workspaceRoot });
  const secondStore = await createStore(second.root, { workspaceRoot });

  const firstState = await firstStore.loadProject();
  const secondState = await secondStore.loadProject();

  await firstStore.saveProject({
    ...firstState,
    project: {
      ...firstState.project,
      title: "Alpha Project",
      premise: "林澈在旧城废墟里追查一座失踪实验室留下的最后日志。",
    },
  });

  await secondStore.saveProject({
    ...secondState,
    project: {
      ...secondState.project,
      title: "Beta Project",
      premise: "顾衍在星际货运联盟的黑箱账本里发现了家族覆灭的源头。",
    },
  });

  const reloadedFirst = await firstStore.loadProject();
  const reloadedSecond = await secondStore.loadProject();
  const projects = await listProjects(workspaceRoot);

  assert.equal(reloadedFirst.project.title, "Alpha Project");
  assert.match(reloadedFirst.project.premise, /林澈/);
  assert.equal(reloadedSecond.project.title, "Beta Project");
  assert.match(reloadedSecond.project.premise, /顾衍/);
  assert.deepEqual(
    projects.map((project) => project.id).sort(),
    [first.id, second.id].sort(),
  );
}));

test("workspace can delete a project without affecting others", async () => withIsolatedProviderEnv(async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-delete-workspace-"));

  const first = await createProjectWorkspace(workspaceRoot, "Delete Me");
  const second = await createProjectWorkspace(workspaceRoot, "Keep Me");

  const firstStore = await createStore(first.root, { workspaceRoot });
  const secondStore = await createStore(second.root, { workspaceRoot });

  await firstStore.saveProject({
    ...(await firstStore.loadProject()),
    project: {
      ...(await firstStore.loadProject()).project,
      title: "Delete Me",
    },
  });

  await secondStore.saveProject({
    ...(await secondStore.loadProject()),
    project: {
      ...(await secondStore.loadProject()).project,
      title: "Keep Me",
    },
  });

  const deleted = await deleteProjectWorkspace(workspaceRoot, first.id);
  const projects = await listProjects(workspaceRoot);

  assert.equal(deleted, true);
  assert.deepEqual(projects.map((project) => project.id), [second.id]);
  assert.equal(projects[0].title, "Keep Me");
}));
