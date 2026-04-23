import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseSimpleToml,
  saveCodexApiConfig,
  stringifySimpleToml,
} from "../src/config/codex-config.js";
import { StdioMcpClient } from "../src/mcp/client.js";
import { closeAllWorkspaceMcpManagers, createMcpManager, normalizeLocalRagToolResult } from "../src/mcp/index.js";
import { rebuildRagCollectionIndex } from "../src/rag/index.js";
import { createStore } from "../src/utils/store.js";

const FIXTURE_RUNTIME_SERVER = path.join(process.cwd(), "test", "fixtures", "mcp", "runtime-server.js");
const FIXTURE_WEB_SEARCH_SERVER = path.join(process.cwd(), "test", "fixtures", "mcp", "web-search-server.js");

test.afterEach(async () => {
  await closeAllWorkspaceMcpManagers();
});

test("simple toml supports MCP array config round-trip", () => {
  const parsed = parseSimpleToml(`
[mcp.servers.web_search]
command = "npx"
args = ["-y", "minimax-coding-plan-mcp"]
`);

  assert.deepEqual(parsed.mcp.servers.web_search.args, ["-y", "minimax-coding-plan-mcp"]);

  const serialized = stringifySimpleToml({
    mcp: {
      enabled: true,
      servers: {
        web_search: {
          command: "npx",
          args: ["-y", "minimax-coding-plan-mcp"],
        },
      },
    },
  });
  assert.match(serialized, /args = \["-y", "minimax-coding-plan-mcp"\]/);
});

test("stdio mcp client completes initialize list and call flow", async () => {
  const client = new StdioMcpClient({
    serverId: "fixture_runtime",
    command: process.execPath,
    args: [FIXTURE_RUNTIME_SERVER],
    env: {
      ...process.env,
      FIXTURE_MODE: "normal",
      FIXTURE_TOOL_NAME: "echo_tool",
    },
    startupTimeoutMs: 3000,
    callTimeoutMs: 3000,
  });

  try {
    await client.connect();
    const tools = await client.listTools();
    assert.equal(tools[0]?.name, "echo_tool");
    const result = await client.callTool("echo_tool", { value: "hello" });
    assert.equal(result?.structuredContent?.echoed, "hello");
  } finally {
    await client.close();
  }
});

test("stdio mcp client reports timeout and stdout pollution errors", async () => {
  const timeoutClient = new StdioMcpClient({
    serverId: "fixture_timeout",
    command: process.execPath,
    args: [FIXTURE_RUNTIME_SERVER],
    env: {
      ...process.env,
      FIXTURE_MODE: "timeout",
      FIXTURE_TOOL_NAME: "echo_tool",
    },
    startupTimeoutMs: 3000,
    callTimeoutMs: 200,
  });

  try {
    await timeoutClient.connect();
    await assert.rejects(
      () => timeoutClient.callTool("echo_tool", { value: "slow" }),
      /timed out/i,
    );
  } finally {
    await timeoutClient.close();
  }

  const noisyClient = new StdioMcpClient({
    serverId: "fixture_noisy",
    command: process.execPath,
    args: [FIXTURE_RUNTIME_SERVER],
    env: {
      ...process.env,
      FIXTURE_MODE: "noisy_stdout",
      FIXTURE_TOOL_NAME: "echo_tool",
    },
    startupTimeoutMs: 3000,
    callTimeoutMs: 1000,
  });

  await assert.rejects(
    () => noisyClient.connect(),
    /non-JSON stdout/i,
  );
  await noisyClient.close();
});

test("stdio mcp client surfaces missing command startup failures clearly", async () => {
  const client = new StdioMcpClient({
    serverId: "missing_binary",
    command: "definitely-not-a-real-command-for-novelex-tests",
    args: [],
    startupTimeoutMs: 1000,
    callTimeoutMs: 1000,
  });

  await assert.rejects(
    () => client.connect(),
    /failed to spawn/i,
  );
  await client.close();
});

