/**
 * The shape of one Home agent run, resolved once before the loop starts:
 * profile, budgets, the tools the model sees, the three system prompts
 * (native tools, XML tools, direct), and the research product settings.
 *
 * Everything here is a pure function of the run arguments and the app
 * config, so the loop never re-derives it and tests can assert it directly.
 */

import type { RequestMessage } from '$lib/services/chat/types';
import type { RunAgentTaskArgs } from '$lib/services/agent-types';
import type { AppConfig } from '$lib/types/chat';
import { supportsNativeTools } from '$lib/services/agent-llm';
import { getToolDefinitions } from '$lib/services/agent-tooling';
import { isWebsiteBuildRequest } from '$lib/services/agent-flow';
import { compactText } from '$lib/services/agent-evidence';
import { isResearchProductPath, resolveResearchMode } from '$lib/services/research-pipeline';
import {
  getNativeSystemPrompt, getXmlSystemPrompt, buildDirectSystemPrompt, buildCurrentRequestReminder,
  getAgenteChatSystemPrompt
} from '$lib/services/agent-prompts';
import { DEFAULT_PROVIDER_ID } from '$shared/providers';

const DEFAULT_MAX_ITERATIONS = 14;
const LOCAL_DEFAULT_MAX_ITERATIONS = 10;
/** Agente (code) needs more room than chat sandbox agents. */
const CODE_MAX_ITERATIONS = 28;
const CODE_LOCAL_MAX_ITERATIONS = 18;
const CODE_MAX_TIME_MS = 8 * 60 * 1000;
/** Simple Chat Agent budgets (long-horizon lite). */
const CHAT_MAX_ITERATIONS = 12;
const CHAT_LOCAL_MAX_ITERATIONS = 8;
const CHAT_MAX_TIME_MS = 5 * 60 * 1000;
const MAX_TIME_MS = 2 * 60 * 1000;
const TOOL_CALLS_PER_STEP = 3;
const LOCAL_TOOL_CALLS_PER_STEP = 2;
const CODE_TOOL_CALLS_PER_STEP = 4;
/** Max tool-loop messages after chat history (structural cap only; budget still applies). */
const MAX_LOOP_MESSAGES_LOCAL = 12;
const MAX_LOOP_MESSAGES_API = 16;

const SEARCH_TOOL_NAMES = new Set([
  'web_search',
  'fetch_url',
  'calculator',
  'get_weather',
  'convert_currency',
  'get_quote',
  'create_chart',
  'create_dashboard',
  'create_info_card',
  'create_html_card',
  'create_widget',
  'create_scene_3d',
  'create_diagram',
  'create_map'
]);
/**
 * Instant fast-path allowlist: grounded answers and math only. No artifact
 * creators, no file writes, no workspace edits — those live on the Agent
 * tab. Port as one pack subset if Home moves to the core engine (#12).
 */
export const INSTANT_TOOL_NAMES = new Set([
  'web_search',
  'fetch_url',
  'query_knowledge',
  'calculator',
  'get_weather',
  'convert_currency',
  'get_quote'
]);

type ToolMode = NonNullable<RunAgentTaskArgs['toolMode']>;
type SearchDepth = 'search' | 'deep' | 'max';

export interface AgentRunPlan {
  debugLogs: boolean;
  backendMode: string;
  localMode: boolean;
  providerName: string;
  activeModel: string;
  executionMode: 'workspace' | 'sandbox';
  /** Workspace runs write real files on disk; there is no sandbox artifact to show. */
  artifactsEnabled: boolean;
  artifactToggles: Record<string, boolean>;
  /** Tool groups or names turned off in the Tools menu (config.ui.home_tools_disabled). */
  disabledTools: string[];
  toolMode: ToolMode;
  /** Instant: intent-gated fast path — answer directly, tools only when needed. */
  isInstant: boolean;
  agentProfile: NonNullable<RunAgentTaskArgs['agentProfile']>;
  isCodeProfile: boolean;
  isChatProfile: boolean;
  maxIterations: number;
  maxToolCalls: number;
  maxTimeMs: number;
  /** Native tool calling is worth trying for this provider/model. */
  nativeTools: boolean;
  wantsWebsiteArtifact: boolean;
  toolDefs: ReturnType<typeof getToolDefinitions>;
  prompts: { native: string; xml: string; direct: string };
  /** Search / Deep / Max product path — not the Code profile. */
  isResearchChat: boolean;
  researchMode: ReturnType<typeof resolveResearchMode>;
  /** Search / Deep / Max: no completion max_tokens budget (long professional reports). */
  omitMaxTokens: boolean;
  fallbackMode: 'research' | 'chat';
  /** Research and attached documents: never token-budget trim the context. */
  preserveDocs: boolean;
  maxLoopMessages: number;
}

function isSearchDepth(value: unknown): value is SearchDepth {
  return value === 'search' || value === 'deep' || value === 'max';
}

