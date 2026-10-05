<svelte:options runes={true} />

<!--
  The composer shell: input, drop target, and the pieces that hang off it.

  Speech recognition, drag-and-drop, and OCR progress live in
  `composer/use-dictation.svelte.ts` and `composer/use-attachments.svelte.ts`;
  the mode selectors and send button live in `composer/ComposerToolbar.svelte`.
  What remains here is the textarea and how a message gets submitted.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onDestroy, tick } from 'svelte';
  import { Paperclip } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { threadJump } from './thread/thread-jump.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { isElectron } from '$lib/services/bridge';
  import { copy, say } from '$lib/copy';

  import AttachmentCards from './composer/AttachmentCards.svelte';
  import ModelSwitcher from './ModelSwitcher.svelte';
  import ReasoningLevelSelector from './composer/ReasoningLevelSelector.svelte';
  import ComposerModelNotice from './composer/ComposerModelNotice.svelte';
  import ComposerSuggestions from './composer/ComposerSuggestions.svelte';
  import ComposerAddMenu from './composer/ComposerAddMenu.svelte';
  import ComposerToolbar from './composer/ComposerToolbar.svelte';
  import ModeSelector from './composer/ModeSelector.svelte';
  import SelectedTextCard from './composer/SelectedTextCard.svelte';
  import VoiceCallPanel from './composer/VoiceCallPanel.svelte';
  import ComposerRecorder from './composer/ComposerRecorder.svelte';
  import DictationSetupPopover from './composer/DictationSetupPopover.svelte';
  import { ComposerAttachments } from './composer/use-attachments.svelte';
  import { Dictation } from './composer/use-dictation.svelte';
  import { MAX_COMPOSER_TEXTAREA_PX, autogrowTextarea } from '$lib/features/shared/composer-autogrow';
  import NameCompletion from '$lib/features/shared/NameCompletion.svelte';
  import PromptQueue from '$lib/features/shared/PromptQueue.svelte';
  import JumpToLatest from './thread/JumpToLatest.svelte';
  import { meterMode } from '$lib/features/code/tile-meter';
  import type { NameCandidate } from '$lib/features/shared/name-completion';

  let { placeholder: customPlaceholder, nameCompletion, above }: {
    placeholder?: string;
    nameCompletion?: { candidates: NameCandidate[]; automatic?: boolean; nickname?: boolean };
    /** A row above the input, inside the composer's width (roleplay steering). */
    above?: Snippet;
  } = $props();

  /** Textarea grows with content up to this height, then scrolls. */
  const MAX_TEXTAREA_PX = MAX_COMPOSER_TEXTAREA_PX;
  /** How long an error placeholder stays before reverting. */
  const ERROR_PLACEHOLDER_MS = 12_000;
  /** Debounce before recomputing the context-budget preview. */
  const BUDGET_DEBOUNCE_MS = 140;
  /** Pause before re-arming the mic in hands-free voice mode. */

  const dictation = new Dictation();
  const attachments = new ComposerAttachments();

  // Must be reactive: the auto-grow effect below bails out while this is still
  // undefined, so a plain `let` meant it ran once during mount and never again,
  // leaving the input stuck at whatever height was last written to it.
  let textarea = $state<HTMLTextAreaElement | undefined>(undefined);
  let fileInput: HTMLInputElement | undefined;
  let showErrorPlaceholder = $state(false);
  let errorPlaceholderTimer: ReturnType<typeof setTimeout> | null = null;
  let budgetTimer: ReturnType<typeof setTimeout> | null = null;
  let quotedText = $state('');
  let quotedSourceMessageId = $state('');
  let destroyed = false;

  const generating = $derived(appStore.currentChatGenerating);

  /* The jump button wears the run's weather while the thread is scrolled away.
     Same helper as the Code status row, so the two never disagree about whether
     the run is busy, waiting on you, or has gone quiet. */
  let jumpNow = $state(Date.now());
  const jumpMode = $derived(meterMode({
    attention: approvalsStore.forChat(appStore.currentChatId || '').length > 0,
    working: generating,
    lastEventAt: appStore.currentRun?.lastEventAt
  }, jumpNow));
  $effect(() => {
    if (!generating) return;
    jumpNow = Date.now();
    const timer = setInterval(() => (jumpNow = Date.now()), 500);
    return () => clearInterval(timer);
  });

  const localBusyElsewhere = $derived(appStore.currentChatBlockedByOtherLocalRun);
  /* Starter prompts only make sense before the conversation has started. */
  const threadIsEmpty = $derived(!(appStore.currentChat?.messages?.length));
  const voiceMode = $derived(appStore.voiceModeActive);

  /**
   * A single stable placeholder. This used to be a rotating list of twenty
   * suggestions typed out character by character with a shimmer gradient, which
   * competed for attention with the hint below the composer and never sat still
   * long enough to read.
   */
  const placeholder = $derived(
    showErrorPlaceholder
      ? copy.composer.errorPlaceholder
      : generating && appStore.composerMode === 'agent'
        ? say.inProgress('Agent working')
        : generating && appStore.composerMode === 'instant'
          ? say.inProgress('Answering')
          : customPlaceholder ?? copy.composer.placeholder
  );

  // Mirrors the guards inside sendCurrentMessage so the button reflects reality.
  const backendReady = $derived(
    appStore.backendMode === 'local'
      ? !!(appStore.selectedLocalModelPath && appStore.localModelActive)
      : !!(
          (appStore.activeProvider?.has_api_key || appStore.activeProvider?.api_key) &&
          appStore.activeProvider?.model
        )
  );
  const sendDisabled = $derived(!generating && (!backendReady || localBusyElsewhere));

  /**
   * Size the input to its content.
   *
   * Measured against the *empty* height rather than trusting `scrollHeight`
   * outright: when this runs before layout has settled — which it does on
   * mount — `scrollHeight` can come back far too large, and the old version
   * would clamp that to MAX_TEXTAREA_PX and leave an empty composer stuck at
   * full height until the next keystroke.
   */
  function autoGrow(element: HTMLTextAreaElement) {
    autogrowTextarea(element, MAX_TEXTAREA_PX);
  }

  function focusComposer(moveCursorToEnd = true) {
    if (!textarea) return;
    textarea.focus();
    if (moveCursorToEnd) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function clearQuote() {
    quotedText = '';
    quotedSourceMessageId = '';
  }

  async function submit() {
    attachments.clearOcr();

    if (localBusyElsewhere) {
      toastStore.info('Local model is busy in another chat.', 2400);
      return;
    }

    // A quoted selection is folded into the message as a blockquote, preceded by
    // a marker naming the message it came from. `UserMessage` parses that marker
    // to render the quote as a jump-back affordance — the marker was never
    // actually emitted before, so the jump target was always empty.
    if (quotedText.trim() && appStore.composer.trim()) {
      const quote = quotedText
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      const marker = quotedSourceMessageId
        ? `<!-- chatealm-selected-source:${quotedSourceMessageId} -->\n`
        : '';
      appStore.updateComposer(`${marker}${quote}\n\n${appStore.composer.trim()}`);
      clearQuote();
    }

    await appStore.sendCurrentMessage();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.defaultPrevented) return;
    if (event.key === 'ArrowUp' && !appStore.composer && !appStore.pendingAttachments.length) {
      const item = [...(appStore.currentChat?.pendingPrompts ?? [])].reverse().find(item => !item.sending);
      if (item && appStore.currentChatId) {
        event.preventDefault(); appStore.removeQueuedPrompt(appStore.currentChatId, item.id);
        appStore.updateComposer(item.content); appStore.pendingAttachments = item.attachments ?? [];
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void submit();
  }

  function onInput(event: Event) {
    const element = event.currentTarget as HTMLTextAreaElement;
    appStore.updateComposer(element.value);
    autoGrow(element);
  }

  function clearErrorPlaceholder() {
    showErrorPlaceholder = false;
    if (errorPlaceholderTimer) {
      clearTimeout(errorPlaceholderTimer);
      errorPlaceholderTimer = null;
    }
  }

  // ── Hands-free voice mode ─────────────────────────────────────────────────

  async function enterVoiceMode() {
    if (appStore.voiceModeActive) { exitVoiceMode(); return; }
    if (!appStore.currentChatId) appStore.createChat('home');
    const ready = await dictation.prepareCall();
    if (destroyed) return;
    if (ready) appStore.voiceModeActive = true;
    else if (dictation.phase === 'choose') dictation.afterSetup = () => { if (!destroyed) appStore.voiceModeActive = true; };
  }

  function exitVoiceMode() {
    appStore.voiceModeActive = false;
    dictation.afterSetup = undefined;
    ttsStore.stop();
    dictation.cancel();
  }

  // ── Window events ─────────────────────────────────────────────────────────

  function handleAskSelectedText(event: Event) {
    const detail = (event as CustomEvent<{ text?: string; sourceMessageId?: string }>).detail;
    const text = (detail?.text || '').trim();
    if (!text) return;
    quotedText = text;
    quotedSourceMessageId = detail?.sourceMessageId || '';
    requestAnimationFrame(() => focusComposer());
  }

  $effect(() => attachments.listen());

  $effect(() => {
    const onFocusComposer = () => focusComposer();
    window.addEventListener('ask-selected-text', handleAskSelectedText as EventListener);
    window.addEventListener('focus-composer', onFocusComposer);
    return () => {
      window.removeEventListener('ask-selected-text', handleAskSelectedText as EventListener);
      window.removeEventListener('focus-composer', onFocusComposer);
    };
  });

  // ── Reactive housekeeping ─────────────────────────────────────────────────

  $effect(() => {
    if (!textarea) return;
    void appStore.composer;
    autoGrow(textarea);
  });

  $effect(() => {
    void appStore.currentChatId;
    attachments.clearOcr();
    clearQuote();
  });

  // Surface a one-off error placeholder after a failed turn.
  $effect(() => {
    if (appStore.currentChatGenerating) {
      clearErrorPlaceholder();
      return;
    }
    const last = appStore.currentChat?.messages?.at(-1);
    if (last?.role !== 'assistant' || last?.status !== 'error' || showErrorPlaceholder) return;

    showErrorPlaceholder = true;
    if (errorPlaceholderTimer) clearTimeout(errorPlaceholderTimer);
    errorPlaceholderTimer = setTimeout(() => {
      showErrorPlaceholder = false;
    }, ERROR_PLACEHOLDER_MS);
  });

  // The context ring depends on far more than the composer text, so this tracks
  // everything that feeds the estimate and recomputes on a trailing edge.
  $effect(() => {
    void appStore.currentChatId;
    void appStore.composer;
    void appStore.pendingAttachments.length;
    void appStore.currentRagDocuments.length;
    void appStore.currentChat?.messages.length;
    void appStore.searchMode;
    void appStore.composerMode;
    void appStore.currentContextMode;
    void appStore.backendMode;
    void appStore.activeProviderName;
    void appStore.activeProvider?.model;
    void appStore.activeProvider?.max_tokens;
    void appStore.activeProvider?.base_url;
    void appStore.activeProvider?.has_api_key;
    void appStore.config.llm?.local?.context_length;
    void appStore.config.llm?.local?.max_tokens;
    void appStore.config.llm?.local?.system_prompt;
    void appStore.config.llm?.system_prompt;
    void appStore.userName;

    if (budgetTimer) clearTimeout(budgetTimer);
    budgetTimer = setTimeout(() => {
      void appStore.refreshContextBudgetPreview();
    }, BUDGET_DEBOUNCE_MS);

    return () => {
      if (budgetTimer) {
        clearTimeout(budgetTimer);
        budgetTimer = null;
      }
    };
  });

  onDestroy(() => {
    destroyed = true;
    exitVoiceMode();
    dictation.dispose();
    if (errorPlaceholderTimer) clearTimeout(errorPlaceholderTimer);
  });
</script>

<div
  class="composer-dock relative z-20 w-full shrink-0 px-3 pb-2 pt-2 md:px-6 md:pb-3 {attachments.windowDragActive
    ? 'pointer-events-auto'
    : 'pointer-events-none'}"
  role="region"
  aria-label="Message composer"
  ondrop={(event) => attachments.handleDrop(event)}
  ondragover={(event) => attachments.handleDragOver(event)}
  ondragleave={(event) => attachments.handleDragLeave(event)}
>
  <input
    bind:this={fileInput}
    class="hidden"
    type="file"
    multiple
    accept="image/*,.pdf,.docx,.doc,.txt,.md,.csv,.json,.html,.xml,.rtf,.epub"
    oninput={(event) => void attachments.handleFileInput(event)}
  />

  {#if attachments.dragOver}
    <div class="drop-overlay">
      <div class="text-center">
        <Paperclip class="mx-auto mb-2 size-8 text-muted-foreground" />
        <p class="text-sm font-medium text-foreground">{copy.composer.dropFiles}</p>
        <p class="text-xs text-muted-foreground">{copy.composer.dropHint}</p>
      </div>
    </div>
  {/if}

  <div
    class="composer-frame mx-auto w-full"
    style="max-width: var(--thread-width);"
  >
    <!-- The dock ignores the pointer so the thread scrolls behind it; what
         sits above the input opts back in, or it renders but never clicks. -->
    <div class="composer-above">
      <ComposerModelNotice />
      {@render above?.()}
    </div>

    {#if appStore.activeSpace === 'home'}
      <!-- The mode tab lives above the input shell on Home: Instant for fast
           grounded answers, Agent for the full tool loop. Code space always
           runs the full loop, so it offers no tab. -->
      <div class="mode-tab-row">
        <ModeSelector />
      </div>
    {/if}

    {#if dictation.phase === 'choose'}
      <DictationSetupPopover {dictation} />
    {/if}

    <!-- Back to the latest message, on the tab row's right end. While the run is
         live the button wears the meter, so a thread scrolled away from the
         status row still says the agent is working. -->
    {#if threadJump.visible && threadJump.jump}
      <div class="jump-slot">
        <JumpToLatest working={generating} mode={jumpMode} onclick={() => threadJump.jump?.()} />
      </div>
    {/if}

    {#if voiceMode}
      <VoiceCallPanel onend={exitVoiceMode} />
    {/if}

    <!-- Radius comes from --composer-radius on .ui-composer; the rounded-*
         utilities that used to sit here fought it at equal specificity. -->
    {#if appStore.currentChat?.pendingPrompts?.length && appStore.currentChatId}
      <PromptQueue items={appStore.currentChat.pendingPrompts} onupdate={(id, content) => appStore.updateQueuedPrompt(appStore.currentChatId!, id, content)} onremove={(id) => { appStore.removeQueuedPrompt(appStore.currentChatId!, id); }} onsend={() => void appStore.sendQueuedPromptsNow(appStore.currentChatId!)} />
    {/if}
    <div class="composer-shell ui-composer pointer-events-auto transition">
      {#if nameCompletion}
        <NameCompletion {textarea} text={appStore.composer} {...nameCompletion} onchange={(text) => appStore.updateComposer(text)} />
      {/if}
      {#if attachments.ocrLabel}
        <div class="px-3 pt-1">
          <div class="inline-flex items-center gap-1.5 px-2 py-1 text-[12px] font-medium text-muted-foreground">
            <span
              class="size-1.5 rounded-[2px] bg-muted-foreground"
              class:animate-pulse={!attachments.ocrSettled}
            ></span>
            <span>{attachments.ocrLabel}</span>
          </div>
        </div>
      {/if}

      <AttachmentCards />

      {#if localBusyElsewhere}
        <div class="px-4 pt-1 text-[12px] text-muted-foreground">
          {$t('chat.localBusy')}
        </div>
      {/if}

      {#if quotedText}
        <div class="px-4 pt-3">
          <SelectedTextCard bind:text={quotedText} ondiscard={() => { clearQuote(); requestAnimationFrame(() => focusComposer()); }} />
        </div>
      {/if}

      <!--
        Two rows: the message gets the full width, and every control sits on a
        second line beneath it. Putting the input and the controls on one line
        squeezes the text into a shrinking gap as the chips grow, and pins the
        caret next to icons that have nothing to do with typing.
      -->
      <div class="composer-body {quotedText ? 'pt-1' : ''}">
        <textarea
          bind:this={textarea}
          class="composer-textarea w-full resize-none bg-transparent text-foreground outline-none"
          {placeholder}
          rows="1"
          value={appStore.composer}
          oninput={onInput}
          onkeydown={onKeydown}
        ></textarea>

        <div class="composer-bar">
          {#if dictation.uiActive && !voiceMode && dictation.phase !== 'choose'}
            <!-- Dictation takes over the bar: waveform, timer, cancel, done. -->
            <ComposerRecorder {dictation} />
          {:else}
            <div class="composer-bar-leading">
              <ComposerAddMenu onattach={() => fileInput?.click()} />
              <div class="model-slot"><ModelSwitcher compact /></div>
              <ReasoningLevelSelector />
            </div>
            <ComposerToolbar
              {dictation}
              {generating}
              {sendDisabled}
              oncall={() => void enterVoiceMode()}
              onsubmit={() => void submit()}
              onstop={() => appStore.stopStreaming()}
            />
          {/if}
        </div>
      </div>
    </div>

    {#if threadIsEmpty}
      <!-- await tick() so the textarea holds the inserted prompt before we
           focus it; otherwise the caret lands at the pre-insert length. -->
      <ComposerSuggestions onpick={async () => { await tick(); focusComposer(); }} />
    {/if}
  </div>
</div>

<style>
  .composer-dock {
    background: var(--chat-bg);
  }
  /* Fade the thread out into the dock rather than cutting it off. */
  .composer-dock::before {
    content: '';
    position: absolute;
    inset-inline: 0;
    top: -2rem;
    height: 2rem;
    pointer-events: none;
    background: linear-gradient(
      to bottom,
      transparent,
      color-mix(in srgb, var(--chat-bg) 62%, transparent) 65%,
      var(--chat-bg)
    );
  }
  .composer-frame {
    position: relative;
  }
  /* Instant/Agent tab above the input shell: quiet, left-aligned, attached to
     the shell rather than floating in the thread. The dock is
     pointer-events:none so the thread stays scrollable behind it — opt back
     in, or the tabs render but never receive clicks. */
  .composer-above {
    pointer-events: auto;
  }
  .mode-tab-row {
    display: flex;
    justify-content: flex-start;
    padding: 0 0 0.35rem;
    pointer-events: auto;
  }
  /* Level with the Agent / Instant tabs, flush with the input's right edge. The
     dock ignores the pointer so the thread stays scrollable behind it, so the
     slot opts back in; the button's own look lives in JumpToLatest. */
  .jump-slot {
    position: absolute;
    top: 0;
    right: 0.35rem;
    z-index: 30;
    pointer-events: auto;
  }
  .drop-overlay {
    position: absolute;
    inset: 0;
    z-index: var(--z-float);
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px dashed var(--border-hover);
    border-radius: 1rem;
    background: var(--surface-hover);
  }

  .model-slot { min-width: 0; max-width: 18rem; flex: 0 1 auto; }
  @container composer (max-width: 620px) {
    .model-slot { max-width: 12rem; }
  }
</style>
