const app = document.querySelector("#app");

let snapshot = null;
let workspaceProjects = [];
let selectedProjectId = window.localStorage.getItem("novelex:selected-project") || null;
let selectedDocumentPath = null;
let selectedStyleFingerprintId = null;
let selectedStyleFingerprintDetail = null;
let styleFingerprintLoading = false;
let toastTimer = null;
let activeMutation = null;
let serverActiveOperation = null;
let serverPollTimer = null;
let serverPollInFlight = false;
let sidebarCollapsed = window.localStorage.getItem("novelex:sidebar-collapsed") === "true";
let utilityCollapsed = window.localStorage.getItem("novelex:utility-collapsed") === "true";
let activeMainSection = window.localStorage.getItem("novelex:main-section") || "overview";
let activeSideTab = window.localStorage.getItem("novelex:side-tab") || "project";
let mobileSidebarOpen = false;
let mobileUtilityOpen = false;
const expandedFlowItems = Object.create(null);
const outlineWorkbenchState = Object.create(null);
const partialRevisionWorkbenchState = Object.create(null);
const directEditWorkbenchState = Object.create(null);

const MAIN_SECTIONS = ["overview", "plan", "write", "chapters"];
const SIDE_TABS = ["project", "resources", "documents", "history"];

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sanitizeUrl(value) {
  const url = String(value || "").trim();
  if (!url) {
    return "";
  }
  return /^(https?:|mailto:|\/|#)/i.test(url) ? url : "";
}

function createMarkdownPlaceholder(tokens, html) {
  const index = tokens.push(html) - 1;
  return `@@MDTOKEN${index}@@`;
}

function restoreMarkdownPlaceholders(html, tokens) {
  return html.replace(/@@MDTOKEN(\d+)@@/g, (_, index) => tokens[Number(index)] || "");
}

function renderInlineMarkdown(value) {
  const tokens = [];
  let raw = String(value || "");

  raw = raw.replace(/`([^`\n]+)`/g, (_, code) =>
    createMarkdownPlaceholder(tokens, `<code>${escapeHtml(code)}</code>`),
  );

  raw = raw.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) {
      return match;
    }
    return createMarkdownPlaceholder(
      tokens,
      `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">${renderInlineMarkdown(label)}</a>`,
    );
  });

  let html = escapeHtml(raw);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  return restoreMarkdownPlaceholders(html, tokens);
}

function isMarkdownBoundary(line) {
  const source = String(line || "");
  return (
    !source.trim() ||
    /^```/.test(source) ||
    /^(#{1,6})\s+/.test(source) ||
    /^>\s?/.test(source) ||
    /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(source) ||
    /^\s*[-*+]\s+/.test(source) ||
    /^\s*\d+\.\s+/.test(source)
  );
}

function markdownToHtml(markdown) {
  const lines = String(markdown || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^```([\w-]+)?\s*$/);
    if (fenceMatch) {
      const language = fenceMatch[1] || "";
      index += 1;
      const codeLines = [];
      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const languageClass = language ? ` class="language-${escapeHtml(language)}"` : "";
      blocks.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push("<hr />");
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${markdownToHtml(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*[-*+]\s+(.*)$/);
        if (!match) {
          break;
        }
        items.push(`<li>${renderInlineMarkdown(match[1])}</li>`);
        index += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*\d+\.\s+(.*)$/);
        if (!match) {
          break;
        }
        items.push(`<li>${renderInlineMarkdown(match[1])}</li>`);
        index += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && !isMarkdownBoundary(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraphHtml = renderInlineMarkdown(paragraphLines.join("\n")).replace(/\n/g, "<br />");
    blocks.push(`<p>${paragraphHtml}</p>`);
  }

  return blocks.join("");
}

function renderMarkdownBlock(value) {
  return `<div class="markdown-body">${markdownToHtml(String(value || ""))}</div>`;
}

function renderPreformattedBlock(value) {
  return `<pre>${escapeHtml(String(value || ""))}</pre>`;
}

function renderJsonBlock(value) {
  return renderPreformattedBlock(JSON.stringify(value || {}, null, 2));
}

function isMarkdownPath(path) {
  return /\.(md|markdown)$/i.test(String(path || ""));
}

function renderDocumentContent(content, path) {
  return isMarkdownPath(path) ? renderMarkdownBlock(content) : renderPreformattedBlock(content);
}

function pillTone(status) {
  if (!status) return "accent";
  if (/locked|approved|resolved|idle|completed/.test(status)) return "success";
  if (/pending|review/.test(status)) return "warning";
  if (/rejected|danger|failed|error/.test(status)) return "danger";
  return "accent";
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

function applyServerState(data) {
  if (Object.prototype.hasOwnProperty.call(data || {}, "activeOperation")) {
    serverActiveOperation = data?.activeOperation || null;
  }

  workspaceProjects = data?.projects || workspaceProjects || [];
  selectedProjectId = data?.projectId || selectedProjectId || workspaceProjects[0]?.id || null;

  if (selectedProjectId) {
    window.localStorage.setItem("novelex:selected-project", selectedProjectId);
  } else {
    window.localStorage.removeItem("novelex:selected-project");
  }

  snapshot = data?.state || null;
  if (!snapshot) {
    selectedDocumentPath = null;
    selectedStyleFingerprintId = null;
    selectedStyleFingerprintDetail = null;
    styleFingerprintLoading = false;
    return;
  }

  if (!selectedDocumentPath && snapshot.documents.length) {
    selectedDocumentPath = snapshot.documents[0].label;
  }

  const availableStyleIds = (snapshot.styleFingerprints || []).map((item) => item.id);
  const preferredStyleId = snapshot.project?.project?.styleFingerprintId || availableStyleIds[0] || null;
  if (!selectedStyleFingerprintId || !availableStyleIds.includes(selectedStyleFingerprintId)) {
    selectedStyleFingerprintId = preferredStyleId;
    selectedStyleFingerprintDetail = null;
    styleFingerprintLoading = false;
  }

  if (selectedStyleFingerprintDetail && selectedStyleFingerprintDetail.metadata?.id !== selectedStyleFingerprintId) {
    selectedStyleFingerprintDetail = null;
  }
}

function stopServerPolling() {
  if (serverPollTimer) {
    window.clearTimeout(serverPollTimer);
    serverPollTimer = null;
  }
}

function scheduleServerPolling() {
  if (activeMutation || !serverActiveOperation) {
    stopServerPolling();
    return;
  }

  if (serverPollTimer || serverPollInFlight) {
    return;
  }

  serverPollTimer = window.setTimeout(async () => {
    serverPollTimer = null;
    if (activeMutation || !serverActiveOperation) {
      return;
    }

    serverPollInFlight = true;
    try {
      await loadState(selectedProjectId);
    } catch {
      render();
    } finally {
      serverPollInFlight = false;
      scheduleServerPolling();
    }
  }, 1500);
}

async function loadState(projectId = selectedProjectId) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const data = await api(`/api/state${query}`);
  applyServerState(data);
  if (!snapshot && workspaceProjects.length && selectedProjectId && selectedProjectId !== projectId) {
    return loadState(selectedProjectId);
  }
  render();
}

function apiBody(payload = {}) {
  return JSON.stringify({
    projectId: selectedProjectId,
    ...payload,
  });
}

function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("visible");
  }, 2800);
}

function latestRun(phase) {
  return snapshot?.runs?.[phase]?.[0] || null;
}

function pendingReview() {
  return snapshot?.project?.phase?.plan?.pendingReview || snapshot?.project?.phase?.write?.pendingReview || null;
}

function mutationBusy(action = null) {
  if (!action) {
    return Boolean(activeMutation || serverActiveOperation);
  }
  return activeMutation === action || serverActiveOperation?.action === action;
}

function disabledAttr(disabled) {
  return disabled ? "disabled" : "";
}

