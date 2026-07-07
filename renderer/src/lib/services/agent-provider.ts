import type {
  CodeAgentDriver,
  CodeAgentDriverKind,
  CodeAgentInstance,
  CodeAgentInstanceId,
  CodeAgentProvider,
  CodeAgentProviderId,
  CodeAgentProviderStatus
} from '$lib/types/chat';
import type { RunAgentTaskArgs, AgentTaskResult } from '$lib/services/agent-types';
import { runAgentTask } from '$lib/services/agent';
import { isTauri, invoke } from '$lib/services/tauri';
import { runChateaAgentSession } from '$lib/services/chatea-agent-session';

export interface CodeAgentAdapter {
  readonly instance: CodeAgentInstance;
  detect(): Promise<CodeAgentProviderStatus>;
  run(args: RunAgentTaskArgs): Promise<AgentTaskResult>;
}

export interface CodeAgentDriverDefinition {
  readonly driver: CodeAgentDriver;
  readonly defaultInstance: CodeAgentInstance;
  createAdapter(instance: CodeAgentInstance): CodeAgentAdapter;
}

export type CodeAgentDriverRegistry = Record<CodeAgentDriverKind, CodeAgentDriverDefinition>;
export type CodeAgentInstanceRegistry = Record<CodeAgentInstanceId, CodeAgentAdapter>;
export type ProviderRegistry = Record<CodeAgentProviderId, CodeAgentAdapter>;

const LEGACY_PROVIDER_TO_INSTANCE: Record<string, CodeAgentInstanceId> = {
  builtin: 'chatea',
  chatea: 'chatea',
  'chatea-agent': 'chatea-agent',
  codex: 'codex',
  claude: 'claude',
  cursor: 'cursor',
  opencode: 'opencode',
  pi: 'pi'
};

let driverRegistry: CodeAgentDriverRegistry | null = null;
let instanceRegistry: CodeAgentInstanceRegistry | null = null;

async function cliExists(command: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const result = await invoke<{ exit_code: number }>('workspace_exec', {
      workspace_root: '',
      command: process.platform === 'win32' ? 'where' : 'which',
      args: [command],
      timeout_ms: 5000
    });
    return result.exit_code === 0;
  } catch {
    return false;
  }
}

function defaultInstance(input: {
  id: CodeAgentInstanceId;
  driverKind: CodeAgentDriverKind;
  displayName: string;
  detail: string;
  status?: CodeAgentProviderStatus;
  accentColor?: string;
}): CodeAgentInstance {
  return {
    id: input.id,
    driverKind: input.driverKind,
    displayName: input.displayName,
    detail: input.detail,
    enabled: true,
    status: input.status || 'missing',
    accentColor: input.accentColor
  };
}

function makeAdapter(
  instance: CodeAgentInstance,
  detect: () => Promise<CodeAgentProviderStatus>,
  run: (args: RunAgentTaskArgs) => Promise<AgentTaskResult>
): CodeAgentAdapter {
  return { instance, detect, run };
}

function createUnavailableRun(displayName: string) {
  return async (): Promise<AgentTaskResult> => ({
    content: `${displayName} is detected as a provider instance, but its runtime adapter is not implemented in Chatea yet.`,
    reasoning: '',
    steps: [],
    artifact: null,
    sources: [],
    outcome: 'failed',
    stopReason: 'error',
    error: `${displayName} adapter not implemented`,
  });
}

function createChateaDriver(): CodeAgentDriverDefinition {
  const instance = defaultInstance({
    id: 'chatea',
    driverKind: 'chatea',
    displayName: 'Chatea Agent (Local)',
    detail: 'Local-model agent (Chat mode only)',
    status: 'ready',
    accentColor: '#717CE2'
  });
  return {
    driver: {
      driverKind: 'chatea',
      displayName: 'Chatea Agent (Local)',
      detail: 'Built-in local-model agent for Chat mode',
      supportsMultipleInstances: false
    },
    defaultInstance: instance,
    createAdapter: (entry) => makeAdapter(entry, async () => 'ready', async (args) => runAgentTask(args))
  };
}