test("mcp manager lazily reuses a connected server", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-mcp-manager-"));
  saveCodexApiConfig(tempRoot, {
    mcp: {
      enabled: true,
      servers: {
        web_search: {
          enabled: true,
          transport: "stdio",
          command: process.execPath,
          args: [FIXTURE_RUNTIME_SERVER],
          startup_timeout_ms: 3000,
          call_timeout_ms: 3000,
          env: {
            FIXTURE_MODE: "normal",
            FIXTURE_TOOL_NAME: "web_search",
          },
        },
        local_rag: {
          enabled: false,
        },
      },
    },
  });

  const manager = createMcpManager({
    rootDir: tempRoot,
    configRootDir: tempRoot,
  });

  try {
    const first = await manager.callTool("web_search", { value: "first" });
    const firstClient = manager.clients.get("web_search");
    const second = await manager.callTool("web_search", { value: "second" });
    const secondClient = manager.clients.get("web_search");

    assert.equal(first?.structuredContent?.echoed, "first");
    assert.equal(second?.structuredContent?.echoed, "second");
    assert.ok(firstClient);
    assert.equal(firstClient, secondClient);
  } finally {
    await manager.closeAll();
  }
});

test("mcp manager falls back from uvx to npx for web_search and provisions npm cache", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-mcp-fallback-"));
  const binDir = path.join(tempRoot, "bin");
  const fakeNpx = path.join(binDir, "npx");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(fakeNpx, `#!/bin/sh
if [ -z "$npm_config_cache" ]; then
  echo "npm_config_cache missing" >&2
  exit 41
fi
if [ -z "$npm_config_userconfig" ]; then
  echo "npm_config_userconfig missing" >&2
  exit 42
fi
if [ -z "$HOME" ]; then
  echo "HOME missing" >&2
  exit 43
fi
if [ -z "$XDG_CACHE_HOME" ]; then
  echo "XDG_CACHE_HOME missing" >&2
  exit 44
fi
if [ ! -f "$npm_config_userconfig" ]; then
  echo "npm_config_userconfig file missing" >&2
  exit 45
fi
case "$HOME" in
  "${tempRoot}"/runtime/npm-home) ;;
  *)
    echo "HOME not isolated: $HOME" >&2
    exit 46
    ;;
esac
case "$1" in
  --cache) ;;
  *)
    echo "--cache flag missing" >&2
    exit 47
    ;;
esac
case "$2" in
  "${tempRoot}"/runtime/npm-cache) ;;
  *)
    echo "cache path not injected: $2" >&2
    exit 48
    ;;
esac
exec "${process.execPath}" "${FIXTURE_WEB_SEARCH_SERVER}"
`, "utf8");
  await fs.chmod(fakeNpx, 0o755);

  saveCodexApiConfig(tempRoot, {
    mcp: {
      enabled: true,
      servers: {
        web_search: {
          enabled: true,
          transport: "stdio",
          command: "uvx",
          args: ["minimax-coding-plan-mcp", "-y"],
          startup_timeout_ms: 3000,
          call_timeout_ms: 3000,
          env: {
            PATH: binDir,
          },
        },
        local_rag: {
          enabled: false,
        },
      },
    },
  });

  const manager = createMcpManager({
    rootDir: tempRoot,
    configRootDir: tempRoot,
  });

  try {
    const result = await manager.callTool("web_search", { query: "fallback works" });
    assert.equal(result?.structuredContent?.query, "fallback works");

    const npmCacheDir = path.join(tempRoot, "runtime", "npm-cache");
    const npmHomeDir = path.join(tempRoot, "runtime", "npm-home");
    const npmUserConfigPath = path.join(npmHomeDir, ".npmrc");
    const stat = await fs.stat(npmCacheDir);
    assert.equal(stat.isDirectory(), true);
    assert.equal((await fs.stat(npmHomeDir)).isDirectory(), true);
    assert.equal((await fs.stat(npmUserConfigPath)).isFile(), true);
  } finally {
    await manager.closeAll();
  }
});

