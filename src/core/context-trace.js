import { createExcerpt } from "./text.js";

function promptInput(name, source, summary) {
  const normalizedSummary = createExcerpt(summary || "", 220);
  if (!normalizedSummary) {
    return null;
  }

  return {
    name,
    source,
    summary: normalizedSummary,
  };
}

export function buildContextTrace({
  chapterPlan,
  chapterIntent,
  contextPackage,
  ruleStack,
  writerContext,
  historyPacket,
  researchPacket,
  referencePacket,
  openingReferencePacket,
  styleGuideText,
  styleGuideSourcePath,
}) {
  const chapterId = String(chapterPlan?.chapterId || chapterIntent?.chapterId || "").trim();
  const stagingBase = chapterId ? `runtime/staging/write/${chapterId}` : "runtime/staging/write";

  return {
    chapter: Number(chapterPlan?.chapterNumber || chapterIntent?.chapter || 0),
    chapterId,
    selectedDocuments: (contextPackage?.selectedContext || []).map((item) => ({
      source: item.source,
      reason: item.reason,
      excerpt: item.excerpt || "",
    })),
    promptInputs: [
      promptInput(
        "chapter_intent",
        `${stagingBase}/chapter_intent.json`,
        [
          `目标：${chapterIntent?.goal || ""}`,
          `mustKeep：${(chapterIntent?.mustKeep || []).join("；")}`,
          `mustAvoid：${(chapterIntent?.mustAvoid || []).join("；")}`,
        ].join(" "),
      ),
      promptInput(
        "rule_stack",
        `${stagingBase}/rule_stack.json`,
        [
          `hardFacts：${(ruleStack?.hardFacts || []).join("；")}`,
          `softGoals：${(ruleStack?.softGoals || []).join("；")}`,
          `deferRules：${(ruleStack?.deferRules || []).join("；")}`,
          `currentTask：${(ruleStack?.currentTask || []).join("；")}`,
        ].join(" "),
      ),
      promptInput(
        "context_package",
        `${stagingBase}/context_package.json`,
        (contextPackage?.selectedContext || [])
          .map((item) => `${item.source}:${item.reason}`)
          .join("；"),
      ),
      promptInput(
        "writer_context",
        `${stagingBase}/writer_context.json`,
        writerContext?.briefingMarkdown || "",
      ),
      promptInput(
        "history_context",
        `${stagingBase}/history_context.json`,
        historyPacket?.briefingMarkdown || historyPacket?.contextSummary || "",
      ),
      promptInput(
        "research_packet",
        `${stagingBase}/research_packet.json`,
        researchPacket?.briefingMarkdown || researchPacket?.summary || "",
      ),
      promptInput(
        "reference_packet",
        `${stagingBase}/reference_packet.json`,
        referencePacket?.briefingMarkdown || referencePacket?.summary || "",
      ),
      promptInput(
        "opening_reference_packet",
        `${stagingBase}/opening_reference_packet.json`,
        openingReferencePacket?.briefingMarkdown || openingReferencePacket?.summary || "",
      ),
      promptInput(
        "style_guide",
        styleGuideSourcePath || "novel_state/style_guide.md",
        styleGuideText || "",
      ),
    ].filter(Boolean),
    activeRules: {
      hardFacts: (ruleStack?.hardFacts || []).slice(0, 10),
      softGoals: (ruleStack?.softGoals || []).slice(0, 10),
      deferRules: (ruleStack?.deferRules || []).slice(0, 10),
      currentTask: (ruleStack?.currentTask || []).slice(0, 8),
    },
    researchSources: (researchPacket?.sources || [])
      .map((item) => ({
        title: String(item?.title || item?.url || "").trim(),
        url: String(item?.url || "").trim(),
        snippet: createExcerpt(item?.snippet || "", 140),
      }))
      .filter((item) => item.url),
    referenceSources: (referencePacket?.matches || [])
      .map((item) => ({
        title: `${String(item?.collectionName || item?.collectionId || "").trim()} / ${String(item?.sourcePath || "").trim()}`.trim(),
        source: `runtime/rag_collections/${String(item?.collectionId || "").trim()}/sources/${String(item?.sourcePath || "").trim()}`,
        excerpt: createExcerpt(item?.excerpt || item?.text || "", 140),
      }))
      .filter((item) => item.source),
    openingReferenceSources: (openingReferencePacket?.matches || [])
      .map((item) => ({
        title: `${String(item?.collectionName || item?.collectionId || "").trim()} / ${String(item?.sourcePath || "").trim()}`.trim(),
        source: `runtime/opening_collections/${String(item?.collectionId || "").trim()}/sources/${String(item?.sourcePath || "").trim()}`,
        excerpt: createExcerpt(item?.excerpt || item?.text || "", 140),
      }))
      .filter((item) => item.source),
    notes: (chapterIntent?.conflicts || [])
      .map((item) => String(item?.resolution || "").trim())
      .filter(Boolean),
  };
}
