<svelte:options runes={true} />

<!--
  Mode tabs. Home offers Agent | Instant above the input shell; the Code
  toolbar passes a single mode, which hides the control (a one-tab tablist
  is furniture, not a choice). The Code space always runs the full loop.
  The selected tab is the raised pill of the shared segmented style.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    modes?: Array<'instant' | 'agent'>;
  }

  let { modes = ['agent', 'instant'] }: Props = $props();

  function handleKeydown(event: KeyboardEvent, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % modes.length;
    else if (event.key === 'ArrowLeft') next = (index + modes.length - 1) % modes.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = modes.length - 1;
    else return;
    event.preventDefault();
    appStore.setComposerMode(modes[next]);
    const tabs = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[next]?.focus();
  }
</script>

{#if modes.length > 1}
  <div class="mode-tabs ui-segmented" role="tablist" aria-label={copy.composer.selectMode}>
    {#each modes as mode, index (mode)}
      <button
        type="button"
        class="mode-tab ui-segmented-item"
        class:is-active={appStore.composerMode === mode}
        onclick={() => appStore.setComposerMode(mode)}
        onkeydown={(event) => handleKeydown(event, index)}
        role="tab"
        aria-selected={appStore.composerMode === mode}
        tabindex={appStore.composerMode === mode ? 0 : -1}
        title={$t(`chat.mode.${mode}Hint`)}
      >
        {$t(`chat.mode.${mode}`)}
      </button>
    {/each}
  </div>
{/if}

<style>
  .mode-tabs { height: 26px; padding: 2px; }
  .mode-tab { height: 22px; padding: 0 0.625rem; font-size: 12.5px; }
  .mode-tab:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
</style>
