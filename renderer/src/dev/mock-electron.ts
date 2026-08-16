// Dev-only browser harness (?mock=1): installs a scripted window.electronAPI
// so the renderer can be exercised in a plain browser without Electron.
// Never imported unless the query flag is present (see src/main.ts).

type Listener = (payload: unknown) => void;

const eventListeners = new Map<string, Set<Listener>>();
const savedSessions: unknown[] = [];
const savedProjects: Record<string, unknown>[] = [
  {
    id: 'proj-1',
    rootPath: '/home/work/Code/demo-app',
    rootName: 'demo-app',
    icon: null,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 3_600_000
  }
];

const config = {
  llm: {
    backend_mode: 'api',
    provider: 'anthropic',
    providers: {
      anthropic: { base_url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', api_key: 'mock-key' }
    }
  },
  ui: {},
  search: { engines: {} }
};

function emit(channel: string, payload: unknown): void {
  for (const listener of eventListeners.get(channel) ?? []) {
    setTimeout(() => listener(payload), 0);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scripted agent run: text → read tool → approval-gated write → summary. */
async function scriptAgentRun(chatId: string): Promise<void> {
  const send = (payload: Record<string, unknown>) => emit('code_agent_event', { chatId, ...payload });

  await wait(150);
  send({ type: 'agent_start' });
  await wait(100);
  send({ type: 'turn_start', turnIndex: 1 });

  for (const delta of ['Alright, ', 'let me inspect ', 'the project first.']) {
    await wait(120);
    send({ type: 'text_delta', delta });
  }

  await wait(150);
  send({ type: 'tool_start', toolCallId: 'tc-read-1', toolName: 'read', args: { path: 'src/index.ts' } });
  await wait(400);
  send({ type: 'tool_end', toolCallId: 'tc-read-1', result: '1  import { boot } from "./app";\n2  boot();', isError: false });

  await wait(200);
  send({ type: 'tool_start', toolCallId: 'tc-write-1', toolName: 'edit', args: { path: 'src/index.ts' } });
  await wait(250);
  send({ type: 'approval_request', requestId: 'apr-1', toolName: 'edit', args: { path: 'src/index.ts' }, diff: '--- src/index.ts\n+++ src/index.ts\n-boot();\n+boot({ verbose: true });' });

  // The decision arrives when the user clicks Allow/Deny (agente_respond_approval).
}

async function finishApprovedRun(chatId: string, decision: 'allow' | 'deny'): Promise<void> {
  const send = (payload: Record<string, unknown>) => emit('code_agent_event', { chatId, ...payload });
  send({ type: 'approval_resolved', requestId: 'apr-1', decision });
  await wait(200);
  send({
    type: 'tool_end',
    toolCallId: 'tc-write-1',
    result: decision === 'allow' ? 'Edited src/index.ts: replaced 1 occurrence(s).' : 'Blocked: user denied.',
    isError: decision !== 'allow'
  });
  await wait(150);
  send({
    type: 'checkpoint_finalized',
    turnIndex: 1,
    files: decision === 'allow' ? [{ path: 'src/index.ts', additions: 1, deletions: 1, kind: 'modified' }] : []
  });
  await wait(150);
  for (const delta of decision === 'allow'
    ? ['Done — ', '`src/index.ts` now boots with verbose mode. ', 'Tests would go here next.']
    : ['Understood — ', 'I left the file untouched. ', 'Tell me how you\u2019d like to proceed.']) {
    await wait(120);
    send({ type: 'text_delta', delta });
  }
  await wait(150);
  send({ type: 'turn_end', turnIndex: 1 });
  send({ type: 'agent_end' });
}

const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
  get_config: () => config,
  save_config: () => ({}),
  update_config: () => ({}),
  is_first_run: () => false,
  get_hardware_limits: () => ({ total_memory_gb: 32, cpu_cores: 8, has_gpu: false }),
  get_desktop_capabilities: () => ({ platform: 'linux', capabilities: [] }),
  get_runtime_recommendations: () => ({}),

  chat_db_load_all: () => savedSessions,
  chat_db_save_session: (args) => {
    savedSessions.unshift((args as { session: unknown } | undefined)?.session ?? null);
    return { ok: true };
  },
  chat_db_delete: () => ({ ok: true }),
  chat_db_migrate: () => ({ migrated: 0 }),
  chat_db_load_folders: () => [],
  chat_db_save_folder: () => ({ ok: true }),
  chat_db_delete_folder: () => ({ ok: true }),
  chat_db_load_code_projects: () => savedProjects,
  chat_db_save_code_project: (args) => {
    const project = (args as { project?: Record<string, unknown> } | undefined)?.project;
    if (project && !savedProjects.some((p) => p.id === project.id)) savedProjects.unshift(project);
    return { ok: true };
  },
  chat_db_delete_code_project: () => ({ ok: true }),

  pick_workspace_folder: () => '/home/work/Code/another-demo',

  fetch_provider_models: () => [],
  detect_tool_support: () => ({ supportsTools: true, source: 'mock' }),
  get_reasoning_capabilities: () => ({ supported: false, levels: [], paramShape: 'openai_reasoning_effort', source: 'mock' }),
  count_tokens: () => 0,
  build_context_budget: () => ({}),

  'agente_detect': () => ({ status: 'ready' }),
  'agente_start_session': () => ({ sessionId: `sess-${Date.now()}`, resumed: false }),
  'agente_prompt': (args) => {
    void scriptAgentRun(String((args as { chatId?: string } | undefined)?.chatId ?? ''));
    return { ok: true };
  },
  'agente_steer': () => ({ ok: true }),
  'agente_follow_up': () => ({ ok: true }),
  'agente_abort': () => ({ ok: true }),
  'agente_compact': () => ({ ok: true }),
  'agente_set_model': () => ({ ok: true }),
  'agente_set_runtime_mode': () => ({ ok: true }),
  'agente_respond_approval': (args) => {
    const { chatId, decision } = (args ?? {}) as { chatId?: string; decision?: 'allow' | 'deny' };
    void finishApprovedRun(String(chatId ?? ''), decision === 'deny' ? 'deny' : 'allow');
    return { ok: true };
  },
  'agente_list_checkpoints': () => [{ turnIndex: 1, createdAt: Date.now(), fileCount: 1, additions: 1, deletions: 1 }],
  'agente_rollback': () => ({ ok: true, restored: 1 }),
  'agente_close': () => ({ ok: true }),
  'agente_new_session': () => ({ ok: true, sessionId: `sess-${Date.now()}` }),
  'agente_cycle_model': () => ({ ok: false }),
  'agente_list_sessions': () => [],
  'agente_list_extensions': () => [
    { id: 'git-tools', name: 'Git Tools', description: 'Adds git_status and git_diff tools (read-only).', enabled: true, defaultEnabled: true },
    { id: 'safety-rails', name: 'Safety Rails', description: 'Blocks destructive commands before execution.', enabled: true, defaultEnabled: true }
  ],
  'agente_set_extension_enabled': () => ({ ok: true })
};

export function installMockElectron(): void {
  if (window.electronAPI) return;
  window.electronAPI = {
    isElectron: true,
    platform: 'linux',
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = handlers[channel];
      if (handler) return Promise.resolve(handler(args[0] as Record<string, unknown> | undefined));
      // Unknown channels resolve benignly so boot never crashes in the harness.
      console.warn(`[mock-electron] unhandled channel: ${channel}`);
      return Promise.resolve(null);
    },
    on: (channel: string, callback: Listener) => {
      let set = eventListeners.get(channel);
      if (!set) {
        set = new Set();
        eventListeners.set(channel, set);
      }
      set.add(callback);
      return () => set!.delete(callback);
    },
    once: (channel: string, callback: Listener) => {
      const wrapped: Listener = (payload) => {
        eventListeners.get(channel)?.delete(wrapped);
        callback(payload);
      };
      let set = eventListeners.get(channel);
      if (!set) {
        set = new Set();
        eventListeners.set(channel, set);
      }
      set.add(wrapped);
      return () => set!.delete(wrapped);
    },
    windowMinimize: () => Promise.resolve(),
    windowToggleMaximize: () => Promise.resolve(),
    windowIsMaximized: () => Promise.resolve(false),
    windowClose: () => Promise.resolve(),
    windowRequestClose: () => Promise.resolve({ closed: true, prompted: false }),
    windowSetActiveWork: () => Promise.resolve()
  } as unknown as Window['electronAPI'];
  console.info('[mock-electron] scripted bridge installed (?mock=1)');
}

installMockElectron();
