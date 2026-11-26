import type { ChartData } from '$lib/utils/chart-data';
import type { ChartType } from '$lib/utils/chart-types';
import type { HomeRuntimeMeta } from '$shared/home-runtime';
import type { IndexedDocument, SearchResult, SlideData } from '$lib/types/bridge';
import type { AgentActivityKey, CodeChild, CodeRunSummary, CodeSpend, CodeStopReason, CodeTodoItem, HomeStopReason } from '$shared/agente-protocol';
import type { Attachment as CodeAttachment } from '$shared/agente-protocol.gen';

/** One entry of a Code run's transcript, in arrival order. */
/** A Code run in arrival order: what it said, what it thought, what it did. */
export type CodeTimelineEntry = { kind: 'text'; text: string } | { kind: 'thinking'; text: string } | { kind: 'step'; id: string };

export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
  preview?: string;
  base64?: string;   // data: URL for images used in vision API calls
  data?: string;     // Blob URL or data URL for document content (for inline preview)
  kind?: 'image' | 'document';
  status?: 'ready' | 'processing' | 'error';
  docId?: string;
  ocrText?: string;  // Extracted text from OCR (images, scanned PDFs)
  processingMode?: 'vision' | 'ocr' | 'document_text' | 'transcription';
  warning?: string;
  visionReady?: boolean;
  error?: string;
}

export interface MessageVersion {
  content: string;
  reasoning?: string;
  createdAt: number;
  /**
   * The sources this version's answer cites; its `[n]` markers index into
   * them. Absent on versions saved before sources moved here, which fall
   * back to the message's list.
   */
  sources?: SearchResult[];
  metadata?: {
    /** Optional reaction chosen by the Home agent for a user message. */
    agentReaction?: string;
    modelName?: string;
    tokens?: number;
    timing?: number;
    tokensPerSecond?: number;
    modelTimingSeconds?: number;
    totalElapsedSeconds?: number;
    reasoningTimingSeconds?: number;
    usageSource?: 'provider' | 'runtime' | 'estimated' | 'none';
    timingScope?: 'model' | 'agent_wall' | 'reasoning' | 'unknown';
    homeConversationIndex?: number;
    homeSessionId?: string;
    homeRevision?: number;
    inputTokens?: number;
    outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
    totalTokens?: number;
    promptEvalTimingSeconds?: number;
    executionBackend?: 'local' | 'api';
    executionTransport?: 'local_runtime' | 'provider_ipc' | 'sdk';
    error?: boolean;
    errorMessage?: string;
    warning?: string;
    outcome?: AgentOutcome;
    stopReason?: AgentStopReason;
    /** Why a Code-space agent run ended (the agente loop's StopReason). */
    codeStopReason?: CodeStopReason;
    /** The Code run stopped because its turn budget ran out, not because it finished. */
    codeHitTurnLimit?: boolean;
    /** Text and tool steps of a Code run in the order they happened. */
    codeTimeline?: CodeTimelineEntry[];
    /** The model's task list as it stood when the run ended. */
    codeTodos?: CodeTodoItem[];
    /** Wall time of the Code run. */
    codeElapsedMs?: number;
    /** A system note in the transcript (e.g. "Restored files to before turn 3"). */
    codeNote?: string;
    codeChildren?: CodeChild[];
    codeSpend?: CodeSpend;
    codeUsage?: CodeRunSummary['usage'];
    codeDiagnostics?: string[];
    codeConversationIndex?: number;
    codeCompaction?: { running: boolean; success?: boolean; tokensBefore?: number; tokensAfter?: number; summary?: string; smart?: boolean; requestedSmart?: boolean; modelTokens?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; error?: string };
    codeAttachments?: CodeAttachment[];
    /** Sent while a Code run was busy and not yet taken by the model. */
    codeQueued?: boolean;
    currentActivity?: AgentActivity;
    activityLabel?: string;
    publicFallback?: boolean;
    diagnosticsRedacted?: boolean;
    documentSurface?: { kind: 'report' | 'documents'; title?: string; primaryFile?: string };
    workProduct?: { id: string; kind: WorkProductKind; title: string; primaryFile?: string; status?: WorkProductStatus };
    /** Roleplay-only versioned state; persisted by the existing metadata path. */
    roleplay?: RoleplayTurnSnapshot;
    roleplayPersona?: { id: string | null; name: string; avatar?: string };
  };
}

export type AgentOutcome = 'completed' | 'partial' | 'stopped' | 'failed';
/**
 * Canonical definitions live in $shared/agente-protocol (single owner shared
 * with the engine); aliased here so existing imports keep working.
 */
export type AgentStopReason = HomeStopReason;
export type AgentActivity = AgentActivityKey;