function previewText(value, limit = 2400) {
  const text = String(value || "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n\n...`;
}

function countWordsApprox(value) {
  if (!value) {
    return 0;
  }
  return String(value).replace(/\s+/g, "").length;
}

function pendingChapterWordCount(pending = null) {
  const explicitCount = Number(pending?.chapterMeta?.word_count);
  if (Number.isFinite(explicitCount) && explicitCount > 0) {
    return explicitCount;
  }
  return countWordsApprox(pending?.chapterMarkdown || "");
}

function sectionExpanded(key) {
  return Boolean(expandedFlowItems[key]);
}

function ensureSectionDefaultExpanded(key) {
  if (!Object.prototype.hasOwnProperty.call(expandedFlowItems, key)) {
    expandedFlowItems[key] = true;
  }
}

function setMainSection(section) {
  const next = MAIN_SECTIONS.includes(section) ? section : "overview";
  activeMainSection = next;
  window.localStorage.setItem("novelex:main-section", next);
  mobileSidebarOpen = false;
}

function setSideTab(tab) {
  const next = SIDE_TABS.includes(tab) ? tab : "project";
  activeSideTab = next;
  window.localStorage.setItem("novelex:side-tab", next);
}

function setSidebarCollapsed(value) {
  sidebarCollapsed = Boolean(value);
  window.localStorage.setItem("novelex:sidebar-collapsed", sidebarCollapsed ? "true" : "false");
}

function setUtilityCollapsed(value) {
  utilityCollapsed = Boolean(value);
  window.localStorage.setItem("novelex:utility-collapsed", utilityCollapsed ? "true" : "false");
}

function renderIcon(name) {
  const stroke = "currentColor";
  const base = 'width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"';
  const icons = {
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
  return icons[name] || icons.overview;
}

function renderPill(label, value) {
  return `<span class="pill" data-tone="${pillTone(value)}">${escapeHtml(label)}: ${escapeHtml(value || "-")}</span>`;
}

function renderBadge(label, tone = "accent") {
  return `<span class="mini-pill" data-tone="${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function currentStyleFingerprintSummary() {
  const styleId = snapshot?.project?.project?.styleFingerprintId || null;
  if (!styleId) {
    return null;
  }
  return (snapshot?.styleFingerprints || []).find((item) => item.id === styleId) || null;
}

function summarizePlanCharacters(characters = []) {
  return (Array.isArray(characters) ? characters : [])
    .map(
      (character) =>
        `- **${character.name || "未命名"}**｜${character.role || "未定角色"}｜欲望：${character.desire || "待补"}`,
    )
    .join("\n");
}

function normalizedOutlineOptionsFromSnapshot(pending = null) {
  const options = pending?.reviewState?.outlineOptions || pending?.chapterOutlineContext?.outlineOptions || null;
  return {
    variantCount: Number(options?.variantCount || 3),
    diversityPreset: options?.diversityPreset || "wide",
  };
}

function outlineWorkbenchFor(chapterId, pending = null) {
  const key = String(chapterId || "");
  if (!outlineWorkbenchState[key]) {
    outlineWorkbenchState[key] = {
      sceneRefs: [...(pending?.selectedChapterOutline?.selectedSceneRefs || [])],
    };
  }
  return outlineWorkbenchState[key];
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

function chapterBodyFromPending(pending = null) {
  if (!pending?.chapterMarkdown) {
    return "";
  }
  return splitChapterMarkdownForReview(
    pending.chapterMarkdown,
    pending?.chapterPlan?.title || "",
  ).body;
}

function directEditWorkbenchFor(chapterId, pending = null) {
  const key = String(chapterId || "");
  const sourceBody = chapterBodyFromPending(pending);
  if (!directEditWorkbenchState[key]) {
    directEditWorkbenchState[key] = {
      isEditing: false,
      sourceBody,
      draftBody: sourceBody,
    };
  }
  const workbench = directEditWorkbenchState[key];
  if (workbench.sourceBody !== sourceBody && !workbench.isEditing) {
    workbench.sourceBody = sourceBody;
    workbench.draftBody = sourceBody;
  }
  return workbench;
}

function partialRevisionWorkbenchFor(chapterId, pending = null) {
  const key = String(chapterId || "");
  if (!partialRevisionWorkbenchState[key]) {
    partialRevisionWorkbenchState[key] = {
      selectedText: String(pending?.reviewState?.selection?.selectedText || ""),
      prefixContext: String(pending?.reviewState?.selection?.prefixContext || ""),
      suffixContext: String(pending?.reviewState?.selection?.suffixContext || ""),
      feedback: String(
        pending?.reviewState?.mode === "partial_rewrite"
          ? pending?.reviewState?.lastFeedback || ""
          : "",
      ),
    };
  }
  return partialRevisionWorkbenchState[key];
}

function selectionPreviewText(workbench = null) {
  const selectedText = String(workbench?.selectedText || "");
  return selectedText ? previewText(selectedText, 240) : "";
}

function rangeOffsetWithin(root, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return range.toString().length;
}

function captureChapterSelection(container) {
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

  const workbench = partialRevisionWorkbenchFor(chapterId, snapshot?.staged?.pendingChapter || null);
  workbench.selectedText = selectedText;
  workbench.prefixContext = bodyText.slice(Math.max(0, start - 120), start);
  workbench.suffixContext = bodyText.slice(end, end + 120);
  render();
  selection.removeAllRanges();
}

function candidateSceneMap(pending = null) {
  const map = new Map();
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
}

function selectedOutlineScenes(pending = null) {
  const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "";
  const workbench = outlineWorkbenchFor(chapterId, pending);
  const map = candidateSceneMap(pending);
  return workbench.sceneRefs
    .map((sceneRef) => map.get(sceneRef))
    .filter(Boolean);
}

async function runMutation(action, task) {
  if (activeMutation) {
    showToast("已有请求正在处理中，请稍候。");
    return null;
  }

  activeMutation = action;
  render();

  try {
    return await task();
  } finally {
    activeMutation = null;
    render();
  }
}

async function syncStateAfterError() {
  try {
    await loadState(selectedProjectId);
  } catch {
    render();
  }
}

function nextActionText() {
  const { plan, write } = snapshot.project.phase;
  if (plan.status === "idle" || plan.status === "draft_rejected" || plan.status === "final_rejected") {
    return "运行 Plan 阶段，生成完整 plan 包并等待一次性审阅。";
  }
  if (plan.status === "draft_pending_review") {
    return "旧流程待升级：审阅草稿或推进到完整 plan 包。";
  }
  if (plan.status === "final_pending_review") {
    return "审阅完整大纲并锁定进入 Write 阶段。";
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

function pendingReviewText() {
  const pending = pendingReview();
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

function humanMainSectionLabel(section) {
  if (section === "plan") return "大纲协作流程";
  if (section === "write") return "章节写作流程";
  if (section === "chapters") return "已锁定章节";
  return "总览";
}

function currentProjectSummary() {
  return workspaceProjects.find((project) => project.id === selectedProjectId) || null;
}

function mainSectionButton(section, label) {
  const active = activeMainSection === section;
  return `
    <button
      class="subnav-button ${active ? "is-active" : ""}"
      type="button"
      data-main-section="${escapeHtml(section)}"
      aria-pressed="${active ? "true" : "false"}"
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function renderSidebarNavButton(section, label, icon) {
  const active = activeMainSection === section;
  return `
    <button
      class="sidebar-nav-button ${active ? "is-active" : ""}"
      type="button"
      data-main-section="${escapeHtml(section)}"
      aria-pressed="${active ? "true" : "false"}"
      title="${escapeHtml(label)}"
    >
      <span class="sidebar-nav-icon">${renderIcon(icon)}</span>
      <span class="sidebar-nav-label">${escapeHtml(label)}</span>
    </button>
  `;
}

function renderUtilityTabButton(tab, label, icon) {
  const active = activeSideTab === tab;
  return `
    <button
      class="utility-tab-button ${active ? "is-active" : ""}"
      type="button"
      data-side-tab="${escapeHtml(tab)}"
      aria-pressed="${active ? "true" : "false"}"
      title="${escapeHtml(label)}"
    >
      <span class="utility-tab-icon">${renderIcon(icon)}</span>
      <span class="utility-tab-label">${escapeHtml(label)}</span>
    </button>
  `;
}

function renderWorkspaceSidebar() {
  const selected = currentProjectSummary();
  return `
    <aside class="workspace-sidebar ${sidebarCollapsed ? "is-collapsed" : ""} ${mobileSidebarOpen ? "is-mobile-open" : ""}">
      <div class="sidebar-inner">
        <div class="sidebar-brand">
          <button class="brand-mark" type="button" data-jump-main-section="overview" title="回到总览">N</button>
          <div class="brand-copy">
            <strong>Novelex</strong>
            <span>${escapeHtml(selected?.title || "Novel Studio")}</span>
          </div>
          <button
            class="sidebar-toggle"
            type="button"
            data-toggle-shell-sidebar="true"
            aria-expanded="${sidebarCollapsed ? "false" : "true"}"
            title="${sidebarCollapsed ? "展开项目栏" : "收起项目栏"}"
          >
            ${sidebarCollapsed ? renderIcon("chevronRight") : renderIcon("chevronLeft")}
          </button>
        </div>
        <div class="sidebar-section sidebar-nav">
          ${renderSidebarNavButton("overview", "总览", "overview")}
          ${renderSidebarNavButton("plan", "大纲流程", "outline")}
          ${renderSidebarNavButton("write", "写作流程", "write")}
          ${renderSidebarNavButton("chapters", "章节", "chapters")}
        </div>
        <div class="sidebar-section">
          <div class="sidebar-section-head">
            <span class="eyebrow">Projects</span>
            ${selected ? `<span class="sidebar-meta">${escapeHtml(workspaceProjects.length)} 个项目</span>` : ""}
          </div>
          <div class="sidebar-project-list">
            ${workspaceProjects.length ? workspaceProjects.map((project) => {
              const active = project.id === selectedProjectId;
              return `
                <button
                  class="sidebar-project ${active ? "is-active" : ""}"
                  type="button"
                  data-select-project="${escapeHtml(project.id)}"
                >
                  <div class="sidebar-project-main">
                    <strong>${escapeHtml(sidebarCollapsed ? (project.title || project.id).slice(0, 1) : project.title || project.id)}</strong>
                    ${sidebarCollapsed ? "" : `<span>${escapeHtml(project.id)}</span>`}
                  </div>
                  ${sidebarCollapsed ? "" : `
                    <div class="sidebar-project-state">
                      ${renderBadge(`Plan ${project.planStatus || "idle"}`, pillTone(project.planStatus))}
                      ${renderBadge(`Write ${project.writeStatus || "idle"}`, pillTone(project.writeStatus))}
                    </div>
                  `}
                </button>
              `;
            }).join("") : `<div class="empty compact">当前还没有项目。</div>`}
          </div>
        </div>
        <div class="sidebar-section sidebar-create">
          <div class="sidebar-section-head">
            <span class="eyebrow">Create</span>
          </div>
          <div class="sidebar-create-row">
            <input id="new-project-name" placeholder="${sidebarCollapsed ? "新项目" : "新建一个项目"}" ${disabledAttr(mutationBusy())} />
            <button class="button button-primary" id="create-project-button" ${disabledAttr(mutationBusy())}>
              ${mutationBusy("project_create") ? "创建中..." : sidebarCollapsed ? renderIcon("plus") : "新建项目"}
            </button>
          </div>
        </div>
        <div class="sidebar-footer">
          <div class="sidebar-avatar">${escapeHtml((selected?.title || "N").slice(0, 1).toUpperCase())}</div>
          <div class="sidebar-footer-copy">
            <strong>${escapeHtml(selected?.title || "Novelex")}</strong>
            <span>${escapeHtml(selected?.id || "workspace")}</span>
          </div>
          <button class="sidebar-footer-button" type="button" data-open-utility-tab="project" title="打开项目设置">
            ${renderIcon("panel")}
          </button>
        </div>
      </div>
    </aside>
  `;
}

function renderPlaygroundHeader() {
  const project = snapshot.project.project;
  const plan = snapshot.project.phase.plan;
  const write = snapshot.project.phase.write;
  const provider = snapshot.provider;
  const overviewMode = activeMainSection === "overview";

  return `
    <section class="playground-header ${overviewMode ? "is-home" : ""}">
      <div class="playground-title-block">
        <div class="eyebrow">${overviewMode ? "Late-night novel workspace" : "Project Playground"}</div>
        <h1>${escapeHtml(project.title)}</h1>
        <p>${escapeHtml(project.genre || "未填写类型")} · ${escapeHtml(project.setting || "未填写设定")}</p>
      </div>
      <div class="playground-header-actions">
        <button class="button button-ghost mobile-only" type="button" data-open-sidebar="true">项目栏</button>
        <button class="button button-ghost mobile-only" type="button" data-open-utility="true">右侧面板</button>
        <button class="button button-danger" type="button" id="delete-current-project-button" ${disabledAttr(mutationBusy() || !selectedProjectId)}>
          ${mutationBusy("project_delete") ? "删除中..." : "删除项目"}
        </button>
      </div>
      <div class="playground-status-grid ${overviewMode ? "is-home" : ""}">
        <div class="status-summary-card">
          <span class="eyebrow">当前状态</span>
          <div class="pill-row">
            ${renderPill("Plan", plan.status)}
            ${renderPill("Write", write.status)}
            ${renderPill("Provider", provider.effectiveMode)}
            ${renderPill("已锁定章节", String(write.currentChapterNumber || 0))}
          </div>
        </div>
        <div class="status-summary-card">
          <span class="eyebrow">下一动作</span>
          <p>${escapeHtml(nextActionText())}</p>
        </div>
        <div class="status-summary-card">
          <span class="eyebrow">待审节点</span>
          <p>${escapeHtml(pendingReviewText())}</p>
        </div>
      </div>
      <div class="playground-subnav ${overviewMode ? "is-home" : ""}">
        ${mainSectionButton("overview", "总览")}
        ${mainSectionButton("plan", "大纲协作流程")}
        ${mainSectionButton("write", "章节写作流程")}
        ${mainSectionButton("chapters", "已锁定章节")}
      </div>
    </section>
  `;
}

function renderOverviewPanelCard(title, eyebrow, bodyHtml, actionsHtml = "") {
  return `
    <section class="playground-panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">${escapeHtml(eyebrow)}</div>
          <h2>${escapeHtml(title)}</h2>
        </div>
        ${actionsHtml}
      </div>
      ${bodyHtml}
    </section>
  `;
}

function renderOverviewSection() {
  const project = snapshot.project.project;
  const plan = snapshot.project.phase.plan;
  const write = snapshot.project.phase.write;
  const planRun = latestRun("plan");
  const writeRun = latestRun("write");
  const pending = pendingReview();
  const currentStyle = currentStyleFingerprintSummary();
  const styleName = currentStyle?.name || "未绑定";

  return `
    <div class="playground-stack overview-stack">
      <section class="claude-home">
        <div class="claude-home-mark">*</div>
        <h2>${escapeHtml(project.title)}</h2>
        <p>${escapeHtml(project.premise || "从这里进入你的小说工作台，推进大纲、写作与审查流程。")}</p>
        <div class="claude-home-card">
          <div class="claude-home-card-head">
            <span>${escapeHtml(nextActionText())}</span>
            <strong>${escapeHtml(plan.status)} / ${escapeHtml(write.status)}</strong>
          </div>
          <div class="claude-home-card-body">
            <button class="button button-primary" type="button" data-jump-main-section="${pending ? (pending.target === "chapter" || pending.target === "chapter_outline" ? "write" : "plan") : "plan"}">
              ${pending ? "前往待审节点" : "继续推进流程"}
            </button>
            <button class="button button-secondary" type="button" data-jump-main-section="write">打开写作流程</button>
            <button class="button button-ghost" type="button" data-open-utility-tab="project">项目设置</button>
          </div>
        </div>
        <div class="claude-home-chips">
          <button class="claude-chip" type="button" data-jump-main-section="plan">大纲协作</button>
          <button class="claude-chip" type="button" data-jump-main-section="write">章节写作</button>
          <button class="claude-chip" type="button" data-jump-main-section="chapters">已锁定章节</button>
          <button class="claude-chip" type="button" data-open-utility-tab="resources">资源配置</button>
          <button class="claude-chip" type="button" data-open-utility-tab="history">运行历史</button>
        </div>
      </section>
      <section class="playground-panel overview-secondary-panel">
        <div class="overview-grid">
          <div class="overview-card">
            <span class="eyebrow">作品信息</span>
            <h3>${escapeHtml(project.title)}</h3>
            <p>${escapeHtml(project.genre || "未填写类型")} · ${escapeHtml(project.setting || "未填写设定")}</p>
          </div>
          <div class="overview-card">
            <span class="eyebrow">风格与资源</span>
            <h3>${escapeHtml(styleName)}</h3>
            <p>风格指纹 ${escapeHtml(styleName)}，范文库 ${escapeHtml(String((project.ragCollectionIds || []).length))} 个，黄金三章参考 ${escapeHtml(String((project.openingCollectionIds || []).length))} 个。</p>
          </div>
          <div class="overview-card">
            <span class="eyebrow">当前待审</span>
            <h3>${escapeHtml(pending ? (pending.target === "chapter_outline" ? "细纲待审" : pending.target === "chapter" ? "正文待审" : "大纲待审") : "暂无")}</h3>
            <p>${escapeHtml(pendingReviewText())}</p>
          </div>
        </div>
        <div class="overview-metrics">
          <div class="metric"><span>Plan</span><strong>${escapeHtml(plan.status)}</strong></div>
          <div class="metric"><span>Write</span><strong>${escapeHtml(write.status)}</strong></div>
          <div class="metric"><span>目标章节</span><strong>${escapeHtml(String(project.totalChapters || "-"))}</strong></div>
          <div class="metric"><span>单章目标字数</span><strong>${escapeHtml(String(project.targetWordsPerChapter || "-"))}</strong></div>
        </div>
        <div class="overview-list">
          <div class="overview-list-item">
            <strong>最近 Plan 运行</strong>
            <p>${escapeHtml(planRun?.summary || "还没有 Plan 运行记录。")}</p>
          </div>
          <div class="overview-list-item">
            <strong>最近 Write 运行</strong>
            <p>${escapeHtml(writeRun?.summary || "还没有 Write 运行记录。")}</p>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderCollapsibleCard({ key, className, titleHtml, bodyHtml, headerMetaHtml = "" }) {
  const expanded = sectionExpanded(key);
  return `
    <div class="${className} collapsible-card ${expanded ? "is-expanded" : "is-collapsed"}" data-section-key="${escapeHtml(key)}">
      <div class="collapsible-header">
        <div class="collapsible-title-wrap">
          ${titleHtml}
          ${headerMetaHtml}
        </div>
        <button
          class="button button-ghost button-collapse"
          type="button"
          data-toggle-section="${escapeHtml(key)}"
          aria-expanded="${expanded ? "true" : "false"}"
        >
          ${expanded ? "隐藏" : "展开"}
        </button>
      </div>
      <div class="collapsible-content">
        ${bodyHtml}
      </div>
    </div>
  `;
}

function renderArtifactBlock(title, bodyHtml, tone = "accent") {
  return `
    <div class="artifact-block" data-tone="${escapeHtml(tone)}">
      <div class="artifact-title">${escapeHtml(title)}</div>
      <div class="artifact-body">${bodyHtml}</div>
    </div>
  `;
}

function renderArtifactList(blocks = []) {
  if (!blocks.length) {
    return "";
  }
  return `<div class="artifact-stack">${blocks.join("")}</div>`;
}

function renderTimelineItem({
  key,
  label,
  summary,
  bodyHtml = "",
  status = "completed",
  metaHtml = "",
  isLast = false,
}) {
  const expanded = sectionExpanded(key);
  return `
    <div class="timeline-item ${expanded ? "is-expanded" : ""}">
      <div class="timeline-rail">
        <span class="timeline-dot" data-tone="${pillTone(status)}"></span>
        ${isLast ? "" : '<span class="timeline-line"></span>'}
      </div>
      <div class="timeline-card">
        <div class="timeline-head">
          <div class="timeline-title-wrap">
            <div class="timeline-title-row">
              <strong>${escapeHtml(label)}</strong>
              ${metaHtml}
            </div>
            <p class="timeline-summary">${escapeHtml(summary || "-")}</p>
          </div>
          <button
            class="button button-ghost button-collapse"
            type="button"
            data-toggle-section="${escapeHtml(key)}"
            aria-expanded="${expanded ? "true" : "false"}"
          >
            ${expanded ? "隐藏" : "展开"}
          </button>
        </div>
        <div class="timeline-body">
          ${bodyHtml}
        </div>
      </div>
    </div>
  `;
}

function expandFlow(prefix) {
  document.querySelectorAll(`[data-flow-key-prefix="${prefix}"] [data-section-key]`).forEach((node) => {
    const key = node.getAttribute("data-section-key");
    if (key) {
      expandedFlowItems[key] = true;
    }
  });
}

function collapseFlow(prefix) {
  Object.keys(expandedFlowItems).forEach((key) => {
    if (key.startsWith(prefix)) {
      expandedFlowItems[key] = false;
    }
  });
}

function renderTimeline(prefix, items, emptyMessage) {
  return `
    <div class="timeline-shell">
      <div class="timeline-actions">
        <button class="button button-ghost" type="button" data-expand-flow="${escapeHtml(prefix)}">展开全部</button>
        <button class="button button-ghost" type="button" data-collapse-flow="${escapeHtml(prefix)}">收起全部</button>
      </div>
      ${items.length ? `
        <div class="timeline" data-flow-key-prefix="${escapeHtml(prefix)}">
          ${items.map((item, index) => renderTimelineItem({
            ...item,
            isLast: index === items.length - 1,
          })).join("")}
        </div>
      ` : `<div class="empty">${escapeHtml(emptyMessage)}</div>`}
    </div>
  `;
}

function renderFlowStepArtifacts(phase, step, context = {}) {
  const stepId = `${step.id || ""} ${step.label || ""}`.toLowerCase();
  const blocks = [];

  if (phase === "plan") {
    const draft = context.draft || null;
    const finalPlan = context.finalPlan || null;

    if ((/cast|character/.test(stepId)) && draft?.cast?.length) {
      blocks.push(renderArtifactBlock("人物草稿", renderJsonBlock(draft.cast), "accent"));
    }
    if ((/outline|draft/.test(stepId)) && draft?.outlineMarkdown) {
      blocks.push(renderArtifactBlock("当前大纲草稿", renderMarkdownBlock(draft.outlineMarkdown), "accent"));
    }
    if ((/final|outline|plan/.test(stepId)) && finalPlan?.outlineMarkdown) {
      blocks.push(renderArtifactBlock("完整大纲", renderMarkdownBlock(finalPlan.outlineMarkdown), "success"));
    }
    if ((/structure|slot|foreshadow/.test(stepId)) && finalPlan?.structureMarkdown) {
      blocks.push(renderArtifactBlock("结构摘要", renderMarkdownBlock(finalPlan.structureMarkdown), "success"));
    }
    if ((/world|setting/.test(stepId)) && finalPlan?.worldbuildingMarkdown) {
      blocks.push(renderArtifactBlock("世界观摘要", renderMarkdownBlock(finalPlan.worldbuildingMarkdown), "success"));
    }
    if ((/character|cast/.test(stepId)) && finalPlan?.characters?.length) {
      blocks.push(renderArtifactBlock("角色摘要", renderMarkdownBlock(summarizePlanCharacters(finalPlan.characters || [])), "success"));
    }
  }

  if (phase === "write") {
    const pending = context.pending || null;
    const chapterParts = context.chapterParts || null;
    const pendingChapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "";
    const directEditWorkbench = pendingChapterId ? directEditWorkbenchFor(pendingChapterId, pending) : null;
    const directEditMode = Boolean(directEditWorkbench?.isEditing);

    if (/outlinecontext|briefing|plan_context_outline/.test(stepId) && pending?.chapterOutlineContext) {
      blocks.push(renderArtifactBlock("细纲上下文", renderJsonBlock(pending.chapterOutlineContext), "accent"));
    }
    if (/history/.test(stepId) && pending?.retrieval) {
      blocks.push(renderArtifactBlock("历史衔接包", renderJsonBlock(pending.retrieval), "accent"));
    }
    if (/fact/.test(stepId) && pending?.factContext) {
      blocks.push(renderArtifactBlock("事实上下文", renderJsonBlock(pending.factContext), "accent"));
    }
    if (/reference/.test(stepId) && pending?.referencePacket) {
      blocks.push(renderArtifactBlock("范文参考包", renderJsonBlock(pending.referencePacket), "accent"));
    }
    if (/research/.test(stepId) && pending?.researchPacket) {
      blocks.push(renderArtifactBlock("研究资料包", renderJsonBlock(pending.researchPacket), "accent"));
    }
    if (/writercontext|coordinator|governance|input_governance/.test(stepId) && pending?.writerContext) {
      blocks.push(renderArtifactBlock("Writer Context", renderJsonBlock(pending.writerContext), "accent"));
    }
    if ((/writer_agent/.test(stepId) || /\bwriteragent\b/.test(stepId)) && pending?.chapterMarkdown) {
      blocks.push(renderArtifactBlock(
        chapterParts?.title || pending?.chapterPlan?.title || "章节正文",
        `
          <p><small>${escapeHtml(`当前草稿字数：${pendingChapterWordCount(pending)} 字`)}</small></p>
          <div
            class="chapter-body-selectable ${directEditMode ? "is-editing" : ""}"
            ${directEditMode ? 'data-chapter-body-editable="true"' : 'data-chapter-body-selectable="true"'}
            data-chapter-id="${escapeHtml(pendingChapterId)}"
            tabindex="0"
            ${directEditMode ? 'contenteditable="true" spellcheck="false"' : ""}
          >${escapeHtml(directEditMode ? (directEditWorkbench?.draftBody || "") : (chapterParts?.body || ""))}</div>
        `,
        "warning",
      ));
    }
    if ((/audit_orchestrator|audit_analyzer|auditheuristics|auditguardrail/.test(stepId) || /\bauditanalyzeragent\b/.test(stepId)) && pending?.validation) {
      blocks.push(renderArtifactBlock("审计结果", renderJsonBlock(pending.validation), pillTone(step.status)));
    }
    if (/audit_drift/.test(stepId) && (pending?.auditDrift?.markdown || pending?.validation?.auditDrift?.markdown)) {
      blocks.push(renderArtifactBlock(
        "漂移提示",
        renderMarkdownBlock(pending.auditDrift?.markdown || pending.validation.auditDrift.markdown),
        pillTone(step.status),
      ));
    }
    if (/state_update/.test(stepId) && (pending?.chapterMeta || pending?.worldState)) {
      blocks.push(renderArtifactBlock("章节元数据", renderJsonBlock(pending.chapterMeta || {}), "success"));
      blocks.push(renderArtifactBlock("世界状态摘要", renderJsonBlock(pending.worldState || {}), "success"));
    }
  }

  return renderArtifactList(blocks);
}

function buildPlanTimelineItems() {
  const run = latestRun("plan");
  const draft = snapshot.staged.planDraft;
  const finalPlan = snapshot.staged.planFinal;
  const plan = snapshot.project.phase.plan;
  const unresolvedIssues = draft?.preApprovalCritics?.passed === false
    ? draft.preApprovalCritics.issues || []
    : [];
  const items = [];

  if (run?.steps?.length) {
    run.steps.forEach((step, index) => {
      items.push({
        key: `plan-flow-step-${index}`,
        label: step.label || step.id || `Plan Step ${index + 1}`,
        summary: step.summary || "已完成该步骤。",
        status: step.status || "completed",
        metaHtml: step.preview ? renderBadge("含结果", "accent") : "",
        bodyHtml: `
          <div class="timeline-detail-stack">
            ${step.preview ? renderArtifactBlock("步骤预览", renderPreformattedBlock(step.preview), "accent") : ""}
            ${renderFlowStepArtifacts("plan", step, { draft, finalPlan })}
          </div>
        `,
      });
    });
  }

  if (draft?.outlineMarkdown) {
    items.push({
      key: "plan-flow-draft-outline",
      label: "当前大纲草稿",
      summary: "展示当前 staged 的大纲草稿与人物草稿。",
      status: plan.status,
      bodyHtml: renderArtifactList([
        draft.cast?.length ? renderArtifactBlock("自动生成人物", renderJsonBlock(draft.cast), "accent") : "",
        renderArtifactBlock("大纲草稿", renderMarkdownBlock(draft.outlineMarkdown), "accent"),
      ].filter(Boolean)),
    });
  }

  if (finalPlan?.outlineMarkdown || finalPlan?.structureMarkdown || finalPlan?.worldbuildingMarkdown) {
    items.push({
      key: "plan-flow-final-package",
      label: "完整 Plan 包",
      summary: "当前可锁定的大纲、结构、世界观与角色摘要。",
      status: plan.status,
      bodyHtml: renderArtifactList([
        finalPlan?.outlineMarkdown ? renderArtifactBlock("完整大纲", renderMarkdownBlock(finalPlan.outlineMarkdown), "success") : "",
        finalPlan?.structureMarkdown ? renderArtifactBlock("结构摘要", renderMarkdownBlock(finalPlan.structureMarkdown), "success") : "",
        finalPlan?.worldbuildingMarkdown ? renderArtifactBlock("世界观摘要", renderMarkdownBlock(finalPlan.worldbuildingMarkdown), "success") : "",
        finalPlan?.characters?.length ? renderArtifactBlock("角色摘要", renderMarkdownBlock(summarizePlanCharacters(finalPlan.characters || [])), "success") : "",
        unresolvedIssues.length ? renderArtifactBlock(
          "自动预审遗留问题",
          renderMarkdownBlock(unresolvedIssues.map((item, index) => `${index + 1}. ${item}`).join("\n")),
          "warning",
        ) : "",
      ].filter(Boolean)),
    });
  }

  if (plan.pendingReview?.target === "plan_draft") {
    ensureSectionDefaultExpanded("plan-flow-review-draft");
    items.push({
      key: "plan-flow-review-draft",
      label: "大纲草稿审查",
      summary: "这是旧流程兼容节点。批准后系统会先补齐完整 plan 包，再进入最终审阅。",
      status: "pending_review",
      bodyHtml: renderPlanReviewBody("plan_draft", "这是旧流程兼容节点。批准后系统会先补齐完整 plan 包，再进入最终审阅。"),
    });
  }

  if (plan.pendingReview?.target === "plan_final") {
    ensureSectionDefaultExpanded("plan-flow-review-final");
    items.push({
      key: "plan-flow-review-final",
      label: "最终大纲审查",
      summary: unresolvedIssues.length
        ? "自动 Critic 已连续多轮回炉，但仍保留少量问题。你可以直接批准锁定，也可以填写人类反馈继续重写。"
        : "这里是单次终审节点。批准后只会执行本地锁定与提交，不再触发新的 Critic 或自动改写。",
      status: "pending_review",
      bodyHtml: renderPlanReviewBody(
        "plan_final",
        unresolvedIssues.length
          ? "自动 Critic 已连续多轮回炉，但仍保留少量问题。你可以直接批准锁定，也可以填写人类反馈继续重写。"
          : "这里是单次终审节点。批准后只会执行本地锁定与提交，不再触发新的 Critic 或自动改写。",
      ),
    });
  }

  return items;
}

function renderPlanReviewBody(target, description) {
  return `
    <div class="review-body">
      <p>${escapeHtml(description)}</p>
      <textarea id="feedback-${target}" placeholder="写下你的人类意见。批准时可留空，拒绝时建议写清楚要改哪里。" ${disabledAttr(mutationBusy())}></textarea>
      <div class="actions">
        <button class="button button-primary" data-review-target="${target}" data-approved="true" ${disabledAttr(mutationBusy())}>${mutationBusy("plan_review") ? "提交中..." : "批准"}</button>
        <button class="button button-danger" data-review-target="${target}" data-approved="false" ${disabledAttr(mutationBusy())}>${mutationBusy("plan_review") ? "提交中..." : "拒绝并重写"}</button>
      </div>
    </div>
  `;
}

function renderPlanSection() {
  const plan = snapshot.project.phase.plan;
  return `
    <section class="playground-panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Plan Stage</div>
          <h2>大纲协作流程</h2>
        </div>
        <div class="actions">
          <button class="button button-secondary" id="plan-run-button" ${disabledAttr(
            mutationBusy() ||
            plan.status === "draft_pending_review" ||
            plan.status === "final_pending_review" ||
            plan.status === "locked",
          )}>${mutationBusy("plan_run") ? "处理中..." : "推进 Plan 阶段"}</button>
        </div>
      </div>
      <div class="metrics">
        <div class="metric"><span>当前状态</span><strong>${escapeHtml(plan.status)}</strong></div>
        <div class="metric"><span>最近运行</span><strong>${escapeHtml(plan.lastRunId || "暂无")}</strong></div>
        <div class="metric"><span>锁定时间</span><strong>${escapeHtml(plan.lockedAt || "未锁定")}</strong></div>
      </div>
      ${renderTimeline("plan-flow", buildPlanTimelineItems(), "尚未运行 Plan 阶段。点击“推进 Plan 阶段”后，系统会先生成完整 plan 包，再等待你做一次性终审。")}
    </section>
  `;
}

function renderChapterOutlineReviewBody(pending = null) {
  const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "pending";
  const selectedScenes = selectedOutlineScenes(pending);
  const candidates = pending?.chapterOutlineCandidates || [];

  return `
    <div class="review-body">
      <p>先确定本章细纲，再进入正文生成。你可以直接采用某个方案，也可以把不同方案里的 scene 组合成最终细纲。</p>
      <textarea id="feedback-chapter-outline" placeholder="写下组合说明或重生反馈，比如想强化哪条关系线、换成更险的冲突轴、让章末更狠一点。" ${disabledAttr(mutationBusy())}>${escapeHtml(pending?.selectedChapterOutline?.authorNotes || "")}</textarea>
      <div class="candidate-stack">
        ${candidates.map((candidate) => `
          <div class="candidate-card">
            <div class="candidate-head">
              <div>
                <strong>${escapeHtml(candidate.proposalId)} · ${escapeHtml(candidate.chapterPlan?.title || "")}</strong>
                <p>${escapeHtml(candidate.summary || "")}</p>
                <p><small>${escapeHtml(candidate.diffSummary || "")}</small></p>
              </div>
              <button class="button button-primary" data-review-target="chapter_outline" data-review-action="approve_single" data-selected-proposal-id="${escapeHtml(candidate.proposalId)}" ${disabledAttr(mutationBusy())}>
                ${mutationBusy("chapter_review") ? "提交中..." : "直接采用"}
              </button>
            </div>
            <div class="candidate-scene-list">
              ${(candidate.chapterPlan?.scenes || []).map((scene) => `
                <div class="candidate-scene">
                  <div>
                    <strong>${escapeHtml(scene.label)}</strong>
                    <p><small>${escapeHtml(scene.location)}｜${escapeHtml(scene.focus)}</small></p>
                    <p><small>张力：${escapeHtml(scene.tension)}｜人物：${escapeHtml((scene.characters || []).join("、"))}</small></p>
                  </div>
                  <button class="button button-secondary" type="button" data-outline-add-scene="${escapeHtml(scene.sceneRef)}" data-outline-chapter-id="${escapeHtml(chapterId)}" ${disabledAttr(mutationBusy())}>
                    加入最终方案
                  </button>
                </div>
              `).join("")}
            </div>
          </div>
        `).join("") || `<div class="empty">当前没有可用的细纲候选。</div>`}
      </div>
      <div class="compose-card">
        <strong>最终细纲工作区</strong>
        <p><small>当前已选 ${selectedScenes.length} 个 scene，可用上下移动顺序并删除不想要的部分。</small></p>
        <div class="compose-list">
          ${selectedScenes.map((scene, index) => `
            <div class="compose-item">
              <div>
                <strong>${index + 1}. ${escapeHtml(scene.label)}</strong>
                <p><small>来源：${escapeHtml(scene.proposalId)}｜${escapeHtml(scene.location)}｜${escapeHtml(scene.focus)}</small></p>
              </div>
              <div class="actions">
                <button class="button button-secondary" type="button" data-outline-move="up" data-outline-scene-ref="${escapeHtml(scene.sceneRef)}" data-outline-chapter-id="${escapeHtml(chapterId)}" ${disabledAttr(mutationBusy() || index === 0)}>上移</button>
                <button class="button button-secondary" type="button" data-outline-move="down" data-outline-scene-ref="${escapeHtml(scene.sceneRef)}" data-outline-chapter-id="${escapeHtml(chapterId)}" ${disabledAttr(mutationBusy() || index === selectedScenes.length - 1)}>下移</button>
                <button class="button button-danger" type="button" data-outline-remove-scene="${escapeHtml(scene.sceneRef)}" data-outline-chapter-id="${escapeHtml(chapterId)}" ${disabledAttr(mutationBusy())}>移除</button>
              </div>
            </div>
          `).join("") || `<div class="empty">还没有加入任何 scene。</div>`}
        </div>
      </div>
      <div class="actions">
        <button class="button button-primary" data-review-target="chapter_outline" data-review-action="approve_composed" ${disabledAttr(mutationBusy())}>${mutationBusy("chapter_review") ? "提交中..." : "组合后定稿"}</button>
        <button class="button button-secondary" data-review-target="chapter_outline" data-review-action="regenerate" ${disabledAttr(mutationBusy())}>${mutationBusy("chapter_review") ? "提交中..." : "根据反馈重生"}</button>
      </div>
    </div>
  `;
}

function renderChapterReviewBody(pending = null) {
  const validation = pending?.validation || {};
  const reviewState = pending?.reviewState || {};
  const wordCount = pendingChapterWordCount(pending);
  const issueCounts = validation.issueCounts || { critical: 0, warning: 0, info: 0 };
  const manualReviewRequired = Boolean(reviewState.manualReviewRequired);
  const feedbackSupervisionPassed = reviewState.feedbackSupervisionPassed !== false;
  const approvalOverrideRequired = manualReviewRequired || validation?.overallPassed === false || !feedbackSupervisionPassed;
  const auditMode = manualReviewRequired
    ? "人工复审中"
    : (reviewState.auditDegraded || validation.auditDegraded || validation?.semanticAudit?.source === "heuristics_only")
      ? "降级审查（heuristics only）"
      : "正常审查";
  const blockingFeedbackIssues = (reviewState.blockingFeedbackIssues || []).filter(Boolean).slice(0, 4);
  const blockingIssues = (reviewState.blockingAuditIssues || []).filter(Boolean).slice(0, 4);
  const feedbackSummary = String(reviewState.feedbackSupervisionSummary || "").trim();
  const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "pending";
  const directEditActive = Boolean(directEditWorkbenchFor(chapterId, pending)?.isEditing);
  const workbench = partialRevisionWorkbenchFor(chapterId, pending);
  const selectionPreview = selectionPreviewText(workbench);
  const approveLabel = approvalOverrideRequired ? "仍然锁章（未通过审计）" : "批准";

  return `
    <div class="review-body">
      <p>${escapeHtml(directEditActive
        ? "当前正在直接编辑正文。请先保存或取消本次手动修改，再继续批准、整章重写或局部修订。"
        : approvalOverrideRequired
          ? "当前章节仍有未解决问题；你可以继续重写，也可以在显式确认风险后仍然锁章。"
          : "通过后会锁章；如果不满意，你既可以按反馈重写整章，也可以先在上面的正文 body 中框选一个连续片段，只改那一段。")}</p>
      ${wordCount ? `<p><small>当前待审章节字数：${escapeHtml(String(wordCount))} 字</small></p>` : ""}
      <div class="audit-flag ${approvalOverrideRequired ? "is-danger" : issueCounts.warning ? "is-warning" : "is-success"}">
        <strong>${escapeHtml(approvalOverrideRequired ? "当前章节尚未通过反馈监督或审计" : issueCounts.warning ? "当前章节可批准，但仍有 warning" : "当前没有阻止通过的 critical 问题")}</strong>
        <p><small>审查模式：${escapeHtml(auditMode)}｜critical ${issueCounts.critical || 0} / warning ${issueCounts.warning || 0} / info ${issueCounts.info || 0}｜manualReviewRequired=${manualReviewRequired ? "true" : "false"}</small></p>
        ${feedbackSummary ? `<p><small>反馈监督：${escapeHtml(feedbackSummary)}</small></p>` : ""}
        ${blockingFeedbackIssues.length ? `<p><small>未落实反馈：${escapeHtml(blockingFeedbackIssues.join("；"))}</small></p>` : ""}
        ${blockingIssues.length ? `<p><small>未解决问题：${escapeHtml(blockingIssues.join("；"))}</small></p>` : ""}
      </div>
      <textarea id="feedback-chapter" placeholder="写下你的修改意见，比如要加强哪段冲突、调整节奏、补足人物动机或优化章末牵引。" ${disabledAttr(mutationBusy() || directEditActive)}></textarea>
      <div class="actions">
        <button class="button button-primary" data-review-target="chapter" data-review-action="approve" ${disabledAttr(mutationBusy() || directEditActive)}>${mutationBusy("chapter_review") ? "提交中..." : approveLabel}</button>
        <button class="button button-danger" data-review-target="chapter" data-review-action="rewrite" ${disabledAttr(mutationBusy() || directEditActive)}>${mutationBusy("chapter_review") ? "提交中..." : "根据反馈重写"}</button>
      </div>
      <div class="compose-card">
        <strong>局部修订工作区</strong>
        <p><small>${escapeHtml(directEditActive ? "当前已切换到正文直接编辑态；如需局部修订，请先保存或取消手动编辑。" : "先在正文预览里直接框选一段连续文本，再写修改意见。系统会只替换这一段，其余正文保持不动。")}</small></p>
        <div class="chapter-selection-preview">${selectionPreview ? escapeHtml(selectionPreview) : "当前还没有选中的正文片段。"}</div>
        <textarea id="feedback-chapter-partial" placeholder="只描述这段该怎么改，比如压紧情绪、改顺动作逻辑、补一句更明确的人物反应。" ${disabledAttr(mutationBusy() || directEditActive)}>${escapeHtml(workbench.feedback || "")}</textarea>
        <div class="actions">
          <button class="button button-secondary" type="button" data-chapter-selection-clear="${escapeHtml(chapterId)}" ${disabledAttr(mutationBusy() || directEditActive)}>${directEditActive ? "直接编辑中" : "清除选区"}</button>
          <button class="button button-secondary" data-review-target="chapter" data-review-action="partial_rewrite" ${disabledAttr(mutationBusy() || directEditActive)}>${mutationBusy("chapter_review") ? "提交中..." : "只改选中部分"}</button>
        </div>
      </div>
    </div>
  `;
}

function buildWriteTimelineItems() {
  const write = snapshot.project.phase.write;
  const pending = snapshot.staged.pendingChapter;
  const chapterParts = pending?.chapterMarkdown
    ? splitChapterMarkdownForReview(pending.chapterMarkdown, pending?.chapterPlan?.title || "")
    : null;
  const items = [];
  const run = latestRun("write");
  const pendingChapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "";
  const directEditWorkbench = pendingChapterId ? directEditWorkbenchFor(pendingChapterId, pending) : null;
  const directEditMode = Boolean(directEditWorkbench?.isEditing);

  if (run?.steps?.length) {
    run.steps.forEach((step, index) => {
      items.push({
        key: `write-flow-step-${index}`,
        label: step.label || step.id || `Write Step ${index + 1}`,
        summary: step.summary || "已完成该步骤。",
        status: step.status || "completed",
        metaHtml: step.preview ? renderBadge("含结果", "accent") : "",
        bodyHtml: `
          <div class="timeline-detail-stack">
            ${step.preview ? renderArtifactBlock("步骤预览", renderPreformattedBlock(step.preview), "accent") : ""}
            ${renderFlowStepArtifacts("write", step, { pending, chapterParts })}
          </div>
        `,
      });
    });
  }

  if (pending?.chapterOutlineContext) {
    items.push({
      key: "write-flow-outline-package",
      label: "章节细纲上下文包",
      summary: "展示当前章节细纲生成阶段可用的上下文与候选方案。",
      status: write.status,
      bodyHtml: renderArtifactList([
        pending.chapterOutlineContext?.briefingMarkdown
          ? renderArtifactBlock("Outline Context", renderMarkdownBlock(pending.chapterOutlineContext.briefingMarkdown), "accent")
          : renderArtifactBlock("Outline Context", renderJsonBlock(pending.chapterOutlineContext), "accent"),
        pending.chapterOutlineCandidates?.length
          ? renderArtifactBlock("Outline Candidates", renderJsonBlock(pending.chapterOutlineCandidates), "accent")
          : "",
      ].filter(Boolean)),
    });
  }

  if (pending?.writerContext || pending?.factContext || pending?.retrieval || pending?.referencePacket || pending?.researchPacket) {
    items.push({
      key: "write-flow-context-package",
      label: "写作上下文包",
      summary: "展示 Writer 可消费的上下文、事实、历史、范文与研究资料。",
      status: write.status,
      bodyHtml: renderArtifactList([
        pending.writerContext ? renderArtifactBlock("Writer Context", renderJsonBlock(pending.writerContext), "accent") : "",
        pending.factContext ? renderArtifactBlock("Fact Context", renderJsonBlock(pending.factContext), "accent") : "",
        pending.retrieval ? renderArtifactBlock("History Retrieval", renderJsonBlock(pending.retrieval), "accent") : "",
        pending.referencePacket ? renderArtifactBlock("Reference Packet", renderJsonBlock(pending.referencePacket), "accent") : "",
        pending.researchPacket ? renderArtifactBlock("Research Packet", renderJsonBlock(pending.researchPacket), "accent") : "",
      ].filter(Boolean)),
    });
  }

  if (pending?.chapterMarkdown) {
    items.push({
      key: "write-flow-draft",
      label: chapterParts?.title || pending?.chapterPlan?.title || "章节正文草稿",
      summary: directEditMode
        ? "当前处于人工直接编辑态，保存后会重新校验章节，并退出可修改状态。"
        : "正文 body 支持直接框选，也支持进入直接编辑；章节标题不会被纳入修改范围。",
      status: write.status,
      bodyHtml: renderArtifactList([
        renderArtifactBlock(
          "章节正文",
          `
            <p><small>${escapeHtml(`当前草稿字数：${pendingChapterWordCount(pending)} 字`)}</small></p>
            <div class="actions" style="margin-top:12px;">
              ${directEditMode ? `
                <button class="button button-primary" type="button" data-chapter-direct-save="${escapeHtml(pendingChapterId)}" ${disabledAttr(mutationBusy())}>${mutationBusy("chapter_manual_edit") ? "保存中..." : "保存正文"}</button>
                <button class="button button-ghost" type="button" data-chapter-direct-cancel="${escapeHtml(pendingChapterId)}" ${disabledAttr(mutationBusy())}>取消编辑</button>
              ` : `
                <button class="button button-secondary" type="button" data-chapter-direct-edit="${escapeHtml(pendingChapterId)}" ${disabledAttr(mutationBusy())}>直接修改正文</button>
              `}
            </div>
            <div
              class="chapter-body-selectable ${directEditMode ? "is-editing" : ""}"
              ${directEditMode ? 'data-chapter-body-editable="true"' : 'data-chapter-body-selectable="true"'}
              data-chapter-id="${escapeHtml(pendingChapterId)}"
              tabindex="0"
              ${directEditMode ? 'contenteditable="true" spellcheck="false"' : ""}
            >${escapeHtml(directEditMode ? (directEditWorkbench?.draftBody || "") : (chapterParts?.body || ""))}</div>
          `,
          "warning",
        ),
      ]),
    });
  }

  if (pending?.sceneDrafts?.length || pending?.validation) {
    items.push({
      key: "write-flow-audit",
      label: "场景与审计结果",
      summary: pending?.validation?.summary || "展示当前章节的 scene drafts 与验证结果。",
      status: write.status,
      bodyHtml: renderArtifactList([
        pending.sceneDrafts?.length ? renderArtifactBlock("Scene Drafts", renderJsonBlock(pending.sceneDrafts), "accent") : "",
        pending.validation ? renderArtifactBlock("验证结果", renderJsonBlock(pending.validation), pillTone(write.status)) : "",
        pending.auditDrift?.markdown || pending.validation?.auditDrift?.markdown
          ? renderArtifactBlock(
            "漂移提示",
            renderMarkdownBlock(pending.auditDrift?.markdown || pending.validation.auditDrift.markdown),
            pillTone(write.status),
          )
          : "",
      ].filter(Boolean)),
    });
  }

  if (write.pendingReview?.target === "chapter_outline") {
    ensureSectionDefaultExpanded("write-flow-review-outline");
    items.push({
      key: "write-flow-review-outline",
      label: "章节细纲审查",
      summary: "先确认章节细纲，再进入正文生成。",
      status: "pending_review",
      bodyHtml: renderChapterOutlineReviewBody(pending),
    });
  }

  if (write.pendingReview?.target === "chapter") {
    ensureSectionDefaultExpanded("write-flow-review-chapter");
    items.push({
      key: "write-flow-review-chapter",
      label: "章节审查",
      summary: "审阅当前章节正文，决定锁章、整章重写或局部修订。",
      status: "pending_review",
      bodyHtml: renderChapterReviewBody(pending),
    });
  }

  return items;
}

function renderWriteSection() {
  const write = snapshot.project.phase.write;
  const enabled = snapshot.project.phase.plan.status === "locked";
  const pending = snapshot.staged.pendingChapter;
  const outlineOptions = normalizedOutlineOptionsFromSnapshot(pending);

  return `
    <section class="playground-panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Write Stage</div>
          <h2>章节写作流程</h2>
        </div>
        <div class="actions">
          <label class="field compact-field">
            <span>方案数</span>
            <select id="outline-variant-count" ${disabledAttr(mutationBusy() || !enabled)}>
              ${[2, 3, 4, 5].map((count) => `<option value="${count}" ${outlineOptions.variantCount === count ? "selected" : ""}>${count}</option>`).join("")}
            </select>
          </label>
          <label class="field compact-field">
            <span>发散度</span>
            <select id="outline-diversity-preset" ${disabledAttr(mutationBusy() || !enabled)}>
              <option value="standard" ${outlineOptions.diversityPreset === "standard" ? "selected" : ""}>standard</option>
              <option value="wide" ${outlineOptions.diversityPreset === "wide" ? "selected" : ""}>wide</option>
            </select>
          </label>
          <button class="button button-secondary" id="write-run-button" ${disabledAttr(
            mutationBusy() || !enabled || write.status === "chapter_pending_review" || write.status === "chapter_outline_pending_review",
          )}>${mutationBusy("write_run") ? "生成中..." : "生成下一章细纲"}</button>
        </div>
      </div>
      <div class="metrics">
        <div class="metric"><span>当前状态</span><strong>${escapeHtml(write.status)}</strong></div>
        <div class="metric"><span>已锁定章节</span><strong>${escapeHtml(String(write.currentChapterNumber || 0))}</strong></div>
        <div class="metric"><span>最近运行</span><strong>${escapeHtml(write.lastRunId || "暂无")}</strong></div>
      </div>
      ${enabled ? "" : `<div class="empty" style="margin-top:16px;">需要先锁定完整大纲，Write 阶段才会开放。</div>`}
      ${renderTimeline("write-flow", enabled ? buildWriteTimelineItems() : [], "章节细纲、正文、审计和审查节点会在这里沿流程展开。")}
    </section>
  `;
}

function renderChapterSection() {
  const chapters = snapshot.chapters || [];
  const latestChapterId = chapters.at(-1)?.chapter_id || "";
  const writePending = Boolean(snapshot.project?.phase?.write?.pendingReview?.chapterId);
  return `
    <section class="playground-panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Chapter Index</div>
          <h2>已锁定章节</h2>
        </div>
      </div>
      <div class="chapter-list">
        ${chapters.length ? chapters.map((chapter) => renderCollapsibleCard({
          key: `chapter-${chapter.chapter_id}`,
          className: "chapter-card",
          titleHtml: `<strong>${escapeHtml(chapter.chapter_id)} · ${escapeHtml(chapter.title)}</strong>`,
          bodyHtml: `
            <p>${escapeHtml(chapter.summary_50)}</p>
            ${chapter.chapter_id === latestChapterId ? `
              <div class="actions" style="margin-top:12px;">
                <button
                  class="button button-danger"
                  type="button"
                  data-delete-locked-chapter="${escapeHtml(chapter.chapter_id)}"
                  ${disabledAttr(mutationBusy() || writePending)}
                >
                  ${mutationBusy("chapter_delete") ? "删除中..." : "删除此章"}
                </button>
                <small>仅支持依次删除最新锁定章节。</small>
              </div>
            ` : ""}
          `,
        })).join("") : `<div class="empty">还没有锁定的章节。</div>`}
      </div>
    </section>
  `;
}

function renderMainContent() {
  if (activeMainSection === "plan") {
    return renderPlanSection();
  }
  if (activeMainSection === "write") {
    return renderWriteSection();
  }
  if (activeMainSection === "chapters") {
    return renderChapterSection();
  }
  return renderOverviewSection();
}

function renderProjectPanel() {
  const project = snapshot.project.project;
  const providerRuntime = snapshot.provider;
  const availableProviders = providerRuntime.availableProviders || [];
  const primaryRuntime = providerRuntime.agentModels?.primary || null;
  const secondaryRuntime = providerRuntime.agentModels?.secondary || null;
  const primaryProvider =
    availableProviders.find((item) => item.id === primaryRuntime?.providerId) ||
    availableProviders.find((item) => item.id === providerRuntime.providerId) ||
    availableProviders[0] ||
    null;
  const secondaryProvider =
    availableProviders.find((item) => item.id === secondaryRuntime?.providerId) ||
    primaryProvider;

  return `
    <section class="panel utility-panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Project Setup</div>
          <h2>项目设定</h2>
        </div>
        <div class="pill-row">
          ${renderPill("主力", primaryRuntime?.providerName || providerRuntime.providerName)}
          ${renderPill("辅助", secondaryRuntime?.providerName || secondaryRuntime?.providerId || "未配置")}
        </div>
      </div>
      <div class="provider-switch-card">
        <div class="provider-switch-head">
          <div>
            <div class="eyebrow">Model Router</div>
            <h3>模型切换</h3>
          </div>
          <div class="pill-row">
            ${renderPill("复杂 Agent", primaryRuntime?.model || providerRuntime.responseModel)}
            ${renderPill("简单 Agent", secondaryRuntime?.model || providerRuntime.reviewModel)}
          </div>
        </div>
        <form class="project-form" id="provider-config-form">
          <div class="form-grid">
            <div class="field">
              <label>主力 Provider</label>
              <select name="primaryProviderId" id="primary-provider-switcher" data-slot="primary" ${disabledAttr(mutationBusy())}>
                ${availableProviders.map((item) => `
                  <option
                    value="${escapeHtml(item.id)}"
                    data-model="${escapeHtml(item.responseModel || "")}"
                    data-wire-api="${escapeHtml(item.wireApi || "")}"
                    data-base-url="${escapeHtml(item.baseUrl || "")}"
                    data-has-api-key="${item.hasApiKey ? "true" : "false"}"
                    ${item.id === primaryRuntime?.providerId ? "selected" : ""}
                  >${escapeHtml(item.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>主力协议</label>
              <input id="primary-provider-wire-api" value="${escapeHtml(primaryProvider?.wireApi || primaryRuntime?.apiStyle || providerRuntime.apiStyle || "")}" disabled />
            </div>
            <div class="field full">
              <label>主力 Base URL</label>
              <input id="primary-provider-base-url" value="${escapeHtml(primaryProvider?.baseUrl || primaryRuntime?.baseUrl || providerRuntime.baseUrl || "")}" disabled />
            </div>
            <div class="field">
              <label>主力模型</label>
              <input name="primaryModel" value="${escapeHtml(primaryRuntime?.model || primaryProvider?.responseModel || providerRuntime.responseModel || "")}" ${disabledAttr(mutationBusy())} />
            </div>
            <div class="field">
              <label>主力 API Key 状态</label>
              <input id="primary-provider-key-status" value="${primaryProvider?.hasApiKey ? "已检测到当前 Provider 的 API Key" : "当前 Provider 尚未配置 API Key"}" disabled />
            </div>
            <div class="field">
              <label>辅助 Provider</label>
              <select name="secondaryProviderId" id="secondary-provider-switcher" data-slot="secondary" ${disabledAttr(mutationBusy())}>
                ${availableProviders.map((item) => `
                  <option
                    value="${escapeHtml(item.id)}"
                    data-model="${escapeHtml(item.responseModel || "")}"
                    data-wire-api="${escapeHtml(item.wireApi || "")}"
                    data-base-url="${escapeHtml(item.baseUrl || "")}"
                    data-has-api-key="${item.hasApiKey ? "true" : "false"}"
                    ${item.id === secondaryRuntime?.providerId ? "selected" : ""}
                  >${escapeHtml(item.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>辅助协议</label>
              <input id="secondary-provider-wire-api" value="${escapeHtml(secondaryProvider?.wireApi || secondaryRuntime?.apiStyle || providerRuntime.apiStyle || "")}" disabled />
            </div>
            <div class="field full">
              <label>辅助 Base URL</label>
              <input id="secondary-provider-base-url" value="${escapeHtml(secondaryProvider?.baseUrl || secondaryRuntime?.baseUrl || providerRuntime.baseUrl || "")}" disabled />
            </div>
            <div class="field">
              <label>辅助模型</label>
              <input name="secondaryModel" value="${escapeHtml(secondaryRuntime?.model || secondaryProvider?.responseModel || providerRuntime.reviewModel || "")}" ${disabledAttr(mutationBusy())} />
            </div>
            <div class="field">
              <label>辅助 API Key 状态</label>
              <input id="secondary-provider-key-status" value="${secondaryProvider?.hasApiKey ? "已检测到当前 Provider 的 API Key" : "当前 Provider 尚未配置 API Key"}" disabled />
            </div>
            <div class="field">
              <label>Codex 模型</label>
              <input value="${escapeHtml(providerRuntime.codexResponseModel || primaryProvider?.codexResponseModel || "")}" disabled />
            </div>
            <div class="field full">
              <label>配置来源</label>
              <input value="${escapeHtml(
                providerRuntime.configSource === "codex_file"
                  ? `novelex.codex.toml · ${providerRuntime.configLoaded ? "已加载" : "加载失败"}`
                  : "运行时配置 / 环境变量",
              )}" disabled />
            </div>
            <div class="field full">
              <label>配置文件路径</label>
              <input value="${escapeHtml(providerRuntime.configPath || "未定位到配置文件")}" disabled />
            </div>
          </div>
          <p class="helper-text">
            这里的切换会直接写回 <code>novelex.codex.toml</code> 的 <code>agent_models.primary</code> 与 <code>agent_models.secondary</code>。
          </p>
          <p class="helper-text">
            主力模型负责复杂 agent，辅助模型负责简单 agent。API Key 与 Base URL 都以 <code>novelex.codex.toml</code> 为准。
            ${providerRuntime.configError ? ` 当前配置文件错误：${escapeHtml(providerRuntime.configError)}` : ""}
          </p>
          <div class="actions">
            <button class="button button-primary" type="submit" ${disabledAttr(mutationBusy())}>
              ${mutationBusy("provider_save") ? "切换中..." : "保存并切换模型"}
            </button>
          </div>
        </form>
      </div>
      <form class="project-form" id="project-form">
        <fieldset ${disabledAttr(mutationBusy())} style="border: 0; padding: 0; margin: 0; min-inline-size: 0;">
          <div class="form-grid">
            <div class="field">
              <label>推理强度</label>
              <input value="${escapeHtml(`${providerRuntime.reasoningEffort || "medium"}（由当前 Provider 配置决定）`)}" disabled />
            </div>
            <div class="field">
              <label>作品标题</label>
              <input name="title" value="${escapeHtml(project.title)}" />
            </div>
            <div class="field">
              <label>类型</label>
              <input name="genre" value="${escapeHtml(project.genre)}" />
            </div>
            <div class="field full">
              <label>故事前提</label>
              <textarea name="premise">${escapeHtml(project.premise)}</textarea>
            </div>
            <div class="field">
              <label>设定 / 场域</label>
              <input name="setting" value="${escapeHtml(project.setting)}" />
            </div>
            <div class="field">
              <label>主题</label>
              <input name="theme" value="${escapeHtml(project.theme)}" />
            </div>
            <div class="field">
              <label>主角目标</label>
              <input name="protagonistGoal" value="${escapeHtml(project.protagonistGoal)}" />
            </div>
            <div class="field">
              <label>目标章节数</label>
              <input name="totalChapters" type="number" value="${escapeHtml(project.totalChapters)}" />
            </div>
            <div class="field">
              <label>目标单章字数</label>
              <input name="targetWordsPerChapter" type="number" value="${escapeHtml(project.targetWordsPerChapter)}" />
            </div>
            <div class="field">
              <label>阶段数</label>
              <input name="stageCount" type="number" value="${escapeHtml(project.stageCount)}" />
            </div>
            <div class="field full">
              <label>风格说明</label>
              <textarea name="styleNotes">${escapeHtml(project.styleNotes)}</textarea>
            </div>
            <div class="field full">
              <label>研究备注</label>
              <textarea name="researchNotes">${escapeHtml(project.researchNotes)}</textarea>
            </div>
          </div>
        </fieldset>
        <p class="helper-text">
          人物名单与名称会在 <code>Plan</code> 阶段自动生成。若题材明显属于真实历史背景，系统会优先混合真实历史人物与虚构角色。
        </p>
        <p class="helper-text">
          项目设定和模型切换现在分离了。上方切换器改的是大模型路由；这里保存的是作品本身的题材、设定和写作目标。
        </p>
        <div class="actions">
          <button class="button button-primary" type="submit" ${disabledAttr(mutationBusy())}>
            ${mutationBusy("project_save") ? "保存中..." : "保存项目设定"}
          </button>
        </div>
      </form>
    </section>
  `;
}

function renderStyleFingerprintPanel() {
  const styleFingerprints = snapshot.styleFingerprints || [];
  const currentProject = snapshot.project.project || {};
  const selectedSummary = styleFingerprints.find((item) => item.id === selectedStyleFingerprintId) || null;
  const currentSummary = currentStyleFingerprintSummary();
  const detail = selectedStyleFingerprintDetail;
  const detailMatchesSelection = detail?.metadata?.id === selectedStyleFingerprintId;

  return `
    <section class="panel utility-panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Style Fingerprints</div>
          <h2>风格指纹库</h2>
        </div>
        <div class="pill-row">
          ${renderPill("库内数量", String(styleFingerprints.length))}
          ${renderPill("当前项目", currentSummary?.name || "未选择")}
        </div>
      </div>
      <div class="style-panel-grid">
        <div class="style-column">
          <div class="preview-box">
            <h3>生成新风格指纹</h3>
            <form class="project-form" id="style-fingerprint-generate-form">
              <div class="field">
                <label>风格名称</label>
                <input name="name" placeholder="例如：冷峻近贴视角" ${disabledAttr(mutationBusy())} />
              </div>
              <div class="field">
                <label>范文</label>
                <textarea name="sampleText" class="style-sample-textarea" placeholder="粘贴一篇你希望模仿其文风的范文。系统会抽取叙述距离、措辞、节奏、修辞、对白与禁忌项。" ${disabledAttr(mutationBusy())}></textarea>
              </div>
              <div class="actions">
                <button class="button button-primary" type="submit" ${disabledAttr(mutationBusy())}>
                  ${mutationBusy("style_generate") ? "分析中..." : "生成风格指纹"}
                </button>
              </div>
            </form>
          </div>
          <div class="preview-box">
            <h3>当前项目使用的章节风格</h3>
            <form class="project-form" id="project-style-form">
              <div class="field">
                <label>选中的风格指纹</label>
                <select name="styleFingerprintId" ${disabledAttr(mutationBusy())}>
                  <option value="">未选择，回退默认风格</option>
                  ${styleFingerprints.map((item) => `
                    <option value="${escapeHtml(item.id)}" ${currentProject.styleFingerprintId === item.id ? "selected" : ""}>
                      ${escapeHtml(item.name)}
                    </option>`).join("")}
                </select>
              </div>
              <p class="helper-text">
                ${currentSummary ? `当前生效：${escapeHtml(currentSummary.name)}。之后的新章节会直接使用它的风格指令。` : "当前没有选中风格指纹，写作阶段会继续回退到项目风格备注 / 已有风格指南。"}
              </p>
              <div class="actions">
                <button class="button button-secondary" type="submit" ${disabledAttr(mutationBusy())}>
                  ${mutationBusy("project_style_save") ? "保存中..." : "保存章节风格选择"}
                </button>
                <button class="button button-ghost" type="button" id="clear-project-style-button" ${disabledAttr(mutationBusy())}>
                  清空选择
                </button>
              </div>
            </form>
          </div>
        </div>
        <div class="style-column">
          <div class="style-library-shell">
            <div class="style-library-list">
              ${styleFingerprints.length ? styleFingerprints.map((item) => `
                <button class="style-library-item ${selectedStyleFingerprintId === item.id ? "active" : ""}" data-style-id="${escapeHtml(item.id)}">
                  <strong>${escapeHtml(item.name)}</strong>
                  <small>${escapeHtml(item.summary || "已生成风格指纹。")}</small>
                </button>`).join("") : `<div class="empty">还没有风格指纹。先粘贴一篇范文生成第一份风格。</div>`}
            </div>
            <div class="style-detail-card">
              ${!selectedStyleFingerprintId ? `<div class="empty">从左侧选择一份风格指纹，即可查看、编辑并设置给当前项目。</div>` : ""}
              ${selectedStyleFingerprintId && styleFingerprintLoading ? `<div class="empty">风格指纹加载中...</div>` : ""}
              ${selectedStyleFingerprintId && !styleFingerprintLoading && !detailMatchesSelection ? `<div class="empty">正在准备风格详情...</div>` : ""}
              ${selectedStyleFingerprintId && detailMatchesSelection ? `
                <div class="style-detail-stack">
                  <div class="metrics">
                    <div class="metric"><span>名称</span><strong>${escapeHtml(detail.metadata.name || selectedSummary?.name || "-")}</strong></div>
                    <div class="metric"><span>字数估算</span><strong>${escapeHtml(String(detail.metadata.stats?.approxWordCount || "-"))}</strong></div>
                    <div class="metric"><span>段落数</span><strong>${escapeHtml(String(detail.metadata.stats?.paragraphCount || "-"))}</strong></div>
                  </div>
                  ${renderCollapsibleCard({
                    key: `style-fingerprint-edit-${detail.metadata.id}`,
                    className: "preview-box",
                    titleHtml: "<h3>风格指令编辑器</h3>",
                    headerMetaHtml: `<p class="document-meta">${escapeHtml(detail.metadata.updatedAt || detail.metadata.createdAt || "")}</p>`,
                    bodyHtml: `
                      <form class="project-form" id="style-fingerprint-edit-form">
                        <input type="hidden" name="styleId" value="${escapeHtml(detail.metadata.id)}" />
                        <div class="field">
                          <label>名称</label>
                          <input name="name" value="${escapeHtml(detail.metadata.name || "")}" ${disabledAttr(mutationBusy())} />
                        </div>
                        <div class="field">
                          <label>Writer 用风格指令</label>
                          <textarea name="promptMarkdown" class="style-prompt-textarea" ${disabledAttr(mutationBusy())}>${escapeHtml(detail.promptMarkdown || "")}</textarea>
                        </div>
                        <div class="actions">
                          <button class="button button-primary" type="submit" ${disabledAttr(mutationBusy())}>
                            ${mutationBusy("style_update") ? "保存中..." : "保存风格指令"}
                          </button>
                        </div>
                      </form>
                    `,
                  })}
                  ${renderCollapsibleCard({
                    key: `style-fingerprint-analysis-${detail.metadata.id}`,
                    className: "preview-box",
                    titleHtml: "<h3>结构化风格分析（只读）</h3>",
                    bodyHtml: renderJsonBlock(detail.fingerprint || {}),
                  })}
                  ${renderCollapsibleCard({
                    key: `style-fingerprint-sample-${detail.metadata.id}`,
                    className: "preview-box",
                    titleHtml: "<h3>原始范文（只读）</h3>",
                    bodyHtml: renderMarkdownBlock(detail.sampleMarkdown || ""),
                  })}
                </div>` : ""}
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderRagPanel() {
  const collections = snapshot.ragCollections || [];
  const currentProject = snapshot.project.project || {};
  const selectedIds = new Set(currentProject.ragCollectionIds || []);

  return `
    <section class="panel utility-panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Reference RAG</div>
          <h2>范文语料库</h2>
        </div>
        <div class="pill-row">
          ${renderPill("共享库", String(collections.length))}
          ${renderPill("当前绑定", String(selectedIds.size))}
        </div>
      </div>
      <div class="style-panel-grid">
        <div class="style-column">
          <div class="preview-box">
            <h3>新建共享 collection</h3>
            <form class="project-form" id="rag-collection-create-form">
              <div class="field">
                <label>Collection 名称</label>
                <input name="name" placeholder="例如：晚明海权范文" ${disabledAttr(mutationBusy())} />
              </div>
              <p class="helper-text">
                新建后请把范文手动放入对应的 <code>sources/</code> 目录，再点击“重建索引”。
              </p>
              <div class="actions">
                <button class="button button-primary" type="submit" ${disabledAttr(mutationBusy())}>
                  ${mutationBusy("rag_create") ? "创建中..." : "创建 collection"}
                </button>
              </div>
            </form>
          </div>
          <div class="preview-box">
            <h3>当前项目绑定</h3>
            <form class="project-form" id="project-rag-form">
              <div class="field">
                <label>启用的范文库</label>
                <div class="checkbox-stack">
                  ${collections.length ? collections.map((item) => `
                    <label class="checkbox-card">
                      <input
                        type="checkbox"
                        data-rag-collection-bind="${escapeHtml(item.id)}"
                        ${selectedIds.has(item.id) ? "checked" : ""}
                        ${disabledAttr(mutationBusy())}
                      />
                      <span>
                        <strong>${escapeHtml(item.name)}</strong><br />
                        <small>${escapeHtml(item.id)} · chunks ${escapeHtml(String(item.chunkCount || 0))}</small>
                      </span>
                    </label>`).join("") : `<div class="empty">还没有共享范文库。</div>`}
                </div>
              </div>
              <p class="helper-text">
                写章节时只会检索这里勾选的 collection。Embedding 运行时需要环境变量 <code>ZHIPU_API_KEY</code>。
              </p>
              <div class="actions">
                <button class="button button-secondary" type="submit" ${disabledAttr(mutationBusy())}>
                  ${mutationBusy("project_rag_save") ? "保存中..." : "保存项目绑定"}
                </button>
              </div>
            </form>
          </div>
        </div>
        <div class="style-column">
          <div class="style-library-shell">
            <div class="style-detail-card">
              <div class="style-detail-stack">
                ${collections.length ? collections.map((item) => renderCollapsibleCard({
                  key: `rag-collection-${item.id}`,
                  className: "preview-box",
                  titleHtml: `<h3>${escapeHtml(item.name)}</h3>`,
                  headerMetaHtml: `<p class="document-meta">${escapeHtml(item.id)} · ${escapeHtml(item.lastBuiltAt || "尚未构建")}</p>`,
                  bodyHtml: `
                    <div class="metrics">
                      <div class="metric"><span>文档数</span><strong>${escapeHtml(String(item.fileCount || 0))}</strong></div>
                      <div class="metric"><span>Chunk 数</span><strong>${escapeHtml(String(item.chunkCount || 0))}</strong></div>
                      <div class="metric"><span>编码</span><strong>${escapeHtml((item.encodings || []).join(", ") || "-")}</strong></div>
                    </div>
                    <p style="margin-top: 12px;"><strong>sources 目录：</strong><br /><code>${escapeHtml(item.sourceDir || item.sourceDirRelative || "-")}</code></p>
                    ${item.lastError ? `<p style="margin-top: 12px; color: #b42318;"><strong>最近错误：</strong> ${escapeHtml(item.lastError)}</p>` : ""}
                    <div class="actions" style="margin-top: 12px;">
                      <button class="button button-primary" type="button" data-rag-rebuild="${escapeHtml(item.id)}" ${disabledAttr(mutationBusy())}>
                        ${mutationBusy("rag_rebuild") ? "重建中..." : "重建索引"}
                      </button>
                    </div>
                  `,
                })).join("") : `<div class="empty">新建第一套 collection 之后，这里会显示索引状态与 sources 路径。</div>`}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderOpeningPanel() {
  const collections = snapshot.openingCollections || [];
  const currentProject = snapshot.project.project || {};
  const selectedIds = new Set(currentProject.openingCollectionIds || []);

  return `
    <section class="panel utility-panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Golden Opening</div>
          <h2>黄金三章参考库</h2>
        </div>
        <div class="pill-row">
          ${renderPill("共享库", String(collections.length))}
          ${renderPill("当前绑定", String(selectedIds.size))}
        </div>
      </div>
      <div class="style-panel-grid">
        <div class="style-column">
          <div class="preview-box">
            <h3>新建共享 collection</h3>
            <form class="project-form" id="opening-collection-create-form">
              <div class="field">
                <label>Collection 名称</label>
                <input name="name" placeholder="例如：强钩子都市开头" ${disabledAttr(mutationBusy())} />
              </div>
              <p class="helper-text">
                新建后请把优秀网文前三章手动放入对应的 <code>sources/</code> 目录，再点击“重建索引”。
              </p>
              <div class="actions">
                <button class="button button-primary" type="submit" ${disabledAttr(mutationBusy())}>
                  ${mutationBusy("opening_create") ? "创建中..." : "创建 collection"}
                </button>
              </div>
            </form>
          </div>
          <div class="preview-box">
            <h3>当前项目绑定</h3>
            <form class="project-form" id="project-opening-form">
              <div class="field">
                <label>启用的开头参考库</label>
                <div class="checkbox-stack">
                  ${collections.length ? collections.map((item) => `
                    <label class="checkbox-card">
                      <input
                        type="checkbox"
                        data-opening-collection-bind="${escapeHtml(item.id)}"
                        ${selectedIds.has(item.id) ? "checked" : ""}
                        ${disabledAttr(mutationBusy())}
                      />
                      <span>
                        <strong>${escapeHtml(item.name)}</strong><br />
                        <small>${escapeHtml(item.id)} · chunks ${escapeHtml(String(item.chunkCount || 0))}</small>
                      </span>
                    </label>`).join("") : `<div class="empty">还没有黄金三章参考库。</div>`}
                </div>
              </div>
              <p class="helper-text">
                Plan 阶段全程会使用这里勾选的 collection；Write 阶段仅第 1-3 章会强注入这些开头结构参考。
              </p>
              <div class="actions">
                <button class="button button-secondary" type="submit" ${disabledAttr(mutationBusy())}>
                  ${mutationBusy("project_opening_save") ? "保存中..." : "保存项目绑定"}
                </button>
              </div>
            </form>
          </div>
        </div>
        <div class="style-column">
          <div class="style-library-shell">
            <div class="style-detail-card">
              <div class="style-detail-stack">
                ${collections.length ? collections.map((item) => renderCollapsibleCard({
                  key: `opening-collection-${item.id}`,
                  className: "preview-box",
                  titleHtml: `<h3>${escapeHtml(item.name)}</h3>`,
                  headerMetaHtml: `<p class="document-meta">${escapeHtml(item.id)} · ${escapeHtml(item.lastBuiltAt || "尚未构建")}</p>`,
                  bodyHtml: `
                    <div class="metrics">
                      <div class="metric"><span>文档数</span><strong>${escapeHtml(String(item.fileCount || 0))}</strong></div>
                      <div class="metric"><span>Chunk 数</span><strong>${escapeHtml(String(item.chunkCount || 0))}</strong></div>
                      <div class="metric"><span>编码</span><strong>${escapeHtml((item.encodings || []).join(", ") || "-")}</strong></div>
                    </div>
                    <p style="margin-top: 12px;"><strong>sources 目录：</strong><br /><code>${escapeHtml(item.sourceDir || item.sourceDirRelative || "-")}</code></p>
                    ${item.lastError ? `<p style="margin-top: 12px; color: #b42318;"><strong>最近错误：</strong> ${escapeHtml(item.lastError)}</p>` : ""}
                    <div class="actions" style="margin-top: 12px;">
                      <button class="button button-primary" type="button" data-opening-rebuild="${escapeHtml(item.id)}" ${disabledAttr(mutationBusy())}>
                        ${mutationBusy("opening_rebuild") ? "重建中..." : "重建索引"}
                      </button>
                    </div>
                  `,
                })).join("") : `<div class="empty">新建第一套黄金三章参考 collection 之后，这里会显示索引状态与 sources 路径。</div>`}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderLogsPanel() {
  const logs = [...(snapshot.runs.plan || []), ...(snapshot.runs.write || [])]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 8);

  return `
    <section class="panel utility-panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Run History</div>
          <h2>最近运行</h2>
        </div>
      </div>
      <div class="logs">
        ${logs.length ? logs.map((run) => renderCollapsibleCard({
          key: `log-${run.id}`,
          className: "log-card",
          titleHtml: `<strong>${escapeHtml(run.id)}</strong>`,
          headerMetaHtml: `<span class="timeline-inline-meta">${renderBadge(run.phase, "accent")}${renderBadge(run.target || "run", pillTone(run.target || run.phase))}</span>`,
          bodyHtml: `
            <p>${escapeHtml(run.summary || "-")}</p>
            <p><small>${escapeHtml(run.phase)} · ${escapeHtml(run.target || "")} · ${escapeHtml(run.startedAt)}</small></p>
            ${run.steps?.length ? `<div class="history-steps">${run.steps.map((step, index) => `
              <div class="history-step">
                <strong>${escapeHtml(`${index + 1}. ${step.label || step.id || "step"}`)}</strong>
                <p>${escapeHtml(step.summary || "-")}</p>
                ${step.preview ? `<p><small>${escapeHtml(step.preview)}</small></p>` : ""}
              </div>`).join("")}</div>` : ""}
          `,
        })).join("") : `<div class="empty">还没有运行记录。</div>`}
      </div>
    </section>
  `;
}

function renderDocumentsPanel() {
  const selectedDocument = snapshot.documents.find((doc) => doc.label === selectedDocumentPath) || null;

  if (selectedDocument) {
    ensureSectionDefaultExpanded(`document-${selectedDocument.label}`);
  }

  return `
    <section class="panel utility-panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Document Browser</div>
          <h2>状态文档浏览器</h2>
        </div>
      </div>
      <div class="document-shell">
        <div class="document-list">
          ${snapshot.documents.length ? snapshot.documents.map((doc) => `
            <button class="document-item ${selectedDocumentPath === doc.label ? "active" : ""}" data-document-path="${escapeHtml(doc.label)}">
              <strong>${escapeHtml(doc.label)}</strong><br />
              <small>${escapeHtml(doc.scope)} · ${escapeHtml(doc.modifiedAt)}</small>
            </button>`).join("") : `<div class="empty">还没有可浏览的文档。</div>`}
        </div>
        ${
          selectedDocument
            ? renderCollapsibleCard({
              key: `document-${selectedDocument.label}`,
              className: "document-viewer",
              titleHtml: `<h3>${escapeHtml(selectedDocument.label)}</h3>`,
              headerMetaHtml: `<p class="document-meta">${escapeHtml(selectedDocument.scope)} · ${escapeHtml(selectedDocument.modifiedAt)}</p>`,
              bodyHtml: `<div class="document-viewer-content empty" id="document-viewer-content">文档加载中...</div>`,
            })
            : `<div class="document-viewer"><div class="empty">选择左侧文档即可查看内容。</div></div>`
        }
      </div>
    </section>
  `;
}

function renderUtilityTabs() {
  return `
    <aside class="utility-panel-shell ${utilityCollapsed ? "is-collapsed" : ""} ${mobileUtilityOpen ? "is-mobile-open" : ""}">
      <div class="utility-header">
        <div class="utility-header-copy">
          <div class="eyebrow">Utility Panel</div>
          <h2>右侧面板</h2>
        </div>
        <div class="utility-header-actions">
          <button
            class="sidebar-toggle utility-toggle"
            type="button"
            data-toggle-utility-panel="true"
            aria-expanded="${utilityCollapsed ? "false" : "true"}"
            title="${utilityCollapsed ? "展开项目设置栏" : "收起项目设置栏"}"
          >
            ${utilityCollapsed ? renderIcon("chevronLeft") : renderIcon("chevronRight")}
          </button>
          <button class="button button-ghost mobile-only" type="button" data-close-utility="true">关闭</button>
        </div>
      </div>
      <div class="utility-tabs">
        ${renderUtilityTabButton("project", "项目设置", "project")}
        ${renderUtilityTabButton("resources", "资源配置", "resources")}
        ${renderUtilityTabButton("documents", "状态文档", "documents")}
        ${renderUtilityTabButton("history", "运行历史", "history")}
      </div>
      <div class="utility-body">
        ${activeSideTab === "project" ? renderProjectPanel() : ""}
        ${activeSideTab === "resources" ? `${renderStyleFingerprintPanel()}${renderRagPanel()}${renderOpeningPanel()}` : ""}
        ${activeSideTab === "documents" ? renderDocumentsPanel() : ""}
        ${activeSideTab === "history" ? renderLogsPanel() : ""}
      </div>
    </aside>
  `;
}

function renderShell() {
  if (!snapshot) {
    return `
      <div class="app-shell app-shell-empty ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${utilityCollapsed ? "utility-collapsed" : ""}">
        ${renderWorkspaceSidebar()}
        <main class="playground-shell">
          <section class="playground-panel empty-state-panel">
            <div class="empty">${workspaceProjects.length ? "请选择一个项目进入工作区。" : "当前还没有项目，先新建一个项目吧。"}</div>
          </section>
        </main>
      </div>
    `;
  }

  return `
    <div class="app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${utilityCollapsed ? "utility-collapsed" : ""}">
      ${renderWorkspaceSidebar()}
      <main class="playground-shell">
        ${renderPlaygroundHeader()}
        ${renderMainContent()}
      </main>
      ${renderUtilityTabs()}
      <div class="shell-overlay ${mobileSidebarOpen || mobileUtilityOpen ? "is-visible" : ""}" data-close-overlays="true"></div>
    </div>
  `;
}

function render() {
  app.innerHTML = renderShell();
  bindEvents();
  renderSelectedDocument();
  renderSelectedStyleFingerprint();
  scheduleServerPolling();
}

function collectFormData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function syncProviderDraftFromSelection(slot) {
  const normalizedSlot = slot === "secondary" ? "secondary" : "primary";
  const select = document.querySelector(`#${normalizedSlot}-provider-switcher`);
  if (!select) {
    return;
  }

  const option = select.selectedOptions?.[0];
  if (!option) {
    return;
  }

  const form = select.form;
  if (!form) {
    return;
  }

  const modelInput = form.querySelector(`[name="${normalizedSlot}Model"]`);
  const wireApiInput = document.querySelector(`#${normalizedSlot}-provider-wire-api`);
  const baseUrlInput = document.querySelector(`#${normalizedSlot}-provider-base-url`);
  const keyStatusInput = document.querySelector(`#${normalizedSlot}-provider-key-status`);

  if (modelInput) {
    modelInput.value = option.dataset.model || "";
  }
  if (wireApiInput) {
    wireApiInput.value = option.dataset.wireApi || "";
  }
  if (baseUrlInput) {
    baseUrlInput.value = option.dataset.baseUrl || "";
  }
  if (keyStatusInput) {
    keyStatusInput.value =
      option.dataset.hasApiKey === "true"
        ? "已检测到当前 Provider 的 API Key"
        : "当前 Provider 尚未配置 API Key";
  }
}

function bindEvents() {
  document.querySelectorAll("[data-select-project]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (mutationBusy()) {
        showToast("已有请求正在处理中，请稍候。");
        render();
        return;
      }

      const nextProjectId = button.getAttribute("data-select-project");
      if (!nextProjectId || nextProjectId === selectedProjectId) {
        mobileSidebarOpen = false;
        render();
        return;
      }

      selectedProjectId = nextProjectId;
      selectedDocumentPath = null;
      mobileSidebarOpen = false;
      await loadState(selectedProjectId);
    });
  });

  document.querySelector("#create-project-button")?.addEventListener("click", async () => {
    const nameInput = document.querySelector("#new-project-name");
    const name = nameInput?.value?.trim() || "新项目";

    await runMutation("project_create", async () => {
      try {
        const data = await api("/api/projects", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        selectedDocumentPath = null;
        applyServerState(data);
        mobileSidebarOpen = false;
        render();
        showToast(`项目“${name}”已创建。`);
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  const deleteProject = async () => {
    const current = workspaceProjects.find((project) => project.id === selectedProjectId);
    if (!selectedProjectId || !current) {
      showToast("当前没有可删除的项目。");
      return;
    }

    const confirmed = window.confirm(`确定要删除项目“${current.title}”吗？该项目目录及其运行数据会被一并删除。`);
    if (!confirmed) {
      return;
    }

    await runMutation("project_delete", async () => {
      try {
        const data = await api(`/api/projects?projectId=${encodeURIComponent(selectedProjectId)}`, {
          method: "DELETE",
          body: JSON.stringify({ projectId: selectedProjectId }),
        });
        selectedDocumentPath = null;
        applyServerState(data);
        render();
        showToast(`项目“${current.title}”已删除。`);
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  };

  document.querySelector("#delete-current-project-button")?.addEventListener("click", deleteProject);

  document.querySelectorAll("[data-main-section]").forEach((button) => {
    button.addEventListener("click", () => {
      setMainSection(button.getAttribute("data-main-section") || "overview");
      render();
    });
  });

  document.querySelectorAll("[data-jump-main-section]").forEach((button) => {
    button.addEventListener("click", () => {
      setMainSection(button.getAttribute("data-jump-main-section") || "overview");
      render();
    });
  });

  document.querySelectorAll("[data-side-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      setSideTab(button.getAttribute("data-side-tab") || "project");
      render();
    });
  });

  document.querySelectorAll("[data-open-utility-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      setSideTab(button.getAttribute("data-open-utility-tab") || "history");
      mobileUtilityOpen = true;
      render();
    });
  });

  document.querySelector("[data-toggle-shell-sidebar]")?.addEventListener("click", () => {
    setSidebarCollapsed(!sidebarCollapsed);
    render();
  });

  document.querySelector("[data-toggle-utility-panel]")?.addEventListener("click", () => {
    setUtilityCollapsed(!utilityCollapsed);
    render();
  });

  document.querySelector("[data-open-sidebar]")?.addEventListener("click", () => {
    mobileSidebarOpen = true;
    render();
  });

  document.querySelector("[data-open-utility]")?.addEventListener("click", () => {
    mobileUtilityOpen = true;
    render();
  });

  document.querySelector("[data-close-utility]")?.addEventListener("click", () => {
    mobileUtilityOpen = false;
    render();
  });

  document.querySelector("[data-close-overlays]")?.addEventListener("click", () => {
    mobileSidebarOpen = false;
    mobileUtilityOpen = false;
    render();
  });

  document.querySelector("#project-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = collectFormData(form);
    await runMutation("project_save", async () => {
      try {
        const data = await api("/api/project", {
          method: "POST",
          body: apiBody(payload),
        });
        applyServerState(data);
        render();
        showToast("项目设定已保存。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelector("#primary-provider-switcher")?.addEventListener("change", () => {
    syncProviderDraftFromSelection("primary");
  });

  document.querySelector("#secondary-provider-switcher")?.addEventListener("change", () => {
    syncProviderDraftFromSelection("secondary");
  });

  document.querySelector("#provider-config-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = collectFormData(form);
    await runMutation("provider_save", async () => {
      try {
        const data = await api("/api/provider/config", {
          method: "POST",
          body: apiBody(payload),
        });
        applyServerState(data);
        render();
        showToast("模型配置已写入 novelex.codex.toml。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelector("#style-fingerprint-generate-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = collectFormData(form);

    await runMutation("style_generate", async () => {
      try {
        const data = await api("/api/style-fingerprints/generate", {
          method: "POST",
          body: apiBody(payload),
        });
        selectedStyleFingerprintId = data.styleFingerprint?.metadata?.id || selectedStyleFingerprintId;
        selectedStyleFingerprintDetail = data.styleFingerprint || null;
        styleFingerprintLoading = false;
        applyServerState(data);
        render();
        form.reset();
        showToast("风格指纹已生成。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelector("#project-style-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = collectFormData(form);

    await runMutation("project_style_save", async () => {
      try {
        const data = await api("/api/project/style", {
          method: "POST",
          body: apiBody(payload),
        });
        applyServerState(data);
        render();
        showToast(payload.styleFingerprintId ? "章节风格选择已保存。" : "已清空章节风格选择。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelector("#clear-project-style-button")?.addEventListener("click", async () => {
    await runMutation("project_style_save", async () => {
      try {
        const data = await api("/api/project/style", {
          method: "POST",
          body: apiBody({ styleFingerprintId: "" }),
        });
        applyServerState(data);
        render();
        showToast("已回退到默认章节风格。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelector("#style-fingerprint-edit-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = collectFormData(form);

    await runMutation("style_update", async () => {
      try {
        const data = await api("/api/style-fingerprint/update", {
          method: "POST",
          body: apiBody(payload),
        });
        selectedStyleFingerprintId = data.styleFingerprint?.metadata?.id || selectedStyleFingerprintId;
        selectedStyleFingerprintDetail = data.styleFingerprint || null;
        styleFingerprintLoading = false;
        applyServerState(data);
        render();
        showToast("风格指令已保存。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelector("#rag-collection-create-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = collectFormData(form);

    await runMutation("rag_create", async () => {
      try {
        const data = await api("/api/rag/collections", {
          method: "POST",
          body: apiBody(payload),
        });
        applyServerState(data);
        render();
        form.reset();
        showToast("共享范文库已创建。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelector("#project-rag-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const ragCollectionIds = [...document.querySelectorAll("[data-rag-collection-bind]:checked")]
      .map((item) => item.getAttribute("data-rag-collection-bind"))
      .filter(Boolean);

    await runMutation("project_rag_save", async () => {
      try {
        const data = await api("/api/project/rag", {
          method: "POST",
          body: apiBody({ ragCollectionIds }),
        });
        applyServerState(data);
        render();
        showToast("项目范文库绑定已保存。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-rag-rebuild]").forEach((button) => {
    button.addEventListener("click", async () => {
      const collectionId = button.getAttribute("data-rag-rebuild");
      if (!collectionId) {
        return;
      }

      await runMutation("rag_rebuild", async () => {
        try {
          const data = await api("/api/rag/rebuild", {
            method: "POST",
            body: apiBody({ collectionId }),
          });
          applyServerState(data);
          render();
          showToast("RAG 索引已重建。");
        } catch (error) {
          await syncStateAfterError();
          showToast(error.message);
        }
      });
    });
  });

  document.querySelector("#opening-collection-create-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = collectFormData(form);

    await runMutation("opening_create", async () => {
      try {
        const data = await api("/api/opening/collections", {
          method: "POST",
          body: apiBody(payload),
        });
        applyServerState(data);
        render();
        form.reset();
        showToast("黄金三章参考库已创建。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelector("#project-opening-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const openingCollectionIds = [...document.querySelectorAll("[data-opening-collection-bind]:checked")]
      .map((item) => item.getAttribute("data-opening-collection-bind"))
      .filter(Boolean);

    await runMutation("project_opening_save", async () => {
      try {
        const data = await api("/api/project/openings", {
          method: "POST",
          body: apiBody({ openingCollectionIds }),
        });
        applyServerState(data);
        render();
        showToast("项目黄金三章参考绑定已保存。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-opening-rebuild]").forEach((button) => {
    button.addEventListener("click", async () => {
      const collectionId = button.getAttribute("data-opening-rebuild");
      if (!collectionId) {
        return;
      }

      await runMutation("opening_rebuild", async () => {
        try {
          const data = await api("/api/opening/rebuild", {
            method: "POST",
            body: apiBody({ collectionId }),
          });
          applyServerState(data);
          render();
          showToast("黄金三章参考索引已重建。");
        } catch (error) {
          await syncStateAfterError();
          showToast(error.message);
        }
      });
    });
  });

  document.querySelector("#plan-run-button")?.addEventListener("click", async () => {
    await runMutation("plan_run", async () => {
      try {
        const data = await api("/api/plan/run", { method: "POST", body: apiBody({}) });
        applyServerState(data);
        setMainSection("plan");
        render();
        showToast("Plan 阶段已推进。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelector("#write-run-button")?.addEventListener("click", async () => {
    const outlineOptions = {
      variantCount: Number(document.querySelector("#outline-variant-count")?.value || 3),
      diversityPreset: document.querySelector("#outline-diversity-preset")?.value || "wide",
    };
    await runMutation("write_run", async () => {
      try {
        const data = await api("/api/write/run", { method: "POST", body: apiBody({ outlineOptions }) });
        applyServerState(data);
        setMainSection("write");
        render();
        showToast("章节细纲候选已生成。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-delete-locked-chapter]").forEach((button) => {
    button.addEventListener("click", async () => {
      const chapterId = button.getAttribute("data-delete-locked-chapter");
      if (!chapterId) {
        return;
      }

      const confirmed = window.confirm(`确定删除已锁定章节 ${chapterId} 吗？当前只允许按倒序删除最新锁定章节。`);
      if (!confirmed) {
        return;
      }

      await runMutation("chapter_delete", async () => {
        try {
          const data = await api("/api/write/delete", {
            method: "POST",
            body: apiBody({ chapterId }),
          });
          applyServerState(data);
          render();
          showToast(`${chapterId} 已删除。`);
        } catch (error) {
          await syncStateAfterError();
          showToast(error.message);
        }
      });
    });
  });

  document.querySelectorAll("[data-outline-add-scene]").forEach((button) => {
    button.addEventListener("click", () => {
      const chapterId = button.getAttribute("data-outline-chapter-id");
      const sceneRef = button.getAttribute("data-outline-add-scene");
      if (!chapterId || !sceneRef) {
        return;
      }
      const workbench = outlineWorkbenchFor(chapterId, snapshot?.staged?.pendingChapter || null);
      if (!workbench.sceneRefs.includes(sceneRef)) {
        workbench.sceneRefs.push(sceneRef);
      }
      render();
    });
  });

  document.querySelectorAll("[data-outline-remove-scene]").forEach((button) => {
    button.addEventListener("click", () => {
      const chapterId = button.getAttribute("data-outline-chapter-id");
      const sceneRef = button.getAttribute("data-outline-remove-scene");
      if (!chapterId || !sceneRef) {
        return;
      }
      const workbench = outlineWorkbenchFor(chapterId, snapshot?.staged?.pendingChapter || null);
      workbench.sceneRefs = workbench.sceneRefs.filter((item) => item !== sceneRef);
      render();
    });
  });

  document.querySelectorAll("[data-outline-move]").forEach((button) => {
    button.addEventListener("click", () => {
      const chapterId = button.getAttribute("data-outline-chapter-id");
      const sceneRef = button.getAttribute("data-outline-scene-ref");
      const direction = button.getAttribute("data-outline-move");
      if (!chapterId || !sceneRef || !direction) {
        return;
      }
      const workbench = outlineWorkbenchFor(chapterId, snapshot?.staged?.pendingChapter || null);
      const index = workbench.sceneRefs.indexOf(sceneRef);
      if (index === -1) {
        return;
      }
      const nextIndex = direction === "up" ? index - 1 : index + 1;
      if (nextIndex < 0 || nextIndex >= workbench.sceneRefs.length) {
        return;
      }
      const nextRefs = [...workbench.sceneRefs];
      [nextRefs[index], nextRefs[nextIndex]] = [nextRefs[nextIndex], nextRefs[index]];
      workbench.sceneRefs = nextRefs;
      render();
    });
  });

  document.querySelectorAll("[data-chapter-direct-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const chapterId = button.getAttribute("data-chapter-direct-edit");
      if (!chapterId) {
        return;
      }
      const pending = snapshot?.staged?.pendingChapter || null;
      const editWorkbench = directEditWorkbenchFor(chapterId, pending);
      editWorkbench.isEditing = true;
      editWorkbench.sourceBody = chapterBodyFromPending(pending);
      editWorkbench.draftBody = editWorkbench.sourceBody;
      const partialWorkbench = partialRevisionWorkbenchFor(chapterId, pending);
      partialWorkbench.selectedText = "";
      partialWorkbench.prefixContext = "";
      partialWorkbench.suffixContext = "";
      render();
      window.requestAnimationFrame(() => {
        const editor = document.querySelector(`[data-chapter-body-editable][data-chapter-id="${chapterId}"]`);
        editor?.focus();
      });
    });
  });

  document.querySelectorAll("[data-chapter-direct-cancel]").forEach((button) => {
    button.addEventListener("click", () => {
      const chapterId = button.getAttribute("data-chapter-direct-cancel");
      if (!chapterId) {
        return;
      }
      const editWorkbench = directEditWorkbenchFor(chapterId, snapshot?.staged?.pendingChapter || null);
      editWorkbench.isEditing = false;
      editWorkbench.draftBody = editWorkbench.sourceBody;
      render();
    });
  });

  document.querySelectorAll("[data-chapter-body-editable]").forEach((container) => {
    const syncDraft = () => {
      const chapterId = container.getAttribute("data-chapter-id") || "";
      if (!chapterId) {
        return;
      }
      const workbench = directEditWorkbenchFor(chapterId, snapshot?.staged?.pendingChapter || null);
      workbench.draftBody = String(container.innerText || "")
        .replace(/\u00a0/g, " ")
        .replace(/\r\n?/g, "\n");
    };
    container.addEventListener("input", syncDraft);
    container.addEventListener("blur", syncDraft);
  });

  document.querySelectorAll("[data-chapter-direct-save]").forEach((button) => {
    button.addEventListener("click", async () => {
      const chapterId = button.getAttribute("data-chapter-direct-save");
      if (!chapterId) {
        return;
      }
      const pending = snapshot?.staged?.pendingChapter || null;
      const workbench = directEditWorkbenchFor(chapterId, pending);
      const editor = document.querySelector(`[data-chapter-body-editable][data-chapter-id="${chapterId}"]`);
      if (editor) {
        workbench.draftBody = String(editor.innerText || "")
          .replace(/\u00a0/g, " ")
          .replace(/\r\n?/g, "\n");
      }
      const nextBody = String(workbench.draftBody || "").replace(/\r\n?/g, "\n");
      const currentBody = chapterBodyFromPending(pending);
      if (!nextBody.trim()) {
        showToast("章节正文不能为空。");
        return;
      }
      if (nextBody === currentBody) {
        workbench.isEditing = false;
        workbench.sourceBody = currentBody;
        workbench.draftBody = currentBody;
        render();
        showToast("正文没有变化。");
        return;
      }

      await runMutation("chapter_manual_edit", async () => {
        try {
          const data = await api("/api/write/manual-edit", {
            method: "POST",
            body: apiBody({
              chapterBody: nextBody,
            }),
          });
          applyServerState(data);
          const updatedPending = snapshot?.staged?.pendingChapter || null;
          const updatedChapterId = updatedPending?.chapterPlan?.chapterId || updatedPending?.chapterId || chapterId;
          const updatedWorkbench = directEditWorkbenchFor(updatedChapterId, updatedPending);
          updatedWorkbench.isEditing = false;
          updatedWorkbench.sourceBody = chapterBodyFromPending(updatedPending);
          updatedWorkbench.draftBody = updatedWorkbench.sourceBody;
          render();
          showToast("正文修改已保存。");
        } catch (error) {
          await syncStateAfterError();
          showToast(error.message);
        }
      });
    });
  });

  document.querySelectorAll("[data-chapter-body-selectable]").forEach((container) => {
    const capture = () => {
      window.setTimeout(() => {
        captureChapterSelection(container);
      }, 0);
    };
    container.addEventListener("mouseup", capture);
    container.addEventListener("keyup", capture);
  });

  document.querySelectorAll("[data-chapter-selection-clear]").forEach((button) => {
    button.addEventListener("click", () => {
      const chapterId = button.getAttribute("data-chapter-selection-clear");
      if (!chapterId) {
        return;
      }
      const workbench = partialRevisionWorkbenchFor(chapterId, snapshot?.staged?.pendingChapter || null);
      workbench.selectedText = "";
      workbench.prefixContext = "";
      workbench.suffixContext = "";
      render();
    });
  });

  const partialFeedbackInput = document.querySelector("#feedback-chapter-partial");
  if (partialFeedbackInput) {
    partialFeedbackInput.addEventListener("input", () => {
      const pending = snapshot?.staged?.pendingChapter || null;
      const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "";
      if (!chapterId) {
        return;
      }
      partialRevisionWorkbenchFor(chapterId, pending).feedback = partialFeedbackInput.value || "";
    });
  }

  document.querySelectorAll("[data-review-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = button.getAttribute("data-review-target");
      const reviewAction = button.getAttribute("data-review-action");
      const isWriteReview = target === "chapter";
      const isOutlineReview = target === "chapter_outline";
      const isPartialRewrite = isWriteReview && reviewAction === "partial_rewrite";
      const approved = isOutlineReview
        ? reviewAction === "approve_single" || reviewAction === "approve_composed"
        : reviewAction === "approve" ? true : button.getAttribute("data-approved") === "true";
      const textarea = isPartialRewrite
        ? document.querySelector("#feedback-chapter-partial")
        : document.querySelector(`#feedback-${target}`);
      const feedback = textarea?.value || "";
      const pending = snapshot?.staged?.pendingChapter || null;
      const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "";
      const partialWorkbench = isWriteReview ? partialRevisionWorkbenchFor(chapterId, pending) : null;
      const outlineWorkbench = isOutlineReview ? outlineWorkbenchFor(chapterId, pending) : null;
      const selectedSceneRefs = isOutlineReview && reviewAction === "approve_composed"
        ? [...(outlineWorkbench?.sceneRefs || [])]
        : [];
      const selectedProposalId = isOutlineReview ? button.getAttribute("data-selected-proposal-id") || "" : "";
      const approvalOverrideRequired = isWriteReview &&
        approved &&
        (
          pending?.reviewState?.manualReviewRequired ||
          pending?.validation?.overallPassed === false ||
          pending?.reviewState?.feedbackSupervisionPassed === false
        );
      const outlineOptions = {
        variantCount: Number(document.querySelector("#outline-variant-count")?.value || 3),
        diversityPreset: document.querySelector("#outline-diversity-preset")?.value || "wide",
      };

      if (isOutlineReview && reviewAction === "approve_composed" && !selectedSceneRefs.length) {
        showToast("先往最终细纲工作区加入至少一个 scene，再提交组合定稿。");
        return;
      }
      if (isPartialRewrite && !String(partialWorkbench?.selectedText || "").trim()) {
        showToast("先在正文 body 中框选一段要修改的文本，再提交局部修订。");
        return;
      }
      if (approvalOverrideRequired) {
        const blockingIssues = (pending?.reviewState?.blockingAuditIssues || []).filter(Boolean).slice(0, 4);
        const confirmationText = [
          "当前章节审计尚未通过，确认仍要锁章吗？",
          `critical ${pending?.validation?.issueCounts?.critical || 0} / warning ${pending?.validation?.issueCounts?.warning || 0} / info ${pending?.validation?.issueCounts?.info || 0}`,
          ...(blockingIssues.length ? ["未解决问题：", ...blockingIssues.map((item) => `- ${item}`)] : []),
        ].join("\n");
        if (!window.confirm(confirmationText)) {
          return;
        }
      }

      const endpoint = isWriteReview ? "/api/write/review" : "/api/plan/review";
      const normalizedEndpoint = isOutlineReview ? "/api/write/review" : endpoint;
      const actionKey = (isWriteReview || isOutlineReview) ? "chapter_review" : "plan_review";

      await runMutation(actionKey, async () => {
        try {
          const data = await api(normalizedEndpoint, {
            method: "POST",
            body: apiBody({
              target,
              approved,
              feedback,
              reviewAction,
              approvalOverrideAcknowledged: approvalOverrideRequired,
              selectedProposalId,
              selectedSceneRefs,
              authorNotes: feedback,
              outlineOptions,
              selection: isPartialRewrite
                ? {
                  selectedText: partialWorkbench?.selectedText || "",
                  prefixContext: partialWorkbench?.prefixContext || "",
                  suffixContext: partialWorkbench?.suffixContext || "",
                }
                : null,
            }),
          });
          applyServerState(data);
          if (isWriteReview || isOutlineReview) {
            setMainSection("write");
          } else {
            setMainSection("plan");
          }
          render();
          showToast(
            isOutlineReview
              ? approved ? "细纲已确认，系统正在生成正文。" : "细纲反馈已提交，系统正在重生候选。"
              : approved
                ? approvalOverrideRequired ? "未通过审计的章节已在显式确认后锁章。" : "审查结果已提交。"
                : isPartialRewrite ? "局部修订意见已提交，系统正在只改选中片段。" : "修改意见已提交，系统正在根据反馈重写。",
          );
        } catch (error) {
          await syncStateAfterError();
          showToast(error.message);
        }
      });
    });
  });

  document.querySelectorAll("[data-document-path]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedDocumentPath = button.getAttribute("data-document-path");
      render();
    });
  });

  document.querySelectorAll("[data-style-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedStyleFingerprintId = button.getAttribute("data-style-id");
      selectedStyleFingerprintDetail = null;
      styleFingerprintLoading = true;
      render();
    });
  });

  document.querySelectorAll("[data-toggle-section]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.getAttribute("data-toggle-section");
      const expanded = !sectionExpanded(key);
      expandedFlowItems[key] = expanded;
      const card = button.closest(".collapsible-card, .timeline-item");
      card?.classList.toggle("is-expanded", expanded);
      button.textContent = expanded ? "隐藏" : "展开";
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
  });

  document.querySelectorAll("[data-expand-flow]").forEach((button) => {
    button.addEventListener("click", () => {
      expandFlow(button.getAttribute("data-expand-flow") || "");
      render();
    });
  });

  document.querySelectorAll("[data-collapse-flow]").forEach((button) => {
    button.addEventListener("click", () => {
      collapseFlow(button.getAttribute("data-collapse-flow") || "");
      render();
    });
  });
}

async function renderSelectedDocument() {
  const viewer = document.querySelector("#document-viewer-content");
  if (!viewer || !selectedDocumentPath || !selectedProjectId) {
    return;
  }

  try {
    const documentData = await api(
      `/api/document?projectId=${encodeURIComponent(selectedProjectId)}&path=${encodeURIComponent(selectedDocumentPath)}`,
    );
    viewer.classList.remove("empty");
    viewer.innerHTML = renderDocumentContent(documentData.content, selectedDocumentPath);
  } catch (error) {
    viewer.classList.add("empty");
    viewer.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function renderSelectedStyleFingerprint() {
  if (!selectedStyleFingerprintId || !selectedProjectId) {
    styleFingerprintLoading = false;
    selectedStyleFingerprintDetail = null;
    return;
  }

  if (selectedStyleFingerprintDetail?.metadata?.id === selectedStyleFingerprintId) {
    styleFingerprintLoading = false;
    return;
  }

  styleFingerprintLoading = true;
  try {
    const data = await api(
      `/api/style-fingerprint?projectId=${encodeURIComponent(selectedProjectId)}&styleId=${encodeURIComponent(selectedStyleFingerprintId)}`,
    );
    if (selectedStyleFingerprintId === data.styleFingerprint?.metadata?.id) {
      selectedStyleFingerprintDetail = data.styleFingerprint;
      styleFingerprintLoading = false;
      render();
    }
  } catch (error) {
    styleFingerprintLoading = false;
    selectedStyleFingerprintDetail = null;
    render();
    showToast(error.message);
  }
}

loadState().catch((error) => {
  app.innerHTML = `<div class="app-shell app-shell-empty ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${utilityCollapsed ? "utility-collapsed" : ""}">${renderWorkspaceSidebar()}<div class="empty">${escapeHtml(error.message)}</div></div>`;
});
