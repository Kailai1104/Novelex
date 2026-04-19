import path from "node:path";

export function createPaths(projectRoot = process.cwd(), options = {}) {
  const workspaceRoot = options.workspaceRoot || projectRoot;
  const runtimeDir = path.join(projectRoot, "runtime");
  const workspaceRuntimeDir = path.join(workspaceRoot, "runtime");
  const runsDir = path.join(runtimeDir, "runs");
  const stagingDir = path.join(runtimeDir, "staging");
  const publicDir = path.join(workspaceRoot, "public");
  const novelStateDir = path.join(projectRoot, "novel_state");

  return {
    rootDir: projectRoot,
    projectRoot,
    workspaceRoot,
    configRootDir: workspaceRoot,
    workspaceRuntimeDir,
    sharedStyleFingerprintsDir: path.join(workspaceRuntimeDir, "style_fingerprints"),
    sharedRagCollectionsDir: path.join(workspaceRuntimeDir, "rag_collections"),
    sharedOpeningCollectionsDir: path.join(workspaceRuntimeDir, "opening_collections"),
    runtimeDir,
    runsDir,
    reviewsDir: path.join(runtimeDir, "reviews"),
    stagingDir,
    planStagingDir: path.join(stagingDir, "plan"),
    writeStagingDir: path.join(stagingDir, "write"),
    publicDir,
    projectFile: path.join(runtimeDir, "project-state.json"),
    novelStateDir,
    chaptersDir: path.join(novelStateDir, "chapters"),
    charactersDir: path.join(novelStateDir, "characters"),
  };
}
