import fs from "node:fs/promises";
import path from "node:path";

import { createExcerpt, extractKeywords, normalizeText, overlapScore, unique } from "../core/text.js";
import { createZhipuEmbeddingClient } from "./zhipu.js";

const SUPPORTED_ENCODINGS = ["utf-8", "utf-16le", "gb18030"];
const TARGET_CHUNK_LENGTH = 700;
const CHUNK_OVERLAP_LENGTH = 120;

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

function decodeScore(text) {
  const source = String(text || "");
  if (!source.trim()) {
    return -1e9;
  }

  const chinese = (source.match(/[\u4e00-\u9fff]/g) || []).length;
  const replacement = (source.match(/\uFFFD/g) || []).length;
  const control = (source.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  const noise = (source.match(/[�]/g) || []).length;

  return chinese * 2 - replacement * 80 - control * 20 - noise * 40;
}

export function decodeTextBuffer(buffer) {
  const attempts = [];

  for (const encoding of SUPPORTED_ENCODINGS) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: false });
      const text = decoder.decode(buffer);
      attempts.push({
        encoding,
        text,
        score: decodeScore(text),
      });
    } catch {
      // Ignore unsupported decoders in the current runtime.
    }
  }

  const best = attempts.sort((left, right) => right.score - left.score)[0];
  if (!best) {
    return {
      encoding: "utf-8",
      text: buffer.toString("utf8"),
    };
  }

  return {
    encoding: best.encoding,
    text: best.text.replace(/^\uFEFF/, ""),
  };
}

function normalizeSourceText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLongParagraph(paragraph, limit = TARGET_CHUNK_LENGTH) {
  const source = normalizeText(paragraph);
  if (!source) {
    return [];
  }
  if (source.length <= limit) {
    return [source];
  }

  const pieces = [];
  for (let start = 0; start < source.length; start += limit) {
    pieces.push(source.slice(start, start + limit));
  }
  return pieces;
}

export function chunkText(text, options = {}) {
  const targetLength = Number(options.targetLength || TARGET_CHUNK_LENGTH);
  const overlapLength = Number(options.overlapLength || CHUNK_OVERLAP_LENGTH);
  const normalized = normalizeSourceText(text);
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .flatMap((paragraph) => splitLongParagraph(paragraph, targetLength))
    .filter(Boolean);

  const chunks = [];
  let current = "";
  let startOffset = 0;

  function pushChunk(forceText = current) {
    const value = normalizeSourceText(forceText);
    if (!value) {
      return;
    }
    const endOffset = Math.min(normalized.length, startOffset + value.length);
    chunks.push({
      text: value,
      start: startOffset,
      end: endOffset,
    });
  }

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= targetLength) {
      current = next;
      continue;
    }

    if (current) {
      pushChunk(current);
      const overlap = current.slice(-overlapLength);
      startOffset += Math.max(0, current.length - overlap.length);
      current = normalizeSourceText([overlap, paragraph].filter(Boolean).join("\n\n"));
      continue;
    }

    current = paragraph;
  }

  pushChunk(current);
  return chunks.map((item, index) => ({
    index,
    ...item,
  }));
}

function buildChunkRecord({ collectionId, collectionName, sourcePath, chunk }) {
  return {
    chunkId: `${collectionId}:${sourcePath}:${chunk.index + 1}`,
    collectionId,
    collectionName,
    sourcePath,
    text: chunk.text,
    excerpt: createExcerpt(chunk.text, 180),
    keywords: extractKeywords(sourcePath, chunk.text).slice(0, 24),
    position: {
      index: chunk.index,
      start: chunk.start,
      end: chunk.end,
    },
  };
}

export async function rebuildRagCollectionIndex({ store, collectionId }) {
  const collection = await store.loadRagCollection(collectionId);
  if (!collection) {
    throw new Error("RAG collection not found.");
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
    await store.saveRagCollectionIndex(collection.id, {
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

    await store.writeRagCollectionChunks(collection.id, hydratedRecords);
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
    await store.saveRagCollectionIndex(collection.id, index);
    return {
      collection: await store.loadRagCollection(collection.id),
      index,
      chunks: hydratedRecords.length,
    };
  } catch (error) {
    await store.saveRagCollectionIndex(collection.id, {
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

export async function loadCollectionChunks(store, collectionIds = []) {
  const collections = [];

  for (const collectionId of collectionIds) {
    const collection = await store.loadRagCollection(collectionId);
    if (!collection) {
      continue;
    }
    const chunks = await store.readRagCollectionChunks(collection.id, []);
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

function cosineSimilarity(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (!a.length || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = Number(a[index]);
    const y = Number(b[index]);
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (!normA || !normB) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildRrfMap(items, keyField, scoreField) {
  const ordered = [...items].sort((left, right) => right[scoreField] - left[scoreField]);
  const result = new Map();
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    result.set(item[keyField], 1 / (60 + index + 1));
  }
  return result;
}

export async function runHybridRetrieval({ queries, chunks, limit = 8, rootDir = process.cwd() }) {
  const queryTexts = (Array.isArray(queries) ? queries : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const records = Array.isArray(chunks) ? chunks : [];

  if (!queryTexts.length || !records.length) {
    return [];
  }

  const client = createZhipuEmbeddingClient({ rootDir });
  if (!client.isConfigured()) {
    throw new Error("Missing ZHIPU_API_KEY.");
  }

  const queryVectors = await client.embedTexts(queryTexts, { concurrency: 2 });

  const scored = records.map((chunk) => {
    const vectorScore = Math.max(
      ...queryVectors.map((vector) => cosineSimilarity(vector, chunk.embedding)),
    );
    const keywordScore = Math.max(
      ...queryTexts.map((query) => overlapScore(query, `${chunk.sourcePath} ${chunk.text}`)),
    );
    return {
      ...chunk,
      vectorScore,
      keywordScore,
    };
  });

  const vectorRanks = buildRrfMap(scored, "chunkId", "vectorScore");
  const keywordRanks = buildRrfMap(scored, "chunkId", "keywordScore");

  const fused = scored
    .map((item) => ({
      ...item,
      fusedScore: Number(
        ((vectorRanks.get(item.chunkId) || 0) + (keywordRanks.get(item.chunkId) || 0)).toFixed(6),
      ),
    }))
    .sort((left, right) => right.fusedScore - left.fusedScore);

  const perSourceCounter = new Map();
  const selected = [];
  for (const item of fused) {
    const sourceKey = `${item.collectionId}:${item.sourcePath}`;
    const used = perSourceCounter.get(sourceKey) || 0;
    if (used >= 2) {
      continue;
    }
    perSourceCounter.set(sourceKey, used + 1);
    selected.push(item);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}
