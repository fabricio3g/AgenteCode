<svelte:options runes={true} />

<!--
  The project's agent setup, one section at a time (from the composer's "…"
  menu or its slash command): skills and custom commands, subagents and the
  model each uses, MCP servers, saved sessions to resume, and the runtime
  settings. Rows follow the settings list style: name, one line of detail,
  actions on the right.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { RefreshCw } from 'lucide-svelte';
  import { Button, Dialog, Input, Switch } from '$lib/components/ui';
  import { invoke } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import type { SessionInfo } from '$shared/agente-protocol.gen';
  import { projectInfo, mcpStatus, type ProjectInfo, type McpServer } from './code-ipc';
  import { codeStore } from './code.svelte';
  import type { CodeDialog } from './code-commands';
  import SubagentCard from './SubagentCard.svelte';

  let { chatId, projectRoot, section, onclose }: { chatId: string; projectRoot: string; section: CodeDialog; onclose: () => void } = $props();

  type Settings = { smart_compaction: boolean; max_parallel_subagents: number; subagent_models: Record<string, { provider: string; model: string }>; allow_media: string[] };

  let info = $state<ProjectInfo | null>(null);
  let servers = $state<McpServer[]>([]);
  let sessions = $state<SessionInfo[]>([]);
  let error = $state('');
  let loading = $state(true);
  let settings = $state<Settings>({ smart_compaction: false, max_parallel_subagents: 8, subagent_models: {}, allow_media: [] });
  const run = $derived(codeStore.runFor(chatId));
  const MEDIA = ['image', 'audio', 'video'] as const;

  onMount(() => void load());

  async function load() {
    loading = true;
    error = '';
    try {
      if (section === 'mcp') servers = await mcpStatus(projectRoot);
      else if (section === 'sessions') sessions = await invoke<SessionInfo[]>('agente_session_list');
      else if (section === 'settings') settings = await invoke<Settings>('agente_runtime_settings');
      else {
        info = await projectInfo(projectRoot);
        if (section === 'agents') settings = await invoke<Settings>('agente_runtime_settings');
      }
    } catch (cause) {
      error = String(cause);
    } finally {
      loading = false;
    }
  }

  async function controlServer(name: string, action: 'approve' | 'reconnect' | 'disable') {
    try {
      await invoke('agente_mcp_control', { projectRoot, name, action });
      await load();
    } catch (cause) {
      error = String(cause);
    }
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
    } catch (cause) {
      toastStore.error(String(cause));
    }
  }

  function toggleMedia(kind: string, on: boolean) {
    settings.allow_media = on ? [...new Set([...settings.allow_media, kind])] : settings.allow_media.filter((item) => item !== kind);
  }

  async function save() {
    try {
      await invoke('agente_runtime_configure', {
        smart_compaction: settings.smart_compaction,
        max_parallel_subagents: Math.max(1, Math.min(32, Math.round(Number(settings.max_parallel_subagents) || 1))),
        allow_media: settings.allow_media
      });
      onclose();
    } catch (cause) {
      error = String(cause);
    }
  }
</script>

