import path from "node:path";

import {
  chapterNumberFromId,
  createExcerpt,
  extractJsonObject,
  safeJsonParse,
  unique,
} from "../core/text.js";

function buildQueryText(chapterPlan) {
  return [
    chapterPlan.chapterId,
    chapterPlan.title,
    chapterPlan.stage,
    chapterPlan.location,
    ...chapterPlan.keyEvents,
    ...chapterPlan.charactersPresent,
    ...chapterPlan.continuityAnchors,
    chapterPlan.nextHook,
  ]
    .filter(Boolean)
    .join(" ");
}

function describeChapterMeta(meta) {
  return [
    `章节标题：${meta.title}`,
    `摘要：${meta.summary_200 || meta.summary_50 || "无摘要"}`,
    `人物：${(meta.characters_present || []).join("、") || "无"}`,
    `事件：${(meta.key_events || []).join(" / ") || "无"}`,
    `连续性锚点：${(meta.continuity_anchors || []).join(" / ") || "无"}`,
  ].join("；");
}

async function buildCandidateFiles(store, chapterMetas) {
  const candidates = [];

  const fixedCandidates = [
    {
      id: "style_guide",
      kind: "document",
      path: path.join("novel_state", "style_guide.md"),
      name: "风格指南",
      description: "记录已锁定章节沉淀出的文风、句式密度、叙事节奏与禁忌写法。适合检索写作风格约束。",
    },
    {
      id: "world_state",
      kind: "document",
      path: path.join("novel_state", "world_state.json"),
      name: "世界状态",
      description: "记录当前故事时间、主要地点、近期事件和接下来的剧情锚点。适合检索宏观连续性。",
    },
    {
      id: "foreshadowing_registry",
      kind: "document",
      path: path.join("novel_state", "foreshadowing_registry.json"),
      name: "伏笔注册表",
      description: "记录已计划、已埋下、待回收的伏笔及其章节分布。适合检索伏笔任务。",
    },
  ];

  for (const candidate of fixedCandidates) {
    const absolutePath = path.join(store.paths.rootDir, candidate.path);
    if (await store.exists(absolutePath)) {
      candidates.push(candidate);
    }
  }

  for (const meta of chapterMetas) {
    candidates.push({
      id: meta.chapter_id,
      kind: "chapter_meta",
      path: path.join("novel_state", "chapters", `${meta.chapter_id}_meta.json`),
      companionPath: path.join("novel_state", "chapters", `${meta.chapter_id}.md`),
      name: `${meta.chapter_id} ${meta.title}`,
      description: describeChapterMeta(meta),
      meta,
    });
  }

  return candidates;
}

async function chooseFilesWithAgent(provider, queryText, candidates) {
  if (!candidates.length) {
    return [];
  }

  const result = await provider.generateText({
    instructions:
      "你是 Novelex 的 FileRetrievalAgent。你只能根据候选文件的文件名和描述做选择。请选出对当前章节写作最有帮助的 1 到 4 个文件。只输出 JSON，不要解释。",
    input: [
      `当前检索需求：${queryText}`,
      "候选文件：",
      ...candidates.map(
        (candidate) =>
          `- id=${candidate.id} | path=${candidate.path} | name=${candidate.name} | description=${candidate.description}`,
      ),
      `请输出 JSON：
{
  "selectedIds": ["文件id1", "文件id2"],
  "reasons": {
    "文件id1": "为什么相关",
    "文件id2": "为什么相关"
  }
}`,
    ].join("\n"),
  });

  const parsed = safeJsonParse(extractJsonObject(result.text), null);
  if (!parsed || !Array.isArray(parsed.selectedIds) || !parsed.selectedIds.length) {
    throw new Error(`FileRetrievalAgent 返回了无效结果：${createExcerpt(result.text || "", 240)}`);
  }

  const reasons = parsed.reasons && typeof parsed.reasons === "object" ? parsed.reasons : {};
  return parsed.selectedIds
    .map((id, index) => ({
      id: String(id || "").trim(),
      order: index,
      rationale: String(reasons[id] || "文件名与描述和当前章节需求相关。").trim(),
    }))
    .filter((item) => item.id);
}

