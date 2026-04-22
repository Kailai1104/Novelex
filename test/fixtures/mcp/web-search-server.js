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

async function handle(message) {
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
  const method = String(message.method || "").trim();
  const params = message.params && typeof message.params === "object" ? message.params : {};

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "fixture-web-search-server",
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
          name: "web_search",
          description: "Fixture web search tool",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
              },
            },
            required: ["query"],
          },
        },
      ],
    });
    return;
  }

  if (method === "tools/call") {
    const query = String(params.arguments?.query || "").trim();
    respond(id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            query,
            results: [
              {
                title: "明代海防研究资料",
                url: "https://example.com/ming-haifang",
                snippet: "沿海卫所、巡检与港口贸易互相交织。",
              },
              {
                title: "福建海商与港口秩序",
                url: "https://example.com/fujian-port",
                snippet: "海商网络与地方防务呈复杂共生关系。",
              },
            ],
          }),
        },
      ],
      structuredContent: {
        query,
        results: [
          {
            title: "明代海防研究资料",
            url: "https://example.com/ming-haifang",
            snippet: "沿海卫所、巡检与港口贸易互相交织。",
          },
          {
            title: "福建海商与港口秩序",
            url: "https://example.com/fujian-port",
            snippet: "海商网络与地方防务呈复杂共生关系。",
          },
        ],
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
