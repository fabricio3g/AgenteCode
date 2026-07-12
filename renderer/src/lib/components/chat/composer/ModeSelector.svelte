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

<div class="aui-segmented" role="tablist" aria-label="Composer mode">
  {#each modeOptionsIds as modeId (modeId)}
    <button
      type="button"
      class="aui-segmented-item px-3 py-1.5 {composerMode === modeId ? 'is-active' : ''}"
      onclick={() => selectMode(modeId)}
      role="tab"
      aria-selected={composerMode === modeId}
    >
      {getModeLabel(modeId)}
    </button>
  {/each}
</div>
