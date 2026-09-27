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
import { getAgenteCodeSystemPrompt } from '$lib/services/agent-prompts';

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

// Not every CodeAgentDriverKind is runnable — retired external CLI kinds stay in
// the type for persisted-value compatibility but have no registry entry.
export type CodeAgentDriverRegistry = Partial<Record<CodeAgentDriverKind, CodeAgentDriverDefinition>>;
export type CodeAgentInstanceRegistry = Record<CodeAgentInstanceId, CodeAgentAdapter>;
export type ProviderRegistry = Record<CodeAgentProviderId, CodeAgentAdapter>;

const LEGACY_PROVIDER_TO_INSTANCE: Record<string, CodeAgentInstanceId> = {
  builtin: 'chatea-agent',
  chatea: 'chatea',
  'chatea-agent': 'chatea-agent',
  'flaxeo-agent': 'chatea-agent',
  flaxeo: 'chatea-agent',
  pi: 'chatea-agent' // the built-in path is Agente
};

/** Built-in code profile. Unknown ids fall back here (never to the chat-only `chatea`). */
const FALLBACK_INSTANCE_ID: CodeAgentInstanceId = 'chatea-agent';

let driverRegistry: CodeAgentDriverRegistry | null = null;
let instanceRegistry: CodeAgentInstanceRegistry | null = null;

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

function createChateaDriver(): CodeAgentDriverDefinition {
  const instance = defaultInstance({
    id: 'chatea',
    driverKind: 'chatea',
    displayName: 'Agente Chat (Local)',
    detail: 'Local-model agent (Chat mode only)',
    status: 'ready',
    accentColor: 'var(--primary)'
  });
  return {
    driver: {
      driverKind: 'chatea',
      displayName: 'Agente Chat (Local)',
      detail: 'Built-in local-model agent for Chat mode',
      supportsMultipleInstances: false
    },
    defaultInstance: instance,
    createAdapter: (entry) => makeAdapter(entry, async () => 'ready', async (args) => runAgentTask(args))
  };
}

/**
 * Agente — built-in coding agent.
 * Uses the in-process tool loop (runAgentTask), not an external CLI binary.
 * Instance id stays `chatea-agent` for session/DB compatibility.
 */
function createBuiltinAgentDriver(): CodeAgentDriverDefinition {
  const instance = defaultInstance({
    id: 'chatea-agent',
    driverKind: 'chatea-agent',
    displayName: 'Agente',
    detail: 'Built-in coding agent · Pi-inspired',
    status: 'ready',
    accentColor: 'var(--primary)'
  });
  return {
    driver: {
      driverKind: 'chatea-agent',
      displayName: 'Agente',
      detail: 'Built-in coding agent for Code projects',
      supportsMultipleInstances: false
    },
    defaultInstance: instance,
    createAdapter: (entry) => makeAdapter(
      entry,
      async () => 'ready',
      async (args) => {
        if (!args.workspaceRoot) {
          return {
            content: 'Open a Code project folder first so Agente can work on real files.',
            reasoning: '',
            steps: [],
            artifact: null,
            artifacts: [],
            sources: [],
            outcome: 'failed',
            stopReason: 'error',
            error: 'No workspace root'
          };
        }
        const agentePrompt = getAgenteCodeSystemPrompt();
        return runAgentTask({
          ...args,
          executionMode: 'workspace',
          toolMode: 'agent',
          agentProfile: 'code',
          // Prefer explicit budgets; runAgentTask also raises defaults for code profile
          maxIterations: args.maxIterations ?? 28,
          maxToolCalls: args.maxToolCalls ?? 80,
          maxTimeMs: args.maxTimeMs ?? 8 * 60 * 1000,
          systemPrompt: [agentePrompt, args.systemPrompt].filter(Boolean).join('\n\n'),
        });
      },
    ),
  };
}

/**
 * Code Agent — the Code space's built-in agent (pi-inspired engine in the
 * main process, driven through features/code). The Code surface talks to the
 * engine directly over agente_* IPC; this adapter only serves legacy
 * resolveCodeAgentInstance() callers, so it rides the in-process tool loop
 * with the code profile rather than reporting itself unavailable.
 *
 * `driverKind: 'agente'` is a persisted value — do not rename it.
 */
function createAgenteDriver(): CodeAgentDriverDefinition {
  const instance = defaultInstance({
    id: 'agente',
    driverKind: 'agente',
    displayName: 'Code Agent',
    detail: 'Built-in coding agent · extensible',
    status: 'ready',
    accentColor: 'var(--primary)'
  });
  return {
    driver: {
      driverKind: 'agente',
      displayName: 'Code Agent',
      detail: 'Built-in coding agent for Code projects',
      supportsMultipleInstances: false
    },
    defaultInstance: instance,
    createAdapter: (entry) => makeAdapter(entry, async () => 'ready', async (args) => runAgentTask({
      ...args,
      executionMode: 'workspace',
      toolMode: 'agent',
      agentProfile: 'code',
      maxIterations: args.maxIterations ?? 28,
      maxToolCalls: args.maxToolCalls ?? 80,
      maxTimeMs: args.maxTimeMs ?? 8 * 60 * 1000
    }))
  };
}

export function normalizeCodeAgentInstanceId(value: unknown): CodeAgentInstanceId {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'chatea-agent';
  return LEGACY_PROVIDER_TO_INSTANCE[raw] || raw;
}

export function getCodeAgentDriverRegistry(): CodeAgentDriverRegistry {
  if (!driverRegistry) {
    // Only runnable adapters belong here. The Codex/Claude/Cursor/OpenCode CLI
    // stubs could detect a binary but never run one (createUnavailableRun), and
    // listing them offered users providers that always failed; `pi` duplicated
    // the `chatea-agent` instance id in the registry and is now an alias
    // resolved through LEGACY_PROVIDER_TO_INSTANCE instead.
    driverRegistry = {
      agente: createAgenteDriver(),
      chatea: createChateaDriver(),
      'chatea-agent': createBuiltinAgentDriver()
    };
  }
  return driverRegistry;
}

export function getCodeAgentInstanceRegistry(): CodeAgentInstanceRegistry {
  if (!instanceRegistry) {
    const drivers = getCodeAgentDriverRegistry();
    instanceRegistry = Object.fromEntries(
      Object.values(drivers)
        .filter((definition): definition is CodeAgentDriverDefinition => !!definition)
        .map((definition) => {
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
  const adapter = registry[instanceId];
  if (adapter) return adapter;
  // A typo'd or retired persisted id must not silently switch profiles: the old
  // chain (chatea -> chatea-agent) could run a chat/sandbox profile where a
  // workspace/code profile was expected. Fall back to the built-in code agent —
  // deterministically, and loudly enough to diagnose.
  console.warn(`[agent-provider] Unknown code agent instance "${String(id ?? '')}" — falling back to "${FALLBACK_INSTANCE_ID}".`);
  return registry[FALLBACK_INSTANCE_ID];
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
  // Instance ids are unique by construction now that `pi` is an alias rather
  // than a duplicate registry entry; prefer Agente first.
  const list = Object.values(getCodeAgentInstanceRegistry()).map(adapterToProvider);
  list.sort((a, b) => {
    if (a.id === 'chatea-agent') return -1;
    if (b.id === 'chatea-agent') return 1;
    return a.label.localeCompare(b.label);
  });
  return list;
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
