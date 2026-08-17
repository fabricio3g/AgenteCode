<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';

  const MODES = [
    { id: 'chat', label: 'Chat' },
    { id: 'agent', label: 'Agent' }
  ] as const;
</script>

<div class="aui-segmented" role="tablist" aria-label={copy.composer.selectMode}>
  {#each MODES as mode (mode.id)}
    <button
      type="button"
      class="aui-segmented-item px-3 py-1.5"
      class:is-active={appStore.composerMode === mode.id}
      onclick={() => appStore.setComposerMode(mode.id)}
      role="tab"
      aria-selected={appStore.composerMode === mode.id}
    >
      {mode.label}
    </button>
  {/each}
</div>
