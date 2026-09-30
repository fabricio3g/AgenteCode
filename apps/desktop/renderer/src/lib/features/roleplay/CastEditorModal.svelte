<svelte:options runes={true} />

<!--
  Cast editor: add, remove and reorder the characters in a live scene.

  Removing the primary promotes the new first member; a single remaining
  character collapses the scene back to a one-on-one.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { X } from 'lucide-svelte';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { dirtyGuard } from '$lib/components/ui/dirty-guard';
  import { Button } from '$lib/components/ui';
  import CastPicker from './CastPicker.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    characterIds: string[];
    onchange: (ids: string[]) => void;
    onclose: () => void;
  }

  let { characterIds, onchange, onclose }: Props = $props();

  let castIds = $state<string[]>(untrack(() => [...characterIds]));
  // Backdrop, Escape, X and Cancel all ask before throwing edits away.
  const guard = dirtyGuard(() => castIds);

  function save() {
    if (!castIds.length) return;
    onchange(castIds);
    onclose();
  }
</script>

<div
  class="ui-modal-backdrop"
  role="presentation"
  use:modalLayer={{ onclose: () => guard.close(onclose) }}
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) guard.close(onclose);
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="ui-modal-surface max-w-2xl"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="ui-modal-header">
      <div class="min-w-0">
        <div class="ui-modal-title">Scene cast</div>
        <div class="text-xs text-muted-foreground">
          {castIds.length > 1 ? `Group scene · ${castIds.length} characters` : 'One-on-one scene'}
          · the first member speaks first
        </div>
      </div>
      <button type="button" class="ui-icon-button" onclick={() => guard.close(onclose)} aria-label={copy.actions.close}>
        <X class="size-4" />
      </button>
    </div>

    <div class="ui-modal-body max-h-[62vh] space-y-3 overflow-y-auto">
      <CastPicker value={castIds} onchange={(ids) => (castIds = ids)} />
      {#if !castIds.length}
        <p class="text-center text-xs text-muted-foreground">Pick at least one character to keep the scene alive.</p>
      {/if}
    </div>

    <div class="ui-modal-footer">
      <button type="button" class="ui-btn ui-btn-ghost" onclick={() => guard.close(onclose)}>{copy.actions.cancel}</button>
      <Button onclick={save} disabled={!castIds.length}>Save cast</Button>
    </div>
  </div>
</div>
