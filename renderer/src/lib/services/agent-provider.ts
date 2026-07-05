import type { CodeAgentProviderId, CodeAgentProviderStatus } from '$lib/types/chat';
import type { RunAgentTaskArgs, AgentTaskResult } from '$lib/services/agent-types';
import { runAgentTask } from '$lib/services/agent';
import { isTauri, invoke } from '$lib/services/tauri';

export interface CodeAgentAdapter {
  readonly id: CodeAgentProviderId;
  readonly label: string;
  readonly driver: string;
  readonly detail: string;
  detect(): Promise<CodeAgentProviderStatus>;
  run(args: RunAgentTaskArgs): Promise<AgentTaskResult>;
}

export type ProviderRegistry = Record<CodeAgentProviderId, CodeAgentAdapter>;

let _registry: ProviderRegistry | null = null;

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

function createBuiltinAdapter(): CodeAgentAdapter {
  return {
    id: 'builtin',
    label: 'Chatea Agent',
    driver: 'Built-in',
    detail: 'Current local agent',
    detect: async () => 'ready',
    run: async (args) => runAgentTask(args)
  };
}

function createCodexAdapter(): CodeAgentAdapter {
  return {
    id: 'codex',
    label: 'Codex',
    driver: 'CLI',
    detail: 'OpenAI Codex CLI',
    detect: async () => (await cliExists('codex')) ? 'ready' : 'missing',
    run: () => {
      throw new Error('Codex adapter not implemented');
    }
  };
}

function createClaudeAdapter(): CodeAgentAdapter {
  return {
    id: 'claude',
    label: 'Claude Code',
    driver: 'CLI',
    detail: 'Anthropic Claude Code',
    detect: async () => (await cliExists('claude')) ? 'login' : 'missing',
    run: () => {
      throw new Error('Claude Code adapter not implemented');
    }
  };
}

function createCursorAdapter(): CodeAgentAdapter {
  return {
    id: 'cursor',
    label: 'Cursor Agent',
    driver: 'CLI/ACP',
    detail: 'Cursor coding agent',
    detect: async () => 'disabled',
    run: () => {
      throw new Error('Cursor Agent adapter not implemented');
    }
  };
}

function createOpencodeAdapter(): CodeAgentAdapter {
  return {
    id: 'opencode',
    label: 'OpenCode',
    driver: 'CLI/server',
    detail: 'OpenCode runtime',
    detect: async () => (await cliExists('opencode')) ? 'ready' : 'missing',
    run: () => {
      throw new Error('OpenCode adapter not implemented');
    }
  };
}

function createPiAdapter(): CodeAgentAdapter {
  return {
    id: 'pi',
    label: 'Pi Agent',
    driver: 'Agent',
    detail: 'Pi coding agent',
    detect: async () => 'soon',
    run: () => {
      throw new Error('Pi Agent adapter not implemented');
    }
  };
}

export function getProviderRegistry(): ProviderRegistry {
  if (!_registry) {
    _registry = {
      builtin: createBuiltinAdapter(),
      codex: createCodexAdapter(),
      claude: createClaudeAdapter(),
      cursor: createCursorAdapter(),
      opencode: createOpencodeAdapter(),
      pi: createPiAdapter()
    };
  }
  return _registry;
}

export function resolveProvider(id: CodeAgentProviderId): CodeAgentAdapter {
  return getProviderRegistry()[id] || getProviderRegistry().builtin;
}

export async function detectProviderStatus(id: CodeAgentProviderId): Promise<CodeAgentProviderStatus> {
  const adapter = resolveProvider(id);
  try {
    return await adapter.detect();
  } catch {
    return 'missing';
  }
}

export async function detectAllProviderStatuses(): Promise<Record<CodeAgentProviderId, CodeAgentProviderStatus>> {
  const registry = getProviderRegistry();
  const results = {} as Record<CodeAgentProviderId, CodeAgentProviderStatus>;
  await Promise.all(
    (Object.entries(registry) as Array<[CodeAgentProviderId, CodeAgentAdapter]>).map(async ([id, adapter]) => {
      results[id] = await adapter.detect().catch(() => 'missing' as CodeAgentProviderStatus);
    })
  );
  return results;
}

export async function runCodeAgent(args: RunAgentTaskArgs, providerId?: CodeAgentProviderId): Promise<AgentTaskResult> {
  const adapter = resolveProvider(providerId || 'builtin');
  return adapter.run(args);
}