function defaultIterations(profile: { code: boolean; chat: boolean }, localMode: boolean): number {
  if (profile.code) return localMode ? CODE_LOCAL_MAX_ITERATIONS : CODE_MAX_ITERATIONS;
  if (profile.chat) return localMode ? CHAT_LOCAL_MAX_ITERATIONS : CHAT_MAX_ITERATIONS;
  return localMode ? LOCAL_DEFAULT_MAX_ITERATIONS : DEFAULT_MAX_ITERATIONS;
}

function defaultToolCalls(profile: { code: boolean; chat: boolean }, maxIterations: number, localMode: boolean): number {
  if (profile.code) return Math.max(maxIterations, maxIterations * (localMode ? LOCAL_TOOL_CALLS_PER_STEP : CODE_TOOL_CALLS_PER_STEP));
  if (profile.chat) return Math.max(maxIterations, maxIterations * 2);
  return Math.max(maxIterations, maxIterations * (localMode ? LOCAL_TOOL_CALLS_PER_STEP : TOOL_CALLS_PER_STEP));
}

function modeNote(plan: { isCodeProfile: boolean; isChatProfile: boolean; executionMode: string }, workspaceRoot?: string): string {
  if (plan.isCodeProfile || (plan.executionMode === 'workspace' && !plan.isChatProfile)) {
    // The coding rules themselves live in the base prompt (native) or in the
    // tool descriptions (XML); this note only says where the work happens.
    // It used to re-state the whole Agente code prompt plus an eight-bullet
    // tool inventory that the API already sends as schemas.
    return [
      `You are attached to a real workspace folder at ${workspaceRoot || 'the project root'}.`,
      'Files and bash commands run on the host filesystem, confined to the workspace root.',
      'Work with read_file, write_file, edit_file, delete_file, list_dir, grep, find and bash; use bash for tests, installs, builds and git.',
      'Read a file before you modify it, and prefer edit_file over rewriting it with write_file.',
      'Diffs and file changes auto-render in the chat as a changed-files overview.'
    ].join('\n');
  }
  if (plan.isChatProfile) {
    return [
      getAgenteChatSystemPrompt(),
      'You are in chat sandbox mode. Files exist only inside this conversation unless the user exports them.',
    ].join('\n');
  }
  return 'You are in chat sandbox mode. Files exist only inside this conversation artifact unless the user exports them.';
}

function searchModeNote(toolMode: ToolMode, searchMode?: string): string {
  if (toolMode !== 'search_chat') return '';
  return [
    `Selected search depth: ${searchMode || 'search'}.`,
    searchMode === 'max'
      ? 'Max search means keep broadening and deepening with additional searches/source reads until the answer is strongly supported or the tool/time budget is exhausted.'
      : searchMode === 'deep'
        ? 'Deep search means use multiple high-signal searches and source reads to improve accuracy before answering.'
        : 'Search mode means use web search for current information and follow up if the first search is insufficient.'
  ].join(' ');
}

const INSTANT_MODE_NOTE = [
  'Fast-answer mode: respond directly and briefly whenever you already know the answer.',
  'Reach for a tool only when the answer genuinely needs grounding — current information (web_search/fetch_url), retrieved documents (query_knowledge), live data (get_weather/convert_currency/get_quote), or exact arithmetic (calculator).',
  'Never more than a couple of tool calls per question; do not go on research journeys.',
  'You cannot create files, artifacts, or visuals in this mode — answer in prose, with sources where they matter.'
].join(' ');

import { lessonsEnabled } from '$lib/services/lesson-surface';
import { LEARNING_ANSWER_FIRST } from '$lib/services/agent-prompts';

function selectToolDefs(toolMode: ToolMode, executionMode: 'workspace' | 'sandbox', toggles: Record<string, boolean>, profile: AgentRunPlan['agentProfile'], disabled: readonly string[] = [], contextMode?: string) {
  if (toolMode === 'search_chat') {
    return getToolDefinitions(executionMode, toggles, 'search', disabled).filter((tool) => SEARCH_TOOL_NAMES.has(tool.function.name));
  }
  if (toolMode === 'instant') {
    return getToolDefinitions(executionMode, toggles, 'search', disabled).filter((tool) => INSTANT_TOOL_NAMES.has(tool.function.name));
  }
  return getToolDefinitions(executionMode, toggles, profile, disabled)
    // Home-only artifact types never reach another space's tool list. Design and
    // Roleplay share the chat profile, so the profile alone is not a gate.
    .filter((tool) => tool.function.name !== 'create_lesson' || lessonsEnabled(contextMode));
}

