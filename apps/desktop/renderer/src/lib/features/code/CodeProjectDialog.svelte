<svelte:options runes={true} />

<!--
  The project's agent setup, one section at a time (from the composer's "…"
  menu or its slash command): skills and custom commands, subagents and the
  model each uses, MCP servers, saved sessions to resume, and the runtime
  settings. Rows follow the settings list style: name, one line of detail,
  actions on the right.
-->

<script lang="ts">
  import { cn as uiClass } from '$lib/utils/cn';

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
  import BotModelPicker from '$lib/features/bots/BotModelPicker.svelte';
  import SubagentCard from './SubagentCard.svelte';
  import CompactionReport from './CompactionReport.svelte';
  import { appStore } from '$lib/stores/app.svelte';

  let { chatId, projectRoot, section, onclose }: { chatId: string; projectRoot?: string; section: CodeDialog; onclose: () => void } = $props();

  type Settings = { smart_compaction: boolean; compaction_model?: {provider: string; model: string; thinking?: string}; max_parallel_subagents: number; subagent_models: Record<string, { provider: string; model: string; thinking?: string }>; allow_media: string[] };

  let info = $state<ProjectInfo | null>(null);
  let servers = $state<McpServer[]>([]);
  let sessions = $state<SessionInfo[]>([]);
  let error = $state('');
  let compacting = $state(false);
  async function compactNow(smart: boolean) {
    compacting = true; error = '';
    try { if (smart) await invoke('agente_runtime_configure', { compaction_model: settings.compaction_model ?? null }); const result = await codeStore.compact(chatId, smart); if (!result.ok) error = result.error || 'Compaction failed'; } catch (cause) { error = String(cause); } finally { compacting = false; }
  }
  let loading = $state(true);
  let settings = $state<Settings>({ smart_compaction: false, max_parallel_subagents: 8, subagent_models: {}, allow_media: [] });
  const run = $derived(codeStore.runFor(chatId));
  const compactReport = $derived.by(() => {
    const messages = appStore.chats.find(chat => chat.id === chatId)?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index--) if (messages[index]!.metadata?.codeCompaction) return messages[index]!.metadata!.codeCompaction;
    return undefined;
  });
  const MEDIA = ['image', 'audio', 'video'] as const;
  /** Only these sections ask the engine about a project directory. */
  const needsProject = $derived(['skills', 'agents', 'mcp'].includes(section));

  onMount(() => void load());

  async function load(silent = false) {
    if (!silent) loading = true;
    error = '';
    try {
      if (section === 'mcp') servers = await mcpStatus(projectRoot!);
      else if (section === 'sessions') sessions = await invoke<SessionInfo[]>('agente_session_list');
      else if (section === 'settings') settings = await invoke<Settings>('agente_runtime_settings') ?? settings;
      else {
        info = projectRoot ? await projectInfo(projectRoot) : null;
        if (section === 'agents') settings = await invoke<Settings>('agente_runtime_settings') ?? settings;
      }
      if (settings.compaction_model?.provider.startsWith('desktop-')) settings.compaction_model = { ...settings.compaction_model, provider: settings.compaction_model.provider.slice(8) };
      lastSaved = snapshot();
    } catch (cause) {
      error = String(cause);
    } finally {
      loading = false;
    }
  }

  async function controlServer(name: string, action: 'approve' | 'reconnect' | 'disable') {
    try {
      await invoke('agente_mcp_control', { projectRoot: projectRoot!, name, action });
      await load(true);
    } catch (cause) {
      error = String(cause);
    }
  }

  function insert(name: string) {
    window.dispatchEvent(new CustomEvent('code-composer-draft', { detail: `/${name} ` }));
    onclose();
  }

  async function chooseModel(kind: string, pin: { provider: string; model: string; thinking?: string } | null | undefined) {
    try {
      await codeStore.ensureSession(chatId);
      await invoke('agente_subagent_model', { chatId, kind, pin });
      await load(true);
    } catch (cause) {
      toastStore.error(String(cause));
    }
  }

  function toggleMedia(kind: string, on: boolean) {
    settings.allow_media = on ? [...new Set([...settings.allow_media, kind])] : settings.allow_media.filter((item) => item !== kind);
  }

  /** Settings apply as they change: there is no Save to forget. */
  const snapshot = () => JSON.stringify({
    smart: settings.smart_compaction,
    model: settings.compaction_model ?? null,
    parallel: Math.max(1, Math.min(32, Math.round(Number(settings.max_parallel_subagents) || 1))),
    media: [...settings.allow_media].sort()
  });
  let lastSaved = '';
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle');

  $effect(() => {
    if (section !== 'settings' || loading) return;
    const next = snapshot();
    if (next === lastSaved) return;
    const timer = setTimeout(async () => {
      saveState = 'saving';
      try {
        const value = JSON.parse(next) as { smart: boolean; model: Settings['compaction_model'] | null; parallel: number; media: string[] };
        await invoke('agente_runtime_configure', {
          smart_compaction: value.smart,
          compaction_model: value.model,
          max_parallel_subagents: value.parallel,
          allow_media: value.media
        });
        lastSaved = next;
        error = '';
        saveState = 'saved';
      } catch (cause) {
        error = String(cause);
        saveState = 'idle';
      }
    }, 350);
    return () => clearTimeout(timer);
  });
