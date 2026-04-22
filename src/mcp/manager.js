import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCodexApiConfig, normalizeCodexConfigData } from "../config/codex-config.js";
import { StdioMcpClient } from "./client.js";
import { McpError } from "./error.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL_TO_SERVER = {
  web_search: "web_search",
  local_rag: "local_rag",
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "")) : [];
}

function commandExists(command, env = process.env) {
  const target = String(command || "").trim();
  if (!target) {
    return false;
  }

  if (target.includes(path.sep)) {
    return fs.existsSync(target);
  }

  const pathValue = String(env?.PATH || process.env.PATH || "").trim();
  if (!pathValue) {
    return false;
  }

  const extensions = process.platform === "win32"
    ? String(env?.PATHEXT || process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .filter(Boolean)
    : [""];

  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => extensions.some((extension) => {
      const candidate = path.join(directory, extension && !target.endsWith(extension) ? `${target}${extension}` : target);
      return fs.existsSync(candidate);
    }));
}

function ensureTextFile(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, "utf8");
  }
}

function resolveMiniMaxHost(fileData = {}) {
  const explicit = String(
    fileData?.mcp?.servers?.web_search?.env?.MINIMAX_API_HOST ||
    process.env.MINIMAX_API_HOST ||
    "",
  ).trim();
  if (explicit) {
    return explicit;
  }

  const baseUrl = String(
    fileData?.model_providers?.MiniMax?.base_url ||
    process.env.MINIMAX_BASE_URL ||
    "",
  ).trim();
  if (!baseUrl) {
    return "https://api.minimaxi.com";
  }

  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/v\d+\/?$/i, "");
  }
}

function buildServerEnv(serverId, serverConfig, rootDir, fileData) {
  const merged = {
    ...process.env,
    ...(serverConfig.env || {}),
    NOVELEX_MCP_ROOT_DIR: rootDir,
  };

  if (serverId === "web_search") {
    const apiKey = String(
      fileData?.model_providers?.MiniMax?.api_key ||
      process.env.MINIMAX_API_KEY ||
      "",
    ).trim();
    if (apiKey) {
      merged.MINIMAX_API_KEY = apiKey;
    }
    merged.MINIMAX_API_HOST = resolveMiniMaxHost(fileData);
    const npmHomeDir = path.join(rootDir, "runtime", "npm-home");
    const npmCacheDir = String(
      merged.npm_config_cache ||
      merged.NPM_CONFIG_CACHE ||
      path.join(rootDir, "runtime", "npm-cache"),
    ).trim();
    const npmUserConfigPath = path.join(npmHomeDir, ".npmrc");
    const xdgCacheDir = path.join(rootDir, "runtime", "xdg-cache");
    if (npmCacheDir) {
      fs.mkdirSync(npmCacheDir, { recursive: true });
      merged.npm_config_cache = npmCacheDir;
      merged.NPM_CONFIG_CACHE = npmCacheDir;
    }
    fs.mkdirSync(npmHomeDir, { recursive: true });
    fs.mkdirSync(xdgCacheDir, { recursive: true });
    ensureTextFile(npmUserConfigPath, "");
    merged.HOME = npmHomeDir;
    merged.USERPROFILE = npmHomeDir;
    merged.XDG_CACHE_HOME = xdgCacheDir;
    merged.npm_config_userconfig = npmUserConfigPath;
    merged.NPM_CONFIG_USERCONFIG = npmUserConfigPath;
    if (!String(merged.npm_config_update_notifier || "").trim()) {
      merged.npm_config_update_notifier = "false";
    }
    if (!String(merged.npm_config_yes || "").trim()) {
      merged.npm_config_yes = "true";
    }
  }

  return merged;
}

function resolveCommand(serverId, command, env) {
  const normalized = String(command || "").trim();
  if (
    serverId === "web_search" &&
    normalized === "uvx" &&
    !commandExists(normalized, env) &&
    commandExists("npx", env)
  ) {
    return "npx";
  }
  return normalized;
}

function resolveStartupTimeoutMs(serverId, serverConfig, command, args = []) {
  const configured = Number(serverConfig?.startup_timeout_ms || 15000);
  if (!Number.isFinite(configured) || configured <= 0) {
    return 15000;
  }

  const normalizedCommand = String(command || "").trim();
  const normalizedArgs = ensureArray(args).map((item) => item.trim());
  const looksLikeMiniMaxPackage =
    normalizedArgs.includes("minimax-coding-plan-mcp") ||
    normalizedArgs.some((item) => /(^|\/)minimax-coding-plan-mcp$/i.test(item));

  if (
    serverId === "web_search" &&
    looksLikeMiniMaxPackage &&
    (normalizedCommand === "npx" || normalizedCommand === "uvx")
  ) {
    // The first launch often includes an on-demand package install, so 15s is too short.
    return Math.max(configured, 60000);
  }

  return configured;
}

