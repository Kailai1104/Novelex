import assert from "node:assert/strict";
import test from "node:test";

import {
  missingRequiredNamedCharacters,
  realizedCharactersPresent,
  requiredCharactersConstraint,
} from "../src/core/character-presence.js";

test("required character constraint excludes generic crowd labels", () => {
  const chapterPlan = {
    charactersPresent: ["李凡", "林定海", "众水手", "船员"],
  };

  assert.equal(
    requiredCharactersConstraint(chapterPlan),
    "本章必须让以下具名角色在正文中实际出场或被直接点名：李凡、林定海",
  );
});

test("missing required named characters catches omitted named roles", () => {
  const chapterPlan = {
    charactersPresent: ["李凡", "林定海", "众水手"],
  };
  const markdown = "# 第一章\n\n李凡把绳索缠到腕上，众水手跟着压住船身。";

  assert.deepEqual(missingRequiredNamedCharacters(chapterPlan, markdown), ["林定海"]);
});

test("realized characters keep generic labels but drop missing named roles", () => {
  const chapterPlan = {
    charactersPresent: ["李凡", "林定海", "众水手"],
  };
  const markdown = "# 第一章\n\n李凡喝住众水手，自己先扑到舵旁。";

  assert.deepEqual(realizedCharactersPresent(chapterPlan, markdown), ["李凡", "众水手"]);
});
