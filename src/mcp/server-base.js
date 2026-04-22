const JSON_RPC_VERSION = "2.0";
const SERVER_PROTOCOL_VERSION = "2024-11-05";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateScalarType(value, type) {
  if (type === "string") {
    return typeof value === "string";
  }
  if (type === "integer") {
    return Number.isInteger(value);
  }
  if (type === "number") {
    return Number.isFinite(value);
  }
  if (type === "boolean") {
    return typeof value === "boolean";
  }
  return true;
}

function validateSchema(value, schema, path = "input") {
  if (!schema || typeof schema !== "object") {
    return;
  }

  if (schema.type === "object") {
    if (!isPlainObject(value)) {
      throw new Error(`${path} must be an object.`);
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new Error(`${path}.${key} is required.`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
        continue;
      }
      validateSchema(value[key], propertySchema, `${path}.${key}`);
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${path} must be an array.`);
    }
    for (const item of value) {
      validateSchema(item, schema.items || {}, `${path}[]`);
    }
    return;
  }

  if (!validateScalarType(value, schema.type)) {
    throw new Error(`${path} must be a ${schema.type}.`);
  }

  if (Array.isArray(schema.enum) && schema.enum.length && !schema.enum.includes(value)) {
    throw new Error(`${path} must be one of ${schema.enum.join(", ")}.`);
  }
  if (schema.minimum !== undefined && Number(value) < Number(schema.minimum)) {
    throw new Error(`${path} must be >= ${schema.minimum}.`);
  }
  if (schema.maximum !== undefined && Number(value) > Number(schema.maximum)) {
    throw new Error(`${path} must be <= ${schema.maximum}.`);
  }
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendResult(id, result) {
  send({
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  });
}

function sendError(id, code, message, data = null) {
  send({
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  });
}

function normalizeToolOutput(output) {
  if (output && typeof output === "object" && Array.isArray(output.content)) {
    return output;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(output || {}),
      },
    ],
    structuredContent: output || {},
    isError: false,
  };
}

export function startMcpServer({ name, version, tools = [] }) {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  let initializeSeen = false;
  let fullyInitialized = false;
  let queue = Promise.resolve();
  let buffer = "";

  async function handleMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
    const method = String(message.method || "").trim();
    const params = isPlainObject(message.params) ? message.params : {};

    if (method === "initialize") {
      initializeSeen = true;
      sendResult(id, {
        protocolVersion: SERVER_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name,
          version,
        },
      });
      return;
    }

    if (method === "notifications/initialized") {
      fullyInitialized = true;
      return;
    }

    if (!initializeSeen || !fullyInitialized) {
      sendError(id, -32002, "Server not initialized.");
      return;
    }

    if (method === "tools/list") {
      sendResult(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description || "",
          inputSchema: tool.inputSchema || {
            type: "object",
            properties: {},
          },
        })),
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = String(params.name || "").trim();
      const tool = toolMap.get(toolName);
      if (!tool) {
        sendError(id, -32601, `Unknown tool: ${toolName}`);
        return;
      }

      try {
        const args = isPlainObject(params.arguments) ? params.arguments : {};
        validateSchema(args, tool.inputSchema || {
          type: "object",
          properties: {},
        });
        const output = await tool.handler(args, {
          name: toolName,
        });
        sendResult(id, normalizeToolOutput(output));
      } catch (error) {
        sendResult(id, {
          content: [
            {
              type: "text",
              text: String(error instanceof Error ? error.message : error || "Tool execution failed."),
            },
          ],
          structuredContent: {
            error: {
              code: "tool_execution_error",
              message: String(error instanceof Error ? error.message : error || "Tool execution failed."),
            },
          },
          isError: true,
        });
      }
      return;
    }

    sendError(id, -32601, `Unknown method: ${method}`);
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += String(chunk || "");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const source = String(line || "").trim();
      if (!source) {
        continue;
      }

      queue = queue.then(async () => {
        try {
          await handleMessage(JSON.parse(source));
        } catch (error) {
          sendError(null, -32700, `Parse error: ${String(error instanceof Error ? error.message : error || "")}`);
        }
      });
    }
  });
}
