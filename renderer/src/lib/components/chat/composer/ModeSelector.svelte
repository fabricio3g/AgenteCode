<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import { t } from 'svelte-i18n';

  const composerMode = $derived(appStore.composerMode);
  const modeOptionsIds: Array<'chat' | 'agent'> = ['chat', 'agent'];

  function getModeLabel(id: 'chat' | 'agent'): string {
    const labels = {
      chat: $t('composer.modeChat') || 'Chat',
      agent: $t('composer.modeAgent') || 'Agent'
    };
    return labels[id] || id;
  }

  function selectMode(mode: 'chat' | 'agent') {
    appStore.setComposerMode(mode);
  }
</script>

<div class="mode-selector-tabs inline-flex items-center" role="tablist" aria-label="Composer mode">
  {#each modeOptionsIds as modeId (modeId)}
    <button
      class="mode-selector-tab inline-flex items-center justify-center px-3 py-1.5 text-xs font-semibold transition {composerMode === modeId ? 'is-active' : ''}"
      onclick={() => selectMode(modeId)}
      role="tab"
      aria-selected={composerMode === modeId}
    >
      {getModeLabel(modeId)}
    </button>
  {/each}
</div>

<style>
  .mode-selector-tabs {
    border-radius: 0.5rem;
    padding: 2px;
    gap: 2px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid color-mix(in srgb, #dbe0ff 22%, var(--border) 78%);
  }

  .mode-selector-tab {
    border-radius: 0.375rem;
    border: 1px solid transparent;
    color: var(--text-secondary);
    background: transparent;
  }

  .mode-selector-tab:hover:not(.is-active) {
    background: var(--surface-hover);
    color: var(--text-primary);
  }

  .mode-selector-tab.is-active {
    color: #fff;
    background: linear-gradient(180deg, #818af0 0%, #717CE2 52%, #626edc 100%);
    border: 1px solid color-mix(in srgb, #dbe0ff 58%, #5f69c9 42%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.45),
      inset 0 -1px 0 rgba(0, 0, 0, 0.2),
      0 0 0 1px rgba(226, 231, 255, 0.18);
  }
</style>
