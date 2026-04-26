import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { loadCodexApiConfig, normalizeCodexConfigData, saveCodexApiConfig } from "./config/codex-config.js";
import { PLAN_STATUS } from "./core/defaults.js";
import { buildStyleFingerprintSummary } from "./core/style-fingerprint.js";
import { loadFactLedger } from "./core/facts.js";
import { nowIso, safeJsonParse } from "./core/text.js";
import { publicProviderSettings, resolveProviderSettings } from "./llm/provider.js";
import { closeAllWorkspaceMcpManagers, getWorkspaceMcpManager } from "./mcp/index.js";
import { runPlanDraft, reviewPlanDraft, reviewPlanFinal, runPlanFinalization } from "./orchestration/plan.js";
import { generateStyleFingerprint } from "./orchestration/style-fingerprint.js";
import { rebuildOpeningCollectionIndex } from "./opening/index.js";
import { deleteLatestLockedChapter, reviewChapter, runWriteChapter, saveManualChapterEdit } from "./orchestration/write.js";
import { rebuildRagCollectionIndex } from "./rag/index.js";
import { createStore } from "./utils/store.js";
import { createProjectWorkspace, deleteProjectWorkspace, ensureProjectId, listProjects } from "./utils/workspace.js";

const PORT = Number(process.env.PORT || 3000);
const WORKSPACE_ROOT = process.cwd();
const storeCache = new Map();
let activeOperation = null;
const workspaceMcpManager = getWorkspaceMcpManager({
  rootDir: WORKSPACE_ROOT,
  configRootDir: WORKSPACE_ROOT,
});

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? safeJsonParse(raw, {}) : {};
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(response, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function currentActiveOperation() {
  if (!activeOperation) {
    return null;
  }

  return {
    action: activeOperation.action,
    startedAt: activeOperation.startedAt,
  };
}

function withActiveOperation(payload = {}) {
  return {
    ...payload,
    activeOperation: currentActiveOperation(),
  };
}

async function runWithMutationLock(action, task) {
  if (activeOperation) {
    const error = new Error(`当前已有操作正在执行：${activeOperation.action}`);
    error.code = "MUTATION_IN_PROGRESS";
    error.activeOperation = currentActiveOperation();
    throw error;
  }

  const token = Symbol(String(action || "mutation"));
  activeOperation = {
    token,
    action: String(action || "mutation"),
    startedAt: nowIso(),
  };

  try {
    return await task();
  } finally {
    if (activeOperation?.token === token) {
      activeOperation = null;
    }
  }
}

async function sendLockedJson(response, action, task) {
  const payload = await runWithMutationLock(action, task);
  sendJson(response, 200, withActiveOperation(payload));
}

function withErrorHandling(handler) {
  return async (request, response, url) => {
    try {
      await handler(request, response, url);
    } catch (error) {
      if (error?.code === "MUTATION_IN_PROGRESS") {
        sendJson(response, 409, withActiveOperation({
          error: error instanceof Error ? error.message : "当前已有操作正在执行",
        }));
        return;
      }
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown server error",
      });
    }
  };
}

async function getStore(projectId) {
  if (!storeCache.has(projectId)) {
    storeCache.set(projectId, await createStore(path.join(WORKSPACE_ROOT, "projects", projectId), { workspaceRoot: WORKSPACE_ROOT }));
  }
  return storeCache.get(projectId);
}

function dropStore(projectId) {
  storeCache.delete(projectId);
}

async function resolveProjectContext(url, body = null) {
  const requestedId =
    String(url.searchParams.get("projectId") || body?.projectId || "").trim() || null;
  const projectId = await ensureProjectId(WORKSPACE_ROOT, requestedId);
  if (!projectId) {
    return {
      projectId: null,
      store: null,
      projects: await listProjects(WORKSPACE_ROOT),
    };
  }

  return {
    projectId,
    store: await getStore(projectId),
    projects: await listProjects(WORKSPACE_ROOT),
  };
}

