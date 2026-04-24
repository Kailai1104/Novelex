import { normalizeStyleFingerprint, buildStyleFingerprintId, buildStyleFingerprintStats, buildStyleFingerprintSummary, renderStyleFingerprintPrompt } from "../core/style-fingerprint.js";
import { createExcerpt, extractJsonObject, nowIso, safeJsonParse } from "../core/text.js";
import { createProvider } from "../llm/provider.js";

function parseAgentJson(result) {
  const parsed = safeJsonParse(extractJsonObject(result?.text || ""), null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`StyleFingerprintAgent 返回了无法解析的 JSON：${createExcerpt(result?.text || "", 240)}`);
  }
  return parsed;
}

async function runStyleFingerprintAgent(provider, { name, sampleText }) {
  const result = await provider.generateText({
    agentComplexity: "simple",
    instructions: [
      "你是 Novelex 的 StyleFingerprintAgent。",
      "你的任务是读取一篇范文，抽取它在写作层面的稳定风格特征，并输出结构化 JSON。",
      "不要改写范文，不要给创作建议解释过程，不要注入世界观、题材套路或大纲内容。",
      "只分析文本风格本身，尤其关注叙述距离、措辞、句式、修辞、对白、情绪、场景推进与章末收束。",
    ].join(" "),
    input: [
      `风格名称：${name}`,
      "请阅读下面的范文，并输出 JSON：",
      sampleText,
      `JSON 结构必须是：
{
  "perspective": "叙述视角与贴脸距离",
  "diction": "措辞与语域",
  "syntaxRhythm": "句式节奏",
  "rhetoricImagery": "修辞与意象",
  "dialogueHabits": "对白习惯",
  "emotionalTemperature": "情绪温度",
  "sceneMomentum": "场景推进",
  "chapterClosure": "章末收束",
  "prohibitions": ["禁止项1", "禁止项2"],
  "recommendations": ["建议项1", "建议项2"]
}`,
    ].join("\n\n"),
    metadata: {
      feature: "style_fingerprint_generation",
    },
  });

  return normalizeStyleFingerprint(parseAgentJson(result));
}

export async function generateStyleFingerprint(store, { name, sampleText }) {
  const normalizedName = String(name || "").trim();
  const normalizedSample = String(sampleText || "").trim();
  if (!normalizedName) {
    throw new Error("风格名称不能为空。");
  }
  if (!normalizedSample) {
    throw new Error("范文不能为空。");
  }

  const projectState = await store.loadProject();
  const provider = createProvider(projectState, { rootDir: store.paths.configRootDir });
  const fingerprint = await runStyleFingerprintAgent(provider, {
    name: normalizedName,
    sampleText: normalizedSample,
  });
  const summary = buildStyleFingerprintSummary(normalizedName, fingerprint);
  const now = nowIso();
  const metadata = {
    id: buildStyleFingerprintId(normalizedName),
    name: normalizedName,
    summary,
    createdAt: now,
    updatedAt: now,
    stats: buildStyleFingerprintStats(normalizedSample),
  };
  const promptMarkdown = renderStyleFingerprintPrompt({
    name: normalizedName,
    summary,
    fingerprint,
  });

  await store.saveStyleFingerprint({
    metadata,
    sampleMarkdown: normalizedSample,
    fingerprint,
    promptMarkdown,
  });

  return {
    metadata,
    sampleMarkdown: normalizedSample,
    fingerprint,
    promptMarkdown,
  };
}
