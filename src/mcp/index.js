import { McpManager } from "./manager.js";
import { normalizeLocalRagToolResult, normalizeWebSearchToolResult } from "./normalize.js";

const managerCache = new Map();

export function createMcpManager(options = {}) {
  return new McpManager(options);
}

export function getWorkspaceMcpManager(options = {}) {
  const rootDir = String(options.rootDir || process.cwd()).trim() || process.cwd();
  if (!managerCache.has(rootDir)) {
    managerCache.set(rootDir, createMcpManager(options));
  }
  return managerCache.get(rootDir);
}

export async function closeAllWorkspaceMcpManagers() {
  const managers = [...managerCache.values()];
  managerCache.clear();
  await Promise.all(managers.map((manager) => manager.closeAll()));
}

export {
  normalizeLocalRagToolResult,
  normalizeWebSearchToolResult,
};
