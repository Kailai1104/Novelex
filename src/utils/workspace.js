import fs from "node:fs/promises";
import path from "node:path";

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) {
    return fallback;
  }

  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function slugifyProjectId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function projectsDir(workspaceRoot = process.cwd()) {
  return path.join(workspaceRoot, "projects");
}

export function projectRoot(workspaceRoot = process.cwd(), projectId) {
  return path.join(projectsDir(workspaceRoot), projectId);
}

async function listProjectIds(workspaceRoot = process.cwd()) {
  const root = projectsDir(workspaceRoot);
  await ensureDir(root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function bootstrapLegacyProject(workspaceRoot = process.cwd()) {
  const currentIds = await listProjectIds(workspaceRoot);
  if (currentIds.length) {
    return;
  }

  const legacyRuntime = path.join(workspaceRoot, "runtime", "project-state.json");
  if (!(await exists(legacyRuntime))) {
    return;
  }

  const targetRoot = projectRoot(workspaceRoot, "default");
  if (await exists(path.join(targetRoot, "runtime", "project-state.json"))) {
    return;
  }

  await ensureDir(targetRoot);
  if (await exists(path.join(workspaceRoot, "runtime"))) {
    await fs.cp(path.join(workspaceRoot, "runtime"), path.join(targetRoot, "runtime"), { recursive: true });
  }
  if (await exists(path.join(workspaceRoot, "novel_state"))) {
    await fs.cp(path.join(workspaceRoot, "novel_state"), path.join(targetRoot, "novel_state"), { recursive: true });
  }
}

export async function listProjects(workspaceRoot = process.cwd()) {
  await bootstrapLegacyProject(workspaceRoot);
  const ids = await listProjectIds(workspaceRoot);
  const projects = [];

  for (const id of ids) {
    const root = projectRoot(workspaceRoot, id);
    const projectState = await readJson(path.join(root, "runtime", "project-state.json"), null);
    if (!projectState) {
      continue;
    }

    projects.push({
      id,
      title: projectState.project?.title || id,
      genre: projectState.project?.genre || "",
      updatedAt: projectState.updatedAt || projectState.initializedAt || null,
      planStatus: projectState.phase?.plan?.status || "idle",
      writeStatus: projectState.phase?.write?.status || "idle",
      path: root,
    });
  }

  return projects.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

export async function ensureProjectId(workspaceRoot = process.cwd(), requestedId) {
  const projects = await listProjects(workspaceRoot);
  if (!projects.length) {
    return null;
  }

  if (!requestedId) {
    return projects[0].id;
  }

  return projects.some((project) => project.id === requestedId) ? requestedId : null;
}

export async function createProjectWorkspace(workspaceRoot = process.cwd(), projectName = "新项目") {
  await ensureDir(projectsDir(workspaceRoot));

  const baseId = slugifyProjectId(projectName) || "project";
  let projectId = baseId;
  let suffix = 2;
  while (await exists(projectRoot(workspaceRoot, projectId))) {
    projectId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  const root = projectRoot(workspaceRoot, projectId);
  await ensureDir(root);

  return {
    id: projectId,
    root,
    title: String(projectName || "").trim() || projectId,
  };
}

export async function deleteProjectWorkspace(workspaceRoot = process.cwd(), projectId) {
  const id = String(projectId || "").trim();
  if (!id) {
    throw new Error("Missing project id");
  }

  const root = projectRoot(workspaceRoot, id);
  if (!(await exists(root))) {
    return false;
  }

  await fs.rm(root, { recursive: true, force: true });
  return true;
}
