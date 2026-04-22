import { createExcerpt } from "../../core/text.js";
import { loadCollectionChunksFromWorkspace, runHybridRetrieval } from "../../rag/index.js";
import { startMcpServer } from "../server-base.js";

function normalizeQueries(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

startMcpServer({
  name: "novelex-local-rag",
  version: "0.1.0",
  tools: [
    {
      name: "local_rag",
      description: "Search local Novelex RAG collections and return normalized retrieval matches.",
      inputSchema: {
        type: "object",
        properties: {
          collectionType: {
            type: "string",
            enum: ["reference"],
          },
          collectionIds: {
            type: "array",
            items: {
              type: "string",
            },
          },
          queries: {
            type: "array",
            items: {
              type: "string",
            },
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
          },
        },
        required: ["collectionType", "collectionIds", "queries"],
      },
      async handler(args) {
        if (args.collectionType !== "reference") {
          throw new Error(`Unsupported collectionType: ${String(args.collectionType || "")}`);
        }

        const collectionIds = (Array.isArray(args.collectionIds) ? args.collectionIds : [])
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 20);
        const queries = normalizeQueries(args.queries);
        const limit = Math.max(1, Math.min(20, Number(args.limit || 8)));

        const loaded = await loadCollectionChunksFromWorkspace(process.env.NOVELEX_MCP_ROOT_DIR || process.cwd(), collectionIds);
        const chunks = loaded.flatMap((item) => item.chunks);
        const matches = await runHybridRetrieval({
          queries,
          chunks,
          limit,
          rootDir: process.env.NOVELEX_MCP_ROOT_DIR || process.cwd(),
        });

        return {
          matches: matches.map((item) => ({
            chunkId: item.chunkId,
            collectionId: item.collectionId,
            collectionName: item.collectionName,
            sourcePath: item.sourcePath,
            excerpt: item.excerpt,
            text: createExcerpt(item.text, 600),
            position: item.position,
            fusedScore: item.fusedScore,
            vectorScore: item.vectorScore,
            keywordScore: item.keywordScore,
          })),
          summary: matches.length
            ? `local_rag 命中 ${matches.length} 个参考片段。`
            : "local_rag 没有命中高相关片段。",
          warnings: [],
        };
      },
    },
  ],
});