function sanitizeProjectInput(input, current) {
  const numeric = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const sanitizedCurrent = { ...current };
  delete sanitizedCurrent.targetReaders;
  delete sanitizedCurrent.structureReferenceIds;
  delete sanitizedCurrent.structureReferenceMode;

  return {
    ...sanitizedCurrent,
    title: String(input.title || current.title).trim(),
    genre: String(input.genre || current.genre).trim(),
    setting: String(input.setting || current.setting).trim(),
    premise: String(input.premise || current.premise).trim(),
    theme: String(input.theme || current.theme).trim(),
    styleNotes: String(input.styleNotes || current.styleNotes).trim(),
    researchNotes: String(input.researchNotes || current.researchNotes).trim(),
    protagonistGoal: String(input.protagonistGoal || current.protagonistGoal).trim(),
    totalChapters: numeric(input.totalChapters, current.totalChapters),
    targetWordsPerChapter: numeric(input.targetWordsPerChapter, current.targetWordsPerChapter),
    stageCount: numeric(input.stageCount, current.stageCount),
  };
}

function sanitizeProviderInput(input, projectState) {
  const existingAgentModels = projectState.providerConfig?.agentModels || {};
  return {
    providerMode:
      input.providerMode === "openai-responses"
        ? input.providerMode
        : projectState.providerMode,
    providerConfig: {
      ...(projectState.providerConfig || {}),
      responseModel:
        String(input.responseModel || projectState.providerConfig?.responseModel || "").trim() ||
        projectState.providerConfig?.responseModel,
      reviewModel:
        String(input.reviewModel || projectState.providerConfig?.reviewModel || "").trim() ||
        projectState.providerConfig?.reviewModel,
      codexResponseModel:
        String(input.codexResponseModel || projectState.providerConfig?.codexResponseModel || "").trim() ||
        projectState.providerConfig?.codexResponseModel,
      agentModels: {
        primary: {
          provider:
            String(input.primaryProviderId || existingAgentModels?.primary?.provider || "OpenAI").trim() || "OpenAI",
          model:
            String(input.primaryModel || existingAgentModels?.primary?.model || projectState.providerConfig?.responseModel || "").trim() ||
            projectState.providerConfig?.responseModel,
        },
        secondary: {
          provider:
            String(input.secondaryProviderId || existingAgentModels?.secondary?.provider || existingAgentModels?.primary?.provider || "OpenAI").trim() || "OpenAI",
          model:
            String(input.secondaryModel || existingAgentModels?.secondary?.model || projectState.providerConfig?.reviewModel || projectState.providerConfig?.responseModel || "").trim() ||
            projectState.providerConfig?.responseModel,
        },
      },
      reasoningEffort: "medium",
      apiStyle: "responses",
    },
  };
}

function sanitizeTomlProviderInput(input, rootDir = WORKSPACE_ROOT) {
  const existing = loadCodexApiConfig(rootDir);
  const currentConfig = normalizeCodexConfigData(existing.data || {});
  const primaryProviderId = String(
    input.primaryProviderId ||
    currentConfig.agent_models?.primary?.provider ||
    currentConfig.model_provider ||
    "OpenAI",
  ).trim() || "OpenAI";
  const secondaryProviderId = String(
    input.secondaryProviderId ||
    currentConfig.agent_models?.secondary?.provider ||
    currentConfig.agent_models?.primary?.provider ||
    currentConfig.model_provider ||
    "OpenAI",
  ).trim() || "OpenAI";
  const primaryProviderBlock = currentConfig.model_providers?.[primaryProviderId];
  const secondaryProviderBlock = currentConfig.model_providers?.[secondaryProviderId];

  if (!primaryProviderBlock) {
    throw new Error(`Unknown provider: ${primaryProviderId}`);
  }
  if (!secondaryProviderBlock) {
    throw new Error(`Unknown provider: ${secondaryProviderId}`);
  }

  const primaryModel =
    String(
      input.primaryModel ||
      currentConfig.agent_models?.primary?.model ||
      primaryProviderBlock.response_model ||
      primaryProviderBlock.model ||
      currentConfig.model ||
      "",
    ).trim() || currentConfig.model;
  const secondaryModel =
    String(
      input.secondaryModel ||
      currentConfig.agent_models?.secondary?.model ||
      secondaryProviderBlock.response_model ||
      secondaryProviderBlock.model ||
      currentConfig.review_model ||
      primaryModel ||
      "",
    ).trim() || primaryModel;

  return {
    ...currentConfig,
    agent_models: {
      primary: {
        provider: primaryProviderId,
        model: primaryModel,
      },
      secondary: {
        provider: secondaryProviderId,
        model: secondaryModel,
      },
    },
  };
}

