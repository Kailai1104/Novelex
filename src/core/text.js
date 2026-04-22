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

export function splitChapterMarkdown(markdown = "", fallbackTitle = "") {
  const normalized = String(markdown || "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const headingMatch = lines[0]?.match(/^#\s+(.+)$/);

  if (!headingMatch) {
    return {
      title: String(fallbackTitle || "").trim(),
      titleLine: String(fallbackTitle || "").trim() ? `# ${String(fallbackTitle || "").trim()}` : "",
      body: normalized,
    };
  }

  return {
    title: String(headingMatch[1] || fallbackTitle || "").trim(),
    titleLine: lines[0],
    body: lines.slice(1).join("\n").replace(/^\n+/, ""),
  };
}

export function composeChapterMarkdown(title = "", body = "") {
  const normalizedBody = String(body || "").replace(/\r\n?/g, "\n");
  const normalizedTitle = String(title || "").trim();

  if (!normalizedTitle) {
    return normalizedBody.trim();
  }

  return normalizedBody ? `# ${normalizedTitle}\n\n${normalizedBody}` : `# ${normalizedTitle}`;
}

export function sanitizeRevisionFragment(text = "") {
  let source = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!source) {
    return "";
  }

  const fencedMatch = source.match(/^```(?:[\w-]+)?\s*\n?([\s\S]*?)\n?```$/);
  if (fencedMatch) {
    source = String(fencedMatch[1] || "").trim();
  }

  const lines = source.split("\n");
  while (lines.length) {
    const line = String(lines[0] || "").trim();
    if (!line) {
      lines.shift();
      continue;
    }

    const labelWithContent = line.match(/^(?:替换片段|修订后|修改后|输出|正文片段|新的内容)[:：]\s*(.+)$/);
    if (labelWithContent) {
      lines[0] = labelWithContent[1];
      break;
    }

    if (
      /^#{1,6}\s+/.test(line) ||
      /^(?:替换片段|修订后|修改后|输出|正文片段|新的内容)[:：]?$/.test(line)
    ) {
      lines.shift();
      continue;
    }

    break;
  }

  return lines.join("\n").trim();
}

export function locateSelectedText(text = "", selection = {}) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  const selectedText = String(selection?.selectedText || "").replace(/\r\n?/g, "\n");
  const prefixContext = String(selection?.prefixContext || "").replace(/\r\n?/g, "\n");
  const suffixContext = String(selection?.suffixContext || "").replace(/\r\n?/g, "\n");

  if (!selectedText) {
    throw new Error("未提供可替换的选中文本。");
  }

  const candidates = [];
  let cursor = source.indexOf(selectedText);
  while (cursor !== -1) {
    candidates.push({
      start: cursor,
      end: cursor + selectedText.length,
    });
    cursor = source.indexOf(selectedText, cursor + 1);
  }

  if (!candidates.length) {
    throw new Error("选中的原文片段无法在当前正文中定位，请重新选择。");
  }

  if (candidates.length === 1) {
    return {
      ...candidates[0],
      occurrenceCount: 1,
    };
  }

  const prefixMatches = prefixContext
    ? candidates.filter((candidate) =>
        source.slice(Math.max(0, candidate.start - prefixContext.length), candidate.start) === prefixContext)
    : candidates;
  const suffixMatches = suffixContext
    ? candidates.filter((candidate) =>
        source.slice(candidate.end, candidate.end + suffixContext.length) === suffixContext)
    : candidates;
  const anchoredMatches = candidates.filter((candidate) => {
    const prefixPassed = !prefixContext ||
      source.slice(Math.max(0, candidate.start - prefixContext.length), candidate.start) === prefixContext;
    const suffixPassed = !suffixContext ||
      source.slice(candidate.end, candidate.end + suffixContext.length) === suffixContext;
    return prefixPassed && suffixPassed;
  });

  const resolved = [anchoredMatches, prefixMatches, suffixMatches].find((items) => items.length === 1);
  if (resolved) {
    return {
      ...resolved[0],
      occurrenceCount: candidates.length,
    };
  }

  throw new Error("选中的原文片段出现多处匹配，当前锚点仍不够唯一，请缩小范围后重试。");
}

export function replaceSelectionInChapterMarkdown(markdown = "", selection = {}, replacement = "", fallbackTitle = "") {
  const parts = splitChapterMarkdown(markdown, fallbackTitle);
  const range = locateSelectedText(parts.body, selection);
  const nextBody = `${parts.body.slice(0, range.start)}${replacement}${parts.body.slice(range.end)}`;

  return {
    title: parts.title,
    body: nextBody,
    selectionRange: range,
    markdown: composeChapterMarkdown(parts.title || fallbackTitle, nextBody),
  };
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
