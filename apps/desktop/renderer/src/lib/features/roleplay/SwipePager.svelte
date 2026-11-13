<svelte:options runes={true} />

<!--
  ‹ 2 / 3 › under a reply: flip between its versions in place, like swiping a
  chat message. On the greeting it cycles the openings; on the last reply,
  › past the newest version writes a new one.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

  import { ChevronLeft, ChevronRight } from '$lib/icons';
  import { t } from 'svelte-i18n';

  interface Props {
    count: number;
    index: number;
    /** Group label: which thing is being flipped. */
    label: string;
    /** Cycle past the ends instead of stopping (greetings). */
    wrap?: boolean;
    /** › on the last version asks for a new one. */
    oncreate?: () => void;
    disabled?: boolean;
    onchange: (index: number) => void;
  }

  let { count, index, label, wrap = false, oncreate, disabled = false, onchange }: Props = $props();

  const atStart = $derived(index <= 0);
  const atEnd = $derived(index >= count - 1);

  function previous() {
    if (!atStart) onchange(index - 1);
    else if (wrap) onchange(count - 1);
  }

  function next() {
    if (!atEnd) onchange(index + 1);
    else if (oncreate) oncreate();
    else if (wrap) onchange(0);
  }
</script>

<div class="swipe-pager" role="group" aria-label={label}>
  <IconButton label={$t('roleplay.swipe.previous')} size="xs" variant="ghost" type="button" class={uiClass("pager-btn", "ui-local-33a6f1d7")}  title={$t('roleplay.swipe.previous')} disabled={disabled || (atStart && !wrap)} onclick={previous}>
    <ChevronLeft class="size-3.5" />
  </IconButton>
  <span class="pager-count" aria-live="polite">{index + 1} / {count}</span>
  <IconButton label={atEnd && oncreate ? $t('roleplay.swipe.new') : $t('roleplay.swipe.next')} size="xs" variant="ghost"
    type="button"
    class={uiClass("pager-btn", "ui-local-33a6f1d7")}

    title={atEnd && oncreate ? $t('roleplay.swipe.new') : $t('roleplay.swipe.next')}
    disabled={disabled || (atEnd && !oncreate && !wrap)}
    onclick={next}
  >
    <ChevronRight class="size-3.5" />
  </IconButton>
</div>

<style>
  .swipe-pager {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    margin-top: 0.375rem;
    color: var(--muted-foreground);
  }

  :global(.pager-btn.ui-local-33a6f1d7) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    border-radius: var(--radius-full);
    color: inherit;
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }

  :global(.pager-btn:hover:not(:disabled).ui-local-33a6f1d7) {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  :global(.pager-btn:disabled.ui-local-33a6f1d7) {
    opacity: 0.35;
  }

  .pager-count {
    min-width: 2.25rem;
    text-align: center;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
</style>
