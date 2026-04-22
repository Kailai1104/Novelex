const mode = String(process.env.FIXTURE_MODE || "normal").trim();
const toolName = String(process.env.FIXTURE_TOOL_NAME || "echo_tool").trim();
const initDelayMs = Number(process.env.FIXTURE_INIT_DELAY_MS || 0);
let initialized = false;
let buffer = "";

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(id, result) {
  send({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function error(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

if (mode === "noisy_stdout") {
  process.stdout.write("this should not be on stdout\n");
}

async function handle(message) {
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
  const method = String(message.method || "").trim();
  const params = message.params && typeof message.params === "object" ? message.params : {};

  if (method === "initialize") {
    if (Number.isFinite(initDelayMs) && initDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, initDelayMs));
    }
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "fixture-runtime-server",
        version: "0.1.0",
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    initialized = true;
    return;
  }

  if (!initialized) {
    error(id, -32002, "not initialized");
    return;
  }

  if (method === "tools/list") {
    respond(id, {
      tools: [
        {
          name: toolName,
          description: "Fixture tool",
          inputSchema: {
            type: "object",
            properties: {
              value: {
                type: "string",
              },
            },
          },
        },
      ],
    });
    return;
  }

  if (method === "tools/call") {
    if (mode === "timeout") {
      return;
    }
    if (mode === "crash") {
      process.exit(2);
    }
    if (mode === "tool_error") {
      respond(id, {
        content: [
          {
            type: "text",
            text: "fixture tool error",
          },
        ],
        structuredContent: {
          error: {
            code: "fixture_error",
            message: "fixture tool error",
          },
        },
        isError: true,
      });
      return;
    }

    respond(id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            echoed: params.arguments?.value || "",
          }),
        },
      ],
      structuredContent: {
        echoed: params.arguments?.value || "",
      },
      isError: false,
    });
    return;
  }

  error(id, -32601, `unknown method ${method}`);
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
    handle(JSON.parse(source)).catch((err) => {
      error(null, -32000, String(err?.message || err || "fixture failure"));
    });
  }
});
