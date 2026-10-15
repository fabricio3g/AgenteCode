<svelte:options runes={true} />

<!--
  The on-device server, as one thing shared by every chat: which model it
  holds, how many conversations it answers at once (llama.cpp `--parallel`),
  what that leaves each one, and what the slots are doing now.

  Changing the slots takes a reload. "Apply and restart" waits for the replies
  in flight to finish first, so nobody's answer is cut off.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Cpu, LoaderCircle } from 'lucide-svelte';
  import { Button, SegmentedControl } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { formatTokens } from '$lib/services/model-card';
  import { shortModelName } from '$lib/features/chat/model-menu/model-menu';
  import SettingsSection from './SettingsSection.svelte';
  import SettingsRow from './SettingsRow.svelte';

  const CHOICES = [1, 2, 4, 6, 8];

  const configured = $derived(Math.max(1, Number(appStore.config.llm?.local?.parallel) || 1));
  const loaded = $derived(appStore.localModelActive);
  const running = $derived(Number(modelsStore.status?.total_slots) || 0);
  const serverContext = $derived(Number(modelsStore.status?.n_ctx) || 0);
  const perChat = $derived(serverContext > 0 ? Math.floor(serverContext / configured) : 0);
  const memoryMb = $derived(Number(modelsStore.status?.memory_mb) || 0);
  /** The server runs a different slot count than the setting: a reload applies it. */
  const stale = $derived(!!loaded && running > 0 && running !== configured);

  const busyChats = $derived(appStore.chats.filter((chat) => appStore.isChatGenerating(chat.id) && appStore.configForChat(chat).llm?.backend_mode === 'local'));
  const slotRows = $derived(Array.from({ length: Math.max(running, 0) }, (_, index) => busyChats[index] ?? null));

  let waiting = $state(false);

  async function restart() {
    const model = appStore.localModelActive;
    if (!model?.path) return;
    waiting = false;
    await appStore.loadLocalModelQuietly({ id: model.path, name: model.name || shortModelName(model.path), path: model.path });
  }

  function apply() {
    if (busyChats.length) waiting = true;
    else void restart();
  }

  // Replies in flight finish first; the reload follows the last one.
  $effect(() => {
    if (waiting && busyChats.length === 0) void restart();
  });

  $effect(() => {
    void modelsStore.refreshStatus();
  });
</script>

<SettingsSection title={$t('computer.server.title')} description={$t('computer.server.hint')}>
  <SettingsRow label={loaded ? shortModelName(loaded.name || loaded.path) : $t('computer.server.noModel')}
    description={loaded && memoryMb ? `${(memoryMb / 1024).toFixed(1)} GB` : ''} control="auto">
    {#snippet tile()}<Cpu class="size-4" />{/snippet}
    <Button variant="outline" size="sm" onclick={() => appStore.openSettings('explore')}>{$t('computer.switch')}</Button>
  </SettingsRow>

  <SettingsRow label={$t('computer.server.parallel')}
    description={perChat ? $t('computer.server.parallelHint', { values: { ctx: formatTokens(perChat) } }) : $t('computer.server.parallelShared')} control="auto">
    <SegmentedControl value={String(configured)} label={$t('computer.server.parallel')}
      options={CHOICES.map((value) => ({ value: String(value), label: String(value) }))}
      onchange={(value) => void appStore.setLocalParallel(Number(value))} />
  </SettingsRow>

  {#if stale}
    <SettingsRow label={$t('computer.server.apply')} description={$t('computer.server.applyHint')} control="auto">
      <Button size="sm" disabled={waiting || appStore.localModelLoading} onclick={apply}>
        {#if waiting || appStore.localModelLoading}<LoaderCircle class="animate-spin" />{/if}
        {$t('computer.server.apply')}
      </Button>
    </SettingsRow>
  {/if}

  {#if slotRows.length}
    <div class="slots" aria-label={$t('computer.server.slots')}>
      <p class="slots-title">{$t('computer.server.slots')}</p>
      <div class="slot-grid">
        {#each slotRows as chat, index (chat?.id ?? `free-${index}`)}
          <div class="slot" class:is-busy={!!chat}>
            <span class="slot-name">{chat ? chat.title || $t('computer.server.slotBusy') : $t('computer.server.slotFree')}</span>
            <span class="slot-state">{chat ? $t('computer.server.slotBusy') : '—'}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</SettingsSection>

<style>
  .slots { padding: 0.75rem 1rem 1rem; }
  .slots-title {
    margin: 0 0 0.5rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .slot-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
    gap: 0.375rem;
  }
  .slot {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.4375rem 0.625rem;
    border-radius: var(--radius-md);
    background: var(--muted);
    font-size: var(--text-xs);
  }
  .slot-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted-foreground);
  }
  .slot.is-busy .slot-name { color: var(--foreground); font-weight: 500; }
  .slot.is-busy .slot-name::before {
    content: '';
    display: inline-block;
    width: 0.375rem;
    height: 0.375rem;
    margin-right: 0.375rem;
    border-radius: var(--radius-full);
    background: var(--brand-accent);
    vertical-align: 0.0625rem;
  }
  .slot-state { color: var(--muted-foreground); }
</style>