</script>

<Dialog title={$t(`code.project.${section}.title`)} description={$t(`code.project.${section}.hint`)} {onclose} size="lg">
  <div class="space-y-1 p-3 text-sm">
    {#if error}<p class="px-2 pb-2 text-[13px] text-error" role="alert">{error}</p>{/if}

    {#if loading}
      <p class="px-2 py-3 text-[13px] text-muted-foreground">{$t('code.project.loading')}</p>
    {:else if needsProject && !projectRoot}
      <p class="empty">{$t('code.project.needsProject')}</p>
    {:else if section === 'skills' && info}
      {#each [...info.skills, ...info.commands] as item (item.name)}
        <Button variant="plain" type="button" class={uiClass("row w-full text-left", "ui-local-323c2339")} onclick={() => insert(item.name)}>
          <span class="text-[12.5px] text-foreground">/{item.name}</span>
          <span class="row-detail">{item.description}</span>
        </Button>
      {:else}
        <p class="empty">{$t('code.project.skills.empty')}</p>
      {/each}
    {:else if section === 'agents' && info}
      {#each run?.children ?? [] as child (child.id)}<SubagentCard {child} id={`project:${child.id}`} />{/each}
      <!-- One card per type, with the same picker the bot editor uses: the
           provider, the model and the thinking level it runs at. Unpinned is a
           state, not a button that guesses the chat's model. -->
      {#each [{ name: '*', description: $t('code.project.agents.all'), builtin: true }, ...info.agents] as agent (agent.name)}
        {@const pin = settings.subagent_models[agent.name]}
        <div class="agent-row" class:is-default={agent.name === '*'}>
          <div class="min-w-0">
            <p class="agent-name">{agent.name === '*' ? $t('code.project.agents.defaultName') : agent.name}</p>
            <p class="row-detail clamp-2">{agent.name === '*' ? $t('code.project.agents.defaultHint') : agent.description}</p>
          </div>
          <div class="agent-pick">
            <BotModelPicker compact value={pin} onchange={(next) => chooseModel(agent.name, next)} />
            {#if pin}<Button variant="plain" type="button" class={uiClass("agent-reset", "ui-local-323c2339")} onclick={() => chooseModel(agent.name, null)}>{$t('code.project.agents.reset')}</Button>{/if}
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
      <div class="flex justify-end px-2 pt-2"><Button size="sm" variant="ghost" onclick={() => load()}><RefreshCw /> {$t('code.project.mcp.refresh')}</Button></div>
    {:else if section === 'sessions'}
      {#each sessions.filter((session) => !session.profile) as session (session.session_id)}
        <Button variant="plain" type="button" class={uiClass("row w-full text-left", "ui-local-323c2339")} onclick={() => { void codeStore.importSession(session).then(onclose).catch((cause) => (error = String(cause))); }}>
          <span class="block truncate text-[13px] font-medium text-foreground">{session.title || session.first_prompt || session.session_id}</span>
          <span class="row-detail block truncate">{session.project_dir} · {$t('code.project.sessions.messages', { values: { n: session.message_count || 0 } })}</span>
        </Button>
      {:else}
        <p class="empty">{$t('code.project.sessions.empty')}</p>
      {/each}
    {:else if section === 'settings'}
      <h3 class="group">{$t('code.project.settings.context')}</h3>
      <div class="row" title={$t('code.project.settings.smartCompactionHint')}>
        <span class="min-w-0 flex-1">
          <span class="row-title">{$t('code.project.settings.smartCompaction')}</span>
        </span>
        <Switch label={$t('code.project.settings.smartCompaction')} bind:checked={settings.smart_compaction} />
      </div>
      <div class="row" title={$t('code.compaction.modelHint')}>
        <span class="min-w-0 flex-1">
          <span class="row-title">{$t('code.compaction.model')}</span>
        </span>
        <div class="model-cell"><BotModelPicker compact bind:value={settings.compaction_model} /></div>
      </div>
      <div class="row" title={$t('code.compaction.settingsHint')}>
        <span class="min-w-0 flex-1">
          <span class="row-title">{$t('code.project.settings.compactNow')}</span>
        </span>
        <div class="flex shrink-0 gap-1.5">
          <Button size="sm" variant="outline" disabled={compacting || !!run?.running} loading={compacting} onclick={() => compactNow(true)}>{$t('code.compaction.smartNow')}</Button>
          <Button size="sm" variant="outline" disabled={compacting || !!run?.running} onclick={() => compactNow(false)}>{$t('code.compaction.trimNow')}</Button>
        </div>
      </div>
      {#if compactReport}<div class="px-2.5"><CompactionReport report={compactReport} /></div>{:else if compacting}<p class="px-2.5 text-xs text-muted-foreground" role="status">{$t('code.compaction.working')}</p>{/if}

      <h3 class="group">{$t('code.project.settings.subagents')}</h3>
      <div class="row">
        <span class="min-w-0 flex-1 row-title">{$t('code.project.settings.parallel')}</span>
        <Input class="w-20" type="number" min="1" max="32" bind:value={settings.max_parallel_subagents} aria-label={$t('code.project.settings.parallel')} />
      </div>

      <h3 class="group">{$t('code.project.settings.media')}</h3>
      {#each MEDIA as kind (kind)}
        <div class="row">
          <span class="min-w-0 flex-1 row-title">{$t(`code.project.settings.${kind}`)}</span>
          <Switch label={$t(`code.project.settings.${kind}`)} checked={settings.allow_media.includes(kind)} onchange={(on) => toggleMedia(kind, on)} />
        </div>
      {/each}
      <p class="save-state" role="status" aria-live="polite">{saveState === 'saving' ? $t('code.project.settings.saving') : saveState === 'saved' ? $t('code.project.settings.saved') : ''}</p>
    {/if}
  </div>
</Dialog>

<style>
  .group { padding: 1rem 0.625rem 0.25rem; font-size: var(--text-xs); font-weight: 500; letter-spacing: 0.02em; text-transform: uppercase; color: var(--muted-foreground); }
  .group:first-child { padding-top: 0.25rem; }
  .model-cell { flex: 0 1 16rem; min-width: 0; }
  .agent-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 16rem); align-items: start; gap: 0.75rem; padding: 0.625rem; border-radius: 0.625rem; }
  .agent-row + .agent-row { border-top: 1px solid var(--border-subtle); border-radius: 0; }
  .agent-row.is-default { background: var(--surface-hover); border-radius: 0.625rem; margin-bottom: 0.25rem; }
  .agent-row.is-default + .agent-row { border-top: 0; }
  .agent-name { font-size: 13px; font-weight: 500; color: var(--foreground); }
  .agent-pick { display: flex; min-width: 0; flex-direction: column; align-items: flex-end; gap: 0.125rem; }
  :global(.agent-reset.ui-local-323c2339) { font-size: var(--text-xs); color: var(--muted-foreground); }
  :global(.agent-reset:hover.ui-local-323c2339) { color: var(--foreground); text-decoration: underline; text-underline-offset: 2px; }
  .clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  @media (max-width: 560px) { .agent-row { grid-template-columns: minmax(0, 1fr); } .agent-pick { justify-items: stretch; } }
  .row-title { font-size: 13px; color: var(--foreground); }
  .save-state { padding: 1rem 0.625rem 0.25rem; font-size: var(--text-xs); color: var(--muted-foreground); }

  :is(.row, :global(.row.ui-local-323c2339)) {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.75rem;
    border-radius: 0.625rem;
    padding: 0.5rem 0.625rem;
  }
  :global(button.row.ui-local-323c2339) {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
  }
  :global(button.row:hover.ui-local-323c2339) { background: var(--surface-hover); }
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