async function buildSnapshot(store, projectId) {
  const project = await store.loadProject();
  const provider = publicProviderSettings(resolveProviderSettings(project, store.paths.configRootDir));
  const planRuns = await store.listRuns("plan", 6);
  const planDraft = await store.loadPlanDraft();
  const planFinal = await store.loadPlanFinal();
  const pendingChapter = project.phase.write.pendingReview?.chapterId
    ? await store.loadChapterDraft(project.phase.write.pendingReview.chapterId)
    : null;
  const chapters = await store.listChapterMeta();
  const visibleWriteChapterIds = new Set(
    chapters
      .map((chapter) => String(chapter?.chapter_id || chapter?.chapterId || "").trim())
      .filter(Boolean),
  );
  if (project.phase.write.pendingReview?.chapterId) {
    visibleWriteChapterIds.add(String(project.phase.write.pendingReview.chapterId).trim());
  }
  const writeRuns = (await store.listRuns("write", 50))
    .filter((run) => {
      const runChapterId = String(run?.chapterId || "").trim();
      return !runChapterId || visibleWriteChapterIds.has(runChapterId);
    })
    .slice(0, 6);
  const documents = await store.buildDocumentIndex();
  const styleFingerprints = await store.listStyleFingerprints();
  const ragCollections = await store.listRagCollections();
  const openingCollections = await store.listOpeningCollections();

  const committed = {
    outline: await store.readText(path.join(store.paths.novelStateDir, "outline.md"), ""),
    worldbuilding: await store.readText(path.join(store.paths.novelStateDir, "worldbuilding.md"), ""),
    structure: await store.readText(path.join(store.paths.novelStateDir, "structure.md"), ""),
    styleGuide: await store.readText(path.join(store.paths.novelStateDir, "style_guide.md"), ""),
    worldState: await store.readJson(path.join(store.paths.novelStateDir, "world_state.json"), null),
    foreshadowingRegistry: await store.readJson(
      path.join(store.paths.novelStateDir, "foreshadowing_registry.json"),
      null,
    ),
    factLedger: await loadFactLedger(store),
  };

  return {
    serverTime: nowIso(),
    projectId,
    project,
    provider,
    runs: {
      plan: planRuns,
      write: writeRuns,
    },
    staged: {
      planDraft,
      planFinal,
      pendingChapter,
    },
    committed,
    chapters,
    documents,
    styleFingerprints,
    ragCollections,
    openingCollections,
  };
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function sendFile(response, resolvedPath) {
  const content = await fs.readFile(resolvedPath);
  const ext = path.extname(resolvedPath);
  sendText(response, 200, content, CONTENT_TYPES[ext] || "application/octet-stream");
}

async function serveStaticFromDirectory(response, rootDir, relativePath) {
  const normalizedRelative = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  const filePath = path.join(rootDir, normalizedRelative);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(rootDir)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    await sendFile(response, resolved);
  } catch {
    sendText(response, 404, "Not Found");
  }
}

