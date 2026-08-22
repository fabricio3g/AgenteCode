<svelte:options runes={true} />

<!--
  The Code composer: the same shell as Home's composer (aui-composer pill,
  two-row body, dock fade) so both spaces read as one product.

  Grammar follows Grok's bar split — scope on the left (runtime-mode gate),
  brain on the right (model), and a send control that only exists when there
  is something shippable. While a run is active the bar switches to steering:
  Enter course-corrects, Alt+Enter queues a follow-up, the button stops.
-->

<script lang="ts">
  import { ArrowDownToLine, ArrowUp, Check, ChevronDown, ClipboardList, Play, ShieldCheck, Square, Zap } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { ChatSession } from '$lib/types/chat';
  import { appStore } from '$lib/stores/app.svelte';
  import ModelSwitcher from '$lib/features/chat/ModelSwitcher.svelte';
  import ContextUsageRing from '$lib/features/chat/composer/ContextUsageRing.svelte';
  import { codeStore } from './code.svelte';
  import { setAgenteModel } from './code-ipc';
  import { flyAndScale } from '$lib/utils/transitions';

  let { chat }: { chat: ChatSession } = $props();

  /** Textarea grows with content up to this height, then scrolls (Home parity). */
  const MAX_TEXTAREA_PX = 220;

  let textarea = $state<HTMLTextAreaElement | undefined>(undefined);
  let text = $state('');
  let modeMenuOpen = $state(false);

  const run = $derived(codeStore.runFor(chat.id));
  const running = $derived(!!run?.running);
  const runtimeMode = $derived(chat.codeAgent?.runtimeMode ?? 'supervised');
  // Honest model visibility: without a usable model the bar says so instead
  // of letting a send die inside the provider.
  const modelReady = $derived(codeStore.modelReady);
  const canSend = $derived(!!text.trim() && (modelReady || running));
  // Real accounting from the engine: promptTokens of the last call is the
  // context footprint. Hidden until the first report, like Home's ring.
  const usage = $derived(run?.usage);
  const showContextRing = $derived(!!usage && usage.promptTokens > 0);
  /** Input handed off but not yet consumed by a turn. */
  const queuedCount = $derived(run?.queuedCount ?? 0);
  /**
   * The last run ended on its own terms — offer one-click continuation
   * (dsh's turn-tail action) instead of making the user retype.
   */
  const canContinue = $derived(
    !running && modelReady && chat.messages.at(-1)?.metadata?.codeStopReason === 'stop'
  );

  const modes = $derived([
    { id: 'plan' as const, icon: ClipboardList, label: $t('code.modePlan'), hint: $t('code.modePlanHint') },
    { id: 'supervised' as const, icon: ShieldCheck, label: $t('code.modeSupervised'), hint: $t('code.modeSupervisedHint') },
    { id: 'full' as const, icon: Zap, label: $t('code.modeFull'), hint: $t('code.modeFullHint') }
  ]);
  const activeMode = $derived(modes.find((m) => m.id === runtimeMode) ?? modes[1]!);

  function selectMode(mode: 'plan' | 'supervised' | 'full') {
    modeMenuOpen = false;
    if (mode !== runtimeMode) void codeStore.setMode(chat.id, mode);
  }

  function openModelHub() {
    appStore.modelManagerOpenSection = 'models';
    appStore.modelManagerOpen = true;
  }

  const placeholder = $derived(
    running
      ? $t('code.steerPlaceholder')
      : !modelReady
        ? 'Select a model to start coding'
        : $t('code.composerPlaceholder')
  );

  const hint = $derived(
    running
      ? 'Enter steers · Alt+Enter queues · click ■ to stop'
      : !modelReady
        ? ''
        : $t('code.composerHint')
  );

  /** Size the input to its content — same empty-height guard as Home's. */
  function autoGrow(element: HTMLTextAreaElement) {
    element.style.height = 'auto';
    const measured = element.scrollHeight;
    const next = element.value ? Math.min(measured, MAX_TEXTAREA_PX) : 0;
    element.style.height = next ? `${next}px` : '';
  }

  function focusComposer() {
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  async function submit() {
    const value = text.trim();
    if (!value) return;
    if (running) {
      text = '';
      if (textarea) autoGrow(textarea);
      await codeStore.steer(chat.id, value);
      return;
    }
    if (!modelReady) return;
    text = '';
    if (textarea) autoGrow(textarea);
    await codeStore.send(chat.id, value);
  }

  async function queueFollowUp() {
    const value = text.trim();
    if (!value) return;
    if (!running && !modelReady) return;
    text = '';
    if (textarea) autoGrow(textarea);
    await codeStore.followUp(chat.id, value);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.altKey) {
      void queueFollowUp();
      return;
    }
    void submit();
  }

  function onInput(event: Event) {
    const element = event.currentTarget as HTMLTextAreaElement;
    text = element.value;
    autoGrow(element);
  }

  // Re-point the engine session when the app-wide model selection changes
  // (ModelSwitcher writes app config; the agente runtime keeps its own copy).
  let lastAppliedModel = $state('');
  $effect(() => {
    const provider = appStore.activeProviderName;
    const model = appStore.activeModelLabel;
    const backend = appStore.backendMode;
    const key = `${backend}:${provider}:${model}`;
    if (!lastAppliedModel) {
      lastAppliedModel = key;
      return;
    }
    if (key === lastAppliedModel) return;
    lastAppliedModel = key;
    if (!codeStore.hasSession(chat.id)) return;
    void setAgenteModel(
      chat.id,
      backend === 'local' ? 'local' : provider,
      backend === 'local' ? String(appStore.config.llm?.local?.model || '') : model,
      undefined
    ).catch(() => {});
  });

  $effect(() => {
    const onFocusComposer = () => focusComposer();
    window.addEventListener('focus-composer', onFocusComposer);
    return () => window.removeEventListener('focus-composer', onFocusComposer);
  });

  $effect(() => {
    if (!textarea) return;
    void text;
    autoGrow(textarea);
  });
