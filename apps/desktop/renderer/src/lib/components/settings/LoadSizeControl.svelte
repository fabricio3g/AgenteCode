<svelte:options runes={true} />

<!--
  One sizing setting of the load dialog (context, GPU layers): the label and
  what it means on the left, the value on the right edge, a slider under it.
  "Auto" is a state of the value, not a sibling preset: on, llama.cpp sizes it
  against real memory (`--fit`) and the field says Auto; touching the slider
  or typing a number takes it off. Context slides on a log scale so 4k–32k get
  real travel on a 256k model.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import UiRange from '$lib/components/ui/Range.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { contextToPosition, parseTokens, positionToContext, shortTokens, SLIDER_STEPS } from './load-sizing';

  let {
    label,
    hint = '',
    value,
    auto,
    min,
    max,
    kind,
    leaveAuto,
    onchange
  }: {
    label: string;
    hint?: string;
    /** Where the slider sits; while on auto, where llama.cpp is likely to land. */
    value: number;
    auto: boolean;
    min: number;
    max: number;
    kind: 'context' | 'layers';
    /**
     * The value taken when Auto is switched off. Without it the slider's auto
     * position (the model's maximum, every layer) became the choice: 256k and
     * an out-of-memory on a laptop.
     */
    leaveAuto?: number;
    /** `null` = auto. */
    onchange: (value: number | null) => void;
  } = $props();

  const isContext = $derived(kind === 'context');
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const position = $derived(isContext ? contextToPosition(value, min, max) : clamp(value));
  const fromPosition = (p: number) => (isContext ? positionToContext(p, min, max) : clamp(p));
  const show = (n: number) => (isContext ? n.toLocaleString() : String(n));

  let draft = $state<string | null>(null);
  const fieldText = $derived(draft ?? (auto ? '' : show(value)));

  function commitDraft() {
    if (draft === null) return;
    const text = draft;
    draft = null;
    if (!text.trim() || /^auto$/i.test(text.trim())) { onchange(null); return; }
    const parsed = isContext ? parseTokens(text) : Number.parseInt(text, 10);
    if (parsed != null && Number.isFinite(parsed)) onchange(clamp(parsed));
  }

  const fieldId = `load-size-${Math.random().toString(36).slice(2, 8)}`;
</script>

<div class="size-row">
  <span class="size-text">
    <label class="size-label" for={fieldId}>{label}</label>
    {#if hint}<span class="size-hint">{hint}</span>{/if}
  </span>
  <span class="size-control">
    <UiRange
      min="0"
      max={isContext ? SLIDER_STEPS : max}
      step="1"
      value={position}
      aria-label={label}
      aria-valuetext={auto ? $t('localLoad.auto') : show(value)}
      title={`${isContext ? shortTokens(min) : min} – ${isContext ? shortTokens(max) : max}`}
      class={auto ? 'size-slider is-auto' : 'size-slider'}
      oninput={(event) => onchange(fromPosition(Number(event.currentTarget.value)))}
    />
    <Button variant="plain" type="button" class={auto ? 'load-auto-chip is-on' : 'load-auto-chip'} aria-pressed={auto}
      onclick={() => onchange(auto ? clamp(leaveAuto ?? value) : null)}>{$t('localLoad.auto')}</Button>
    <Input
      id={fieldId}
      class={auto ? 'load-size-field is-auto' : 'load-size-field'}
      inputmode="numeric"
      autocomplete="off"
      spellcheck="false"
      placeholder={$t('localLoad.auto')}
      value={fieldText}
      oninput={(event) => { draft = event.currentTarget.value; }}
      onblur={commitDraft}
      onkeydown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); commitDraft(); event.currentTarget.blur(); }
        if (event.key === 'Escape' && draft !== null) { event.stopPropagation(); draft = null; }
      }}
    />
  </span>
</div>

<style>
  /* The dialog's row grid (LocalModelLoadModal .load-row): text | control. */
  .size-row {
    display: grid;
    grid-template-columns: minmax(10rem, 15rem) minmax(0, 1fr);
    align-items: center;
    gap: 0.25rem 1.5rem;
    min-height: 3rem;
    padding: 0.5rem 0;
  }
  .size-text { display: flex; min-width: 0; flex-direction: column; gap: 0.125rem; }
  .size-label { color: var(--foreground); font-size: var(--text-sm); font-weight: 500; }
  .size-hint { color: var(--muted-foreground); font-size: var(--text-xs); line-height: 1.4; }
  .size-control { display: flex; min-width: 0; align-items: center; gap: 0.5rem; }
  :global(.size-slider) { flex: 1; min-width: 6rem; accent-color: var(--primary); }
  :global(.size-slider.is-auto) { opacity: 0.4; }
  :global(.load-auto-chip) {
    height: 1.75rem;
    flex-shrink: 0;
    padding: 0 0.625rem;
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease);
  }
  :global(.load-auto-chip:hover) { background: var(--muted); color: var(--foreground); }
  :global(.load-auto-chip.is-on) { background: var(--muted); color: var(--foreground); font-weight: 500; }
  :global(.load-auto-chip:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }
  :global(.load-size-field) {
    width: 6rem;
    height: 1.75rem;
    flex-shrink: 0;
    padding: 0 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--foreground);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    text-align: right;
    outline: none;
  }
  :global(.load-size-field:focus) { border-color: var(--border-hover); }
  :global(.load-size-field.is-auto::placeholder) { color: var(--muted-foreground); }
</style>