export function resolveAgentRunPlan(args: RunAgentTaskArgs, config: AppConfig, host: { isElectron: boolean }): AgentRunPlan {
  const debugLogs = !!config.ui?.agent_debug_logs;
  const executionMode = args.executionMode || 'sandbox';
  const artifactToggles = config.ui?.artifact_toggles || {};
  const backendMode = config.llm?.backend_mode || (host.isElectron ? 'local' : 'api');
  const localMode = backendMode === 'local';
  const toolMode: ToolMode = args.toolMode || 'agent';
  const isInstant = toolMode === 'instant';
  const agentProfile = args.agentProfile
    || (toolMode === 'search_chat' ? 'search' : (executionMode === 'workspace' ? 'code' : 'work'));
  const isCodeProfile = agentProfile === 'code';
  const isChatProfile = agentProfile === 'chat';
  const profile = { code: isCodeProfile, chat: isChatProfile };

  const maxIterations = Math.max(1, Math.floor(args.maxIterations ?? defaultIterations(profile, localMode)));
  const maxToolCalls = Math.max(maxIterations, Math.floor(args.maxToolCalls ?? defaultToolCalls(profile, maxIterations, localMode)));
  const maxTimeMs = Math.max(
    30_000,
    Math.floor(args.maxTimeMs ?? (isCodeProfile ? CODE_MAX_TIME_MS : isChatProfile ? CHAT_MAX_TIME_MS : MAX_TIME_MS))
  );

  const providerName = config.llm?.provider || DEFAULT_PROVIDER_ID;
  const providers = config.llm?.providers || {};
  const provider = providers[providerName] || {};
  const activeModel = localMode ? (config.llm?.local?.model || 'local-model') : (provider.model || '');

  const latestUserText = args.rawPrompt
    || [...args.messages].reverse().find((message) => message.role === 'user')?.content?.toString?.()
    || '';
  const wantsWebsiteArtifact = !isInstant && isWebsiteBuildRequest(latestUserText);
  const toolDefs = selectToolDefs(toolMode, executionMode, artifactToggles, agentProfile, config.ui?.home_tools_disabled ?? [], args.contextMode);

  const agentExtra = [
    modeNote({ isCodeProfile, isChatProfile, executionMode }, args.workspaceRoot),
    searchModeNote(toolMode, args.searchMode),
    isInstant ? INSTANT_MODE_NOTE : '',
    // Opt-in, Home-only: the rule ships only when the lesson type is on.
    lessonsEnabled(args.contextMode) && artifactToggles.lesson ? LEARNING_ANSWER_FIRST : '',
    args.systemPrompt,
    buildCurrentRequestReminder(args.rawPrompt, compactText)
  ].filter(Boolean).join('\n\n');
  const promptSearchMode: SearchDepth = isSearchDepth(args.searchMode) ? args.searchMode : 'search';

  const isResearchChat = isResearchProductPath({ isCodeProfile, toolMode, searchMode: args.searchMode });
  const researchish = toolMode === 'search_chat' || isSearchDepth(args.searchMode);

  return {
    debugLogs,
    backendMode,
    localMode,
    providerName,
    activeModel,
    executionMode,
    artifactsEnabled: executionMode !== 'workspace',
    artifactToggles,
    disabledTools: config.ui?.home_tools_disabled ?? [],
    toolMode,
    isInstant,
    agentProfile,
    isCodeProfile,
    isChatProfile,
    maxIterations,
    maxToolCalls,
    maxTimeMs,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nativeTools: host.isElectron && supportsNativeTools(config as any),
    wantsWebsiteArtifact,
    toolDefs,
    prompts: {
      native: getNativeSystemPrompt(agentExtra, maxToolCalls, maxIterations, toolMode, executionMode, promptSearchMode),
      xml: getXmlSystemPrompt(agentExtra, maxToolCalls, maxIterations, toolDefs, toolMode, executionMode, promptSearchMode),
      direct: buildDirectSystemPrompt(agentExtra, { toolMode, searchMode: promptSearchMode })
    },
    isResearchChat,
    researchMode: resolveResearchMode(args.searchMode),
    omitMaxTokens: researchish,
    fallbackMode: isResearchChat || researchish ? 'research' : 'chat',
    preserveDocs: isResearchChat
      || toolMode === 'search_chat'
      || !!args.preserveDocumentContext
      || (typeof args.conversationContext === 'string' && args.conversationContext.includes('<documents>')),
    maxLoopMessages: localMode ? MAX_LOOP_MESSAGES_LOCAL : MAX_LOOP_MESSAGES_API
  };
}

/**
 * Normalize history to pure role/content rows so trimming can protect them.
 * Preserves reasoning_content (DeepSeek tool+thinking echo) and provider state.
 */
export function normalizeAgentHistory(messages: RequestMessage[] | undefined): RequestMessage[] {
  return (messages || [])
    .map((message) => {
      const row: RequestMessage = {
        role: message.role,
        content: typeof message.content === 'string' ? message.content : (message.content ? JSON.stringify(message.content) : ''),
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        ...(message.providerState ? { providerState: message.providerState } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments.map(item => ({ ...item })) } : {})
      };
      const rc = message.reasoning_content;
      if (typeof rc === 'string' && rc.trim()) row.reasoning_content = rc;
      return row;
    })
    .filter((message) => message.role === 'system' || String(message.content || '').trim() || message.tool_calls?.length || message.reasoning_content || message.attachments?.length);
}