</script>

<div class="composer-dock relative z-20 w-full shrink-0 px-3 pb-2 pt-2 md:px-6 md:pb-3" role="region" aria-label={$t('code.composerRegion')}>
  <div class="composer-frame mx-auto w-full" style="max-width: var(--thread-width);">
    <div class="composer-shell aui-composer pointer-events-auto transition">
      <div class="composer-body">
        <textarea
          bind:this={textarea}
          class="composer-textarea w-full resize-none bg-transparent text-foreground outline-none"
          {placeholder}
          rows="1"
          value={text}
          oninput={onInput}
          onkeydown={onKeydown}
        ></textarea>

        <div class="composer-actions">
          <!-- Runtime mode gate — plan / supervised / full-auto. Scope lives on
               the left of the bar; the model picker answers on the right. -->
          <div class="relative">
            <button
              type="button"
              class="mode-trigger flex h-8 items-center gap-1.5 px-2.5 transition"
              class:is-open={modeMenuOpen}
              onclick={() => (modeMenuOpen = !modeMenuOpen)}
              aria-label={$t('code.modeSelector')}
              title={activeMode.hint}
              aria-expanded={modeMenuOpen}
            >
              <svelte:component this={activeMode.icon} class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
              <span class="trigger-label truncate">{activeMode.label}</span>
              <ChevronDown class={`h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150${modeMenuOpen ? ' rotate-180' : ''}`} />
            </button>

            {#if modeMenuOpen}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="fixed inset-0 z-40" onclick={() => (modeMenuOpen = false)}></div>
              <div
                class="absolute bottom-10 left-0 z-50 flex w-64 flex-col gap-1 rounded-xl border border-border bg-popover p-1.5 shadow-lg"
                transition:flyAndScale={{ y: 8, start: 0.96, duration: 180 }}
              >
                {#each modes as mode (mode.id)}
                  <button
                    type="button"
                    class="mode-option flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition"
                    class:is-selected={mode.id === runtimeMode}
                    onclick={() => selectMode(mode.id)}
                  >
                    <span class="mode-icon mt-0.5 flex size-4 shrink-0 items-center justify-center">
                      {#if mode.id === runtimeMode}
                        <Check class="size-3.5 text-foreground" />
                      {:else}
                        <mode.icon class="size-3.5" />
                      {/if}
                    </span>
                    <span class="option-body min-w-0 flex-1">
                      <span class="block text-[13px] font-medium text-foreground">{mode.label}</span>
                      <span class="block text-[11px] leading-snug text-muted-foreground">{mode.hint}</span>
                    </span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          <ModelSwitcher />

          <div class="trailing">
            {#if showContextRing && usage}
              <ContextUsageRing
                usedTokens={usage.promptTokens}
                maxTokens={usage.contextWindow}
                reservedTokens={usage.completionTokens}
              />
            {/if}

            {#if running && queuedCount > 0}
              <!-- QueueDock-lite: proof the queued message landed. -->
              <span
                class="queued-pill flex h-8 items-center rounded-full border border-border px-2.5 text-[11px] font-medium text-muted-foreground"
                role="status"
              >
                {$t('code.queued', { values: { n: queuedCount } })}
              </span>
            {/if}

            {#if running}
              <!-- Stop is unambiguous and always reachable mid-run. -->
              <button
                type="button"
                class="send-btn is-stop flex size-8 items-center justify-center rounded-full transition"
                onclick={() => void codeStore.stop(chat.id)}
                aria-label={$t('code.stop')}
                title={$t('code.stop')}
              >
                <Square class="size-3 fill-current stroke-[2.75]" />
              </button>
            {:else if canSend}
              <!-- Filled send appears only when there is something to ship. -->
              <button
                type="button"
                class="send-btn flex size-8 items-center justify-center rounded-full transition"
                onclick={() => void submit()}
                aria-label={$t('code.send')}
                title={$t('code.send')}
              >
                <span class="send-icon inline-flex">
                  <ArrowUp class="size-4 stroke-[2.75]" />
                </span>
              </button>
            {:else if !modelReady}
              <!-- The one honest interruption: point at the fix. -->
              <button
                type="button"
                class="model-cta flex h-8 items-center gap-1.5 rounded-full border border-dashed border-border px-3 text-xs font-medium text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
                onclick={openModelHub}
                title="Open the Model Hub"
              >
                <ArrowDownToLine class="size-3.5" />
                Choose model
              </button>
            {:else if canContinue && !text.trim()}
              <!-- The run finished on its own: one click picks the work back up. -->
              <button
                type="button"
                class="continue-btn flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium text-foreground transition hover:border-foreground/40 hover:bg-muted"
                onclick={() => void codeStore.followUp(chat.id, $t('code.continuePrompt'))}
                title={$t('code.continue')}
              >
                <Play class="size-3.5" />
                {$t('code.continue')}
              </button>
            {/if}
          </div>
        </div>
      </div>
    </div>

    <p class="composer-hint mx-auto mt-1.5 px-1 text-center text-[11px] text-muted-foreground">
      {#if hint}
        {hint}
      {/if}
    </p>
  </div>
</div>

<style>
  .composer-dock {
    background: var(--chat-bg);
  }

  /* Fade the transcript out into the dock rather than cutting it off. */
  .composer-dock::before {
    content: '';
    position: absolute;
    inset-inline: 0;
    top: -3rem;
    height: 3rem;
    pointer-events: none;
    background: linear-gradient(
      to bottom,
      transparent,
      color-mix(in srgb, var(--chat-bg) 72%, transparent) 58%,
      var(--chat-bg)
    );
  }

  .composer-frame {
    position: relative;
  }

  .composer-shell {
    position: relative;
  }

  .composer-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.875rem 0.875rem 0.625rem;
  }

  .composer-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 2rem;
  }

  .composer-textarea {
    display: block;
    margin: 0;
    min-height: 1.5rem;
    max-height: 11rem;
    padding: 0;
    font-size: 1rem;
    line-height: 1.55;
    letter-spacing: -0.005em;
  }

  .composer-textarea::placeholder {
    color: var(--text-secondary);
    opacity: 1;
  }

  /* Same white-pill treatment as the ModelSwitcher trigger beside it. */
  .mode-trigger {
    color: var(--text-secondary);
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    box-shadow: none;
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .mode-trigger:hover,
  .mode-trigger.is-open {
    border-color: color-mix(in srgb, var(--foreground) 22%, transparent);
    background: var(--muted);
    color: var(--foreground);
  }

  .mode-trigger:active {
    transform: scale(0.98);
  }

  .mode-trigger :global(svg) {
    transition: transform var(--motion-fast) var(--motion-ease);
  }

  .mode-trigger:hover :global(svg) {
    transform: scale(1.08);
  }

  .mode-trigger .trigger-label {
    color: inherit;
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  .mode-option {
    border: none;
    background: transparent;
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--motion-ease);
  }

  .mode-option:hover {
    background: var(--muted);
  }

  .mode-option.is-selected {
    background: color-mix(in srgb, var(--foreground) 6%, transparent);
  }

  /* Icons and text lean in on hover: the icon warms to full contrast and the
     label nudges a pixel, so the row answers before the fill lands. */
  .mode-icon {
    color: var(--muted-foreground);
    transition: color var(--motion-fast) var(--motion-ease);
  }

  .mode-option:hover .mode-icon,
  .mode-option.is-selected .mode-icon {
    color: var(--foreground);
  }

  .option-body {
    transition: transform var(--motion-fast) var(--motion-ease);
  }

  .mode-option:hover .option-body {
    transform: translateX(1px);
  }

  .trailing {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: flex-end;
    gap: 0.375rem;
    min-width: 0;
  }

  .send-btn {
    border: none;
    background: var(--primary);
    color: var(--primary-foreground);
    box-shadow: none;
    transition:
      background-color 150ms ease,
      opacity 150ms ease,
      transform 150ms var(--motion-ease);
  }

  .send-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .send-btn.is-stop {
    /* Stop reads as an interrupt, not a submit: quiet surface, loud glyph. */
    background: color-mix(in srgb, var(--error) 14%, var(--background));
    color: var(--error);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--error) 35%, transparent);
  }

  .send-btn:active:not(:disabled) {
    transform: scale(0.96);
  }

  .continue-btn {
    background: transparent;
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      border-color var(--motion-fast) var(--motion-ease);
  }

  .continue-btn:active {
    transform: scale(0.98);
  }

  .queued-pill {
    background: var(--card);
    letter-spacing: -0.01em;
  }

  .send-icon {
    transform-origin: center;
    transition: transform 200ms var(--motion-ease);
  }

  .send-btn:hover:not(:disabled) .send-icon {
    transform: translateY(-1px);
  }

  @media (max-width: 640px) {
    .composer-textarea {
      max-height: 10rem;
      font-size: 0.9375rem;
    }
  }
</style>
