<svelte:options runes={true} />

<!--
  The Code composer: the same shell as Home's composer (ui-composer pill,
  two-row body, dock fade) so both spaces read as one product.

  Grammar follows the same bar split — scope on the left (runtime-mode gate),
  brain on the right (model), and a send control that only exists when there
  is something shippable. While a run is active the bar switches to steering:
  Enter course-corrects, Alt+Enter queues a follow-up, the button stops.
-->

<script lang="ts">
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import UiFileInput from '$lib/components/ui/FileInput.svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onDestroy, untrack } from 'svelte';
  import { ArrowDownToLine, ArrowUp, ChevronDown, ClipboardList, Eye, EyeOff, Folder, File as FileIcon, MoreHorizontal, Paperclip, Play, Plus, ShieldCheck, Settings2, X, Zap } from 'lucide-svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { codeWorkspace } from './workspace.svelte';
  import { exactSlashCommand, matchSlashCommands, slashQuery } from './slash-commands';
  import { codeCommands, type CodeCommand, type CodeDialog } from './code-commands';
  import { t } from 'svelte-i18n';
  import type { ChatSession, ReasoningLevel } from '$lib/types/chat';
  import { appStore } from '$lib/stores/app.svelte';
  import { fetchReasoningCapabilities } from '$lib/services/chat-api';
  import { isElectron } from '$lib/services/bridge';
  import { ThinkingCapabilitiesController } from '$lib/stores/models/thinking-capabilities.svelte';
  import ModelSwitcher from '$lib/features/chat/ModelSwitcher.svelte';
  import ContextUsageRing from '$lib/features/chat/composer/ContextUsageRing.svelte';
  import { codeStore } from './code.svelte';
  import { codeEdits, initProject, projectFiles, setAgenteModel } from './code-ipc';
  import CodeProjectDialog from './CodeProjectDialog.svelte';
  import TodoDock from './TodoDock.svelte';
  import { conversationTodos } from './code-run';
  import MediaAttachmentCard from './MediaAttachmentCard.svelte';
  import PromptQueue from '$lib/features/shared/PromptQueue.svelte';
  import { conversationSpend } from './accounting';
  import { fileMentionAt, insertFile, matchFiles } from './file-mention';
  import { downloadSessionMarkdown } from '$lib/features/shared/export-session';
  import { Button, Dialog } from '$lib/components/ui';
  import { invoke } from '$lib/services/bridge';
  import type { Attachment, AttachmentKind } from '$shared/agente-protocol.gen';
  import { MEDIA_ACCEPT, isMediaPath, mediaData } from './code-media';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import SendButton from '$lib/features/shared/composer/SendButton.svelte';
  import ReasoningLevelSelector from '$lib/features/chat/composer/ReasoningLevelSelector.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { copy } from '$lib/copy';
  import { MAX_COMPOSER_TEXTAREA_PX, autogrowTextarea } from '$lib/features/shared/composer-autogrow';
  import { mergeDraft } from '$lib/features/canvas/canvas-doc';

  let { chat }: { chat: ChatSession } = $props();

  /** Textarea grows with content up to this height, then scrolls (Home parity). */
  const MAX_TEXTAREA_PX = MAX_COMPOSER_TEXTAREA_PX;

  let textarea = $state<HTMLTextAreaElement | undefined>(undefined);
  let text = $state(untrack(() => chat.draft || ''));
  let modeMenuOpen = $state(false);
  let toolsMenuOpen = $state(false);
  let dialog = $state<CodeDialog | null>(null);
  let caret = $state(0);
  let files = $state<string[]>([]);
  let fileIndex = $state(0);
  let fileDismissed = $state(false);
  let mediaPicker = $state<HTMLInputElement>();
  let attachments = $state<Attachment[]>(untrack(() => chat.codeAgent?.draftAttachments?.map((item) => ({ ...item })) || []));
  let pendingMedia = $state<Attachment[]>([]);
  let allowMedia = $state<AttachmentKind[]>([]);
  let attaching = $state(false);

  const run = $derived(codeStore.runFor(chat.id));
  const running = $derived(!!run?.running);
  const ownConfig = $derived(appStore.configForChat(chat));
  const ownBackend = $derived(ownConfig.llm?.backend_mode ?? 'local');
  const ownProvider = $derived(ownBackend === 'local' ? 'local' : ownConfig.llm?.provider ?? '');
  const ownModel = $derived(ownBackend === 'local' ? ownConfig.llm?.local?.model ?? '' : ownConfig.llm?.providers?.[ownProvider]?.model ?? '');
  const thinking = new ThinkingCapabilitiesController({ getConfig: () => ownConfig, isNative: isElectron, fetch: fetchReasoningCapabilities });
  const ownThinking = $derived(thinking.capabilities);
  $effect(() => {
    ownConfig;
    void untrack(() => thinking.refresh(true));
    return () => thinking.cancel();
  });
  function setThinking(level: ReasoningLevel | null) {
    chat.reasoningLevel=level; if(appStore.currentChatId===chat.id)appStore.reasoningLevel=level;
    appStore.markChatDirty(chat.id);appStore.persist();
  }
  const runtimeMode = $derived(chat.codeAgent?.runtimeMode ?? codeStore.defaultMode);
  // Honest model visibility: without a usable model the bar says so instead
  // of letting a send die inside the provider.
  const modelReady = $derived(ownBackend === 'local' ? !!(ownConfig.llm?.local?.selected_model_path && appStore.localModelActive) : !!(ownModel && (ownConfig.llm?.providers?.[ownProvider]?.api_key || ownConfig.llm?.providers?.[ownProvider]?.has_api_key)));
  const canSend = $derived((!!text.trim() || attachments.length > 0) && !attaching && (modelReady || running));
  // Real accounting from the engine: promptTokens of the last call is the
  // context footprint. Hidden until the first report, like Home's ring.
  const usage = $derived(run?.usage ?? [...chat.messages].reverse().find((message) => message.metadata?.codeUsage)?.metadata?.codeUsage);
  const showContextRing = $derived(!!usage && usage.promptTokens > 0 && (usage.contextWindow ?? 0) > 0);
  const spend = $derived(conversationSpend(chat.messages, run ?? undefined));
  /** Input handed off but not yet consumed by a turn. */
  const queuedCount = $derived(run?.queuedCount ?? 0);
  /**
   * The last run ended on its own terms — offer one-click continuation
   * (dsh's turn-tail action) instead of making the user retype.
   */
  const canContinue = $derived.by(() => {
    // Only when the run was cut short (output cap or turn budget) — a run
    // that finished its task has nothing to continue.
    const last = chat.messages.at(-1)?.metadata;
    return !running && modelReady && (last?.codeStopReason === 'length' || !!last?.codeHitTurnLimit);
  });
  /** A paused run waiting on the user: point at the row that needs an answer. */
  const awaitingApproval = $derived(approvalsStore.forChat(chat.id).length > 0);
  /** The task list on the composer: live while a run works, then while tasks are left. */
  const todos = $derived.by(() => {
    if (running) return run?.todos ?? [];
    const saved = conversationTodos(chat.messages);
    return saved.some((todo) => todo.status !== 'completed') ? saved : [];
  });

  const modes = $derived([
    { id: 'plan' as const, icon: ClipboardList, label: $t('code.modePlan'), hint: $t('code.modePlanHint') },
    { id: 'supervised' as const, icon: ShieldCheck, label: $t('code.modeSupervised'), hint: $t('code.modeSupervisedHint') },
    { id: 'full' as const, icon: Zap, label: $t('code.modeFull'), hint: $t('code.modeFullHint') }
  ]);
  const activeMode = $derived(modes.find((m) => m.id === runtimeMode) ?? modes[1]!);
  // Svelte 5 dynamic components: a capitalized reference renders directly.
  const ModeIcon = $derived(activeMode.icon);

  function selectMode(mode: 'plan' | 'supervised' | 'full') {
    modeMenuOpen = false;
    if (mode !== runtimeMode) void codeStore.setMode(chat.id, mode).catch((error) => toastStore.error(String(error)));
  }

  async function editFiles(action: 'undo' | 'redo') {
    await codeStore.ensureSession(chat.id);
    const result = await codeEdits(chat.id, action);
    if (!result.ok) throw new Error(result.error || 'Could not restore files.');
    await codeStore.refreshCheckpoints(chat.id);
    if (project) await codeWorkspace.refreshChanges({ chatId: chat.id, projectRoot: project.rootPath, sessionId: chat.codeAgent?.sessionId || undefined });
    toastStore.success(`${action === 'undo' ? 'Restored' : 'Reapplied'} ${result.files?.length ?? 0} files`);
  }

  function openModelHub() {
    appStore.openSettings('models');
  }

  const placeholder = $derived(
    running
      ? $t('code.steerPlaceholder')
      : !modelReady
        ? ownBackend === 'api' && ownModel ? copy.model.configureProvider : $t('code.selectModel')
        : $t('code.composerPlaceholder')
  );

  const hint = $derived(
    running
      ? $t('code.steerHint')
      : !modelReady
        ? ''
        : $t('code.composerHint')
  );

  /** Size the input to its content — shared helper keeps Home parity. */

  // ── Commands (slash menu and "…" menu) ──────────────────────────────
  type Command = CodeCommand;

  const project = $derived(codeStore.projectById(chat.projectId ?? null));
  // These sections ask the engine about a project directory. The rest —
  // Agent settings and saved sessions — are runtime-wide and work without one.
  const PROJECT_SECTIONS: CodeDialog[] = ['skills', 'agents', 'mcp'];
  const commands = $derived<Command[]>(codeCommands({
    t: (key) => $t(key),
    running,
    hasProject: !!project,
    mode: runtimeMode,
    compact: async () => {
      // Session state is not reactive; check it when the command runs.
      if (!codeStore.hasSession(chat.id)) {
        toastStore.info($t('code.slash.nothingToCompact'));
        return;
      }
      const result = await codeStore.compact(chat.id);
      if (result.ok) toastStore.success($t('code.slash.compacted'));
      else toastStore.error($t('code.compactFailed', { values: { error: result.error ?? '' } }));
    },
    newConversation: () => { if (project) codeStore.newConversation(project); },
    setMode: selectMode,
    showChanges: () => codeWorkspace.toggleChanges(true),
    toggleTerminal: async () => {
      if (!project) return;
      try {
        await codeWorkspace.toggleBottom('terminal', project.rootPath);
      } catch (error) {
        toastStore.error($t('codeWs.terminalFailed', { values: { reason: (error as Error).message } }));
      }
    },
    openDialog: (next) => { dialog = next; },
    edits: editFiles,
    init: async () => { if (project) toastStore.info((await initProject(project.rootPath)).message); },
    exportConversation: () => downloadSessionMarkdown(chat),
    openModels: openModelHub,
    openProject: async () => { const selected = await codeStore.addProject(); if (selected) codeStore.newConversation(selected); },
    stop: () => codeStore.stop(chat.id)
  }));
  const menuGroups = $derived([commands.filter((command) => command.menu === 'actions'), commands.filter((command) => command.menu === 'project')]);

  $effect(() => {
    const root = project?.rootPath;
    files = [];
    if (!root) return;
    let active = true;
    void projectFiles(root).then((value) => { if (active) files = value; }).catch(() => {});
    return () => { active = false; };
  });
  const mention = $derived(fileMentionAt(text, caret));
  const fileMatches = $derived(mention ? matchFiles(files, mention.query) : []);
  const fileOpen = $derived(!!mention && !fileDismissed && fileMatches.length > 0);
  $effect(() => { void mention?.query; fileIndex = 0; });
  function chooseFile(file: string) {
    if (!mention) return;
    if (isMediaPath(file)) {
      const start = mention.start;
      const end = caret;
      void attachPath(file).then((attached) => { if (attached) text = text.slice(0, start) + text.slice(end); });
      return;
    }
    const inserted = insertFile(text, caret, mention, file);
    text = inserted.text;
    caret = inserted.caret;
    void Promise.resolve().then(() => { textarea?.focus(); textarea?.setSelectionRange(caret, caret); });
  }
  function onFileKey(event: KeyboardEvent): boolean {
    if (!fileOpen) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      fileIndex = (fileIndex + (event.key === 'ArrowDown' ? 1 : -1) + fileMatches.length) % fileMatches.length;
    } else if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing)) {
      event.preventDefault(); chooseFile(fileMatches[fileIndex]!);
    } else if (event.key === 'Escape') {
      event.preventDefault(); fileDismissed = true;
    } else return false;
    return true;
  }

  let slashIndex = $state(0);
  let slashDismissed = $state(false);
  const slashText = $derived(slashQuery(text));
  const slashMatches = $derived(slashText === null ? [] : matchSlashCommands(commands, slashText));
  const slashOpen = $derived(slashText !== null && !slashDismissed && slashMatches.length > 0);

  $effect(() => {
    void slashText;
    slashIndex = 0;
  });

  function clearComposer() {
    text = '';
    slashDismissed = false;
    if (textarea) autoGrow(textarea);
  }

  async function runCommand(command: Command) {
    if (command.disabled) return;
    clearComposer();
    toolsMenuOpen = false;
    try { await command.run(); }
    catch (error) { toastStore.error(String(error)); }
  }

  function completeCommand(command: Command) {
    text = `/${command.name}`;
    void Promise.resolve().then(focusComposer);
  }

  /** Keys the open slash menu handles; true when the key was used. */
  function onSlashKey(event: KeyboardEvent): boolean {
    if (!slashOpen) return false;
    const count = slashMatches.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      slashIndex = (slashIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      void Promise.resolve().then(() => document.querySelector('.slash-item.is-active')?.scrollIntoView({ block: 'nearest' }));
      return true;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      completeCommand(slashMatches[slashIndex]!);
      return true;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void runCommand(slashMatches[slashIndex]!);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      slashDismissed = true;
      return true;
    }
    return false;
  }

  function autoGrow(element: HTMLTextAreaElement) {
    autogrowTextarea(element, MAX_TEXTAREA_PX);
  }

  function focusComposer() {
    if (!textarea) return;
    if (appStore.currentChatId !== chat.id) codeStore.openConversation(chat.id);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  // What the selected model can take, shown quietly on the bar so a
  // screenshot it never sees is not a surprise.
  const MEDIA_KINDS = ['image', 'video', 'audio'] as const;
  let modelInputs = $state<string[] | null>(null);
  $effect(() => {
    const provider = ownProvider;
    const model = ownModel;
    let current = true;
    void invoke<string[]>('agente_model_inputs', { provider, model })
      .then((kinds) => { if (current) modelInputs = kinds; })
      .catch(() => { if (current) modelInputs = null; });
    return () => { current = false; };
  });
  const seenMedia = $derived(MEDIA_KINDS.filter((kind) => modelInputs?.includes(kind)));
  /** The eye is about vision: audio or video input is not a picture. */
  const vision = $derived(seenMedia.includes('image'));
  const mediaHint = $derived.by(() => {
    if (!seenMedia.length) return $t('code.media.textOnlyHint');
    const names = (kinds: readonly string[]) => kinds.map((kind) => $t(`code.project.settings.${kind}`)).join(', ');
    const auto = MEDIA_KINDS.filter((kind) => allowMedia.includes(kind));
    const sees = vision
      ? $t('code.media.sees', { values: { kinds: names(seenMedia) } })
      : $t('code.media.noVisionHint', { values: { kinds: names(seenMedia) } });
    return auto.length ? `${sees} · ${$t('code.media.autoAttach', { values: { kinds: names(auto) } })}` : sees;
  });
  /** What the icon opens, so the tooltip can name its destination. */
  const mediaLabel = $derived(`${mediaHint} — ${$t('code.cmd.settings.label')}`);

  /**
   * `allow_media` lives in Agent settings, so the bar has to re-read it when
   * that dialog closes — a mount-only read left the icon describing a policy
   * the user had already changed.
   */
  async function refreshSettings() {
    try {
      const settings = await invoke<{ allow_media: AttachmentKind[] }>('agente_runtime_settings');
      allowMedia = settings.allow_media;
    } catch {
      /* The daemon is not up yet; the bar keeps the last known policy. */
    }
  }
  $effect(() => { void refreshSettings(); });
  function offerMedia(items: Attachment[]) {
    const ready = items.filter((item) => item.kind === 'pdf' || allowMedia.includes(item.kind));
    attachments = [...attachments, ...ready.filter((item) => !attachments.some((existing) => existing.path === item.path))];
    pendingMedia = [...pendingMedia, ...items.filter((item) => !ready.includes(item))];
  }
  async function acceptMedia(always = false) {
    try {
      if (always) {
        const kinds = [...new Set([...allowMedia, ...pendingMedia.map((item) => item.kind)])];
        await invoke('agente_runtime_configure', { allow_media: kinds });
        allowMedia = kinds;
      }
      attachments = [...attachments, ...pendingMedia.filter((item) => !attachments.some((existing) => existing.path === item.path))];
      pendingMedia = [];
      focusComposer();
    } catch (error) { toastStore.error(String(error)); }
  }
  async function attachFiles(selected: File[]) {
    attaching = true;
    try {
      const imported: Attachment[] = [];
      for (const file of selected) {
        const result = await invoke<{ attachment: Attachment }>('agente_media_import', await mediaData(file));
        if (result.attachment) imported.push(result.attachment);
      }
      offerMedia(imported);
    } catch (error) { toastStore.error(String(error)); }
    finally { attaching = false; }
  }
  async function attachPath(path: string): Promise<boolean> {
    try {
      const { attachment } = await invoke<{ attachment: Attachment | null }>('agente_media_import', { path, project_dir: project?.rootPath });
      if (!attachment) return false;
      offerMedia([attachment]);
      return true;
    } catch (error) { toastStore.error(String(error)); return false; }
  }
  function onPaste(event: ClipboardEvent) {
    const selected = [...(event.clipboardData?.files || [])];
    if (selected.length) { event.preventDefault(); void attachFiles(selected); return; }
    const pasted = event.clipboardData?.getData('text/plain') || '';
    if (isMediaPath(pasted)) {
      event.preventDefault();
      const start = textarea?.selectionStart || 0;
      const end = textarea?.selectionEnd || 0;
      void attachPath(pasted).then((attached) => { if (!attached) text = text.slice(0, start) + pasted + text.slice(end); });
    }
  }

  async function submit() {
    const value = text.trim() || (attachments.length ? 'Please review the attached media.' : '');
    if (attaching) return;
    if (!value) { await codeStore.sendQueuedNow(chat.id, chat.pendingPrompts?.find((item) => !item.sending)?.id); return; }
    // "/compact" typed out and sent runs the command, it is not a message.
    const command = exactSlashCommand(commands, value);
    if (command) {
      await runCommand(command);
      return;
    }
    if (running) {
      const media = attachments;
      attachments = [];
      text = '';
      if (textarea) autoGrow(textarea);
      void codeStore.steer(chat.id, value, media);
      return;
    }
    if (!modelReady) return;
    const media = attachments;
    attachments = [];
    text = '';
    if (textarea) autoGrow(textarea);
    if (value.startsWith('!')) await codeStore.exec(chat.id, value.slice(1));
    else await codeStore.send(chat.id, value, media);
  }

  async function queueFollowUp() {
    const value = text.trim() || (attachments.length ? 'Please review the attached media.' : '');
    if (!value) return;
    if (!running && !modelReady) return;
    text = '';
    const media = attachments;
    attachments = [];
    if (textarea) autoGrow(textarea);
    if (running) codeStore.queue(chat.id, value, media);
    else await codeStore.send(chat.id, value, media);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowUp' && !text && !attachments.length && !event.isComposing) {
      const item = [...(chat.pendingPrompts ?? [])].reverse().find(item => !item.sending);
      if (item) {
        event.preventDefault();
        appStore.removeQueuedPrompt(chat.id, item.id);
        text = item.content; attachments = item.codeAttachments ?? [];
        void Promise.resolve().then(focusComposer);
        return;
      }
    }
    if (event.key === 'Backspace' && !text && attachments.length) { event.preventDefault(); attachments = attachments.slice(0, -1); return; }
    if (onFileKey(event)) return;
    if (onSlashKey(event)) return;
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      selectMode(runtimeMode === 'plan' ? 'supervised' : runtimeMode === 'supervised' ? 'full' : 'plan');
      return;
    }
    // Escape stops a live run (the shortcut help promises it).
    if (event.key === 'Escape' && running) {
      event.preventDefault();
      void codeStore.stop(chat.id);
      return;
    }
    // Shift+Enter is a newline, as the hint says; never submit mid-IME.
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (event.altKey) {
      void queueFollowUp();
      return;
    }
    void submit();
  }

  function scrollToApproval() {
    document.querySelector('[data-awaiting-approval="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function onInput(event: Event) {
    const element = event.currentTarget as HTMLTextAreaElement;
    text = element.value;
    caret = element.selectionStart;
    fileDismissed = false;
    slashDismissed = false;
    autoGrow(element);
  }

  // Re-point the engine session when the app-wide model selection changes
  // (ModelSwitcher writes app config; the agente runtime keeps its own copy).
  let lastAppliedModel = $state('');
  $effect(() => {
    const provider = ownProvider;
    const model = ownModel;
    const backend = ownBackend;
    const thinking = chat.reasoningLevel || undefined;
    const key = `${backend}:${provider}:${model}:${thinking || ''}`;
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
      model,
      thinking,
      chat.modelSelection ? { modelPath: chat.modelSelection.localModelPath, baseUrl: chat.modelSelection.localBaseUrl } : undefined
    ).catch((error) => toastStore.error(String(error)));
  });

  $effect(() => {
    const onFocusComposer = () => { if (appStore.currentChatId === chat.id) focusComposer(); };
    // Starter prompts fill the composer; they never send on their own.
    const onDraft = (event: Event) => {
      const detail = (event as CustomEvent<string | { chatId?: string; text?: string }>).detail;
      if ((typeof detail === 'object' ? detail.chatId : appStore.currentChatId) !== chat.id) return;
      text = typeof detail === 'string' ? detail : detail?.text ?? '';
      void Promise.resolve().then(focusComposer);
    };
    // The canvas panel hands over a rendered image plus the instruction that
    // describes it. Unlike a starter prompt it *appends*: whatever the user has
    // half-written stays, and both the text and the chips land together.
    const onAppend = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: string; text?: string; media?: Attachment[] }>).detail ?? {};
      if ((detail.chatId ?? appStore.currentChatId) !== chat.id) return;
      text = mergeDraft(text, String(detail.text ?? ''));
      const media = detail.media ?? [];
      if (media.length) attachments = [...attachments, ...media.filter((item) => !attachments.some((existing) => existing.path === item.path))];
      void Promise.resolve().then(focusComposer);
    };
    window.addEventListener('focus-composer', onFocusComposer);
    window.addEventListener('code-composer-draft', onDraft);
    window.addEventListener('code-composer-append', onAppend);
    return () => {
      window.removeEventListener('focus-composer', onFocusComposer);
      window.removeEventListener('code-composer-draft', onDraft);
      window.removeEventListener('code-composer-append', onAppend);
    };
  });

  $effect(() => {
    if (!textarea) return;
    void text;
    autoGrow(textarea);
  });
  $effect(() => {
    const id = chat.id;
    const draft = text;
    const media = attachments.map((item) => ({ ...item }));
    untrack(() => appStore.updateChatDraft(id, draft, media));
    const timer = setTimeout(() => appStore.persistDraft(id), 300);
    return () => clearTimeout(timer);
  });
  onDestroy(() => appStore.persist());
