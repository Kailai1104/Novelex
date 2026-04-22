import assert from "node:assert/strict";
import test from "node:test";

import {
  locateSelectedText,
  replaceSelectionInChapterMarkdown,
  sanitizeRevisionFragment,
  splitChapterMarkdown,
} from "../src/core/text.js";

test("replaceSelectionInChapterMarkdown replaces a uniquely matched body fragment", () => {
  const markdown = [
    "# 药舱与黑舱",
    "",
    "第一段原文。",
    "",
    "这里是要修改的句子。",
    "",
    "结尾保持不动。",
  ].join("\n");

  const result = replaceSelectionInChapterMarkdown(
    markdown,
    {
      selectedText: "这里是要修改的句子。",
      prefixContext: "第一段原文。\n\n",
      suffixContext: "\n\n结尾保持不动。",
    },
    "这里是新的句子。",
    "药舱与黑舱",
  );

  assert.match(result.markdown, /这里是新的句子。/);
  assert.doesNotMatch(result.markdown, /这里是要修改的句子。/);
  assert.match(result.markdown, /^# 药舱与黑舱/m);
  assert.match(result.markdown, /结尾保持不动。/);
});

test("locateSelectedText resolves duplicated text by using prefix and suffix anchors", () => {
  const body = [
    "甲板上风声很紧。",
    "",
    "重复句子。",
    "",
    "中间段落。",
    "",
    "重复句子。",
    "",
    "船尾已经进水。",
  ].join("\n");

  const located = locateSelectedText(body, {
    selectedText: "重复句子。",
    prefixContext: "中间段落。\n\n",
    suffixContext: "\n\n船尾已经进水。",
  });

  assert.equal(body.slice(located.start, located.end), "重复句子。");
  assert.equal(located.occurrenceCount, 2);
  assert.equal(body.slice(located.end, located.end + 9), "\n\n船尾已经进水。");
});

test("locateSelectedText throws when duplicated text remains ambiguous", () => {
  const body = "重复句子。\n\n过渡。\n\n重复句子。";
  assert.throws(
    () => locateSelectedText(body, { selectedText: "重复句子。" }),
    /多处匹配/u,
  );
});

test("splitChapterMarkdown keeps the title outside replacement operations", () => {
  const parts = splitChapterMarkdown("# 标题\n\n正文第一段。", "备用标题");
  assert.equal(parts.title, "标题");
  assert.equal(parts.body, "正文第一段。");
});

test("sanitizeRevisionFragment removes wrapper labels and fences", () => {
  assert.equal(
    sanitizeRevisionFragment("```markdown\n替换片段：新的正文。\n```"),
    "新的正文。",
  );
});
