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
const expandedSections = Object.create(null);
const outlineWorkbenchState = Object.create(null);

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

function renderMarkdownBlock(value, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : null;
  const markdown = limit === null ? String(value || "") : previewText(value, limit);
  return `<div class="markdown-body">${markdownToHtml(markdown)}</div>`;
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
  if (/locked|approved|resolved|idle/.test(status)) return "success";
  if (/pending/.test(status)) return "warning";
  if (/rejected|danger/.test(status)) return "danger";
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
  if (
    selectedStyleFingerprintDetail &&
    selectedStyleFingerprintDetail.metadata?.id !== selectedStyleFingerprintId
  ) {
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

function currentStyleFingerprintSummary() {
  const styleId = snapshot?.project?.project?.styleFingerprintId || null;
  if (!styleId) {
    return null;
  }
  return (snapshot?.styleFingerprints || []).find((item) => item.id === styleId) || null;
}

function renderPill(label, value) {
  return `<span class="pill" data-tone="${pillTone(value)}">${escapeHtml(label)}: ${escapeHtml(value || "-")}</span>`;
}

function sectionExpanded(key) {
  return Boolean(expandedSections[key]);
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

function previewText(value, limit = 2400) {
  const text = String(value || "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n\n...`;
}

function summarizePlanCharacters(characters = []) {
  return (Array.isArray(characters) ? characters : [])
    .map(
      (character) =>
        `- **${character.name || "未命名"}**｜${character.role || "未定角色"}｜欲望：${character.desire || "待补"}`,
    )
    .join("\n");
}

function renderWorkspaceBar() {
  return `
    <section class="workspace-bar">
      <div class="workspace-card">
        <div>
          <div class="eyebrow">Workspace</div>
          <h2>项目工作台</h2>
        </div>
        <div class="workspace-actions">
          <div class="field workspace-project">
            <label>当前项目</label>
            <div class="workspace-select-row">
              <select id="project-selector" ${disabledAttr(mutationBusy())}>
                <option value="">请选择项目</option>
                ${workspaceProjects
                  .map(
                    (project) => `
                      <option value="${escapeHtml(project.id)}" ${selectedProjectId === project.id ? "selected" : ""}>
                        ${escapeHtml(project.title)} · ${escapeHtml(project.id)}
                      </option>`,
                  )
                  .join("")}
              </select>
              <button class="button button-danger" id="delete-project-button" ${disabledAttr(mutationBusy() || !selectedProjectId)}>
                ${mutationBusy("project_delete") ? "删除中..." : "删除项目"}
              </button>
            </div>
          </div>
          <div class="field workspace-create">
            <label>新建项目</label>
            <div class="workspace-create-row">
              <input id="new-project-name" placeholder="例如 赛博修仙长篇" ${disabledAttr(mutationBusy())} />
              <button class="button button-primary" id="create-project-button" ${disabledAttr(mutationBusy())}>
                ${mutationBusy("project_create") ? "创建中..." : "新建项目"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
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

function parseCsvList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

function renderHero() {
  const project = snapshot.project.project;
  const planPhase = snapshot.project.phase.plan;
  const writePhase = snapshot.project.phase.write;
  const provider = snapshot.provider;
  return `
    <section class="hero">
      <div class="hero-card">
        <div class="eyebrow">Human-in-the-Loop Multi Agent Novel Studio</div>
        <h1>Novelex</h1>
        <p>
          这是一套按照你的实施方案搭建的首版系统：<strong>Plan 阶段</strong>负责大纲、设定、人物与结构协作，
          <strong>Write 阶段</strong>负责章节调研、写作方案编排、正文生成、验证与状态更新。所有关键节点都保留人工审查入口，
          并持续把结果落到 <code>novel_state</code> 文档体系。
        </p>
      </div>
      <div class="hero-side">
        <div class="status-box">
          <h3>${escapeHtml(project.title)}</h3>
          <p>${escapeHtml(project.genre)} · ${escapeHtml(project.setting)}</p>
          <div class="pill-row" style="margin-top: 12px;">
            ${renderPill("Plan", planPhase.status)}
            ${renderPill("Write", writePhase.status)}
            ${renderPill("Provider", provider.effectiveMode)}
            ${renderPill("当前进度", `已锁定 ${writePhase.currentChapterNumber || 0} 章`)}
          </div>
        </div>
        <div class="status-stack">
          <div class="status-box">
            <h3>下一动作</h3>
            <p>${escapeHtml(nextActionText())}</p>
          </div>
          <div class="status-box">
            <h3>待审节点</h3>
            <p>${escapeHtml(pendingReviewText())}</p>
          </div>
        </div>
      </div>
    </section>
  `;
}

function nextActionText() {
  const { plan, write } = snapshot.project.phase;
  if (plan.status === "idle" || plan.status === "draft_rejected" || plan.status === "final_rejected") return "运行 Plan 阶段，生成完整 plan 包并等待一次性审阅。";
  if (plan.status === "draft_pending_review") return "旧流程待升级：审阅草稿或推进到完整 plan 包。";
  if (plan.status === "final_pending_review") return "审阅完整大纲并锁定进入 Write 阶段。";
  if (plan.status === "locked" && write.status === "idle") return "生成下一章细纲候选。";
  if (write.status === "chapter_outline_pending_review") return "审阅章节细纲候选，选择、组合或反馈重生。";
  if (write.status === "chapter_pending_review") return "审阅章节草稿并决定锁定或重写。";
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

function renderProjectPanel() {
  const project = snapshot.project.project;
  const providerRuntime = snapshot.provider;
  const availableProviders = providerRuntime.availableProviders || [];
  const activeProvider =
    availableProviders.find((item) => item.id === providerRuntime.providerId) ||
    availableProviders[0] ||
    null;
  return `
    <section class="panel span-12">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Project Setup</div>
          <h2>项目设定</h2>
        </div>
        <div class="pill-row">
          ${renderPill("Provider", providerRuntime.providerName)}
          ${renderPill("Effective", providerRuntime.effectiveMode)}
        </div>
      </div>
      <div class="provider-switch-card">
        <div class="provider-switch-head">
          <div>
            <div class="eyebrow">Model Router</div>
            <h3>模型切换</h3>
          </div>
          <div class="pill-row">
            ${renderPill("当前", activeProvider?.name || providerRuntime.providerName)}
            ${renderPill("协议", providerRuntime.apiStyle)}
          </div>
        </div>
        <form class="project-form" id="provider-config-form">
          <div class="form-grid">
            <div class="field">
              <label>模型服务</label>
              <select name="providerId" id="provider-switcher" ${disabledAttr(mutationBusy())}>
                ${availableProviders.map((item) => `
                  <option
                    value="${escapeHtml(item.id)}"
                    data-response-model="${escapeHtml(item.responseModel || "")}"
                    data-review-model="${escapeHtml(item.reviewModel || "")}"
                    data-codex-model="${escapeHtml(item.codexResponseModel || "")}"
                    data-wire-api="${escapeHtml(item.wireApi || "")}"
                    data-base-url="${escapeHtml(item.baseUrl || "")}"
                    data-has-api-key="${item.hasApiKey ? "true" : "false"}"
                    ${item.id === providerRuntime.providerId ? "selected" : ""}
                  >${escapeHtml(item.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>接入协议</label>
              <input id="provider-wire-api" value="${escapeHtml(activeProvider?.wireApi || providerRuntime.apiStyle || "")}" disabled />
            </div>
            <div class="field full">
              <label>Base URL</label>
              <input id="provider-base-url" value="${escapeHtml(activeProvider?.baseUrl || providerRuntime.baseUrl || "")}" disabled />
            </div>
            <div class="field">
              <label>文本模型</label>
              <input name="responseModel" value="${escapeHtml(providerRuntime.responseModel || activeProvider?.responseModel || "")}" ${disabledAttr(mutationBusy())} />
            </div>
            <div class="field">
              <label>审查模型</label>
              <input name="reviewModel" value="${escapeHtml(providerRuntime.reviewModel || activeProvider?.reviewModel || "")}" ${disabledAttr(mutationBusy())} />
            </div>
            <div class="field">
              <label>Codex 模型</label>
              <input name="codexResponseModel" value="${escapeHtml(providerRuntime.codexResponseModel || activeProvider?.codexResponseModel || "")}" ${disabledAttr(mutationBusy())} />
            </div>
            <div class="field">
              <label>API Key 状态</label>
              <input id="provider-key-status" value="${activeProvider?.hasApiKey ? "已检测到当前 Provider 的 API Key" : "当前 Provider 尚未配置 API Key"}" disabled />
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
            这里的切换会直接写回 <code>novelex.codex.toml</code>。每个 Provider 会记住各自最近一次保存的模型名，切回时会自动带回。
          </p>
          <p class="helper-text">
            API Key 与 Base URL 都以 <code>novelex.codex.toml</code> 为准。若当前 Provider 缺少 Key，系统会显示为不可用。
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
        <p style="margin: 0; color: var(--muted); font-size: 0.95rem;">
          人物名单与名称会在 <code>Plan</code> 阶段自动生成。若题材明显属于真实历史背景，系统会优先混合真实历史人物与虚构角色。
        </p>
        <p style="margin: 0; color: var(--muted); font-size: 0.95rem;">
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
    <section class="panel span-12">
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
    <section class="panel span-12">
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
                <div style="display:grid; gap:8px;">
                  ${collections.length ? collections.map((item) => `
                    <label style="display:flex; gap:8px; align-items:flex-start;">
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
            <div class="style-detail-card" style="min-height: 0;">
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
    <section class="panel span-12">
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
                <div style="display:grid; gap:8px;">
                  ${collections.length ? collections.map((item) => `
                    <label style="display:flex; gap:8px; align-items:flex-start;">
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
            <div class="style-detail-card" style="min-height: 0;">
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

function renderPlanPanel() {
  const project = snapshot.project.phase.plan;
  const draft = snapshot.staged.planDraft;
  const finalPlan = snapshot.staged.planFinal;
  const run = latestRun("plan");
  const unresolvedPreApprovalIssues = draft?.preApprovalCritics?.passed === false
    ? draft.preApprovalCritics.issues || []
    : [];

  return `
    <section class="panel span-12">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Plan Stage</div>
          <h2>大纲协作流程</h2>
        </div>
        <div class="actions">
          <button class="button button-secondary" id="plan-run-button" ${disabledAttr(
            mutationBusy() ||
            project.status === "draft_pending_review" ||
            project.status === "final_pending_review" ||
            project.status === "locked",
          )}>${mutationBusy("plan_run") ? "处理中..." : "推进 Plan 阶段"}</button>
        </div>
      </div>
      <div class="metrics">
        <div class="metric"><span>当前状态</span><strong>${escapeHtml(project.status)}</strong></div>
        <div class="metric"><span>最近运行</span><strong>${escapeHtml(project.lastRunId || "暂无")}</strong></div>
        <div class="metric"><span>锁定时间</span><strong>${escapeHtml(project.lockedAt || "未锁定")}</strong></div>
      </div>
      <div class="flow" style="margin-top: 18px;">
        ${run ? renderRunSteps(run.steps) : `<div class="empty">尚未运行 Plan 阶段。点击“推进 Plan 阶段”后，系统会先生成完整 plan 包，再等待你做一次性终审。</div>`}
        ${draft ? `
          ${draft.cast?.length ? `
          ${renderCollapsibleCard({
            key: "plan-draft-cast",
            className: "preview-box",
            titleHtml: "<h3>自动生成人物</h3>",
            bodyHtml: renderJsonBlock(draft.cast),
          })}` : ""}
          ${renderCollapsibleCard({
            key: "plan-draft-outline",
            className: "preview-box",
            titleHtml: "<h3>当前大纲草稿</h3>",
            bodyHtml: renderMarkdownBlock(draft.outlineMarkdown, { limit: 2400 }),
          })}` : ""}
        ${project.pendingReview?.target === "plan_draft" ? renderReviewBox("plan_draft", "这是旧流程兼容节点。批准后系统会先补齐完整 plan 包，再进入最终审阅。") : ""}
        ${finalPlan ? `
          ${unresolvedPreApprovalIssues.length ? renderCollapsibleCard({
            key: "plan-final-auto-review-issues",
            className: "preview-box",
            titleHtml: "<h3>自动预审遗留问题</h3>",
            bodyHtml: renderMarkdownBlock(
              unresolvedPreApprovalIssues.map((item, index) => `${index + 1}. ${item}`).join("\n"),
              { limit: 2400 },
            ),
          }) : ""}
          ${renderCollapsibleCard({
            key: "plan-final-outline",
            className: "preview-box",
            titleHtml: "<h3>完整大纲与设定预览</h3>",
            bodyHtml: renderMarkdownBlock(finalPlan.outlineMarkdown || "", { limit: 2400 }),
          })}
          ${renderCollapsibleCard({
            key: "plan-final-structure",
            className: "preview-box",
            titleHtml: "<h3>结构摘要</h3>",
            bodyHtml: renderMarkdownBlock(finalPlan.structureMarkdown || "", { limit: 2400 }),
          })}
          ${renderCollapsibleCard({
            key: "plan-final-worldbuilding",
            className: "preview-box",
            titleHtml: "<h3>世界观摘要</h3>",
            bodyHtml: renderMarkdownBlock(finalPlan.worldbuildingMarkdown || "", { limit: 2400 }),
          })}
          ${renderCollapsibleCard({
            key: "plan-final-characters",
            className: "preview-box",
            titleHtml: "<h3>角色摘要</h3>",
            bodyHtml: renderMarkdownBlock(summarizePlanCharacters(finalPlan.characters || []), { limit: 2400 }),
          })}` : ""}
        ${project.pendingReview?.target === "plan_final" ? renderReviewBox("plan_final", unresolvedPreApprovalIssues.length
          ? "自动 Critic 已连续多轮回炉，但仍保留少量问题。你可以直接批准锁定，也可以填写人类反馈继续重写。"
          : "这里是单次终审节点。批准后只会执行本地锁定与提交，不再触发新的 Critic 或自动改写。") : ""}
      </div>
    </section>
  `;
}

function renderWritePanel() {
  const write = snapshot.project.phase.write;
  const enabled = snapshot.project.phase.plan.status === "locked";
  const pending = snapshot.staged.pendingChapter;
  const outlineOptions = normalizedOutlineOptionsFromSnapshot(pending);
  return `
    <section class="panel span-12">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Write Stage</div>
          <h2>章节写作流程</h2>
        </div>
        <div class="actions">
          <label class="field" style="min-width: 96px;">
            <span style="display:block; font-size:12px; margin-bottom:6px;">方案数</span>
            <select id="outline-variant-count" ${disabledAttr(mutationBusy() || !enabled)}>
              ${[2, 3, 4, 5].map((count) => `<option value="${count}" ${outlineOptions.variantCount === count ? "selected" : ""}>${count}</option>`).join("")}
            </select>
          </label>
          <label class="field" style="min-width: 120px;">
            <span style="display:block; font-size:12px; margin-bottom:6px;">发散度</span>
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
      <div class="flow" style="margin-top: 18px;">
        ${enabled ? "" : `<div class="empty">需要先锁定完整大纲，Write 阶段才会开放。</div>`}
        ${latestRun("write") ? renderRunSteps(latestRun("write").steps) : ""}
        ${pending ? `
          ${pending.chapterOutlineContext?.briefingMarkdown ? renderCollapsibleCard({
            key: `write-${pending.chapterPlan?.chapterId || "pending"}-outline-context`,
            className: "preview-box",
            titleHtml: "<h3>Outline Context</h3>",
            bodyHtml: renderMarkdownBlock(pending.chapterOutlineContext?.briefingMarkdown || ""),
          }) : ""}
          ${pending.chapterOutlineCandidates?.length ? renderCollapsibleCard({
            key: `write-${pending.chapterPlan?.chapterId || "pending"}-outline-candidates`,
            className: "preview-box",
            titleHtml: "<h3>Outline Candidates</h3>",
            bodyHtml: `<pre>${escapeHtml(JSON.stringify(pending.chapterOutlineCandidates || [], null, 2))}</pre>`,
          }) : ""}
          ${renderCollapsibleCard({
            key: `write-${pending.chapterPlan?.chapterId || "pending"}-context`,
            className: "preview-box",
            titleHtml: "<h3>Writer Context</h3>",
            bodyHtml: `<pre>${escapeHtml(JSON.stringify(pending.writerContext || {}, null, 2))}</pre>`,
          })}
          ${renderCollapsibleCard({
            key: `write-${pending.chapterPlan?.chapterId || "pending"}-history`,
            className: "preview-box",
            titleHtml: "<h3>History Retrieval</h3>",
            bodyHtml: `<pre>${escapeHtml(JSON.stringify(pending.retrieval || {}, null, 2))}</pre>`,
          })}
          ${renderCollapsibleCard({
            key: `write-${pending.chapterPlan?.chapterId || "pending"}-reference`,
            className: "preview-box",
            titleHtml: "<h3>Reference Packet</h3>",
            bodyHtml: `<pre>${escapeHtml(JSON.stringify(pending.referencePacket || {}, null, 2))}</pre>`,
          })}
          ${renderCollapsibleCard({
            key: `write-${pending.chapterPlan?.chapterId || "pending"}-research`,
            className: "preview-box",
            titleHtml: "<h3>Research Packet</h3>",
            bodyHtml: `<pre>${escapeHtml(JSON.stringify(pending.researchPacket || {}, null, 2))}</pre>`,
          })}
          ${pending.chapterMarkdown ? `
          ${renderCollapsibleCard({
            key: `write-${pending.chapterPlan?.chapterId || "pending"}-chapter`,
            className: "preview-box",
            titleHtml: `<h3>${escapeHtml(pending.chapterPlan.title)}</h3>`,
            bodyHtml: renderMarkdownBlock(pending.chapterMarkdown),
          })}` : ""}
          ${pending.sceneDrafts?.length ? `
          ${renderCollapsibleCard({
            key: `write-${pending.chapterPlan?.chapterId || "pending"}-scenes`,
            className: "preview-box",
            titleHtml: "<h3>Scene Drafts</h3>",
            bodyHtml: `<pre>${escapeHtml(JSON.stringify(pending.sceneDrafts || [], null, 2))}</pre>`,
          })}` : ""}
          ${pending.validation ? `
          ${renderCollapsibleCard({
            key: `write-${pending.chapterPlan?.chapterId || "pending"}-validation`,
            className: "preview-box",
            titleHtml: "<h3>验证结果</h3>",
            bodyHtml: `<pre>${escapeHtml(JSON.stringify(pending.validation, null, 2))}</pre>`,
          })}` : ""}
        ` : ""}
        ${write.pendingReview?.target === "chapter_outline" ? renderChapterOutlineReviewBox(pending) : ""}
        ${write.pendingReview?.target === "chapter" ? renderChapterReviewBox(pending) : ""}
      </div>
    </section>
  `;
}

function renderRunSteps(steps) {
  return `
    <div class="lane">
      ${steps
        .map(
          (item, index) => renderCollapsibleCard({
            key: `run-step-${item.label}-${index}`,
            className: "step-card",
            titleHtml: `<strong>${escapeHtml(item.label)}</strong>`,
            bodyHtml: `
              <p>${escapeHtml(item.summary)}</p>
              ${item.preview ? `<p style="margin-top: 8px;"><small>${escapeHtml(item.preview)}</small></p>` : ""}
            `,
          }),
        )
        .join("")}
    </div>
  `;
}

function renderReviewBox(target, description) {
  const titleMap = {
    plan_draft: "大纲草稿审查",
    plan_final: "最终大纲审查",
  };
  return renderCollapsibleCard({
    key: `review-${target}`,
    className: "review-box",
    titleHtml: `<h3>${titleMap[target]}</h3>`,
    bodyHtml: `
      <p>${escapeHtml(description)}</p>
      <textarea id="feedback-${target}" placeholder="写下你的人类意见。批准时可留空，拒绝时建议写清楚要改哪里。" ${disabledAttr(mutationBusy())}></textarea>
      <div class="actions">
        <button class="button button-primary" data-review-target="${target}" data-approved="true" ${disabledAttr(mutationBusy())}>${mutationBusy("plan_review") ? "提交中..." : "批准"}</button>
        <button class="button button-danger" data-review-target="${target}" data-approved="false" ${disabledAttr(mutationBusy())}>${mutationBusy("plan_review") ? "提交中..." : "拒绝并重写"}</button>
      </div>
    `,
  });
}

function renderChapterOutlineReviewBox(pending = null) {
  const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "pending";
  const workbench = outlineWorkbenchFor(chapterId, pending);
  const selectedScenes = selectedOutlineScenes(pending);
  const candidates = pending?.chapterOutlineCandidates || [];

  return renderCollapsibleCard({
    key: "review-chapter-outline",
    className: "review-box",
    titleHtml: "<h3>章节细纲审查</h3>",
    bodyHtml: `
      <p>先确定本章细纲，再进入正文生成。你可以直接采用某个方案，也可以把不同方案里的 scene 组合成最终细纲。</p>
      <textarea id="feedback-chapter-outline" placeholder="写下组合说明或重生反馈，比如想强化哪条关系线、换成更险的冲突轴、让章末更狠一点。" ${disabledAttr(mutationBusy())}>${escapeHtml(pending?.selectedChapterOutline?.authorNotes || "")}</textarea>
      <div style="display:grid; gap:12px; margin-top:16px;">
        ${candidates.map((candidate) => `
          <div style="border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px;">
            <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
              <div>
                <strong>${escapeHtml(candidate.proposalId)} · ${escapeHtml(candidate.chapterPlan?.title || "")}</strong>
                <p style="margin-top:6px;">${escapeHtml(candidate.summary || "")}</p>
                <p style="margin-top:6px;"><small>${escapeHtml(candidate.diffSummary || "")}</small></p>
              </div>
              <button class="button button-primary" data-review-target="chapter_outline" data-review-action="approve_single" data-selected-proposal-id="${escapeHtml(candidate.proposalId)}" ${disabledAttr(mutationBusy())}>
                ${mutationBusy("chapter_review") ? "提交中..." : "直接采用"}
              </button>
            </div>
            <div style="margin-top:10px; display:grid; gap:8px;">
              ${(candidate.chapterPlan?.scenes || []).map((scene) => `
                <div style="border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:10px;">
                  <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                    <div>
                      <strong>${escapeHtml(scene.label)}</strong>
                      <p style="margin-top:4px;"><small>${escapeHtml(scene.location)}｜${escapeHtml(scene.focus)}</small></p>
                      <p style="margin-top:4px;"><small>张力：${escapeHtml(scene.tension)}｜人物：${escapeHtml((scene.characters || []).join("、"))}</small></p>
                    </div>
                    <button class="button button-secondary" type="button" data-outline-add-scene="${escapeHtml(scene.sceneRef)}" data-outline-chapter-id="${escapeHtml(chapterId)}" ${disabledAttr(mutationBusy())}>
                      加入最终方案
                    </button>
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        `).join("") || `<div class="empty">当前没有可用的细纲候选。</div>`}
      </div>
      <div style="margin-top:18px; border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px;">
        <strong>最终细纲工作区</strong>
        <p style="margin-top:6px;"><small>当前已选 ${selectedScenes.length} 个 scene，可用上下移动顺序并删除不想要的部分。</small></p>
        <div style="display:grid; gap:8px; margin-top:10px;">
          ${selectedScenes.map((scene, index) => `
            <div style="border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:10px;">
              <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                <div>
                  <strong>${index + 1}. ${escapeHtml(scene.label)}</strong>
                  <p style="margin-top:4px;"><small>来源：${escapeHtml(scene.proposalId)}｜${escapeHtml(scene.location)}｜${escapeHtml(scene.focus)}</small></p>
                </div>
                <div class="actions">
                  <button class="button button-secondary" type="button" data-outline-move="up" data-outline-scene-ref="${escapeHtml(scene.sceneRef)}" data-outline-chapter-id="${escapeHtml(chapterId)}" ${disabledAttr(mutationBusy() || index === 0)}>上移</button>
                  <button class="button button-secondary" type="button" data-outline-move="down" data-outline-scene-ref="${escapeHtml(scene.sceneRef)}" data-outline-chapter-id="${escapeHtml(chapterId)}" ${disabledAttr(mutationBusy() || index === selectedScenes.length - 1)}>下移</button>
                  <button class="button button-danger" type="button" data-outline-remove-scene="${escapeHtml(scene.sceneRef)}" data-outline-chapter-id="${escapeHtml(chapterId)}" ${disabledAttr(mutationBusy())}>移除</button>
                </div>
              </div>
            </div>
          `).join("") || `<div class="empty">还没有加入任何 scene。</div>`}
        </div>
      </div>
      <div class="actions" style="margin-top: 16px;">
        <button class="button button-primary" data-review-target="chapter_outline" data-review-action="approve_composed" ${disabledAttr(mutationBusy())}>${mutationBusy("chapter_review") ? "提交中..." : "组合后定稿"}</button>
        <button class="button button-secondary" data-review-target="chapter_outline" data-review-action="regenerate" ${disabledAttr(mutationBusy())}>${mutationBusy("chapter_review") ? "提交中..." : "根据反馈重生"}</button>
      </div>
    `,
  });
}

function renderChapterReviewBox(pending = null) {
  return renderCollapsibleCard({
    key: "review-chapter",
    className: "review-box",
    titleHtml: "<h3>章节审查</h3>",
    bodyHtml: `
      <p>批准会直接锁章；如果不满意，只需要写清楚修改意见，系统会根据反馈自动重写本章。</p>
      <textarea id="feedback-chapter" placeholder="写下你的修改意见，比如要加强哪段冲突、调整节奏、补足人物动机或优化章末牵引。" ${disabledAttr(mutationBusy())}></textarea>
      <div class="actions">
        <button class="button button-primary" data-review-target="chapter" data-review-action="approve" ${disabledAttr(mutationBusy())}>${mutationBusy("chapter_review") ? "提交中..." : "批准"}</button>
        <button class="button button-danger" data-review-target="chapter" data-review-action="rewrite" ${disabledAttr(mutationBusy())}>${mutationBusy("chapter_review") ? "提交中..." : "根据反馈重写"}</button>
      </div>
    `,
  });
}

function renderChapterPanel() {
  const chapters = snapshot.chapters || [];
  return `
    <section class="panel span-12">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Chapter Index</div>
          <h2>已锁定章节</h2>
        </div>
      </div>
      <div class="chapter-list">
        ${chapters.length
          ? chapters
              .map(
                (chapter) => renderCollapsibleCard({
                  key: `chapter-${chapter.chapter_id}`,
                  className: "chapter-card",
                  titleHtml: `<strong>${escapeHtml(chapter.chapter_id)} · ${escapeHtml(chapter.title)}</strong>`,
                  bodyHtml: `<p>${escapeHtml(chapter.summary_50)}</p>`,
                }),
              )
              .join("")
          : `<div class="empty">还没有锁定的章节。</div>`}
      </div>
    </section>
  `;
}

function renderLogsPanel() {
  const logs = [...(snapshot.runs.plan || []), ...(snapshot.runs.write || [])]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 8);

  return `
    <section class="panel span-12">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Run History</div>
          <h2>最近运行</h2>
        </div>
      </div>
      <div class="logs">
        ${logs.length
          ? logs
              .map(
                (run) => renderCollapsibleCard({
                  key: `log-${run.id}`,
                  className: "log-card",
                  titleHtml: `<strong>${escapeHtml(run.id)}</strong>`,
                  bodyHtml: `
                    <p>${escapeHtml(run.summary || "-")}</p>
                    <p><small>${escapeHtml(run.phase)} · ${escapeHtml(run.target || "")} · ${escapeHtml(run.startedAt)}</small></p>
                  `,
                }),
              )
              .join("")
          : `<div class="empty">还没有运行记录。</div>`}
      </div>
    </section>
  `;
}

function renderDocumentsPanel() {
  const selectedDocument = snapshot.documents.find((doc) => doc.label === selectedDocumentPath) || null;
  return `
    <section class="panel span-12">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Document Browser</div>
          <h2>状态文档浏览器</h2>
        </div>
      </div>
      <div class="document-shell">
        <div class="document-list">
          ${snapshot.documents.length
            ? snapshot.documents
                .map(
                  (doc) => `
                    <button class="document-item ${selectedDocumentPath === doc.label ? "active" : ""}" data-document-path="${escapeHtml(doc.label)}">
                      <strong>${escapeHtml(doc.label)}</strong><br />
                      <small>${escapeHtml(doc.scope)} · ${escapeHtml(doc.modifiedAt)}</small>
                    </button>`,
                )
                .join("")
            : `<div class="empty">还没有可浏览的文档。</div>`}
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

function render() {
  if (!snapshot) {
    app.innerHTML = `
      <div class="shell">
        ${renderWorkspaceBar()}
        <section class="panel span-12">
          <div class="empty">${workspaceProjects.length ? "请选择一个项目进入工作区。" : "当前还没有项目，先新建一个项目吧。"}</div>
        </section>
      </div>
    `;
  bindEvents();
  scheduleServerPolling();
  return;
  }

  app.innerHTML = `
    <div class="shell">
      ${renderWorkspaceBar()}
      ${renderHero()}
      <main class="grid">
        ${renderProjectPanel()}
        ${renderStyleFingerprintPanel()}
        ${renderRagPanel()}
        ${renderOpeningPanel()}
        ${renderPlanPanel()}
        ${renderWritePanel()}
        ${renderChapterPanel()}
        ${renderLogsPanel()}
        ${renderDocumentsPanel()}
      </main>
    </div>
  `;

  bindEvents();
  renderSelectedDocument();
  renderSelectedStyleFingerprint();
  scheduleServerPolling();
}

function collectFormData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function syncProviderDraftFromSelection() {
  const select = document.querySelector("#provider-switcher");
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

  const responseModelInput = form.querySelector('[name="responseModel"]');
  const reviewModelInput = form.querySelector('[name="reviewModel"]');
  const codexModelInput = form.querySelector('[name="codexResponseModel"]');
  const wireApiInput = document.querySelector("#provider-wire-api");
  const baseUrlInput = document.querySelector("#provider-base-url");
  const keyStatusInput = document.querySelector("#provider-key-status");

  if (responseModelInput) {
    responseModelInput.value = option.dataset.responseModel || "";
  }
  if (reviewModelInput) {
    reviewModelInput.value = option.dataset.reviewModel || "";
  }
  if (codexModelInput) {
    codexModelInput.value = option.dataset.codexModel || "";
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
  document.querySelector("#project-selector")?.addEventListener("change", async (event) => {
    if (mutationBusy()) {
      showToast("已有请求正在处理中，请稍候。");
      render();
      return;
    }

    selectedProjectId = event.currentTarget.value || null;
    selectedDocumentPath = null;
    await loadState(selectedProjectId);
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
        render();
        showToast(`项目“${name}”已创建。`);
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
    });
  });

  document.querySelector("#delete-project-button")?.addEventListener("click", async () => {
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

  document.querySelector("#provider-switcher")?.addEventListener("change", () => {
    syncProviderDraftFromSelection();
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
        render();
        showToast("章节细纲候选已生成。");
      } catch (error) {
        await syncStateAfterError();
        showToast(error.message);
      }
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

  document.querySelectorAll("[data-review-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = button.getAttribute("data-review-target");
      const reviewAction = button.getAttribute("data-review-action");
      const isWriteReview = target === "chapter";
      const isOutlineReview = target === "chapter_outline";
      const approved = isOutlineReview
        ? reviewAction === "approve_single" || reviewAction === "approve_composed"
        : reviewAction === "approve" ? true : button.getAttribute("data-approved") === "true";
      const textarea = document.querySelector(`#feedback-${target}`);
      const feedback = textarea?.value || "";
      const pending = snapshot?.staged?.pendingChapter || null;
      const chapterId = pending?.chapterPlan?.chapterId || pending?.chapterId || "";
      const outlineWorkbench = isOutlineReview ? outlineWorkbenchFor(chapterId, pending) : null;
      const selectedSceneRefs = isOutlineReview && reviewAction === "approve_composed"
        ? [...(outlineWorkbench?.sceneRefs || [])]
        : [];
      const selectedProposalId = isOutlineReview ? button.getAttribute("data-selected-proposal-id") || "" : "";
      const outlineOptions = {
        variantCount: Number(document.querySelector("#outline-variant-count")?.value || 3),
        diversityPreset: document.querySelector("#outline-diversity-preset")?.value || "wide",
      };

      if (isOutlineReview && reviewAction === "approve_composed" && !selectedSceneRefs.length) {
        showToast("先往最终细纲工作区加入至少一个 scene，再提交组合定稿。");
        return;
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
              selectedProposalId,
              selectedSceneRefs,
              authorNotes: feedback,
              outlineOptions,
            }),
          });
          applyServerState(data);
          render();
          showToast(
            isOutlineReview
              ? approved ? "细纲已确认，系统正在生成正文。" : "细纲反馈已提交，系统正在重生候选。"
              : approved ? "审查结果已提交。" : "修改意见已提交，系统正在根据反馈重写。",
          );
        } catch (error) {
          await syncStateAfterError();
          showToast(error.message);
        }
      });
    });
  });

  document.querySelectorAll("[data-document-path]").forEach((button) => {
    button.addEventListener("click", async () => {
      selectedDocumentPath = button.getAttribute("data-document-path");
      render();
    });
  });

  document.querySelectorAll("[data-style-id]").forEach((button) => {
    button.addEventListener("click", async () => {
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
      expandedSections[key] = expanded;
      const card = button.closest(".collapsible-card");
      card?.classList.toggle("is-expanded", expanded);
      card?.classList.toggle("is-collapsed", !expanded);
      button.textContent = expanded ? "隐藏" : "展开";
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
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
  app.innerHTML = `<div class="shell">${renderWorkspaceBar()}<div class="empty">${escapeHtml(error.message)}</div></div>`;
});
