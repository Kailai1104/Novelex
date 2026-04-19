const STOP_WORDS = new Set([
  "一个",
  "一种",
  "以及",
  "为了",
  "因为",
  "但是",
  "这个",
  "那个",
  "自己",
  "他们",
  "我们",
  "故事",
  "小说",
  "主角",
  "阶段",
  "章节",
  "当前",
  "进行",
  "需要",
]);

export function nowIso() {
  return new Date().toISOString();
}

export function chapterIdFromNumber(number) {
  return `ch${String(number).padStart(3, "0")}`;
}

export function chapterNumberFromId(chapterId) {
  return Number(String(chapterId).replace(/[^\d]/g, "")) || 0;
}

export function countWordsApprox(text) {
  if (!text) {
    return 0;
  }

  const compact = String(text).replace(/\s+/g, "");
  return compact.length;
}

export function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .trim();
}

export function extractKeywords(...values) {
  const source = values.join(" ");
  const tokens = source.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z0-9]{3,}/g) || [];
  const normalized = tokens
    .map((token) => token.trim())
    .filter((token) => token && !STOP_WORDS.has(token));

  return [...new Set(normalized)];
}

export function overlapScore(a, b) {
  const left = new Set(extractKeywords(a));
  const right = new Set(extractKeywords(b));

  if (!left.size || !right.size) {
    return 0;
  }

  let hits = 0;
  for (const token of left) {
    if (right.has(token)) {
      hits += 1;
    }
  }

  return hits / Math.max(left.size, right.size);
}

export function splitIntoStages(totalChapters, stageCount) {
  const chapters = Math.max(1, totalChapters);
  const stages = Math.max(1, stageCount);
  const base = Math.floor(chapters / stages);
  const remainder = chapters % stages;

  let cursor = 1;
  return Array.from({ length: stages }, (_, index) => {
    const size = base + (index < remainder ? 1 : 0);
    const start = cursor;
    const end = cursor + size - 1;
    cursor = end + 1;

    return {
      index: index + 1,
      start,
      end,
      size,
    };
  });
}

export function toChineseChapterNumber(number) {
  const numerals = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const n = Number(number) || 0;

  if (n <= 10) {
    return n === 10 ? "十" : numerals[n];
  }

  if (n < 20) {
    return `十${numerals[n % 10]}`;
  }

  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${numerals[tens]}十${ones ? numerals[ones] : ""}`;
}

export function pick(items, index) {
  if (!items.length) {
    return "";
  }

  return items[index % items.length];
}

export function createExcerpt(text, maxLength = 160) {
  const normalized = normalizeText(text).replace(/\n+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function extractJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) {
    return "";
  }

  const fencedMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : source;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1);
  }
  return candidate;
}
