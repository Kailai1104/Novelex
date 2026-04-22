export class McpError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.serverId = options.serverId || "";
    this.toolName = options.toolName || "";
    this.cause = options.cause;
    this.stderr = options.stderr || "";
    this.data = options.data;
  }
}

export function formatMcpErrorMessage(prefix, error) {
  const label = String(prefix || "MCP");
  if (!(error instanceof Error)) {
    return `${label} failed: ${String(error || "Unknown error")}`;
  }

  const stderr = String(error.stderr || "").trim();
  if (stderr) {
    return `${label} failed: ${error.message} | stderr: ${stderr}`;
  }
  return `${label} failed: ${error.message}`;
}
