<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Dialog } from '$lib/components/ui';
  import { invoke } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import type { SessionInfo } from '$shared/agente-protocol.gen';
  import { projectInfo, mcpStatus, type ProjectInfo, type McpServer } from './code-ipc';
  import { codeStore } from './code.svelte';
  import SubagentCard from './SubagentCard.svelte';

  let { chatId, projectRoot, section, onclose }: { chatId: string; projectRoot: string; section: 'skills' | 'agents' | 'mcp' | 'sessions' | 'settings'; onclose: () => void } = $props();
  let info = $state<ProjectInfo | null>(null);
  let servers = $state<McpServer[]>([]);
  let sessions = $state<SessionInfo[]>([]);
  let error = $state('');
  let settings = $state({ smart_compaction: false, max_parallel_subagents: 8, subagent_models: {} as Record<string, { provider: string; model: string }>, allow_media: [] as string[] });
  const run = $derived(codeStore.runFor(chatId));
  const title = $derived(({ skills: 'Skills and commands', agents: 'Subagents', mcp: 'MCP servers', sessions: 'Resume a Rust session', settings: 'Agent settings' })[section]);
  onMount(() => { void load().catch((cause) => (error = String(cause))); });
  async function load() {
    if (section === 'mcp') servers = await mcpStatus(projectRoot);
    else if (section === 'sessions') sessions = await invoke<SessionInfo[]>('agente_session_list');
    else if (section === 'settings') settings = await invoke('agente_runtime_settings');
    else {
      info = await projectInfo(projectRoot);
      if (section === 'agents') settings = await invoke('agente_runtime_settings');
    }
  }
  async function controlServer(name: string, action: 'approve' | 'reconnect' | 'disable') {
    try {
      await invoke('agente_mcp_control', { projectRoot, name, action });
      await load();
    } catch (cause) { error = String(cause); }
  }
  function insert(name: string) {
    window.dispatchEvent(new CustomEvent('code-composer-draft', { detail: `/${name} ` }));
    onclose();
  }
  async function chooseModel(kind: string, inherit: boolean) {
    try {
      await codeStore.ensureSession(chatId);
      await invoke('agente_subagent_model', { chatId, kind, inherit });
      await load();
    } catch (cause) { toastStore.error(String(cause)); }
  }
  async function save() {
    try {
      await invoke('agente_runtime_configure', { smart_compaction: settings.smart_compaction, max_parallel_subagents: settings.max_parallel_subagents, allow_media: settings.allow_media });
      onclose();
    } catch (cause) { error = String(cause); }
  }
</script>

<Dialog {title} {onclose} size="md">
  <div class="space-y-3 p-4 text-sm">
    {#if error}<p class="text-error">{error}</p>{/if}
    {#if section === 'skills' && info}
      {#each [...info.skills, ...info.commands] as item (item.name)}
        <button type="button" class="block w-full rounded-lg p-2 text-left hover:bg-muted" onclick={() => insert(item.name)}><span class="font-medium">/{item.name}</span><span class="mt-1 block text-xs text-muted-foreground">{item.description}</span></button>
      {:else}<p class="text-muted-foreground">No project skills or custom commands found.</p>{/each}
    {:else if section === 'agents' && info}
      {#each run?.children ?? [] as child (child.id)}<SubagentCard {child} />{/each}
      {#each [{ name: '*', description: 'All subagents', builtin: true }, ...info.agents] as agent (agent.name)}
        <div class="rounded-lg p-2">
          <p class="font-medium">{agent.name}</p><p class="text-xs text-muted-foreground">{agent.description}</p>
          <p class="mt-1 text-xs text-muted-foreground">{settings.subagent_models[agent.name]?.model || 'Inherit main model'}</p>
          <div class="mt-2 flex gap-2"><Button size="sm" variant="ghost" onclick={() => chooseModel(agent.name, false)}>Use selected model</Button><Button size="sm" variant="ghost" onclick={() => chooseModel(agent.name, true)}>Reset</Button></div>
        </div>
      {/each}
    {:else if section === 'mcp'}
      <Button size="sm" variant="ghost" onclick={load}>Refresh status</Button>
      {#each servers as server (server.name)}<div class="rounded-lg p-2"><p class="font-medium">{server.name} <span class="text-xs text-muted-foreground">{server.status} · {server.tools} tools</span></p><p class="break-all text-xs text-muted-foreground">{server.error || server.target}</p><div class="mt-2 flex gap-2">
        {#if server.status === 'needs_approval'}<Button size="sm" onclick={() => controlServer(server.name, 'approve')}>Approve server</Button>{:else}<Button size="sm" variant="ghost" onclick={() => controlServer(server.name, 'reconnect')}>Reconnect</Button><Button size="sm" variant="ghost" onclick={() => controlServer(server.name, 'disable')}>Disable</Button>{/if}
      </div></div>{:else}<p class="text-muted-foreground">No MCP servers connected.</p>{/each}
    {:else if section === 'sessions'}
      {#each sessions.filter((session) => !session.profile) as session (session.session_id)}<button type="button" class="block w-full rounded-lg p-2 text-left hover:bg-muted" onclick={() => { void codeStore.importSession(session).then(onclose).catch((cause) => (error = String(cause))); }}><span class="font-medium">{session.title || session.first_prompt || session.session_id}</span><span class="block truncate text-xs text-muted-foreground">{session.project_dir} · {session.message_count || 0} messages</span></button>{:else}<p class="text-muted-foreground">No saved sessions yet.</p>{/each}
    {:else if section === 'settings'}
      <label class="flex items-center justify-between gap-3"><span>Summarize on automatic compaction</span><input type="checkbox" bind:checked={settings.smart_compaction} /></label>
      <label class="flex items-center justify-between gap-3"><span>Parallel subagents</span><input class="w-20 rounded-md bg-muted p-2" type="number" min="1" max="32" bind:value={settings.max_parallel_subagents} /></label>
      <p class="pt-2 text-xs text-muted-foreground">Attach without asking</p>
      {#each ['image', 'audio', 'video'] as kind (kind)}<label class="flex items-center justify-between gap-3"><span class="capitalize">{kind}</span><input type="checkbox" value={kind} bind:group={settings.allow_media} /></label>{/each}
      <Button size="sm" onclick={save}>Apply settings</Button>
    {/if}
  </div>
</Dialog>
