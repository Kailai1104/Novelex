import { loadCodexApiConfig, normalizeCodexConfigData } from "../config/codex-config.js";

const MAX_RECONNECT_ATTEMPTS = 5;
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429]);

class ProviderRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderRequestError";
    this.status = options.status;
    this.attempts = options.attempts;
  }
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

function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

function reconnectDelayMs(attempt) {
  return 250 * 2 ** (attempt - 1);
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
    return finalPayload;
  }

  return {
    output_text: accumulatedText.trim(),
    output: accumulatedText.trim()
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
  };
}

async function requestProviderJson({
  url,
  apiKey,
  payload,
  providerName,
  streamFallbackAllowed = true,
  parseStream = null,
}) {
  let activePayload = payload;

  for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
    const wantsStream = Boolean(activePayload?.stream);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(wantsStream ? { Accept: "text/event-stream" } : {}),
        },
        body: JSON.stringify(activePayload),
      });

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

        if (attempt < MAX_RECONNECT_ATTEMPTS && isRetryableStatus(response.status)) {
          await wait(reconnectDelayMs(attempt));
          continue;
        }

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
          if (attempt < MAX_RECONNECT_ATTEMPTS) {
            await wait(reconnectDelayMs(attempt));
            continue;
          }
          throw error;
        }
      }

      return response.json();
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        throw error;
      }

      if (attempt < MAX_RECONNECT_ATTEMPTS) {
        await wait(reconnectDelayMs(attempt));
        continue;
      }

      const message = error instanceof Error ? error.message : String(error || "");
      throw new ProviderRequestError(
        `${providerName} request failed after ${attempt} attempts: ${message}`,
        {
          attempts: attempt,
        },
      );
    }
  }

  throw new ProviderRequestError(`${providerName} request failed after exhausting reconnect attempts.`, {
    attempts: MAX_RECONNECT_ATTEMPTS,
  });
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
    return typeof error.status === "number" && error.status >= 500;
  }

  const message = error instanceof Error ? error.message : String(error || "");
  return /request failed(?: after \d+ attempts)?:.*\b5\d{2}\b/i.test(message);
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
  return [`${String(providerId || "").toUpperCase()}_API_KEY`];
}

function defaultEnvBaseUrlNames(providerId) {
  if (providerId === "OpenAI") {
    return ["OPENAI_BASE_URL"];
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

export function resolveProviderSettings(projectState, rootDir = process.cwd(), options = {}) {
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
    availableProviders,
    configSource: codexConfig.exists ? "codex_file" : "runtime_or_env",
    configPath: codexConfig.path,
    configError: codexConfig.error,
    configLoaded: codexConfig.exists && !codexConfig.error,
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
    availableProviders: settings.availableProviders,
    configSource: settings.configSource,
    configPath: settings.configPath,
    configLoaded: settings.configLoaded,
    configError: settings.configError,
  };
}

export function createProvider(projectState, options = {}) {
  const outerOptions = options;
  const settings = resolveProviderSettings(projectState, options.rootDir, {
    providerIdOverride: options.providerIdOverride,
  });

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

  async function executeResponsesRequest(payload) {
    try {
      return await requestProviderJson({
        url: `${settings.baseUrl}/responses`,
        apiKey: settings.apiKey,
        providerName: settings.providerName,
        payload: buildCompatibleResponsePayload(payload, settings),
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
        payload: buildLeanResponseRetryPayload(payload),
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
  }) {
    const payload = {
      model: pickModel({ useCodexModel, useReviewModel, model }),
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
      response = await executeResponsesRequest(payload);
    } catch (error) {
      if (!Object.prototype.hasOwnProperty.call(payload, "temperature") || !shouldRetryWithoutTemperature(error)) {
        throw error;
      }

      const payloadWithoutTemperature = {
        ...payload,
      };
      delete payloadWithoutTemperature.temperature;
      response = await executeResponsesRequest(payloadWithoutTemperature);
    }

    return {
      mode: settings.effectiveMode,
      model: payload.model,
      text: extractResponseText(response),
      raw: response,
    };
  }

  async function generateWithChatCompletions({
    instructions,
    input,
    messages,
    useCodexModel = false,
    useReviewModel = false,
    model,
    temperature,
  }) {
    const payload = {
      model: pickModel({ useCodexModel, useReviewModel, model }),
      messages: normalizeChatMessages({ instructions, input, messages }),
    };

    if (Number.isFinite(Number(temperature))) {
      payload.temperature = Number(temperature);
    }

    let response;
    try {
      response = await requestProviderJson({
        url: `${settings.baseUrl}/chat/completions`,
        apiKey: settings.apiKey,
        providerName: settings.providerName,
        payload,
        streamFallbackAllowed: false,
        parseStream: payload.stream ? parseChatCompletionEventStream : null,
      });
    } catch (error) {
      if (!Object.prototype.hasOwnProperty.call(payload, "temperature") || !shouldRetryWithoutTemperature(error)) {
        throw error;
      }

      const payloadWithoutTemperature = {
        ...payload,
      };
      delete payloadWithoutTemperature.temperature;
      response = await requestProviderJson({
        url: `${settings.baseUrl}/chat/completions`,
        apiKey: settings.apiKey,
        providerName: settings.providerName,
        payload: payloadWithoutTemperature,
        streamFallbackAllowed: false,
        parseStream: payloadWithoutTemperature.stream ? parseChatCompletionEventStream : null,
      });
    }

    return {
      mode: settings.effectiveMode,
      model: payload.model,
      text: extractChatCompletionText(response),
      raw: response,
    };
  }

  async function generateText(options) {
    if (settings.effectiveMode === "unavailable") {
      throw new Error(
        `Novelex 需要可用的 ${settings.providerName} API 配置。请检查 novelex.codex.toml 里的 provider、base_url 与 api_key，然后重试。`,
      );
    }

    if (
      Array.isArray(options?.tools) &&
      options.tools.length &&
      !options?.disableToolProviderRouting
    ) {
      const toolProvider = createProvider(projectState, {
        rootDir: outerOptions.rootDir,
        providerIdOverride: "OpenAI",
        disableToolProviderRouting: true,
      });

      if (toolProvider.settings.effectiveMode !== "openai-responses") {
        throw new Error("web_search 已固定走 OpenAI GPT，但当前 OpenAI Provider 不可用。请检查 novelex.codex.toml 里的 OpenAI 配置。");
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