test("mcp manager ignores inherited npm cache env for web_search", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-mcp-inherited-cache-"));
  const binDir = path.join(tempRoot, "bin");
  const fakeNpx = path.join(binDir, "npx");
  const previousLowerCache = process.env.npm_config_cache;
  const previousUpperCache = process.env.NPM_CONFIG_CACHE;
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(fakeNpx, `#!/bin/sh
case "$npm_config_cache" in
  "${tempRoot}"/runtime/npm-cache) ;;
  *)
    echo "inherited npm_config_cache leaked: $npm_config_cache" >&2
    exit 61
    ;;
esac
case "$1" in
  --cache) ;;
  *)
    echo "--cache flag missing" >&2
    exit 62
    ;;
esac
case "$2" in
  "${tempRoot}"/runtime/npm-cache) ;;
  *)
    echo "cache arg leaked: $2" >&2
    exit 63
    ;;
esac
exec "${process.execPath}" "${FIXTURE_WEB_SEARCH_SERVER}"
`, "utf8");
  await fs.chmod(fakeNpx, 0o755);

  process.env.npm_config_cache = path.join(os.homedir(), ".npm");
  process.env.NPM_CONFIG_CACHE = path.join(os.homedir(), ".npm");

  saveCodexApiConfig(tempRoot, {
    mcp: {
      enabled: true,
      servers: {
        web_search: {
          enabled: true,
          transport: "stdio",
          command: "npx",
          args: ["-y", "minimax-coding-plan-mcp"],
          startup_timeout_ms: 3000,
          call_timeout_ms: 3000,
          env: {
            PATH: binDir,
          },
        },
        local_rag: {
          enabled: false,
        },
      },
    },
  });

  const manager = createMcpManager({
    rootDir: tempRoot,
    configRootDir: tempRoot,
  });

  try {
    const result = await manager.callTool("web_search", { query: "ignore inherited cache" });
    assert.equal(result?.structuredContent?.query, "ignore inherited cache");
  } finally {
    if (previousLowerCache === undefined) {
      delete process.env.npm_config_cache;
    } else {
      process.env.npm_config_cache = previousLowerCache;
    }

    if (previousUpperCache === undefined) {
      delete process.env.NPM_CONFIG_CACHE;
    } else {
      process.env.NPM_CONFIG_CACHE = previousUpperCache;
    }

    await manager.closeAll();
  }
});

test("web_search extends startup timeout for npx-based MiniMax MCP cold starts", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-mcp-cold-start-"));
  const binDir = path.join(tempRoot, "bin");
  const fakeNpx = path.join(binDir, "npx");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(fakeNpx, `#!/bin/sh
sleep 0.2
exec "${process.execPath}" "${FIXTURE_RUNTIME_SERVER}"
`, "utf8");
  await fs.chmod(fakeNpx, 0o755);

  saveCodexApiConfig(tempRoot, {
    mcp: {
      enabled: true,
      servers: {
        web_search: {
          enabled: true,
          transport: "stdio",
          command: "npx",
          args: ["-y", "minimax-coding-plan-mcp"],
          startup_timeout_ms: 50,
          call_timeout_ms: 3000,
          env: {
            PATH: binDir,
            FIXTURE_MODE: "normal",
            FIXTURE_TOOL_NAME: "web_search",
            FIXTURE_INIT_DELAY_MS: "200",
          },
        },
        local_rag: {
          enabled: false,
        },
      },
    },
  });

  const manager = createMcpManager({
    rootDir: tempRoot,
    configRootDir: tempRoot,
  });

  try {
    const startedAt = Date.now();
    const result = await manager.callTool("web_search", { value: "cold-start" });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result?.structuredContent?.echoed, "cold-start");
    assert.ok(elapsedMs >= 150);
  } finally {
    await manager.closeAll();
  }
});

test("local_rag mcp server returns normalized matches for reference retrieval", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novelex-local-rag-"));
  const store = await createStore(tempRoot);
  process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS = "true";

  try {
    const collection = await store.createRagCollection("测试范文库");
    await fs.writeFile(
      path.join(collection.sourceDir, "sample.md"),
      Array.from({ length: 20 }, () => "海风、船板和短对白一起把局势推紧。").join("\n\n"),
      "utf8",
    );
    await rebuildRagCollectionIndex({
      store,
      collectionId: collection.id,
    });

    const manager = createMcpManager({
      rootDir: tempRoot,
      configRootDir: tempRoot,
    });

    try {
      const normalized = normalizeLocalRagToolResult(await manager.callTool("local_rag", {
        collectionType: "reference",
        collectionIds: [collection.id],
        queries: ["海风 船板 短对白"],
        limit: 4,
      }));
      assert.ok(normalized.matches.length >= 1);
      assert.equal(normalized.matches[0].collectionId, collection.id);
    } finally {
      await manager.closeAll();
    }
  } finally {
    delete process.env.NOVELEX_FAKE_ZHIPU_EMBEDDINGS;
  }
});