export interface SearchMeta {
  searchRequested: boolean;
  searchSucceeded: boolean;
  contextAvailable: boolean;
  sourceCount: number;
  requestedProvider?: string | null;
  providerUsed?: string | null;
  searchFallbackReason?: string;
  providerWarnings?: string[];
  searchError?: string;
  researchTaskId?: string | null;
  researchStatus?: 'queued' | 'awaiting_input' | 'searching' | 'crawling' | 'synthesizing' | 'completed' | 'failed' | 'cancelled' | null;
  researchSummary?: string | null;
  researchStats?: {
    pagesCrawled?: number;
    pagesDiscovered?: number;
    maxDepthReached?: number;
    truncated?: boolean;
  } | null;
  providerAttempts?: Array<{ provider: string; success: boolean; resultCount: number; error?: string }>;
  scrapeStats?: { attempted: number; success: number; blocked: number; thinContent: number };
  stopReason?: AgentStopReason;
}

export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  type: string;
  status: 'ready' | 'skipped' | 'error';
  docId?: string;
  reason?: string;
}

export interface WorkspaceContext {
  rootName: string;
  rootPath?: string;
  attachedAt: number;
  fileCount: number;
  indexedCount: number;
  skippedCount: number;
  files: WorkspaceFile[];
}

export interface WorkContextMeta {
  rootName: string;
  fileCount: number;
  indexedCount: number;
}

export interface AgentStep {
  id: string;
  type: 'thinking' | 'planning' | 'searching' | 'reading' | 'coding' | 'writing' | 'executing' | 'preview' | 'tool' | 'approval' | 'done' | 'error';
  label: string;
  /** The tool behind a tool step (labels are translated; logic keys on this). */
  toolName?: string;
  status: 'pending' | 'running' | 'awaiting_approval' | 'done' | 'error';
  detail?: string;
  /** Tool arguments as received from the runtime, for the expandable trace. */
  toolInput?: string;
  output?: string;
  fileChanges?: CodeAgentFileChange[];
  diffStats?: CodeAgentDiffStat[];
  /** Web research steps: what was searched or read, for the research widget. */
  research?: { query?: string; results?: number; url?: string; title?: string };
  /** The agent's opening sentence before it starts working; shown as text, not as a step. */
  preface?: boolean;
  /**
   * The subagent type a `task` step asked for, so its row can name the kind
   * (Explore, Plan) before the child's card has registered.
   */
  subagentType?: string;
  /**
   * The child this `task` step spawned. The runtime never reports the parent's
   * tool call id, so the link is made in the renderer when the child appears
   * (see `linkChildToStep`).
   */
  subagentId?: string;
  /** When the step started, and how long it took once it ended (Code space). */
  startedAt?: number;
  durationMs?: number;
  /**
   * The model that did this step's work, when it is not the conversation's own:
   * the child a spawn runs on, or the checkpoint writer a compaction used.
   */
  model?: string;
}

export type ChartArtifactPayload = ChartData & {
  kind: 'chart';
  title: string;
  chartType: ChartType;
};

export type MapArtifactPayload = {
  kind: 'map';
  title: string;
  latitude: number;
  longitude: number;
  zoom: number;
  markers: Array<{ lat?: number; lng?: number; label?: string; popup?: string }>;
  polylines: Array<{ coords?: Array<{ lat?: number; lng?: number }>; color?: string; weight?: number; label?: string } | Array<{ lat?: number; lng?: number }>>;
};

export type DiagramArtifactPayload = {
  kind: 'diagram';
  title: string;
  diagramType?: string;
  source: string;
};

export type DashboardArtifactPayload = {
  kind: 'dashboard';
  title: string;
  subtitle?: string;
  metrics: Array<{ label?: string; value?: string | number; trend?: string; unit?: string; color?: string }>;
  sections: Array<{ heading?: string; content?: string }>;
  charts?: ChartArtifactPayload[];
};

/** Weather / status / short fact packs — chart-style in-chat card. */
export type InfoCardArtifactPayload = {
  kind: 'info_card';
  title: string;
  subtitle?: string;
  rows: Array<{ label: string; value: string; hint?: string }>;
  footer?: string;
  accent?: string;
};

/** Small self-contained HTML snippet rendered in chat (no CDN / network). */
export type HtmlCardArtifactPayload = {
  kind: 'html_card';
  title: string;
  html: string;
  /** Present on interactive widgets (create_widget): runs in a sealed, offline frame. */
  script?: string;
};

/* ── Lessons ────────────────────────────────────────────────────────────────
 * An interactive teaching artifact (Home only). The model supplies data; the
 * app owns the interaction, the feedback and the layout. There is deliberately
 * no score, streak or progress field anywhere in this payload.
 */
export type LessonCalloutTone = 'why' | 'try' | 'careful';

export interface LessonChoice {
  text: string;
  correct?: boolean;
  /** Why this option is right/wrong — the only feedback a lesson gives. */
  why?: string;
  /** Optional expression rendered as a miniature curve in `visual_choice` blocks. */
  plot?: string;
}

export interface LessonVariable {
  key: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}

export interface LessonOutput {
  key: string;
  label: string;
  expression: string;
  unit?: string;
  format?: 'number' | 'percent' | 'currency' | 'compact';
}

export interface LessonModel {
  variables: LessonVariable[];
  outputs: LessonOutput[];
  plot?: {
    expression: string;
    variable: string;
    label?: string;
    xLabel?: string;
    yLabel?: string;
    from?: number;
    to?: number;
    samples?: number;
  };
}