function createChateaAgentDriver(): CodeAgentDriverDefinition {
  const instance = defaultInstance({
    id: 'chatea-agent',
    driverKind: 'chatea-agent',
    displayName: 'Chatea Agent',
    detail: 'Custom coding harness',
    status: 'ready',
    accentColor: '#717CE2'
  });
  return {
    driver: {
      driverKind: 'chatea-agent',
      displayName: 'Chatea Agent',
      detail: 'Chatea custom coding harness',
      supportsMultipleInstances: false
    },
    defaultInstance: instance,
    createAdapter: (entry) => makeAdapter(
      entry,
      async () => 'ready',
      async (args) => runChateaAgentSession(
        {
          chatId: args.chatId,
          projectRoot: args.workspaceRoot || '',
          provider: 'chatea',
          model: 'default',
          runtimeMode: args.runtimeMode || 'full',
          systemPromptOverride: args.systemPrompt,
        },
        args,
      ),
    ),
  };
}

function createCodexDriver(): CodeAgentDriverDefinition {
  const instance = defaultInstance({ id: 'codex', driverKind: 'codex', displayName: 'Codex', detail: 'OpenAI Codex CLI', accentColor: '#10a37f' });
  return {
    driver: { driverKind: 'codex', displayName: 'Codex', detail: 'OpenAI Codex CLI', supportsMultipleInstances: true },
    defaultInstance: instance,
    createAdapter: (entry) => makeAdapter(entry, async () => (await cliExists('codex')) ? 'ready' : 'missing', createUnavailableRun(entry.displayName))
  };
}

function createClaudeDriver(): CodeAgentDriverDefinition {
  const instance = defaultInstance({ id: 'claude', driverKind: 'claude', displayName: 'Claude Code', detail: 'Anthropic Claude Code', accentColor: '#d97706' });
  return {
    driver: { driverKind: 'claude', displayName: 'Claude Code', detail: 'Anthropic Claude Code', supportsMultipleInstances: true },
    defaultInstance: instance,
    createAdapter: (entry) => makeAdapter(entry, async () => (await cliExists('claude')) ? 'login' : 'missing', createUnavailableRun(entry.displayName))
  };
}

function createCursorDriver(): CodeAgentDriverDefinition {
  const instance = defaultInstance({ id: 'cursor', driverKind: 'cursor', displayName: 'Cursor Agent', detail: 'Cursor coding agent', status: 'disabled', accentColor: '#f8fafc' });
  return {
    driver: { driverKind: 'cursor', displayName: 'Cursor Agent', detail: 'Cursor coding agent', supportsMultipleInstances: true },
    defaultInstance: instance,
    createAdapter: (entry) => makeAdapter(entry, async () => 'disabled', createUnavailableRun(entry.displayName))
  };
}

function createOpenCodeDriver(): CodeAgentDriverDefinition {
  const instance = defaultInstance({ id: 'opencode', driverKind: 'opencode', displayName: 'OpenCode', detail: 'OpenCode runtime', accentColor: '#22c55e' });
  return {
    driver: { driverKind: 'opencode', displayName: 'OpenCode', detail: 'OpenCode runtime', supportsMultipleInstances: true },
    defaultInstance: instance,
    createAdapter: (entry) => makeAdapter(entry, async () => (await cliExists('opencode')) ? 'ready' : 'missing', createUnavailableRun(entry.displayName))
  };
}

function createPiDriver(): CodeAgentDriverDefinition {
  const instance = defaultInstance({ id: 'pi', driverKind: 'pi', displayName: 'Pi Agent', detail: 'Pi coding agent', status: 'soon', accentColor: '#ec4899' });
  return {
    driver: { driverKind: 'pi', displayName: 'Pi Agent', detail: 'Pi coding agent', supportsMultipleInstances: true },
    defaultInstance: instance,
    createAdapter: (entry) => makeAdapter(entry, async () => 'soon', createUnavailableRun(entry.displayName))
  };
}

