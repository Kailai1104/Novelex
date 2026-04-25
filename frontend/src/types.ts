export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export type MainSection = "overview" | "plan" | "write" | "chapters";
export type SideTab = "project" | "resources" | "documents" | "history";
export type MutationAction =
  | "project_create"
  | "project_delete"
  | "project_save"
  | "provider_save"
  | "project_style_save"
  | "style_generate"
  | "style_update"
  | "rag_create"
  | "project_rag_save"
  | "rag_rebuild"
  | "opening_create"
  | "project_opening_save"
  | "opening_rebuild"
  | "plan_run"
  | "plan_review"
  | "write_run"
  | "chapter_review"
  | "chapter_manual_edit"
  | "chapter_delete";

export type PlanReviewTarget = "plan_draft" | "plan_final";
export type WriteReviewTarget = "chapter_outline" | "chapter";
export type ReviewTarget = PlanReviewTarget | WriteReviewTarget;

export interface ActiveOperation {
  action: string;
  startedAt: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  genre: string;
  updatedAt: string | null;
  planStatus: string;
  writeStatus: string;
  path: string;
}

export interface PendingReviewInfo extends JsonObject {
  chapterId?: string;
  target?: string;
}

export interface ProjectConfig extends JsonObject {
  title: string;
  genre: string;
  setting: string;
  premise: string;
  theme: string;
  styleNotes: string;
  researchNotes: string;
  protagonistGoal: string;
  totalChapters: number;
  targetWordsPerChapter: number;
  stageCount: number;
  styleFingerprintId?: string | null;
  ragCollectionIds?: string[];
  openingCollectionIds?: string[];
}

export interface ProjectState extends JsonObject {
  project: ProjectConfig;
  providerMode?: string;
  providerConfig?: JsonObject;
  phase: {
    plan: {
      status: string;
      lastRunId?: string;
      lockedAt?: string;
      pendingReview?: PendingReviewInfo | null;
    } & JsonObject;
    write: {
      status: string;
      lastRunId?: string;
      currentChapterNumber?: number;
      pendingReview?: PendingReviewInfo | null;
    } & JsonObject;
  };
}

export interface ProviderChoice {
  id: string;
  name: string;
  wireApi?: string;
  baseUrl?: string;
  responseModel?: string;
  reviewModel?: string;
  codexResponseModel?: string;
  hasApiKey?: boolean;
}

export interface AgentModelRuntime extends JsonObject {
  slot?: string;
  providerId?: string;
  providerName?: string;
  model?: string;
  apiStyle?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  supportsNativeWebSearch?: boolean;
}

export interface ProviderRuntime extends JsonObject {
  configuredMode?: string;
  effectiveMode?: string;
  apiStyle?: string;
  hasApiKey?: boolean;
  baseUrl?: string;
  responseModel?: string;
  reviewModel?: string;
  codexResponseModel?: string;
  reasoningEffort?: string;
  providerId?: string;
  providerName?: string;
  configSource?: string;
  configPath?: string;
  configLoaded?: boolean;
  configError?: string | null;
  availableProviders?: ProviderChoice[];
  agentModels?: {
    primary?: AgentModelRuntime;
    secondary?: AgentModelRuntime;
  };
}

export interface RunStep extends JsonObject {
  id?: string;
  label?: string;
  status?: string;
  summary?: string;
  preview?: string;
}

export interface RunRecord extends JsonObject {
  id: string;
  phase: string;
  target?: string;
  summary?: string;
  startedAt?: string;
  steps?: RunStep[];
}

export interface ChapterMeta extends JsonObject {
  chapter_id: string;
  title?: string;
  stage?: string;
  time_in_story?: string;
  pov_character?: string;
  location?: string;
  next_hook?: string;
  summary_50?: string;
  summary_200?: string;
  word_count?: number;
  emotional_tone?: string;
  characters_present?: string[];
}

export interface DocumentEntry {
  id: string;
  label: string;
  scope: string;
  modifiedAt: string;
}

export interface StyleFingerprintSummary {
  id: string;
  name: string;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
  stats?: {
    characterCount?: number;
    paragraphCount?: number;
    approxWordCount?: number;
  };
}