export type LessonBlock =
  | { type: 'pretest'; prompt: string; formula?: string; choices?: LessonChoice[]; numeric?: { answer: number; tolerance?: number; unit?: string }; answer?: string; why?: string }
  | { type: 'explore'; prompt: string; model: LessonModel; insight?: string }
  | { type: 'predict'; prompt: string; expression?: string; series?: Array<{ x: number; y: number }>; xRange: [number, number]; yRange?: [number, number]; label?: string; insight?: string }
  | { type: 'choice'; prompt: string; formula?: string; choices: LessonChoice[]; hint?: string }
  | { type: 'visual_choice'; prompt: string; formula?: string; choices: LessonChoice[]; hint?: string }
  | { type: 'graph_challenge'; prompt: string; expression: string; xRange?: [number, number]; initialX?: number; metric?: 'slope' | 'value'; target: number; tolerance?: number; explanation?: string; hint?: string }
  | { type: 'hotspot_diagram'; prompt?: string; pins: Array<{ id: string; label: string; role?: string; description: string; x: number; y: number }> }
  | { type: 'timeline_story'; prompt?: string; eras: Array<{ year: string; title: string; trigger: string; unlocked: string }> }
  | { type: 'algo_stepper'; prompt?: string; data: Array<string | number>; steps: Array<{ low?: number; mid?: number; high?: number; found?: number; note: string }> }
  | { type: 'numeric'; prompt: string; formula?: string; answer: number; tolerance?: number; unit?: string; hint?: string }
  | { type: 'steps'; prompt: string; steps: Array<{ formula?: string; note: string }> }
  | { type: 'reveal'; prompt: string; body: string; tone?: LessonCalloutTone }
  | { type: 'figure'; prompt?: string; chart?: ChartArtifactPayload; diagram?: DiagramArtifactPayload; infoCard?: InfoCardArtifactPayload }
  | { type: 'summary'; points: string[]; next?: string[] };

export type LessonArtifactPayload = {
  kind: 'lesson';
  title: string;
  subtitle?: string;
  subject?: string;
  mode: 'lesson' | 'practice';
  blocks: LessonBlock[];
};

export type Scene3DArtifactPayload = {
  kind: 'scene_3d';
  title: string;
  subtitle?: string;
  preset: 'dna' | 'molecule' | 'orbit' | 'exploded_stack' | 'surface' | 'custom';
  paramLabel?: string;
  paramValue?: number;
  takeaway?: string;
  layers?: Array<{ label: string; accent?: boolean }>;
  nodes?: Array<{ id?: string; x: number; y: number; z: number; label?: string; radius?: number; accent?: boolean }>;
  edges?: Array<{ from: number | string; to: number | string; accent?: boolean }>;
  autoRotate?: boolean;
};

export type InlineArtifactPayload =
  | ChartArtifactPayload
  | MapArtifactPayload
  | DiagramArtifactPayload
  | DashboardArtifactPayload
  | InfoCardArtifactPayload
  | HtmlCardArtifactPayload
  | LessonArtifactPayload
  | Scene3DArtifactPayload;

export type ArtifactKind =
  | 'report'
  | 'work_product'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'chart'
  | 'diagram'
  | 'map'
  | 'dashboard'
  | 'info_card'
  | 'html_card'
  | 'widget'
  | 'lesson'
  | 'scene_3d'
  | 'research_package'
  | 'web'
  | 'files';

export type ArtifactPresentation = 'inline' | 'document' | 'web' | 'files';
export type ArtifactStatus = 'ready' | 'partial' | 'invalid';
export type ArtifactIssueSeverity = 'warning' | 'error';

export interface ArtifactIssue {
  code: string;
  severity: ArtifactIssueSeverity;
  message: string;
  path?: string;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  kind: ArtifactKind;
  presentation: ArtifactPresentation;
  entryPath?: string;
  status: ArtifactStatus;
  issues?: ArtifactIssue[];
}

export interface AgentArtifact {
  title: string;
  files: Record<string, string>;
  previewHtml?: string | null;
  inline?: InlineArtifactPayload | null;
  workProduct?: GeneratedWorkProduct | null;
  /** Additive metadata for deterministic rendering. Missing manifests are normalized lazily. */
  manifest?: ArtifactManifest | null;
}

export type WorkProductKind = 'report' | 'documents' | 'spreadsheet' | 'presentation' | 'bundle';
export type WorkProductStatus = 'creating' | 'ready' | 'partial' | 'failed';

export type CodeAgentDriverKind =
  | 'agente'
  | 'acp'
  | 'claude'
  | 'codex'
  | 'custom'
  | 'chatea'
  | 'chatea-agent'
  | 'cursor'
  | 'opencode'
  | 'pi';
export type CodeAgentInstanceId = string;
export type CodeAgentProviderId = CodeAgentInstanceId;
export type CodeAgentProviderStatus = 'ready' | 'missing' | 'login' | 'soon' | 'disabled';
export type CodeAgentRuntimeMode = 'full' | 'supervised' | 'plan';

