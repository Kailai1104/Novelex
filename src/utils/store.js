import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_PROJECT_STATE, DEFAULT_STYLE_GUIDE_MARKDOWN } from "../core/defaults.js";
import { nowIso } from "../core/text.js";
import { createPaths } from "./paths.js";

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) {
    return fallback;
  }

  const value = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readText(filePath, fallback = "") {
  if (!(await exists(filePath))) {
    return fallback;
  }

  return fs.readFile(filePath, "utf8");
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value, "utf8");
}

async function readJsonLines(filePath, fallback = []) {
  if (!(await exists(filePath))) {
    return fallback;
  }

  const text = await fs.readFile(filePath, "utf8");
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return rows.length ? rows : fallback;
}

async function writeJsonLines(filePath, values) {
  await ensureDir(path.dirname(filePath));
  const payload = (Array.isArray(values) ? values : [])
    .map((item) => JSON.stringify(item))
    .join("\n");
  await fs.writeFile(filePath, payload ? `${payload}\n` : "", "utf8");
}

async function copyFile(source, target) {
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
}

async function copyDirectory(source, target) {
  await ensureDir(target);
  await fs.cp(source, target, { recursive: true });
}

async function removeIfExists(filePath) {
  if (await exists(filePath)) {
    await fs.rm(filePath, { force: true });
  }
}

async function removeDirIfExists(dirPath) {
  if (await exists(dirPath)) {
    await fs.rm(dirPath, { recursive: true, force: true });
  }
}

