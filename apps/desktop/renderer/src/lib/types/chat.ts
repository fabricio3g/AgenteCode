import type { IndexedDocument, SearchResult, SlideData } from '$lib/types/bridge';
import type { AgentActivityKey, CodeChild, CodeRunSummary, CodeSpend, CodeStopReason, CodeTodoItem, HomeStopReason } from '$shared/agente-protocol';
import type { Attachment as CodeAttachment } from '$shared/agente-protocol.gen';

/** One entry of a Code run's transcript, in arrival order. */
export type CodeTimelineEntry = { kind: 'text'; text: string } | { kind: 'step'; id: string };

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
  processingMode?: 'vision' | 'ocr' | 'document_text';
  visionReady?: boolean;
  error?: string;
}

export interface MessageVersion {
  content: string;
  reasoning?: string;
  createdAt: number;
  metadata?: {
    modelName?: string;
    tokens?: number;
    timing?: number;
    tokensPerSecond?: number;
    modelTimingSeconds?: number;
    totalElapsedSeconds?: number;
    reasoningTimingSeconds?: number;
    usageSource?: 'provider' | 'runtime' | 'estimated' | 'none';
    timingScope?: 'model' | 'agent_wall' | 'reasoning' | 'unknown';
    inputTokens?: number;
    outputTokens?: number;
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
    codeAttachments?: CodeAttachment[];
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
  output?: string;
  fileChanges?: CodeAgentFileChange[];
  diffStats?: CodeAgentDiffStat[];
  /** Web research steps: what was searched or read, for the research widget. */
  research?: { query?: string; results?: number; url?: string; title?: string };
  /** The agent's opening sentence before it starts working; shown as text, not as a step. */
  preface?: boolean;
}

export type ChartArtifactPayload = {
  kind: 'chart';
  title: string;
  chartType: 'bar' | 'line' | 'pie' | 'donut';
  labels: string[];
  datasets: Array<{ label: string; data: number[] }>;
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

export type InlineArtifactPayload =
  | ChartArtifactPayload
  | MapArtifactPayload
  | DiagramArtifactPayload
  | DashboardArtifactPayload
  | InfoCardArtifactPayload
  | HtmlCardArtifactPayload;

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

export type CodeAgentDriverKind = 'agente' | 'chatea' | 'chatea-agent' | 'codex' | 'claude' | 'cursor' | 'opencode' | 'pi';
export type CodeAgentInstanceId = string;
export type CodeAgentProviderId = CodeAgentInstanceId;
export type CodeAgentProviderStatus = 'ready' | 'missing' | 'login' | 'soon' | 'disabled';
export type CodeAgentRuntimeMode = 'full' | 'supervised' | 'plan';

export interface CodeAgentProvider {
  id: CodeAgentInstanceId;
  instanceId?: CodeAgentInstanceId;
  driverKind: CodeAgentDriverKind;
  label: string;
  driver: string;
  detail: string;
  status: CodeAgentProviderStatus;
  enabled?: boolean;
  accentColor?: string;
}

export interface CodeAgentDriver {
  driverKind: CodeAgentDriverKind;
  displayName: string;
  detail: string;
  supportsMultipleInstances?: boolean;
}

export interface CodeAgentInstance {
  id: CodeAgentInstanceId;
  driverKind: CodeAgentDriverKind;
  displayName: string;
  detail: string;
  enabled: boolean;
  status: CodeAgentProviderStatus;
  config?: unknown;
  environment?: Array<{ name: string; value: string; sensitive?: boolean }>;
  accentColor?: string;
}

export interface CodeAgentSessionMeta {
  draftAttachments?: CodeAttachment[];
  instanceId: CodeAgentInstanceId;
  driverKind?: CodeAgentDriverKind;
  providerId?: CodeAgentProviderId;
  status?: CodeAgentProviderStatus;
  runtimeMode?: CodeAgentRuntimeMode;
  substrate?: 'native' | 'pi';
  sessionId?: string;
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
// Surfaced by each provider's getReasoningCapabilities() — never guessed
// from model names in shared code. The UI only shows the selector when a
// provider returns `supported: true` with a known `source`.

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

export type ReasoningParamShape =
  | 'openai_reasoning_effort'
  | 'anthropic_thinking'
  | 'gemini_thinking_budget'
  | 'mistral_reasoning_effort'
  | 'local_enable_thinking';

export interface ReasoningCapabilities {
  supported: boolean;
  levels: ReasoningLevel[];
  paramShape: ReasoningParamShape;
  source: 'sdk' | 'api' | 'metadata' | 'unknown';
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
}

/**
 * The space a session belongs to. Immutable after create.
 *
 * Persisted values may be legacy spellings — `'chat'` (old id of home) and
 * `'work'`/`'code'` (old ids of code) — and are normalized on read via
 * `normalizeSpace()` in `$lib/spaces`.
 */
export type ChatContextMode = 'home' | 'code' | 'roleplay';

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

export interface ChatSession {
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
  messages: ChatMessage[];
}

/**
 * Clear space separation on top of ChatSession.
 *
 * ChatSession stays as persisted base for compat.
 * New code branches on these narrowed views:
 * - HomeSession: no project, no codeAgent, no workspace.
 * - CodeSession: project-linked agent conversation.
 * Narrow via `isCodeSession` / `isHomeSession`
 * in `features/shared/session-guards.ts`.
 */
export interface HomeSession extends ChatSession {
  contextMode?: 'home';
  codeAgent?: null;
  projectId?: null;
  workspace?: null;
}

export interface CodeSession extends ChatSession {
  contextMode?: 'code';
  projectId?: string | null;
}

export type SpaceSession = HomeSession | CodeSession;

export interface ModelOption {
  id: string;
  name: string;
  source: 'local' | 'api';
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
    max_results?: number;
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
    language?: string;
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
    agent_debug_logs?: boolean;
    artifact_toggles?: Record<string, boolean>;
    /** Enables the Roleplay space (tab, surface and settings section). */
    roleplay_enabled?: boolean;
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
