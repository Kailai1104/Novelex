import { generateStructuredObject } from "../llm/structured.js";

const GENERIC_CHARACTER_PATTERNS = [
  /^众/u,
  /^群/u,
  /^诸/u,
  /^若干/u,
  /^无名/u,
  /^(水手|船员|海盗|官兵|士兵|军士|百姓|流民|弟兄|手下|喽啰|护卫|亲兵)$/u,
  /(水手|船员|海盗|官兵|士兵|军士|百姓|流民|弟兄|手下|喽啰|护卫|亲兵)$/u,
];

function unique(values = []) {
  return [...new Set(values)];
}

export function isGenericCharacterLabel(name = "") {
  const normalized = String(name || "").trim();
  if (!normalized) {
    return true;
  }
  return GENERIC_CHARACTER_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function requiredNamedCharacters(chapterPlan = null) {
  return unique((Array.isArray(chapterPlan?.charactersPresent) ? chapterPlan.charactersPresent : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean))
    .filter((name) => !isGenericCharacterLabel(name));
}

export function characterAppearsInText(markdown = "", name = "") {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    return false;
  }
  return String(markdown || "").includes(normalizedName);
}

export function missingRequiredNamedCharacters(chapterPlan = null, markdown = "") {
  return requiredNamedCharacters(chapterPlan)
    .filter((name) => !characterAppearsInText(markdown, name));
}

export function realizedCharactersPresent(chapterPlan = null, markdown = "") {
  return unique((Array.isArray(chapterPlan?.charactersPresent) ? chapterPlan.charactersPresent : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .filter((name) => isGenericCharacterLabel(name) || characterAppearsInText(markdown, name)));
}

export function requiredCharactersConstraint(chapterPlan = null) {
  const names = requiredNamedCharacters(chapterPlan);
  return names.length
    ? `本章必须让以下具名角色在正文中实际出场或被直接点名：${names.join("、")}`
    : "";
}

export async function analyzeCharacterPresence({
  provider,
  project = null,
  chapterPlan = null,
  markdown = "",
}) {
  const plannedCharacters = unique((Array.isArray(chapterPlan?.charactersPresent) ? chapterPlan.charactersPresent : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean));
  const namedCharacters = requiredNamedCharacters(chapterPlan);

  if (!plannedCharacters.length) {
    return {
      source: "agent",
      plannedCharacters,
      namedCharacters,
      charactersPresent: [],
      missingRequiredCharacters: [],
      mentions: [],
      summary: "当前章纲未声明登场角色。",
    };
  }

  const normalized = await generateStructuredObject(provider, {
    label: "CharacterPresenceAgent",
    instructions:
      "你是 Novelex 的 CharacterPresenceAgent。你的任务是判断章节正文里，哪些计划角色真的出场或被明确点名，哪些只是泛称、擦边提及或根本没出现。必须严格以正文为准，只输出 JSON。",
    input: [
      `作品：${project?.title || "未命名作品"}`,
      `章节：${chapterPlan?.chapterId || ""} ${chapterPlan?.title || ""}`,
      `计划登场角色：${plannedCharacters.join("、")}`,
      `必须具名出场角色：${namedCharacters.join("、") || "无"}`,
      `正文全文：\n${String(markdown || "")}`,
      `请输出 JSON：
{
  "summary": "一句总结",
  "charactersPresent": ["正文里真正出场或被明确点名的角色"],
  "missingRequiredCharacters": ["计划要求但正文里未真实出场的具名角色"],
  "mentions": [
    {
      "name": "角色名",
      "present": true,
      "directlyNamed": true,
      "evidence": "短证据",
      "reason": "为什么判定为出场或未出场"
    }
  ]
}`,
    ].join("\n\n"),
    useReviewModel: true,
    metadata: {
      feature: "character_presence",
      chapterId: chapterPlan?.chapterId || "",
    },
    normalize(parsed) {
      const charactersPresent = unique((Array.isArray(parsed.charactersPresent) ? parsed.charactersPresent : [])
        .map((name) => String(name || "").trim())
        .filter((name) => plannedCharacters.includes(name)));
      const missingRequiredCharacters = unique((Array.isArray(parsed.missingRequiredCharacters) ? parsed.missingRequiredCharacters : [])
        .map((name) => String(name || "").trim())
        .filter((name) => namedCharacters.includes(name)));
      const mentionMap = new Map();
      for (const item of Array.isArray(parsed.mentions) ? parsed.mentions : []) {
        const name = String(item?.name || "").trim();
        if (!name || !plannedCharacters.includes(name)) {
          continue;
        }
        mentionMap.set(name, {
          name,
          present: Boolean(item?.present),
          directlyNamed: Boolean(item?.directlyNamed),
          evidence: String(item?.evidence || "").trim(),
          reason: String(item?.reason || "").trim(),
        });
      }

      const reconciledPresent = unique([
        ...charactersPresent,
        ...plannedCharacters.filter((name) => mentionMap.get(name)?.present),
      ]);
      const reconciledMissing = unique([
        ...missingRequiredCharacters,
        ...namedCharacters.filter((name) => mentionMap.get(name)?.present === false),
      ]).filter((name) => !reconciledPresent.includes(name));

      return {
        source: "agent",
        summary: String(parsed.summary || "").trim(),
        plannedCharacters,
        namedCharacters,
        charactersPresent: reconciledPresent,
        missingRequiredCharacters: reconciledMissing,
        mentions: plannedCharacters
          .map((name) => mentionMap.get(name) || {
            name,
            present: reconciledPresent.includes(name),
            directlyNamed: reconciledPresent.includes(name) && !isGenericCharacterLabel(name),
            evidence: "",
            reason: "",
          }),
      };
    },
  });

  return normalized;
}