export function normalizeCodeAgentInstanceId(value: unknown): CodeAgentInstanceId {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'chatea';
  return LEGACY_PROVIDER_TO_INSTANCE[raw] || raw;
}

export function getCodeAgentDriverRegistry(): CodeAgentDriverRegistry {
  if (!driverRegistry) {
    driverRegistry = {
      chatea: createChateaDriver(),
      'chatea-agent': createChateaAgentDriver(),
      codex: createCodexDriver(),
      claude: createClaudeDriver(),
      cursor: createCursorDriver(),
      opencode: createOpenCodeDriver(),
      pi: createPiDriver()
    };
  }
  return driverRegistry;
}

export function getCodeAgentInstanceRegistry(): CodeAgentInstanceRegistry {
  if (!instanceRegistry) {
    const drivers = getCodeAgentDriverRegistry();
    instanceRegistry = Object.fromEntries(
      Object.values(drivers).map((definition) => {
        const instance = definition.defaultInstance;
        return [instance.id, definition.createAdapter(instance)];
      })
    );
  }
  return instanceRegistry;
}

export function listCodeAgentInstances(): CodeAgentInstance[] {
  return Object.values(getCodeAgentInstanceRegistry()).map((adapter) => adapter.instance);
}

export function resolveCodeAgentInstance(id?: CodeAgentInstanceId | null): CodeAgentAdapter {
  const registry = getCodeAgentInstanceRegistry();
  const instanceId = normalizeCodeAgentInstanceId(id);
  return registry[instanceId] || registry['chatea'] || registry['chatea-agent'];
}

export async function detectCodeAgentInstanceStatus(id: CodeAgentInstanceId): Promise<CodeAgentProviderStatus> {
  const adapter = resolveCodeAgentInstance(id);
  if (!adapter.instance.enabled) return 'disabled';
  try {
    return await adapter.detect();
  } catch {
    return 'missing';
  }
}

export async function detectAllCodeAgentInstanceStatuses(): Promise<Record<CodeAgentInstanceId, CodeAgentProviderStatus>> {
  const registry = getCodeAgentInstanceRegistry();
  const results: Record<CodeAgentInstanceId, CodeAgentProviderStatus> = {};
  await Promise.all(
    Object.entries(registry).map(async ([id, adapter]) => {
      results[id] = adapter.instance.enabled ? await adapter.detect().catch(() => 'missing' as CodeAgentProviderStatus) : 'disabled';
    })
  );
  return results;
}

export async function runCodeAgent(args: RunAgentTaskArgs, instanceId?: CodeAgentInstanceId | null): Promise<AgentTaskResult> {
  const adapter = resolveCodeAgentInstance(instanceId);
  return adapter.run(args);
}

function adapterToProvider(adapter: CodeAgentAdapter): CodeAgentProvider {
  return {
    id: adapter.instance.id,
    instanceId: adapter.instance.id,
    driverKind: adapter.instance.driverKind,
    label: adapter.instance.displayName,
    driver: adapter.instance.driverKind,
    detail: adapter.instance.detail,
    status: adapter.instance.status,
    enabled: adapter.instance.enabled,
    accentColor: adapter.instance.accentColor
  };
}

export function getProviderRegistry(): ProviderRegistry {
  return getCodeAgentInstanceRegistry();
}

export function listCodeAgentProviders(): CodeAgentProvider[] {
  return Object.values(getCodeAgentInstanceRegistry()).map(adapterToProvider);
}

export function resolveProvider(id: CodeAgentProviderId): CodeAgentAdapter {
  return resolveCodeAgentInstance(id);
}

export async function detectProviderStatus(id: CodeAgentProviderId): Promise<CodeAgentProviderStatus> {
  return detectCodeAgentInstanceStatus(id);
}

export async function detectAllProviderStatuses(): Promise<Record<CodeAgentProviderId, CodeAgentProviderStatus>> {
  return detectAllCodeAgentInstanceStatuses();
}