export interface CodeAgentSessionMeta {
  draftAttachments?: CodeAttachment[];
  instanceId: CodeAgentInstanceId;
  driverKind?: CodeAgentDriverKind;
  driverModel?: string | null;
  driverEffort?: string | null;
  providerId?: CodeAgentProviderId;
  status?: CodeAgentProviderStatus;
  runtimeMode?: CodeAgentRuntimeMode;
  substrate?: 'native' | 'pi';
  sessionId?: string;
  worktree?: import('$shared/agente-protocol').SessionWorktree | null;
  checkpointsEnabled?: boolean;
  updatedAt: number;
}

export type CodeAgentFileChangeKind = 'created' | 'modified' | 'deleted';

export interface CodeAgentFileChange {
  path: string;
  kind: CodeAgentFileChangeKind;
}

export interface CodeAgentDiffStat {
  path: string;
  kind: CodeAgentFileChangeKind;
  additions: number;
  deletions: number;
  before?: string;
  after?: string;
  /** Unified diff of the change (hunks with context), when the engine reported one. */
  patch?: string;
}

export interface GeneratedWorkProductFile {
  path: string;
  title?: string;
  mime?: string;
  kind?: 'markdown' | 'html' | 'docx' | 'xlsx' | 'pdf' | 'pptx' | 'csv' | 'text';
  previewPath?: string;
}

export interface GeneratedWorkProduct {
  id: string;
  title: string;
  kind: WorkProductKind;
  status: WorkProductStatus;
  files: GeneratedWorkProductFile[];
  sourceIds?: string[];
  evidenceMap?: Record<string, string[]>;
  warnings?: string[];
  createdAt: number;
}

export interface CreatedFile {
  path: string;
  name: string;
  fullPath?: string;
}

export interface TtsAudioMeta {
  duration: number;
  voice: string;
  generatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  createdAt: number;
  model?: string;
  metadata?: MessageVersion['metadata'];
  done?: boolean;
  status?: 'idle' | 'streaming' | 'error';
  attachments?: Attachment[];
  versions?: MessageVersion[];
  activeVersion?: number;
  sources?: SearchResult[];
  searchMeta?: SearchMeta | null;
  ragDocuments?: IndexedDocument[];
  searchMode?: 'chat' | 'search' | 'deep' | 'max';
  slides?: SlideData[];
  mode?: 'chat' | 'slides' | 'instant' | 'agent';
  /** Roleplay group chats: which character authored an assistant turn. */
  speakerId?: string | null;
  /** Roleplay adventure choices offered at the end of this turn. */
  choices?: string[];
  /** Roleplay props the turn put in the user's hands. */
  props?: RoleplayProp[];
  /** Set on a turn the user did not write: a thrown twist, a beat of silence. */
  storyTurn?: RoleplayStoryTurn;
  agentSteps?: AgentStep[];
  /**
   * The last artifact the turn produced. Retained because chats persisted before
   * artifacts became a list only have this field, and much of the UI still asks for
   * a single artifact. Read through `artifactsForMessage` to get the full set.
   */
  artifact?: AgentArtifact | null;
  /** Every artifact the turn produced, oldest first. Absent on older messages. */
  artifacts?: AgentArtifact[];
  workContext?: WorkContextMeta | null;
  filesCreated?: CreatedFile[];
  ttsAudio?: TtsAudioMeta | null;
}

// ── Reasoning levels ───────────────────────────────────────────────────
// One profile per model from the shared Rust core (agente_core::thinking),
// the same one Agente Code's TUI shows — never guessed from model names here.
// The UI only shows the selector when `supported: true` with a known `source`.

export type ReasoningLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'max'
  | 'xhigh'
  | 'enabled'
  | 'disabled'
  | 'on'
  | 'none'
  | 'default'; // Groq Qwen reasoning_effort

export interface ReasoningCapabilities {
  /** Renderer-only provenance; prevents a prior route's scale appearing. */
  route?: string;
  /** Auto plus at least one level to choose. */
  supported: boolean;
  /** Concrete choices, low → high; Auto is implied. */
  levels: ReasoningLevel[];
  source: 'catalog' | 'live' | 'template' | 'unknown';
  /** What Auto resolves to, when the provider says. */
  default?: ReasoningLevel;
  /** The model always thinks — there is no Off. */
  mandatory?: boolean;
  /** Thinking-token budget of the levels that have one (the rest are sized by the provider). */
  budgets?: Partial<Record<ReasoningLevel, number>>;
}

export interface ReasoningRequest {
  level: ReasoningLevel;
  budgetTokens?: number;
}

export interface ChatFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

// ── Roleplay ───────────────────────────────────────────────────────────
// Character Card V2/V3-compatible shapes. Field names mirror the community
// spec so imported cards round-trip; the UI may only render a subset.

export type CharacterAssetType = 'icon' | 'background' | 'user_icon' | 'emotion' | string;

export interface CharacterAsset {
  type: CharacterAssetType;
  /** Data URL or `ccdefault:` for the card's own image. */
  uri: string;
  name?: string;
  ext?: string;
}

