import { chapterNumberFromId, unique } from "./text.js";

function normalizeHookIds(values, limit = 8) {
  return unique((Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)).slice(0, limit);
}

function primaryHookFamily(item) {
  const tag = Array.isArray(item?.tags)
    ? String(item.tags[0] || "").trim()
    : "";
  return tag ? `${tag}类` : "";
}

function lastTouchedChapterNumber(item) {
  return chapterNumberFromId(
    item?.last_touched_chapter ||
    item?.planted_chapter ||
    item?.planned_plant_chapter ||
    "",
  );
}

function isStaleHook(item, currentChapterNumber, activeHookIds) {
  if (!item || item.status === "resolved") {
    return false;
  }
  if (activeHookIds.has(item.id)) {
    return false;
  }

  const lastTouched = lastTouchedChapterNumber(item);
  if (!lastTouched || currentChapterNumber <= lastTouched) {
    return item?.urgency === "high";
  }

  const chaptersSinceTouch = currentChapterNumber - lastTouched;
  return item?.urgency === "high" || chaptersSinceTouch >= 6;
}

export function buildHookAgenda({
  chapterPlan,
  foreshadowingAdvice = [],
}) {
  const actions = Array.isArray(chapterPlan?.foreshadowingActions)
    ? chapterPlan.foreshadowingActions
    : [];
  const activeHookIds = new Set(actions.map((item) => String(item?.id || "").trim()).filter(Boolean));
  const chapterNumber = Number(chapterPlan?.chapterNumber || 0);

  const mustAdvance = normalizeHookIds(
    actions
      .filter((item) => item?.action !== "resolve")
      .map((item) => item.id),
  );
  const eligibleResolve = normalizeHookIds(
    actions
      .filter((item) => item?.action === "resolve")
      .map((item) => item.id),
  );

  const staleDebtEntries = (Array.isArray(foreshadowingAdvice) ? foreshadowingAdvice : [])
    .filter((item) => isStaleHook(item, chapterNumber, activeHookIds));
  const staleDebt = normalizeHookIds(staleDebtEntries.map((item) => item.id));
  const avoidNewHookFamilies = unique(
    staleDebtEntries
      .map((item) => primaryHookFamily(item))
      .filter(Boolean),
  ).slice(0, 4);

  return {
    mustAdvance,
    eligibleResolve,
    staleDebt,
    avoidNewHookFamilies,
  };
}
