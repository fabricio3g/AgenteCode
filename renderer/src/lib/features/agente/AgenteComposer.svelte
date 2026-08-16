<svelte:options runes={true} />

<!--
  The Agente composer: the same shell as Home's composer (aui-composer pill,
  two-row body, dock fade) so the Code tab reads as one product. The toolbar
  swaps Home's chat-mode chips for the supervised / full-auto gate and reuses
  the app-wide ModelSwitcher — model selection is global app config, and the
  engine session is re-pointed when it changes.
-->

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ArrowUp, Check, ChevronDown, ClipboardList, ShieldCheck, Square, Zap } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { ChatSession } from '$lib/types/chat';
  import { appStore } from '$lib/stores/app.svelte';
  import ModelSwitcher from '$lib/features/chat/ModelSwitcher.svelte';
  import ContextUsageRing from '$lib/features/chat/composer/ContextUsageRing.svelte';
  import { agenteStore } from './agente.svelte';
  import { setAgenteModel } from './agente-ipc';

  let { chat }: { chat: ChatSession } = $props();

  /** Textarea grows with content up to this height, then scrolls (Home parity). */
  const MAX_TEXTAREA_PX = 220;

  let textarea = $state<HTMLTextAreaElement | undefined>(undefined);
  let text = $state('');
  let modeMenuOpen = $state(false);

  const run = $derived(agenteStore.runFor(chat.id));
  const running = $derived(!!run?.running);
  const runtimeMode = $derived(chat.codeAgent?.runtimeMode ?? 'supervised');
  const canSend = $derived(!!text.trim() || running);
  // Real accounting from the engine: promptTokens of the last call is the
  // context footprint. Hidden until the first report, like Home's ring.
  const usage = $derived(run?.usage);
  const showContextRing = $derived(!!usage && usage.promptTokens > 0);

  const modes = $derived([
    { id: 'plan' as const, icon: ClipboardList, label: $t('agente.modePlan'), hint: $t('agente.modePlanHint') },
    { id: 'supervised' as const, icon: ShieldCheck, label: $t('agente.modeSupervised'), hint: $t('agente.modeSupervisedHint') },
    { id: 'full' as const, icon: Zap, label: $t('agente.modeFull'), hint: $t('agente.modeFullHint') }
  ]);
  const activeMode = $derived(modes.find((m) => m.id === runtimeMode) ?? modes[1]!);

  function selectMode(mode: 'plan' | 'supervised' | 'full') {
    modeMenuOpen = false;
    if (mode !== runtimeMode) void agenteStore.setMode(chat.id, mode);
  }

  const placeholder = $derived(
    running ? $t('agente.steerPlaceholder') : $t('agente.composerPlaceholder')
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
    if (running) {
      await agenteStore.stop(chat.id);
      return;
    }
    const value = text.trim();
    if (!value) return;
    text = '';
    if (textarea) autoGrow(textarea);
    await agenteStore.send(chat.id, value);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
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
    if (agenteStore.hasSession(chat.id)) {
      void setAgenteModel(
        chat.id,
        backend === 'local' ? 'local' : provider,
        backend === 'local' ? String(appStore.config.llm?.local?.model || '') : model,
        undefined
      ).catch(() => {});
    }
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

  onDestroy(() => {
    // nothing long-lived to tear down here yet
  });
</script>

<div class="composer-dock relative z-20 w-full shrink-0 px-3 pb-2 pt-2 md:px-6 md:pb-3" role="region" aria-label={$t('agente.composerRegion')}>
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
          <!-- Runtime mode gate — plan / supervised / full-auto, opened as a
               list. Styled as the same pill as the model trigger. -->
          <div class="relative">
            <button
              type="button"
              class="mode-trigger flex h-8 items-center gap-1.5 px-2.5 transition"
              class:is-open={modeMenuOpen}
              onclick={() => (modeMenuOpen = !modeMenuOpen)}
              aria-label={$t('agente.modeSelector')}
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
              <div class="absolute bottom-10 left-0 z-50 w-64 rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                {#each modes as mode (mode.id)}
                  <button
                    type="button"
                    class="mode-option flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-muted"
                    class:is-selected={mode.id === runtimeMode}
                    onclick={() => selectMode(mode.id)}
                  >
                    <span class="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                      {#if mode.id === runtimeMode}
                        <Check class="size-3.5 text-foreground" />
                      {:else}
                        <mode.icon class="size-3.5 text-muted-foreground" />
                      {/if}
                    </span>
                    <span class="min-w-0 flex-1">
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
            <button
              type="button"
              class="send-btn flex size-8 items-center justify-center rounded-full transition"
              onclick={() => void submit()}
              disabled={!canSend}
              aria-label={running ? $t('agente.stop') : $t('agente.send')}
              title={running ? $t('agente.stop') : $t('agente.send')}
            >
              {#if running}
                <Square class="size-3.5 fill-current stroke-[2.75]" />
              {:else}
                <span class="send-icon inline-flex">
                  <ArrowUp class="size-4 stroke-[2.75]" />
                </span>
              {/if}
            </button>
          </div>
        </div>
      </div>
    </div>

    <p class="composer-hint mx-auto mt-1.5 px-1 text-center text-[11px] text-muted-foreground">
      {#if running}
        {$t('agente.running')}
      {:else}
        {$t('agente.composerHint')}
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
  }

  .mode-option.is-selected {
    background: color-mix(in srgb, var(--foreground) 6%, transparent);
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

  .send-btn:disabled {
    background: color-mix(in srgb, var(--foreground) 26%, transparent);
    color: var(--background);
    cursor: default;
  }

  .send-btn:active:not(:disabled) {
    transform: scale(0.96);
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
