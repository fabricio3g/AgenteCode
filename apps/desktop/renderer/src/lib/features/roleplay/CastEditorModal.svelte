<svelte:options runes={true} />

<!--
  Cast editor: add, remove and reorder the characters in a live scene.

  Removing the primary promotes the new first member; a single remaining
  character collapses the scene back to a one-on-one.
-->

<script lang="ts">
  import DialogActions from '$lib/components/ui/DialogActions.svelte';

  import DialogFooter from '$lib/components/ui/DialogFooter.svelte';

  import UiIconButton from '$lib/components/ui/IconButton.svelte';

  import { t } from 'svelte-i18n';
  import { untrack } from 'svelte';
  import { X } from '$lib/icons';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { dirtyGuard } from '$lib/components/ui/dirty-guard';
  import { Button, Tooltip } from '$lib/components/ui';
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
        <div class="ui-modal-title">{$t('roleplay.cast.title')}</div>
        <div class="text-xs text-muted-foreground">
          {castIds.length > 1 ? `Group scene · ${castIds.length} characters` : 'One-on-one scene'}
          · the first member speaks first
        </div>
      </div>
      <Tooltip label={copy.actions.close} position="bottom"><UiIconButton label={copy.actions.close} size="sm" type="button"  onclick={() => guard.close(onclose)} >
        <X class="size-4" />
      </UiIconButton></Tooltip>
    </div>

    <div class="ui-modal-body max-h-[62vh] space-y-3 overflow-y-auto">
      <CastPicker value={castIds} onchange={(ids) => (castIds = ids)} />
      {#if !castIds.length}
        <p class="text-xs text-muted-foreground">{$t('roleplay.cast.hint')}</p>
      {/if}
    </div>

    <DialogFooter >
      <DialogActions cancelLabel={copy.actions.cancel} confirmLabel={$t('roleplay.cast.save')} oncancel={() => guard.close(onclose)} onconfirm={save} disabled={!castIds.length} />
    </DialogFooter>
  </div>
</div>