</script>

{#if dialog && (project || !PROJECT_SECTIONS.includes(dialog))}<CodeProjectDialog chatId={chat.id} projectRoot={project?.rootPath} section={dialog} onclose={() => { dialog = null; void refreshSettings(); }} />{/if}
{#if pendingMedia.length}
  <Dialog title={$t('code.media.title')} onclose={() => (pendingMedia = [])} size="sm">
    <div class="space-y-3 p-4 text-sm"><p class="text-muted-foreground">{$t('code.media.question')}</p>{#each pendingMedia as media, index (index)}<p class="truncate">{media.name} · {media.kind}</p>{/each}
      <div class="flex gap-2"><Button size="sm" onclick={() => acceptMedia()}>{$t('code.media.attach')}</Button><Button size="sm" variant="ghost" onclick={() => acceptMedia(true)}>{$t('code.media.always')}</Button></div>
    </div>
  </Dialog>
{/if}

<div class="composer-dock relative z-20 w-full shrink-0 px-3 pb-2 pt-2 md:px-6 md:pb-3" role="region" aria-label={$t('code.composerRegion')}>
  <div class="composer-frame mx-auto w-full" style="max-width: var(--thread-width);">
    {#if awaitingApproval}
      <Button variant="plain" type="button" class={uiClass("approval-pill mb-2 flex self-start items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium", "ui-local-49e9c79c")} onclick={scrollToApproval}>
        <ShieldCheck class="size-3.5" />
        {$t('code.awaitingApproval')}
      </Button>
    {/if}
    {#if fileOpen}
      <div class="slash-menu" role="listbox" aria-label={$t('code.projectFiles')}>
        {#each fileMatches as file, index (file)}
          <Button variant="plain" type="button" role="option" aria-selected={index === fileIndex} class={uiClass("slash-item", "ui-local-49e9c79c", {"is-active": index === fileIndex})}  onmouseenter={() => (fileIndex = index)} onmousedown={(event) => event.preventDefault()} onclick={() => chooseFile(file)}><FileIcon class="size-4 shrink-0 text-muted-foreground" /><span class="truncate text-xs">{file}</span></Button>
        {/each}
      </div>
    {:else if slashOpen}
      <div class="slash-menu" role="listbox" aria-label={$t('code.slash.title')}>
        {#each slashMatches as command, index (command.name)}
          {@const Icon = command.icon}
          <Button variant="plain"
            type="button"
            role="option"
            aria-selected={index === slashIndex}
            aria-disabled={command.disabled}
            class={uiClass("slash-item", "ui-local-49e9c79c", {"is-active": index === slashIndex, "is-disabled": command.disabled})}


            onmouseenter={() => (slashIndex = index)}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => void runCommand(command)}
          >
            <Icon class="size-4 shrink-0 text-muted-foreground" />
            <span class="text-[13px] text-foreground">/{command.name}</span>
            <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{command.hint}</span>
          </Button>
        {/each}
      </div>
    {/if}
    {#if chat.pendingPrompts?.length}
      <PromptQueue items={chat.pendingPrompts} onupdate={(id, content) => appStore.updateQueuedPrompt(chat.id, id, content)} onremove={(id) => { appStore.removeQueuedPrompt(chat.id, id); }} onsend={(id) => void codeStore.sendQueuedNow(chat.id, id)} />
    {/if}
    {#if todos.length}<TodoDock {todos} running={running && !run?.stopping && !!run?.todosUpdated} />{/if}
    <div class="composer-shell ui-composer pointer-events-auto transition">
      <div class="composer-body">
        {#if attachments.length}
          <div class="mb-2 flex flex-wrap gap-1.5">
            {#each attachments as media (media.path)}<MediaAttachmentCard attachment={media} onremove={() => attachments = attachments.filter(item => item.path !== media.path)} />{/each}
          </div>
        {/if}
        <UiTextarea variant="composer"
          bind:ref={textarea}
          class={uiClass("composer-textarea w-full resize-none bg-transparent text-foreground outline-none", "ui-local-49e9c79c")}
          {placeholder}
          rows={1}
          value={text}
          oninput={onInput}
          onkeydown={onKeydown}
          onpaste={onPaste}
          ondragover={(event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); }}
          ondrop={(event) => { const selected = [...(event.dataTransfer?.files || [])]; if (selected.length) { event.preventDefault(); void attachFiles(selected); } }}
          onselect={() => { if (textarea) caret = textarea.selectionStart; }}
        ></UiTextarea>

        <div class="composer-bar is-compact">
          <div class="composer-bar-leading">
            <UiFileInput bind:ref={mediaPicker}  class={uiClass("hidden", "ui-local-49e9c79c")} accept={MEDIA_ACCEPT} multiple onchange={(event) => { void attachFiles([...((event.currentTarget as HTMLInputElement).files || [])]); event.currentTarget.value = ''; }} />
            <Tooltip label={$t('code.attach')} position="top">
              <UiIconButton label={$t('code.attach')} size="xs" type="button" class={uiClass("", "ui-local-49e9c79c")}  disabled={attaching} onclick={() => mediaPicker?.click()}><Plus class="size-3.5" /></UiIconButton>
            </Tooltip>

<div class="model-slot"><ModelSwitcher compact {chat} /></div>
        {#if ownBackend === 'local'}
          <Tooltip label={copy.model.browseAll} position="top"><UiIconButton label={copy.model.browseAll} size="xs" type="button" class={uiClass(" local-model-library", "ui-local-49e9c79c")}  onclick={()=>appStore.openSettings('explore')}><ArrowDownToLine class="size-3" /></UiIconButton></Tooltip>
        {:else if !modelReady}
          <Tooltip label={copy.model.configureProvider} position="top"><UiIconButton label={copy.model.configureProvider} size="xs" type="button" class={uiClass(" provider-setup", "ui-local-49e9c79c")}  onclick={()=>appStore.openSettings('providers')}><Settings2 class="size-3" /></UiIconButton></Tooltip>
        {/if}
        <div class="composer-meta-item is-reasoning"><ReasoningLevelSelector inline capabilities={ownThinking} value={chat.reasoningLevel} onchange={setThinking} /></div>

            <div class="composer-meta-item">
            <!-- Runtime mode gate — plan / supervised / full-auto. -->
            <Menu bind:open={modeMenuOpen} placement="top-start" minWidth="16rem" label={$t('code.modeSelector')} class="mode-menu">
              {#snippet trigger(props)}
                <Button variant="plain"
                  type="button"
                  class={uiClass("mode-trigger flex h-6 items-center gap-1 px-2 transition", "ui-local-49e9c79c", {"is-open": modeMenuOpen})}

                  aria-label={$t('code.modeSelector')}
                  title={activeMode.hint}
                  {...props}
                >
                  <ModeIcon class="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                  <span class="trigger-label truncate">{activeMode.label}</span>
                  <ChevronDown class={`mode-chevron h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150${modeMenuOpen ? ' rotate-180' : ''}`} />
                </Button>
              {/snippet}
              {#each modes as mode (mode.id)}
                {@const selected = mode.id === runtimeMode}
                <MenuItem class="mode-option" icon={mode.icon} label={mode.label} description={mode.hint} active={selected} onselect={() => selectMode(mode.id)} />
              {/each}
            </Menu>
            </div>

          </div>

          <div class="composer-bar-trailing">
            {#if modelReady && canContinue && !text.trim()}
              <!-- The run stopped short: one click picks the work back up. -->
              <Tooltip label={$t('code.continue')} position="top">
                <Button variant="plain" type="button" class={uiClass("composer-chip", "ui-local-49e9c79c")} onclick={() => void codeStore.followUp(chat.id, $t('code.continuePrompt'))}>
                  <Play class="size-3.5" />
                  {$t('code.continue')}
                </Button>
              </Tooltip>
            {/if}

            <Menu bind:open={toolsMenuOpen} placement="top-end" minWidth="14rem" label={$t('code.toolsMenu')}>
              {#snippet trigger(props)}<Tooltip label={$t('code.toolsMenu')} position="top"><UiIconButton label={$t('code.toolsMenu')} size="xs" type="button" class={uiClass("", "ui-local-49e9c79c")}  {...props}><MoreHorizontal class="size-3.5" /></UiIconButton></Tooltip>{/snippet}
              {#each menuGroups as group, index (index)}
                {#if index > 0}<div class="ui-menu-separator" role="separator"></div>{/if}
                {#each group as command (command.name)}<MenuItem icon={command.icon} label={command.label} disabled={command.disabled} onselect={() => void runCommand(command)} />{/each}
              {/each}
            </Menu>

            <SendButton compact stopShortcut="escape"
              {running}
              disabled={!canSend}
              sendLabel={$t('code.send')}
              stopLabel={$t('code.stop')}
              onsend={() => void submit()}
              onstop={() => void codeStore.stop(chat.id)}
            />
          </div>
        </div>
      </div>
    </div>

    <div class="composer-secondary">
      {#if project}<span class="composer-checkout" title={project.rootPath}><Folder class="size-3" /><span>{project.rootName}</span></span>{/if}
      <div class="composer-secondary-status">            {#if running && queuedCount > 0}<span class="queued-status" role="status">{$t('code.queued', { values: { n: queuedCount } })}</span>{/if}
            {#if modelReady && modelInputs}
              <!-- Capability and policy in one glyph: what the model sees, and
                   the door to the toggles that decide what gets attached. -->
              <Tooltip label={mediaLabel} position="top">
                <Button variant="plain" type="button" class={uiClass("media-status", "ui-local-49e9c79c")} aria-label={mediaLabel} onclick={() => (dialog = 'settings')}>
                  {#if vision}<Eye class="size-3.5" />{:else}<EyeOff class="size-3.5" />{$t('code.media.textOnly')}{/if}
                </Button>
              </Tooltip>
            {/if}
            {#if showContextRing && usage}<ContextUsageRing showLabel usedTokens={usage.promptTokens} maxTokens={usage.contextWindow ?? 0} {spend} />{/if}

</div>
    </div>

    <p class="composer-hint sr-only mx-auto mt-[var(--dock-gap)] px-1 text-center text-xs text-muted-foreground opacity-70">
      {#if hint}
        {hint}
      {/if}
    </p>
  </div>
</div>

<style>
  .composer-bar {min-height:1.75rem;}
  /* The labelled context ring keeps its own width; squeezing it to an icon
     slot spilled the ring over the media glyph beside it. */

  .composer-bar :global(.model-trigger), .composer-bar :global(.thinking-trigger) {height:1.5rem;font-size:var(--text-xs);}


  :global(.approval-pill.ui-local-49e9c79c) {
    border: 1px solid color-mix(in srgb, var(--warning, #d97706) 45%, transparent);
    background: color-mix(in srgb, var(--warning, #d97706) 12%, var(--background));
    color: var(--foreground);
  }
  .composer-dock {
    background: var(--chat-bg);
  }
  /* Fade the transcript out into the dock rather than cutting it off. One
     `--dock-gap` deep, matching the padding the transcript keeps under its last
     row, so the fade never reaches a line of text. */
  .composer-dock::before {
    content: '';
    position: absolute;
    inset-inline: 0;
    top: calc(-1 * var(--dock-gap, 8px));
    height: var(--dock-gap, 8px);
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
    min-width: 0;
  }
  .model-slot {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 18rem;
  }
  .queued-status { color: var(--muted-foreground); font-size: var(--text-xs); white-space: nowrap; }
  /* One muted base for both states: "Text only" is a quiet note, not the
     brightest thing on the bar. */
  :global(.media-status.ui-local-49e9c79c) {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: 9999px;
    padding: 0.25rem 0.375rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    white-space: nowrap;
    transition: background-color 120ms ease, color 120ms ease;
  }
  :global(.media-status:hover.ui-local-49e9c79c) { background: var(--surface-hover); color: var(--foreground); }
  .slash-menu {
    max-height: min(20rem, 40vh);
    overflow-y: auto;
    margin-bottom: 0.5rem;
    padding: var(--float-pad);
    border: 1px solid var(--float-border);
    border-radius: var(--float-radius);
    background: var(--float-bg);
    box-shadow: var(--float-shadow);
  }
  :global(.slash-item.ui-local-49e9c79c) {
    display: flex;
    width: 100%;
    min-height: var(--float-row-h);
    align-items: center;
    gap: 0.625rem;
    padding: 0.3125rem 0.625rem;
    border-radius: var(--float-row-radius);
    font-size: var(--text-sm);
    text-align: left;
  }
  :global(.slash-item:hover.ui-local-49e9c79c),
  :global(.slash-item.is-active.ui-local-49e9c79c) {
    background: var(--float-row-hover);
  }
  :global(.slash-item.is-disabled.ui-local-49e9c79c) {
    opacity: 0.45;
    cursor: default;
  }
  /* Compact rectangle: clear edges, quiet depth, no pill or glyph motion. */
  :global(.mode-menu) {width:16rem;max-width:calc(100vw - 1.5rem);}
  :global(.mode-menu .mode-option) {padding:0.4375rem 0.625rem;}
  :global(.mode-menu :is(.mode-option.is-active, :global(.mode-option.is-active.ui-local-49e9c79c))) {background:var(--float-row-selected);}
  :global(.mode-menu .ui-menu-item-hint) {white-space:normal;overflow-wrap:anywhere;}
  :global(.mode-menu .ui-menu-check) {color:var(--brand-accent-strong);}
  :global(.mode-trigger.ui-local-49e9c79c) {color:var(--text-secondary);min-width:0;max-width:9rem;background:var(--control-bg);border:1px solid var(--border);border-radius:var(--radius-sm);box-shadow:var(--control-inset);transition:background-color var(--motion-fast),border-color var(--motion-fast),color var(--motion-fast);}
  :global(.mode-trigger:hover.ui-local-49e9c79c),:global(.mode-trigger.is-open.ui-local-49e9c79c) {background:var(--float-row-hover);border-color:var(--border-hover);color:var(--foreground);}
  :global(.mode-trigger:focus-visible.ui-local-49e9c79c) {outline:2px solid var(--brand-accent);outline-offset:2px;}
  :global(.mode-trigger.ui-local-49e9c79c) .trigger-label {
    color: inherit;
    font-size: var(--text-xs);
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  :global(.mode-trigger.ui-local-49e9c79c) {flex-shrink:0;}
  @container composer (max-width:480px) {
    :global(.mode-trigger.ui-local-49e9c79c) .trigger-label, :global(.mode-trigger.ui-local-49e9c79c) :global(.mode-chevron) {display:none;}
    :global(.mode-trigger.ui-local-49e9c79c) {padding-inline:0.375rem;}
    .model-slot {flex:1 1 auto;max-width:none;}
  }

</style>