export interface StyleFingerprintDetail {
  metadata: StyleFingerprintSummary;
  sampleMarkdown: string;
  fingerprint: JsonValue;
  promptMarkdown: string;
}

export interface CollectionSourceFile {
  path: string;
  encoding?: string;
  size?: number;
  chunkCount?: number;
}

export interface RagCollection {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  collectionId?: string;
  sourceDir?: string;
  sourceDirRelative?: string;
  chunksPath?: string;
  fileCount?: number;
  chunkCount?: number;
  lastBuiltAt?: string | null;
  lastError?: string;
  sourceFiles?: CollectionSourceFile[];
  encodings?: string[];
}

export interface OpeningCollection extends RagCollection {}

export interface WorkspaceSnapshot {
  serverTime?: string;
  projectId?: string | null;
  project: ProjectState;
  provider: ProviderRuntime;
  runs: {
    plan: RunRecord[];
    write: RunRecord[];
  };
  staged: {
    planDraft?: JsonValue | null;
    planFinal?: JsonValue | null;
    pendingChapter?: JsonValue | null;
  };
  committed: {
    outline?: string;
    worldbuilding?: string;
    structure?: string;
    styleGuide?: string;
    worldState?: JsonValue | null;
    foreshadowingRegistry?: JsonValue | null;
    factLedger?: JsonValue | null;
  };
  chapters: ChapterMeta[];
  documents: DocumentEntry[];
  styleFingerprints: StyleFingerprintSummary[];
  ragCollections: RagCollection[];
  openingCollections: OpeningCollection[];
}

export interface StateResponse {
  projects: ProjectSummary[];
  projectId: string | null;
  state: WorkspaceSnapshot | null;
  activeOperation?: ActiveOperation | null;
  result?: JsonValue;
  styleFingerprint?: StyleFingerprintDetail;
  collection?: JsonValue;
}

export interface DocumentResponse {
  path: string;
  content: string;
}

export interface StyleFingerprintDetailResponse {
  projectId?: string | null;
  styleFingerprint: StyleFingerprintDetail;
  activeOperation?: ActiveOperation | null;
}

export interface OutlineOptions {
  variantCount: number;
  diversityPreset: string;
}

export interface PartialSelectionPayload {
  selectedText: string;
  prefixContext: string;
  suffixContext: string;
}

export interface ProjectSavePayload {
  title?: string;
  genre?: string;
  setting?: string;
  premise?: string;
  theme?: string;
  styleNotes?: string;
  researchNotes?: string;
  protagonistGoal?: string;
  totalChapters?: string | number;
  targetWordsPerChapter?: string | number;
  stageCount?: string | number;
}

export interface ProviderConfigPayload {
  primaryProviderId?: string;
  primaryModel?: string;
  secondaryProviderId?: string;
  secondaryModel?: string;
}

export interface CollectionBindingPayload {
  ragCollectionIds?: string[];
  openingCollectionIds?: string[];
}

export interface StyleFingerprintUpdatePayload {
  styleId?: string;
  name?: string;
  promptMarkdown?: string;
}

export interface PlanReviewPayload {
  target: PlanReviewTarget;
  approved: boolean;
  feedback?: string;
}

export interface WriteReviewPayload {
  target: WriteReviewTarget;
  approved: boolean;
  feedback?: string;
  reviewAction?: string;
  approvalOverrideAcknowledged?: boolean;
  selectedProposalId?: string;
  selectedSceneRefs?: string[];
  authorNotes?: string;
  outlineOptions?: OutlineOptions;
  selection?: PartialSelectionPayload | null;
}

export interface OutlineWorkbenchState {
  sceneRefs: string[];
}

export interface PartialRevisionWorkbenchState {
  selectedText: string;
  prefixContext: string;
  suffixContext: string;
  feedback: string;
}

export interface DirectEditWorkbenchState {
  isEditing: boolean;
  sourceBody: string;
  draftBody: string;
}

export interface ToastState {
  visible: boolean;
  message: string;
}