<Dialog title={$t(`code.project.${section}.title`)} description={$t(`code.project.${section}.hint`)} {onclose} size="md">
  <div class="space-y-1 p-3 text-sm">
    {#if error}<p class="px-2 pb-2 text-[13px] text-error" role="alert">{error}</p>{/if}

    {#if loading}
      <p class="px-2 py-3 text-[13px] text-muted-foreground">{$t('code.project.loading')}</p>
    {:else if section === 'skills' && info}
      {#each [...info.skills, ...info.commands] as item (item.name)}
        <button type="button" class="row w-full text-left" onclick={() => insert(item.name)}>
          <span class="text-[12.5px] text-foreground">/{item.name}</span>
          <span class="row-detail">{item.description}</span>
        </button>
      {:else}
        <p class="empty">{$t('code.project.skills.empty')}</p>
      {/each}
    {:else if section === 'agents' && info}
      {#each run?.children ?? [] as child (child.id)}<SubagentCard {child} />{/each}
      {#each [{ name: '*', description: $t('code.project.agents.all'), builtin: true }, ...info.agents] as agent (agent.name)}
        <div class="row">
          <div class="min-w-0 flex-1">
            <p class="text-[13px] font-medium text-foreground">{agent.name}</p>
            <p class="row-detail">{agent.description}</p>
            <p class="row-detail">{settings.subagent_models[agent.name]?.model || $t('code.project.agents.inherit')}</p>
          </div>
          <div class="flex shrink-0 gap-1">
            <Button size="sm" variant="ghost" onclick={() => chooseModel(agent.name, false)}>{$t('code.project.agents.useModel')}</Button>
            {#if settings.subagent_models[agent.name]}<Button size="sm" variant="ghost" onclick={() => chooseModel(agent.name, true)}>{$t('code.project.agents.reset')}</Button>{/if}
          </div>
        </div>
      {/each}
    {:else if section === 'mcp'}
      {#each servers as server (server.name)}
        <div class="row">
          <div class="min-w-0 flex-1">
            <p class="text-[13px] font-medium text-foreground">{server.name} <span class="font-normal text-muted-foreground">· {$t(`code.project.mcp.status.${server.status}`)} · {$t('code.project.mcp.tools', { values: { n: server.tools } })}</span></p>
            <p class="row-detail break-all">{server.error || server.target}</p>
          </div>
          <div class="flex shrink-0 gap-1">
            {#if server.status === 'needs_approval'}
              <Button size="sm" onclick={() => controlServer(server.name, 'approve')}>{$t('code.project.mcp.approve')}</Button>
            {:else}
              <Button size="sm" variant="ghost" onclick={() => controlServer(server.name, 'reconnect')}>{$t('code.project.mcp.reconnect')}</Button>
              <Button size="sm" variant="ghost" onclick={() => controlServer(server.name, 'disable')}>{$t('code.project.mcp.disable')}</Button>
            {/if}
          </div>
        </div>
      {:else}
        <p class="empty">{$t('code.project.mcp.empty')}</p>
      {/each}
      <div class="flex justify-end px-2 pt-2"><Button size="sm" variant="ghost" onclick={load}><RefreshCw /> {$t('code.project.mcp.refresh')}</Button></div>
    {:else if section === 'sessions'}
      {#each sessions.filter((session) => !session.profile) as session (session.session_id)}
        <button type="button" class="row w-full text-left" onclick={() => { void codeStore.importSession(session).then(onclose).catch((cause) => (error = String(cause))); }}>
          <span class="block truncate text-[13px] font-medium text-foreground">{session.title || session.first_prompt || session.session_id}</span>
          <span class="row-detail block truncate">{session.project_dir} · {$t('code.project.sessions.messages', { values: { n: session.message_count || 0 } })}</span>
        </button>
      {:else}
        <p class="empty">{$t('code.project.sessions.empty')}</p>
      {/each}
    {:else if section === 'settings'}
      <div class="row">
        <span class="min-w-0 flex-1 text-[13px] text-foreground">{$t('code.project.settings.smartCompaction')}</span>
        <Switch label={$t('code.project.settings.smartCompaction')} bind:checked={settings.smart_compaction} />
      </div>
      <div class="row">
        <span class="min-w-0 flex-1 text-[13px] text-foreground">{$t('code.project.settings.parallel')}</span>
        <Input class="w-20" type="number" min="1" max="32" bind:value={settings.max_parallel_subagents} aria-label={$t('code.project.settings.parallel')} />
      </div>
      <p class="px-2 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">{$t('code.project.settings.media')}</p>
      {#each MEDIA as kind (kind)}
        <div class="row">
          <span class="min-w-0 flex-1 text-[13px] text-foreground">{$t(`code.project.settings.${kind}`)}</span>
          <Switch label={$t(`code.project.settings.${kind}`)} checked={settings.allow_media.includes(kind)} onchange={(on) => toggleMedia(kind, on)} />
        </div>
      {/each}
      <div class="flex justify-end px-2 pt-3"><Button size="sm" onclick={save}>{$t('code.project.settings.save')}</Button></div>
    {/if}
  </div>
</Dialog>

<style>
  .row {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.75rem;
    border-radius: 0.625rem;
    padding: 0.5rem 0.625rem;
  }
  button.row {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
  }
  button.row:hover { background: var(--surface-hover); }
  .row-detail {
    font-size: 12px;
    line-height: 1.45;
    color: var(--muted-foreground);
  }
  .empty {
    padding: 0.75rem 0.625rem;
    font-size: 13px;
    color: var(--muted-foreground);
  }
</style>