async function listFilesRecursive(dirPath) {
  if (!(await exists(dirPath))) {
    return [];
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function mergeProjectState(state) {
  const project = {
    ...DEFAULT_PROJECT_STATE.project,
    ...(state?.project || {}),
  };
  delete project.structureReferenceIds;
  delete project.structureReferenceMode;

  return {
    ...DEFAULT_PROJECT_STATE,
    ...state,
    project,
    phase: {
      plan: {
        ...DEFAULT_PROJECT_STATE.phase.plan,
        ...(state?.phase?.plan || {}),
      },
      write: {
        ...DEFAULT_PROJECT_STATE.phase.write,
        ...(state?.phase?.write || {}),
      },
    },
    history: {
      ...DEFAULT_PROJECT_STATE.history,
      ...(state?.history || {}),
    },
    providerConfig: {
      ...DEFAULT_PROJECT_STATE.providerConfig,
      ...(state?.providerConfig || {}),
      reasoningEffort: "medium",
    },
  };
}

function normalizeRun(run) {
  if (!run || typeof run !== "object") {
    return run;
  }

  const steps = Array.isArray(run.steps)
    ? run.steps
        .filter((step) => step?.id !== "actor_agents" && step?.label !== "ActorAgent Network")
        .map((step) => step)
    : [];

  return {
    ...run,
    steps,
  };
}

export async function createStore(rootDir = process.cwd(), options = {}) {
  const paths = createPaths(rootDir, options);

  await Promise.all([
    ensureDir(paths.runtimeDir),
    ensureDir(paths.workspaceRuntimeDir),
    ensureDir(paths.runsDir),
    ensureDir(paths.reviewsDir),
    ensureDir(paths.planStagingDir),
    ensureDir(paths.writeStagingDir),
    ensureDir(paths.novelStateDir),
    ensureDir(paths.chaptersDir),
    ensureDir(paths.charactersDir),
    ensureDir(paths.sharedStyleFingerprintsDir),
    ensureDir(paths.sharedRagCollectionsDir),
    ensureDir(paths.sharedOpeningCollectionsDir),
  ]);

  if (!(await exists(paths.projectFile))) {
    const initialState = mergeProjectState({
      initializedAt: nowIso(),
      updatedAt: nowIso(),
    });
    await writeJson(paths.projectFile, initialState);
  }

  async function loadProject() {
    const state = await readJson(paths.projectFile, DEFAULT_PROJECT_STATE);
    return mergeProjectState(state);
  }

  async function saveProject(projectState) {
    const merged = mergeProjectState({
      ...projectState,
      updatedAt: nowIso(),
    });
    await writeJson(paths.projectFile, merged);
    return merged;
  }

  async function saveRun(run) {
    const target = path.join(paths.runsDir, `${run.id}.json`);
    await writeJson(target, run);
    return target;
  }

  async function listRuns(phase, limit = 8) {
    const files = await listFilesRecursive(paths.runsDir);
    const runs = [];

    for (const filePath of files) {
      if (!filePath.endsWith(".json")) {
        continue;
      }
      const run = await readJson(filePath, null);
      if (!run) {
        continue;
      }
      if (!phase || run.phase === phase) {
        runs.push(normalizeRun(run));
      }
    }

    return runs
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
      .slice(0, limit);
  }

  async function saveReview(review) {
    const filePath = path.join(paths.reviewsDir, `${review.id}.json`);
    await writeJson(filePath, review);
    return filePath;
  }

  async function removeRunsByPhase(phase) {
    const files = await listFilesRecursive(paths.runsDir);
    for (const filePath of files) {
      if (!filePath.endsWith(".json")) {
        continue;
      }
      const run = await readJson(filePath, null);
      if (run?.phase === phase) {
        await removeIfExists(filePath);
      }
    }
  }

  async function removeReviewsByTargets(targets = []) {
    const targetSet = new Set(
      (Array.isArray(targets) ? targets : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    );
    if (!targetSet.size) {
      return;
    }

    const files = await listFilesRecursive(paths.reviewsDir);
    for (const filePath of files) {
      if (!filePath.endsWith(".json")) {
        continue;
      }
      const review = await readJson(filePath, null);
      if (targetSet.has(String(review?.target || "").trim())) {
        await removeIfExists(filePath);
      }
    }
  }

  async function stagePlanDraft(payload) {
    await writeJson(path.join(paths.planStagingDir, "draft.json"), payload);
    await writeText(path.join(paths.planStagingDir, "outline_draft.md"), payload.outlineMarkdown);
  }

  async function loadPlanDraft() {
    return readJson(path.join(paths.planStagingDir, "draft.json"), null);
  }

  async function stagePlanFinalCacheEntry(entryName, payload) {
    await writeJson(path.join(paths.planStagingDir, "final_cache", entryName), payload);
  }

  async function loadPlanFinalCacheEntry(entryName, fallback = null) {
    return readJson(path.join(paths.planStagingDir, "final_cache", entryName), fallback);
  }

  async function clearPlanFinalCache() {
    await removeDirIfExists(path.join(paths.planStagingDir, "final_cache"));
  }

  async function stagePlanFinal(payload) {
    const finalDir = path.join(paths.planStagingDir, "final");
    await ensureDir(finalDir);
    await writeJson(path.join(finalDir, "bundle.json"), payload);
    await writeText(path.join(finalDir, "outline.md"), payload.outlineMarkdown);
    await writeJson(path.join(finalDir, "outline_data.json"), payload.outlineData);
    await writeText(path.join(finalDir, "worldbuilding.md"), payload.worldbuildingMarkdown);
    await writeText(path.join(finalDir, "structure.md"), payload.structureMarkdown);
    await writeJson(path.join(finalDir, "structure_data.json"), payload.structureData);
    await writeJson(path.join(finalDir, "chapter_slots.json"), payload.chapterSlots || []);
    await writeJson(path.join(finalDir, "world_state.json"), payload.worldState);
    await writeJson(
      path.join(finalDir, "foreshadowing_registry.json"),
      payload.foreshadowingRegistry,
    );
    await writeText(path.join(finalDir, "style_guide.md"), DEFAULT_STYLE_GUIDE_MARKDOWN);

    for (const character of payload.characters) {
      await writeText(
        path.join(finalDir, "characters", `${character.name}_biography.md`),
        character.biographyMarkdown,
      );
      await writeText(
        path.join(finalDir, "characters", `${character.name}_profile.md`),
        character.profileMarkdown,
      );
      await writeText(
        path.join(finalDir, "characters", `${character.name}_storyline.md`),
        character.storylineMarkdown,
      );
      await writeJson(
        path.join(finalDir, "characters", `${character.name}_state.json`),
        character.state,
      );
    }
  }

  async function loadPlanFinal() {
    return readJson(path.join(paths.planStagingDir, "final", "bundle.json"), null);
  }

  async function clearPlanFinal() {
    await removeDirIfExists(path.join(paths.planStagingDir, "final"));
  }

  async function commitPlanFinal() {
    const source = path.join(paths.planStagingDir, "final");
    if (!(await exists(source))) {
      return false;
    }
    await copyDirectory(source, paths.novelStateDir);
    return true;
  }

  async function stageChapterDraft(payload) {
    const chapterDir = path.join(paths.writeStagingDir, payload.chapterId);
    const historyContext = payload.historyContext || payload.retrieval || {};
    const planContext = payload.planContext || {};
    const chapterOutlineContext = payload.chapterOutlineContext || {};
    const chapterOutlineCandidates = payload.chapterOutlineCandidates || [];
    const chapterOutlineHistory = payload.chapterOutlineHistory || [];
    const writerContext = payload.writerContext || {};
    const researchPacket = payload.researchPacket || {};
    const referencePacket = payload.referencePacket || {};
    const openingReferencePacket = payload.openingReferencePacket || {};
    const chapterSlot = payload.chapterSlot || null;
    const continuityGuard = payload.continuityGuard || {};
    const contextConflicts = payload.contextConflicts || {};
    const outlineGenerationContract = payload.outlineGenerationContract || {};
    const outlineContinuityAudit = payload.outlineContinuityAudit || {};
    const chapterIntent = payload.chapterIntent || {};
    const contextPackage = payload.contextPackage || {};
    const ruleStack = payload.ruleStack || {};
    const contextTrace = payload.contextTrace || payload.trace || {};
    const writerPromptPacket = payload.writerPromptPacket || null;
    const auditDrift = payload.auditDrift || {};
    const factContext = payload.factContext || {};
    await ensureDir(chapterDir);
    await writeJson(path.join(chapterDir, "bundle.json"), payload);
    await writeText(path.join(chapterDir, `${payload.chapterId}.md`), payload.chapterMarkdown || "");
    await writeJson(path.join(chapterDir, "scene_drafts.json"), payload.sceneDrafts || []);
    await writeJson(path.join(chapterDir, `${payload.chapterId}_meta.json`), payload.chapterMeta || null);
    await writeJson(path.join(chapterDir, "validation.json"), payload.validation || null);
    await writeJson(path.join(chapterDir, "world_state.json"), payload.worldState || null);
    await writeJson(path.join(chapterDir, "retrieval.json"), historyContext);
    await writeJson(path.join(chapterDir, "history_context.json"), historyContext);
    await writeText(path.join(chapterDir, "history_context.md"), historyContext.briefingMarkdown || "");
    await writeJson(path.join(chapterDir, "plan_context.json"), planContext);
    await writeText(path.join(chapterDir, "plan_context.md"), planContext.briefingMarkdown || "");
    await writeJson(path.join(chapterDir, "outline_context.json"), chapterOutlineContext);
    await writeText(path.join(chapterDir, "outline_context.md"), chapterOutlineContext.briefingMarkdown || "");
    await writeJson(path.join(chapterDir, "outline_candidates.json"), chapterOutlineCandidates);
    await writeJson(path.join(chapterDir, "outline_history.json"), chapterOutlineHistory);
    await writeJson(path.join(chapterDir, "chapter_slot.json"), chapterSlot);
    await writeJson(path.join(chapterDir, "continuity_guard.json"), continuityGuard);
    await writeText(path.join(chapterDir, "continuity_guard.md"), continuityGuard.markdown || "");
    await writeJson(path.join(chapterDir, "context_conflicts.json"), contextConflicts);
    await writeJson(path.join(chapterDir, "outline_generation_contract.json"), outlineGenerationContract);
    await writeJson(path.join(chapterDir, "outline_continuity_audit.json"), outlineContinuityAudit);
    await writeJson(path.join(chapterDir, "writer_context.json"), writerContext);
    await writeText(path.join(chapterDir, "writer_context.md"), writerContext.briefingMarkdown || "");
    await writeJson(path.join(chapterDir, "chapter_intent.json"), chapterIntent);
    await writeJson(path.join(chapterDir, "context_package.json"), contextPackage);
    await writeJson(path.join(chapterDir, "rule_stack.json"), ruleStack);
    await writeJson(path.join(chapterDir, "trace.json"), contextTrace);
    await writeJson(path.join(chapterDir, "writer_prompt_packet.json"), writerPromptPacket);
    await writeText(path.join(chapterDir, "writer_prompt_packet.md"), writerPromptPacket?.markdown || "");
    await writeJson(path.join(chapterDir, "research_packet.json"), researchPacket);
    await writeText(path.join(chapterDir, "research_packet.md"), researchPacket.briefingMarkdown || "");
    await writeJson(path.join(chapterDir, "reference_packet.json"), referencePacket);
    await writeText(path.join(chapterDir, "reference_packet.md"), referencePacket.briefingMarkdown || "");
    await writeJson(path.join(chapterDir, "opening_reference_packet.json"), openingReferencePacket);
    await writeText(path.join(chapterDir, "opening_reference_packet.md"), openingReferencePacket.briefingMarkdown || "");
    await writeJson(path.join(chapterDir, "provider_snapshot.json"), payload.providerSnapshot || {});
    await writeJson(path.join(chapterDir, "review_state.json"), payload.reviewState || {});
    await writeJson(path.join(chapterDir, "rewrite_history.json"), payload.rewriteHistory || []);
    await writeJson(path.join(chapterDir, "selected_chapter_outline.json"), payload.selectedChapterOutline || null);
    await writeJson(path.join(chapterDir, "audit_drift.json"), auditDrift);
    await writeText(path.join(chapterDir, "audit_drift.md"), auditDrift.markdown || "");
    await writeJson(path.join(chapterDir, "fact_context.json"), factContext);
    await writeText(path.join(chapterDir, "fact_context.md"), factContext.briefingMarkdown || "");
    await writeJson(
      path.join(chapterDir, "foreshadowing_registry.json"),
      payload.foreshadowingRegistry || null,
    );
    await removeIfExists(path.join(chapterDir, "actor_packets.json"));

    for (const state of payload.characterStates || []) {
      await writeJson(path.join(chapterDir, "characters", `${state.name}_state.json`), state);
    }
  }

  async function loadChapterDraft(chapterId) {
    return readJson(path.join(paths.writeStagingDir, chapterId, "bundle.json"), null);
  }

  async function commitChapterDraft(chapterId) {
    const sourceDir = path.join(paths.writeStagingDir, chapterId);
    if (!(await exists(sourceDir))) {
      return false;
    }

    await copyFile(
      path.join(sourceDir, `${chapterId}.md`),
      path.join(paths.chaptersDir, `${chapterId}.md`),
    );
    await copyFile(
      path.join(sourceDir, `${chapterId}_meta.json`),
      path.join(paths.chaptersDir, `${chapterId}_meta.json`),
    );
    if (await exists(path.join(sourceDir, "selected_chapter_outline.json"))) {
      await copyFile(
        path.join(sourceDir, "selected_chapter_outline.json"),
        path.join(paths.chaptersDir, `${chapterId}_outline.json`),
      );
    }
    if (await exists(path.join(sourceDir, "audit_drift.json"))) {
      await copyFile(
        path.join(sourceDir, "audit_drift.json"),
        path.join(paths.chaptersDir, `${chapterId}_audit_drift.json`),
      );
    }
    if (await exists(path.join(sourceDir, "audit_drift.md"))) {
      await copyFile(
        path.join(sourceDir, "audit_drift.md"),
        path.join(paths.chaptersDir, `${chapterId}_audit_drift.md`),
      );
    }
    await copyFile(
      path.join(sourceDir, "world_state.json"),
      path.join(paths.novelStateDir, "world_state.json"),
    );
    await copyFile(
      path.join(sourceDir, "foreshadowing_registry.json"),
      path.join(paths.novelStateDir, "foreshadowing_registry.json"),
    );

    const stateFiles = await listFilesRecursive(path.join(sourceDir, "characters"));
    for (const filePath of stateFiles) {
      await copyFile(filePath, path.join(paths.charactersDir, path.basename(filePath)));
    }

    return true;
  }

  async function removeCommittedChapter(chapterId) {
    const chapterFiles = [
      path.join(paths.chaptersDir, `${chapterId}.md`),
      path.join(paths.chaptersDir, `${chapterId}_meta.json`),
      path.join(paths.chaptersDir, `${chapterId}_outline.json`),
      path.join(paths.chaptersDir, `${chapterId}_audit_drift.json`),
      path.join(paths.chaptersDir, `${chapterId}_audit_drift.md`),
      path.join(paths.chaptersDir, `${chapterId}_facts.json`),
    ];

    await Promise.all(chapterFiles.map((filePath) => removeIfExists(filePath)));
  }

  async function removeChapterDraft(chapterId) {
    await removeDirIfExists(path.join(paths.writeStagingDir, chapterId));
  }

  async function replaceCharacterStates(states = []) {
    await removeDirIfExists(paths.charactersDir);
    await ensureDir(paths.charactersDir);

    for (const state of Array.isArray(states) ? states : []) {
      const name = String(state?.name || "").trim();
      if (!name) {
        continue;
      }
      await writeJson(path.join(paths.charactersDir, `${name}_state.json`), state);
    }
  }

  async function listChapterMeta() {
    const files = await listFilesRecursive(paths.chaptersDir);
    const metas = [];
    for (const filePath of files) {
      if (!filePath.endsWith("_meta.json")) {
        continue;
      }
      const meta = await readJson(filePath, null);
      if (meta) {
        metas.push(meta);
      }
    }
    return metas.sort((a, b) => String(a.chapter_id).localeCompare(String(b.chapter_id)));
  }

  async function listCommittedChapterOutlines() {
    const files = await listFilesRecursive(paths.chaptersDir);
    const outlines = [];
    for (const filePath of files) {
      if (!filePath.endsWith("_outline.json")) {
        continue;
      }
      const outline = await readJson(filePath, null);
      if (outline) {
        outlines.push(outline);
      }
    }
    return outlines.sort((a, b) => {
      const left = Number(a?.chapterPlan?.chapterNumber || String(a?.chapterPlan?.chapterId || "").replace(/[^\d]/g, "")) || 0;
      const right = Number(b?.chapterPlan?.chapterNumber || String(b?.chapterPlan?.chapterId || "").replace(/[^\d]/g, "")) || 0;
      return left - right;
    });
  }

  function styleFingerprintDir(styleId) {
    return path.join(paths.sharedStyleFingerprintsDir, String(styleId || "").trim());
  }

  async function saveStyleFingerprint({
    metadata,
    sampleMarkdown = "",
    fingerprint = null,
    promptMarkdown = "",
  }) {
    const id = String(metadata?.id || "").trim();
    if (!id) {
      throw new Error("Style fingerprint id is required.");
    }

    const dir = styleFingerprintDir(id);
    await ensureDir(dir);
    await writeJson(path.join(dir, "metadata.json"), metadata);
    await writeText(path.join(dir, "sample.md"), sampleMarkdown);
    await writeJson(path.join(dir, "fingerprint.json"), fingerprint || {});
    await writeText(path.join(dir, "prompt.md"), promptMarkdown);
    return dir;
  }

  async function listStyleFingerprints() {
    if (!(await exists(paths.sharedStyleFingerprintsDir))) {
      return [];
    }

    const entries = await fs.readdir(paths.sharedStyleFingerprintsDir, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const metadata = await readJson(path.join(paths.sharedStyleFingerprintsDir, entry.name, "metadata.json"), null);
      if (!metadata?.id) {
        continue;
      }
      items.push(metadata);
    }

    return items.sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  }

  async function loadStyleFingerprint(styleId) {
    const id = String(styleId || "").trim();
    if (!id) {
      return null;
    }

    const dir = styleFingerprintDir(id);
    const metadata = await readJson(path.join(dir, "metadata.json"), null);
    if (!metadata) {
      return null;
    }

    return {
      metadata,
      sampleMarkdown: await readText(path.join(dir, "sample.md"), ""),
      fingerprint: await readJson(path.join(dir, "fingerprint.json"), {}),
      promptMarkdown: await readText(path.join(dir, "prompt.md"), ""),
    };
  }

  async function updateStyleFingerprint(styleId, { name, promptMarkdown, summary }) {
    const current = await loadStyleFingerprint(styleId);
    if (!current) {
      throw new Error("Style fingerprint not found.");
    }

    const nextMetadata = {
      ...current.metadata,
      name: String(name || current.metadata.name || "").trim() || current.metadata.id,
      summary: String(summary || current.metadata.summary || "").trim(),
      updatedAt: nowIso(),
    };

    await saveStyleFingerprint({
      metadata: nextMetadata,
      sampleMarkdown: current.sampleMarkdown,
      fingerprint: current.fingerprint,
      promptMarkdown: String(promptMarkdown || current.promptMarkdown || "").trim(),
    });

    return loadStyleFingerprint(styleId);
  }

  async function buildDocumentIndex() {
    const files = [
      ...(await listFilesRecursive(paths.sharedStyleFingerprintsDir)),
      ...(await listFilesRecursive(paths.sharedRagCollectionsDir)),
      ...(await listFilesRecursive(paths.sharedOpeningCollectionsDir)),
      ...(await listFilesRecursive(paths.novelStateDir)),
      ...(await listFilesRecursive(paths.stagingDir)),
    ];

    const documentEntries = [];
    for (const filePath of files) {
      const stat = await fs.stat(filePath);
      documentEntries.push({
        id: path.relative(paths.workspaceRoot, filePath),
        label: path.relative(paths.workspaceRoot, filePath),
        scope: filePath.includes(`${path.sep}style_fingerprints${path.sep}`)
          || filePath.includes(`${path.sep}rag_collections${path.sep}`)
          || filePath.includes(`${path.sep}opening_collections${path.sep}`)
          ? "shared"
          : filePath.includes(`${path.sep}staging${path.sep}`)
            ? "staged"
            : "committed",
        modifiedAt: stat.mtime.toISOString(),
      });
    }

    return documentEntries.sort((a, b) => a.label.localeCompare(b.label));
  }

  async function readDocument(relativePath) {
    const allowedRoots = [
      paths.rootDir,
      paths.sharedStyleFingerprintsDir,
      paths.sharedRagCollectionsDir,
      paths.sharedOpeningCollectionsDir,
    ].map((root) => path.resolve(root));
    const candidatePaths = [
      path.resolve(paths.workspaceRoot, relativePath),
      path.resolve(paths.rootDir, relativePath),
    ];

    for (const resolved of candidatePaths) {
      if (!allowedRoots.some((root) => resolved.startsWith(root))) {
        continue;
      }
      if (!(await exists(resolved))) {
        continue;
      }

      const content = await readText(resolved, "");
      return {
        path: relativePath,
        content,
      };
    }

    return null;
  }

  function ragCollectionDir(collectionId) {
    return path.join(paths.sharedRagCollectionsDir, String(collectionId || "").trim());
  }

  function slugifyCollectionName(value) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9\u4e00-\u9fff-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return normalized || "collection";
  }

  async function createRagCollection(name) {
    const label = String(name || "").trim() || "新范文库";
    const id = `${slugifyCollectionName(label)}-${Date.now()}`;
    const dir = ragCollectionDir(id);
    const sourceDir = path.join(dir, "sources");
    const metadata = {
      id,
      name: label,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const index = {
      collectionId: id,
      fileCount: 0,
      chunkCount: 0,
      lastBuiltAt: null,
      lastError: "",
      sourceFiles: [],
      sourceDir: path.relative(paths.workspaceRoot, sourceDir),
    };

    await ensureDir(sourceDir);
    await writeJson(path.join(dir, "metadata.json"), metadata);
    await writeJson(path.join(dir, "index.json"), index);
    await writeJsonLines(path.join(dir, "chunks.jsonl"), []);

    return {
      ...metadata,
      ...index,
      sourceDir,
    };
  }

  async function loadRagCollection(collectionId) {
    const id = String(collectionId || "").trim();
    if (!id) {
      return null;
    }

    const dir = ragCollectionDir(id);
    const metadata = await readJson(path.join(dir, "metadata.json"), null);
    if (!metadata) {
      return null;
    }
    const index = await readJson(path.join(dir, "index.json"), {});
    return {
      ...metadata,
      ...index,
      sourceDir: path.join(dir, "sources"),
      sourceDirRelative: path.relative(paths.workspaceRoot, path.join(dir, "sources")),
      chunksPath: path.join(dir, "chunks.jsonl"),
    };
  }

  async function listRagCollections() {
    if (!(await exists(paths.sharedRagCollectionsDir))) {
      return [];
    }

    const entries = await fs.readdir(paths.sharedRagCollectionsDir, { withFileTypes: true });
    const collections = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const collection = await loadRagCollection(entry.name);
      if (!collection) {
        continue;
      }
      collections.push(collection);
    }

    return collections.sort((left, right) =>
      String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  }

  async function saveRagCollectionMetadata(collectionId, metadata) {
    const id = String(collectionId || "").trim();
    if (!id) {
      throw new Error("RAG collection id is required.");
    }

    const current = await loadRagCollection(id);
    if (!current) {
      throw new Error("RAG collection not found.");
    }

    const next = {
      id,
      ...current,
      ...metadata,
      updatedAt: nowIso(),
    };
    await writeJson(path.join(ragCollectionDir(id), "metadata.json"), {
      id: next.id,
      name: next.name,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
    });
    return loadRagCollection(id);
  }

  async function loadRagCollectionIndex(collectionId, fallback = null) {
    const id = String(collectionId || "").trim();
    if (!id) {
      return fallback;
    }
    return readJson(path.join(ragCollectionDir(id), "index.json"), fallback);
  }

  async function saveRagCollectionIndex(collectionId, index) {
    const id = String(collectionId || "").trim();
    if (!id) {
      throw new Error("RAG collection id is required.");
    }
    const current = await loadRagCollection(id);
    if (!current) {
      throw new Error("RAG collection not found.");
    }

    const nextIndex = {
      collectionId: id,
      sourceDir: path.relative(paths.workspaceRoot, path.join(ragCollectionDir(id), "sources")),
      ...(current || {}),
      ...(index || {}),
    };
    await writeJson(path.join(ragCollectionDir(id), "index.json"), nextIndex);
    await saveRagCollectionMetadata(id, {
      updatedAt: nowIso(),
    });
    return loadRagCollectionIndex(id, null);
  }

  async function readRagCollectionChunks(collectionId, fallback = []) {
    const id = String(collectionId || "").trim();
    if (!id) {
      return fallback;
    }
    return readJsonLines(path.join(ragCollectionDir(id), "chunks.jsonl"), fallback);
  }

  async function writeRagCollectionChunks(collectionId, rows) {
    const id = String(collectionId || "").trim();
    if (!id) {
      throw new Error("RAG collection id is required.");
    }
    await writeJsonLines(path.join(ragCollectionDir(id), "chunks.jsonl"), rows);
    await saveRagCollectionMetadata(id, {
      updatedAt: nowIso(),
    });
  }

  function openingCollectionDir(collectionId) {
    return path.join(paths.sharedOpeningCollectionsDir, String(collectionId || "").trim());
  }

  async function createOpeningCollection(name) {
    const label = String(name || "").trim() || "新开头参考库";
    const id = `${slugifyCollectionName(label)}-${Date.now()}`;
    const dir = openingCollectionDir(id);
    const sourceDir = path.join(dir, "sources");
    const metadata = {
      id,
      name: label,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const index = {
      collectionId: id,
      fileCount: 0,
      chunkCount: 0,
      lastBuiltAt: null,
      lastError: "",
      sourceFiles: [],
      sourceDir: path.relative(paths.workspaceRoot, sourceDir),
    };

    await ensureDir(sourceDir);
    await writeJson(path.join(dir, "metadata.json"), metadata);
    await writeJson(path.join(dir, "index.json"), index);
    await writeJsonLines(path.join(dir, "chunks.jsonl"), []);

    return {
      ...metadata,
      ...index,
      sourceDir,
    };
  }

  async function loadOpeningCollection(collectionId) {
    const id = String(collectionId || "").trim();
    if (!id) {
      return null;
    }

    const dir = openingCollectionDir(id);
    const metadata = await readJson(path.join(dir, "metadata.json"), null);
    if (!metadata) {
      return null;
    }
    const index = await readJson(path.join(dir, "index.json"), {});
    return {
      ...metadata,
      ...index,
      sourceDir: path.join(dir, "sources"),
      sourceDirRelative: path.relative(paths.workspaceRoot, path.join(dir, "sources")),
      chunksPath: path.join(dir, "chunks.jsonl"),
    };
  }

  async function listOpeningCollections() {
    if (!(await exists(paths.sharedOpeningCollectionsDir))) {
      return [];
    }

    const entries = await fs.readdir(paths.sharedOpeningCollectionsDir, { withFileTypes: true });
    const collections = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const collection = await loadOpeningCollection(entry.name);
      if (!collection) {
        continue;
      }
      collections.push(collection);
    }

    return collections.sort((left, right) =>
      String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  }

  async function saveOpeningCollectionMetadata(collectionId, metadata) {
    const id = String(collectionId || "").trim();
    if (!id) {
      throw new Error("Opening collection id is required.");
    }

    const current = await loadOpeningCollection(id);
    if (!current) {
      throw new Error("Opening collection not found.");
    }

    const next = {
      id,
      ...current,
      ...metadata,
      updatedAt: nowIso(),
    };
    await writeJson(path.join(openingCollectionDir(id), "metadata.json"), {
      id: next.id,
      name: next.name,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
    });
    return loadOpeningCollection(id);
  }

  async function loadOpeningCollectionIndex(collectionId, fallback = null) {
    const id = String(collectionId || "").trim();
    if (!id) {
      return fallback;
    }
    return readJson(path.join(openingCollectionDir(id), "index.json"), fallback);
  }

  async function saveOpeningCollectionIndex(collectionId, index) {
    const id = String(collectionId || "").trim();
    if (!id) {
      throw new Error("Opening collection id is required.");
    }
    const current = await loadOpeningCollection(id);
    if (!current) {
      throw new Error("Opening collection not found.");
    }

    const nextIndex = {
      collectionId: id,
      sourceDir: path.relative(paths.workspaceRoot, path.join(openingCollectionDir(id), "sources")),
      ...(current || {}),
      ...(index || {}),
    };
    await writeJson(path.join(openingCollectionDir(id), "index.json"), nextIndex);
    await saveOpeningCollectionMetadata(id, {
      updatedAt: nowIso(),
    });
    return loadOpeningCollectionIndex(id, null);
  }

  async function readOpeningCollectionChunks(collectionId, fallback = []) {
    const id = String(collectionId || "").trim();
    if (!id) {
      return fallback;
    }
    return readJsonLines(path.join(openingCollectionDir(id), "chunks.jsonl"), fallback);
  }

  async function writeOpeningCollectionChunks(collectionId, rows) {
    const id = String(collectionId || "").trim();
    if (!id) {
      throw new Error("Opening collection id is required.");
    }
    await writeJsonLines(path.join(openingCollectionDir(id), "chunks.jsonl"), rows);
    await saveOpeningCollectionMetadata(id, {
      updatedAt: nowIso(),
    });
  }

  return {
    paths,
    exists,
    ensureDir,
    readJson,
    readText,
    writeJson,
    writeText,
    loadProject,
    saveProject,
    saveRun,
    listRuns,
    saveReview,
    removeRunsByPhase,
    removeReviewsByTargets,
    stagePlanDraft,
    loadPlanDraft,
    stagePlanFinalCacheEntry,
    loadPlanFinalCacheEntry,
    clearPlanFinalCache,
    stagePlanFinal,
    loadPlanFinal,
    clearPlanFinal,
    commitPlanFinal,
    stageChapterDraft,
    loadChapterDraft,
    commitChapterDraft,
    removeCommittedChapter,
    removeChapterDraft,
    replaceCharacterStates,
    listChapterMeta,
    listCommittedChapterOutlines,
    saveStyleFingerprint,
    listStyleFingerprints,
    loadStyleFingerprint,
    updateStyleFingerprint,
    createRagCollection,
    loadRagCollection,
    listRagCollections,
    saveRagCollectionMetadata,
    loadRagCollectionIndex,
    saveRagCollectionIndex,
    readRagCollectionChunks,
    writeRagCollectionChunks,
    createOpeningCollection,
    loadOpeningCollection,
    listOpeningCollections,
    saveOpeningCollectionMetadata,
    loadOpeningCollectionIndex,
    saveOpeningCollectionIndex,
    readOpeningCollectionChunks,
    writeOpeningCollectionChunks,
    buildDocumentIndex,
    readDocument,
  };
}
