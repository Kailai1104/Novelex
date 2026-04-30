import {
  chapterNumberFromId,
  countWordsApprox,
  createExcerpt,
  unique,
} from "./text.js";
import { missingRequiredNamedCharacters } from "./character-presence.js";

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function removeTitle(markdown = "") {
  return normalizeText(markdown)
    .replace(/^#.+\n+/, "")
    .trim();
}

function extractParagraphs(markdown = "") {
  return removeTitle(markdown)
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeParagraphKey(paragraph = "") {
  return paragraph
    .replace(/[“”"'`~!@#$%^&*()_\-+=[\]{}\\|;:,.<>/?！？。，、；：“”‘’（）《》【】\s]/g, "")
    .trim();
}

function createIssue(id, severity, category, description, evidence = "", suggestion = "") {
  return {
    id,
    severity,
    category,
    description: String(description || "").trim(),
    evidence: String(evidence || "").trim(),
    suggestion: String(suggestion || "").trim(),
    source: "heuristic",
  };
}

function normalizeStringList(values, limit = Infinity) {
  return unique((Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)).slice(0, limit);
}

function normalizeReplayComparableText(value = "") {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[“”"'`~!@#$%^&*()_\-+=[\]{}\\|;:,.<>/?！？。，、；：“”‘’（）《》【】\s]/g, "")
    .trim()
    .toLowerCase();
}

function stripDialogue(text = "") {
  return normalizeText(text)
    .replace(/“[^”]*”/g, "")
    .replace(/"[^"]*"/g, "");
}

function countMatches(text, pattern) {
  const matches = String(text || "").match(pattern);
  return matches ? matches.length : 0;
}

function median(values = []) {
  const numbers = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!numbers.length) {
    return 0;
  }
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 0
    ? (numbers[middle - 1] + numbers[middle]) / 2
    : numbers[middle];
}

function chapterMetrics(markdown = "") {
  const body = removeTitle(markdown);
  const paragraphs = extractParagraphs(markdown);
  const wordCount = countWordsApprox(body);
  const dialogueCount = countMatches(body, /“/g);
  const dialogueRatio = wordCount > 0 ? dialogueCount / wordCount : 0;
  const averageParagraphLength = paragraphs.length
    ? paragraphs.reduce((sum, paragraph) => sum + countWordsApprox(paragraph), 0) / paragraphs.length
    : 0;

  return {
    wordCount,
    paragraphCount: paragraphs.length,
    dialogueCount,
    dialogueRatio,
    averageParagraphLength,
  };
}

function formatWordCountEvidence(actualWords = 0, targetWords = 0) {
  if (targetWords <= 0) {
    return `当前约 ${actualWords} 字`;
  }
  const ratio = actualWords / targetWords;
  return `当前约 ${actualWords} 字，目标约 ${targetWords} 字，完成度约 ${Math.round(ratio * 100)}%`;
}

function detectChapterWordCount(project, markdown = "") {
  const targetWords = Number(project?.targetWordsPerChapter || 0);
  if (!Number.isFinite(targetWords) || targetWords <= 0) {
    return [];
  }

  const { wordCount } = chapterMetrics(markdown);
  if (wordCount <= 0) {
    return [];
  }

  const ratio = wordCount / targetWords;
  const criticalShortThreshold = Math.max(60, Math.min(120, Math.round(targetWords * 0.05)));

  if (wordCount < criticalShortThreshold) {
    return [createIssue(
      "chapter_word_count",
      "critical",
      "章节字数",
      "章节字数过短，正文承载量明显不足，容易导致关键事件、反应链和章末牵引无法真正落地。",
      formatWordCountEvidence(wordCount, targetWords),
      "补足至少一个关键事件的现场展开、人物反应与章末压力，让正文体量回到目标区间。",
    )];
  }
  if (ratio > 2.2) {
    return [createIssue(
      "chapter_word_count",
      "critical",
      "章节字数",
      "章节字数明显高于目标，单章体量失控，容易带来注水、重复推进或节奏拖沓。",
      formatWordCountEvidence(wordCount, targetWords),
      "合并重复推进的段落，把次要铺陈前移或后移，收紧到本章真正必须完成的事件链。",
    )];
  }
  if (ratio < 0.45) {
    return [createIssue(
      "chapter_word_count",
      "warning",
      "章节字数",
      "章节字数低于目标区间，可能会让本章推进显得偏薄。",
      formatWordCountEvidence(wordCount, targetWords),
      "适当补足现场动作、人物反应或章末牵引，让本章更饱满。",
    )];
  }
  if (ratio > 1.5) {
    return [createIssue(
      "chapter_word_count",
      "warning",
      "章节字数",
      "章节字数高于目标区间，需留意本章是否出现拖沓或重复推进。",
      formatWordCountEvidence(wordCount, targetWords),
      "检查是否有可压缩的概述段、重复试探或可并入下一章的铺陈。",
    )];
  }

  return [];
}

function firstPersonNarrationEvidence(markdown = "") {
  const paragraphs = extractParagraphs(markdown);
  const evidence = [];

  for (const paragraph of paragraphs) {
    const stripped = stripDialogue(paragraph);
    if (!stripped) {
      continue;
    }
    if (
      /(^|[。！？；，、\s])(我|我们)(?!们?说|想说|问|答|道|喊|笑|叫|觉得你|知道你)/.test(stripped) &&
      /(看见|听见|闻到|想到|意识到|伸手|转身|低头|抬头|只能|忽然|立刻|先|还没)/.test(stripped)
    ) {
      evidence.push(createExcerpt(paragraph, 90));
    }
  }

  return unique(evidence).slice(0, 3);
}

function detectMetaLeaks(markdown = "") {
  const body = removeTitle(markdown);
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const matched = [];
  const patterns = [
    /本章将/,
    /这一章里/,
    /接下来(他|她|他们|故事)/,
    /写作备注/,
    /人工修订重点/,
    /修订补笔/,
    /^##+\s*场景/,
    /^场景\d+[：:]/,
    /系统元信息/,
  ];

  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) {
      matched.push(line);
    }
  }

  return unique(matched).slice(0, 3);
}

function detectRepeatedParagraphs(markdown = "") {
  const paragraphs = extractParagraphs(markdown).filter((item) => countWordsApprox(item) >= 70);
  const seen = new Map();
  const duplicates = [];

  for (const paragraph of paragraphs) {
    const key = normalizeParagraphKey(paragraph);
    if (key.length < 50) {
      continue;
    }
    if (seen.has(key)) {
      duplicates.push(createExcerpt(paragraph, 110));
      continue;
    }
    seen.set(key, paragraph);
  }

  return unique(duplicates).slice(0, 2);
}

const CHAPTER_REPLAY_PATTERNS = [
  {
    id: "impact",
    pattern: /方向盘|刹车|车灯|白灯|轮胎|玻璃炸碎|撞来|撞上|惊醒|醒了|睁开眼|睁眼|呛醒|咳醒|炮震|炮声|耳鸣/u,
  },
  {
    id: "survival",
    pattern: /甲板|桅杆|风浪|海水|咸水|木船|船身|唐鹞|炮门|右舷|铜山|岸影/u,
  },
  {
    id: "setup",
    pattern: /崇祯|通敌|嫌疑|林定海|马会魁|先砍|丢海里|那盏灯|老规矩|昨夜/u,
  },
  {
    id: "verification",
    pattern: /不是船底|不是龙骨|右舷那扇炮门|右舷腰间|两三浪|水涨慢了|横摇一模一样|先把那扇炮门关上/u,
  },
];

const CARRYOVER_REPLAY_SIGNAL_DEFINITIONS = [
  {
    id: "lin_dinghai_first_aid",
    resolvedText: "李凡已对林定海做第一轮勒脉止血，只能承接伤情后果，不可重新完整演止血",
    hintPatterns: [/林定海/u, /止血|勒脉|绞标|扎紧|包扎/u],
    detectionPatterns: [/林定海/u, /血|伤口|血脉/u, /止血|勒脉|绞标|扎紧|包扎/u, /麻布|布条|缠|按住|撕下/u],
    minPatternMatches: 3,
    category: "既定事实连续性",
    description: "章节开头把上一章已经完成的急救止血重新写成了本章首次事件。",
    suggestion: "上一章已完成第一轮止血；本章只能承接伤情后果、后续固定或伤势升级，不能重新完整演一遍止血过程。",
  },
  {
    id: "draft_black_cargo_discovery",
    resolvedText: "许三娘已指出吃水线异常与底舱重物，只能推进查验/揭晓，不可重新完整演发现过程",
    hintPatterns: [/许三娘/u, /吃水|水线/u, /黑货|底舱|重物|盐袋/u],
    detectionPatterns: [/许三娘/u, /吃水|水线|船身压得太低|压得深/u, /黑货|底舱|重物|盐袋/u, /盯着|看准|算死|掀开|查验/u],
    minPatternMatches: 3,
    category: "既定事实连续性",
    description: "章节开头把上一章已经完成的黑货判断重新写成了本章首次发现。",
    suggestion: "上一章已指出吃水线异常与底舱重物；本章只能推进查验、开舱或揭晓，不可重新完整演一遍发现与判断过程。",
  },
];

function detectRepeatedChapterReplay(markdown = "") {
  const paragraphs = extractParagraphs(markdown);
  if (paragraphs.length < 8) {
    return null;
  }

  const paragraphSignals = paragraphs.map((paragraph, index) => ({
    index,
    text: paragraph,
    groups: CHAPTER_REPLAY_PATTERNS
      .filter(({ pattern }) => pattern.test(paragraph))
      .map(({ id }) => id),
  }));

  function collapseSignals(items = []) {
    const clusters = [];
    for (const item of items) {
      const window = {
        start: item.index,
        end: item.index,
        groups: [...item.groups],
        excerpt: createExcerpt(item.text, 120),
      };
      const previous = clusters.at(-1);
      if (previous && window.start <= previous.end + 2) {
        previous.end = window.end;
        previous.groups = unique([...previous.groups, ...window.groups]);
        continue;
      }
      clusters.push(window);
    }
    return clusters;
  }

  const restartClusters = collapseSignals(
    paragraphSignals.filter((item) =>
      item.groups.includes("impact") || item.groups.includes("survival")),
  )
    .filter((cluster) =>
      cluster.groups.includes("impact") && cluster.groups.includes("survival"));
  const setupClusters = collapseSignals(
    paragraphSignals.filter((item) => item.groups.includes("setup")),
  );
  const verificationClusters = collapseSignals(
    paragraphSignals.filter((item) => item.groups.includes("verification")),
  );

  const hasReplayGap = (clusters = []) =>
    clusters.length >= 2 && clusters.at(-1).start >= clusters[0].start + 4;

  const repeatedRestart = hasReplayGap(restartClusters);
  const repeatedSetup = hasReplayGap(setupClusters);
  const repeatedVerification = hasReplayGap(verificationClusters);

  if (
    !(repeatedRestart && repeatedSetup) &&
    !(repeatedRestart && repeatedVerification) &&
    !(repeatedSetup && repeatedVerification)
  ) {
    return null;
  }

  const evidence = [];
  const reasons = [];

  if (repeatedRestart) {
    reasons.push("同章内出现了不止一次“冷启动开场/重新进入险局”的片段。");
    evidence.push(restartClusters[0].excerpt, restartClusters.at(-1).excerpt);
  }

  if (repeatedSetup) {
    reasons.push("同一初始困局被重新建立，像又从开头把人物关系和指控重演了一遍。");
    evidence.push(setupClusters[0].excerpt, setupClusters.at(-1).excerpt);
  }

  if (repeatedVerification) {
    reasons.push("同一条核心验证链被重新演了一遍，像把另一版正文又接进来了。");
    evidence.push(verificationClusters[0].excerpt, verificationClusters.at(-1).excerpt);
  }

  return {
    reasons,
    evidence: unique(evidence).slice(0, 3),
  };
}

function countPatternMatches(text = "", patterns = []) {
  return patterns.reduce((count, pattern) => (pattern.test(text) ? count + 1 : count), 0);
}

function resolveCarryoverReplayDefinitions(factContext = null, resolvedCarryoverBeats = []) {
  const hints = normalizeReplayComparableText([
    ...normalizeStringList(resolvedCarryoverBeats, 6),
    ...((factContext?.openTensions || []).flatMap((item) => [item?.subject, item?.assertion])),
    ...((factContext?.establishedFacts || []).flatMap((item) => [item?.subject, item?.assertion])),
  ].join("\n"));

  return CARRYOVER_REPLAY_SIGNAL_DEFINITIONS.filter((definition) => {
    if (!hints) {
      return false;
    }
    return definition.hintPatterns.some((pattern) => pattern.test(hints));
  });
}

function detectCarryoverReplay(markdown = "", factContext = null, resolvedCarryoverBeats = []) {
  const definitions = resolveCarryoverReplayDefinitions(factContext, resolvedCarryoverBeats);
  if (!definitions.length) {
    return [];
  }

  const openingParagraphs = extractParagraphs(markdown).slice(0, 4);
  const issues = [];

  for (const definition of definitions) {
    const evidence = openingParagraphs
      .filter((paragraph) => countPatternMatches(paragraph, definition.detectionPatterns) >= definition.minPatternMatches)
      .map((paragraph) => createExcerpt(paragraph, 120))
      .slice(0, 2);

    if (!evidence.length) {
      continue;
    }

    issues.push(createIssue(
      "carryover_replay",
      "critical",
      definition.category,
      definition.description,
      evidence.join(" / "),
      definition.suggestion,
    ));
  }

  return issues;
}

function detectSummaryHeavyPacing(markdown = "") {
  const body = removeTitle(markdown);
  const paragraphs = extractParagraphs(markdown);
  const metrics = chapterMetrics(markdown);
  const summaryCueCount = countMatches(body, /(很快|随后|接着|片刻后|不多时|最终|总之|意味着|显然|某种程度上)/g);
  const longParagraphs = paragraphs.filter((item) => countWordsApprox(item) >= 260);

  return {
    metrics,
    summaryCueCount,
    longParagraphCount: longParagraphs.length,
    evidence: longParagraphs.slice(0, 2).map((item) => createExcerpt(item, 100)),
  };
}

function classifyOpening(text = "") {
  const excerpt = createExcerpt(removeTitle(text), 140);
  if (/猛地|惊醒|咳醒|睁开眼|醒来/.test(excerpt)) {
    return "惊醒开场";
  }
  if (/脚步|喊声|爆炸|风浪|追兵|传令|血/.test(excerpt)) {
    return "危机压场";
  }
  if (/盘点|清点|核对|商议|议定|分派/.test(excerpt)) {
    return "事务开场";
  }
  if (/对话|说道|开口/.test(excerpt)) {
    return "对话开场";
  }
  return "其他开场";
}

function classifyEnding(text = "") {
  const paragraphs = extractParagraphs(text);
  const tail = createExcerpt(paragraphs.at(-1) || removeTitle(text), 140);
  if (/必须|只能|守|掠|抉择|选择|下一步/.test(tail)) {
    return "抉择收束";
  }
  if (/帆影|线索|异样|来人|发现|动静/.test(tail)) {
    return "发现收束";
  }
  if (/逼近|追来|围剿|风暴|危机|倒计时/.test(tail)) {
    return "压力收束";
  }
  if (/决裂|沉默|翻脸|关系|对视/.test(tail)) {
    return "关系收束";
  }
  if (/真相|回收|兑现|揭开/.test(tail)) {
    return "回收收束";
  }
  return "其他收束";
}

function classifyTone(tone = "") {
  const value = String(tone || "").trim();
  if (!value) {
    return "未知情绪";
  }
  if (/惊|惧|压抑|紧张|恐/.test(value)) {
    return "高压情绪";
  }
  if (/冷|硬|克制|肃杀/.test(value)) {
    return "冷硬情绪";
  }
  if (/悲|痛|哀|沉/.test(value)) {
    return "低沉情绪";
  }
  if (/昂扬|振奋|痛快|热/.test(value)) {
    return "高扬情绪";
  }
  return value;
}

function buildSequenceSnapshot(recentChapters = [], currentChapter = null) {
  const sequence = [...recentChapters];
  if (currentChapter) {
    sequence.push(currentChapter);
  }

  return sequence.map((item) => ({
    chapterId: item.chapterId,
    title: item.title,
    openingType: classifyOpening(item.markdown || ""),
    endingType: classifyEnding(item.markdown || ""),
    toneType: classifyTone(item.emotionalTone || ""),
  }));
}

function detectSequenceMonotony(sequenceSnapshot = []) {
  const recent = sequenceSnapshot.slice(-3);
  if (recent.length < 3) {
    return [];
  }

  const issues = [];
  const endingTypes = recent.map((item) => item.endingType);
  const openingTypes = recent.map((item) => item.openingType);
  const toneTypes = recent.map((item) => item.toneType);

  if (new Set(endingTypes).size === 1 && endingTypes[0] !== "其他收束") {
    issues.push(createIssue(
      "sequence_monotony",
      "warning",
      "节奏单调",
      `最近三章连续使用同一种章末模式：${endingTypes[0]}。`,
      recent.map((item) => `${item.chapterId}:${item.endingType}`).join(" / "),
      "下一章优先换一种收束方式，例如把“发现新线索”改成关系反压、局势逼近或代价落地。",
    ));
  }

  if (new Set(toneTypes).size === 1 && toneTypes[0] !== "未知情绪") {
    issues.push(createIssue(
      "sequence_monotony",
      "warning",
      "节奏单调",
      `最近三章情绪底色过于一致：${toneTypes[0]}。`,
      recent.map((item) => `${item.chapterId}:${item.toneType}`).join(" / "),
      "下一章给情绪曲线加入反差，至少让压迫、释放、反打中的一种出现明显变化。",
    ));
  }

  if (new Set(openingTypes).size === 1 && openingTypes[0] !== "其他开场") {
    issues.push(createIssue(
      "sequence_monotony",
      "info",
      "节奏单调",
      `最近三章开场手法重复：${openingTypes[0]}。`,
      recent.map((item) => `${item.chapterId}:${item.openingType}`).join(" / "),
      "下一章可以改成对话切入、结果先行或局势切面，避免固定开场模板。",
    ));
  }

  return issues;
}

function detectStyleDrift(recentChapters = [], currentMarkdown = "") {
  if (!recentChapters.length) {
    return [];
  }

  const baseline = recentChapters.map((item) => chapterMetrics(item.markdown || ""));
  const current = chapterMetrics(currentMarkdown);
  const baselineDialogueRatio = median(baseline.map((item) => item.dialogueRatio));
  const baselineParagraphLength = median(baseline.map((item) => item.averageParagraphLength));

  const issues = [];
  const dialogueRatioDelta = baselineDialogueRatio > 0
    ? Math.abs(current.dialogueRatio - baselineDialogueRatio) / baselineDialogueRatio
    : 0;
  const paragraphDelta = baselineParagraphLength > 0
    ? Math.abs(current.averageParagraphLength - baselineParagraphLength) / baselineParagraphLength
    : 0;

  if (
    baselineDialogueRatio > 0.004 &&
    dialogueRatioDelta >= 0.85 &&
    Math.abs(current.dialogueRatio - baselineDialogueRatio) >= 0.01
  ) {
    issues.push(createIssue(
      "style_drift",
      "warning",
      "风格漂移",
      "当前章对白密度与最近已锁定章节偏差过大，读感可能脱离既有风格节奏。",
      `当前=${current.dialogueRatio.toFixed(4)}，基线=${baselineDialogueRatio.toFixed(4)}`,
      "回看最近已锁定章节的对白/叙述配比，避免突然变成大段说明或纯对白推进。",
    ));
  }

  if (
    baselineParagraphLength > 60 &&
    paragraphDelta >= 0.6 &&
    Math.abs(current.averageParagraphLength - baselineParagraphLength) >= 45
  ) {
    issues.push(createIssue(
      "style_drift",
      "warning",
      "风格漂移",
      "当前章平均段长与最近章节基线偏差明显，段落节奏可能失真。",
      `当前=${current.averageParagraphLength.toFixed(1)}，基线=${baselineParagraphLength.toFixed(1)}`,
      "把过长概述段拆成动作、对白和即时反应，让段落节奏回到既有风格区间。",
    ));
  }

  return issues;
}

function detectResearchAccuracy(markdown = "", researchPacket = null) {
  if (!researchPacket?.triggered) {
    return [];
  }

  const body = removeTitle(markdown);
  const issues = [];
  const avoids = Array.isArray(researchPacket?.factsToAvoid) ? researchPacket.factsToAvoid : [];

  for (const item of avoids) {
    const text = String(item || "").trim();
    if (!text || text.length < 6) {
      continue;
    }
    if (body.includes(text)) {
      issues.push(createIssue(
        "research_accuracy",
        "critical",
        "考据准确",
        "正文直接出现了研究资料包明确要求避免的表述。",
        createExcerpt(text, 80),
        "按研究资料包改写相关事实，或把断言改成角色视角内的猜测与传闻。",
      ));
    }
  }

  return issues.slice(0, 2);
}

function staleForeshadowings(registry = null, currentChapterNumber = 0) {
  return (Array.isArray(registry?.foreshadowings) ? registry.foreshadowings : [])
    .filter((item) => String(item?.status || "").trim() !== "resolved")
    .map((item) => {
      const lastTouchedChapter = chapterNumberFromId(
        item?.last_touched_chapter ||
        item?.planted_chapter ||
        item?.planned_plant_chapter,
      );
      const chaptersSinceTouch = currentChapterNumber > 0 && lastTouchedChapter > 0
        ? currentChapterNumber - lastTouchedChapter
        : 0;
      const nextWaterAt = (Array.isArray(item?.waterAt) ? item.waterAt : [])
        .find((chapter) => Number(chapter) >= currentChapterNumber) || null;
      const missedWaterAt = (Array.isArray(item?.waterAt) ? item.waterAt : [])
        .filter((chapter) => Number(chapter) < currentChapterNumber)
        .at(-1) || null;

      return {
        id: String(item?.id || "").trim(),
        description: String(item?.description || "").trim(),
        status: String(item?.status || "").trim(),
        intendedPayoffChapter: Number(item?.intended_payoff_chapter || 0),
        nextWaterAt: nextWaterAt ? Number(nextWaterAt) : null,
        missedWaterAt: missedWaterAt ? Number(missedWaterAt) : null,
        chaptersSinceTouch,
      };
    })
    .filter((item) => item.id);
}

function detectSubplotStagnation(registry = null, currentChapterNumber = 0) {
  const staleItems = staleForeshadowings(registry, currentChapterNumber)
    .filter((item) => item.status === "planted" || item.status === "watered");
  if (!staleItems.length) {
    return {
      issues: [],
      staleItems: [],
    };
  }

  const criticalItems = staleItems.filter(
    (item) =>
      item.intendedPayoffChapter > 0 &&
      item.intendedPayoffChapter - currentChapterNumber <= 2 &&
      item.chaptersSinceTouch >= 6,
  );
  const warningItems = staleItems.filter(
    (item) =>
      item.chaptersSinceTouch >= 6 ||
      (item.missedWaterAt && item.missedWaterAt <= currentChapterNumber - 1),
  );

  const issues = [];
  if (criticalItems.length) {
    issues.push(createIssue(
      "subplot_stagnation",
      "critical",
      "支线停滞",
      `存在接近回收节点却久未推进的旧伏笔：${criticalItems.map((item) => item.id).join("、")}。`,
      criticalItems
        .slice(0, 3)
        .map((item) => `${item.id} 已 ${item.chaptersSinceTouch} 章未触碰，目标回收章=${item.intendedPayoffChapter}`)
        .join(" / "),
      "下一章优先让这些旧债产生可见推进，不要继续只提压力而不兑现具体动作。",
    ));
  } else if (warningItems.length) {
    issues.push(createIssue(
      "subplot_stagnation",
      "warning",
      "支线停滞",
      `存在长期只挂着不推进的旧伏笔：${warningItems.map((item) => item.id).join("、")}。`,
      warningItems
        .slice(0, 3)
        .map((item) => `${item.id} 已 ${item.chaptersSinceTouch} 章未触碰`)
        .join(" / "),
      "下一章至少推进其中一条，让读者看到状态变化，而不是重复提醒它存在。",
    ));
  }

  return {
    issues,
    staleItems: warningItems.slice(0, 5),
  };
}

export function runAuditHeuristics({
  project,
  chapterPlan,
  chapterDraft,
  researchPacket,
  foreshadowingRegistry,
  recentChapters = [],
  factContext = null,
  resolvedCarryoverBeats = [],
}) {
  const markdown = chapterDraft?.markdown || "";
  const issues = [];
  const missingNamedCharacters = missingRequiredNamedCharacters(chapterPlan, markdown);

  if (missingNamedCharacters.length) {
    issues.push(createIssue(
      "outline_drift",
      "critical",
      "大纲偏移",
      `细纲要求登场的具名角色未在正文中实际出场：${missingNamedCharacters.join("、")}。`,
      `计划登场=${(chapterPlan?.charactersPresent || []).join("、") || "无"} / 正文缺失=${missingNamedCharacters.join("、")}`,
      "把缺席角色写进对应 scene 的动作、对白或站位反应里，不要再用无名功能角色替代其剧情职责。",
    ));
  }

  const metaLeakEvidence = detectMetaLeaks(markdown);
  if (metaLeakEvidence.length) {
    issues.push(createIssue(
      "meta_leak",
      "critical",
      "元信息泄漏",
      "正文出现了提纲式元话语、场景标题或写作备注痕迹。",
      metaLeakEvidence.join(" / "),
      "删除元信息句式，把说明改写成动作、对白或现场反应。",
    ));
  }

  const firstPersonEvidence = firstPersonNarrationEvidence(markdown);
  if (firstPersonEvidence.length >= 2) {
    issues.push(createIssue(
      "pov_consistency",
      firstPersonEvidence.length >= 3 ? "critical" : "warning",
      "视角一致性",
      "正文叙述视角偏向第一人称，未稳定保持第三人称有限视角。",
      firstPersonEvidence.join(" / "),
      "保留对白中的“我”，但把旁白叙述改回“李凡看见/听见/想到”这类有限视角表达。",
    ));
  }

  const repeatedParagraphEvidence = detectRepeatedParagraphs(markdown);
  if (repeatedParagraphEvidence.length) {
    issues.push(createIssue(
      "chapter_pacing",
      "critical",
      "单章节奏",
      "章节存在明显重复段落或草稿拼接痕迹，推进感会被严重稀释。",
      repeatedParagraphEvidence.join(" / "),
      "删除重复版本，只保留一条最清晰的事件链，并重接前后因果。",
    ));
  }

  const replayEvidence = detectRepeatedChapterReplay(markdown);
  if (replayEvidence) {
    issues.push(createIssue(
      "chapter_restart_replay",
      "critical",
      "单章节奏",
      "章节疑似把多个版本或多次重启的正文串在了一起，时间线被反复拉回开场状态。",
      replayEvidence.evidence.join(" / "),
      "只保留一条完整事件链，删除重复开场、重复建立初始困局和重复验证段落。",
    ));
  }

  issues.push(...detectCarryoverReplay(markdown, factContext, resolvedCarryoverBeats));

  const pacingSignals = detectSummaryHeavyPacing(markdown);
  if (
    !repeatedParagraphEvidence.length &&
    pacingSignals.metrics.wordCount >= 1200 &&
    pacingSignals.longParagraphCount >= 3 &&
    pacingSignals.summaryCueCount >= 6
  ) {
    issues.push(createIssue(
      "chapter_pacing",
      "warning",
      "单章节奏",
      "当前章概述性段落偏多，可能出现空转或“讲过去了”而不是“演出来了”的问题。",
      pacingSignals.evidence.join(" / ") || `概述信号=${pacingSignals.summaryCueCount}`,
      "把至少一两个长概述段拆成现场动作、对白和即时反应。",
    ));
  }

  issues.push(...detectResearchAccuracy(markdown, researchPacket));
  issues.push(...detectStyleDrift(recentChapters, markdown));
  issues.push(...detectChapterWordCount(project, markdown));

  const sequenceSnapshot = buildSequenceSnapshot(recentChapters, {
    chapterId: chapterPlan?.chapterId || "current",
    title: chapterPlan?.title || "当前章",
    markdown,
    emotionalTone: chapterPlan?.emotionalTone || "",
  });
  issues.push(...detectSequenceMonotony(sequenceSnapshot));

  const subplotSignals = detectSubplotStagnation(
    foreshadowingRegistry,
    Number(chapterPlan?.chapterNumber || 0),
  );
  issues.push(...subplotSignals.issues);

  return {
    issues,
    metrics: chapterMetrics(markdown),
    sequenceSnapshot,
    staleForeshadowings: subplotSignals.staleItems,
  };
}
