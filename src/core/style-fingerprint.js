import { countWordsApprox, createExcerpt } from "./text.js";

export const STYLE_FINGERPRINT_FIELDS = [
  ["perspective", "叙述视角与贴脸距离"],
  ["diction", "措辞与语域"],
  ["syntaxRhythm", "句式节奏"],
  ["rhetoricImagery", "修辞与意象"],
  ["dialogueHabits", "对白习惯"],
  ["emotionalTemperature", "情绪温度"],
  ["sceneMomentum", "场景推进"],
  ["chapterClosure", "章末收束"],
];

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeList(values, limit = 8) {
  return (Array.isArray(values) ? values : [])
    .map((item) => normalizeString(item))
    .filter(Boolean)
    .slice(0, limit);
}

export function buildStyleFingerprintStats(sampleText) {
  const normalized = normalizeString(sampleText).replace(/\r/g, "");
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    characterCount: normalized.length,
    paragraphCount: paragraphs.length,
    approxWordCount: countWordsApprox(normalized),
  };
}

export function normalizeStyleFingerprint(raw = {}) {
  return {
    perspective: normalizeString(raw.perspective),
    diction: normalizeString(raw.diction),
    syntaxRhythm: normalizeString(raw.syntaxRhythm),
    rhetoricImagery: normalizeString(raw.rhetoricImagery),
    dialogueHabits: normalizeString(raw.dialogueHabits),
    emotionalTemperature: normalizeString(raw.emotionalTemperature),
    sceneMomentum: normalizeString(raw.sceneMomentum),
    chapterClosure: normalizeString(raw.chapterClosure),
    prohibitions: normalizeList(raw.prohibitions, 10),
    recommendations: normalizeList(raw.recommendations, 10),
  };
}

export function buildStyleFingerprintSummary(name, fingerprint = {}) {
  const normalized = normalizeStyleFingerprint(fingerprint);
  const focus = [
    normalized.perspective,
    normalized.diction,
    normalized.syntaxRhythm,
    normalized.emotionalTemperature,
  ].filter(Boolean).join("；");
  return createExcerpt(`${name ? `${name}：` : ""}${focus}`, 180) || "已生成风格指纹。";
}

export function renderStyleFingerprintPrompt({ name = "", summary = "", fingerprint = {} }) {
  const normalized = normalizeStyleFingerprint(fingerprint);
  const sections = STYLE_FINGERPRINT_FIELDS
    .map(([key, label]) => normalized[key] ? `## ${label}\n- ${normalized[key]}` : "")
    .filter(Boolean);

  return [
    `# 风格指纹指令${name ? `：${name}` : ""}`,
    "",
    summary ? `> ${summary}` : "",
    summary ? "" : "",
    "请把以下风格要求当作章节正文生成阶段的写作基线。只输出小说正文，不解释提纲，不复述规则，不泄漏系统元信息。",
    "",
    ...sections,
    "## 建议执行",
    normalized.recommendations.length
      ? normalized.recommendations.map((item) => `- ${item}`).join("\n")
      : "- 保持风格稳定，把表达落到具体动作、对白、反应与场景推进上。",
    "",
    "## 明确禁忌",
    normalized.prohibitions.length
      ? normalized.prohibitions.map((item) => `- ${item}`).join("\n")
      : "- 不要写成提纲复述、解释性元话语或系统备注。",
  ].filter((line, index, array) => {
    if (line !== "") {
      return true;
    }
    return array[index - 1] !== "";
  }).join("\n");
}

export function buildStyleFingerprintId(name = "") {
  const slug = normalizeString(name)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return `style-${Date.now()}${slug ? `-${slug}` : ""}`;
}
