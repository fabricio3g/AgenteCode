<svelte:options runes={true} />

<!--
  Mode tabs. Home offers Agent | Instant above the input shell; the Code
  toolbar passes a single mode, which hides the control (a one-tab tablist
  is furniture, not a choice). The Code space always runs the full loop.
-->

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    modes?: Array<'instant' | 'agent'>;
  }

  const MODE_LABELS: Record<'instant' | 'agent', string> = {
    instant: 'Instant',
    agent: 'Agent'
  };

  let { modes = ['agent', 'instant'] }: Props = $props();
</script>

{#if modes.length > 1}
  <div class="aui-segmented" role="tablist" aria-label={copy.composer.selectMode}>
    {#each modes as mode (mode)}
      <button
        type="button"
        class="aui-segmented-item px-3 py-1.5"
        class:is-active={appStore.composerMode === mode}
        onclick={() => appStore.setComposerMode(mode)}
        role="tab"
        aria-selected={appStore.composerMode === mode}
      >
        {MODE_LABELS[mode]}
      </button>
    {/each}
  </div>
{/if}
