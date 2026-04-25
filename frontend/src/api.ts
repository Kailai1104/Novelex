import type {
  CollectionBindingPayload,
  DocumentResponse,
  OpeningCollection,
  OutlineOptions,
  PlanReviewPayload,
  ProjectSavePayload,
  ProjectSummary,
  ProviderConfigPayload,
  RagCollection,
  RunRecord,
  StateResponse,
  StyleFingerprintDetail,
  StyleFingerprintDetailResponse,
  StyleFingerprintSummary,
  StyleFingerprintUpdatePayload,
  WorkspaceSnapshot,
  WriteReviewPayload,
} from "./types";

function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    ...init,
  });

  const data = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }

  return data as T;
}

function normalizeRunRecords(records: RunRecord[] | undefined | null): RunRecord[] {
  return asArray(records).map((record) => ({
    ...record,
    steps: asArray(record.steps),
  }));
}

function normalizeStyleFingerprintSummaries(
  items: StyleFingerprintSummary[] | undefined | null,
): StyleFingerprintSummary[] {
  return asArray(items).map((item) => ({
    ...item,
    stats: item.stats || {},
  }));
}

function normalizeCollections<T extends RagCollection | OpeningCollection>(items: T[] | undefined | null): T[] {
  return asArray(items).map((item) => ({
    ...item,
    sourceFiles: asArray(item.sourceFiles),
    encodings: asArray(item.encodings),
  }));
}

function normalizeSnapshot(snapshot: WorkspaceSnapshot | null): WorkspaceSnapshot | null {
  if (!snapshot) {
    return null;
  }

  return {
    ...snapshot,
    runs: {
      plan: normalizeRunRecords(snapshot.runs?.plan),
      write: normalizeRunRecords(snapshot.runs?.write),
    },
    chapters: asArray(snapshot.chapters),
    documents: asArray(snapshot.documents),
    styleFingerprints: normalizeStyleFingerprintSummaries(snapshot.styleFingerprints),
    ragCollections: normalizeCollections(snapshot.ragCollections),
    openingCollections: normalizeCollections(snapshot.openingCollections),
    staged: {
      planDraft: snapshot.staged?.planDraft ?? null,
      planFinal: snapshot.staged?.planFinal ?? null,
      pendingChapter: snapshot.staged?.pendingChapter ?? null,
    },
    committed: {
      outline: snapshot.committed?.outline || "",
      worldbuilding: snapshot.committed?.worldbuilding || "",
      structure: snapshot.committed?.structure || "",
      styleGuide: snapshot.committed?.styleGuide || "",
      worldState: snapshot.committed?.worldState ?? null,
      foreshadowingRegistry: snapshot.committed?.foreshadowingRegistry ?? null,
      factLedger: snapshot.committed?.factLedger ?? null,
    },
  };
}

function normalizeStateResponse(payload: StateResponse): StateResponse {
  return {
    ...payload,
    projects: asArray<ProjectSummary>(payload.projects),
    projectId: payload.projectId || null,
    state: normalizeSnapshot(payload.state),
    activeOperation: payload.activeOperation || null,
  };
}

function normalizeStyleFingerprintDetail(detail: StyleFingerprintDetail): StyleFingerprintDetail {
  return {
    ...detail,
    metadata: {
      ...detail.metadata,
      stats: detail.metadata?.stats || {},
    },
    sampleMarkdown: detail.sampleMarkdown || "",
    promptMarkdown: detail.promptMarkdown || "",
    fingerprint: detail.fingerprint ?? {},
  };
}

export async function getWorkspaceState(projectId: string | null): Promise<StateResponse> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return normalizeStateResponse(await requestJson<StateResponse>(`/api/state${query}`));
}

export async function getDocument(projectId: string, documentPath: string): Promise<DocumentResponse> {
  return requestJson<DocumentResponse>(
    `/api/document?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(documentPath)}`,
    { headers: { Accept: "application/json" } },
  );
}