export interface LorebookEntry {
  id: string;
  keys: string[];
  /** Required in addition to `keys` when `selective` is set. */
  secondaryKeys?: string[];
  selective?: boolean;
  /** How `secondaryKeys` combine: any (default), all, none, or not-all. */
  secondaryLogic?: 'and_any' | 'and_all' | 'not_any' | 'not_all';
  /** Always injected regardless of keys (within token budget). */
  constant?: boolean;
  content: string;
  enabled: boolean;
  insertionOrder: number;
  caseSensitive?: boolean;
  useRegex?: boolean;
  priority?: number;
  position?: 'before_char' | 'after_char';
  comment?: string;
}

export interface CharacterBook {
  name?: string;
  description?: string;
  scanDepth?: number;
  tokenBudget?: number;
  recursiveScanning?: boolean;
  entries: LorebookEntry[];
}

export interface CharacterCard {
  id: string;
  name: string;
  nickname?: string;
  aliases?: string[];
  tagline?: string;
  /** Data URL or local file path. */
  avatar?: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  alternateGreetings: string[];
  /** V3: greetings only offered inside group chats. */
  groupOnlyGreetings: string[];
  exampleDialogue: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  creatorNotes?: string;
  tags: string[];
  creator?: string;
  characterVersion?: string;
  spec?: 'chara_card_v2' | 'chara_card_v3' | 'flaxeo';
  assets?: CharacterAsset[];
  book?: CharacterBook | null;
  /** Kokoro/engine voice id used for this character's replies. */
  voiceId?: string | null;
  voice?: import('$shared/speech').VoiceAssignment | null;
  /** Group chats: 0 (never speaks unless mentioned) … 100 (always replies). */
  talkativeness?: number;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  createdAt: number;
  updatedAt: number;
}

