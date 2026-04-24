export const PLAN_STATUS = {
  IDLE: "idle",
  DRAFT_PENDING_REVIEW: "draft_pending_review",
  DRAFT_APPROVED: "draft_approved",
  DRAFT_REJECTED: "draft_rejected",
  FINAL_PENDING_REVIEW: "final_pending_review",
  FINAL_REJECTED: "final_rejected",
  LOCKED: "locked",
};

export const WRITE_STATUS = {
  IDLE: "idle",
  CHAPTER_OUTLINE_PENDING_REVIEW: "chapter_outline_pending_review",
  CHAPTER_PENDING_REVIEW: "chapter_pending_review",
  CHAPTER_REJECTED: "chapter_rejected",
};

export const DEFAULT_PROJECT_STATE = {
  appName: "Novelex",
  providerMode: "openai-responses",
  providerConfig: {
    apiStyle: "responses",
    responseModel: "gpt-5.4",
    reviewModel: "gpt-5.4",
    codexResponseModel: "gpt-5.3-codex",
    agentModels: {
      primary: {
        provider: "OpenAI",
        model: "gpt-5.4",
      },
      secondary: {
        provider: "OpenAI",
        model: "gpt-5.4",
      },
    },
    reasoningEffort: "medium",
    forceStream: false,
  },
  project: {
    title: "《未命名长篇》",
    genre: "请填写作品类型",
    setting: "请填写故事时代、地域或世界设定",
    premise: "请填写故事前提。",
    theme: "请填写作品主题",
    styleNotes: "第三人称有限视角。",
    styleFingerprintId: null,
    ragCollectionIds: [],
    openingCollectionIds: [],
    researchNotes: "",
    protagonistGoal: "请填写主角目标",
    totalChapters: 24,
    targetWordsPerChapter: 4000,
    stageCount: 4,
  },
  phase: {
    plan: {
      status: PLAN_STATUS.IDLE,
      lastRunId: null,
      pendingReview: null,
      lockedAt: null,
      rejectionNotes: [],
    },
    write: {
      status: WRITE_STATUS.IDLE,
      lastRunId: null,
      currentChapterNumber: 0,
      pendingReview: null,
      rejectionNotes: [],
      rewriteHistory: [],
    },
  },
  history: {
    reviews: [],
  },
};

export const REVIEW_TARGETS = {
  PLAN_DRAFT: "plan_draft",
  PLAN_FINAL: "plan_final",
  CHAPTER_OUTLINE: "chapter_outline",
  CHAPTER: "chapter",
};

export const DEFAULT_STYLE_GUIDE_MARKDOWN =
  "# 风格指南（待第1章通过后生成）\n\n- 当前尚未锁定首章风格，待首章通过后由系统自动生成。\n";
