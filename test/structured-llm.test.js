import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveCodexApiConfig } from "../src/config/codex-config.js";
import { analyzeCharacterPresence } from "../src/core/character-presence.js";
import {
  createMiniMaxValidationProvider,
  generateStructuredObject,
  parseStructuredObject,
} from "../src/llm/structured.js";

test("parseStructuredObject parses valid JSON and rejects invalid payloads", () => {
  assert.deepEqual(
    parseStructuredObject({ text: 'prefix {"ok":true,"count":2} suffix' }, "TestAgent"),
    { ok: true, count: 2 },
  );

  assert.throws(
    () => parseStructuredObject({ text: "not json" }, "TestAgent"),
    /TestAgent 返回了无法解析的 JSON/,
  );
});

test("generateStructuredObject normalizes provider JSON output", async () => {
  const provider = {
    async generateText() {
      return {
        text: '{"summary":"ok","items":["A","B","A"]}',
      };
    },
  };

  const result = await generateStructuredObject(provider, {
    label: "NormalizerAgent",
    instructions: "ignored",
    input: "ignored",
    normalize(parsed) {
      return {
        summary: parsed.summary,
        items: [...new Set(parsed.items)],
      };
    },
  });

  assert.deepEqual(result, {
    summary: "ok",
    items: ["A", "B"],
  });
});

test("CharacterPresenceAgent keeps only actually present planned characters", async () => {
  const provider = {
    async generateText() {
      return {
        text: JSON.stringify({
          summary: "李凡已出场，林定海缺席。",
          charactersPresent: ["李凡", "众水手"],
          missingRequiredCharacters: ["林定海"],
          mentions: [
            {
              name: "李凡",
              present: true,
              directlyNamed: true,
              evidence: "李凡压住舵链。",
              reason: "正文直接点名。",
            },
            {
              name: "林定海",
              present: false,
              directlyNamed: false,
              evidence: "",
              reason: "正文未出现。",
            },
          ],
        }),
      };
    },
  };

  const result = await analyzeCharacterPresence({
    provider,
    project: { title: "测试作品" },
    chapterPlan: {
      chapterId: "ch002",
      title: "舵链",
      charactersPresent: ["李凡", "林定海", "众水手"],
    },
    markdown: "李凡压住舵链，众水手一起用力。",
  });

  assert.deepEqual(result.charactersPresent, ["李凡", "众水手"]);
  assert.deepEqual(result.missingRequiredCharacters, ["林定海"]);
});

test("createMiniMaxValidationProvider forces MiniMax settings for validation", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-minimax-validation-"));
  try {
    saveCodexApiConfig(tempRoot, {
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
    });

    const provider = createMiniMaxValidationProvider({}, { rootDir: tempRoot });
    assert.equal(provider.settings.providerId, "MiniMax");
    assert.equal(provider.settings.providerName, "MiniMax");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
