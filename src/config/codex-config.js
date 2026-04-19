import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG_FILENAME = "novelex.codex.toml";
const DEFAULT_PROVIDER_CATALOG = {
  OpenAI: {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    wire_api: "responses",
    response_model: "gpt-5.4",
    review_model: "gpt-5.4",
    codex_model: "gpt-5.3-codex",
    requires_openai_auth: true,
  },
};
const UNSUPPORTED_PROVIDER_IDS = new Set(["Kimi", "MiniMax"]);

function stripInlineComment(line) {
  let inString = false;
  let escaped = false;
  let output = "";

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      output += char;
      continue;
    }

    if (!inString && char === "#") {
      break;
    }

    output += char;
  }

  return output.trim();
}

function parseValue(raw) {
  const value = raw.trim();
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\"/g, "\"");
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function parseSimpleToml(tomlText) {
  const root = {};
  let currentPath = [];

  const lines = String(tomlText || "").replace(/\r/g, "").split("\n");
  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine);
    if (!line) {
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      const sectionPath = line
        .slice(1, -1)
        .split(".")
        .map((part) => part.trim())
        .filter(Boolean);
      currentPath = sectionPath;

      let target = root;
      for (const part of currentPath) {
        if (!target[part] || typeof target[part] !== "object") {
          target[part] = {};
        }
        target = target[part];
      }
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1);
    let target = root;
    for (const part of currentPath) {
      target = target[part];
    }
    target[key] = parseValue(rawValue);
  }

  return root;
}

function serializeValue(value) {
  if (typeof value === "string") {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  return null;
}

function hasScalarEntries(node) {
  return Object.values(node || {}).some((value) => !isPlainObject(value) && value !== undefined && value !== null);
}

function appendSections(lines, node, currentPath = []) {
  for (const [key, value] of Object.entries(node || {})) {
    if (!isPlainObject(value)) {
      continue;
    }

    const nextPath = [...currentPath, key];
    if (hasScalarEntries(value)) {
      if (lines.length && lines.at(-1) !== "") {
        lines.push("");
      }
      lines.push(`[${nextPath.join(".")}]`);
      for (const [entryKey, entryValue] of Object.entries(value)) {
        if (isPlainObject(entryValue) || entryValue === undefined || entryValue === null) {
          continue;
        }
        const serialized = serializeValue(entryValue);
        if (serialized !== null) {
          lines.push(`${entryKey} = ${serialized}`);
        }
      }
    }

    appendSections(lines, value, nextPath);
  }
}

export function stringifySimpleToml(data = {}) {
  const lines = [];

  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value) || value === undefined || value === null) {
      continue;
    }
    const serialized = serializeValue(value);
    if (serialized !== null) {
      lines.push(`${key} = ${serialized}`);
    }
  }

  appendSections(lines, data);
  return `${lines.join("\n").trim()}\n`;
}

export function codexConfigPath(rootDir = process.cwd()) {
  return path.join(rootDir, DEFAULT_CONFIG_FILENAME);
}

export function defaultProviderCatalog() {
  return cloneJson(DEFAULT_PROVIDER_CATALOG);
}

function fallbackProviderId(modelProviders = {}) {
  if (modelProviders.OpenAI) {
    return "OpenAI";
  }
  return Object.keys(modelProviders).find((providerId) => !UNSUPPORTED_PROVIDER_IDS.has(providerId)) || "OpenAI";
}

export function normalizeProviderCatalog(rawProviders = {}) {
  const normalized = {};

  for (const [providerId, defaults] of Object.entries(DEFAULT_PROVIDER_CATALOG)) {
    normalized[providerId] = {
      ...defaults,
      ...(rawProviders?.[providerId] || {}),
      name: String(rawProviders?.[providerId]?.name || defaults.name || providerId).trim() || providerId,
    };
  }

  for (const [providerId, config] of Object.entries(rawProviders || {})) {
    if (UNSUPPORTED_PROVIDER_IDS.has(providerId)) {
      continue;
    }
    if (normalized[providerId]) {
      continue;
    }
    normalized[providerId] = {
      name: providerId,
      ...(config || {}),
    };
  }

  return normalized;
}

export function normalizeCodexConfigData(data = {}) {
  const normalized = {
    ...cloneJson(data || {}),
  };
  normalized.model_providers = normalizeProviderCatalog(normalized.model_providers || {});

  const requestedProviderId = String(normalized.model_provider || "OpenAI").trim() || "OpenAI";
  const providerId = normalized.model_providers[requestedProviderId]
    ? requestedProviderId
    : fallbackProviderId(normalized.model_providers);
  const keepRootModelSelection = providerId === requestedProviderId;
  const providerBlock =
    normalized.model_providers[providerId] ||
    normalized.model_providers.OpenAI ||
    defaultProviderCatalog().OpenAI;

  normalized.model_provider = providerId;
  normalized.model =
    String(
      (keepRootModelSelection ? normalized.model : "") ||
      providerBlock.response_model ||
      providerBlock.model ||
      DEFAULT_PROVIDER_CATALOG.OpenAI.response_model,
    ).trim() || DEFAULT_PROVIDER_CATALOG.OpenAI.response_model;
  normalized.review_model =
    String(
      (keepRootModelSelection ? normalized.review_model : "") ||
      providerBlock.review_model ||
      providerBlock.response_model ||
      normalized.model ||
      DEFAULT_PROVIDER_CATALOG.OpenAI.review_model,
    ).trim() || normalized.model;
  normalized.codex_model =
    String(
      (keepRootModelSelection ? normalized.codex_model : "") ||
      providerBlock.codex_model ||
      providerBlock.response_model ||
      normalized.model ||
      DEFAULT_PROVIDER_CATALOG.OpenAI.codex_model,
    ).trim() || normalized.model;
  normalized.model_reasoning_effort =
    String(normalized.model_reasoning_effort || "medium").trim() || "medium";

  if (!Object.prototype.hasOwnProperty.call(normalized, "disable_response_storage")) {
    normalized.disable_response_storage = true;
  }

  return normalized;
}

export function loadCodexApiConfig(rootDir = process.cwd()) {
  const filePath = codexConfigPath(rootDir);
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      path: filePath,
      data: null,
      error: null,
    };
  }

  try {
    const text = fs.readFileSync(filePath, "utf8");
    const data = parseSimpleToml(text);
    return {
      exists: true,
      path: filePath,
      data,
      error: null,
    };
  } catch (error) {
    return {
      exists: true,
      path: filePath,
      data: null,
      error: error instanceof Error ? error.message : "Failed to load config",
    };
  }
}

export function saveCodexApiConfig(rootDir = process.cwd(), data = {}) {
  const filePath = codexConfigPath(rootDir);
  const normalized = normalizeCodexConfigData(data);
  fs.writeFileSync(filePath, stringifySimpleToml(normalized), "utf8");
  return {
    exists: true,
    path: filePath,
    data: normalized,
    error: null,
  };
}
