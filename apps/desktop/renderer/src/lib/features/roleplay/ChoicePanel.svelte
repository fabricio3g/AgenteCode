<svelte:options runes={true} />

<!--
  Choice panel: the scene's offered actions, presented like a game's.

  Numbered rows in one bordered block under the newest reply. Press 1–4 to pick,
  Esc to dismiss, or just type in the composer — free text is always available,
  so an option is a shortcut and never a gate.

  A scene can put a clock on the moment. When it runs out the turn is *silence*,
  never an auto-pick: in a tense scene saying nothing is a real choice. The
  countdown stops while the window is hidden or the pointer is over the panel,
  so walking away never burns the story.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';

  interface Props {
    choices: string[];
    disabled?: boolean;
    /** Seconds before the moment passes. Null or 0 means no clock. */
    timerSeconds?: number | null;
    onpick: (choice: string) => void;
    /** The clock ran out: the moment passed with nothing said. */
    onexpire?: () => void;
    ondismiss?: () => void;
  }

  let { choices, disabled = false, timerSeconds = null, onpick, onexpire, ondismiss }: Props = $props();

  let picked = $state<number | null>(null);
  let now = $state(Date.now());
  let totalMs = $state(0);
  let deadline = $state(0);
  let expired = $state(false);
  let pausedAt = $state(0);
  let hovering = $state(false);

  const clocked = $derived(totalMs > 0);
  const remainingMs = $derived(deadline ? Math.max(0, deadline - now) : 0);
  const remainingSeconds = $derived(Math.ceil(remainingMs / 1000));
  const fraction = $derived(clocked ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0);
  const held = $derived(hovering || pausedAt > 0 || typeof document !== 'undefined' && document.visibilityState === 'hidden');

  $effect(() => { holdClock(hovering || !!appStore.composer.trim() || document.visibilityState === 'hidden'); });

  // New options restart the clock. Reading `choices` is what makes this re-run.
  $effect(() => {
    void choices.length;
    void timerSeconds;
    totalMs = timerSeconds && timerSeconds > 0 ? Math.floor(timerSeconds) * 1000 : 0;
    deadline = totalMs ? Date.now() + totalMs : 0;
    pausedAt = 0;
    expired = false;
    picked = null;
  });

  $effect(() => {
    if (!deadline) return;
    const timer = setInterval(() => (now = Date.now()), 100);
    return () => clearInterval(timer);
  });

  $effect(() => {
    if (!deadline || held || expired || picked != null || now < deadline) return;
    expired = true;
    onexpire?.();
  });

  $effect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => holdClock(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  function holdClock(hold: boolean) {
    if (!clocked) return;
    if (hold && !pausedAt) {
      pausedAt = Date.now();
    } else if (!hold && pausedAt) {
      deadline += Date.now() - pausedAt;
      pausedAt = 0;
    }
  }

  function pick(index: number) {
    if (disabled || picked != null || !choices[index]) return;
    picked = index;
    const choice = choices[index]!;
    onpick(choice);
  }

  function onkeydown(event: KeyboardEvent) {
    if (disabled || picked != null) return;
    // Typing in the composer must never fire an option.
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      ondismiss?.();
      return;
    }
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) {
      event.preventDefault();
      pick(index);
    }
  }
</script>

<svelte:window {onkeydown} />

<div
  class="panel"
  role="group"
  aria-label={$t('roleplay.settings.field.adventureChoices')}
  onmouseenter={() => { hovering = true; holdClock(true); }}
  onmouseleave={() => { hovering = false; holdClock(false); }}
>
  {#if clocked}
    <div class="clock" aria-hidden="true">
      <span class="clock-fill" style="width: {(fraction * 100).toFixed(1)}%"></span>
    </div>
    <div class="clock-label" aria-live="polite">{remainingSeconds}s</div>
  {/if}

  <div class="rows">
    {#each choices as choice, index (index)}
      <UiButton variant="plain"
        type="button"
        class={uiClass(`row ${picked === index ? 'is-picked' : ''} ${picked != null && picked !== index ? 'is-dropped' : ''}`, "ui-local-7c16d68f")}
        {disabled}
        onclick={() => pick(index)}
      >
        <span class="row-index">{index + 1}</span>
        <span class="min-w-0 flex-1">{choice}</span>
      </UiButton>
    {/each}
  </div>

  <div class="foot">
    <span class="hint">{$t('roleplay.choices.hint', { values: { keys: choices.length > 1 ? `1–${choices.length}` : '1' } })}</span>
    {#if ondismiss}
      <IconButton label={$t('roleplay.choices.dismiss')} size="xs" variant="ghost" type="button" class={uiClass("dismiss", "ui-local-7c16d68f")}  onclick={ondismiss}>
        <X class="size-3" />
      </IconButton>
    {/if}
  </div>
</div>

<style>
  .panel {
    position: relative;
    max-width: 34rem;
    margin-top: 0.5rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
  }

  .clock {
    height: 2px;
    background: var(--muted);
  }

  .clock-fill {
    display: block;
    height: 100%;
    background: var(--warning);
    transition: width 100ms linear;
  }

  .clock-label {
    position: absolute;
    top: 0.375rem;
    right: 0.5rem;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .rows {
    display: flex;
    flex-direction: column;
  }

  :global(.row.ui-local-7c16d68f) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4375rem 0.625rem;
    border: 0;
    border-top: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--foreground);
    font-size: 0.8125rem;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      opacity var(--motion-smooth) var(--motion-ease-out),
      transform var(--motion-smooth) var(--motion-ease-out);
  }

  :global(.row:first-child.ui-local-7c16d68f) {
    border-top: 0;
  }

  :global(.row:hover:not(:disabled).ui-local-7c16d68f) {
    background: var(--surface-hover);
  }

  :global(.row:disabled.ui-local-7c16d68f) {
    cursor: default;
    opacity: 0.5;
  }

  /* The pick holds; the rest fall away before the turn sends. */
  :global(.row.is-picked.ui-local-7c16d68f) {
    background: var(--accent-soft);
  }

  :global(.row.is-dropped.ui-local-7c16d68f) {
    opacity: 0;
    transform: translateY(0.125rem);
  }

  .row-index {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  :global(.row.is-picked.ui-local-7c16d68f) .row-index {
    border-color: var(--primary);
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.25rem 0.625rem 0.375rem;
    border-top: 1px solid var(--border-subtle);
  }

  .hint {
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  :global(.dismiss.ui-local-7c16d68f) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    height: 1.125rem;
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
  }

  :global(.dismiss:hover.ui-local-7c16d68f) {
    background: var(--surface-hover);
    color: var(--foreground);
  }
</style>