export async function getStyleFingerprint(
  projectId: string,
  styleId: string,
): Promise<StyleFingerprintDetailResponse> {
  const payload = await requestJson<StyleFingerprintDetailResponse>(
    `/api/style-fingerprint?projectId=${encodeURIComponent(projectId)}&styleId=${encodeURIComponent(styleId)}`,
    { headers: { Accept: "application/json" } },
  );

  return {
    ...payload,
    projectId: payload.projectId || null,
    activeOperation: payload.activeOperation || null,
    styleFingerprint: normalizeStyleFingerprintDetail(payload.styleFingerprint),
  };
}

export async function postWorkspaceAction<T extends StateResponse = StateResponse>(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<T> {
  return normalizeStateResponse(
    await requestJson<T>(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  ) as T;
}

export async function deleteWorkspaceAction<T extends StateResponse = StateResponse>(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<T> {
  return normalizeStateResponse(
    await requestJson<T>(endpoint, {
      method: "DELETE",
      body: JSON.stringify(payload),
    }),
  ) as T;
}

export async function createProject(name: string) {
  return postWorkspaceAction("/api/projects", { name });
}

export async function deleteProject(projectId: string) {
  return deleteWorkspaceAction(`/api/projects?projectId=${encodeURIComponent(projectId)}`, { projectId });
}

export async function saveProject(projectId: string, payload: ProjectSavePayload) {
  return postWorkspaceAction("/api/project", { projectId, ...payload });
}

export async function saveProviderConfig(projectId: string, payload: ProviderConfigPayload) {
  return postWorkspaceAction("/api/provider/config", { projectId, ...payload });
}

export async function generateStyleFingerprint(projectId: string, payload: { name?: string; sampleText?: string }) {
  return postWorkspaceAction("/api/style-fingerprints/generate", { projectId, ...payload });
}

export async function saveProjectStyle(projectId: string, styleFingerprintId: string) {
  return postWorkspaceAction("/api/project/style", { projectId, styleFingerprintId });
}

export async function updateStyleFingerprint(projectId: string, payload: StyleFingerprintUpdatePayload) {
  return postWorkspaceAction("/api/style-fingerprint/update", { projectId, ...payload });
}

export async function createRagCollection(projectId: string, name: string) {
  return postWorkspaceAction("/api/rag/collections", { projectId, name });
}

export async function saveProjectRagBindings(projectId: string, payload: CollectionBindingPayload) {
  return postWorkspaceAction("/api/project/rag", { projectId, ragCollectionIds: payload.ragCollectionIds || [] });
}

export async function rebuildRagCollection(projectId: string, collectionId: string) {
  return postWorkspaceAction("/api/rag/rebuild", { projectId, collectionId });
}

export async function createOpeningCollection(projectId: string, name: string) {
  return postWorkspaceAction("/api/opening/collections", { projectId, name });
}

export async function saveProjectOpeningBindings(projectId: string, payload: CollectionBindingPayload) {
  return postWorkspaceAction("/api/project/openings", {
    projectId,
    openingCollectionIds: payload.openingCollectionIds || [],
  });
}

export async function rebuildOpeningCollection(projectId: string, collectionId: string) {
  return postWorkspaceAction("/api/opening/rebuild", { projectId, collectionId });
}

export async function runPlan(projectId: string) {
  return postWorkspaceAction("/api/plan/run", { projectId });
}

export async function reviewPlan(projectId: string, payload: PlanReviewPayload) {
  return postWorkspaceAction("/api/plan/review", { projectId, ...payload });
}

export async function runWrite(projectId: string, outlineOptions: OutlineOptions) {
  return postWorkspaceAction("/api/write/run", { projectId, outlineOptions });
}

export async function reviewWrite(projectId: string, payload: WriteReviewPayload) {
  return postWorkspaceAction("/api/write/review", { projectId, ...payload });
}

export async function saveManualChapterEdit(projectId: string, chapterBody: string) {
  return postWorkspaceAction("/api/write/manual-edit", { projectId, chapterBody });
}

export async function deleteLockedChapter(projectId: string, chapterId: string) {
  return postWorkspaceAction("/api/write/delete", { projectId, chapterId });
}
