import { createExcerpt } from "./text.js";

function firstMeaningful(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .find(Boolean) || "";
}

function buildConflict(type, resolution, detail = "") {
  return {
    type,
    resolution: String(resolution || "").trim(),
    detail: String(detail || "").trim(),
  };
}

export function auditChapterDrift({
  chapterPlan,
  planContext,
  historyPacket,
  foreshadowingAdvice = [],
  researchPacket,
}) {
  const conflicts = [];
  const recommendedFocus = String(
    planContext?.outline?.recommendedFocus ||
    firstMeaningful(chapterPlan?.arcContribution) ||
    firstMeaningful(chapterPlan?.keyEvents) ||
    "",
  ).trim();
  const currentFocus = createExcerpt(recommendedFocus || "当前场面冲突", 60);
  const deferred = Array.isArray(planContext?.outline?.deferUntilLater)
    ? planContext.outline.deferUntilLater
    : [];
  const openThreads = Array.isArray(historyPacket?.openThreads)
    ? historyPacket.openThreads
    : [];
  const highPressureHooks = (Array.isArray(foreshadowingAdvice) ? foreshadowingAdvice : [])
    .filter((item) => item?.urgency === "high" && item?.status !== "resolved");
  const uncertainPoints = Array.isArray(researchPacket?.uncertainPoints)
    ? researchPacket.uncertainPoints
    : [];

  if (deferred.length) {
    conflicts.push(buildConflict(
      "planning_vs_current_task",
      `本章先聚焦${currentFocus}，暂不展开${createExcerpt(deferred[0], 50)}。`,
      createExcerpt(deferred.join("；"), 160),
    ));
  }

  if (openThreads.length) {
    conflicts.push(buildConflict(
      "history_vs_current_task",
      `历史余波只承接与${currentFocus}直接相关的部分，不把旧线程写成抢戏主轴。`,
      createExcerpt(openThreads.join("；"), 160),
    ));
  }

  if (highPressureHooks.length) {
    conflicts.push(buildConflict(
      "hook_pressure",
      "优先推进已有伏笔压力，避免为了制造新悬念而稀释当前兑现。",
      createExcerpt(highPressureHooks.map((item) => `${item.id}:${item.description || item.status || ""}`).join("；"), 160),
    ));
  }

  if (uncertainPoints.length) {
    conflicts.push(buildConflict(
      "research_uncertainty",
      "涉及未核实事实时保持克制，只写已确认边界，不把模糊点写死。",
      createExcerpt(uncertainPoints.join("；"), 160),
    ));
  }

  return conflicts.slice(0, 4);
}
