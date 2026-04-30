import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  createOpeningCollection,
  createProject,
  createRagCollection,
  deleteLockedChapter,
  deleteProject,
  generateStyleFingerprint,
  getDocument,
  getStyleFingerprint,
  getWorkspaceState,
  rebuildOpeningCollection,
  rebuildRagCollection,
  reviewPlan,
  reviewWrite,
  runPlan,
  runWrite,
  saveManualChapterEdit,
  saveProject,
  saveProjectOpeningBindings,
  saveProjectRagBindings,
  saveProjectStyle,
  saveProviderConfig,
  updateStyleFingerprint,
} from "./api";
import type {
  DirectEditWorkbenchState,
  MainSection,
  MutationAction,
  OutlineOptions,
  OutlineWorkbenchState,
  PartialRevisionWorkbenchState,
  PartialSelectionPayload,
  ProjectSummary,
  ProviderChoice,
  SideTab,
  StyleFingerprintSummary,
  ToastState,
  WorkspaceSnapshot,
} from "./types";

const MAIN_SECTIONS: MainSection[] = ["overview", "plan", "write", "chapters"];
const SIDE_TABS: SideTab[] = ["project", "resources", "history"];

function useStoredNullableString(key: string, initialValue: string | null) {
  const [state, setState] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return initialValue;
    }
    const raw = window.localStorage.getItem(key);
    return raw === null ? initialValue : raw;
  });

  useEffect(() => {
    if (state === null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, state);
  }, [key, state]);

  return [state, setState] as const;
}

function useStoredString<T extends string>(key: string, initialValue: T) {
  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") {
      return initialValue;
    }
    const raw = window.localStorage.getItem(key);
    return raw === null ? initialValue : (raw as T);
  });

  useEffect(() => {
    window.localStorage.setItem(key, state);
  }, [key, state]);

  return [state, setState] as const;
}

function useStoredBoolean(key: string, initialValue: boolean) {
  const [state, setState] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return initialValue;
    }
    return window.localStorage.getItem(key) === "true";
  });

  useEffect(() => {
    window.localStorage.setItem(key, state ? "true" : "false");
  }, [key, state]);

  return [state, setState] as const;
}

function usePageVisibility() {
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      setVisible(document.visibilityState === "visible");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return visible;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item)).filter(Boolean) : [];
}