function selectedFilesFromChoices(candidates, choices) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return choices
    .map((choice) => {
      const candidate = byId.get(choice.id);
      if (!candidate) {
        return null;
      }
      return {
        ...candidate,
        retrieval_rationale: choice.rationale,
        retrieval_score:
          typeof choice.score === "number"
            ? Number(choice.score.toFixed(4))
            : Number(Math.max(0.2, 1 - choice.order * 0.15).toFixed(4)),
      };
    })
    .filter(Boolean);
}

async function loadCandidateContext(store, candidate) {
  const absolutePath = path.join(store.paths.rootDir, candidate.path);

  if (candidate.kind === "document" && candidate.path.endsWith(".md")) {
    const content = await store.readText(absolutePath, "");
    return createExcerpt(content, 280);
  }

  if (candidate.kind === "document" && candidate.path.endsWith(".json")) {
    const content = await store.readJson(absolutePath, null);
    return createExcerpt(JSON.stringify(content || {}, null, 2), 280);
  }

  if (candidate.kind === "chapter_meta") {
    const meta = await store.readJson(absolutePath, candidate.meta || null);
    const chapterMarkdown = candidate.companionPath
      ? await store.readText(path.join(store.paths.rootDir, candidate.companionPath), "")
      : "";

    const summary = [
      meta?.summary_200 || meta?.summary_50 || "",
      (meta?.key_events || []).length ? `关键事件：${meta.key_events.join("；")}` : "",
      (meta?.continuity_anchors || []).length
        ? `连续性锚点：${meta.continuity_anchors.join("；")}`
        : "",
      chapterMarkdown ? `正文片段：${createExcerpt(chapterMarkdown, 140)}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    return createExcerpt(summary, 320);
  }

  return "";
}

export async function filesystemHistoryLookup({
  store,
  provider,
  chapterPlan,
  chapterMetas,
}) {
  const queryText = buildQueryText(chapterPlan);
  const candidates = await buildCandidateFiles(store, chapterMetas);

  if (!candidates.length) {
    return {
      queryText: createExcerpt(queryText, 220),
      relatedChapters: [],
      selectedFiles: [],
      continuityAnchors: [],
      lastEnding: "上一章节的余波还在。",
      retrievalMode: "filesystem-llm",
      catalogStats: {
        totalFiles: 0,
        selected: 0,
      },
      contextSummary: "当前没有可检索的历史文件。",
    };
  }

  const llmChoices = await chooseFilesWithAgent(provider, queryText, candidates);
  const selectedFiles = selectedFilesFromChoices(candidates, llmChoices.slice(0, 4));

  const hydratedFiles = await Promise.all(
    selectedFiles.map(async (item) => ({
      ...item,
      context_excerpt: await loadCandidateContext(store, item),
    })),
  );

  const relatedChapters = hydratedFiles
    .filter((item) => item.kind === "chapter_meta" && item.meta)
    .map((item) => ({
      ...item.meta,
      retrieval_score: item.retrieval_score,
      retrieval_rationale: item.retrieval_rationale,
      file_path: item.path,
      file_description: item.description,
      context_excerpt: item.context_excerpt,
    }));

  const continuityAnchors = unique(
    relatedChapters.flatMap((meta) => meta.continuity_anchors || []),
  ).slice(0, 8);
  const previousMeta = chapterMetas.at(-1);
  const latestRelatedChapter = [...relatedChapters].sort(
    (left, right) => chapterNumberFromId(right.chapter_id) - chapterNumberFromId(left.chapter_id),
  )[0];
  const contextSummary = hydratedFiles.length
    ? hydratedFiles
        .map((item) => `${item.name}：${item.context_excerpt || item.description}`)
        .join(" | ")
    : "未挑选到显著相关的历史文件。";

  return {
    queryText: createExcerpt(queryText, 220),
    relatedChapters,
    selectedFiles: hydratedFiles.map((item) => ({
      id: item.id,
      kind: item.kind,
      path: item.path,
      name: item.name,
      description: item.description,
      retrieval_score: item.retrieval_score,
      retrieval_rationale: item.retrieval_rationale,
      context_excerpt: item.context_excerpt,
    })),
    continuityAnchors,
    lastEnding:
      latestRelatedChapter?.summary_50 || previousMeta?.summary_50 || "上一章节的余波还在。",
    retrievalMode: "filesystem-llm",
    catalogStats: {
      totalFiles: candidates.length,
      selected: hydratedFiles.length,
    },
    contextSummary,
  };
}