function resolveCommandArgs(serverId, args = [], cwd, options = {}) {
  const resolved = ensureArray(args);
  const normalizedCommand = String(options.command || "").trim();

  if (
    serverId === "web_search" &&
    normalizedCommand === "npx" &&
    !resolved.includes("--cache") &&
    !resolved.some((item) => /^--cache=/.test(item))
  ) {
    const npmCacheDir = String(
      options.env?.npm_config_cache ||
      options.env?.NPM_CONFIG_CACHE ||
      path.join(options.rootDir || cwd, "runtime", "npm-cache"),
    ).trim();
    if (npmCacheDir) {
      return ["--cache", npmCacheDir, ...resolved];
    }
  }

  if (serverId !== "local_rag") {
    return resolved;
  }

  if (!resolved.length) {
    return [path.join(APP_ROOT, "src", "mcp", "servers", "local-rag.js")];
  }

  const firstArg = resolved[0];
  const candidate = path.resolve(cwd, firstArg);
  if (fs.existsSync(candidate)) {
    return [candidate, ...resolved.slice(1)];
  }

  if (firstArg === "src/mcp/servers/local-rag.js") {
    return [path.join(APP_ROOT, "src", "mcp", "servers", "local-rag.js"), ...resolved.slice(1)];
  }

  return resolved;
}

function loadMcpConfig(rootDir = process.cwd()) {
  const raw = loadCodexApiConfig(rootDir);
  const fileData = normalizeCodexConfigData(raw.data || {});
  return {
    fileData,
    mcp: cloneJson(fileData.mcp || {}),
  };
}

export class McpManager {
  constructor(options = {}) {
    this.rootDir = options.rootDir || process.cwd();
    this.configRootDir = options.configRootDir || this.rootDir;
    this.clients = new Map();
    this.connecting = new Map();
    this.toolCatalog = new Map();
  }

  async listTools() {
    const toolNames = Object.keys(TOOL_TO_SERVER);
    const tools = [];
    for (const toolName of toolNames) {
      const serverId = TOOL_TO_SERVER[toolName];
      const client = await this.#getServerClient(serverId);
      const serverTools = await client.listTools();
      for (const tool of serverTools) {
        this.toolCatalog.set(tool.name, {
          ...tool,
          serverId,
        });
        tools.push({
          ...tool,
          serverId,
        });
      }
    }
    return tools;
  }

  async callTool(toolName, args = {}, _context = {}) {
    const name = String(toolName || "").trim();
    const serverId = TOOL_TO_SERVER[name];
    if (!serverId) {
      throw new McpError("MCP_UNKNOWN_TOOL", `Unknown MCP tool: ${name}`);
    }

    const client = await this.#getServerClient(serverId);
    return client.callTool(name, args);
  }

  async closeAll() {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.connecting.clear();
    this.toolCatalog.clear();
    await Promise.all(clients.map((client) => client.close()));
  }

  async #getServerClient(serverId) {
    if (this.clients.has(serverId)) {
      return this.clients.get(serverId);
    }

    if (this.connecting.has(serverId)) {
      return this.connecting.get(serverId);
    }

    const connecting = this.#connectServer(serverId)
      .then((client) => {
        this.clients.set(serverId, client);
        this.connecting.delete(serverId);
        return client;
      })
      .catch((error) => {
        this.connecting.delete(serverId);
        throw error;
      });
    this.connecting.set(serverId, connecting);
    return connecting;
  }

  async #connectServer(serverId) {
    const { fileData, mcp } = loadMcpConfig(this.configRootDir);
    if (!mcp?.enabled) {
      throw new McpError("MCP_DISABLED", "MCP is disabled in novelex.codex.toml.");
    }

    const serverConfig = mcp?.servers?.[serverId];
    if (!serverConfig) {
      throw new McpError("MCP_SERVER_NOT_CONFIGURED", `MCP server ${serverId} is not configured.`, {
        serverId,
      });
    }
    if (serverConfig.enabled === false) {
      throw new McpError("MCP_SERVER_DISABLED", `MCP server ${serverId} is disabled.`, {
        serverId,
      });
    }
    if (String(serverConfig.transport || "stdio") !== "stdio") {
      throw new McpError("MCP_SERVER_NOT_CONFIGURED", `MCP server ${serverId} only supports stdio transport in this build.`, {
        serverId,
      });
    }

    const env = buildServerEnv(serverId, serverConfig, this.rootDir, fileData);
    const command = resolveCommand(serverId, serverConfig.command, env);
    const args = resolveCommandArgs(serverId, serverConfig.args || [], this.configRootDir, {
      command,
      env,
      rootDir: this.rootDir,
    });
    const client = new StdioMcpClient({
      serverId,
      command,
      args,
      cwd: this.configRootDir,
      env,
      startupTimeoutMs: resolveStartupTimeoutMs(serverId, serverConfig, command, args),
      callTimeoutMs: Number(serverConfig.call_timeout_ms || 30000),
    });

    try {
      await client.connect();
      const tools = await client.listTools();
      if (!tools.some((tool) => tool?.name === Object.keys(TOOL_TO_SERVER).find((toolName) => TOOL_TO_SERVER[toolName] === serverId))) {
        throw new McpError("MCP_UNKNOWN_TOOL", `MCP server ${serverId} did not expose the expected tool.`, {
          serverId,
        });
      }
      return client;
    } catch (error) {
      await client.close();
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError("MCP_SERVER_STARTUP_FAILED", `Failed to connect MCP server ${serverId}: ${String(error?.message || error || "")}`.trim(), {
        serverId,
        cause: error,
      });
    }
  }
}