function nowFormatted(value?: string | null) {
  if (!value) {
    return "未记录";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function pillTone(status?: string | null): "accent" | "success" | "warning" | "danger" {
  if (!status) {
    return "accent";
  }
  const normalized = String(status).toLowerCase();
  if (/locked|approved|resolved|idle|completed/.test(normalized)) {
    return "success";
  }
  if (/pending|review|running|draft/.test(normalized)) {
    return "warning";
  }
  if (/rejected|danger|failed|error/.test(normalized)) {
    return "danger";
  }
  return "accent";
}

function humanPhaseName(value: string) {
  if (value === "plan") {
    return "方案";
  }
  if (value === "write") {
    return "写作";
  }
  return value;
}

function humanPhaseStatus(status?: string | null) {
  if (!status) {
    return "-";
  }
  const normalized = String(status).toLowerCase();
  if (normalized === "idle") {
    return "未开始";
  }
  if (normalized === "draft_pending_review") {
    return "草稿待审";
  }
  if (normalized === "final_pending_review") {
    return "终稿待审";
  }
  if (normalized === "locked") {
    return "锁定";
  }
  if (normalized === "draft_rejected") {
    return "草稿退回";
  }
  if (normalized === "final_rejected") {
    return "终稿退回";
  }
  if (normalized === "chapter_outline_pending_review") {
    return "细纲待审";
  }
  if (normalized === "chapter_pending_review") {
    return "正文待审";
  }
  if (normalized === "completed") {
    return "已完成";
  }
  if (normalized === "running") {
    return "进行中";
  }
  if (normalized === "failed") {
    return "失败";
  }
  return String(status);
}

function humanDiversityPreset(value: string) {
  if (value === "wide") {
    return "高发散";
  }
  if (value === "standard") {
    return "标准";
  }
  return value;
}

function humanReasoningEffort(value?: string | null) {
  const normalized = String(value || "medium").toLowerCase();
  if (normalized === "low") {
    return "低";
  }
  if (normalized === "high") {
    return "高";
  }
  if (normalized === "xhigh") {
    return "极高";
  }
  return "中等";
}

function humanRunTarget(value?: string | null) {
  if (!value || value === "run") {
    return "运行";
  }
  if (value === "chapter_outline") {
    return "细纲";
  }
  if (value === "chapter") {
    return "正文";
  }
  if (value === "plan_final") {
    return "最终大纲";
  }
  if (value === "plan_draft") {
    return "大纲草稿";
  }
  return value;
}

function previewText(value: unknown, limit = 2400) {
  const text = asString(value);
  if (!text) {
    return "";
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n...`;
}

function countWordsApprox(value: unknown) {
  return asString(value).replace(/\s+/g, "").length;
}

function currentStyleFingerprintSummary(snapshot: WorkspaceSnapshot | null) {
  const styleId = snapshot?.project?.project?.styleFingerprintId || null;
  if (!styleId) {
    return null;
  }
  return (snapshot?.styleFingerprints || []).find((item) => item.id === styleId) || null;
}

function summarizePlanCharacters(characters: any[] = []) {
  return characters
    .map((character) => `- **${character.name || "未命名"}**｜${character.role || "未定角色"}｜欲望：${character.desire || "待补"}`)
    .join("\n");
}

function latestRun(snapshot: WorkspaceSnapshot | null, phase: "plan" | "write") {
  return snapshot?.runs?.[phase]?.[0] || null;
}

function chapterIdFromNumberValue(value?: number | string | null) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) {
    return "";
  }
  return `ch${String(Math.trunc(number)).padStart(3, "0")}`;
}

function activeWriteChapterId(snapshot: WorkspaceSnapshot | null, pending: any) {
  return (
    pending?.chapterPlan?.chapterId ||
    pending?.chapterId ||
    chapterIdFromNumberValue(snapshot?.project?.phase?.write?.currentChapterNumber)
  );
}

function latestWriteRunForChapter(snapshot: WorkspaceSnapshot | null, chapterId: string) {
  if (!chapterId) {
    return null;
  }
  return (snapshot?.runs?.write || []).find((run: any) =>
    String(run?.chapterId || "").trim() === chapterId
  ) || null;
}

function pendingReview(snapshot: WorkspaceSnapshot | null) {
  return snapshot?.project?.phase?.plan?.pendingReview || snapshot?.project?.phase?.write?.pendingReview || null;
}

function pendingChapterWordCount(pending: any) {
  const explicitCount = Number(pending?.chapterMeta?.word_count);
  if (Number.isFinite(explicitCount) && explicitCount > 0) {
    return explicitCount;
  }
  return countWordsApprox(pending?.chapterMarkdown || "");
}

function normalizedOutlineOptionsFromSnapshot(pending: any): OutlineOptions {
  const options = pending?.reviewState?.outlineOptions || pending?.chapterOutlineContext?.outlineOptions || null;
  return {
    variantCount: Number(options?.variantCount || 3),
    diversityPreset: String(options?.diversityPreset || "wide"),
  };
}

function splitChapterMarkdownForReview(markdown = "", fallbackTitle = "") {
  const normalized = String(markdown || "").replace(/\r\n?/g, "\n");
  const match = normalized.match(/^#\s+(.+)\n([\s\S]*)$/);
  if (!match) {
    return {
      title: String(fallbackTitle || "").trim(),
      body: normalized,
    };
  }
  return {
    title: String(match[1] || fallbackTitle || "").trim(),
    body: String(match[2] || "").replace(/^\n+/, ""),
  };
}

function chapterBodyFromPending(pending: any) {
  if (!pending?.chapterMarkdown) {
    return "";
  }
  return splitChapterMarkdownForReview(
    pending.chapterMarkdown,
    pending?.chapterPlan?.title || pending?.chapterTitle || "",
  ).body;
}

function selectionPreviewText(workbench?: PartialRevisionWorkbenchState | null) {
  const selectedText = String(workbench?.selectedText || "");
  return selectedText ? previewText(selectedText, 240) : "";
}

function nextActionText(snapshot: WorkspaceSnapshot | null) {
  if (!snapshot) {
    return "加载项目状态中。";
  }
  const { plan, write } = snapshot.project.phase;
  if (plan.status === "idle" || plan.status === "draft_rejected" || plan.status === "final_rejected") {
    return "运行方案阶段，生成完整方案包并等待一次性审阅。";
  }
  if (plan.status === "draft_pending_review") {
    return "旧流程待升级：审阅草稿或推进到完整方案包。";
  }
  if (plan.status === "final_pending_review") {
    return "审阅完整大纲并锁定进入写作阶段。";
  }
  if (plan.status === "locked" && write.status === "idle") {
    return "生成下一章细纲候选。";
  }
  if (write.status === "chapter_outline_pending_review") {
    return "审阅章节细纲候选，选择、组合或反馈重生。";
  }
  if (write.status === "chapter_pending_review") {
    return "审阅章节草稿并决定锁定或重写。";
  }
  return "系统已准备好继续推进。";
}

function pendingReviewText(snapshot: WorkspaceSnapshot | null) {
  const pending = pendingReview(snapshot);
  if (!pending) {
    return "当前没有待审节点。";
  }
  if (pending.target === "plan_draft") {
    return "旧流程的大纲草稿等待兼容审查。";
  }
  if (pending.target === "plan_final") {
    return "完整大纲等待单次终审锁定。";
  }
  if (pending.target === "chapter_outline") {
    return `${pending.chapterId} 的章节细纲等待选择或组合。`;
  }
  return `${pending.chapterId} 等待章节审阅。`;
}

function rangeOffsetWithin(root: HTMLElement, container: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return range.toString().length;
}

function renderIcon(name: string) {
  const stroke = "currentColor";
  const base = 'width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"';
  const icons: Record<string, string> = {
    menu: `<svg ${base}><path d="M3 4.25H13M3 8H13M3 11.75H13" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round"/></svg>`,
    panel: `<svg ${base}><path d="M3.25 3.25H12.75V12.75H3.25V3.25Z" stroke="${stroke}" stroke-width="1.2"/><path d="M6 3.25V12.75" stroke="${stroke}" stroke-width="1.2"/></svg>`,
    plus: `<svg ${base}><path d="M8 3.25V12.75M3.25 8H12.75" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round"/></svg>`,
    spark: `<svg ${base}><path d="M8 2.5L8.8 5.2L11.5 6L8.8 6.8L8 9.5L7.2 6.8L4.5 6L7.2 5.2L8 2.5Z" stroke="${stroke}" stroke-width="1.1" stroke-linejoin="round"/></svg>`,
    overview: `<svg ${base}><path d="M3.25 3.25H7.25V7.25H3.25V3.25Z" stroke="${stroke}" stroke-width="1.2"/><path d="M8.75 3.25H12.75V5.75H8.75V3.25Z" stroke="${stroke}" stroke-width="1.2"/><path d="M8.75 7.25H12.75V12.75H8.75V7.25Z" stroke="${stroke}" stroke-width="1.2"/><path d="M3.25 8.75H7.25V12.75H3.25V8.75Z" stroke="${stroke}" stroke-width="1.2"/></svg>`,
    outline: `<svg ${base}><path d="M4 4.25H12M4 8H12M4 11.75H9.75" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round"/><circle cx="2.75" cy="4.25" r=".75" fill="${stroke}"/><circle cx="2.75" cy="8" r=".75" fill="${stroke}"/><circle cx="2.75" cy="11.75" r=".75" fill="${stroke}"/></svg>`,
    write: `<svg ${base}><path d="M3.5 11.75L4 9.5L10.25 3.25L12.75 5.75L6.5 12L4.25 12.5L3.5 11.75Z" stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.25 4.25L11.75 6.75" stroke="${stroke}" stroke-width="1.2"/></svg>`,
    chapters: `<svg ${base}><path d="M4 3.25H11.5C12.0523 3.25 12.5 3.69772 12.5 4.25V12.25H4C3.44772 12.25 3 11.8023 3 11.25V4.25C3 3.69772 3.44772 3.25 4 3.25Z" stroke="${stroke}" stroke-width="1.2"/><path d="M5.25 5.5H10.25M5.25 7.75H10.25M5.25 10H8.5" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round"/></svg>`,
    project: `<svg ${base}><path d="M2.75 4.5H13.25V12.5H2.75V4.5Z" stroke="${stroke}" stroke-width="1.2"/><path d="M5.25 4.5V3.5C5.25 3.08579 5.58579 2.75 6 2.75H10C10.4142 2.75 10.75 3.08579 10.75 3.5V4.5" stroke="${stroke}" stroke-width="1.2"/></svg>`,
    resources: `<svg ${base}><path d="M8 2.75L9.25 5.25L12 6.5L9.25 7.75L8 10.25L6.75 7.75L4 6.5L6.75 5.25L8 2.75Z" stroke="${stroke}" stroke-width="1.1" stroke-linejoin="round"/><path d="M11.25 10.75L11.75 11.75L12.75 12.25L11.75 12.75L11.25 13.75L10.75 12.75L9.75 12.25L10.75 11.75L11.25 10.75Z" stroke="${stroke}" stroke-width="1"/></svg>`,
    documents: `<svg ${base}><path d="M4.25 2.75H9.5L11.75 5V13.25H4.25V2.75Z" stroke="${stroke}" stroke-width="1.2"/><path d="M9.5 2.75V5H11.75" stroke="${stroke}" stroke-width="1.2"/><path d="M5.75 7H10.25M5.75 9.25H10.25M5.75 11.5H8.75" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round"/></svg>`,
    history: `<svg ${base}><path d="M8 3.25A4.75 4.75 0 1 1 3.85 5.68" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round"/><path d="M2.75 3.75V6.5H5.5" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 5.5V8L9.75 9.5" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round"/></svg>`,
    chevronLeft: `<svg ${base}><path d="M9.75 3.5L5.75 8L9.75 12.5" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    chevronRight: `<svg ${base}><path d="M6.25 3.5L10.25 8L6.25 12.5" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };
  return <span dangerouslySetInnerHTML={{ __html: icons[name] || icons.overview }} />;
}

function MarkdownBody({ value }: { value: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </div>
  );
}

function PreformattedBlock({ value }: { value: string }) {
  return <pre>{value}</pre>;
}

function JsonBlock({ value }: { value: any }) {
  return <PreformattedBlock value={JSON.stringify(value || {}, null, 2)} />;
}

function ArtifactBlock(props: { title: string; tone?: string; children: React.ReactNode }) {
  return (
    <div className="artifact-block" data-tone={props.tone || "accent"}>
      <div className="artifact-title">{props.title}</div>
      <div className="artifact-body">{props.children}</div>
    </div>
  );
}

function ArtifactList({ children }: { children: React.ReactNode }) {
  return <div className="artifact-stack">{children}</div>;
}

function Badge({ label, tone = "accent" }: { label: string; tone?: string }) {
  return (
    <span className="mini-pill" data-tone={tone}>
      {label}
    </span>
  );
}

function Pill({ label, value, toneValue }: { label: string; value: string; toneValue?: string | null }) {
  return (
    <span className="pill" data-tone={pillTone(toneValue ?? value)}>
      {label}：{value || "-"}
    </span>
  );
}

type TimelineItemType = {
  key: string;
  label: string;
  summary?: string;
  status?: string;
  meta?: React.ReactNode;
  body: React.ReactNode;
  defaultExpanded?: boolean;
};

export default function App() {
  const queryClient = useQueryClient();
  const isPageVisible = usePageVisibility();
  const [selectedProjectId, setSelectedProjectId] = useStoredNullableString("novelex:selected-project", null);
  const [selectedDocumentPath, setSelectedDocumentPath] = useState<string | null>(null);
  const [selectedStyleFingerprintId, setSelectedStyleFingerprintId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useStoredBoolean("novelex:sidebar-collapsed", false);
  const [utilityCollapsed, setUtilityCollapsed] = useStoredBoolean("novelex:utility-collapsed", false);
  const [activeMainSection, setActiveMainSection] = useStoredString<MainSection>("novelex:main-section", "overview");
  const [activeSideTab, setActiveSideTab] = useStoredString<SideTab>("novelex:side-tab", "project");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileUtilityOpen, setMobileUtilityOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>({ visible: false, message: "" });
  const toastTimerRef = useRef<number | null>(null);
  const [activeMutation, setActiveMutation] = useState<MutationAction | null>(null);
  const [expandedFlowItems, setExpandedFlowItems] = useState<Record<string, boolean>>({});
  const [outlineWorkbenchState, setOutlineWorkbenchState] = useState<Record<string, OutlineWorkbenchState>>({});
  const [partialRevisionWorkbenchState, setPartialRevisionWorkbenchState] = useState<Record<string, PartialRevisionWorkbenchState>>({});
  const [directEditWorkbenchState, setDirectEditWorkbenchState] = useState<Record<string, DirectEditWorkbenchState>>({});
  const [reviewFeedback, setReviewFeedback] = useState<Record<string, string>>({});
  const [outlineOptions, setOutlineOptions] = useState<OutlineOptions>({ variantCount: 3, diversityPreset: "wide" });
  const [projectDraft, setProjectDraft] = useState<Record<string, any>>({});
  const [providerDraft, setProviderDraft] = useState<Record<string, any>>({});
  const [projectStyleDraft, setProjectStyleDraft] = useState("");
  const [styleGenerateDraft, setStyleGenerateDraft] = useState({ name: "", sampleText: "" });
  const [styleEditDraft, setStyleEditDraft] = useState({ styleId: "", name: "", promptMarkdown: "" });
  const [ragCreateName, setRagCreateName] = useState("");
  const [openingCreateName, setOpeningCreateName] = useState("");
  const [selectedRagIds, setSelectedRagIds] = useState<string[]>([]);
  const [selectedOpeningIds, setSelectedOpeningIds] = useState<string[]>([]);

  const deferredStyleFingerprintId = useDeferredValue(selectedStyleFingerprintId);

  const workspaceQuery = useQuery({
    queryKey: ["workspace-state", selectedProjectId],
    queryFn: () => getWorkspaceState(selectedProjectId),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const data = query.state.data as any;
      return isPageVisible && !activeMutation && data?.activeOperation ? 1500 : false;
    },
  });

  const workspace = workspaceQuery.data || null;
  const snapshot = workspace?.state || null;
  const projects = workspace?.projects || [];
  const serverActiveOperation = workspace?.activeOperation || null;
  const effectiveProjectId = workspace?.projectId || null;
  const pending = snapshot?.staged?.pendingChapter || null;
  const currentProject = snapshot?.project?.project || null;
  const providerRuntime = snapshot?.provider || null;
  const currentStyle = currentStyleFingerprintSummary(snapshot);

  const styleFingerprintQuery = useQuery({
    queryKey: ["style-fingerprint", effectiveProjectId, deferredStyleFingerprintId],
    queryFn: () => getStyleFingerprint(effectiveProjectId!, deferredStyleFingerprintId!),
    enabled: Boolean(effectiveProjectId && deferredStyleFingerprintId && activeSideTab === "resources"),
  });

  const activeProjectSummary = useMemo(
    () => projects.find((project) => project.id === effectiveProjectId) || null,
    [effectiveProjectId, projects],
  );

  useEffect(() => {
    if (activeSideTab === "documents") {
      setActiveSideTab("history");
    }
  }, [activeSideTab, setActiveSideTab]);

  const mutationBusy = (action?: MutationAction | null) => {
    if (!action) {
      return Boolean(activeMutation || serverActiveOperation);
    }
    return activeMutation === action || serverActiveOperation?.action === action;
  };

  const showToast = (message: string) => {
    setToast({ visible: true, message });
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast((current) => ({ ...current, visible: false }));
    }, 2800);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (effectiveProjectId !== selectedProjectId) {
      setSelectedProjectId(effectiveProjectId);
    }
  }, [effectiveProjectId, selectedProjectId, setSelectedProjectId]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    setProjectDraft({
      title: currentProject?.title || "",
      genre: currentProject?.genre || "",
      setting: currentProject?.setting || "",
      premise: currentProject?.premise || "",
      theme: currentProject?.theme || "",
      styleNotes: currentProject?.styleNotes || "",
      researchNotes: currentProject?.researchNotes || "",
      protagonistGoal: currentProject?.protagonistGoal || "",
      totalChapters: String(currentProject?.totalChapters || ""),
      targetWordsPerChapter: String(currentProject?.targetWordsPerChapter || ""),
      stageCount: String(currentProject?.stageCount || ""),
    });

    setProviderDraft({
      primaryProviderId: providerRuntime?.agentModels?.primary?.providerId || providerRuntime?.providerId || "",
      primaryModel: providerRuntime?.agentModels?.primary?.model || providerRuntime?.responseModel || "",
      secondaryProviderId: providerRuntime?.agentModels?.secondary?.providerId || providerRuntime?.providerId || "",
      secondaryModel: providerRuntime?.agentModels?.secondary?.model || providerRuntime?.reviewModel || "",
    });

    setProjectStyleDraft(currentProject?.styleFingerprintId || "");
    setSelectedRagIds([...(currentProject?.ragCollectionIds || [])]);
    setSelectedOpeningIds([...(currentProject?.openingCollectionIds || [])]);
    setOutlineOptions(normalizedOutlineOptionsFromSnapshot(pending));
  }, [currentProject, pending, providerRuntime, snapshot]);

  useEffect(() => {
    if (!styleFingerprintQuery.data?.styleFingerprint) {
      return;
    }

    const detail = styleFingerprintQuery.data.styleFingerprint;
    setStyleEditDraft({
      styleId: detail.metadata.id,
      name: detail.metadata.name || "",
      promptMarkdown: detail.promptMarkdown || "",
    });
  }, [styleFingerprintQuery.data]);

  useEffect(() => {
    const documentEntries = snapshot?.documents || [];
    if (!documentEntries.length) {
      setSelectedDocumentPath(null);
      return;
    }
    const hasSelected = selectedDocumentPath
      ? documentEntries.some((doc) => doc.label === selectedDocumentPath)
      : false;
    if (!hasSelected) {
      setSelectedDocumentPath(documentEntries[0].label);
    }
  }, [selectedDocumentPath, snapshot?.documents]);

  useEffect(() => {
    const availableStyleIds = (snapshot?.styleFingerprints || []).map((item) => item.id);
    const preferredStyleId = snapshot?.project?.project?.styleFingerprintId || availableStyleIds[0] || null;
    if (!selectedStyleFingerprintId || !availableStyleIds.includes(selectedStyleFingerprintId)) {
      setSelectedStyleFingerprintId(preferredStyleId);
    }
  }, [selectedStyleFingerprintId, snapshot?.project?.project?.styleFingerprintId, snapshot?.styleFingerprints]);

  const applyStateResponse = (data: any) => {
    if (typeof data?.projectId !== "undefined") {
      setSelectedProjectId(data.projectId || null);
    }
    const targetProjectId = data?.projectId || null;
    queryClient.setQueryData(["workspace-state", targetProjectId], data);
    queryClient.invalidateQueries({ queryKey: ["workspace-state"] }).catch(() => {});
  };

  const syncStateAfterError = async (projectId = selectedProjectId) => {
    await queryClient.invalidateQueries({ queryKey: ["workspace-state", projectId] });
  };

  const runMutation = async (
    action: MutationAction,
    task: () => Promise<any>,
    options: {
      onSuccess?: (data: any) => void;
      successMessage?: string;
    } = {},
  ) => {
    if (activeMutation) {
      showToast("已有请求正在处理中，请稍候。");
      return null;
    }

    setActiveMutation(action);
    try {
      const data = await task();
      applyStateResponse(data);
      options.onSuccess?.(data);
      if (options.successMessage) {
        showToast(options.successMessage);
      }
      return data;
    } catch (error: any) {
      await syncStateAfterError();
      showToast(error?.message || "请求失败");
      return null;
    } finally {
      setActiveMutation(null);
    }
  };

  const currentProviderChoice = (slot: "primary" | "secondary") => {
    const providers = providerRuntime?.availableProviders || [];
    const providerId = providerDraft[slot === "primary" ? "primaryProviderId" : "secondaryProviderId"];
    return (
      providers.find((item: ProviderChoice) => item.id === providerId) ||
      providers.find((item: ProviderChoice) => item.id === providerRuntime?.providerId) ||
      providers[0] ||
      null
    );
  };

  const syncProviderDraftFromSelection = (slot: "primary" | "secondary", providerId: string) => {
    const providers = providerRuntime?.availableProviders || [];
    const selected = providers.find((item: ProviderChoice) => item.id === providerId) || null;
    setProviderDraft((current) => ({
      ...current,
      [`${slot}ProviderId`]: providerId,
      [`${slot}Model`]: selected?.responseModel || "",
    }));
  };

  const sectionExpanded = (key: string, defaultExpanded = false) =>
    Object.prototype.hasOwnProperty.call(expandedFlowItems, key)
      ? Boolean(expandedFlowItems[key])
      : defaultExpanded;

  const toggleSection = (key: string, defaultExpanded = false) => {
    setExpandedFlowItems((current) => ({
      ...current,
      [key]: !(Object.prototype.hasOwnProperty.call(current, key) ? Boolean(current[key]) : defaultExpanded),
    }));
  };

  const expandFlow = (prefix: string, keys: string[]) => {
    setExpandedFlowItems((current) => {
      const next = { ...current };
      keys.filter((key) => key.startsWith(prefix)).forEach((key) => {
        next[key] = true;
      });
      return next;
    });
  };

  const collapseFlow = (prefix: string, keys: string[]) => {
    setExpandedFlowItems((current) => {
      const next = { ...current };
      keys.filter((key) => key.startsWith(prefix)).forEach((key) => {
        next[key] = false;
      });
      return next;
    });
  };

  const outlineWorkbenchFor = (chapterId: string, pendingChapter: any) => {
    return outlineWorkbenchState[chapterId] || {
      sceneRefs: [...(pendingChapter?.selectedChapterOutline?.selectedSceneRefs || [])],
    };
  };

  useEffect(() => {
    if (!pending) {
      return;
    }
    const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "";
    if (!chapterId) {
      return;
    }
    setOutlineWorkbenchState((current) => {
      if (current[chapterId]) {
        return current;
      }
      return {
        ...current,
        [chapterId]: {
          sceneRefs: [...(pending?.selectedChapterOutline?.selectedSceneRefs || [])],
        },
      };
    });
    setPartialRevisionWorkbenchState((current) => {
      if (current[chapterId]) {
        return current;
      }
      return {
        ...current,
        [chapterId]: {
          selectedText: String(pending?.reviewState?.selection?.selectedText || ""),
          prefixContext: String(pending?.reviewState?.selection?.prefixContext || ""),
          suffixContext: String(pending?.reviewState?.selection?.suffixContext || ""),
          feedback:
            pending?.reviewState?.mode === "partial_rewrite"
              ? String(pending?.reviewState?.lastFeedback || "")
              : "",
        },
      };
    });
    setDirectEditWorkbenchState((current) => {
      if (current[chapterId]) {
        return current;
      }
      const sourceBody = chapterBodyFromPending(pending);
      return {
        ...current,
        [chapterId]: {
          isEditing: false,
          sourceBody,
          draftBody: sourceBody,
        },
      };
    });
  }, [pending]);

  const partialWorkbench = (() => {
    const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "";
    return chapterId ? partialRevisionWorkbenchState[chapterId] : null;
  })();

  const directEditWorkbench = (() => {
    const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "";
    return chapterId ? directEditWorkbenchState[chapterId] : null;
  })();

  const candidateSceneMap = useMemo(() => {
    const map = new Map<string, any>();
    for (const candidate of pending?.chapterOutlineCandidates || []) {
      for (const scene of candidate?.chapterPlan?.scenes || []) {
        map.set(scene.sceneRef, {
          ...scene,
          proposalId: candidate.proposalId,
          chapterTitle: candidate?.chapterPlan?.title || "",
        });
      }
    }
    return map;
  }, [pending]);

  const selectedOutlineScenes = useMemo(() => {
    const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "";
    const workbench = chapterId ? outlineWorkbenchFor(chapterId, pending) : { sceneRefs: [] };
    return workbench.sceneRefs.map((sceneRef) => candidateSceneMap.get(sceneRef)).filter(Boolean);
  }, [candidateSceneMap, outlineWorkbenchState, pending]);

  const setOutlineSceneRefs = (chapterId: string, updater: (current: string[]) => string[]) => {
    setOutlineWorkbenchState((current) => ({
      ...current,
      [chapterId]: {
        sceneRefs: updater([...(current[chapterId]?.sceneRefs || [])]),
      },
    }));
  };

  const updatePartialWorkbench = (chapterId: string, patch: Partial<PartialRevisionWorkbenchState>) => {
    setPartialRevisionWorkbenchState((current) => ({
      ...current,
      [chapterId]: {
        selectedText: "",
        prefixContext: "",
        suffixContext: "",
        feedback: "",
        ...(current[chapterId] || {}),
        ...patch,
      },
    }));
  };

  const updateDirectEditWorkbench = (chapterId: string, patch: Partial<DirectEditWorkbenchState>) => {
    setDirectEditWorkbenchState((current) => ({
      ...current,
      [chapterId]: {
        isEditing: false,
        sourceBody: chapterBodyFromPending(pending),
        draftBody: chapterBodyFromPending(pending),
        ...(current[chapterId] || {}),
        ...patch,
      },
    }));
  };

  const captureChapterSelection = (container: HTMLDivElement) => {
    const chapterId = container.getAttribute("data-chapter-id") || "";
    if (!chapterId) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
      showToast("请只在正文 body 内框选需要修改的片段。");
      return;
    }

    const start = rangeOffsetWithin(container, range.startContainer, range.startOffset);
    const end = rangeOffsetWithin(container, range.endContainer, range.endOffset);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return;
    }

    const bodyText = container.textContent || "";
    const selectedText = bodyText.slice(start, end);
    if (!selectedText.trim()) {
      showToast("请至少选中一句有效正文。");
      return;
    }

    updatePartialWorkbench(chapterId, {
      selectedText,
      prefixContext: bodyText.slice(Math.max(0, start - 120), start),
      suffixContext: bodyText.slice(end, end + 120),
    });
    selection.removeAllRanges();
  };

  const renderFlowStepArtifacts = (phase: "plan" | "write", step: any) => {
    const stepId = `${step.id || ""} ${step.label || ""}`.toLowerCase();
    const blocks: React.ReactNode[] = [];

    if (phase === "plan") {
      const draft = snapshot?.staged?.planDraft as any;
      const finalPlan = snapshot?.staged?.planFinal as any;

      if ((/cast|character/.test(stepId)) && draft?.cast?.length) {
        blocks.push(<ArtifactBlock key="cast" title="人物草稿"><JsonBlock value={draft.cast} /></ArtifactBlock>);
      }
      if ((/outline|draft/.test(stepId)) && draft?.outlineMarkdown) {
        blocks.push(<ArtifactBlock key="outline" title="当前大纲草稿"><MarkdownBody value={draft.outlineMarkdown} /></ArtifactBlock>);
      }
      if ((/final|outline|plan/.test(stepId)) && finalPlan?.outlineMarkdown) {
        blocks.push(<ArtifactBlock key="final-outline" title="完整大纲" tone="success"><MarkdownBody value={finalPlan.outlineMarkdown} /></ArtifactBlock>);
      }
      if ((/structure|slot|foreshadow/.test(stepId)) && finalPlan?.structureMarkdown) {
        blocks.push(<ArtifactBlock key="structure" title="结构摘要" tone="success"><MarkdownBody value={finalPlan.structureMarkdown} /></ArtifactBlock>);
      }
      if ((/world|setting/.test(stepId)) && finalPlan?.worldbuildingMarkdown) {
        blocks.push(<ArtifactBlock key="world" title="世界观摘要" tone="success"><MarkdownBody value={finalPlan.worldbuildingMarkdown} /></ArtifactBlock>);
      }
      if ((/character|cast/.test(stepId)) && finalPlan?.characters?.length) {
        blocks.push(<ArtifactBlock key="characters" title="角色摘要" tone="success"><MarkdownBody value={summarizePlanCharacters(finalPlan.characters || [])} /></ArtifactBlock>);
      }
    }

    if (phase === "write") {
      const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "";
      const chapterParts = splitChapterMarkdownForReview(pending?.chapterMarkdown || "", pending?.chapterPlan?.title || "");
      const directWorkbench = chapterId ? directEditWorkbenchState[chapterId] : null;
      const directEditMode = Boolean(directWorkbench?.isEditing);

      if (/outlinecontext|briefing|plan_context_outline/.test(stepId) && pending?.chapterOutlineContext) {
        blocks.push(<ArtifactBlock key="outline-context" title="细纲上下文"><JsonBlock value={pending.chapterOutlineContext} /></ArtifactBlock>);
      }
      if (/history/.test(stepId) && pending?.retrieval) {
        blocks.push(<ArtifactBlock key="history" title="历史衔接包"><JsonBlock value={pending.retrieval} /></ArtifactBlock>);
      }
      if (/fact/.test(stepId) && pending?.factContext) {
        blocks.push(<ArtifactBlock key="fact" title="事实上下文"><JsonBlock value={pending.factContext} /></ArtifactBlock>);
      }
      if (/reference/.test(stepId) && pending?.referencePacket) {
        blocks.push(<ArtifactBlock key="reference" title="范文参考包"><JsonBlock value={pending.referencePacket} /></ArtifactBlock>);
      }
      if (/research/.test(stepId) && pending?.researchPacket) {
        blocks.push(<ArtifactBlock key="research" title="研究资料包"><JsonBlock value={pending.researchPacket} /></ArtifactBlock>);
      }
      if (/writercontext|coordinator|governance|input_governance/.test(stepId) && pending?.writerContext) {
        blocks.push(<ArtifactBlock key="writer-context" title="写作上下文"><JsonBlock value={pending.writerContext} /></ArtifactBlock>);
      }
      if ((/writer_agent/.test(stepId) || /\bwriteragent\b/.test(stepId)) && pending?.chapterMarkdown) {
        blocks.push(
          <ArtifactBlock key="chapter" title={chapterParts.title || pending?.chapterPlan?.title || "章节正文"} tone="warning">
            <p><small>当前草稿字数：{pendingChapterWordCount(pending)} 字</small></p>
            <ChapterBody
              chapterId={chapterId}
              body={directEditMode ? directWorkbench?.draftBody || "" : chapterParts.body || ""}
              editable={directEditMode}
              onInput={(value) => {
                updateDirectEditWorkbench(chapterId, { draftBody: value });
              }}
              onSelectionCapture={captureChapterSelection}
            />
          </ArtifactBlock>,
        );
      }
      if ((/audit_orchestrator|audit_analyzer|auditheuristics|auditguardrail/.test(stepId) || /\bauditanalyzeragent\b/.test(stepId)) && pending?.validation) {
        blocks.push(<ArtifactBlock key="audit" title="审计结果" tone={pillTone(step.status)}><JsonBlock value={pending.validation} /></ArtifactBlock>);
      }
      if (/audit_drift/.test(stepId) && (pending?.auditDrift?.markdown || pending?.validation?.auditDrift?.markdown)) {
        blocks.push(
          <ArtifactBlock key="drift" title="漂移提示" tone={pillTone(step.status)}>
            <MarkdownBody value={pending.auditDrift?.markdown || pending.validation.auditDrift.markdown} />
          </ArtifactBlock>,
        );
      }
      if (/state_update/.test(stepId) && (pending?.chapterMeta || pending?.worldState)) {
        blocks.push(<ArtifactBlock key="meta" title="章节元数据" tone="success"><JsonBlock value={pending.chapterMeta || {}} /></ArtifactBlock>);
        blocks.push(<ArtifactBlock key="world-state" title="世界状态摘要" tone="success"><JsonBlock value={pending.worldState || {}} /></ArtifactBlock>);
      }
    }

    if (!blocks.length) {
      return null;
    }

    return <ArtifactList>{blocks}</ArtifactList>;
  };

  const renderPlanReviewBody = (target: "plan_draft" | "plan_final", description: string) => (
    <div className="review-body">
      <p>{description}</p>
      <textarea
        id={`feedback-${target}`}
        placeholder="写下你的人类意见。批准时可留空，拒绝时建议写清楚要改哪里。"
        disabled={mutationBusy()}
        value={reviewFeedback[target] || ""}
        onChange={(event) => {
          setReviewFeedback((current) => ({ ...current, [target]: event.target.value }));
        }}
      />
      <div className="actions">
        <button
          className="button button-primary"
          type="button"
          disabled={mutationBusy()}
          onClick={async () => {
            await runMutation("plan_review", () => reviewPlan(effectiveProjectId!, {
              target,
              approved: true,
              feedback: reviewFeedback[target] || "",
            }), {
              successMessage: "审查结果已提交。",
              onSuccess: () => {
                setActiveMainSection("plan");
                setReviewFeedback((current) => ({ ...current, [target]: "" }));
              },
            });
          }}
        >
          {mutationBusy("plan_review") ? "提交中..." : "批准"}
        </button>
        <button
          className="button button-danger"
          type="button"
          disabled={mutationBusy()}
          onClick={async () => {
            await runMutation("plan_review", () => reviewPlan(effectiveProjectId!, {
              target,
              approved: false,
              feedback: reviewFeedback[target] || "",
            }), {
              successMessage: "修改意见已提交。",
              onSuccess: () => {
                setActiveMainSection("plan");
              },
            });
          }}
        >
          {mutationBusy("plan_review") ? "提交中..." : "拒绝并重写"}
        </button>
      </div>
    </div>
  );

  const renderChapterOutlineReviewBody = () => {
    const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "pending";
    const workbench = outlineWorkbenchFor(chapterId, pending);
    const composedAuditSummary = String(pending?.reviewState?.composedAuditSummary || "").trim();
    const composedAuditIssues = (pending?.reviewState?.composedAuditIssues || []).filter(Boolean);
    return (
      <div className="review-body">
        <p>先确定本章细纲，再进入正文生成。你可以直接采用某个方案，也可以把不同方案里的场景片段组合成最终细纲。</p>
        <textarea
          id="feedback-chapter-outline"
          placeholder="写下组合说明或重生反馈，比如想强化哪条关系线、换成更险的冲突轴、让章末更狠一点。"
          disabled={mutationBusy()}
          value={reviewFeedback.chapter_outline || pending?.selectedChapterOutline?.authorNotes || ""}
          onChange={(event) => {
            setReviewFeedback((current) => ({ ...current, chapter_outline: event.target.value }));
          }}
        />
        {composedAuditSummary ? (
          <div className="outline-audit-panel" data-tone="danger">
            <strong>组合稿未通过审计</strong>
            <p>{composedAuditSummary}</p>
            {composedAuditIssues.length ? (
              <ul className="outline-issue-list">
                {composedAuditIssues.slice(0, 4).map((issue: any, index: number) => (
                  <li key={`${issue.id || "issue"}-${index}`}>{issue.description || String(issue)}</li>
                ))}
              </ul>
            ) : null}
            <p><small>请重新组合，或直接选择已通过预审的候选。</small></p>
          </div>
        ) : null}
        <div className="candidate-stack">
          {(pending?.chapterOutlineCandidates || []).length ? (pending?.chapterOutlineCandidates || []).map((candidate: any) => {
            const candidateSelectable = candidate?.selectable !== false && candidate?.auditStatus !== "failed";
            return (
            <div
              className={`candidate-card ${candidateSelectable ? "is-passed" : "is-failed"}`}
              key={candidate.proposalId}
            >
              <div className="candidate-head">
                <div>
                  <strong>{candidate.proposalId} · {candidate.chapterPlan?.title || ""}</strong>
                  <div className="pill-row candidate-status-row">
                    <span className="mini-pill" data-tone={candidateSelectable ? "success" : "danger"}>
                      {candidateSelectable ? "预审通过" : "预审失败"}
                    </span>
                    {Number.isFinite(Number(candidate.auditScore)) ? (
                      <span className="mini-pill" data-tone={candidateSelectable ? "success" : "danger"}>
                        score {candidate.auditScore}
                      </span>
                    ) : null}
                  </div>
                  <p>{candidate.summary || ""}</p>
                  <p><small>{candidate.diffSummary || ""}</small></p>
                  {candidate.auditSummary ? <p><small>{candidate.auditSummary}</small></p> : null}
                  {!candidateSelectable && (candidate.auditIssues || []).length ? (
                    <ul className="outline-issue-list">
                      {(candidate.auditIssues || []).slice(0, 3).map((issue: any, index: number) => (
                        <li key={`${candidate.proposalId}-issue-${index}`}>{issue.description || String(issue)}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <button
                  className="button button-primary"
                  type="button"
                  disabled={mutationBusy()}
                  onClick={async () => {
                    if (!candidateSelectable) {
                      const confirmationText = [
                        "该细纲候选未通过预审，确认仍要直接采用并进入正文写作吗？",
                        candidate.auditSummary ? `审计结论：${candidate.auditSummary}` : "",
                        ...((candidate.auditIssues || []).slice(0, 4).map((issue: any) => `- ${issue.description || String(issue)}`)),
                      ].filter(Boolean).join("\n");
                      if (!window.confirm(confirmationText)) {
                        return;
                      }
                    }
                    await runMutation("chapter_review", () => reviewWrite(effectiveProjectId!, {
                      target: "chapter_outline",
                      approved: true,
                      reviewAction: "approve_single",
                      feedback: reviewFeedback.chapter_outline || "",
                      selectedProposalId: candidate.proposalId,
                      authorNotes: reviewFeedback.chapter_outline || "",
                      outlineOptions,
                    }), {
                      onSuccess: () => {
                        setActiveMainSection("write");
                        showToast("细纲已确认，系统正在生成正文。");
                      },
                    });
                  }}
                >
                  {mutationBusy("chapter_review") ? "提交中..." : candidateSelectable ? "直接采用" : "仍然采用"}
                </button>
              </div>
              <div className="candidate-scene-list">
                {(candidate.chapterPlan?.scenes || []).map((scene: any) => (
                  <div className="candidate-scene" key={scene.sceneRef}>
                    <div>
                      <strong>{scene.label}</strong>
                      <p><small>{scene.location}｜{scene.focus}</small></p>
                      <p><small>张力：{scene.tension}｜人物：{(scene.characters || []).join("、")}</small></p>
                    </div>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={mutationBusy()}
                      onClick={() => {
                        setOutlineSceneRefs(chapterId, (current) => (
                          current.includes(scene.sceneRef) ? current : [...current, scene.sceneRef]
                        ));
                      }}
                    >
                      加入最终方案
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ); }) : <div className="empty">当前没有可用的细纲候选。</div>}
        </div>
        <div className="compose-card">
          <strong>最终细纲工作区</strong>
          <p><small>当前已选 {selectedOutlineScenes.length} 个场景片段，可用上下移动顺序并删除不想要的部分。</small></p>
          <div className="compose-list">
            {selectedOutlineScenes.length ? selectedOutlineScenes.map((scene: any, index) => (
              <div className="compose-item" key={scene.sceneRef}>
                <div>
                  <strong>{index + 1}. {scene.label}</strong>
                  <p><small>来源：{scene.proposalId}｜{scene.location}｜{scene.focus}</small></p>
                </div>
                <div className="actions">
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={mutationBusy() || index === 0}
                    onClick={() => {
                      setOutlineSceneRefs(chapterId, (current) => {
                        const next = [...current];
                        [next[index - 1], next[index]] = [next[index], next[index - 1]];
                        return next;
                      });
                    }}
                  >
                    上移
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={mutationBusy() || index === selectedOutlineScenes.length - 1}
                    onClick={() => {
                      setOutlineSceneRefs(chapterId, (current) => {
                        const next = [...current];
                        [next[index + 1], next[index]] = [next[index], next[index + 1]];
                        return next;
                      });
                    }}
                  >
                    下移
                  </button>
                  <button
                    className="button button-danger"
                    type="button"
                    disabled={mutationBusy()}
                    onClick={() => {
                      setOutlineSceneRefs(chapterId, (current) => current.filter((item) => item !== scene.sceneRef));
                    }}
                  >
                    移除
                  </button>
                </div>
              </div>
            )) : <div className="empty">还没有加入任何场景片段。</div>}
          </div>
        </div>
        <div className="actions">
          <button
            className="button button-primary"
            type="button"
            disabled={mutationBusy()}
            onClick={async () => {
              if (!workbench.sceneRefs.length) {
                showToast("先往最终细纲工作区加入至少一个场景片段，再提交组合定稿。");
                return;
              }
              await runMutation("chapter_review", () => reviewWrite(effectiveProjectId!, {
                target: "chapter_outline",
                approved: true,
                reviewAction: "approve_composed",
                feedback: reviewFeedback.chapter_outline || "",
                selectedSceneRefs: workbench.sceneRefs,
                authorNotes: reviewFeedback.chapter_outline || "",
                outlineOptions,
              }), {
                onSuccess: () => {
                  setActiveMainSection("write");
                  showToast("细纲已确认，系统正在生成正文。");
                },
              });
            }}
          >
            {mutationBusy("chapter_review") ? "提交中..." : "组合后定稿"}
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={mutationBusy()}
            onClick={async () => {
              await runMutation("chapter_review", () => reviewWrite(effectiveProjectId!, {
                target: "chapter_outline",
                approved: false,
                reviewAction: "regenerate",
                feedback: reviewFeedback.chapter_outline || "",
                authorNotes: reviewFeedback.chapter_outline || "",
                outlineOptions,
              }), {
                successMessage: "细纲反馈已提交，系统正在重生候选。",
                onSuccess: () => {
                  setActiveMainSection("write");
                },
              });
            }}
          >
            {mutationBusy("chapter_review") ? "提交中..." : "根据反馈重生"}
          </button>
        </div>
      </div>
    );
  };

  const renderChapterReviewBody = () => {
    const validation = pending?.validation || {};
    const reviewState = pending?.reviewState || {};
    const issueCounts = validation.issueCounts || { critical: 0, warning: 0, info: 0 };
    const validationIssues = Array.isArray(validation.issues) ? validation.issues : [];
    const activeDimensions = Array.isArray(validation.activeDimensions) ? validation.activeDimensions : [];
    const auditGroups = Array.isArray(validation.auditGroups) ? validation.auditGroups : [];
    const dimensionMeta = new Map(activeDimensions.map((item: any) => [item.id, item]));
    const manualReviewRequired = Boolean(reviewState.manualReviewRequired);
    const feedbackSupervisionPassed = reviewState.feedbackSupervisionPassed !== false;
    const approvalOverrideRequired = manualReviewRequired || validation?.overallPassed === false || !feedbackSupervisionPassed;
    const semanticAuditSource = validation?.semanticAudit?.source;
    const semanticAuditReason = validation?.semanticAudit?.reason;
    const noAutomatedReview = semanticAuditSource === "skipped" && semanticAuditReason === "manual_direct_edit_no_validation";
    const auditMode = manualReviewRequired
      ? "人工复审中"
      : noAutomatedReview
        ? "未自动审查"
        : semanticAuditSource === "skipped"
        ? "已跳过语义审查"
        : (reviewState.auditDegraded || validation.auditDegraded || semanticAuditSource === "heuristics_only")
        ? "降级审查（heuristics only）"
        : "正常审查";
    const blockingFeedbackIssues = (reviewState.blockingFeedbackIssues || []).filter(Boolean).slice(0, 4);
    const blockingIssues = (reviewState.blockingAuditIssues || []).filter(Boolean).slice(0, 4);
    const feedbackSummary = String(reviewState.feedbackSupervisionSummary || "").trim();
    const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "pending";
    const partialDraft = partialRevisionWorkbenchState[chapterId];
    const directDraft = directEditWorkbenchState[chapterId];
    const directEditActive = Boolean(directDraft?.isEditing);
    const approveLabel = approvalOverrideRequired ? "仍然锁章（未通过审计）" : "批准";
    const auditFlagTone = noAutomatedReview
      ? "is-warning"
      : approvalOverrideRequired
        ? "is-danger"
        : issueCounts.warning
          ? "is-warning"
          : "is-success";
    const auditFlagHeadline = noAutomatedReview
      ? "当前章节未自动审查，请人工确认后决定是否锁章"
      : approvalOverrideRequired
        ? "当前章节尚未通过反馈监督或审计"
        : issueCounts.warning
          ? "当前章节可批准，但仍有 warning"
          : "当前没有阻止通过的 critical 问题";

    const submitChapterReview = async (reviewAction: string, approved: boolean) => {
      if (reviewAction === "partial_rewrite" && !String(partialDraft?.selectedText || "").trim()) {
        showToast("先在正文 body 中框选一段要修改的文本，再提交局部修订。");
        return;
      }

      if (approved && approvalOverrideRequired) {
        const confirmationText = [
          "当前章节审计尚未通过，确认仍要锁章吗？",
          `critical ${validation?.issueCounts?.critical || 0} / warning ${validation?.issueCounts?.warning || 0} / info ${validation?.issueCounts?.info || 0}`,
          ...(blockingIssues.length ? ["未解决问题：", ...blockingIssues.map((item: string) => `- ${item}`)] : []),
        ].join("\n");
        if (!window.confirm(confirmationText)) {
          return;
        }
      }

      await runMutation("chapter_review", () => reviewWrite(effectiveProjectId!, {
        target: "chapter",
        approved,
        feedback: reviewAction === "partial_rewrite" ? partialDraft?.feedback || "" : reviewFeedback.chapter || "",
        reviewAction,
        approvalOverrideAcknowledged: approved && approvalOverrideRequired,
        authorNotes: reviewFeedback.chapter || "",
        outlineOptions,
        selection: reviewAction === "partial_rewrite"
          ? {
            selectedText: partialDraft?.selectedText || "",
            prefixContext: partialDraft?.prefixContext || "",
            suffixContext: partialDraft?.suffixContext || "",
          }
          : null,
      }), {
        successMessage:
          approved
            ? approvalOverrideRequired ? "未通过审计的章节已在显式确认后锁章。" : "审查结果已提交。"
            : reviewAction === "partial_rewrite"
              ? "局部修订意见已提交，系统正在只改选中片段。"
              : "修改意见已提交，系统正在根据反馈重写。",
        onSuccess: () => {
          setActiveMainSection("write");
        },
      });
    };

    return (
      <div className="review-body">
        <p>
          {directEditActive
            ? "当前正在直接编辑正文。请先保存或取消本次手动修改，再继续批准、整章重写或局部修订。"
            : noAutomatedReview
              ? "当前章节在人工直接修改后未自动审查；请人工确认内容是否可锁章，或继续重写。"
            : approvalOverrideRequired
              ? "当前章节仍有未解决问题；你可以继续重写，也可以在显式确认风险后仍然锁章。"
              : "通过后会锁章；如果不满意，你既可以按反馈重写整章，也可以先在上面的正文 body 中框选一个连续片段，只改那一段。"}
        </p>
        <p><small>当前待审章节字数：{pendingChapterWordCount(pending)} 字</small></p>
        <div className={`audit-flag ${auditFlagTone}`}>
          <strong>{auditFlagHeadline}</strong>
          <p><small>审查模式：{auditMode}｜critical {issueCounts.critical || 0} / warning {issueCounts.warning || 0} / info {issueCounts.info || 0}｜manualReviewRequired={manualReviewRequired ? "true" : "false"}</small></p>
          {feedbackSummary ? <p><small>反馈监督：{feedbackSummary}</small></p> : null}
          {blockingFeedbackIssues.length ? <p><small>未落实反馈：{blockingFeedbackIssues.join("；")}</small></p> : null}
          {blockingIssues.length ? <p><small>未解决问题：{blockingIssues.join("；")}</small></p> : null}
        </div>
        {auditGroups.length ? (
          <div className="compose-card">
            <strong>分组审计</strong>
            <p><small>当前正文审计被拆为 3 个并行方向；下面展示每组负责的维度、命中问题数和分组摘要。</small></p>
            <div className="compose-list">
              {auditGroups.map((group: any) => {
                const dimensionIds = Array.isArray(group?.dimensionIds) ? group.dimensionIds : [];
                const groupIssues = validationIssues.filter((issue: any) => dimensionIds.includes(issue?.id));
                const groupCounts = groupIssues.reduce((acc: any, issue: any) => {
                  const severity = String(issue?.severity || "").trim();
                  if (severity in acc) acc[severity] += 1;
                  return acc;
                }, { critical: 0, warning: 0, info: 0 });
                const dimensionLabels = dimensionIds.map((id: string) => {
                  const meta = dimensionMeta.get(id);
                  return meta ? `${id}（${meta.category}）` : id;
                });
                const slotLabel = group?.preferredAgentSlot === "primary" ? "主审计槽" : "辅审计槽";
                const stateLabel = group?.error
                  ? "执行失败"
                  : groupCounts.critical
                    ? "存在 critical"
                    : groupCounts.warning
                      ? "存在 warning"
                      : groupCounts.info
                        ? "仅 info"
                        : "通过";

                return (
                  <div className="compose-item" key={group?.id || group?.label}>
                    <div>
                      <strong>{group?.label || group?.id || "未命名分组"}</strong>
                      <p><small>{slotLabel}｜状态：{stateLabel}｜critical {groupCounts.critical} / warning {groupCounts.warning} / info {groupCounts.info}</small></p>
                      <p><small>负责维度：{dimensionLabels.join("、") || "无"}</small></p>
                      {group?.summary ? <p><small>摘要：{group.summary}</small></p> : null}
                      {group?.error ? <p><small>错误：{group.error}</small></p> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        <textarea
          id="feedback-chapter"
          placeholder="写下你的修改意见，比如要加强哪段冲突、调整节奏、补足人物动机或优化章末牵引。"
          disabled={mutationBusy() || directEditActive}
          value={reviewFeedback.chapter || ""}
          onChange={(event) => {
            setReviewFeedback((current) => ({ ...current, chapter: event.target.value }));
          }}
        />
        <div className="actions">
          <button
            className="button button-primary"
            type="button"
            disabled={mutationBusy() || directEditActive}
            onClick={() => submitChapterReview("approve", true)}
          >
            {mutationBusy("chapter_review") ? "提交中..." : approveLabel}
          </button>
          <button
            className="button button-danger"
            type="button"
            disabled={mutationBusy() || directEditActive}
            onClick={() => submitChapterReview("rewrite", false)}
          >
            {mutationBusy("chapter_review") ? "提交中..." : "根据反馈重写"}
          </button>
        </div>
        <div className="compose-card">
          <strong>局部修订工作区</strong>
          <p><small>{directEditActive ? "当前已切换到正文直接编辑态；如需局部修订，请先保存或取消手动编辑。" : "先在正文预览里直接框选一段连续文本，再写修改意见。系统会只替换这一段，其余正文保持不动。"}</small></p>
          <div className="chapter-selection-preview">{selectionPreviewText(partialDraft) || "当前还没有选中的正文片段。"}</div>
          <textarea
            id="feedback-chapter-partial"
            placeholder="只描述这段该怎么改，比如压紧情绪、改顺动作逻辑、补一句更明确的人物反应。"
            disabled={mutationBusy() || directEditActive}
            value={partialDraft?.feedback || ""}
            onChange={(event) => {
              updatePartialWorkbench(chapterId, { feedback: event.target.value });
            }}
          />
          <div className="actions">
            <button
              className="button button-secondary"
              type="button"
              disabled={mutationBusy() || directEditActive}
              onClick={() => {
                updatePartialWorkbench(chapterId, {
                  selectedText: "",
                  prefixContext: "",
                  suffixContext: "",
                });
              }}
            >
              {directEditActive ? "直接编辑中" : "清除选区"}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={mutationBusy() || directEditActive}
              onClick={() => submitChapterReview("partial_rewrite", false)}
            >
              {mutationBusy("chapter_review") ? "提交中..." : "只改选中部分"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const buildPlanTimelineItems = (): TimelineItemType[] => {
    const run = latestRun(snapshot, "plan");
    const draft = snapshot?.staged?.planDraft as any;
    const finalPlan = snapshot?.staged?.planFinal as any;
    const plan = snapshot?.project?.phase?.plan;
    const unresolvedIssues = draft?.preApprovalCritics?.passed === false ? draft.preApprovalCritics.issues || [] : [];
    const items: TimelineItemType[] = [];

    if (run?.steps?.length) {
      run.steps.forEach((step: any, index: number) => {
        items.push({
          key: `plan-flow-step-${index}`,
          label: step.label || step.id || `方案步骤 ${index + 1}`,
          summary: step.summary || "已完成该步骤。",
          status: step.status || "completed",
          meta: step.preview ? <Badge label="含结果" /> : null,
          body: (
            <div className="timeline-detail-stack">
              {step.preview ? <ArtifactBlock title="步骤预览"><PreformattedBlock value={step.preview} /></ArtifactBlock> : null}
              {renderFlowStepArtifacts("plan", step)}
            </div>
          ),
        });
      });
    }

    if (draft?.outlineMarkdown) {
      items.push({
        key: "plan-flow-draft-outline",
        label: "当前大纲草稿",
        summary: "展示当前 staged 的大纲草稿与人物草稿。",
        status: plan?.status,
        body: (
          <ArtifactList>
            {draft.cast?.length ? <ArtifactBlock title="自动生成人物"><JsonBlock value={draft.cast} /></ArtifactBlock> : null}
            <ArtifactBlock title="大纲草稿"><MarkdownBody value={draft.outlineMarkdown} /></ArtifactBlock>
          </ArtifactList>
        ),
      });
    }

    if (finalPlan?.outlineMarkdown || finalPlan?.structureMarkdown || finalPlan?.worldbuildingMarkdown) {
      items.push({
        key: "plan-flow-final-package",
        label: "完整方案包",
        summary: "当前可锁定的大纲、结构、世界观与角色摘要。",
        status: plan?.status,
        body: (
          <ArtifactList>
            {finalPlan?.outlineMarkdown ? <ArtifactBlock title="完整大纲" tone="success"><MarkdownBody value={finalPlan.outlineMarkdown} /></ArtifactBlock> : null}
            {finalPlan?.structureMarkdown ? <ArtifactBlock title="结构摘要" tone="success"><MarkdownBody value={finalPlan.structureMarkdown} /></ArtifactBlock> : null}
            {finalPlan?.worldbuildingMarkdown ? <ArtifactBlock title="世界观摘要" tone="success"><MarkdownBody value={finalPlan.worldbuildingMarkdown} /></ArtifactBlock> : null}
            {finalPlan?.characters?.length ? <ArtifactBlock title="角色摘要" tone="success"><MarkdownBody value={summarizePlanCharacters(finalPlan.characters || [])} /></ArtifactBlock> : null}
            {unresolvedIssues.length ? <ArtifactBlock title="自动预审遗留问题" tone="warning"><MarkdownBody value={unresolvedIssues.map((item: string, index: number) => `${index + 1}. ${item}`).join("\n")} /></ArtifactBlock> : null}
          </ArtifactList>
        ),
      });
    }

    if (plan?.pendingReview?.target === "plan_draft") {
      items.push({
        key: "plan-flow-review-draft",
        label: "大纲草稿审查",
        summary: "这是旧流程兼容节点。批准后系统会先补齐完整方案包，再进入最终审阅。",
        status: "pending_review",
        body: renderPlanReviewBody("plan_draft", "这是旧流程兼容节点。批准后系统会先补齐完整方案包，再进入最终审阅。"),
        defaultExpanded: true,
      });
    }

    if (plan?.pendingReview?.target === "plan_final") {
      items.push({
        key: "plan-flow-review-final",
        label: "最终大纲审查",
        summary: unresolvedIssues.length
          ? "自动评审器已连续多轮回炉，但仍保留少量问题。你可以直接批准锁定，也可以填写人类反馈继续重写。"
          : "这里是单次终审节点。批准后只会执行本地锁定与提交，不再触发新的自动评审或自动改写。",
        status: "pending_review",
        body: renderPlanReviewBody(
          "plan_final",
          unresolvedIssues.length
            ? "自动评审器已连续多轮回炉，但仍保留少量问题。你可以直接批准锁定，也可以填写人类反馈继续重写。"
            : "这里是单次终审节点。批准后只会执行本地锁定与提交，不再触发新的自动评审或自动改写。",
        ),
        defaultExpanded: true,
      });
    }

    return items;
  };

  const buildWriteTimelineItems = (): TimelineItemType[] => {
    const write = snapshot?.project?.phase?.write;
    const chapterParts = pending?.chapterMarkdown
      ? splitChapterMarkdownForReview(pending.chapterMarkdown, pending?.chapterPlan?.title || "")
      : null;
    const items: TimelineItemType[] = [];
    const chapterId = activeWriteChapterId(snapshot, pending);
    const run = latestWriteRunForChapter(snapshot, chapterId);
    const directEditMode = Boolean(directEditWorkbenchState[chapterId]?.isEditing);

    if (run?.steps?.length) {
      run.steps.forEach((step: any, index: number) => {
        items.push({
          key: `write-flow-step-${index}`,
          label: step.label || step.id || `写作步骤 ${index + 1}`,
          summary: step.summary || "已完成该步骤。",
          status: step.status || "completed",
          meta: step.preview ? <Badge label="含结果" /> : null,
          body: (
            <div className="timeline-detail-stack">
              {step.preview ? <ArtifactBlock title="步骤预览"><PreformattedBlock value={step.preview} /></ArtifactBlock> : null}
              {renderFlowStepArtifacts("write", step)}
            </div>
          ),
        });
      });
    }

    if (pending?.chapterOutlineContext) {
      items.push({
        key: "write-flow-outline-package",
        label: "章节细纲上下文包",
        summary: "展示当前章节细纲生成阶段可用的上下文与候选方案。",
        status: write?.status,
        body: (
          <ArtifactList>
            {pending.chapterOutlineContext?.briefingMarkdown
              ? <ArtifactBlock title="细纲上下文"><MarkdownBody value={pending.chapterOutlineContext.briefingMarkdown} /></ArtifactBlock>
              : <ArtifactBlock title="细纲上下文"><JsonBlock value={pending.chapterOutlineContext} /></ArtifactBlock>}
            {pending.chapterOutlineCandidates?.length
              ? <ArtifactBlock title="细纲候选"><JsonBlock value={pending.chapterOutlineCandidates} /></ArtifactBlock>
              : null}
          </ArtifactList>
        ),
      });
    }

    if (pending?.writerContext || pending?.factContext || pending?.retrieval || pending?.referencePacket || pending?.researchPacket) {
      items.push({
        key: "write-flow-context-package",
        label: "写作上下文包",
        summary: "展示写作阶段可消费的上下文、事实、历史、范文与研究资料。",
        status: write?.status,
        body: (
          <ArtifactList>
            {pending.writerContext ? <ArtifactBlock title="写作上下文"><JsonBlock value={pending.writerContext} /></ArtifactBlock> : null}
            {pending.factContext ? <ArtifactBlock title="事实上下文"><JsonBlock value={pending.factContext} /></ArtifactBlock> : null}
            {pending.retrieval ? <ArtifactBlock title="历史检索"><JsonBlock value={pending.retrieval} /></ArtifactBlock> : null}
            {pending.referencePacket ? <ArtifactBlock title="参考资料包"><JsonBlock value={pending.referencePacket} /></ArtifactBlock> : null}
            {pending.researchPacket ? <ArtifactBlock title="研究资料包"><JsonBlock value={pending.researchPacket} /></ArtifactBlock> : null}
          </ArtifactList>
        ),
      });
    }

    if (pending?.chapterMarkdown) {
      items.push({
        key: "write-flow-draft",
        label: chapterParts?.title || pending?.chapterPlan?.title || "章节正文草稿",
        summary: directEditMode
          ? "当前处于人工直接编辑态，保存后会重新校验章节，并退出可修改状态。"
          : "正文 body 支持直接框选，也支持进入直接编辑；章节标题不会被纳入修改范围。",
        status: write?.status,
        body: (
          <ArtifactList>
            <ArtifactBlock title="章节正文" tone="warning">
              <p><small>当前草稿字数：{pendingChapterWordCount(pending)} 字</small></p>
              <div className="actions" style={{ marginTop: 12 }}>
                {directEditMode ? (
                  <>
                    <button
                      className="button button-primary"
                      type="button"
                      disabled={mutationBusy()}
                      onClick={async () => {
                        const nextBody = String(directEditWorkbenchState[chapterId]?.draftBody || "").replace(/\r\n?/g, "\n");
                        const currentBody = chapterBodyFromPending(pending);
                        if (!nextBody.trim()) {
                          showToast("章节正文不能为空。");
                          return;
                        }
                        if (nextBody === currentBody) {
                          updateDirectEditWorkbench(chapterId, {
                            isEditing: false,
                            sourceBody: currentBody,
                            draftBody: currentBody,
                          });
                          showToast("正文没有变化。");
                          return;
                        }
                        await runMutation("chapter_manual_edit", () => saveManualChapterEdit(effectiveProjectId!, nextBody), {
                          successMessage: "正文修改已保存。",
                          onSuccess: () => {
                            const nextPending = queryClient.getQueryData<any>(["workspace-state", effectiveProjectId])?.state?.staged?.pendingChapter || pending;
                            const nextBodyValue = chapterBodyFromPending(nextPending);
                            updateDirectEditWorkbench(chapterId, {
                              isEditing: false,
                              sourceBody: nextBodyValue,
                              draftBody: nextBodyValue,
                            });
                          },
                        });
                      }}
                    >
                      {mutationBusy("chapter_manual_edit") ? "保存中..." : "保存正文"}
                    </button>
                    <button
                      className="button button-ghost"
                      type="button"
                      disabled={mutationBusy()}
                      onClick={() => {
                        updateDirectEditWorkbench(chapterId, {
                          isEditing: false,
                          sourceBody: chapterBodyFromPending(pending),
                          draftBody: chapterBodyFromPending(pending),
                        });
                      }}
                    >
                      取消编辑
                    </button>
                  </>
                ) : (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={mutationBusy()}
                    onClick={() => {
                      updateDirectEditWorkbench(chapterId, {
                        isEditing: true,
                        sourceBody: chapterBodyFromPending(pending),
                        draftBody: chapterBodyFromPending(pending),
                      });
                      updatePartialWorkbench(chapterId, {
                        selectedText: "",
                        prefixContext: "",
                        suffixContext: "",
                      });
                    }}
                  >
                    直接修改正文
                  </button>
                )}
              </div>
              <ChapterBody
                chapterId={chapterId}
                body={directEditMode ? directEditWorkbenchState[chapterId]?.draftBody || "" : chapterParts?.body || ""}
                editable={directEditMode}
                onInput={(value) => {
                  updateDirectEditWorkbench(chapterId, { draftBody: value });
                }}
                onSelectionCapture={captureChapterSelection}
              />
            </ArtifactBlock>
          </ArtifactList>
        ),
      });
    }

    if (pending?.sceneDrafts?.length || pending?.validation) {
      items.push({
        key: "write-flow-audit",
        label: "场景与审计结果",
        summary: pending?.validation?.summary || "展示当前章节的场景草案与验证结果。",
        status: write?.status,
        body: (
          <ArtifactList>
            {pending.sceneDrafts?.length ? <ArtifactBlock title="场景草案"><JsonBlock value={pending.sceneDrafts} /></ArtifactBlock> : null}
            {pending.validation ? <ArtifactBlock title="验证结果" tone={pillTone(write?.status)}><JsonBlock value={pending.validation} /></ArtifactBlock> : null}
            {(pending.auditDrift?.markdown || pending.validation?.auditDrift?.markdown)
              ? <ArtifactBlock title="漂移提示" tone={pillTone(write?.status)}><MarkdownBody value={pending.auditDrift?.markdown || pending.validation.auditDrift.markdown} /></ArtifactBlock>
              : null}
          </ArtifactList>
        ),
      });
    }

    if (write?.pendingReview?.target === "chapter_outline") {
      items.push({
        key: "write-flow-review-outline",
        label: "章节细纲审查",
        summary: "先确认章节细纲，再进入正文生成。",
        status: "pending_review",
        body: renderChapterOutlineReviewBody(),
        defaultExpanded: true,
      });
    }

    if (write?.pendingReview?.target === "chapter") {
      items.push({
        key: "write-flow-review-chapter",
        label: "章节审查",
        summary: "审阅当前章节正文，决定锁章、整章重写或局部修订。",
        status: "pending_review",
        body: renderChapterReviewBody(),
        defaultExpanded: true,
      });
    }

    return items;
  };

  const planTimelineItems = buildPlanTimelineItems();
  const writeTimelineItems = buildWriteTimelineItems();

  const appShellClassName = [
    "app-shell",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    utilityCollapsed ? "utility-collapsed" : "",
    activeSideTab === "resources" && !utilityCollapsed ? "utility-expanded" : "",
  ].filter(Boolean).join(" ");

  return (
    <>
      <div className={appShellClassName}>
        {renderWorkspaceSidebar({
          activeMainSection,
          activeProjectSummary,
          mobileSidebarOpen,
          mutationBusy,
          projects,
          selectedProjectId: effectiveProjectId,
          sidebarCollapsed,
          onCreateProject: async () => {
            const name = String((document.querySelector("#new-project-name") as HTMLInputElement | null)?.value || "新项目").trim() || "新项目";
            await runMutation("project_create", () => createProject(name), {
              successMessage: `项目“${name}”已创建。`,
              onSuccess: () => {
                setSelectedDocumentPath(null);
                setMobileSidebarOpen(false);
              },
            });
          },
          onJumpMainSection: (section) => {
            setActiveMainSection(section);
            setMobileSidebarOpen(false);
          },
          onDeleteProject: async (project) => {
            if (mutationBusy()) {
              showToast("已有请求正在处理中，请稍候。");
              return;
            }
            const confirmed = window.confirm(`确定要删除项目“${project.title}”吗？该项目目录及其运行数据会被一并删除。`);
            if (!confirmed) {
              return;
            }
            await runMutation("project_delete", () => deleteProject(project.id), {
              successMessage: `项目“${project.title}”已删除。`,
              onSuccess: () => {
                setSelectedDocumentPath(null);
                setMobileSidebarOpen(false);
              },
            });
          },
          onSelectProject: async (projectId) => {
            if (mutationBusy()) {
              showToast("已有请求正在处理中，请稍候。");
              return;
            }
            if (projectId === effectiveProjectId) {
              setMobileSidebarOpen(false);
              return;
            }
            setSelectedProjectId(projectId);
            setSelectedDocumentPath(null);
            setMobileSidebarOpen(false);
          },
          onToggleSidebar: () => {
            setSidebarCollapsed(!sidebarCollapsed);
          },
        })}

        <main className="playground-shell">
          {snapshot ? (
            <>
              <section className={`playground-header ${activeMainSection === "overview" ? "is-home" : ""}`}>
                {activeMainSection === "overview" ? null : (
                  <div className="playground-title-block">
                    <div className="eyebrow">项目工作台</div>
                    <h1>{currentProject?.title}</h1>
                    <p>{currentProject?.genre || "未填写类型"} · {currentProject?.setting || "未填写设定"}</p>
                  </div>
                )}
                <div className="playground-header-actions">
                  <button className="button button-ghost mobile-only" type="button" onClick={() => setMobileSidebarOpen(true)}>项目栏</button>
                  <button className="button button-ghost mobile-only" type="button" onClick={() => setMobileUtilityOpen(true)}>右侧面板</button>
                </div>
                <div className={`playground-status-grid ${activeMainSection === "overview" ? "is-home" : ""}`}>
                  <div className="status-summary-card">
                    <span className="eyebrow">当前状态</span>
                    <div className="pill-row">
                      <Pill label="方案" value={humanPhaseStatus(snapshot.project.phase.plan.status)} toneValue={snapshot.project.phase.plan.status} />
                      <Pill label="已锁定章节" value={String(snapshot.project.phase.write.currentChapterNumber || 0)} />
                    </div>
                  </div>
                  <div className="status-summary-card">
                    <span className="eyebrow">下一动作</span>
                    <p>{nextActionText(snapshot)}</p>
                  </div>
                  <div className="status-summary-card">
                    <span className="eyebrow">待审节点</span>
                    <p>{pendingReviewText(snapshot)}</p>
                  </div>
                </div>
                <div className={`playground-subnav ${activeMainSection === "overview" ? "is-home" : ""}`}>
                  {MAIN_SECTIONS.map((section) => (
                    <button
                      key={section}
                      className={`subnav-button ${activeMainSection === section ? "is-active" : ""}`}
                      type="button"
                      onClick={() => setActiveMainSection(section)}
                    >
                      {humanMainSectionLabel(section)}
                    </button>
                  ))}
                </div>
              </section>

              {renderMainContent({
                activeMainSection,
                effectiveProjectId,
                mutationBusy,
                currentStyle,
                outlineOptions,
                pending,
                planTimelineItems,
                reviewFeedback,
                selectedOutlineScenes,
                snapshot,
                writeTimelineItems,
                onJumpMainSection: setActiveMainSection,
                onOutlineOptionsChange: setOutlineOptions,
                onPlanRun: async () => {
                  await runMutation("plan_run", () => runPlan(effectiveProjectId!), {
                    successMessage: "方案阶段已推进。",
                    onSuccess: () => setActiveMainSection("plan"),
                  });
                },
                onWriteRun: async () => {
                  await runMutation("write_run", () => runWrite(effectiveProjectId!, outlineOptions), {
                    successMessage: "章节细纲候选已生成。",
                    onSuccess: () => setActiveMainSection("write"),
                  });
                },
                onDeleteLockedChapter: async (chapterId: string) => {
                  const confirmed = window.confirm(`确定删除已锁定章节 ${chapterId} 吗？当前只允许按倒序删除最新锁定章节。`);
                  if (!confirmed) {
                    return;
                  }
                  await runMutation("chapter_delete", () => deleteLockedChapter(effectiveProjectId!, chapterId), {
                    successMessage: `${chapterId} 已删除。`,
                    });
                  },
                onOpenUtilityTab: (tab) => {
                  setActiveSideTab(tab);
                  setMobileUtilityOpen(true);
                },
                isSectionExpanded: sectionExpanded,
                onToggleSection: toggleSection,
                onExpandFlow: expandFlow,
                onCollapseFlow: collapseFlow,
              })}
            </>
          ) : (
            <section className="playground-panel empty-state-panel">
              <div className="empty">{projects.length ? "请选择一个项目进入工作区。" : "当前还没有项目，先新建一个项目吧。"}</div>
            </section>
          )}
        </main>

        {renderUtilityTabs({
          activeProjectId: effectiveProjectId,
          activeSideTab,
          currentProject,
          mobileUtilityOpen,
          mutationBusy,
          providerDraft,
          providerRuntime,
          projectDraft,
          projectStyleDraft,
          ragCreateName,
          selectedOpeningIds,
          selectedRagIds,
          selectedStyleFingerprintId,
          setActiveSideTab,
          setMobileUtilityOpen,
          setOpeningCreateName,
          setProjectDraft,
          setProjectStyleDraft,
          setProviderDraft,
          setRagCreateName,
          setSelectedOpeningIds,
          setSelectedRagIds,
          setSelectedStyleFingerprintId,
          setStyleEditDraft,
          setStyleGenerateDraft,
          snapshot,
          styleEditDraft,
          styleFingerprintDetail: styleFingerprintQuery.data?.styleFingerprint,
          styleFingerprintError: styleFingerprintQuery.error as any,
          styleFingerprintLoading: styleFingerprintQuery.isLoading,
          styleGenerateDraft,
          syncProviderDraftFromSelection,
          utilityCollapsed,
          onCloseOverlays: () => {
            setMobileSidebarOpen(false);
            setMobileUtilityOpen(false);
          },
          onToggleUtilityPanel: () => {
            setUtilityCollapsed(!utilityCollapsed);
          },
          onCreateOpeningCollection: async () => {
            const name = openingCreateName.trim() || "新开头参考库";
            await runMutation("opening_create", () => createOpeningCollection(effectiveProjectId!, name), {
              successMessage: "黄金三章参考库已创建。",
              onSuccess: () => setOpeningCreateName(""),
            });
          },
          onCreateRagCollection: async () => {
            const name = ragCreateName.trim() || "新范文库";
            await runMutation("rag_create", () => createRagCollection(effectiveProjectId!, name), {
              successMessage: "共享范文库已创建。",
              onSuccess: () => setRagCreateName(""),
            });
          },
          onGenerateStyleFingerprint: async () => {
            await runMutation("style_generate", () => generateStyleFingerprint(effectiveProjectId!, styleGenerateDraft), {
              successMessage: "风格指纹已生成。",
              onSuccess: (data) => {
                setSelectedStyleFingerprintId(data?.styleFingerprint?.metadata?.id || selectedStyleFingerprintId);
                setStyleGenerateDraft({ name: "", sampleText: "" });
              },
            });
          },
          onProjectOpeningSave: async () => {
            await runMutation("project_opening_save", () => saveProjectOpeningBindings(effectiveProjectId!, { openingCollectionIds: selectedOpeningIds }), {
              successMessage: "项目黄金三章参考绑定已保存。",
            });
          },
          onProjectRagSave: async () => {
            await runMutation("project_rag_save", () => saveProjectRagBindings(effectiveProjectId!, { ragCollectionIds: selectedRagIds }), {
              successMessage: "项目范文库绑定已保存。",
            });
          },
          onProjectSave: async () => {
            await runMutation("project_save", () => saveProject(effectiveProjectId!, projectDraft), {
              successMessage: "项目设定已保存。",
            });
          },
          onProviderSave: async () => {
            await runMutation("provider_save", () => saveProviderConfig(effectiveProjectId!, providerDraft), {
              successMessage: "模型配置已写入 novelex.codex.toml。",
            });
          },
          onProjectStyleClear: async () => {
            await runMutation("project_style_save", () => saveProjectStyle(effectiveProjectId!, ""), {
              successMessage: "已回退到默认章节风格。",
            });
          },
          onProjectStyleSave: async () => {
            await runMutation("project_style_save", () => saveProjectStyle(effectiveProjectId!, projectStyleDraft), {
              successMessage: projectStyleDraft ? "章节风格选择已保存。" : "已清空章节风格选择。",
            });
          },
          onRebuildOpeningCollection: async (collectionId: string) => {
            await runMutation("opening_rebuild", () => rebuildOpeningCollection(effectiveProjectId!, collectionId), {
              successMessage: "黄金三章参考索引已重建。",
            });
          },
          onRebuildRagCollection: async (collectionId: string) => {
            await runMutation("rag_rebuild", () => rebuildRagCollection(effectiveProjectId!, collectionId), {
              successMessage: "RAG 索引已重建。",
            });
          },
          onStyleEditSave: async () => {
            await runMutation("style_update", () => updateStyleFingerprint(effectiveProjectId!, styleEditDraft), {
              successMessage: "风格指令已保存。",
            });
          },
        })}

        <div className={`shell-overlay ${mobileSidebarOpen || mobileUtilityOpen ? "is-visible" : ""}`} onClick={() => {
          setMobileSidebarOpen(false);
          setMobileUtilityOpen(false);
        }} />
      </div>
      <div className={`toast ${toast.visible ? "visible" : ""}`}>{toast.message}</div>
    </>
  );
}

function ChapterBody(props: {
  chapterId: string;
  body: string;
  editable?: boolean;
  onInput?: (value: string) => void;
  onSelectionCapture?: (container: HTMLDivElement) => void;
}) {
  if (props.editable) {
    return (
      <textarea
        className="chapter-body-selectable chapter-body-editor is-editing"
        data-chapter-id={props.chapterId}
        spellCheck={false}
        value={props.body}
        onChange={(event) => {
          props.onInput?.(event.target.value.replace(/\r\n?/g, "\n"));
        }}
      />
    );
  }

  return (
    <div
      className="chapter-body-selectable"
      data-chapter-id={props.chapterId}
      data-chapter-body-selectable="true"
      tabIndex={0}
      onMouseUp={(event) => {
        const container = event.currentTarget;
        window.setTimeout(() => {
          props.onSelectionCapture?.(container);
        }, 0);
      }}
      onKeyUp={(event) => {
        const container = event.currentTarget;
        window.setTimeout(() => {
          props.onSelectionCapture?.(container);
        }, 0);
      }}
    >
      {props.body}
    </div>
  );
}

function renderTimeline(props: {
  prefix: string;
  items: TimelineItemType[];
  emptyMessage: string;
  isSectionExpanded: (key: string, defaultExpanded?: boolean) => boolean;
  onToggleSection: (key: string, defaultExpanded?: boolean) => void;
  onExpandFlow: (prefix: string, keys: string[]) => void;
  onCollapseFlow: (prefix: string, keys: string[]) => void;
}) {
  return (
    <div className="timeline-shell">
      <div className="timeline-actions">
        <button className="button button-ghost" type="button" onClick={() => props.onExpandFlow(props.prefix, props.items.map((item) => item.key))}>展开全部</button>
        <button className="button button-ghost" type="button" onClick={() => props.onCollapseFlow(props.prefix, props.items.map((item) => item.key))}>收起全部</button>
      </div>
      {props.items.length ? (
        <div className="timeline" data-flow-key-prefix={props.prefix}>
          {props.items.map((item, index) => (
            <TimelineItem
              key={item.key}
              expanded={props.isSectionExpanded(item.key, item.defaultExpanded)}
              item={item}
              isLast={index === props.items.length - 1}
              onToggleSection={props.onToggleSection}
            />
          ))}
        </div>
      ) : (
        <div className="empty">{props.emptyMessage}</div>
      )}
    </div>
  );
}

function TimelineItem(props: {
  expanded: boolean;
  item: TimelineItemType;
  isLast: boolean;
  onToggleSection: (key: string, defaultExpanded?: boolean) => void;
}) {
  return (
    <div className={`timeline-item ${props.expanded ? "is-expanded" : ""}`}>
      <div className="timeline-rail">
        <span className="timeline-dot" data-tone={pillTone(props.item.status)} />
        {props.isLast ? null : <span className="timeline-line" />}
      </div>
      <div className="timeline-card">
        <div className="timeline-head">
          <div className="timeline-title-wrap">
            <div className="timeline-title-row">
              <strong>{props.item.label}</strong>
              {props.item.meta ? <span className="timeline-inline-meta">{props.item.meta}</span> : null}
            </div>
            <p className="timeline-summary">{props.item.summary || "-"}</p>
          </div>
          <button
            className="button button-ghost button-collapse"
            type="button"
            aria-expanded={props.expanded}
            onClick={() => {
              props.onToggleSection(props.item.key, props.item.defaultExpanded);
            }}
          >
            {props.expanded ? "隐藏" : "展开"}
          </button>
        </div>
        <div className="timeline-body">{props.item.body}</div>
      </div>
    </div>
  );
}

function renderMainContent(props: {
  activeMainSection: MainSection;
  effectiveProjectId: string | null;
  mutationBusy: (action?: MutationAction | null) => boolean;
  currentStyle: StyleFingerprintSummary | null;
  outlineOptions: OutlineOptions;
  pending: any;
  planTimelineItems: TimelineItemType[];
  reviewFeedback: Record<string, string>;
  selectedOutlineScenes: any[];
  snapshot: WorkspaceSnapshot;
  writeTimelineItems: TimelineItemType[];
  onJumpMainSection: (section: MainSection) => void;
  onOpenUtilityTab: (tab: SideTab) => void;
  onOutlineOptionsChange: (value: OutlineOptions) => void;
  onPlanRun: () => void;
  onWriteRun: () => void;
  onDeleteLockedChapter: (chapterId: string) => void;
  isSectionExpanded: (key: string, defaultExpanded?: boolean) => boolean;
  onToggleSection: (key: string, defaultExpanded?: boolean) => void;
  onExpandFlow: (prefix: string, keys: string[]) => void;
  onCollapseFlow: (prefix: string, keys: string[]) => void;
}) {
  const project = props.snapshot.project.project;
  const plan = props.snapshot.project.phase.plan;
  const write = props.snapshot.project.phase.write;
  const planRun = latestRun(props.snapshot, "plan");
  const writeRun = latestRun(props.snapshot, "write");
  const pending = pendingReview(props.snapshot);
  const styleName = props.currentStyle?.name || "未绑定";

  if (props.activeMainSection === "plan") {
    return (
      <section className="playground-panel">
        <div className="panel-header">
          <div>
            <div className="eyebrow">方案阶段</div>
            <h2>大纲协作流程</h2>
          </div>
          <div className="actions">
            <button
              className="button button-secondary"
              type="button"
              disabled={props.mutationBusy() || plan.status === "draft_pending_review" || plan.status === "final_pending_review" || plan.status === "locked"}
              onClick={props.onPlanRun}
            >
              {props.mutationBusy("plan_run") ? "处理中..." : "推进方案阶段"}
            </button>
          </div>
        </div>
        <div className="metrics">
          <div className="metric"><span>当前状态</span><strong>{humanPhaseStatus(plan.status)}</strong></div>
          <div className="metric"><span>最近运行</span><strong>{plan.lastRunId || "暂无"}</strong></div>
          <div className="metric"><span>锁定时间</span><strong>{plan.lockedAt || "未锁定"}</strong></div>
        </div>
        {renderTimeline({
          prefix: "plan-flow",
          items: props.planTimelineItems,
          emptyMessage: "尚未运行方案阶段。点击“推进方案阶段”后，系统会先生成完整方案包，再等待你做一次性终审。",
          isSectionExpanded: props.isSectionExpanded,
          onToggleSection: props.onToggleSection,
          onExpandFlow: props.onExpandFlow,
          onCollapseFlow: props.onCollapseFlow,
        })}
      </section>
    );
  }

  if (props.activeMainSection === "write") {
    const enabled = props.snapshot.project.phase.plan.status === "locked";
    return (
      <section className="playground-panel">
        <div className="panel-header">
          <div>
            <div className="eyebrow">写作阶段</div>
            <h2>章节写作流程</h2>
          </div>
          <div className="actions">
            <label className="field compact-field">
              <span>方案数</span>
              <select
                value={props.outlineOptions.variantCount}
                disabled={props.mutationBusy() || !enabled}
                onChange={(event) => props.onOutlineOptionsChange({
                  ...props.outlineOptions,
                  variantCount: Number(event.target.value || 3),
                })}
              >
                {[2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
            </label>
            <label className="field compact-field">
              <span>发散度</span>
              <select
                value={props.outlineOptions.diversityPreset}
                disabled={props.mutationBusy() || !enabled}
                onChange={(event) => props.onOutlineOptionsChange({
                  ...props.outlineOptions,
                  diversityPreset: event.target.value || "wide",
                })}
              >
                <option value="standard">{humanDiversityPreset("standard")}</option>
                <option value="wide">{humanDiversityPreset("wide")}</option>
              </select>
            </label>
            <button
              className="button button-secondary"
              type="button"
              disabled={props.mutationBusy() || !enabled || write.status === "chapter_pending_review" || write.status === "chapter_outline_pending_review"}
              onClick={props.onWriteRun}
            >
              {props.mutationBusy("write_run") ? "生成中..." : "生成下一章细纲"}
            </button>
          </div>
        </div>
        <div className="metrics">
          <div className="metric"><span>当前状态</span><strong>{humanPhaseStatus(write.status)}</strong></div>
          <div className="metric"><span>已锁定章节</span><strong>{String(write.currentChapterNumber || 0)}</strong></div>
          <div className="metric"><span>最近运行</span><strong>{write.lastRunId || "暂无"}</strong></div>
        </div>
        {enabled ? null : <div className="empty" style={{ marginTop: 16 }}>需要先锁定完整大纲，写作阶段才会开放。</div>}
        {renderTimeline({
          prefix: "write-flow",
          items: enabled ? props.writeTimelineItems : [],
          emptyMessage: "章节细纲、正文、审计和审查节点会在这里沿流程展开。",
          isSectionExpanded: props.isSectionExpanded,
          onToggleSection: props.onToggleSection,
          onExpandFlow: props.onExpandFlow,
          onCollapseFlow: props.onCollapseFlow,
        })}
      </section>
    );
  }

  if (props.activeMainSection === "chapters") {
    const chapters = props.snapshot.chapters || [];
    const latestChapterId = chapters.at(-1)?.chapter_id || "";
    const writePending = Boolean(props.snapshot.project?.phase?.write?.pendingReview?.chapterId);
    return (
      <section className="playground-panel">
        <div className="panel-header">
          <div>
            <div className="eyebrow">章节目录</div>
            <h2>已锁定章节</h2>
          </div>
        </div>
        <div className="chapter-list">
          {chapters.length ? chapters.map((chapter) => (
            <LockedChapterCard
              key={`chapter-${chapter.chapter_id}`}
              chapter={chapter}
              isLatest={chapter.chapter_id === latestChapterId}
              mutationBusy={props.mutationBusy}
              projectId={props.effectiveProjectId}
              writePending={writePending}
              onDeleteLockedChapter={props.onDeleteLockedChapter}
            />
          )) : <div className="empty">还没有锁定的章节。</div>}
        </div>
      </section>
    );
  }

  return (
    <div className="playground-stack overview-stack">
      <section className="claude-home">
        <h2>{project.title}</h2>
        <p>{project.premise || "从这里进入你的小说工作台，推进大纲、写作与审查流程。"}</p>
      </section>
      <section className="playground-panel overview-secondary-panel">
        <div className="overview-grid">
          <div className="overview-card">
            <span className="eyebrow">作品信息</span>
            <h3>{project.title}</h3>
            <p>{project.genre || "未填写类型"} · {project.setting || "未填写设定"}</p>
          </div>
          <div className="overview-card">
            <span className="eyebrow">风格与资源</span>
            <h3>{styleName}</h3>
            <p>风格指纹 {styleName}，范文库 {String((project.ragCollectionIds || []).length)} 个，黄金三章参考 {String((project.openingCollectionIds || []).length)} 个。</p>
          </div>
          <div className="overview-card">
            <span className="eyebrow">当前待审</span>
            <h3>{pending ? (pending.target === "chapter_outline" ? "细纲待审" : pending.target === "chapter" ? "正文待审" : "大纲待审") : "暂无"}</h3>
            <p>{pendingReviewText(props.snapshot)}</p>
          </div>
        </div>
        <div className="overview-metrics">
          <div className="metric"><span>方案阶段</span><strong>{humanPhaseStatus(plan.status)}</strong></div>
          <div className="metric"><span>写作阶段</span><strong>{humanPhaseStatus(write.status)}</strong></div>
          <div className="metric"><span>目标章节</span><strong>{String(project.totalChapters || "-")}</strong></div>
          <div className="metric"><span>单章目标字数</span><strong>{String(project.targetWordsPerChapter || "-")}</strong></div>
        </div>
        <div className="overview-list">
          <div className="overview-list-item">
            <strong>最近方案运行</strong>
            <p>{planRun?.summary || "还没有方案运行记录。"}</p>
          </div>
          <div className="overview-list-item">
            <strong>最近写作运行</strong>
            <p>{writeRun?.summary || "还没有写作运行记录。"}</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function renderWorkspaceSidebar(props: {
  activeMainSection: MainSection;
  activeProjectSummary: ProjectSummary | null;
  mobileSidebarOpen: boolean;
  mutationBusy: (action?: MutationAction | null) => boolean;
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  sidebarCollapsed: boolean;
  onCreateProject: () => void;
  onDeleteProject: (project: ProjectSummary) => void;
  onJumpMainSection: (section: MainSection) => void;
  onSelectProject: (projectId: string) => void;
  onToggleSidebar: () => void;
}) {
  return (
    <aside className={`workspace-sidebar ${props.sidebarCollapsed ? "is-collapsed" : ""} ${props.mobileSidebarOpen ? "is-mobile-open" : ""}`}>
      <div className="sidebar-inner">
        <div className="sidebar-brand">
          <button className="brand-mark" type="button" onClick={() => props.onJumpMainSection("overview")} title="回到总览">N</button>
          <div className="brand-copy">
            <strong>Novelex</strong>
            <span>{props.activeProjectSummary?.title || "小说工作台"}</span>
          </div>
          <button
            className="sidebar-toggle"
            type="button"
            aria-expanded={!props.sidebarCollapsed}
            title={props.sidebarCollapsed ? "展开项目栏" : "收起项目栏"}
            onClick={props.onToggleSidebar}
          >
            {renderIcon(props.sidebarCollapsed ? "chevronRight" : "chevronLeft")}
          </button>
        </div>
        <div className="sidebar-section sidebar-nav">
          <SidebarNavButton active={props.activeMainSection === "overview"} icon="overview" label="总览" onClick={() => props.onJumpMainSection("overview")} />
          <SidebarNavButton active={props.activeMainSection === "plan"} icon="outline" label="大纲流程" onClick={() => props.onJumpMainSection("plan")} />
          <SidebarNavButton active={props.activeMainSection === "write"} icon="write" label="写作流程" onClick={() => props.onJumpMainSection("write")} />
          <SidebarNavButton active={props.activeMainSection === "chapters"} icon="chapters" label="章节" onClick={() => props.onJumpMainSection("chapters")} />
        </div>
        <div className="sidebar-section">
          <div className="sidebar-section-head">
            <span className="eyebrow">项目列表</span>
            {props.activeProjectSummary ? <span className="sidebar-meta">{props.projects.length} 个项目</span> : null}
          </div>
          <div className="sidebar-project-list">
            {props.projects.length ? props.projects.map((project) => {
              const active = project.id === props.selectedProjectId;
              return (
                <div className={`sidebar-project ${active ? "is-active" : ""}`} key={project.id}>
                  <button
                    className="sidebar-project-select"
                    type="button"
                    onClick={() => props.onSelectProject(project.id)}
                  >
                    <div className="sidebar-project-main">
                      <strong>{props.sidebarCollapsed ? (project.title || project.id).slice(0, 1) : project.title || project.id}</strong>
                      {props.sidebarCollapsed ? null : <span>{project.id}</span>}
                    </div>
                    {props.sidebarCollapsed ? null : (
                      <div className="sidebar-project-state">
                        <Badge label={`${humanPhaseName("plan")} ${humanPhaseStatus(project.planStatus)}`} tone={pillTone(project.planStatus)} />
                        <Badge label={`${humanPhaseName("write")} ${humanPhaseStatus(project.writeStatus)}`} tone={pillTone(project.writeStatus)} />
                      </div>
                    )}
                  </button>
                  {props.sidebarCollapsed ? null : (
                    <button
                      className="sidebar-project-delete"
                      type="button"
                      disabled={props.mutationBusy()}
                      onClick={() => props.onDeleteProject(project)}
                    >
                      {props.mutationBusy("project_delete") ? "删除中..." : "删除"}
                    </button>
                  )}
                </div>
              );
            }) : <div className="empty compact">当前还没有项目。</div>}
          </div>
        </div>
        <div className="sidebar-section sidebar-create">
          <div className="sidebar-section-head">
            <span className="eyebrow">创建项目</span>
          </div>
          <div className="sidebar-create-row">
            <input id="new-project-name" placeholder={props.sidebarCollapsed ? "新项目" : "新建一个项目"} disabled={props.mutationBusy()} />
            <button className="button button-primary" type="button" disabled={props.mutationBusy()} onClick={props.onCreateProject}>
              {props.mutationBusy("project_create") ? "创建中..." : props.sidebarCollapsed ? renderIcon("plus") : "新建项目"}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function SidebarNavButton(props: { active: boolean; icon: string; label: string; onClick: () => void }) {
  return (
    <button className={`sidebar-nav-button ${props.active ? "is-active" : ""}`} type="button" aria-pressed={props.active} title={props.label} onClick={props.onClick}>
      <span className="sidebar-nav-icon">{renderIcon(props.icon)}</span>
      <span className="sidebar-nav-label">{props.label}</span>
    </button>
  );
}

function renderUtilityTabs(props: any) {
  const primaryProvider = currentProviderChoiceFromProps(props, "primary");
  const secondaryProvider = currentProviderChoiceFromProps(props, "secondary");

  return (
    <aside className={`utility-panel-shell ${props.utilityCollapsed ? "is-collapsed" : ""} ${props.mobileUtilityOpen ? "is-mobile-open" : ""} ${props.activeSideTab === "resources" && !props.utilityCollapsed ? "is-expanded" : ""}`}>
      <div className="utility-header">
        <div className="utility-header-actions">
          <button className="sidebar-toggle utility-toggle" type="button" aria-expanded={!props.utilityCollapsed} title={props.utilityCollapsed ? "展开项目设置栏" : "收起项目设置栏"} onClick={props.onToggleUtilityPanel}>
            {renderIcon(props.utilityCollapsed ? "chevronLeft" : "chevronRight")}
          </button>
          <button className="button button-ghost mobile-only" type="button" onClick={() => props.setMobileUtilityOpen(false)}>关闭</button>
        </div>
      </div>
      <div className="utility-tabs">
        {SIDE_TABS.map((tab) => (
          <button
            key={tab}
            className={`utility-tab-button ${props.activeSideTab === tab ? "is-active" : ""}`}
            type="button"
            aria-pressed={props.activeSideTab === tab}
            title={humanSideTabLabel(tab)}
            onClick={() => props.setActiveSideTab(tab)}
          >
            <span className="utility-tab-icon">{renderIcon(tab)}</span>
            <span className="utility-tab-label">{humanSideTabLabel(tab)}</span>
          </button>
        ))}
      </div>
      <div className="utility-body">
        {props.activeSideTab === "project" ? (
          <section className="panel utility-panel">
            <div className="panel-header">
              <div>
                <h2>项目设定</h2>
              </div>
              <div className="pill-row">
                <Pill label="主力" value={props.providerRuntime?.agentModels?.primary?.providerName || props.providerRuntime?.providerName || "-"} />
                <Pill label="辅助" value={props.providerRuntime?.agentModels?.secondary?.providerName || props.providerRuntime?.agentModels?.secondary?.providerId || "未配置"} />
              </div>
            </div>
            <div className="provider-switch-card">
              <div className="provider-switch-head">
                <div>
                  <h3>模型切换</h3>
                </div>
                <div className="pill-row">
                  <Pill label="复杂任务" value={props.providerDraft.primaryModel || props.providerRuntime?.responseModel || "-"} />
                  <Pill label="简单任务" value={props.providerDraft.secondaryModel || props.providerRuntime?.reviewModel || "-"} />
                </div>
              </div>
              <form className="project-form" onSubmit={(event) => { event.preventDefault(); props.onProviderSave(); }}>
                <div className="form-grid">
                  <ProviderDraftFields slot="primary" draft={props.providerDraft} provider={primaryProvider} providers={props.providerRuntime?.availableProviders || []} mutationBusy={props.mutationBusy} setProviderDraft={props.setProviderDraft} syncProviderDraftFromSelection={props.syncProviderDraftFromSelection} />
                  <ProviderDraftFields slot="secondary" draft={props.providerDraft} provider={secondaryProvider} providers={props.providerRuntime?.availableProviders || []} mutationBusy={props.mutationBusy} setProviderDraft={props.setProviderDraft} syncProviderDraftFromSelection={props.syncProviderDraftFromSelection} />
                  <div className="field">
                    <label>工作台模型</label>
                    <input value={props.providerRuntime?.codexResponseModel || primaryProvider?.codexResponseModel || ""} disabled readOnly />
                  </div>
                  <div className="field full">
                    <label>配置来源</label>
                    <input value={props.providerRuntime?.configSource === "codex_file" ? `novelex.codex.toml · ${props.providerRuntime?.configLoaded ? "已加载" : "加载失败"}` : "运行时配置 / 环境变量"} disabled readOnly />
                  </div>
                  <div className="field full">
                    <label>配置文件路径</label>
                    <input value={props.providerRuntime?.configPath || "未定位到配置文件"} disabled readOnly />
                  </div>
                </div>
                <div className="actions">
                  <button className="button button-primary" type="submit" disabled={props.mutationBusy()}>
                    {props.mutationBusy("provider_save") ? "切换中..." : "保存并切换模型"}
                  </button>
                </div>
              </form>
            </div>
            <form className="project-form" onSubmit={(event) => { event.preventDefault(); props.onProjectSave(); }}>
              <fieldset disabled={props.mutationBusy()} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0 }}>
                <div className="form-grid">
                  <div className="field">
                    <label>推理强度</label>
                    <input value={`${humanReasoningEffort(props.providerRuntime?.reasoningEffort)}（由当前服务商配置决定）`} disabled readOnly />
                  </div>
                  <ProjectDraftFields draft={props.projectDraft} setProjectDraft={props.setProjectDraft} />
                </div>
              </fieldset>
              <div className="actions">
                <button className="button button-primary" type="submit" disabled={props.mutationBusy()}>
                  {props.mutationBusy("project_save") ? "保存中..." : "保存项目设定"}
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {props.activeSideTab === "resources" ? (
          <>
            <section className="panel utility-panel">
              <div className="panel-header">
                <div>
                  <div className="eyebrow">风格指纹</div>
                  <h2>风格指纹库</h2>
                </div>
                <div className="pill-row">
                  <Pill label="库内数量" value={String((props.snapshot?.styleFingerprints || []).length)} />
                  <Pill label="当前项目" value={currentStyleFingerprintSummary(props.snapshot)?.name || "未选择"} />
                </div>
              </div>
              <div className="style-panel-grid">
                <div className="style-column">
                  <div className="preview-box">
                    <h3>生成新风格指纹</h3>
                    <form className="project-form" onSubmit={(event) => { event.preventDefault(); props.onGenerateStyleFingerprint(); }}>
                      <div className="field">
                        <label>风格名称</label>
                        <input value={props.styleGenerateDraft.name} placeholder="例如：冷峻近贴视角" onChange={(event) => props.setStyleGenerateDraft((current: any) => ({ ...current, name: event.target.value }))} disabled={props.mutationBusy()} />
                      </div>
                      <div className="field">
                        <label>范文</label>
                        <textarea className="style-sample-textarea" value={props.styleGenerateDraft.sampleText} placeholder="粘贴一篇你希望模仿其文风的范文。系统会抽取叙述距离、措辞、节奏、修辞、对白与禁忌项。" onChange={(event) => props.setStyleGenerateDraft((current: any) => ({ ...current, sampleText: event.target.value }))} disabled={props.mutationBusy()} />
                      </div>
                      <div className="actions">
                        <button className="button button-primary" type="submit" disabled={props.mutationBusy()}>
                          {props.mutationBusy("style_generate") ? "分析中..." : "生成风格指纹"}
                        </button>
                      </div>
                    </form>
                  </div>
                  <div className="preview-box">
                    <h3>当前项目使用的章节风格</h3>
                    <form className="project-form" onSubmit={(event) => { event.preventDefault(); props.onProjectStyleSave(); }}>
                      <div className="field">
                        <label>选中的风格指纹</label>
                        <select value={props.projectStyleDraft} onChange={(event) => props.setProjectStyleDraft(event.target.value)} disabled={props.mutationBusy()}>
                          <option value="">未选择，回退默认风格</option>
                          {(props.snapshot?.styleFingerprints || []).map((item: any) => (
                            <option key={item.id} value={item.id}>{item.name}</option>
                          ))}
                        </select>
                      </div>
                      <p className="helper-text">
                        {currentStyleFingerprintSummary(props.snapshot)
                          ? `当前生效：${currentStyleFingerprintSummary(props.snapshot)?.name}。之后的新章节会直接使用它的风格指令。`
                          : "当前没有选中风格指纹，写作阶段会继续回退到项目风格备注 / 已有风格指南。"}
                      </p>
                      <div className="actions">
                        <button className="button button-secondary" type="submit" disabled={props.mutationBusy()}>
                          {props.mutationBusy("project_style_save") ? "保存中..." : "保存章节风格选择"}
                        </button>
                        <button className="button button-ghost" type="button" disabled={props.mutationBusy()} onClick={props.onProjectStyleClear}>清空选择</button>
                      </div>
                    </form>
                  </div>
                </div>
                <div className="style-column">
                  <div className="style-library-shell">
                    <div className="style-library-list">
                      {(props.snapshot?.styleFingerprints || []).length ? (props.snapshot?.styleFingerprints || []).map((item: any) => (
                        <button className={`style-library-item ${props.selectedStyleFingerprintId === item.id ? "active" : ""}`} key={item.id} type="button" onClick={() => props.setSelectedStyleFingerprintId(item.id)}>
                          <strong>{item.name}</strong>
                          <small>{item.summary || "已生成风格指纹。"}</small>
                        </button>
                      )) : <div className="empty">还没有风格指纹。先粘贴一篇范文生成第一份风格。</div>}
                    </div>
                    <div className="style-detail-card">
                      {!props.selectedStyleFingerprintId ? <div className="empty">从左侧选择一份风格指纹，即可查看、编辑并设置给当前项目。</div> : null}
                      {props.selectedStyleFingerprintId && props.styleFingerprintLoading ? <div className="empty">风格指纹加载中...</div> : null}
                      {props.selectedStyleFingerprintId && !props.styleFingerprintLoading && props.styleFingerprintError ? <div className="empty">{props.styleFingerprintError.message}</div> : null}
                      {props.selectedStyleFingerprintId && props.styleFingerprintDetail ? (
                        <div className="style-detail-stack">
                          <SimpleCollapsibleCard title={<h3>风格指令编辑器</h3>} meta={<p className="document-meta">{props.styleFingerprintDetail.metadata.updatedAt || props.styleFingerprintDetail.metadata.createdAt || ""}</p>}>
                            <form className="project-form" onSubmit={(event) => { event.preventDefault(); props.onStyleEditSave(); }}>
                              <div className="field">
                                <label>名称</label>
                                <input value={props.styleEditDraft.name} onChange={(event) => props.setStyleEditDraft((current: any) => ({ ...current, name: event.target.value }))} disabled={props.mutationBusy()} />
                              </div>
                              <div className="field">
                                <label>写作用风格指令</label>
                                <textarea className="style-prompt-textarea" value={props.styleEditDraft.promptMarkdown} onChange={(event) => props.setStyleEditDraft((current: any) => ({ ...current, promptMarkdown: event.target.value }))} disabled={props.mutationBusy()} />
                              </div>
                              <div className="actions">
                                <button className="button button-primary" type="submit" disabled={props.mutationBusy()}>
                                  {props.mutationBusy("style_update") ? "保存中..." : "保存风格指令"}
                                </button>
                              </div>
                            </form>
                          </SimpleCollapsibleCard>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <CollectionPanel
              title="范文语料库"
              eyebrow="参考语料"
              collections={props.snapshot?.ragCollections || []}
              selectedIds={props.selectedRagIds}
              onToggleId={(collectionId: string) => props.setSelectedRagIds((current: string[]) => current.includes(collectionId) ? current.filter((id) => id !== collectionId) : [...current, collectionId])}
              createName={props.ragCreateName}
              setCreateName={props.setRagCreateName}
              createPlaceholder="例如：晚明海权范文"
              createDescription="新建后请把范文手动放入对应的 sources/ 目录，再点击“重建索引”。"
              createButtonLabel={props.mutationBusy("rag_create") ? "创建中..." : "创建语料库"}
              bindDescription="写章节时只会检索这里勾选的语料库。向量化运行时需要环境变量 ZHIPU_API_KEY。"
              bindButtonLabel={props.mutationBusy("project_rag_save") ? "保存中..." : "保存项目绑定"}
              rebuildButtonLabel={props.mutationBusy("rag_rebuild") ? "重建中..." : "重建索引"}
              mutationBusy={props.mutationBusy}
              onCreate={props.onCreateRagCollection}
              onSaveBindings={props.onProjectRagSave}
              onRebuild={props.onRebuildRagCollection}
            />

            <CollectionPanel
              title="黄金三章参考库"
              eyebrow="开篇参考"
              collections={props.snapshot?.openingCollections || []}
              selectedIds={props.selectedOpeningIds}
              onToggleId={(collectionId: string) => props.setSelectedOpeningIds((current: string[]) => current.includes(collectionId) ? current.filter((id) => id !== collectionId) : [...current, collectionId])}
              createName={props.openingCreateName}
              setCreateName={props.setOpeningCreateName}
              createPlaceholder="例如：强钩子都市开头"
              createDescription="新建后请把优秀网文前三章手动放入对应的 sources/ 目录，再点击“重建索引”。"
              createButtonLabel={props.mutationBusy("opening_create") ? "创建中..." : "创建参考库"}
              bindDescription="方案阶段全程会使用这里勾选的参考库；写作阶段仅第 1-3 章会强注入这些开头结构参考。"
              bindButtonLabel={props.mutationBusy("project_opening_save") ? "保存中..." : "保存项目绑定"}
              rebuildButtonLabel={props.mutationBusy("opening_rebuild") ? "重建中..." : "重建索引"}
              mutationBusy={props.mutationBusy}
              onCreate={props.onCreateOpeningCollection}
              onSaveBindings={props.onProjectOpeningSave}
              onRebuild={props.onRebuildOpeningCollection}
            />
          </>
        ) : null}

        {props.activeSideTab === "history" ? (
          <section className="panel utility-panel">
            <div className="panel-header">
              <div>
                <div className="eyebrow">运行历史</div>
                <h2>最近运行</h2>
              </div>
            </div>
            <div className="logs">
              {[...(props.snapshot?.runs?.plan || []), ...(props.snapshot?.runs?.write || [])]
                .sort((a: any, b: any) => String(b.startedAt).localeCompare(String(a.startedAt)))
                .slice(0, 8)
                .map((run: any) => (
                  <div className="history-run-card" key={run.id}>
                    <div className="history-run-head">
                      <strong>{humanPhaseName(run.phase)} · {humanRunTarget(run.target)}</strong>
                      <span className="timeline-inline-meta">
                        <Badge label={humanPhaseName(run.phase)} />
                        <Badge label={humanRunTarget(run.target)} tone={pillTone(run.target || run.phase)} />
                      </span>
                    </div>
                    <p>{run.summary || "暂无摘要。"}</p>
                    <p><small>{nowFormatted(run.startedAt)}</small></p>
                  </div>
                ))}
              {![...(props.snapshot?.runs?.plan || []), ...(props.snapshot?.runs?.write || [])].length ? <div className="empty">还没有运行记录。</div> : null}
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function currentProviderChoiceFromProps(props: any, slot: "primary" | "secondary") {
  const providers = props.providerRuntime?.availableProviders || [];
  const providerId = props.providerDraft[slot === "primary" ? "primaryProviderId" : "secondaryProviderId"];
  return providers.find((item: ProviderChoice) => item.id === providerId)
    || providers.find((item: ProviderChoice) => item.id === props.providerRuntime?.providerId)
    || providers[0]
    || null;
}

function ProviderDraftFields(props: any) {
  const slot = props.slot as "primary" | "secondary";
  const prefix = slot === "primary" ? "主力" : "辅助";
  const providerKey = `${slot}ProviderId`;
  const modelKey = `${slot}Model`;
  return (
    <Fragment>
      <div className="field">
        <label>{prefix}服务商</label>
        <select
          value={props.draft[providerKey] || ""}
          onChange={(event) => props.syncProviderDraftFromSelection(slot, event.target.value)}
          disabled={props.mutationBusy()}
        >
          {props.providers.map((item: ProviderChoice) => (
            <option
              key={item.id}
              value={item.id}
            >
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>{prefix}协议</label>
        <input value={props.provider?.wireApi || props.provider?.apiStyle || ""} disabled readOnly />
      </div>
      <div className="field full">
        <label>{prefix}接口地址</label>
        <input value={props.provider?.baseUrl || ""} disabled readOnly />
      </div>
      <div className="field">
        <label>{prefix}模型</label>
        <input value={props.draft[modelKey] || ""} onChange={(event) => props.setProviderDraft((current: any) => ({ ...current, [modelKey]: event.target.value }))} disabled={props.mutationBusy()} />
      </div>
      <div className="field">
        <label>{prefix}密钥状态</label>
        <input value={props.provider?.hasApiKey ? "已检测到当前服务商的接口密钥" : "当前服务商尚未配置接口密钥"} disabled readOnly />
      </div>
    </Fragment>
  );
}

function ProjectDraftFields(props: any) {
  const setField = (key: string, value: string) => props.setProjectDraft((current: any) => ({ ...current, [key]: value }));
  return (
    <>
      <div className="field">
        <label>作品标题</label>
        <input value={props.draft.title || ""} onChange={(event) => setField("title", event.target.value)} />
      </div>
      <div className="field">
        <label>类型</label>
        <input value={props.draft.genre || ""} onChange={(event) => setField("genre", event.target.value)} />
      </div>
      <div className="field full">
        <label>故事前提</label>
        <textarea value={props.draft.premise || ""} onChange={(event) => setField("premise", event.target.value)} />
      </div>
      <div className="field">
        <label>设定 / 场域</label>
        <input value={props.draft.setting || ""} onChange={(event) => setField("setting", event.target.value)} />
      </div>
      <div className="field">
        <label>主题</label>
        <input value={props.draft.theme || ""} onChange={(event) => setField("theme", event.target.value)} />
      </div>
      <div className="field">
        <label>主角目标</label>
        <input value={props.draft.protagonistGoal || ""} onChange={(event) => setField("protagonistGoal", event.target.value)} />
      </div>
      <div className="field">
        <label>目标章节数</label>
        <input type="number" value={props.draft.totalChapters || ""} onChange={(event) => setField("totalChapters", event.target.value)} />
      </div>
      <div className="field">
        <label>目标单章字数</label>
        <input type="number" value={props.draft.targetWordsPerChapter || ""} onChange={(event) => setField("targetWordsPerChapter", event.target.value)} />
      </div>
      <div className="field">
        <label>阶段数</label>
        <input type="number" value={props.draft.stageCount || ""} onChange={(event) => setField("stageCount", event.target.value)} />
      </div>
      <div className="field full">
        <label>风格说明</label>
        <textarea value={props.draft.styleNotes || ""} onChange={(event) => setField("styleNotes", event.target.value)} />
      </div>
      <div className="field full">
        <label>研究备注</label>
        <textarea value={props.draft.researchNotes || ""} onChange={(event) => setField("researchNotes", event.target.value)} />
      </div>
    </>
  );
}

function CollectionPanel(props: any) {
  return (
    <section className="panel utility-panel">
      <div className="panel-header">
        <div>
          <div className="eyebrow">{props.eyebrow}</div>
          <h2>{props.title}</h2>
        </div>
        <div className="pill-row">
          <Pill label="共享库" value={String(props.collections.length)} />
          <Pill label="当前绑定" value={String(props.selectedIds.length)} />
        </div>
      </div>
      <div className="style-panel-grid">
        <div className="style-column">
          <div className="preview-box">
            <h3>新建共享语料库</h3>
            <form className="project-form" onSubmit={(event) => { event.preventDefault(); props.onCreate(); }}>
              <div className="field">
                <label>语料库名称</label>
                <input value={props.createName} placeholder={props.createPlaceholder} onChange={(event) => props.setCreateName(event.target.value)} disabled={props.mutationBusy()} />
              </div>
              <p className="helper-text">{props.createDescription}</p>
              <div className="actions">
                <button className="button button-primary" type="submit" disabled={props.mutationBusy()}>{props.createButtonLabel}</button>
              </div>
            </form>
          </div>
          <div className="preview-box">
            <h3>当前项目绑定</h3>
            <form className="project-form" onSubmit={(event) => { event.preventDefault(); props.onSaveBindings(); }}>
              <div className="field">
                <label>启用的语料库</label>
                <div className="checkbox-stack">
                  {props.collections.length ? props.collections.map((item: any) => (
                    <label className="checkbox-card" key={item.id}>
                      <input type="checkbox" checked={props.selectedIds.includes(item.id)} onChange={() => props.onToggleId(item.id)} disabled={props.mutationBusy()} />
                      <span>
                        <strong>{item.name}</strong><br />
                        <small>{item.id} · 分块 {String(item.chunkCount || 0)}</small>
                      </span>
                    </label>
                  )) : <div className="empty">还没有共享语料库。</div>}
                </div>
              </div>
              <p className="helper-text">{props.bindDescription}</p>
              <div className="actions">
                <button className="button button-secondary" type="submit" disabled={props.mutationBusy()}>{props.bindButtonLabel}</button>
              </div>
            </form>
          </div>
        </div>
        <div className="style-column">
          <div className="style-library-shell">
            <div className="style-detail-card">
              <div className="style-detail-stack">
                {props.collections.length ? props.collections.map((item: any) => (
                  <SimpleCollapsibleCard key={item.id} title={<h3>{item.name}</h3>} meta={<p className="document-meta">{item.id} · {item.lastBuiltAt || "尚未构建"}</p>} className="preview-box">
                    <div className="metrics">
                      <div className="metric"><span>文档数</span><strong>{String(item.fileCount || 0)}</strong></div>
                      <div className="metric"><span>分块数</span><strong>{String(item.chunkCount || 0)}</strong></div>
                      <div className="metric"><span>编码</span><strong>{(item.encodings || []).join(", ") || "-"}</strong></div>
                    </div>
                    <p style={{ marginTop: 12 }}><strong>素材目录：</strong><br /><code>{item.sourceDir || item.sourceDirRelative || "-"}</code></p>
                    {item.lastError ? <p style={{ marginTop: 12, color: "#b42318" }}><strong>最近错误：</strong> {item.lastError}</p> : null}
                    <div className="actions" style={{ marginTop: 12 }}>
                      <button className="button button-primary" type="button" disabled={props.mutationBusy()} onClick={() => props.onRebuild(item.id)}>
                        {props.rebuildButtonLabel}
                      </button>
                    </div>
                  </SimpleCollapsibleCard>
                )) : <div className="empty">新建第一套语料库之后，这里会显示索引状态与素材目录路径。</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SimpleCollapsibleCard(props: { title: React.ReactNode; meta?: React.ReactNode; className?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`${props.className || ""} collapsible-card ${open ? "is-expanded" : "is-collapsed"}`}>
      <div className="collapsible-header">
        <div className="collapsible-title-wrap">
          {props.title}
          {props.meta}
        </div>
        <button className="button button-ghost button-collapse" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          {open ? "隐藏" : "展开"}
        </button>
      </div>
      <div className="collapsible-content">{props.children}</div>
    </div>
  );
}

function LockedChapterCard(props: {
  chapter: any;
  isLatest: boolean;
  mutationBusy: (action?: MutationAction | null) => boolean;
  projectId: string | null;
  writePending: boolean;
  onDeleteLockedChapter: (chapterId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const chapterId = String(props.chapter?.chapter_id || "");
  const chapterTitle = String(props.chapter?.title || "未命名章节");

  const chapterDocumentQuery = useQuery({
    queryKey: ["locked-chapter-document", props.projectId, chapterId],
    queryFn: () => getDocument(props.projectId!, `novel_state/chapters/${chapterId}.md`),
    enabled: open && Boolean(props.projectId && chapterId),
    staleTime: 60_000,
  });

  const chapterMarkdown = chapterDocumentQuery.data?.content || "";
  const chapterBody = splitChapterMarkdownForReview(chapterMarkdown, chapterTitle).body;

  return (
    <div className={`collapsible-card ${open ? "is-expanded" : "is-collapsed"}`}>
      <div className="collapsible-header">
        <div className="collapsible-title-wrap">
          <strong>{chapterId} · {chapterTitle}</strong>
        </div>
        <button className="button button-ghost button-collapse" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          {open ? "隐藏" : "展开"}
        </button>
      </div>
      <div className="collapsible-content">
        {chapterDocumentQuery.isLoading ? (
          <div className="chapter-summary-card">
            <p>章节正文加载中...</p>
          </div>
        ) : chapterDocumentQuery.isError ? (
          <div className="chapter-summary-card">
            <p>章节正文加载失败。</p>
          </div>
        ) : (
          <div className="chapter-summary-card chapter-body-card">
            <MarkdownBody value={chapterBody || chapterMarkdown || props.chapter?.summary_50 || ""} />
          </div>
        )}
        {props.isLatest ? (
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="button button-danger"
              type="button"
              disabled={props.mutationBusy() || props.writePending}
              onClick={() => props.onDeleteLockedChapter(chapterId)}
            >
              {props.mutationBusy("chapter_delete") ? "删除中..." : "删除此章"}
            </button>
            <small>仅支持依次删除最新锁定章节。</small>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function humanMainSectionLabel(section: MainSection) {
  if (section === "plan") return "大纲协作流程";
  if (section === "write") return "章节写作流程";
  if (section === "chapters") return "已锁定章节";
  return "总览";
}

function humanSideTabLabel(section: SideTab) {
  if (section === "project") return "项目设置";
  if (section === "resources") return "资源配置";
  if (section === "documents") return "状态文档";
  return "运行历史";
}
