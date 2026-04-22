import { spawn } from "node:child_process";
import readline from "node:readline";

import { McpError } from "./error.js";

const INITIALIZE_TIMEOUT_MS = 15000;
const CLOSE_GRACE_MS = 500;
const JSON_RPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";

function summarizeStderr(lines = [], limit = 8) {
  return lines
    .slice(-limit)
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .join(" | ");
}

export class StdioMcpClient {
  constructor(options = {}) {
    this.serverId = String(options.serverId || "").trim() || "mcp_server";
    this.command = String(options.command || "").trim();
    this.args = Array.isArray(options.args) ? options.args.map((item) => String(item)) : [];
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.startupTimeoutMs = Number(options.startupTimeoutMs || INITIALIZE_TIMEOUT_MS);
    this.callTimeoutMs = Number(options.callTimeoutMs || 30000);
    this.child = null;
    this.pending = new Map();
    this.stderrLines = [];
    this.nextRequestId = 1;
    this.initialized = false;
    this.connectPromise = null;
  }

  async connect() {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.#connectInternal();
    try {
      await this.connectPromise;
      return this;
    } catch (error) {
      this.connectPromise = null;
      throw error;
    }
  }

  async listTools() {
    await this.connect();
    const result = await this.#request("tools/list", {}, this.startupTimeoutMs);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}, options = {}) {
    await this.connect();
    const timeoutMs = Number(options.timeoutMs || this.callTimeoutMs);
    const result = await this.#request("tools/call", {
      name,
      arguments: args,
    }, timeoutMs);

    if (result?.isError) {
      throw new McpError("MCP_TOOL_EXECUTION_ERROR", String(result?.content?.[0]?.text || `${name} execution failed`).trim(), {
        serverId: this.serverId,
        toolName: name,
        stderr: summarizeStderr(this.stderrLines),
        data: result,
      });
    }

    return result;
  }

  async close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new McpError("MCP_SERVER_EXITED", `${this.serverId} closed before completing request.`, {
        serverId: this.serverId,
        stderr: summarizeStderr(this.stderrLines),
      }));
    }
    this.pending.clear();

    if (!this.child) {
      this.connectPromise = null;
      this.initialized = false;
      return;
    }

    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.connectPromise = null;

    try {
      child.stdin?.end();
    } catch {
      // Ignore broken pipe on shutdown.
    }

    await new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };

      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore kill failures during shutdown.
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore double-kill.
          }
          finish();
        }, CLOSE_GRACE_MS);
      }, CLOSE_GRACE_MS);

      child.once("exit", () => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  async #connectInternal() {
    if (!this.command) {
      throw new McpError("MCP_SERVER_NOT_CONFIGURED", `${this.serverId} has no command configured.`, {
        serverId: this.serverId,
      });
    }

    let child = null;
    try {
      child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new McpError("MCP_SERVER_STARTUP_FAILED", `${this.serverId} failed to spawn ${this.command}.`, {
        serverId: this.serverId,
        cause: error,
      });
    }

    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);
      this.stderrLines.push(...lines);
      if (this.stderrLines.length > 40) {
        this.stderrLines = this.stderrLines.slice(-40);
      }
    });

    const handleExit = (code, signal, overrideError = null) => {
      const reason = signal
        ? `signal ${signal}`
        : Number.isInteger(code)
          ? `code ${code}`
          : "an unknown startup error";
      const error = overrideError || new McpError("MCP_SERVER_EXITED", `${this.serverId} exited with ${reason}.`, {
        serverId: this.serverId,
        stderr: summarizeStderr(this.stderrLines),
      });
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.initialized = false;
      this.connectPromise = null;
    };

    child.once("error", (error) => {
      this.stderrLines.push(String(error?.message || error || ""));
      handleExit(null, null, new McpError(
        "MCP_SERVER_STARTUP_FAILED",
        `${this.serverId} failed to spawn ${this.command}: ${String(error?.message || error || "Unknown spawn error")}`.trim(),
        {
          serverId: this.serverId,
          stderr: summarizeStderr(this.stderrLines),
          cause: error,
        },
      ));
    });
    child.once("exit", handleExit);

    const lineReader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    lineReader.on("line", (line) => this.#handleStdoutLine(line));

    try {
      await this.#request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "Novelex",
          version: "0.1.0",
        },
      }, this.startupTimeoutMs);
    } catch (error) {
      await this.close();
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError("MCP_INITIALIZE_FAILED", `${this.serverId} initialize failed: ${String(error?.message || error || "")}`.trim(), {
        serverId: this.serverId,
        stderr: summarizeStderr(this.stderrLines),
        cause: error,
      });
    }

    this.#notify("notifications/initialized", {});
    this.initialized = true;
  }

  #handleStdoutLine(line) {
    const source = String(line || "").trim();
    if (!source) {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(source);
    } catch {
      const error = new McpError("MCP_PROTOCOL_ERROR", `${this.serverId} emitted non-JSON stdout.`, {
        serverId: this.serverId,
        stderr: summarizeStderr([...this.stderrLines, source]),
      });
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      try {
        this.child?.kill("SIGTERM");
      } catch {
        // Ignore shutdown errors after protocol failure.
      }
      return;
    }

    if (payload && Object.prototype.hasOwnProperty.call(payload, "id")) {
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(payload.id);

      if (payload.error) {
        pending.reject(new McpError("MCP_REQUEST_FAILED", `${this.serverId} ${pending.method} failed: ${payload.error.message || "Unknown error"}`, {
          serverId: this.serverId,
          stderr: summarizeStderr(this.stderrLines),
          data: payload.error,
        }));
        return;
      }

      pending.resolve(payload.result);
    }
  }

  #notify(method, params = {}) {
    if (!this.child?.stdin?.writable) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: JSON_RPC_VERSION,
      method,
      params,
    })}\n`);
  }

  #request(method, params = {}, timeoutMs = this.callTimeoutMs) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new McpError("MCP_SERVER_EXITED", `${this.serverId} is not running.`, {
        serverId: this.serverId,
        stderr: summarizeStderr(this.stderrLines),
      }));
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError("MCP_TOOL_CALL_TIMEOUT", `${this.serverId} ${method} timed out after ${timeoutMs}ms.`, {
          serverId: this.serverId,
          stderr: summarizeStderr(this.stderrLines),
        }));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      });

      try {
        this.child.stdin.write(`${JSON.stringify({
          jsonrpc: JSON_RPC_VERSION,
          id,
          method,
          params,
        })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpError("MCP_SERVER_EXITED", `${this.serverId} failed to write request ${method}.`, {
          serverId: this.serverId,
          stderr: summarizeStderr(this.stderrLines),
          cause: error,
        }));
      }
    });
  }
}
