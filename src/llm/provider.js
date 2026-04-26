import fs from "node:fs/promises";
import path from "node:path";

import { loadCodexApiConfig, normalizeCodexConfigData } from "../config/codex-config.js";

const MAX_RECONNECT_ATTEMPTS = 5;
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429]);
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_OVERLOAD_RETRY_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_OVERLOAD_BASE_DELAY_MS = 3000;
const DEFAULT_OVERLOAD_MAX_DELAY_MS = 30000;
const DEFAULT_OVERLOAD_JITTER_RATIO = 0.2;
const DEFAULT_MINIMAX_MAX_CONCURRENCY = 2;
const PROVIDER_ERROR_LOG_FILENAME = "provider-errors.jsonl";
const PROVIDER_ERROR_LOG_MAX_DEPTH = 5;
const PROVIDER_ERROR_LOG_MAX_ARRAY_ITEMS = 20;
const PROVIDER_ERROR_LOG_MAX_OBJECT_KEYS = 40;
const PROVIDER_ERROR_LOG_MAX_STRING_LENGTH = 4000;
const STRICT_STRUCTURED_OUTPUT_INSTRUCTION = [
  "输出格式规则（必须严格遵守）：",
  "1. 只返回单个合法 JSON 对象。",
  "2. 回复的首字符必须是 {，最后一个字符必须是 }。",
  "3. 不要使用 ```、```json、Markdown、注释、前言、后记或任何解释性文字。",
  "4. 所有字段名必须与给定 schema 完全一致；不要新增字段。",
  "5. 即使某个字段内容不确定，也必须返回合法 JSON，并使用空字符串、空数组、false 或 null 等占位。",
].join("\n");
const providerCooldowns = new Map();
const providerConcurrencyStates = new Map();

class ProviderRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderRequestError";
    this.status = options.status;
    this.attempts = options.attempts;
    this.overloaded = Boolean(options.overloaded);
    this.elapsedMs = options.elapsedMs;
  }
}

function numericOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumericOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveRetryPolicy(options = {}) {
  const overloadBaseDelayMs = numericOption(options.overloadBaseDelayMs, DEFAULT_OVERLOAD_BASE_DELAY_MS);
  const overloadMaxDelayMs = Math.max(
    overloadBaseDelayMs,
    numericOption(options.overloadMaxDelayMs, DEFAULT_OVERLOAD_MAX_DELAY_MS),
  );

  return {
    requestTimeoutMs: numericOption(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    overloadRetryWindowMs: numericOption(options.overloadRetryWindowMs, DEFAULT_OVERLOAD_RETRY_WINDOW_MS),
    overloadBaseDelayMs,
    overloadMaxDelayMs,
    overloadJitterRatio: nonNegativeNumericOption(options.overloadJitterRatio, DEFAULT_OVERLOAD_JITTER_RATIO),
  };
}

function resolveMaxConcurrency({ providerId = "", providerBlock = {}, options = {} } = {}) {
  const explicit =
    options.maxConcurrency ??
    providerBlock.max_concurrency ??
    process.env.NOVELEX_PROVIDER_MAX_CONCURRENCY;

  const parsedExplicit = Number(explicit);
  if (Number.isFinite(parsedExplicit) && parsedExplicit > 0) {
    return Math.max(1, Math.round(parsedExplicit));
  }

  if (String(providerId || "").trim() === "MiniMax") {
    return DEFAULT_MINIMAX_MAX_CONCURRENCY;
  }

  return Infinity;
}

function resolveRequestTimeoutMs({ providerId = "", providerBlock = {}, options = {} } = {}) {
  const explicit =
    options.requestTimeoutMs ??
    providerBlock.request_timeout_ms ??
    process.env.NOVELEX_PROVIDER_REQUEST_TIMEOUT_MS;

  const parsedExplicit = Number(explicit);
  if (Number.isFinite(parsedExplicit) && parsedExplicit > 0) {
    return Math.max(1, Math.round(parsedExplicit));
  }

  if (String(providerId || "").trim() === "MiniMax") {
    return 300000;
  }

  return DEFAULT_REQUEST_TIMEOUT_MS;
}

function resolveOverloadRetryWindowMs({ providerId = "", providerBlock = {}, options = {} } = {}) {
  const explicit =
    options.overloadRetryWindowMs ??
    providerBlock.overload_retry_window_ms ??
    process.env.NOVELEX_PROVIDER_OVERLOAD_RETRY_WINDOW_MS;

  const parsedExplicit = Number(explicit);
  if (Number.isFinite(parsedExplicit) && parsedExplicit > 0) {
    return Math.max(1, Math.round(parsedExplicit));
  }

  if (String(providerId || "").trim() === "MiniMax") {
    return 30 * 60 * 1000;
  }

  return DEFAULT_OVERLOAD_RETRY_WINDOW_MS;
}

function resolveOverloadBaseDelayMs({ providerBlock = {}, options = {} } = {}) {
  const explicit =
    options.overloadBaseDelayMs ??
    providerBlock.overload_base_delay_ms ??
    process.env.NOVELEX_PROVIDER_OVERLOAD_BASE_DELAY_MS;
  return numericOption(explicit, DEFAULT_OVERLOAD_BASE_DELAY_MS);
}

function resolveOverloadMaxDelayMs({ providerBlock = {}, options = {}, overloadBaseDelayMs } = {}) {
  const explicit =
    options.overloadMaxDelayMs ??
    providerBlock.overload_max_delay_ms ??
    process.env.NOVELEX_PROVIDER_OVERLOAD_MAX_DELAY_MS;
  return Math.max(overloadBaseDelayMs, numericOption(explicit, DEFAULT_OVERLOAD_MAX_DELAY_MS));
}

function resolveOverloadJitterRatio({ providerBlock = {}, options = {} } = {}) {
  const explicit =
    options.overloadJitterRatio ??
    providerBlock.overload_jitter_ratio ??
    process.env.NOVELEX_PROVIDER_OVERLOAD_JITTER_RATIO;
  return nonNegativeNumericOption(explicit, DEFAULT_OVERLOAD_JITTER_RATIO);
}

function roleToInputRole(role) {
  if (role === "assistant") {
    return "assistant";
  }
  return "user";
}

function roleToChatRole(role) {
  if (role === "assistant" || role === "system" || role === "tool") {
    return role;
  }
  return "user";
}

function stringifyInput(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!item || typeof item !== "object") {
          return String(item || "");
        }
        if (typeof item.text === "string") {
          return item.text;
        }
        if (typeof item.content === "string") {
          return item.content;
        }
        return JSON.stringify(item, null, 2);
      })
      .filter(Boolean)
      .join("\n\n");
  }

  if (value && typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }

  return String(value || "");
}

