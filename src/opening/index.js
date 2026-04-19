import fs from "node:fs/promises";
import path from "node:path";

import { unique } from "../core/text.js";
import { chunkText, decodeTextBuffer, runHybridRetrieval } from "../rag/index.js";
import { createZhipuEmbeddingClient } from "../rag/zhipu.js";

async function listSourceFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
      continue;
    }
    if (/\.(txt|md)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function buildChunkRecord({ collectionId, collectionName, sourcePath, chunk }) {
  return {
    chunkId: `${collectionId}:${sourcePath}:${chunk.index + 1}`,
    collectionId,
    collectionName,
    sourcePath,
    text: chunk.text,
    excerpt: String(chunk.text || "").slice(0, 180),
    position: {
      index: chunk.index,
      start: chunk.start,
      end: chunk.end,
    },
  };
}

export async function rebuildOpeningCollectionIndex({ store, collectionId }) {
  const collection = await store.loadOpeningCollection(collectionId);
  if (!collection) {
    throw new Error("Opening collection not found.");
  }

  const sourceFiles = await listSourceFiles(collection.sourceDir);
  const sourceDetails = [];
  const chunkRecords = [];

  for (const filePath of sourceFiles) {
    const buffer = await fs.readFile(filePath);
    const decoded = decodeTextBuffer(buffer);
    const relativePath = path.relative(collection.sourceDir, filePath);
    const chunks = chunkText(decoded.text);

    sourceDetails.push({
      path: relativePath,
      encoding: decoded.encoding,
      size: buffer.length,
      chunkCount: chunks.length,
    });

    for (const chunk of chunks) {
      chunkRecords.push(buildChunkRecord({
        collectionId: collection.id,
        collectionName: collection.name,
        sourcePath: relativePath,
        chunk,
      }));
    }
  }

  const client = createZhipuEmbeddingClient({
    rootDir: store.paths.configRootDir,
  });
  if (!client.isConfigured()) {
    await store.saveOpeningCollectionIndex(collection.id, {
      collectionId: collection.id,
      fileCount: sourceDetails.length,
      chunkCount: 0,
      lastBuiltAt: null,
      lastError: "Missing ZHIPU_API_KEY.",
      sourceFiles: sourceDetails,
    });
    throw new Error("Missing ZHIPU_API_KEY.");
  }

  try {
    const embeddings = await client.embedTexts(
      chunkRecords.map((item) => item.text),
      { concurrency: 3 },
    );
    const hydratedRecords = chunkRecords.map((item, index) => ({
      ...item,
      embedding: embeddings[index],
    }));

    await store.writeOpeningCollectionChunks(collection.id, hydratedRecords);
    const index = {
      collectionId: collection.id,
      fileCount: sourceDetails.length,
      chunkCount: hydratedRecords.length,
      lastBuiltAt: new Date().toISOString(),
      lastError: "",
      sourceFiles: sourceDetails,
      sourceDir: collection.sourceDirRelative,
      encodings: unique(sourceDetails.map((item) => item.encoding)),
    };
    await store.saveOpeningCollectionIndex(collection.id, index);
    return {
      collection: await store.loadOpeningCollection(collection.id),
      index,
      chunks: hydratedRecords.length,
    };
  } catch (error) {
    await store.saveOpeningCollectionIndex(collection.id, {
      collectionId: collection.id,
      fileCount: sourceDetails.length,
      chunkCount: chunkRecords.length,
      lastBuiltAt: null,
      lastError: error instanceof Error ? error.message : String(error || "Unknown error"),
      sourceFiles: sourceDetails,
      sourceDir: collection.sourceDirRelative,
      encodings: unique(sourceDetails.map((item) => item.encoding)),
    });
    throw error;
  }
}

export async function loadOpeningCollectionChunks(store, collectionIds = []) {
  const collections = [];

  for (const collectionId of collectionIds) {
    const collection = await store.loadOpeningCollection(collectionId);
    if (!collection) {
      continue;
    }
    const chunks = await store.readOpeningCollectionChunks(collection.id, []);
    collections.push({
      collection,
      chunks: chunks.map((item) => ({
        ...item,
        collectionName: item.collectionName || collection.name,
      })),
    });
  }

  return collections;
}

export { runHybridRetrieval };
