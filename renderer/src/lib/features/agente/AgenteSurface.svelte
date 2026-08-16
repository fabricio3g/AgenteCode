<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { FolderPlus, History, RotateCcw, Terminal } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { agenteStore } from './agente.svelte';
  import { rollbackAgente } from './agente-ipc';
  import AgentTranscript from './AgentTranscript.svelte';
  import AgenteComposer from './AgenteComposer.svelte';

  onMount(() => {
    void agenteStore.load();
  });

  const activeProject = $derived(agenteStore.projectById(agenteStore.activeProjectId));
  /** The chat currently selected in the work space, when it belongs to a project. */
  const chat = $derived.by(() => {
    const current = appStore.currentChat;
    if (current?.projectId && current.projectId === agenteStore.activeProjectId) return current;
    return null;
  });
  const run = $derived(agenteStore.runFor(chat?.id));

  async function rollback(turnIndex: number) {
    if (!chat) return;
    const result = await rollbackAgente(chat.id, turnIndex);
    if (result.ok) {
      await agenteStore.refreshCheckpoints(chat.id);
    }
  }
</script>

<div class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
  {#if !agenteStore.loaded && agenteStore.loading}
    <div class="flex flex-1 items-center justify-center"></div>
  {:else if !agenteStore.projects.length}
    <div class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <div class="flex size-12 items-center justify-center rounded-2xl border border-border bg-muted">
        <Terminal class="size-6 text-muted-foreground" />
      </div>
      <div class="max-w-md space-y-1">
        <h1 class="text-xl font-semibold tracking-tight text-foreground">{$t('agente.surfaceTitle')}</h1>
        <p class="text-sm leading-relaxed text-muted-foreground">{$t('agente.noProjectsHint')}</p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        onclick={() => void agenteStore.addProject()}
      >
        <FolderPlus class="size-4" />
        {$t('agente.addProject')}
      </button>
    </div>
  {:else if chat}
    <!-- Conversation header: project, model, checkpoints -->
    <div class="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/80 px-4 backdrop-blur">
      <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span class="truncate font-medium text-foreground">{activeProject?.rootName ?? chat.title}</span>
        {#if agenteStore.modelLabel}
          <span class="hidden truncate font-mono text-[10px] sm:inline">{agenteStore.modelLabel}</span>
        {/if}
      </div>
      {#if run?.checkpoints?.length}
        <div class="flex items-center gap-1">
          <History class="size-3.5 text-muted-foreground" />
          {#each run.checkpoints.slice(-3).reverse() as checkpoint (checkpoint.turnIndex)}
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
              title={$t('agente.rollbackTo', { values: { turn: checkpoint.turnIndex } })}
              onclick={() => void rollback(checkpoint.turnIndex)}
            >
              <RotateCcw class="size-3" />
              T{checkpoint.turnIndex} · +{checkpoint.additions}/-{checkpoint.deletions}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <AgentTranscript messages={chat.messages} chatId={chat.id} />
    <AgenteComposer {chat} />
  {:else}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div class="flex size-12 items-center justify-center rounded-2xl border border-border bg-muted">
        <Terminal class="size-6 text-muted-foreground" />
      </div>
      {#if activeProject}
        <p class="max-w-md text-sm leading-relaxed text-muted-foreground">
          {$t('agente.startConversation')}
        </p>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          onclick={() => void agenteStore.newConversation(activeProject)}
        >
          <Terminal class="size-4" />
          {$t('agente.newConversation')}
        </button>
      {:else}
        <p class="max-w-md text-sm leading-relaxed text-muted-foreground">{$t('agente.surfacePickProject')}</p>
      {/if}
    </div>
  {/if}
</div>
