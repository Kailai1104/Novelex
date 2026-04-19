function hasMeaningfulText(value) {
  return String(value || "").trim().length > 0;
}

function unresolvedForeshadowings(registry) {
  return (Array.isArray(registry?.foreshadowings) ? registry.foreshadowings : [])
    .filter((item) => String(item?.status || "").trim() !== "resolved");
}

export const AUDIT_DIMENSIONS = [
  {
    id: "outline_drift",
    label: "Outline Drift",
    category: "大纲偏移",
    legacyBucket: "consistency",
    promptFocus: "检查正文是否兑现本章硬性事件、场景推进与章末钩子，且没有偏离当前章应完成的节点。",
  },
  {
    id: "character_plausibility",
    label: "Character Plausibility",
    category: "人物可信",
    legacyBucket: "plausibility",
    promptFocus: "检查人物动机、情绪转折、行动路径与环境约束是否可信，不要因为风格偏好误伤正文。",
  },
  {
    id: "foreshadowing_progress",
    label: "Foreshadowing Progress",
    category: "伏笔推进",
    legacyBucket: "foreshadowing",
    promptFocus: "检查本章既定伏笔任务是否被种下、浇水或自然牵引，避免只口头提及不真正落地。",
  },
  {
    id: "pov_consistency",
    label: "POV Consistency",
    category: "视角一致性",
    legacyBucket: "style",
    promptFocus: "检查第三人称有限视角是否稳定，是否出现未受控的旁白第一人称或无过渡的视角漂移。",
  },
  {
    id: "meta_leak",
    label: "Meta Leak",
    category: "元信息泄漏",
    legacyBucket: "style",
    promptFocus: "检查是否泄漏提纲语、系统元信息、场景标题、写作备注或说明文式元话语。",
  },
  {
    id: "knowledge_boundary",
    label: "Knowledge Boundary",
    category: "信息越界",
    legacyBucket: "consistency",
    promptFocus: "检查角色是否说出或判断出自己不该知道的信息，尤其要对照角色已知/未知边界。",
  },
  {
    id: "research_accuracy",
    label: "Research Accuracy",
    category: "考据准确",
    legacyBucket: "consistency",
    promptFocus: "仅在本章触发研究时启用。检查是否违背资料包中的建议采用/避免误写事实。",
  },
  {
    id: "hook_overpayoff",
    label: "Hook Overpayoff",
    category: "提前回收",
    legacyBucket: "foreshadowing",
    promptFocus: "检查本章是否提前回收未来章节才该兑现的内容，或过早消耗后续钩子。",
  },
  {
    id: "chapter_pacing",
    label: "Chapter Pacing",
    category: "单章节奏",
    legacyBucket: "plausibility",
    promptFocus: "检查单章内部是否空转、概述过多、重复推进、段落拼接痕迹重或节奏失衡。",
  },
  {
    id: "sequence_monotony",
    label: "Sequence Monotony",
    category: "节奏单调",
    legacyBucket: "style",
    promptFocus: "检查最近几章是否连续同一种开场、同一种收束、同一种情绪或同一种节奏模式。",
    window: 3,
  },
  {
    id: "subplot_stagnation",
    label: "Subplot Stagnation",
    category: "支线停滞",
    legacyBucket: "foreshadowing",
    promptFocus: "检查旧伏笔、支线或未完线程是否长期只提不推，形成拖欠感。",
    window: 5,
  },
  {
    id: "style_drift",
    label: "Style Drift",
    category: "风格漂移",
    legacyBucket: "style",
    promptFocus: "检查本章在段落节奏、对白密度、叙述质感上是否与既有风格指纹偏离过大。",
    window: 3,
  },
];

export function getAuditDimension(id) {
  return AUDIT_DIMENSIONS.find((item) => item.id === id) || null;
}

export function legacyBucketForDimension(id) {
  return getAuditDimension(id)?.legacyBucket || "consistency";
}

export function resolveAuditDimensions({
  project,
  chapterPlan,
  foreshadowingAdvice = [],
  researchPacket,
  styleGuideText = "",
  chapterMetas = [],
  foreshadowingRegistry = null,
  historyPacket = null,
}) {
  const unresolved = unresolvedForeshadowings(foreshadowingRegistry);
  const enabled = [];

  for (const dimension of AUDIT_DIMENSIONS) {
    let active = true;
    let reason = "基础审计维度，默认启用。";

    if (dimension.id === "foreshadowing_progress") {
      active =
        (chapterPlan?.foreshadowingActions || []).length > 0 ||
        foreshadowingAdvice.length > 0 ||
        unresolved.some((item) => item?.urgency === "high");
      reason = active
        ? "本章存在伏笔任务或高压力旧伏笔。"
        : "当前章没有明确伏笔任务，暂不启用。";
    } else if (dimension.id === "research_accuracy") {
      active = Boolean(researchPacket?.triggered) || hasMeaningfulText(project?.researchNotes);
      reason = active
        ? "项目或本章存在明确考据约束。"
        : "本章未触发研究资料包，暂不启用。";
    } else if (dimension.id === "sequence_monotony") {
      active = chapterMetas.length >= 2;
      reason = active
        ? "已有至少两章历史正文，可做最近三章序列对比。"
        : "历史章节不足，暂不做序列单调检查。";
    } else if (dimension.id === "subplot_stagnation") {
      active =
        unresolved.some((item) => item?.status === "planted" || item?.status === "watered") ||
        (Array.isArray(historyPacket?.openThreads) && historyPacket.openThreads.length > 0);
      reason = active
        ? "存在未回收伏笔或历史开放线程。"
        : "当前没有足够明确的支线欠债，暂不启用。";
    } else if (dimension.id === "style_drift") {
      active = hasMeaningfulText(styleGuideText) || chapterMetas.length >= 1;
      reason = active
        ? "存在风格指南或既有章节，可做风格指纹对照。"
        : "缺少风格基准，暂不启用。";
    }

    if (!active) {
      continue;
    }

    enabled.push({
      ...dimension,
      enabledReason: reason,
    });
  }

  return enabled;
}
