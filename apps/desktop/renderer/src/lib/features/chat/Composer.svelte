<svelte:options runes={true} />

<!--
  The composer shell: input, drop target, and the pieces that hang off it.

  Speech recognition, drag-and-drop, and OCR progress live in
  `composer/use-dictation.svelte.ts` and `composer/use-attachments.svelte.ts`;
  both conversation surfaces share the toolbar and dictation controls.
  What remains here is the textarea and how a message gets submitted.
-->

<script lang="ts">
  import UiFileInput from '$lib/components/ui/FileInput.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import type { Snippet } from 'svelte';
  import { onDestroy, tick } from 'svelte';
  import { Globe2, GraduationCap, ListChecks, Paperclip, Radar, Target, Wrench, Zap } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { isConfigModelReady } from '$lib/stores/chat-model';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { copy, say } from '$lib/copy';
  import { matchLessonCommand } from './lesson-entry';

  import AttachmentCards from './composer/AttachmentCards.svelte';
  import ModelMenu from './model-menu/ModelMenu.svelte';
  import ComposerSuggestions from './composer/ComposerSuggestions.svelte';
  import ComposerAddMenu from './composer/ComposerAddMenu.svelte';
  import ComposerToolsMenu from './composer/ComposerToolsMenu.svelte';
  import ComposerBar from './composer/ComposerBar.svelte';
  import DictationButton from './composer/DictationButton.svelte';
  import MicBars from '$lib/features/shared/composer/MicBars.svelte';
  import ComposerShell from '$lib/features/shared/composer/ComposerShell.svelte';
  import { dictationSlotFor, handleApprovalKey, handlePickerKey, recallLastQueuedPrompt } from '$lib/features/shared/composer/composer-shared';
  import ComposerPicker from '$lib/features/shared/composer/ComposerPicker.svelte';
  import { matchSlashCommands, slashQuery } from '$lib/features/shared/composer/slash-commands';
  import HomeContextStatus from './composer/HomeContextStatus.svelte';
  import SelectedModes from './composer/SelectedModes.svelte';
  import { parseGoalCommand, type GoalCommand } from '$shared/session-goal';
  import { parseHomeModeCommand } from '$shared/composer-command';
  import SelectedTextCard from './composer/SelectedTextCard.svelte';
  import VoiceCallPanel from './composer/VoiceCallPanel.svelte';
  import { ComposerAttachments } from './composer/use-attachments.svelte';
  import { Dictation } from './composer/use-dictation.svelte';
  import { autogrowTextarea } from '$lib/features/shared/composer-autogrow';
  import NameCompletion from '$lib/features/shared/NameCompletion.svelte';
  import PromptQueue from '$lib/features/shared/PromptQueue.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import SessionGoal from '$lib/features/shared/SessionGoal.svelte';
  import type { NameCandidate } from '$lib/features/shared/name-completion';

  let { placeholder: customPlaceholder, nameCompletion, above, suggestions = true }: {
    placeholder?: string;
    nameCompletion?: { candidates: NameCandidate[]; automatic?: boolean; nickname?: boolean };
    /** A row above the input, inside the composer's width (roleplay steering). */
    above?: Snippet;
    /** Starter prompts under an empty thread's composer; a surface that lists its own starters turns them off. */
    suggestions?: boolean;
    /** Context usage on a strip under the input, as Code draws it, so a narrow composer keeps its bar for the controls. */
  } = $props();

  let goalControl = $state<{ command: (value: GoalCommand) => Promise<void> }>();
  const slashId = $props.id();
  let slashDismissed = $state(false);
  let slashIndex = $state(0);
  /**
   * Past one row: the send square belongs at the bottom edge, beside the last
   * line, rather than in the middle of a tall field.
   */
  let grown = $state(false);
  const supportsGoals = $derived(appStore.currentContextMode === 'home' || appStore.currentContextMode === 'design');
  const slashCommands = $derived([
    { name: 'goal', icon: Target, hint: $t('goal.hint') },
    { name: 'teach', icon: GraduationCap, hint: $t('artifacts.lesson.teach') },
    { name: 'practice', icon: ListChecks, hint: $t('artifacts.lesson.practice') },
    { name: 'agent', icon: Wrench, hint: $t('chat.mode.agentHint') },
    { name: 'instant', icon: Zap, hint: $t('chat.mode.instantHint') },
    { name: 'search', icon: Globe2, hint: copy.searchModes.search.label },
    { name: 'research', icon: Radar, hint: copy.searchModes.deep.label }
  ]);
  const slashText = $derived(appStore.currentContextMode === 'home' ? slashQuery(appStore.composer) : null);
  const slashMatches = $derived(slashText === null ? [] : matchSlashCommands(slashCommands, slashText));
  const slashOpen = $derived(!slashDismissed && slashMatches.length > 0);

  $effect(() => { void slashText; slashIndex = 0; });

  async function selectSlash(index: number, complete = false) {
    const command = slashMatches[index];
    if (!command) return;
    if (!appStore.currentChat) appStore.createChat();
    if (command.name === 'goal' && !complete) {
      appStore.updateComposer('/goal');
      await submit();
      return;
    }
    appStore.updateComposer(`/${command.name} `);
    await tick();
    focusComposer();
  }
  function ensureGoalSession(): string {
    const chat = appStore.currentChat;
    if (!chat) throw new Error('No active conversation');
    chat.homeRuntime ??= { sessionId: crypto.randomUUID(), revision: 0, provider: '', model: '', contextWindow: 0, historyIds: [], goalPending: true };
    appStore.markChatDirty(chat.id);
    appStore.persist();
    return chat.homeRuntime.sessionId;
  }
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
  let fileInput = $state<HTMLInputElement | undefined>();
  let showErrorPlaceholder = $state(false);
  let errorPlaceholderTimer: ReturnType<typeof setTimeout> | null = null;
  let budgetTimer: ReturnType<typeof setTimeout> | null = null;
  let quotedText = $state('');
  let quotedSourceMessageId = $state('');
  /** The starter under the pointer: its prompt is previewed in the empty field. */
  let previewPrompt = $state('');

  /* Design's link row (and anything else outside this subtree) announces the
     starter it is pointing at, so one field behaviour serves every surface.
     Scoped to the conversation in front, or a background tab would adopt it. */
  $effect(() => {
    const onPreview = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: string; text?: string }>).detail ?? {};
      if (detail.chatId && detail.chatId !== appStore.currentChatId) return;
      previewPrompt = detail.text ?? '';
    };
    window.addEventListener('composer-preview', onPreview);
    return () => window.removeEventListener('composer-preview', onPreview);
  });
  let destroyed = false;

  const generating = $derived(appStore.currentChatGenerating);
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
          : customPlaceholder ?? (previewPrompt && !appStore.composer.trim() ? previewPrompt : copy.composer.placeholder)
  );

  // Mirrors the guards inside sendCurrentMessage so the button reflects reality.
  const backendReady = $derived(isConfigModelReady(appStore.config, appStore.localModelActive));
  const sendDisabled = $derived(!generating && (!backendReady || localBusyElsewhere));
  /** Nothing typed and nothing attached: the field has no message to send. */
  const fieldEmpty = $derived(!appStore.composer.trim() && !appStore.pendingAttachments.some(item => item.status === 'ready'));
  /** The send slot's microphone: the bar's own button, moved into the empty field's corner. */
  const slotDictation = $derived(dictationSlotFor({
    running: generating,
    fieldEmpty,
    supported: dictation.supported,
    listening: dictation.listening,
    hidden: voiceMode,
    label: copy.composer.dictate,
    onToggle: () => dictation.toggle(false),
    glyph: listeningBars
  }));

  /**
   * Size the input to its content.
   *
   * Measured against the *empty* height rather than trusting `scrollHeight`
   * outright: when this runs before layout has settled — which it does on
   * mount — `scrollHeight` can come back far too large, and the old version
   * would clamp that to the cap and leave an empty composer stuck at full
   * height until the next keystroke.
   *
   * The cap is the stylesheet's: five rows of the field's own text.
   */
  function autoGrow(element: HTMLTextAreaElement) {
    autogrowTextarea(element, null, (isGrown) => { grown = isGrown; });
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
    const goalCommand = supportsGoals ? parseGoalCommand(appStore.composer) : null;
    if (goalCommand) {
      if (!appStore.currentChat) appStore.createChat();
      appStore.updateComposer('');
      await tick();
      await goalControl?.command(goalCommand);
      return;
    }
    // `/teach` and `/practice` are Home-only and opt-in: the first use turns the
    // type on, and the command becomes the directive the agent answers.
    const lessonAsk = matchLessonCommand(appStore.composer, appStore.currentContextMode);
    if (lessonAsk) {
      if (!appStore.currentChat) appStore.createChat('home');
      if (!(appStore.getArtifactToggles().lesson ?? false)) void appStore.updateArtifactToggles({ lesson: true });
      appStore.updateComposer(lessonAsk.directive);
    }
    if(appStore.activeSpace==='home'){
      const selected=parseHomeModeCommand(appStore.composer);
      if(selected){if(selected.mode)appStore.setComposerMode(selected.mode);if(selected.research&&appStore.searchMode!==selected.research)appStore.setSearchMode(selected.research);appStore.updateComposer(selected.prompt);if(!selected.prompt)return;}
    }
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

  /** A tool call held for the user's answer: asked on this sheet, as in Code. */
  const pendingApprovals = $derived(appStore.currentChatId ? approvalsStore.forChat(appStore.currentChatId) : []);

  function onKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.defaultPrevented) return;
    // A held call owns Escape (deny) and Enter on an empty field (allow).
    if (handleApprovalKey(event, {
      approval: pendingApprovals[0],
      isEmpty: !appStore.composer.trim() && !appStore.pendingAttachments.length,
      resolve: (id, allow) => approvalsStore.resolve(id, allow)
    })) return;
    if (handlePickerKey(event, {
      open: slashOpen,
      count: slashMatches.length,
      index: slashIndex,
      onIndex: (next) => (slashIndex = next),
      onComplete: (index) => void selectSlash(index, true),
      onSelect: (index) => void selectSlash(index, false),
      onDismiss: () => (slashDismissed = true)
    })) return;
    if (recallLastQueuedPrompt(event, {
      isEmpty: !appStore.composer && !appStore.pendingAttachments.length,
      prompts: appStore.currentChat?.pendingPrompts,
      onRecall: (item) => {
        if (!appStore.currentChatId) return;
        appStore.removeQueuedPrompt(appStore.currentChatId, item.id);
        appStore.updateComposer(item.content);
        appStore.pendingAttachments = item.attachments ?? [];
      }
    })) return;
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void submit();
  }

  function onInput(event: Event) {
    slashDismissed = false;
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
    void appStore.activeLoadConfig.context_length;
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

<!-- The bars that dance in the send square while it is listening. -->
{#snippet listeningBars()}<MicBars />{/snippet}

<ComposerShell
  ariaLabel="Message composer"
  dockFade="tall"
  dockClass={attachments.windowDragActive ? 'pointer-events-auto' : 'pointer-events-none'}
  {dictation}
  {voiceMode}
  running={generating}
  value={appStore.composer}
  {placeholder}
  {grown}
  bind:textarea
  ariaControls={slashOpen ? slashId : undefined}
  ariaActivedescendant={slashOpen ? `${slashId}-${slashIndex}` : undefined}
  sendDisabled={sendDisabled || fieldEmpty}
  sendLabel={copy.composer.send}
  stopLabel={copy.composer.stop}
  dictationSlot={slotDictation}
  {pendingApprovals}
  approvalService
  bodyClass={quotedText ? 'pt-1' : ''}
  onpaste={(event) => attachments.handlePaste(event)}
  ondrop={(event) => attachments.handleDrop(event)}
  ondragover={(event) => attachments.handleDragOver(event)}
  ondragleave={(event) => attachments.handleDragLeave(event)}
  oninput={onInput}
  onkeydown={onKeydown}
  onsend={() => void submit()}
  onstop={() => appStore.stopStreaming()}
>
  {#snippet dockOverlay()}
    <UiFileInput
      bind:ref={fileInput}
      class={uiClass("hidden")}
      multiple
      accept="*/*"
      oninput={(event) => void attachments.handleFileInput(event)}
    />

    {#if attachments.dragOver}
      <div class="drop-overlay">
        <div class="text-center">
          <Paperclip class="mx-auto mb-2 size-8 text-muted-foreground" />
          <p class="text-sm font-medium text-foreground">{copy.composer.dropFiles}</p>
        </div>
      </div>
    {/if}
  {/snippet}

  {#snippet beforeShell()}
    <div class="composer-above">
      {@render above?.()}
    </div>

    {#if voiceMode}
      <VoiceCallPanel onend={exitVoiceMode} />
    {/if}

    {#if slashOpen}
      <ComposerPicker id={slashId} label={$t('code.slash.title')} selected={slashIndex} floating
        items={slashMatches.map(command => ({ id: command.name, label: `/${command.name}`, icon: command.icon, hint: command.hint }))}
        onhighlight={index => (slashIndex = index)} onselect={index => void selectSlash(index)} />
    {/if}
    {#if appStore.currentChat?.pendingPrompts?.length && appStore.currentChatId}
      <PromptQueue running={generating} items={appStore.currentChat.pendingPrompts} onupdate={(id, content) => appStore.updateQueuedPrompt(appStore.currentChatId!, id, content)} onremove={(id) => { appStore.removeQueuedPrompt(appStore.currentChatId!, id); }} onsend={(id) => void appStore.sendQueuedPromptsNow(appStore.currentChatId!, id)} />
    {/if}
    {#if appStore.currentChat && supportsGoals}
      {#key appStore.currentChat.id}
        <SessionGoal bind:this={goalControl} chatId={appStore.currentChat.id} sessionId={appStore.currentChat.homeRuntime?.sessionId} ensureSession={ensureGoalSession} />
      {/key}
    {/if}
    <AttachmentCards />
  {/snippet}

  {#snippet shellTop()}
    {#if nameCompletion}
      <NameCompletion {textarea} text={appStore.composer} {...nameCompletion} onchange={(text) => appStore.updateComposer(text)} />
    {/if}
    {#if attachments.ocrLabel}
      <div class="px-3 pt-1">
        <div class="inline-flex items-center gap-1.5 px-2 py-1 text-[length:var(--text-xs)] font-medium text-muted-foreground">
          <span
            class="size-1.5 rounded-[2px] bg-muted-foreground"
            class:animate-pulse={!attachments.ocrSettled}
          ></span>
          <span>{attachments.ocrLabel}</span>
        </div>
      </div>
    {/if}
    {#if localBusyElsewhere}
      <div class="px-4 pt-1 text-[length:var(--text-xs)] text-muted-foreground">
        {$t('chat.localBusy')}
      </div>
    {/if}
    {#if quotedText}
      <div class="px-4 pt-3">
        <SelectedTextCard bind:text={quotedText} ondiscard={() => { clearQuote(); requestAnimationFrame(() => focusComposer()); }} />
      </div>
    {/if}
  {/snippet}

  {#snippet tray()}
    <ComposerBar>
      {#snippet attach()}<ComposerAddMenu onattach={() => fileInput?.click()} />{/snippet}
      {#snippet extras()}<ComposerToolsMenu compact />{#if appStore.activeSpace === 'home'}<SelectedModes />{/if}{/snippet}
      {#snippet model()}<ModelMenu compact />{/snippet}
      {#snippet microphone()}<DictationButton {dictation} hidden={!!slotDictation} oncall={() => void enterVoiceMode()} />{/snippet}
      {#snippet trailing()}<HomeContextStatus />{/snippet}
    </ComposerBar>
  {/snippet}

  {#snippet afterTray()}
    {#if threadIsEmpty && suggestions}
      <!-- await tick() so the textarea holds the inserted prompt before we
           focus it; otherwise the caret lands at the pre-insert length. -->
      <ComposerSuggestions onpick={async () => { previewPrompt = ''; await tick(); focusComposer(); }} onpreview={(starter) => (previewPrompt = starter?.preview ?? '')} />
    {/if}
  {/snippet}
</ComposerShell>

<style>
  .drop-overlay {
    pointer-events: none;
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
</style>
