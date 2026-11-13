<svelte:options runes={true} />

<!--
  Artifacts: everything the agent made across your chats, as a library.
  Opening one shows it full-size right here (preview, source, save, ZIP),
  with a way back to the chat it came from. Which artifact types the agent
  may produce is chosen in Settings → Artifacts.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { t } from 'svelte-i18n';
  import { ArrowLeft, MessageSquare, Plus, Sparkles, Trash2 } from '$lib/icons';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { Button, FilterBar, FilterChip, PageHeader, PaneHeader } from '$lib/components/ui';
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
    (['documents', 'presentations', 'spreadsheets', 'visuals', 'learning', 'web'] as ArtifactGroup[])
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

  function confirmDelete(entry: LibraryEntry) {
    confirmStore.show({
      title: $t('artifacts.deleteTitle'),
      message: $t('artifacts.deleteMessage', { values: { title: entry.artifact.title || $t('artifacts.untitled') } }),
      confirmLabel: $t('artifacts.deleteConfirm'),
      danger: true,
      onConfirm: () => {
        const leaving = open?.key === entry.key ? returnChat : null;
        dirty = false;
        if (!appStore.deleteArtifact(entry.chatId, entry.messageId, entry.index)) return;
        if (leaving) appStore.selectChat(leaving.id);
      }
    });
  }

  function newChat() {
    appStore.createChat('home');
  }
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label={$t('artifacts.title')}>
  {#if open}
    <!-- One artifact, full-size -->
    <PaneHeader title={open.artifact.title || $t('artifacts.untitled')} subtitle={`${$t(`artifacts.group.${open.group}`)} · ${open.chatTitle}`}>
      {#snippet leading()}
        <Button variant="ghost" size="sm" onclick={back}><ArrowLeft /> {returnChat ? $t('artifacts.backToChat') : $t('artifacts.title')}</Button>
      {/snippet}
      {#snippet actions()}
        {#if !returnChat}<Button variant="outline" size="sm" onclick={() => goToChat(open)}><MessageSquare /> {$t('artifacts.openChat')}</Button>{/if}
        <IconButton label={$t('artifacts.delete')} variant="ghost" size="sm"  title={$t('artifacts.delete')} onclick={() => confirmDelete(open)}><Trash2 /></IconButton>
      {/snippet}
    </PaneHeader>
    <div class="min-h-0 flex-1">
      {#key open.key}
        <ArtifactStudio artifact={open.artifact} chatId={open.chatId} messageId={open.messageId} bind:dirty />
      {/key}
    </div>
  {:else}
    <div class="ui-top-fade flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-[1100px] px-5 pb-10 pt-8 sm:px-8">
          <PageHeader title={$t('artifacts.title')} description={$t('artifacts.description')} />

          {#if !entries.length}
            <!-- Nothing made yet: say what this place is for and how to fill it. -->
            <div class="mt-16 flex flex-col items-center text-center">
              <span class="flex size-14 items-center justify-center rounded-2xl bg-[var(--muted)] text-muted-foreground"><Sparkles class="size-6" /></span>
              <h2 class="mt-4 text-base font-semibold text-foreground">{$t('artifacts.emptyTitle')}</h2>
              <p class="mt-1 max-w-sm text-sm text-muted-foreground">{$t('artifacts.emptyHint')}</p>
              <Button class="mt-5" onclick={newChat}><Plus /> {$t('artifacts.newChat')}</Button>
            </div>
          {:else}
            <FilterBar class="mt-5" bind:query placeholder={$t('artifacts.search')} clearLabel={$t('artifacts.clearSearch')} label={$t('artifacts.filter')}>
              {#snippet chips()}
                <FilterChip on={group === 'all'} count={entries.length} onclick={() => (group = 'all')}>{$t('artifacts.all')}</FilterChip>
                {#each groups as item (item.id)}
                  <FilterChip on={group === item.id} count={item.count} onclick={() => (group = item.id)}>{$t(`artifacts.group.${item.id}`)}</FilterChip>
                {/each}
              {/snippet}
            </FilterBar>

            {#if visible.length}
              <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {#each visible as entry (entry.key)}
                  <ArtifactCard {entry} onopen={() => appStore.openArtifactScreen(entry.chatId, entry.messageId, entry.index, null)} ondelete={() => confirmDelete(entry)} />
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

