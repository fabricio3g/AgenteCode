<svelte:options runes={true} />

<!--
  Artifacts: everything the agent made across your chats, as a library.
  Opening one shows it full-size right here (preview, source, save, ZIP),
  with a way back to the chat it came from. Which artifact types the agent
  may produce is chosen in Settings → Artifacts.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ArrowLeft, MessageSquare, Plus, Search, Sparkles, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { Button } from '$lib/components/ui';
  import ArtifactStudio from '$lib/components/agent/ArtifactStudio.svelte';
  import ArtifactCard from './ArtifactCard.svelte';
  import { collectArtifacts, filterArtifacts, type ArtifactGroup, type LibraryEntry } from './artifact-library';

  let query = $state('');
  let group = $state<ArtifactGroup | 'all'>('all');
  let dirty = $state(false);

  const entries = $derived(collectArtifacts(appStore.chats));
  const visible = $derived(filterArtifacts(entries, query, group));
  const open = $derived(entries.find((entry) => entry.key === appStore.artifactScreenKey) ?? null);
  const returnChat = $derived(appStore.artifactReturnChatId ? appStore.chats.find((chat) => chat.id === appStore.artifactReturnChatId) ?? null : null);
  const groups = $derived(
    (['documents', 'presentations', 'spreadsheets', 'visuals', 'web'] as ArtifactGroup[])
      .map((id) => ({ id, count: entries.filter((entry) => entry.group === id).length }))
      .filter((item) => item.count > 0)
  );

  function leaveOpen(next: () => void) {
    if (!dirty) return next();
    confirmStore.show({
      title: $t('artifacts.studio.discardTitle'),
      message: $t('artifacts.studio.discardMessage'),
      confirmLabel: $t('artifacts.studio.discardConfirm'),
      danger: true,
      onConfirm: next
    });
  }

  function back() {
    leaveOpen(() => {
      dirty = false;
      if (returnChat) appStore.selectChat(returnChat.id);
      else appStore.showArtifactLibrary();
    });
  }

  function goToChat(entry: LibraryEntry) {
    leaveOpen(() => appStore.selectChat(entry.chatId));
  }

  function newChat() {
    appStore.createChat('home');
  }
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label={$t('artifacts.title')}>
  {#if open}
    <!-- One artifact, full-size -->
    <header class="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
      <Button variant="ghost" size="sm" onclick={back}><ArrowLeft /> {returnChat ? $t('artifacts.backToChat') : $t('artifacts.title')}</Button>
      <span class="h-4 w-px bg-[var(--border)]" aria-hidden="true"></span>
      <div class="min-w-0 flex-1 px-1">
        <p class="truncate text-[13px] font-medium text-foreground">{open.artifact.title || $t('artifacts.untitled')}</p>
        <p class="truncate text-[11px] text-muted-foreground">{$t(`artifacts.group.${open.group}`)} · {open.chatTitle}</p>
      </div>
      {#if !returnChat}<Button variant="outline" size="sm" onclick={() => goToChat(open)}><MessageSquare /> {$t('artifacts.openChat')}</Button>{/if}
    </header>
    <div class="min-h-0 flex-1">
      {#key open.key}
        <ArtifactStudio artifact={open.artifact} chatId={open.chatId} messageId={open.messageId} bind:dirty />
      {/key}
    </div>
  {:else}
    <div class="ui-top-fade flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-[1100px] px-5 pb-10 pt-8 sm:px-8">
          <header>
            <h1 class="text-2xl font-semibold tracking-[-0.02em] text-foreground">{$t('artifacts.title')}</h1>
            <p class="mt-1 text-sm text-muted-foreground">{$t('artifacts.description')}</p>
          </header>

          {#if !entries.length}
            <!-- Nothing made yet: say what this place is for and how to fill it. -->
            <div class="mt-16 flex flex-col items-center text-center">
              <span class="flex size-14 items-center justify-center rounded-2xl bg-[var(--muted)] text-muted-foreground"><Sparkles class="size-6" /></span>
              <h2 class="mt-4 text-base font-semibold text-foreground">{$t('artifacts.emptyTitle')}</h2>
              <p class="mt-1 max-w-sm text-sm text-muted-foreground">{$t('artifacts.emptyHint')}</p>
              <Button class="mt-5" onclick={newChat}><Plus /> {$t('artifacts.newChat')}</Button>
            </div>
          {:else}
            <!-- Search and filters -->
            <div class="mt-6 flex flex-wrap items-center gap-2">
              <div class="relative min-w-[14rem] flex-1">
                <Search class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  class="h-10 w-full rounded-full border border-border bg-background pl-10 pr-9 text-sm text-foreground outline-none transition focus:border-[var(--border-hover)]"
                  bind:value={query}
                  placeholder={$t('artifacts.search')}
                  aria-label={$t('artifacts.search')}
                />
                {#if query}
                  <button type="button" class="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--surface-hover)]" aria-label={$t('artifacts.clearSearch')} onclick={() => (query = '')}><X class="size-3.5" /></button>
                {/if}
              </div>
            </div>
            <div class="mt-3 flex flex-wrap gap-1.5" role="group" aria-label={$t('artifacts.filter')}>
              <button type="button" class="chip" class:is-on={group === 'all'} aria-pressed={group === 'all'} onclick={() => (group = 'all')}>
                {$t('artifacts.all')} <span class="chip-count">{entries.length}</span>
              </button>
              {#each groups as item (item.id)}
                <button type="button" class="chip" class:is-on={group === item.id} aria-pressed={group === item.id} onclick={() => (group = item.id)}>
                  {$t(`artifacts.group.${item.id}`)} <span class="chip-count">{item.count}</span>
                </button>
              {/each}
            </div>

            {#if visible.length}
              <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {#each visible as entry (entry.key)}
                  <ArtifactCard {entry} onopen={() => appStore.openArtifactScreen(entry.chatId, entry.messageId, entry.index, null)} />
                {/each}
              </div>
            {:else}
              <p class="mt-12 text-center text-sm text-muted-foreground">{$t('artifacts.noMatches')}</p>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    height: 2rem;
    padding: 0 0.875rem;
    border: 1px solid var(--border);
    border-radius: 9999px;
    font-size: 12.5px;
    color: var(--muted-foreground);
    background: var(--background);
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease), border-color var(--motion-fast) var(--motion-ease);
  }
  .chip:hover {
    color: var(--foreground);
    background: var(--surface-hover);
  }
  .chip.is-on {
    border-color: var(--foreground);
    background: var(--foreground);
    color: var(--background);
  }
  .chip-count {
    font-size: 11px;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }
</style>
