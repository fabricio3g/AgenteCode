<svelte:options runes={true} />

<!--
  The Code space surface.

  Radical calm: an almost empty canvas until there is work —
  one headline and one action per state. The conversation header carries
  only the project name; checkpoint history folds into a single popover so
  the resting bar stays quiet.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { flyAndScale } from '$lib/utils/transitions';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { codeStore } from './code.svelte';
  import { rollbackCodeAgent } from './code-ipc';
  import CodeTranscript from './CodeTranscript.svelte';
  import CodeComposer from './CodeComposer.svelte';
  import CodeExtensionsPanel from './CodeExtensionsPanel.svelte';

  onMount(() => {
    void codeStore.load();
  });

  /**
   * The conversation to show: whatever code-space chat is current AND belongs
   * to a project. Keyed off the chat's own projectId — not the sidebar's
   * project selection — so a restored conversation (currentChatIdBySpace)
   * renders even if no folder row was ever clicked.
   */
  const chat = $derived.by(() => {
    const current = appStore.currentChat;
    if (current?.projectId && current.contextMode === 'code') return current;
    return null;
  });
  const activeProject = $derived(
    codeStore.projectById(chat?.projectId ?? null) ??
      codeStore.projectById(codeStore.activeProjectId)
  );
  const run = $derived(codeStore.runFor(chat?.id));

  let historyOpen = $state(false);

  async function rollback(turnIndex: number) {
    if (!chat) return;
    historyOpen = false;
    const result = await rollbackCodeAgent(chat.id, turnIndex);
    if (result.ok) {
      await codeStore.refreshCheckpoints(chat.id);
    }
  }
</script>

<div class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
  {#if !codeStore.loaded && codeStore.loading}
    <div class="flex flex-1 items-center justify-center"></div>
  {:else if !codeStore.projects.length}
    <!-- Calm default: one headline, one action. -->
    <div class="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <div class="max-w-md space-y-2">
        <h1 class="text-2xl font-semibold tracking-tight text-foreground">{$t('code.surfaceTitle')}</h1>
        <p class="text-sm leading-relaxed text-muted-foreground">{$t('code.noProjectsHint')}</p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        onclick={() => void codeStore.addProject()}
      >
        {$t('code.addProject')}
      </button>
    </div>
  {:else if chat}
    <!-- Conversation header: project identity left, run history right. -->
    <div class="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/80 px-4 backdrop-blur">
      <div
        class="min-w-0 truncate text-xs font-medium text-foreground"
        title={activeProject?.rootPath || chat.title}
      >
        {activeProject?.rootName ?? chat.title}
      </div>

      <div class="flex shrink-0 items-center gap-2">
        {#if run?.checkpoints?.length}
          <div class="relative">
            <button
              type="button"
              class="history-trigger inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
              onclick={() => (historyOpen = !historyOpen)}
              aria-expanded={historyOpen}
            >
              History
              <span class="tabular-nums opacity-70">{run.checkpoints.length}</span>
            </button>

            {#if historyOpen}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="fixed inset-0 z-40" onclick={() => (historyOpen = false)}></div>
              <div
                class="absolute right-0 top-8 z-50 w-64 rounded-xl border border-border bg-popover p-1.5 shadow-lg"
                transition:flyAndScale={{ y: -6, start: 0.96, duration: 160 }}
              >
                <p class="px-2 pb-1 pt-1.5 text-[10px] font-semibold r text-muted-foreground">
                  Restore a checkpoint
                </p>
                {#each [...run.checkpoints].reverse() as checkpoint (checkpoint.turnIndex)}
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition hover:bg-muted"
                    title={$t('code.rollbackTo', { values: { turn: checkpoint.turnIndex } })}
                    onclick={() => void rollback(checkpoint.turnIndex)}
                  >
                    <span class="font-medium text-foreground">Turn {checkpoint.turnIndex}</span>
                    <span class="font-mono tabular-nums">
                      <span class="text-success">+{checkpoint.additions}</span>
                      <span class="text-error">−{checkpoint.deletions}</span>
                    </span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
        <CodeExtensionsPanel />
      </div>
    </div>

    <CodeTranscript messages={chat.messages} chatId={chat.id} />
    <CodeComposer {chat} />
  {:else}
    <div class="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      {#if activeProject}
        <p class="max-w-md text-sm leading-relaxed text-muted-foreground">
          {$t('code.startConversation')}
        </p>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          onclick={() => void codeStore.newConversation(activeProject)}
        >
          {$t('code.newConversation')}
        </button>
      {:else}
        <p class="max-w-md text-sm leading-relaxed text-muted-foreground">{$t('code.surfacePickProject')}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .history-trigger {
    background: transparent;
  }
</style>