/** The user's own character in a roleplay — who the model is talking to. */
export interface UserPersona {
  id: string;
  name: string;
  description: string;
  avatar?: string;
  isDefault?: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * A thing the scene produced, or something the user pinned: a handout, a note,
 * a lead being chased, a bond. Props arrive here from replies; notes are typed
 * by hand. This is the scene's journal — the campaign book for one chat.
 */
export interface RoleplayJournalEntry {
  id: string;
  kind: 'prop' | 'note' | 'quest' | 'bond';
  title: string;
  body: string;
  pinned?: boolean;
  /** The turn that produced it, for props that came out of a reply. */
  messageId?: string | null;
  createdAt: number;
}

export const ROLEPLAY_PROP_KINDS = ['letter', 'note', 'map', 'document', 'object', 'photo'] as const;
export type RoleplayPropKind = (typeof ROLEPLAY_PROP_KINDS)[number];

/**
 * A thing the scene put in the user's hands.
 *
 * A roleplay artifact: no manifest, no work product, no artifact studio. The
 * kind says what it physically is so the card and the viewer can treat it as
 * one.
 */
export interface RoleplayProp {
  title: string;
  kind: RoleplayPropKind;
  body: string;
}

/** The mark left by a turn the user did not write. */
export interface RoleplayStoryTurn {
  label: string;
  kind?: string;
  intensity?: string;
}

/** How a group scene picks who speaks next. */
export type RoleplayReplyOrder = 'list' | 'natural' | 'mention' | 'manual';

/** Defaults a world applies to scenes started from it. */
export interface WorldSettings extends RoleplayOptions {
  replyOrder?: RoleplayReplyOrder;
  /** Let characters keep talking without a user turn. */
  autoMode?: boolean;
  /** Consecutive character turns before auto-mode pauses. */
  autoModeMaxTurns?: number;
  /** Pause between auto-mode turns, in milliseconds. */
  autoModeDelayMs?: number;
  /** End replies with clickable suggested actions. */
  adventureChoices?: boolean;
  /** Seconds a choice panel waits before the moment passes. Absent = no timer. */
  choiceTimerSeconds?: number | null;
  /** Default: let a reply hand the user a prop. */
  props?: boolean;
  /** Keep `Name:` prefixes in replies instead of stripping them. */
  showSpeakerLabels?: boolean;
  /** Allow a single generation to voice several characters. */
  allowMultiSpeaker?: boolean;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  authorNote?: string;
  contentRating?: 'sfw' | 'unrestricted';
}

/**
 * A reusable scene kit: setting, canon and cast.
 *
 * Chats are timelines and own their memory; the world is what carries over
 * between them — lorebook, roster, openings and defaults.
 */
export interface RoleplayWorld {
  id: string;
  name: string;
  tagline?: string;
  /** Always-present setting and rules. */
  overview: string;
  /** Opening situation; used when no cast card defines a scenario. */
  scenario?: string;
  avatar?: string;
  book?: CharacterBook | null;
  /** Ordered cast. The first id is the primary speaker. */
  castIds: string[];
  /** World openings offered when a scene starts. */
  starters: string[];
  defaultPersonaId?: string | null;
  settings?: WorldSettings;
  createdAt: number;
  updatedAt: number;
}

/** Per-session roleplay state, persisted with the chat. */
export interface RoleplaySettings extends RoleplayOptions {
  /** Group-chat roster. The first id is the primary speaker. */
  characterIds?: string[];
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  /** NovelAI-style note injected near the end of context. */
  authorNote?: string;
  /** How many messages from the end the author note is injected at. */
  authorNoteDepth?: number;
  contentRating?: 'sfw' | 'unrestricted';
  /** Let characters keep talking without a user turn. */
  autoMode?: boolean;
  /** Consecutive character turns before auto-mode pauses. */
  autoModeMaxTurns?: number;
  /** Pause between auto-mode turns, in milliseconds. */
  autoModeDelayMs?: number;
  /** Allow a single generation to voice several characters. */
  allowMultiSpeaker?: boolean;
  /** End replies with clickable suggested actions. */
  adventureChoices?: boolean;
  /** Seconds a choice panel waits before the moment passes. Absent = no timer. */
  choiceTimerSeconds?: number | null;
  /** Let a reply hand the user a prop — a letter, a map, a note. */
  props?: boolean;
  /** Handouts and notes kept beside the thread. */
  journal?: RoleplayJournalEntry[];
  /** Keep `Name:` prefixes in replies instead of stripping them. */
  showSpeakerLabels?: boolean;
  /** Speaker order for group chats. */
  replyOrder?: RoleplayReplyOrder;
  /** Group members muted for this scene. */
  mutedIds?: string[];
  scene?: RoleplaySceneState;
  sceneOrigin?: RoleplaySceneState;
  /** The turn at which the user last adjusted the room manually. */
  sceneAnchorId?: string;
  /** The story so far, kept by the model and editable in the journal. */
  storySummary?: RoleplayStorySummary | null;
}

export interface RoleplayStorySummary {
  text: string;
  /** The last message the summary covers. */
  throughId: string | null;
  updatedAt: number;
}

export interface RoleplayOptions {
  interactionMode?: 'chat' | 'narrative' | 'dynamic';
  replyStyle?: 'dialogue' | 'balanced' | 'narrative';
  replyLength?: 'brief' | 'adaptive' | 'detailed';
  initiative?: 'reactive' | 'balanced' | 'proactive';
  pacing?: 'slow' | 'balanced' | 'fast';
  npcDialogue?: boolean;
  maxExchangeLines?: number;
  surprise?: number;
  twistCooldown?: number;
  choiceMin?: number;
  choiceMax?: number;
  decisionWeights?: Record<string, number>;
  outcomeRolls?: boolean;
  outcomeWeights?: { success: number; cost: number; setback: number };
  showOutcomes?: boolean;
  memoryEnabled?: boolean;
  autoMemory?: boolean;
  memoryBudget?: number;
  /** Update the story summary every this many replies; 0 turns it off. */
  summaryEvery?: number;
  autocomplete?: 'off' | 'mention' | 'automatic';
  nameInsertion?: 'name' | 'nickname';
  choiceExpiry?: 'pause' | 'silence' | 'event';
  genre?: string;
  stakes?: 'gentle' | 'balanced' | 'high';
  rerollEnabled?: boolean;
  sceneNpcs?: boolean;
  showAvatars?: boolean;
  messageDensity?: 'comfortable' | 'compact';
  actionFormatting?: 'emphasis' | 'plain';
  voicePlayback?: boolean;
  /** Local models: `roleplay` applies the roleplay sampler preset, `server` keeps llama-server's defaults. */
  localSampler?: 'roleplay' | 'server';
  /** Local repetition control under the roleplay preset: DRY, or a plain repeat penalty for older builds. */
  repetition?: 'dry' | 'repeat';
}

export interface RoleplaySceneState {
  location: string;
  presentIds: string[];
  npcs: Array<{ id: string; name: string; description: string }>;
  facts: string[];
  goals: string[];
  relationships: string[];
}

export interface RoleplayContribution {
  speakerId: string | null;
  addresseeIds: string[];
  content: string;
}

export interface RoleplayTurnSnapshot {
  /** The only characters permitted to speak, retained across Retry/version changes. */
  participantIds?: string[];
  settled?: boolean;
  persona?: { id: string | null; name: string; avatar?: string };
  mode: 'chat' | 'narrative' | 'dynamic';
  seed: number;
  direction: string;
  instruction: string;
  outcome?: 'success' | 'cost' | 'setback';
  outcomeApplied?: boolean;
  settings: RoleplaySettings;
  sceneBefore: RoleplaySceneState;
  sceneAfter: RoleplaySceneState;
  contributions: RoleplayContribution[];
  choices: string[];
  props: RoleplayProp[];
  storyTurn?: RoleplayStoryTurn;
  /** What the prompt of this turn drew on: the memory the viewer can inspect. */
  recall?: RoleplayRecall;
}

/**
 * What a prompt build carries besides its text. `used` is what the turn drew
 * on: the viewer's "remembered" line and the trims the budget made.
 */
export interface RoleplayUsed {
  /** Lore entry ids that fired and were kept. */
  lore: string[];
  /** Memory items from the story-so-far block: `summary`, `fact:N`, `goal:N`, `relationship:N`. */
  memories: string[];
  /** Pinned journal entry ids that were included. */
  journal: string[];
  /** What the budget removed for this request. Empty when nothing was trimmed. */
  trimmed: RoleplayTrimNote[];
}

export interface RoleplayTrimNote {
  kind: 'examples' | 'lore' | 'descriptions' | 'history';
  /** How many items were removed (characters-shortened cards, dropped lore entries, dropped messages). */
  count?: number;
}

/**
 * Optional trims a budget applies to one build, cheapest first. Absent fields
 * change nothing, so the untrimmed prompt is the one a chat normally sends.
 */
export interface PromptTrim {
  /** Drop the primary's example dialogue. */
  examples?: boolean;
  /** Keep only the first N lore entries, in priority order. */
  loreLimit?: number;
  /** Cut each description and personality to this many characters, plus an ellipsis. */
  descriptionChars?: number;
}

/** The memory one reply was written from: pinned memories, lore that fired, the story summary. */
export interface RoleplayRecall {
  memories: Array<{ id: string; title: string }>;
  lore: Array<{ id: string; title: string }>;
  summary: boolean;
  /** What the budget cut to fit the window, when anything was cut. Only what the prompt actually carried is listed above. */
  trimmed?: RoleplayTrimNote[];
}

/**
 * The space a session belongs to. Immutable after create.
 *
 * Persisted values may be legacy spellings — `'chat'` (old id of home) and
 * `'work'`/`'code'` (old ids of code) — and are normalized on read via
 * `normalizeSpace()` in `$lib/spaces`.
 */
export type ChatContextMode = 'home' | 'code' | 'roleplay' | 'design';

export interface CodeProject {
  id: string;
  rootPath: string;
  rootName: string;
  icon?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SessionComposerMode = 'chat' | 'instant' | 'agent';
export type SessionSearchMode = 'chat' | 'search' | 'deep' | 'max';

export interface ChatModelSelection {
  backendMode: 'local' | 'api';
  provider: string;
  model: string;
  localModel: string;
  localModelPath: string;
  localBaseUrl: string;
}

export interface QueuedPrompt {
  id: string;
  content: string;
  attachments?: Attachment[];
  codeAttachments?: CodeAttachment[];
  /** Locked only after an explicit send-now hands this entry to the engine. */
  sending?: boolean;
}

export interface ChatSession {
  pendingPrompts?: QueuedPrompt[];
  /** Provider and both cloud/local choices are owned by this conversation. */
  modelSelection?: ChatModelSelection | null;
  homeRuntime?: HomeRuntimeMeta;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  folderId: string | null;
  draft: string;
  /** Immutable after create: home | code space identity. */
  contextMode?: ChatContextMode;
  codeAgent?: CodeAgentSessionMeta | null;
  projectId?: string | null;
  workspace?: WorkspaceContext | null;
  reasoningLevel?: ReasoningLevel | null;
  /** Per-chat composer mode; isolated across sessions. */
  composerMode?: SessionComposerMode | null;
  /** Per-chat search depth mode; isolated across sessions. */
  searchMode?: SessionSearchMode | null;
  /** Roleplay: the character this chat was started with (group chat primary). */
  characterId?: string | null;
  /** Roleplay: the world whose canon this scene runs in, when one is bound. */
  worldId?: string | null;
  /** Roleplay: the user persona active in this chat. */
  personaId?: string | null;
  /** Roleplay: which greeting seeded the opening message. */
  greetingIndex?: number;
  /** Roleplay: per-session settings (roster, sampling, author note). */
  roleplay?: RoleplaySettings | null;
  /** Where the conversation started: the browser extension's chat panel. */
  origin?: 'browser';
  /**
   * `false` while the transcript is still in the database: Code chats load on
   * open (`appStore.ensureChatMessages`). Never persisted; absent once loaded.
   * A save of such a chat writes its row only, never an empty transcript.
   */
  messagesLoaded?: false;
  messages: ChatMessage[];
}

export interface ModelOption {
  id: string;
  name: string;
  source: 'local' | 'api';
  /** `catalog`: models.dev lists it, the provider's own list does not.
      Absent = served today. */
  availability?: 'catalog';
  path?: string;
  details?: string;
  architecture?: string;
  context_length?: number;
  parameter_count?: number;
  size_label?: string;
  quantization_name?: string;
  block_count?: number;
  chat_template_uses_tools?: boolean;
  has_mmproj?: boolean;
}

export type ProviderType = 'openai_compat' | 'local';

/** Thinking default for one on-device model (load dialog + remembered settings). */
export type LocalThinkingMode = 'auto' | 'off' | 'on';

export interface ProviderConfig {
  base_url: string;
  api_key?: string;
  has_api_key?: boolean;
  model: string;
  type?: ProviderType | string;
  // Generation params (optional)
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  system_prompt?: string;
  /** Model ids added by hand, kept even when the provider list omits them. */
  extra_models?: string[];
}

export interface AppConfig {
  llm?: {
    provider?: string;
    system_prompt?: string;
    user_prompt?: string;
    providers?: Record<string, ProviderConfig>;
    /** User-added OpenAI-compatible endpoints (keys live in providers[id].api_key). */
    custom_providers?: Array<{ id: string; label: string; base_url: string }>;
    backend_mode?: 'local' | 'api';
    local?: {
      system_prompt?: string;
      base_url?: string;
      model?: string;
      temperature?: number;
      max_tokens?: number;
      selected_model_path?: string;
      runtime_path?: string;
      context_length?: number;
      gpu_layers?: number;
      cpu_threads?: number;
      batch_size?: number;
      flash_attention?: boolean;
      offload_kv_cache?: boolean;
      keep_in_memory?: boolean;
      mmap?: boolean;
      seed?: number | null;
      rope_freq_base?: number | null;
      rope_freq_scale?: number | null;
      parallel?: number | null;
      cache_type_k?: string;
      cache_type_v?: string;
      mmproj_path?: string;
      /** Legacy server-default override; superseded by `thinking_mode` below. */
      disable_thinking?: boolean;
      /**
       * Thinking default for this model: 'auto' (omit --reasoning, llama.cpp
       * detects from the template), 'off' (--reasoning off), 'on'
       * (--reasoning on). Absent means 'auto'.
       */
      thinking_mode?: LocalThinkingMode;
      mtp?: boolean;
      mtp_draft_path?: string | null;
      mtp_draft_n_max?: number | null;
      cpu_moe?: boolean;
      n_cpu_moe?: number | null;
      context_shift?: boolean;
      cache_ram_mb?: number | null;
      cache_reuse?: number | null;
      swa_full?: boolean;
      split_mode?: string;
    };
  };
  search?: {
    provider?: string;
    context_budget_chars?: number;
    aggregator_engines?: string[];
    safe_search?: number;
    providers?: {
      [provider: string]: Record<string, unknown> | undefined;
      brave?: {
        api_key?: string;
      };
      tavily?: {
        api_key?: string;
      };
      exa?: {
        api_key?: string;
      };
      searxng?: {
        base_url?: string;
      };
      youcom?: {
        api_key?: string;
      };
      jina?: {
        api_key?: string;
        base_url?: string;
      };
      perplexity?: {
        api_key?: string;
        model?: string;
        api_url?: string;
      };
    };
  };
  tts?: {
    backend_mode?: 'local' | 'api' | 'browser';
    api_provider?: string;
    providers?: Record<string, import('$shared/speech').SpeechProviderConfig>;
    narrator?: import('$shared/speech').VoiceAssignment;
    enable_voice_output?: boolean;
    auto_play_voice?: boolean;
    voice?: string;
    speed?: number;
    volume?: number;
    engine?: 'kokoro' | 'wasm' | 'browser';
    model_path?: string;
    voices_path?: string;
    tokens_path?: string;
    lexicon_path?: string;
    dict_dir?: string;
    data_dir?: string;
    model_variant?: string;
    /** The audio.cpp voice model (shared/voice-models.ts) and the language it speaks. */
    voice_model?: string;
    local_backend?: 'cpu' | 'vulkan';
    num_threads?: number;
    language?: string;
    /** Voices cloned from a recording, and the one in use (empty = a built-in voice). */
    cloned_voices?: import('$shared/voice-models').ClonedVoice[];
    cloned_voice?: string;
  };
  stt?: {
    provider?: 'local' | 'api' | 'auto';
    api_provider?: string;
    providers?: Record<string, import('$shared/speech').SpeechProviderConfig>;
    whisper_quality?: string;
    whisper_model_path?: string;
    runtime_path?: string;
    backend?: 'auto' | 'cpu' | 'cuda' | 'vulkan' | string;
    language?: string;
    enable_stt?: boolean;
    audio_input_device_id?: string;
  };
  ui?: {
    theme?: 'light' | 'dark';
    show_assistant_text?: boolean;
    enable_thinking?: boolean;
    /**
     * Command used by "Open in editor", e.g. `code --reuse-window`. Empty
     * means auto-detect: the app checks $VISUAL/$EDITOR, then the editors it
     * knows on PATH. `{file}` and `{line}` are filled in when present.
     */
    editor?: string;
    agent_debug_logs?: boolean;
    artifact_toggles?: Record<string, boolean>;
    /** Home tools switched off from the composer's Tools menu: group ids and/or tool names. */
    home_tools_disabled?: string[];
    /** Enables the Roleplay space (tab, surface and settings section). */
    roleplay_enabled?: boolean;
    /** Enables the Bots space (tab and screen). */
    /** Set once the starter kit has been offered, so deleting it stays deleted. */
    roleplay_starter_kit?: boolean;
    /**
     * Map artifact basemap. Tiles are the default surface; when they cannot be
     * fetched the map falls back to the geometry bundled with the app, so a map
     * always renders.
     *
     * `template` is provider-agnostic on purpose. OpenStreetMap's public endpoint
     * forbids use by redistributed apps, so a shipped build should point this at a
     * provider the user has a key for.
     */
    map_tiles?: {
      enabled?: boolean;
      template?: string;
      attribution?: string;
    };
    /**
     * How Chat vs Agent is chosen:
     * - tabs: show Chat | Agent control in composer
     * - auto: hide tabs; route each message by intent
     */
    composer_mode_control?: 'tabs' | 'auto';
  };
  onboarding?: {
    completed?: boolean;
    completed_at?: number | null;
  };
}