function trimLogString(value, maxLength = PROVIDER_ERROR_LOG_MAX_STRING_LENGTH) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 15))}...[truncated]`;
}

function sanitizeForErrorLog(value, depth = 0) {
  if (depth >= PROVIDER_ERROR_LOG_MAX_DEPTH) {
    return "[truncated_depth]";
  }

  if (typeof value === "string") {
    return trimLogString(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, PROVIDER_ERROR_LOG_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeForErrorLog(item, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: trimLogString(value.message),
      stack: trimLogString(value.stack || ""),
    };
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, PROVIDER_ERROR_LOG_MAX_OBJECT_KEYS)
        .map(([key, entryValue]) => [key, sanitizeForErrorLog(entryValue, depth + 1)]),
    );
  }

  return trimLogString(String(value));
}

function summarizeMessagesForErrorLog(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .slice(0, PROVIDER_ERROR_LOG_MAX_ARRAY_ITEMS)
    .map((message) => ({
      role: String(message?.role || "user"),
      content: trimLogString(stringifyInput(message?.content || "")),
    }));
}

function buildProviderErrorLogEntry({
  url,
  payload,
  providerName,
  providerKey,
  attempt,
  responseStatus,
  errorText,
  error,
  errorLogContext = {},
}) {
  return {
    timestamp: new Date().toISOString(),
    provider: {
      id: errorLogContext.providerId || "",
      name: providerName,
      key: providerKey,
      apiStyle: errorLogContext.apiStyle || "",
      slotName: errorLogContext.slotName || "",
      model: String(payload?.model || errorLogContext.model || "").trim(),
      url,
    },
    agent: {
      feature: String(errorLogContext.metadata?.feature || "").trim(),
      chapterId: String(errorLogContext.metadata?.chapterId || "").trim(),
      complexity: String(errorLogContext.agentComplexity || "").trim(),
    },
    request: {
      instructions: trimLogString(errorLogContext.instructions || ""),
      input: trimLogString(stringifyInput(errorLogContext.input || "")),
      messages: summarizeMessagesForErrorLog(errorLogContext.messages),
      tools: sanitizeForErrorLog(payload?.tools || errorLogContext.tools || []),
      toolChoice: String(payload?.tool_choice || errorLogContext.toolChoice || "").trim(),
      include: sanitizeForErrorLog(payload?.include || errorLogContext.include || []),
      payload: sanitizeForErrorLog(payload),
    },
    error: {
      status: responseStatus ?? error?.status ?? null,
      attempts: attempt ?? error?.attempts ?? null,
      message: trimLogString(errorText || error?.message || ""),
      responseText: trimLogString(errorText || ""),
      details: sanitizeForErrorLog(error),
    },
  };
}

async function appendProviderErrorLog(rootDir, entry) {
  if (!rootDir || !entry) {
    return;
  }

  try {
    const logPath = path.join(rootDir, "runtime", PROVIDER_ERROR_LOG_FILENAME);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Logging failures should never mask the original provider error.
  }
}

async function logProviderRequestFailure({
  rootDir,
  url,
  payload,
  providerName,
  providerKey,
  attempt,
  responseStatus,
  errorText,
  error,
  errorLogContext,
}) {
  await appendProviderErrorLog(
    rootDir,
    buildProviderErrorLogEntry({
      url,
      payload,
      providerName,
      providerKey,
      attempt,
      responseStatus,
      errorText,
      error,
      errorLogContext,
    }),
  );
}

function normalizeMessages({ input, messages }) {
  if (Array.isArray(messages) && messages.length) {
    return messages.map((message) => ({
      role: roleToInputRole(message.role),
      content: [
        {
          type: "input_text",
          text: String(message.content || ""),
        },
      ],
    }));
  }

  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: stringifyInput(input),
        },
      ],
    },
  ];
}

function normalizeChatContent(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!item || typeof item !== "object") {
          return String(item || "");
        }
        if (typeof item.text === "string") {
          return item.text;
        }
        if (typeof item.content === "string") {
          return item.content;
        }
        return JSON.stringify(item, null, 2);
      })
      .filter(Boolean)
      .join("\n\n");
  }

  if (value && typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
    return JSON.stringify(value, null, 2);
  }

  return String(value || "");
}

function normalizeChatMessages({ instructions, input, messages }) {
  const normalized = [];

  if (String(instructions || "").trim()) {
    normalized.push({
      role: "system",
      content: String(instructions || ""),
    });
  }

  if (Array.isArray(messages) && messages.length) {
    normalized.push(
      ...messages.map((message) => ({
        role: roleToChatRole(message.role),
        content: normalizeChatContent(message.content),
      })),
    );
    return normalized;
  }

  normalized.push({
    role: "user",
    content: stringifyInput(input),
  });

  return normalized;
}

function looksLikeStrictStructuredOutput({ instructions, input, messages, metadata } = {}) {
  if (metadata?.strictStructuredOutput === true) {
    return true;
  }
  if (metadata?.strictStructuredOutput === false) {
    return false;
  }

  const instructionText = String(instructions || "");
  if (/只输出 JSON(?: 对象)?/u.test(instructionText) || /请输出 JSON/u.test(instructionText)) {
    return true;
  }

  if (Array.isArray(messages) && messages.some((message) => {
    const text = stringifyInput(message?.content || "");
    return /只输出 JSON(?: 对象)?/u.test(text) || /请输出 JSON/u.test(text);
  })) {
    return true;
  }

  const inputText = stringifyInput(input);
  return /只输出 JSON(?: 对象)?/u.test(inputText) || /请输出 JSON/u.test(inputText);
}

function strengthenStructuredOutputInstructions(instructions, options = {}) {
  const base = String(instructions || "").trim();
  if (!looksLikeStrictStructuredOutput({ ...options, instructions: base })) {
    return base;
  }
  if (base.includes("输出格式规则（必须严格遵守）")) {
    return base;
  }
  return [base, STRICT_STRUCTURED_OUTPUT_INSTRUCTION].filter(Boolean).join("\n\n");
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const texts = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        texts.push(content.text.trim());
      }
    }
  }
  return texts.join("\n\n").trim();
}

function stripAssistantThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .trim();
}

function extractChatContentText(content) {
  if (typeof content === "string") {
    return stripAssistantThinking(content);
  }
  if (Array.isArray(content)) {
    return stripAssistantThinking(
      content
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }
          if (typeof item?.text === "string") {
            return item.text;
          }
          if (typeof item?.content === "string") {
            return item.content;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  if (typeof content?.text === "string") {
    return stripAssistantThinking(content.text);
  }
  return "";
}

function extractChatCompletionText(payload) {
  return extractChatContentText(payload?.choices?.[0]?.message?.content);
}

function hasOnlyWebSearchTools(tools = []) {
  return Array.isArray(tools) && tools.length > 0 && tools.every((tool) => tool?.type === "web_search");
}

function visitJsonTree(node, visitor, visited = new WeakSet()) {
  if (!node) {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item) => visitJsonTree(item, visitor, visited));
    return;
  }
  if (typeof node !== "object") {
    return;
  }
  if (visited.has(node)) {
    return;
  }
  visited.add(node);

  visitor(node);
  for (const value of Object.values(node)) {
    visitJsonTree(value, visitor, visited);
  }
}

function hasMiniMaxWebSearchToolCall(raw) {
  let matched = false;

  visitJsonTree(raw, (node) => {
    if (matched || !Array.isArray(node?.tool_calls)) {
      return;
    }
    matched = node.tool_calls.some((toolCall) => /web_search/i.test(String(toolCall?.function?.name || "")));
  });

  return matched;
}

function normalizeSseBuffer(buffer) {
  return String(buffer || "").replace(/\r\n/g, "\n");
}

async function cancelReaderQuietly(reader) {
  if (!reader) {
    return;
  }

  try {
    await reader.cancel();
  } catch {
    // Some proxy streams never close cleanly; best-effort cancellation is enough here.
  }
}

async function parseChatCompletionEventStream(response) {
  if (!response.body) {
    throw new Error("chat completion stream response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedText = "";
  let finalPayload = null;
  let streamError = null;
  let sawTerminalEvent = false;

  function appendDeltaContent(delta) {
    if (typeof delta?.content === "string") {
      accumulatedText += delta.content;
      return;
    }

    if (Array.isArray(delta?.content)) {
      for (const part of delta.content) {
        if (typeof part === "string") {
          accumulatedText += part;
          continue;
        }
        if (typeof part?.text === "string") {
          accumulatedText += part.text;
        }
      }
    }
  }

  function processChunk(chunk) {
    const lines = chunk.split("\n");
    const dataLines = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    const data = dataLines.join("\n").trim();
    if (!data) {
      return;
    }

    if (data === "[DONE]") {
      sawTerminalEvent = true;
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    if (payload?.error) {
      streamError = payload.error?.message || payload.error?.type || data;
      sawTerminalEvent = true;
      return;
    }

    if (Array.isArray(payload?.choices) && payload.choices.length) {
      appendDeltaContent(payload.choices[0]?.delta);
      if (payload.choices.some((choice) => choice?.finish_reason)) {
        sawTerminalEvent = true;
      }
    }

    if (payload?.id && Array.isArray(payload?.choices)) {
      finalPayload = payload;
    }
  }

  readLoop: while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer = normalizeSseBuffer(buffer + decoder.decode());
      break;
    }

    buffer = normalizeSseBuffer(buffer + decoder.decode(value, { stream: true }));
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const eventBlock = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      processChunk(eventBlock);
      if (streamError || sawTerminalEvent) {
        await cancelReaderQuietly(reader);
        buffer = "";
        break readLoop;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (!streamError && !sawTerminalEvent && buffer.trim()) {
    processChunk(buffer);
  }

  if (streamError) {
    throw new Error(`chat completion stream failed: ${streamError}`);
  }

  if (finalPayload) {
    const currentContent = extractChatContentText(finalPayload?.choices?.[0]?.message?.content);
    if (!currentContent && accumulatedText.trim()) {
      finalPayload.choices[0].message = {
        role: "assistant",
        content: accumulatedText.trim(),
      };
    }
    return finalPayload;
  }

  return {
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: accumulatedText.trim(),
        },
      },
    ],
  };
}

async function wait(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function providerCircuitKey(settings = {}) {
  return `${String(settings.providerId || settings.providerName || "provider").trim()}:${String(settings.baseUrl || "").trim()}`;
}

async function waitForProviderCooldown(providerKey) {
  const key = String(providerKey || "").trim();
  if (!key) {
    return;
  }

  const cooldownUntil = Number(providerCooldowns.get(key) || 0);
  if (!cooldownUntil) {
    return;
  }

  const remainingMs = cooldownUntil - Date.now();
  if (remainingMs <= 0) {
    providerCooldowns.delete(key);
    return;
  }

  await wait(remainingMs);
}

function scheduleProviderCooldown(providerKey, delayMs) {
  const key = String(providerKey || "").trim();
  const normalizedDelayMs = Math.max(0, Math.round(Number(delayMs) || 0));
  if (!key || !normalizedDelayMs) {
    return;
  }

  const nextAllowedAt = Date.now() + normalizedDelayMs;
  providerCooldowns.set(key, Math.max(Number(providerCooldowns.get(key) || 0), nextAllowedAt));
}

function getProviderConcurrencyState(providerKey, maxConcurrency = Infinity) {
  const key = String(providerKey || "").trim();
  if (!providerConcurrencyStates.has(key)) {
    providerConcurrencyStates.set(key, {
      active: 0,
      waiters: [],
      maxConcurrency,
    });
  }

  const state = providerConcurrencyStates.get(key);
  if (Number.isFinite(maxConcurrency) && maxConcurrency > 0) {
    state.maxConcurrency = Math.max(1, Math.round(maxConcurrency));
  } else {
    state.maxConcurrency = Infinity;
  }
  return state;
}

async function acquireProviderSlot(providerKey, maxConcurrency = Infinity) {
  if (!String(providerKey || "").trim() || !Number.isFinite(maxConcurrency)) {
    return () => {};
  }

  const state = getProviderConcurrencyState(providerKey, maxConcurrency);
  if (state.active < state.maxConcurrency) {
    state.active += 1;
    return () => releaseProviderSlot(providerKey);
  }

  await new Promise((resolve) => {
    state.waiters.push(resolve);
  });

  state.active += 1;
  return () => releaseProviderSlot(providerKey);
}

function releaseProviderSlot(providerKey) {
  const key = String(providerKey || "").trim();
  if (!key || !providerConcurrencyStates.has(key)) {
    return;
  }

  const state = providerConcurrencyStates.get(key);
  state.active = Math.max(0, state.active - 1);

  if (state.waiters.length) {
    const next = state.waiters.shift();
    next();
    return;
  }

  if (state.active === 0) {
    providerConcurrencyStates.delete(key);
  }
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

function reconnectDelayMs(attempt) {
  return 250 * 2 ** (attempt - 1);
}

function overloadDelayMs(attempt, retryPolicy = {}) {
  const baseDelayMs = Math.min(
    Number(retryPolicy.overloadMaxDelayMs || DEFAULT_OVERLOAD_MAX_DELAY_MS),
    Number(retryPolicy.overloadBaseDelayMs || DEFAULT_OVERLOAD_BASE_DELAY_MS) * 2 ** Math.max(0, attempt - 1),
  );
  const jitterRatio = Math.max(0, Number(retryPolicy.overloadJitterRatio || 0));
  if (!jitterRatio) {
    return Math.max(1, Math.round(baseDelayMs));
  }

  const minMultiplier = Math.max(0, 1 - jitterRatio);
  const maxMultiplier = 1 + jitterRatio;
  const multiplier = minMultiplier + (Math.random() * (maxMultiplier - minMultiplier));
  return Math.max(1, Math.round(baseDelayMs * multiplier));
}

function safeJsonParse(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}

function payloadLooksOverloaded(payload) {
  let matched = false;

  visitJsonTree(payload, (node) => {
    if (matched || !node || typeof node !== "object") {
      return;
    }

    if (String(node.type || "").trim() === "overloaded_error") {
      matched = true;
      return;
    }

    if (String(node.http_code || "").trim() === "529") {
      matched = true;
      return;
    }

    const message = String(node.message || node.error_message || "").trim();
    if (/overloaded_error|当前时段请求拥挤/i.test(message)) {
      matched = true;
    }
  });

  return matched;
}

function isOverloadResponse(status, errorText = "") {
  if (Number(status) === 529) {
    return true;
  }

  const text = String(errorText || "");
  if (/overloaded_error|当前时段请求拥挤/i.test(text)) {
    return true;
  }

  return payloadLooksOverloaded(safeJsonParse(text));
}

function isOverloadError(error) {
  if (error instanceof ProviderRequestError) {
    return error.overloaded || isOverloadResponse(error.status, error.message);
  }

  const message = error instanceof Error ? error.message : String(error || "");
  return /overloaded_error|当前时段请求拥挤|\b529\b/i.test(message);
}

function shouldContinueOverloadRetry({
  startedAt,
  overloadAttempt,
  providerKey,
  retryPolicy,
}) {
  const delayMs = overloadDelayMs(overloadAttempt, retryPolicy);
  const elapsedMs = Date.now() - startedAt;
  const withinWindow = elapsedMs + delayMs <= Number(retryPolicy.overloadRetryWindowMs || DEFAULT_OVERLOAD_RETRY_WINDOW_MS);

  if (withinWindow) {
    scheduleProviderCooldown(providerKey, delayMs);
  }

  return {
    delayMs,
    elapsedMs,
    withinWindow,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function shouldForceStream(settings) {
  return Boolean(
    settings.forceStream ||
    /capi\.quan2go\.com/i.test(settings.baseUrl || ""),
  );
}

function prefersCodexProxyCompatibility(settings) {
  return /capi\.quan2go\.com/i.test(settings.baseUrl || "");
}

function buildCompatibleResponsePayload(basePayload, settings) {
  const payload = {
    ...basePayload,
  };

  if (prefersCodexProxyCompatibility(settings)) {
    delete payload.metadata;
    delete payload.stream_options;
  }

  return payload;
}

async function parseResponseEventStream(response) {
  if (!response.body) {
    throw new Error("stream response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedText = "";
  let finalPayload = null;
  let streamError = null;
  let sawTerminalEvent = false;
  const structuredStreamEvents = [];
  const streamedOutputItems = [];

  function rememberStructuredEvent(payload, type) {
    // Keep the low-volume structural events so downstream code can still inspect
    // tool calls or citations even when the proxy omits them from response.completed.
    if (type === "response.output_text.delta" || type === "response.created" || type === "response.completed") {
      return;
    }
    structuredStreamEvents.push(JSON.parse(JSON.stringify(payload)));
  }

  function rememberOutputItem(payload, type) {
    if (
      (type !== "response.output_item.added" && type !== "response.output_item.done") ||
      !payload?.item ||
      typeof payload.item !== "object"
    ) {
      return;
    }

    const outputIndex = Number(payload.output_index);
    if (Number.isInteger(outputIndex) && outputIndex >= 0) {
      streamedOutputItems[outputIndex] = payload.item;
      return;
    }

    streamedOutputItems.push(payload.item);
  }

  function processChunk(chunk) {
    const lines = chunk.split("\n");
    let eventName = "";
    const dataLines = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    const data = dataLines.join("\n").trim();
    if (!data) {
      return;
    }

    if (data === "[DONE]") {
      sawTerminalEvent = true;
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    const type = payload?.type || eventName;
    rememberStructuredEvent(payload, type);
    rememberOutputItem(payload, type);

    if (type === "response.output_text.delta" && typeof payload.delta === "string") {
      accumulatedText += payload.delta;
      return;
    }

    if (type === "response.output_text.done" && typeof payload.text === "string" && !accumulatedText) {
      accumulatedText = payload.text;
      return;
    }

    if (type === "response.completed" || payload?.response?.status === "completed") {
      sawTerminalEvent = true;
      if (payload.response) {
        finalPayload = payload.response;
      }
      return;
    }

    if (type === "response.failed" || payload?.response?.status === "failed") {
      sawTerminalEvent = true;
      streamError =
        payload.response?.error?.message ||
        payload.response?.error?.type ||
        payload.error?.message ||
        payload.message ||
        data;
      return;
    }

    if (type === "error" || payload.error) {
      streamError = payload.error?.message || payload.message || data;
      sawTerminalEvent = true;
    }
  }

  readLoop: while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer = normalizeSseBuffer(buffer + decoder.decode());
      break;
    }

    buffer = normalizeSseBuffer(buffer + decoder.decode(value, { stream: true }));
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const eventBlock = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      processChunk(eventBlock);
      if (streamError || sawTerminalEvent) {
        await cancelReaderQuietly(reader);
        buffer = "";
        break readLoop;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (!streamError && !sawTerminalEvent && buffer.trim()) {
    processChunk(buffer);
  }

  if (streamError) {
    throw new Error(`stream failed: ${streamError}`);
  }

  if (finalPayload) {
    if (accumulatedText.trim() && !String(finalPayload.output_text || "").trim()) {
      finalPayload.output_text = accumulatedText.trim();
    }
    if (
      streamedOutputItems.length &&
      (!Array.isArray(finalPayload.output) || !finalPayload.output.length)
    ) {
      finalPayload.output = streamedOutputItems.filter(Boolean);
    }
    if (
      accumulatedText.trim() &&
      (!Array.isArray(finalPayload.output) || !finalPayload.output.length)
    ) {
      finalPayload.output = [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: accumulatedText.trim(),
            },
          ],
        },
      ];
    }
    if (structuredStreamEvents.length) {
      finalPayload.stream_events = structuredStreamEvents;
    }
    return finalPayload;
  }

  return {
    output_text: accumulatedText.trim(),
    output: streamedOutputItems.length
      ? streamedOutputItems.filter(Boolean)
      : accumulatedText.trim()
        ? [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: accumulatedText.trim(),
                },
              ],
            },
          ]
        : [],
    ...(structuredStreamEvents.length ? { stream_events: structuredStreamEvents } : {}),
  };
}

async function requestProviderJson({
  url,
  apiKey,
  payload,
  providerName,
  providerKey = "",
  maxConcurrency = Infinity,
  retryPolicy = resolveRetryPolicy(),
  streamFallbackAllowed = true,
  parseStream = null,
  errorLogContext = {},
}) {
  let activePayload = payload;
  const startedAt = Date.now();
  let overloadAttempt = 0;
  let attempt = 0;
  const logRootDir = String(errorLogContext.rootDir || process.cwd()).trim() || process.cwd();

  while (true) {
    attempt += 1;
    await waitForProviderCooldown(providerKey);
    const wantsStream = Boolean(activePayload?.stream);
    const releaseSlot = await acquireProviderSlot(providerKey, maxConcurrency);

    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(wantsStream ? { Accept: "text/event-stream" } : {}),
        },
        body: JSON.stringify(activePayload),
      }, retryPolicy.requestTimeoutMs);

      if (!response.ok) {
        const errorText = await response.text();
        if (
          streamFallbackAllowed &&
          parseStream &&
          !wantsStream &&
          response.status === 400 &&
          /only support stream/i.test(errorText)
        ) {
          activePayload = {
            ...activePayload,
            stream: true,
            stream_options: {
              include_obfuscation: false,
            },
          };
          continue;
        }

        if (isOverloadResponse(response.status, errorText)) {
          overloadAttempt += 1;
          const overloadState = shouldContinueOverloadRetry({
            startedAt,
            overloadAttempt,
            providerKey,
            retryPolicy,
          });
          if (overloadState.withinWindow) {
            continue;
          }

          await logProviderRequestFailure({
            rootDir: logRootDir,
            url,
            payload: activePayload,
            providerName,
            providerKey,
            attempt,
            responseStatus: response.status,
            errorText,
            errorLogContext,
          });

          throw new ProviderRequestError(
            `${providerName} request failed after ${attempt} attempts: ${response.status} ${errorText}`,
            {
              status: response.status,
              attempts: attempt,
              overloaded: true,
              elapsedMs: overloadState.elapsedMs,
            },
          );
        }

        if (attempt < MAX_RECONNECT_ATTEMPTS && isRetryableStatus(response.status)) {
          await wait(reconnectDelayMs(attempt));
          continue;
        }

        await logProviderRequestFailure({
          rootDir: logRootDir,
          url,
          payload: activePayload,
          providerName,
          providerKey,
          attempt,
          responseStatus: response.status,
          errorText,
          errorLogContext,
        });

        throw new ProviderRequestError(
          `${providerName} request failed after ${attempt} attempts: ${response.status} ${errorText}`,
          {
            status: response.status,
            attempts: attempt,
          },
        );
      }

      const contentType = response.headers.get("content-type") || "";
      if (parseStream && (wantsStream || /text\/event-stream/i.test(contentType))) {
        try {
          return await parseStream(response);
        } catch (error) {
          if (isOverloadError(error)) {
            overloadAttempt += 1;
            const overloadState = shouldContinueOverloadRetry({
              startedAt,
              overloadAttempt,
              providerKey,
              retryPolicy,
            });
            if (overloadState.withinWindow) {
              continue;
            }

            const message = error instanceof Error ? error.message : String(error || "");
            await logProviderRequestFailure({
              rootDir: logRootDir,
              url,
              payload: activePayload,
              providerName,
              providerKey,
              attempt,
              errorText: message,
              error,
              errorLogContext,
            });
            throw new ProviderRequestError(
              `${providerName} request failed after ${attempt} attempts: ${message}`,
              {
                attempts: attempt,
                overloaded: true,
                elapsedMs: overloadState.elapsedMs,
              },
            );
          }

          if (attempt < MAX_RECONNECT_ATTEMPTS) {
            await wait(reconnectDelayMs(attempt));
            continue;
          }
          await logProviderRequestFailure({
            rootDir: logRootDir,
            url,
            payload: activePayload,
            providerName,
            providerKey,
            attempt,
            error,
            errorLogContext,
          });
          throw error;
        }
      }

      return response.json();
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        throw error;
      }

      if (isOverloadError(error)) {
        overloadAttempt += 1;
        const overloadState = shouldContinueOverloadRetry({
          startedAt,
          overloadAttempt,
          providerKey,
          retryPolicy,
        });
        if (overloadState.withinWindow) {
          continue;
        }

        const message = error instanceof Error ? error.message : String(error || "");
        await logProviderRequestFailure({
          rootDir: logRootDir,
          url,
          payload: activePayload,
          providerName,
          providerKey,
          attempt,
          errorText: message,
          error,
          errorLogContext,
        });
        throw new ProviderRequestError(
          `${providerName} request failed after ${attempt} attempts: ${message}`,
          {
            attempts: attempt,
            overloaded: true,
            elapsedMs: overloadState.elapsedMs,
          },
        );
      }

      if (attempt < MAX_RECONNECT_ATTEMPTS) {
        await wait(reconnectDelayMs(attempt));
        continue;
      }

      const message = error instanceof Error ? error.message : String(error || "");
      await logProviderRequestFailure({
        rootDir: logRootDir,
        url,
        payload: activePayload,
        providerName,
        providerKey,
        attempt,
        errorText: message,
        error,
        errorLogContext,
      });
      throw new ProviderRequestError(
        `${providerName} request failed after ${attempt} attempts: ${message}`,
        {
          attempts: attempt,
        },
      );
    } finally {
      releaseSlot();
    }
  }
}

function shouldRetryWithLeanResponsePayload(error, payload) {
  const hasOptionalPayload =
    Boolean(payload.metadata) ||
    Boolean(payload.stream_options) ||
    Boolean(payload.reasoning) ||
    payload.store !== undefined;

  if (!hasOptionalPayload) {
    return false;
  }

  if (error instanceof ProviderRequestError) {
    return !error.overloaded && typeof error.status === "number" && error.status >= 500;
  }

  const message = error instanceof Error ? error.message : String(error || "");
  return !isOverloadError(error) && /request failed(?: after \d+ attempts)?:.*\b5\d{2}\b/i.test(message);
}

function buildLeanResponseRetryPayload(payload) {
  const leanPayload = {
    model: payload.model,
    instructions: payload.instructions,
    input: payload.input,
    ...(payload.stream ? { stream: true } : {}),
  };

  if (Array.isArray(payload.tools) && payload.tools.length) {
    leanPayload.tools = payload.tools;
  }
  if (payload.tool_choice) {
    leanPayload.tool_choice = payload.tool_choice;
  }
  if (Array.isArray(payload.include) && payload.include.length) {
    leanPayload.include = payload.include;
  }

  return leanPayload;
}

function shouldRetryWithoutTemperature(error) {
  if (error instanceof ProviderRequestError && error.status !== 400) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error || "");
  return /\btemperature\b/i.test(message) && /(unsupported|not support|unknown|invalid|unrecognized|does not allow|not allowed|not permitted)/i.test(message);
}

function modeForWireApi(wireApi) {
  if (wireApi === "responses") {
    return "openai-responses";
  }
  if (wireApi === "chat_completions") {
    return "openai-chat-completions";
  }
  return "unavailable";
}

function resolveConfiguredProviderId({ codexConfig, providerConfig, providerIdOverride }) {
  return String(
    providerIdOverride ||
    codexConfig.data?.model_provider ||
    providerConfig.providerName ||
    "OpenAI",
  ).trim() || "OpenAI";
}

function buildScopedConfigData(rawData = {}, providerId) {
  const normalized = normalizeCodexConfigData(rawData);
  const activeProviderId = normalized.model_providers?.[providerId]
    ? providerId
    : String(normalized.model_provider || "OpenAI").trim() || "OpenAI";
  const providerBlock =
    normalized.model_providers?.[activeProviderId] ||
    normalized.model_providers?.OpenAI ||
    {};

  return {
    ...normalized,
    model_provider: activeProviderId,
    model:
      String(providerBlock.response_model || providerBlock.model || normalized.model || "").trim() ||
      normalized.model,
    review_model:
      String(providerBlock.review_model || providerBlock.response_model || normalized.review_model || "").trim() ||
      normalized.review_model,
    codex_model:
      String(providerBlock.codex_model || providerBlock.response_model || normalized.codex_model || "").trim() ||
      normalized.codex_model,
  };
}

function providerSpecificFileApiKeys(providerId, fileData = {}) {
  const candidates = [];
  if (providerId === "OpenAI") {
    candidates.push(fileData.openai_api_key);
  }
  return candidates;
}

function defaultEnvApiKeyNames(providerId) {
  if (providerId === "OpenAI") {
    return ["OPENAI_API_KEY"];
  }
  if (providerId === "Gemini") {
    return ["GEMINI_API_KEY", "NOVAI_API_KEY"];
  }
  return [`${String(providerId || "").toUpperCase()}_API_KEY`];
}

function defaultEnvBaseUrlNames(providerId) {
  if (providerId === "OpenAI") {
    return ["OPENAI_BASE_URL"];
  }
  if (providerId === "Gemini") {
    return ["GEMINI_BASE_URL", "NOVAI_BASE_URL"];
  }
  return [`${String(providerId || "").toUpperCase()}_BASE_URL`];
}

function resolveEnvValue(names = []) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function resolveProviderApiKey({
  providerId,
  providerBlock = {},
  fileData = {},
  useRootFallback = false,
}) {
  const envNames = String(providerBlock.env_api_key || "").trim()
    ? [String(providerBlock.env_api_key || "").trim()]
    : defaultEnvApiKeyNames(providerId);

  const candidates = [
    providerBlock.api_key,
    ...providerSpecificFileApiKeys(providerId, fileData),
    ...(useRootFallback ? [fileData.api_key] : []),
    resolveEnvValue(envNames),
  ];

  return String(candidates.find((value) => String(value || "").trim()) || "").trim();
}

function resolveProviderBaseUrl({ providerId, providerBlock = {} }) {
  const envNames = String(providerBlock.env_base_url || "").trim()
    ? [String(providerBlock.env_base_url || "").trim()]
    : defaultEnvBaseUrlNames(providerId);
  return String(providerBlock.base_url || resolveEnvValue(envNames) || "")
    .trim()
    .replace(/\/$/, "");
}

function buildAvailableProviders({
  fileData,
  providerConfig,
  activeProviderId,
  preferFileValues = false,
}) {
  return Object.entries(fileData.model_providers || {}).map(([providerId, block]) => {
    const isActive = providerId === activeProviderId;
    const activeResponseModel = preferFileValues
      ? fileData.model || providerConfig.responseModel
      : providerConfig.responseModel || fileData.model;
    const activeReviewModel = preferFileValues
      ? fileData.review_model || providerConfig.reviewModel
      : providerConfig.reviewModel || fileData.review_model;
    const activeCodexModel = preferFileValues
      ? fileData.codex_model || providerConfig.codexResponseModel
      : providerConfig.codexResponseModel || fileData.codex_model;
    const responseModel = String(
      (
        isActive
          ? activeResponseModel
          : block.response_model || block.model
      ) ||
      block.response_model ||
      block.model ||
      providerConfig.responseModel ||
      "",
    ).trim();
    const reviewModel = String(
      (
        isActive
          ? activeReviewModel
          : block.review_model
      ) ||
      block.review_model ||
      block.response_model ||
      responseModel ||
      providerConfig.reviewModel ||
      "",
    ).trim();
    const codexResponseModel = String(
      (
        isActive
          ? activeCodexModel
          : block.codex_model
      ) ||
      block.codex_model ||
      block.response_model ||
      responseModel ||
      providerConfig.codexResponseModel ||
      "",
    ).trim();

    return {
      id: providerId,
      name: String(block.name || providerId).trim() || providerId,
      wireApi: String(block.wire_api || "responses").trim() || "responses",
      baseUrl: resolveProviderBaseUrl({ providerId, providerBlock: block }),
      responseModel,
      reviewModel,
      codexResponseModel,
      hasApiKey: Boolean(
        resolveProviderApiKey({
          providerId,
          providerBlock: block,
          fileData,
          useRootFallback: isActive,
        }),
      ),
    };
  });
}

function resolveWebSearchModel(settings) {
  return /^gpt-/i.test(String(settings.responseModel || "").trim())
    ? settings.responseModel
    : "gpt-5.4";
}

function providerSupportsNativeWebSearch(settings) {
  return settings.providerId === "MiniMax";
}

function resolveSingleProviderSettings(projectState, rootDir = process.cwd(), options = {}) {
  const codexConfig = loadCodexApiConfig(rootDir);
  const providerConfig = {
    ...(projectState?.providerConfig || {}),
  };
  const preferFileValues = Boolean(codexConfig.exists && !codexConfig.error);
  const requestedProviderId = resolveConfiguredProviderId({
    codexConfig,
    providerConfig,
    providerIdOverride: options.providerIdOverride,
  });
  const fileData = buildScopedConfigData({
    model_provider: requestedProviderId,
    ...(codexConfig.data || {}),
  }, requestedProviderId);
  const activeProviderId =
    String(fileData.model_provider || providerConfig.providerName || "OpenAI").trim() || "OpenAI";
  const activeProviderBlock =
    fileData.model_providers?.[activeProviderId] ||
    fileData.model_providers?.OpenAI ||
    {};
  const availableProviders = buildAvailableProviders({
    fileData,
    providerConfig,
    activeProviderId,
    preferFileValues,
  });
  const activeProvider =
    availableProviders.find((item) => item.id === activeProviderId) ||
    availableProviders[0] ||
    null;

  const wireApi = String(activeProvider?.wireApi || activeProviderBlock.wire_api || "responses").trim() || "responses";
  const configuredMode = modeForWireApi(wireApi);
  const apiKey = resolveProviderApiKey({
    providerId: activeProviderId,
    providerBlock: activeProviderBlock,
    fileData,
    useRootFallback: true,
  });
  const requestTimeoutMs = resolveRequestTimeoutMs({
    providerId: activeProviderId,
    providerBlock: activeProviderBlock,
    options,
  });
  const overloadRetryWindowMs = resolveOverloadRetryWindowMs({
    providerId: activeProviderId,
    providerBlock: activeProviderBlock,
    options,
  });
  const overloadBaseDelayMs = resolveOverloadBaseDelayMs({
    providerBlock: activeProviderBlock,
    options,
  });
  const overloadMaxDelayMs = resolveOverloadMaxDelayMs({
    providerBlock: activeProviderBlock,
    options,
    overloadBaseDelayMs,
  });
  const overloadJitterRatio = resolveOverloadJitterRatio({
    providerBlock: activeProviderBlock,
    options,
  });
  const maxConcurrency = resolveMaxConcurrency({
    providerId: activeProviderId,
    providerBlock: activeProviderBlock,
    options,
  });
  const effectiveMode = configuredMode !== "unavailable" && apiKey ? configuredMode : "unavailable";

  return {
    configuredMode,
    effectiveMode,
    apiStyle: wireApi,
    hasApiKey: Boolean(apiKey),
    apiKey,
    baseUrl: String(activeProvider?.baseUrl || "").trim(),
    responseModel:
      String(activeProvider?.responseModel || providerConfig.responseModel || "gpt-5.4").trim() || "gpt-5.4",
    reviewModel:
      String(activeProvider?.reviewModel || providerConfig.reviewModel || "gpt-5.4").trim() || "gpt-5.4",
    codexResponseModel:
      String(activeProvider?.codexResponseModel || providerConfig.codexResponseModel || "gpt-5.3-codex").trim() || "gpt-5.3-codex",
    reasoningEffort:
      String(
        (preferFileValues
          ? fileData.model_reasoning_effort || providerConfig.reasoningEffort
          : providerConfig.reasoningEffort || fileData.model_reasoning_effort) ||
        "medium",
      ).trim() || "medium",
    disableResponseStorage:
      preferFileValues
        ? Boolean(fileData.disable_response_storage) || Boolean(providerConfig.disableResponseStorage)
        : Boolean(providerConfig.disableResponseStorage),
    forceStream:
      Boolean(fileData.force_stream) ||
      String(process.env.NOVELEX_FORCE_STREAM || "").trim() === "true" ||
      Boolean(providerConfig.forceStream),
    providerId: activeProviderId,
    providerName: String(activeProvider?.name || activeProviderId).trim() || activeProviderId,
    maxConcurrency,
    requestTimeoutMs,
    overloadRetryWindowMs,
    overloadBaseDelayMs,
    overloadMaxDelayMs,
    overloadJitterRatio,
    supportsNativeWebSearch: activeProviderId === "MiniMax",
    availableProviders,
    configSource: codexConfig.exists ? "codex_file" : "runtime_or_env",
    configPath: codexConfig.path,
    configError: codexConfig.error,
    configLoaded: codexConfig.exists && !codexConfig.error,
  };
}

function buildAgentModelRuntime(slotName, slotConfig, providerSettings) {
  return {
    slot: slotName,
    providerId: providerSettings.providerId,
    providerName: providerSettings.providerName,
    model: String(slotConfig?.model || providerSettings.responseModel || "").trim(),
    apiStyle: providerSettings.apiStyle,
    configuredMode: providerSettings.configuredMode,
    effectiveMode: providerSettings.effectiveMode,
    hasApiKey: providerSettings.hasApiKey,
    baseUrl: providerSettings.baseUrl,
    maxConcurrency: providerSettings.maxConcurrency,
    requestTimeoutMs: providerSettings.requestTimeoutMs,
    overloadRetryWindowMs: providerSettings.overloadRetryWindowMs,
    overloadBaseDelayMs: providerSettings.overloadBaseDelayMs,
    overloadMaxDelayMs: providerSettings.overloadMaxDelayMs,
    overloadJitterRatio: providerSettings.overloadJitterRatio,
    supportsNativeWebSearch: providerSettings.supportsNativeWebSearch,
  };
}

export function resolveProviderSettings(projectState, rootDir = process.cwd(), options = {}) {
  if (options.providerIdOverride) {
    return resolveSingleProviderSettings(projectState, rootDir, options);
  }

  const codexConfig = loadCodexApiConfig(rootDir);
  const providerConfig = {
    ...(projectState?.providerConfig || {}),
  };
  const fileData = normalizeCodexConfigData(codexConfig.data || {});
  const runtimeAgentModels = providerConfig.agentModels || {};
  const preferFileValues = Boolean(codexConfig.exists && !codexConfig.error);
  const primarySlotConfig = preferFileValues
    ? (fileData.agent_models?.primary || {
      provider: fileData.model_provider,
      model: fileData.model,
    })
    : {
      provider: String(runtimeAgentModels?.primary?.provider || providerConfig.providerName || "OpenAI").trim() || "OpenAI",
      model:
        String(runtimeAgentModels?.primary?.model || providerConfig.responseModel || fileData.model || "").trim() ||
        fileData.model,
    };
  const secondarySlotConfig = preferFileValues
    ? (fileData.agent_models?.secondary || {
      provider: primarySlotConfig.provider,
      model: fileData.review_model || primarySlotConfig.model,
    })
    : {
      provider: String(runtimeAgentModels?.secondary?.provider || primarySlotConfig.provider || "OpenAI").trim() || "OpenAI",
      model:
        String(runtimeAgentModels?.secondary?.model || providerConfig.reviewModel || primarySlotConfig.model || "").trim() ||
        primarySlotConfig.model,
    };
  const primarySettings = resolveSingleProviderSettings(projectState, rootDir, {
    ...options,
    providerIdOverride: primarySlotConfig.provider,
  });
  const secondarySettings = resolveSingleProviderSettings(projectState, rootDir, {
    ...options,
    providerIdOverride: secondarySlotConfig.provider,
  });
  const agentModels = {
    primary: buildAgentModelRuntime("primary", primarySlotConfig, primarySettings),
    secondary: buildAgentModelRuntime("secondary", secondarySlotConfig, secondarySettings),
  };

  return {
    ...primarySettings,
    responseModel: agentModels.primary.model,
    reviewModel: agentModels.primary.model,
    agentModels,
    agentRouting: {
      complex: "primary",
      simple: "secondary",
    },
    deprecatedCompatFields: [
      "providerId",
      "providerName",
      "configuredMode",
      "effectiveMode",
      "apiStyle",
      "baseUrl",
      "hasApiKey",
      "responseModel",
      "reviewModel",
    ],
  };
}

export function publicProviderSettings(settings) {
  return {
    configuredMode: settings.configuredMode,
    effectiveMode: settings.effectiveMode,
    apiStyle: settings.apiStyle,
    hasApiKey: settings.hasApiKey,
    baseUrl: settings.baseUrl,
    responseModel: settings.responseModel,
    reviewModel: settings.reviewModel,
    codexResponseModel: settings.codexResponseModel,
    reasoningEffort: settings.reasoningEffort,
    disableResponseStorage: settings.disableResponseStorage,
    forceStream: settings.forceStream,
    providerId: settings.providerId,
    providerName: settings.providerName,
    maxConcurrency: settings.maxConcurrency,
    requestTimeoutMs: settings.requestTimeoutMs,
    overloadRetryWindowMs: settings.overloadRetryWindowMs,
    overloadBaseDelayMs: settings.overloadBaseDelayMs,
    overloadMaxDelayMs: settings.overloadMaxDelayMs,
    overloadJitterRatio: settings.overloadJitterRatio,
    supportsNativeWebSearch: settings.supportsNativeWebSearch,
    availableProviders: settings.availableProviders,
    agentModels: settings.agentModels,
    agentRouting: settings.agentRouting,
    deprecatedCompatFields: settings.deprecatedCompatFields,
    configSource: settings.configSource,
    configPath: settings.configPath,
    configLoaded: settings.configLoaded,
    configError: settings.configError,
  };
}

function createSingleProviderClient(projectState, options = {}) {
  const outerOptions = options;
  const requestLogRootDir = String(options.rootDir || process.cwd()).trim() || process.cwd();
  const settings = resolveSingleProviderSettings(projectState, options.rootDir, {
    providerIdOverride: options.providerIdOverride,
    maxConcurrency: options.maxConcurrency,
    requestTimeoutMs: options.requestTimeoutMs,
    overloadRetryWindowMs: options.overloadRetryWindowMs,
    overloadBaseDelayMs: options.overloadBaseDelayMs,
    overloadMaxDelayMs: options.overloadMaxDelayMs,
    overloadJitterRatio: options.overloadJitterRatio,
  });
  const retryPolicy = resolveRetryPolicy({
    ...outerOptions,
    requestTimeoutMs: settings.requestTimeoutMs,
    overloadRetryWindowMs: settings.overloadRetryWindowMs,
    overloadBaseDelayMs: settings.overloadBaseDelayMs,
    overloadMaxDelayMs: settings.overloadMaxDelayMs,
    overloadJitterRatio: settings.overloadJitterRatio,
  });
  const providerKey = providerCircuitKey(settings);

  function pickModel({ useCodexModel = false, useReviewModel = false, model } = {}) {
    if (model) {
      return model;
    }
    if (useReviewModel) {
      return settings.reviewModel;
    }
    if (useCodexModel) {
      return settings.codexResponseModel;
    }
    return settings.responseModel;
  }

  async function executeResponsesRequest(payload, errorLogContext = {}) {
    try {
      return await requestProviderJson({
        url: `${settings.baseUrl}/responses`,
        apiKey: settings.apiKey,
        providerName: settings.providerName,
        providerKey,
        maxConcurrency: settings.maxConcurrency,
        retryPolicy,
        payload: buildCompatibleResponsePayload(payload, settings),
        errorLogContext,
        parseStream: parseResponseEventStream,
      });
    } catch (error) {
      if (!shouldRetryWithLeanResponsePayload(error, payload)) {
        throw error;
      }

      return requestProviderJson({
        url: `${settings.baseUrl}/responses`,
        apiKey: settings.apiKey,
        providerName: settings.providerName,
        providerKey,
        maxConcurrency: settings.maxConcurrency,
        retryPolicy,
        payload: buildLeanResponseRetryPayload(payload),
        errorLogContext,
        streamFallbackAllowed: false,
        parseStream: parseResponseEventStream,
      });
    }
  }

  async function generateWithResponses({
    instructions,
    input,
    messages,
    useCodexModel = false,
    useReviewModel = false,
    model,
    tools,
    toolChoice,
    include,
    reasoningEffort,
    metadata,
    temperature,
    agentComplexity,
    agentSlot,
  }) {
    const resolvedModel = pickModel({ useCodexModel, useReviewModel, model });
    const errorLogContext = {
      rootDir: requestLogRootDir,
      providerId: settings.providerId,
      apiStyle: settings.apiStyle,
      instructions,
      input,
      messages,
      tools,
      toolChoice,
      include,
      metadata,
      agentComplexity,
      slotName: agentSlot,
      model: resolvedModel,
    };
    const payload = {
      model: resolvedModel,
      instructions,
      input: normalizeMessages({ input, messages }),
      store: !settings.disableResponseStorage,
      reasoning: {
        effort: reasoningEffort || settings.reasoningEffort,
      },
      metadata,
    };

    if (Number.isFinite(Number(temperature))) {
      payload.temperature = Number(temperature);
    }

    if (Array.isArray(tools) && tools.length) {
      payload.tools = tools;
    }
    if (toolChoice) {
      payload.tool_choice = toolChoice;
    }
    if (Array.isArray(include) && include.length) {
      payload.include = include;
    }

    if (shouldForceStream(settings)) {
      payload.stream = true;
      if (!prefersCodexProxyCompatibility(settings)) {
        payload.stream_options = {
          include_obfuscation: false,
        };
      }
    }

    let response;
    try {
      response = await executeResponsesRequest(payload, errorLogContext);
    } catch (error) {
      if (!Object.prototype.hasOwnProperty.call(payload, "temperature") || !shouldRetryWithoutTemperature(error)) {
        throw error;
      }

      const payloadWithoutTemperature = {
        ...payload,
      };
      delete payloadWithoutTemperature.temperature;
      response = await executeResponsesRequest(payloadWithoutTemperature, errorLogContext);
    }

    return {
      mode: settings.effectiveMode,
      model: payload.model,
      text: extractResponseText(response),
      raw: response,
    };
  }

  async function executeChatCompletionsRequest(payload, errorLogContext = {}) {
    return requestProviderJson({
      url: `${settings.baseUrl}/chat/completions`,
      apiKey: settings.apiKey,
      providerName: settings.providerName,
      providerKey,
      maxConcurrency: settings.maxConcurrency,
      retryPolicy,
      payload,
      errorLogContext,
      streamFallbackAllowed: false,
      parseStream: payload.stream ? parseChatCompletionEventStream : null,
    });
  }

  function buildChatCompletionPayload({
    instructions,
    input,
    messages,
    useCodexModel = false,
    useReviewModel = false,
    model,
    temperature,
    tools,
    toolChoice,
    metadata,
    agentComplexity,
    agentSlot,
    extraBody = {},
  }) {
    const resolvedModel = pickModel({ useCodexModel, useReviewModel, model });
    const payload = {
      model: resolvedModel,
      messages: normalizeChatMessages({ instructions, input, messages }),
      ...(extraBody || {}),
    };

    if (Number.isFinite(Number(temperature))) {
      payload.temperature = Number(temperature);
    }
    if (Array.isArray(tools) && tools.length) {
      payload.tools = tools;
    }
    if (toolChoice) {
      payload.tool_choice = toolChoice;
    }

    return {
      payload,
      errorLogContext: {
        rootDir: requestLogRootDir,
        providerId: settings.providerId,
        apiStyle: settings.apiStyle,
        instructions,
        input,
        messages,
        tools,
        toolChoice,
        metadata,
        agentComplexity,
        slotName: agentSlot,
        model: resolvedModel,
      },
    };
  }

  async function executeChatCompletionWithRetry(buildPayload) {
    let { payload, errorLogContext } = buildPayload(false);

    try {
      return {
        payload,
        response: await executeChatCompletionsRequest(payload, errorLogContext),
      };
    } catch (error) {
      if (!Object.prototype.hasOwnProperty.call(payload, "temperature") || !shouldRetryWithoutTemperature(error)) {
        throw error;
      }

      ({ payload, errorLogContext } = buildPayload(true));
      return {
        payload,
        response: await executeChatCompletionsRequest(payload, errorLogContext),
      };
    }
  }

  async function generateWithChatCompletions({
    instructions,
    input,
    messages,
    useCodexModel = false,
    useReviewModel = false,
    model,
    temperature,
    tools,
    toolChoice,
    metadata,
    agentComplexity,
    agentSlot,
    extraBody,
  }) {
    const { payload, response } = await executeChatCompletionWithRetry((omitTemperature = false) =>
      buildChatCompletionPayload({
        instructions,
        input,
        messages,
        useCodexModel,
        useReviewModel,
        model,
        temperature: omitTemperature ? undefined : temperature,
        tools,
        toolChoice,
        metadata,
        agentComplexity,
        agentSlot,
        extraBody,
      }));

    return {
      mode: settings.effectiveMode,
      model: payload.model,
      text: extractChatCompletionText(response),
      raw: response,
    };
  }

  async function generateWithMiniMaxNativeWebSearch(options = {}) {
    const pluginResult = await generateWithChatCompletions({
      ...options,
      tools: undefined,
      toolChoice: undefined,
      extraBody: {
        plugins: ["plugin_web_search"],
      },
    });
    const raw = {
      ...(pluginResult.raw || {}),
      native_web_search_requested: true,
    };

    if (hasMiniMaxWebSearchToolCall(raw)) {
      return {
        ...pluginResult,
        raw,
      };
    }

    try {
      const probeResult = await generateWithChatCompletions({
        ...options,
        tools: [{ type: "web_search" }],
        toolChoice: "auto",
      });
      raw.native_web_search_probe = probeResult.raw;
    } catch (error) {
      raw.native_web_search_probe_error = error instanceof Error ? error.message : String(error || "");
    }

    return {
      ...pluginResult,
      raw,
    };
  }

  async function generateText(options) {
    if (settings.effectiveMode === "unavailable") {
      throw new Error(
        `Novelex 需要可用的 ${settings.providerName} API 配置。请检查 novelex.codex.toml 里的 provider、base_url 与 api_key，然后重试。`,
      );
    }

    if (Array.isArray(options?.tools) && options.tools.length && !options?.disableToolProviderRouting) {
      let nativeMiniMaxResult = null;
      let nativeMiniMaxError = null;

      if (hasOnlyWebSearchTools(options.tools) && providerSupportsNativeWebSearch(settings)) {
        try {
          nativeMiniMaxResult = await generateWithMiniMaxNativeWebSearch(options);
          if (hasMiniMaxWebSearchToolCall(nativeMiniMaxResult.raw)) {
            return nativeMiniMaxResult;
          }
        } catch (error) {
          nativeMiniMaxError = error;
        }
      }

      const toolProvider = createProvider(projectState, {
        rootDir: outerOptions.rootDir,
        providerIdOverride: "OpenAI",
        disableToolProviderRouting: true,
      });

      if (toolProvider.settings.effectiveMode !== "openai-responses") {
        if (nativeMiniMaxResult) {
          return nativeMiniMaxResult;
        }
        if (nativeMiniMaxError) {
          throw nativeMiniMaxError;
        }
        throw new Error("web_search 当前需要可用的 OpenAI responses provider，或可用的 MiniMax 原生搜索配置。请检查 novelex.codex.toml 里的 OpenAI / MiniMax 配置。");
      }

      return toolProvider.generateText({
        ...options,
        model: resolveWebSearchModel(toolProvider.settings),
        disableToolProviderRouting: true,
      });
    }

    if (settings.apiStyle === "responses") {
      return generateWithResponses(options);
    }

    if (settings.apiStyle === "chat_completions") {
      return generateWithChatCompletions(options);
    }

    throw new Error(`不支持的 Provider 协议：${settings.apiStyle}`);
  }

  return {
    settings,
    async generateText(options) {
      return generateText(options);
    },
  };
}

function slotNameForAgentComplexity(settings, agentComplexity = "complex") {
  if (String(agentComplexity || "").trim() === "simple") {
    return settings?.agentRouting?.simple || "secondary";
  }
  return settings?.agentRouting?.complex || "primary";
}

function slotNameForRequest(settings, options = {}) {
  if (looksLikeStrictStructuredOutput(options)) {
    return settings?.agentRouting?.complex || "primary";
  }
  return slotNameForAgentComplexity(settings, options.agentComplexity);
}

function slotConfigForRequest(settings, options = {}) {
  const slotName = slotNameForRequest(settings, options);
  return {
    slotName,
    slotConfig: settings?.agentModels?.[slotName] || settings?.agentModels?.primary || null,
  };
}

export function createProvider(projectState, options = {}) {
  if (options.providerIdOverride) {
    return createSingleProviderClient(projectState, options);
  }

  const settings = resolveProviderSettings(projectState, options.rootDir, options);
  const primaryClient = createSingleProviderClient(projectState, {
    ...options,
    providerIdOverride: settings.agentModels?.primary?.providerId || settings.providerId,
  });
  const secondaryClient = createSingleProviderClient(projectState, {
    ...options,
    providerIdOverride: settings.agentModels?.secondary?.providerId || settings.providerId,
  });

  return {
    settings,
    resolveAgentModel(agentComplexity = "complex") {
      return slotConfigForRequest(settings, { agentComplexity }).slotConfig;
    },
    async generateText(rawOptions = {}) {
      const optionsWithDefaults = {
        ...(rawOptions || {}),
      };
      const normalizedInstructions = strengthenStructuredOutputInstructions(
        optionsWithDefaults.instructions,
        optionsWithDefaults,
      );
      const normalizedOptions = {
        ...optionsWithDefaults,
        instructions: normalizedInstructions,
      };
      const { slotName, slotConfig } = slotConfigForRequest(
        settings,
        normalizedOptions,
      );
      const targetClient = slotName === "secondary" ? secondaryClient : primaryClient;
      const routedOptions = {
        ...normalizedOptions,
        model: normalizedOptions.model || slotConfig?.model || primaryClient.settings.responseModel,
        agentSlot: slotName,
      };
      return targetClient.generateText(routedOptions);
    },
  };
}
