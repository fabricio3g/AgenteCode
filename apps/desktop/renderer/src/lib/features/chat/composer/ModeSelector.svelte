<svelte:options runes={true} />

<!--
  Mode tabs. Home offers Agent | Instant above the input shell; the Code
  toolbar passes a single mode, which hides the control (a one-tab tablist
  is furniture, not a choice). The Code space always runs the full loop.
  A rounded pill track with a raised active segment — the quiet composer-chip
  look, not a boxed control.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';

  interface Props {
    modes?: Array<'instant' | 'agent'>;
  }

  let { modes = ['agent', 'instant'] }: Props = $props();

  const options = $derived(modes.map((mode) => ({
    value: mode,
    label: $t(`chat.mode.${mode}`),
    title: $t(`chat.mode.${mode}Hint`)
  })));
</script>

{#if modes.length > 1}
  <SegmentedControl
    value={appStore.composerMode}
    {options}
    label={copy.composer.selectMode}
    variant="tabs"
    class="mode-tabs"
    onchange={(value) => appStore.setComposerMode(value as 'agent' | 'instant')}
  />
{/if}