async function serveReactApp(response, pathname) {
  const reactDistDir = path.join(WORKSPACE_ROOT, "dist", "frontend");
  const reactIndexPath = path.join(reactDistDir, "index.html");

  if (!(await exists(reactIndexPath))) {
    sendText(
      response,
      503,
      "React frontend has not been built yet. Run `npm run build:frontend` first.",
    );
    return;
  }

  const relative = pathname === "/" ? "/index.html" : pathname || "/index.html";

  const candidatePath = path.resolve(path.join(reactDistDir, relative));
  if (!candidatePath.startsWith(reactDistDir)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  if (relative !== "/index.html" && (await exists(candidatePath))) {
    const stat = await fs.stat(candidatePath);
    if (stat.isFile()) {
      await sendFile(response, candidatePath);
      return;
    }
  }

  await sendFile(response, reactIndexPath);
}

const routes = {
  "GET /api/health": withErrorHandling(async (_request, response) => {
    sendJson(response, 200, withActiveOperation({
      ok: true,
      serverTime: nowIso(),
    }));
  }),

  "GET /api/projects": withErrorHandling(async (_request, response) => {
    sendJson(response, 200, withActiveOperation({
      projects: await listProjects(WORKSPACE_ROOT),
    }));
  }),

  "POST /api/projects": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    await sendLockedJson(response, "project_create", async () => {
      const created = await createProjectWorkspace(WORKSPACE_ROOT, String(body.name || body.title || "新项目"));
      const store = await createStore(created.root, { workspaceRoot: WORKSPACE_ROOT });
      storeCache.set(created.id, store);

      const projectState = await store.loadProject();
      if (created.title && created.title !== projectState.project.title) {
        await store.saveProject({
          ...projectState,
          project: {
            ...projectState.project,
            title: created.title,
          },
        });
      }

      return {
        projectId: created.id,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(store, created.id),
      };
    });
  }),

  "DELETE /api/projects": withErrorHandling(async (request, response, url) => {
    const body = await readBody(request);
    const requestedId = String(url.searchParams.get("projectId") || body.projectId || "").trim();
    if (!requestedId) {
      sendJson(response, 400, { error: "Missing project id" });
      return;
    }

    await sendLockedJson(response, "project_delete", async () => {
      const deleted = await deleteProjectWorkspace(WORKSPACE_ROOT, requestedId);
      dropStore(requestedId);
      const projects = await listProjects(WORKSPACE_ROOT);
      const fallbackProjectId = projects[0]?.id || null;
      const fallbackStore = fallbackProjectId ? await getStore(fallbackProjectId) : null;

      return {
        deleted,
        deletedProjectId: requestedId,
        projects,
        projectId: fallbackProjectId,
        state: fallbackStore ? await buildSnapshot(fallbackStore, fallbackProjectId) : null,
      };
    });
  }),

  "GET /api/state": withErrorHandling(async (_request, response, url) => {
    const context = await resolveProjectContext(url);
    sendJson(response, 200, withActiveOperation({
      projects: context.projects,
      state: context.store ? await buildSnapshot(context.store, context.projectId) : null,
      projectId: context.projectId,
    }));
  }),

  "GET /api/document": withErrorHandling(async (_request, response, url) => {
    const context = await resolveProjectContext(url);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }
    const relativePath = url.searchParams.get("path");
    if (!relativePath) {
      sendJson(response, 400, { error: "Missing document path" });
      return;
    }
    const document = await context.store.readDocument(relativePath);
    if (!document) {
      sendJson(response, 404, { error: "Document not found" });
      return;
    }
    sendJson(response, 200, document);
  }),

  "GET /api/style-fingerprint": withErrorHandling(async (_request, response, url) => {
    const context = await resolveProjectContext(url);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }
    const styleId = String(url.searchParams.get("styleId") || "").trim();
    if (!styleId) {
      sendJson(response, 400, { error: "Missing styleId" });
      return;
    }

    const styleFingerprint = await context.store.loadStyleFingerprint(styleId);
    if (!styleFingerprint) {
      sendJson(response, 404, { error: "Style fingerprint not found" });
      return;
    }

    sendJson(response, 200, withActiveOperation({
      styleFingerprint,
      projectId: context.projectId,
    }));
  }),

  "POST /api/project": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }
    const projectState = await context.store.loadProject();
    const nextProject = sanitizeProjectInput(body, projectState.project);
    const nextProvider = sanitizeProviderInput(body, projectState);
    const projectChanged = JSON.stringify(nextProject) !== JSON.stringify(projectState.project);

    if (projectState.phase.plan.status === PLAN_STATUS.LOCKED && projectChanged) {
      sendJson(response, 409, {
        error: "大纲已经锁定。若要修改核心项目设定，请先在代码层扩展重置流程。",
      });
      return;
    }

    await sendLockedJson(response, "project_save", async () => {
      const nextState = {
        ...projectState,
        ...nextProvider,
        project: nextProject,
      };
      await context.store.saveProject(nextState);
      return {
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/provider/config": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(
      new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`),
      body,
    );
    await sendLockedJson(response, "provider_save", async () => {
      const nextConfig = sanitizeTomlProviderInput(body, WORKSPACE_ROOT);
      saveCodexApiConfig(WORKSPACE_ROOT, nextConfig);

      return {
        projects: context.projects,
        state: context.store ? await buildSnapshot(context.store, context.projectId) : null,
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/project/style": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }

    const styleFingerprintId = String(body.styleFingerprintId || "").trim();
    if (styleFingerprintId) {
      const styleFingerprint = await context.store.loadStyleFingerprint(styleFingerprintId);
      if (!styleFingerprint) {
        sendJson(response, 404, { error: "Style fingerprint not found" });
        return;
      }
    }

    await sendLockedJson(response, "project_style_save", async () => {
      const projectState = await context.store.loadProject();
      await context.store.saveProject({
        ...projectState,
        project: {
          ...projectState.project,
          styleFingerprintId: styleFingerprintId || null,
        },
      });

      return {
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/project/rag": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }

    const requestedIds = Array.isArray(body.ragCollectionIds)
      ? body.ragCollectionIds
      : typeof body.ragCollectionIds === "string"
        ? body.ragCollectionIds.split(",")
        : [];
    const ragCollectionIds = [...new Set(requestedIds
      .map((item) => String(item || "").trim())
      .filter(Boolean))];

    for (const collectionId of ragCollectionIds) {
      const collection = await context.store.loadRagCollection(collectionId);
      if (!collection) {
        sendJson(response, 404, { error: `RAG collection not found: ${collectionId}` });
        return;
      }
    }

    await sendLockedJson(response, "project_rag_save", async () => {
      const projectState = await context.store.loadProject();
      await context.store.saveProject({
        ...projectState,
        project: {
          ...projectState.project,
          ragCollectionIds,
        },
      });

      return {
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/project/openings": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }

    const requestedIds = Array.isArray(body.openingCollectionIds)
      ? body.openingCollectionIds
      : typeof body.openingCollectionIds === "string"
        ? body.openingCollectionIds.split(",")
        : [];
    const openingCollectionIds = [...new Set(requestedIds
      .map((item) => String(item || "").trim())
      .filter(Boolean))];

    for (const collectionId of openingCollectionIds) {
      const collection = await context.store.loadOpeningCollection(collectionId);
      if (!collection) {
        sendJson(response, 404, { error: `Opening collection not found: ${collectionId}` });
        return;
      }
    }

    await sendLockedJson(response, "project_opening_save", async () => {
      const projectState = await context.store.loadProject();
      await context.store.saveProject({
        ...projectState,
        project: {
          ...projectState.project,
          openingCollectionIds,
        },
      });

      return {
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/rag/collections": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }

    await sendLockedJson(response, "rag_create", async () => {
      const collection = await context.store.createRagCollection(String(body.name || body.collectionName || "新范文库"));
      return {
        collection,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/opening/collections": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }

    await sendLockedJson(response, "opening_create", async () => {
      const collection = await context.store.createOpeningCollection(String(body.name || body.collectionName || "新开头参考库"));
      return {
        collection,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/rag/rebuild": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }

    const collectionId = String(body.collectionId || "").trim();
    if (!collectionId) {
      sendJson(response, 400, { error: "Missing collectionId" });
      return;
    }

    await sendLockedJson(response, "rag_rebuild", async () => {
      const rebuilt = await rebuildRagCollectionIndex({
        store: context.store,
        collectionId,
      });

      return {
        rebuilt,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/opening/rebuild": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }

    const collectionId = String(body.collectionId || "").trim();
    if (!collectionId) {
      sendJson(response, 400, { error: "Missing collectionId" });
      return;
    }

    await sendLockedJson(response, "opening_rebuild", async () => {
      const rebuilt = await rebuildOpeningCollectionIndex({
        store: context.store,
        collectionId,
      });

      return {
        rebuilt,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/style-fingerprints/generate": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }

    await sendLockedJson(response, "style_generate", async () => {
      const styleFingerprint = await generateStyleFingerprint(context.store, {
        name: body.name,
        sampleText: body.sampleText,
      });

      return {
        styleFingerprint,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/style-fingerprint/update": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }

    const styleId = String(body.styleId || "").trim();
    if (!styleId) {
      sendJson(response, 400, { error: "Missing styleId" });
      return;
    }

    const currentStyleFingerprint = await context.store.loadStyleFingerprint(styleId);
    if (!currentStyleFingerprint) {
      sendJson(response, 404, { error: "Style fingerprint not found" });
      return;
    }

    await sendLockedJson(response, "style_update", async () => {
      const styleFingerprint = await context.store.updateStyleFingerprint(styleId, {
        name: body.name,
        promptMarkdown: body.promptMarkdown,
        summary: buildStyleFingerprintSummary(
          String(body.name || currentStyleFingerprint.metadata.name || ""),
          currentStyleFingerprint.fingerprint,
        ),
      });

      return {
        styleFingerprint,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/plan/run": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }

    await sendLockedJson(response, "plan_run", async () => {
      const projectState = await context.store.loadProject();
      let result;
      if (
        projectState.phase.plan.status === PLAN_STATUS.IDLE ||
        projectState.phase.plan.status === PLAN_STATUS.DRAFT_REJECTED ||
        projectState.phase.plan.status === PLAN_STATUS.FINAL_REJECTED
      ) {
        result = await runPlanDraft(context.store);
      } else if (
        projectState.phase.plan.status === PLAN_STATUS.DRAFT_APPROVED
      ) {
        result = await runPlanFinalization(context.store);
      } else {
        result = {
          summary: "当前阶段已经在等待人审，或大纲已经锁定。",
        };
      }
      return {
        result,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/plan/review": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }
    const target = String(body.target || "");
    if (target !== "plan_draft" && target !== "plan_final") {
      sendJson(response, 400, { error: "Unknown plan review target" });
      return;
    }
    await sendLockedJson(response, "plan_review", async () => {
      const approved = Boolean(body.approved);
      let result;

      if (target === "plan_draft") {
        result = await reviewPlanDraft(context.store, {
          approved,
          feedback: String(body.feedback || ""),
        });
      } else if (target === "plan_final") {
        result = await reviewPlanFinal(context.store, {
          approved,
          feedback: String(body.feedback || ""),
        });
      }

      return {
        result,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/write/run": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }
    await sendLockedJson(response, "write_run", async () => {
      const chapterNumber = body.chapterNumber ? Number(body.chapterNumber) : undefined;
      const result = await runWriteChapter(context.store, {
        chapterNumber,
        outlineOptions: body.outlineOptions || null,
      });
      return {
        result,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/write/review": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }
    await sendLockedJson(response, "chapter_review", async () => {
      const result = await reviewChapter(context.store, {
        target: String(body.target || ""),
        approved: Boolean(body.approved),
        feedback: String(body.feedback || ""),
        reviewAction: String(body.reviewAction || (body.approved ? "approve" : "rewrite")),
        approvalOverrideAcknowledged: Boolean(body.approvalOverrideAcknowledged),
        selectedProposalId: String(body.selectedProposalId || ""),
        selectedSceneRefs: body.selectedSceneRefs || [],
        authorNotes: String(body.authorNotes || ""),
        outlineOptions: body.outlineOptions || null,
        sceneIds: body.sceneIds || [],
        sceneOrder: body.sceneOrder || [],
        selection: body.selection || null,
      });
      return {
        result,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/write/manual-edit": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }
    await sendLockedJson(response, "chapter_manual_edit", async () => {
      const result = await saveManualChapterEdit(context.store, {
        chapterBody: String(body.chapterBody || ""),
      });
      return {
        result,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),

  "POST /api/write/delete": withErrorHandling(async (request, response) => {
    const body = await readBody(request);
    const context = await resolveProjectContext(new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`), body);
    if (!context.store) {
      sendJson(response, 404, { error: "Project not found" });
      return;
    }
    await sendLockedJson(response, "chapter_delete", async () => {
      const result = await deleteLatestLockedChapter(context.store, {
        chapterId: String(body.chapterId || ""),
      });
      return {
        result,
        projects: await listProjects(WORKSPACE_ROOT),
        state: await buildSnapshot(context.store, context.projectId),
        projectId: context.projectId,
      };
    });
  }),
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || `localhost:${PORT}`}`);
  const routeKey = `${request.method} ${url.pathname}`;
  const route = routes[routeKey];

  if (route) {
    await route(request, response, url);
    return;
  }

  await serveReactApp(response, url.pathname);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Novelex running at http://localhost:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    try {
      await workspaceMcpManager.closeAll();
      await closeAllWorkspaceMcpManagers();
    } finally {
      process.exit(0);
    }
  });
}

process.once("exit", () => {
  workspaceMcpManager.closeAll().catch(() => {});
});
