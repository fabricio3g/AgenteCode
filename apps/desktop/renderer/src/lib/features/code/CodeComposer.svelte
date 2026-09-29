<svelte:options runes={true} />

<!--
  The Code composer: the same shell as Home's composer (aui-composer pill,
  two-row body, dock fade) so both spaces read as one product.

  Grammar follows the same bar split — scope on the left (runtime-mode gate),
  brain on the right (model), and a send control that only exists when there
  is something shippable. While a run is active the bar switches to steering:
  Enter course-corrects, Alt+Enter queues a follow-up, the button stops.
-->

<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { Archive, ArrowDownToLine, ArrowUp, Bot, Check, ChevronDown, ClipboardList, File as FileIcon, FileDown, GitCompareArrows, MessageSquarePlus, MoreHorizontal, Paperclip, Play, Plug, RotateCcw, RotateCw, Settings2, ShieldCheck, Sparkles, Square, SquareTerminal, X, Zap } from 'lucide-svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { codeWorkspace } from './workspace.svelte';
  import { exactSlashCommand, matchSlashCommands, slashQuery, type SlashCommand } from './slash-commands';
  import { t } from 'svelte-i18n';
  import type { ChatSession } from '$lib/types/chat';
  import { appStore } from '$lib/stores/app.svelte';
  import ModelSwitcher from '$lib/features/chat/ModelSwitcher.svelte';
  import ContextUsageRing from '$lib/features/chat/composer/ContextUsageRing.svelte';
  import { codeStore } from './code.svelte';
  import { codeEdits, initProject, projectFiles, setAgenteModel } from './code-ipc';
  import CodeProjectDialog from './CodeProjectDialog.svelte';
  import { conversationSpend, spendLabel } from './accounting';
  import { fileMentionAt, insertFile, matchFiles } from './file-mention';
  import { downloadSessionMarkdown } from '$lib/features/shared/export-session';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { Button, Dialog } from '$lib/components/ui';
  import { invoke } from '$lib/services/bridge';
  import type { Attachment, AttachmentKind } from '$shared/agente-protocol.gen';
  import { MEDIA_ACCEPT, isMediaPath, mediaData } from './code-media';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { copy } from '$lib/copy';
  import { MAX_COMPOSER_TEXTAREA_PX, autogrowTextarea } from '$lib/features/shared/composer-autogrow';

  let { chat }: { chat: ChatSession } = $props();

  /** Textarea grows with content up to this height, then scrolls (Home parity). */
  const MAX_TEXTAREA_PX = MAX_COMPOSER_TEXTAREA_PX;

  let textarea = $state<HTMLTextAreaElement | undefined>(undefined);
  let text = $state(untrack(() => chat.draft || ''));
  let modeMenuOpen = $state(false);
  let toolsMenuOpen = $state(false);
  let dialog = $state<'skills' | 'agents' | 'mcp' | 'sessions' | 'settings' | null>(null);
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
  const runtimeMode = $derived(chat.codeAgent?.runtimeMode ?? codeStore.defaultMode);
  // Honest model visibility: without a usable model the bar says so instead
  // of letting a send die inside the provider.
  const modelReady = $derived(codeStore.modelReady);
  const canSend = $derived((!!text.trim() || attachments.length > 0) && !attaching && (modelReady || running));
  // Real accounting from the engine: promptTokens of the last call is the
  // context footprint. Hidden until the first report, like Home's ring.
  const usage = $derived(run?.usage ?? [...chat.messages].reverse().find((message) => message.metadata?.codeUsage)?.metadata?.codeUsage);
  const showContextRing = $derived(!!usage && usage.promptTokens > 0 && (usage.contextWindow ?? 0) > 0);
  const accountingLabel = $derived(spendLabel(conversationSpend(chat.messages, run ?? undefined)));
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
    appStore.modelManagerOpenSection = 'models';
    appStore.modelManagerOpen = true;
  }

  const placeholder = $derived(
    running
      ? $t('code.steerPlaceholder')
      : !modelReady
        ? $t('code.selectModel')
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

  // ── Slash commands ───────────────────────────────────────────────────
  type Command = SlashCommand & { icon: typeof Archive; label: string; hint: string; disabled?: boolean; run: () => void | Promise<void> };

  const project = $derived(codeStore.projectById(chat.projectId ?? null));
  const commands = $derived<Command[]>([
    {
      name: 'compact', icon: Archive, label: $t('code.slash.compact'), hint: $t('code.compactHint'),
      // Session state is not reactive; check it when the command runs.
      disabled: running,
      run: async () => {
        if (!codeStore.hasSession(chat.id)) {
          toastStore.info($t('code.slash.nothingToCompact'));
          return;
        }
        const result = await codeStore.compact(chat.id);
        if (result.ok) toastStore.success($t('code.slash.compacted'));
        else toastStore.error($t('code.compactFailed', { values: { error: result.error ?? '' } }));
      }
    },
    { name: 'new', aliases: ['tab'], icon: MessageSquarePlus, label: $t('code.newConversation'), hint: $t('code.slash.newHint'), disabled: !project, run: () => { if (project) codeStore.newConversation(project); } },
    { name: 'plan', icon: ClipboardList, label: $t('code.modePlan'), hint: $t('code.modePlanHint'), run: () => selectMode('plan') },
    { name: 'supervised', aliases: ['build'], icon: ShieldCheck, label: $t('code.modeSupervised'), hint: $t('code.modeSupervisedHint'), run: () => selectMode('supervised') },
    { name: 'full', aliases: ['auto'], icon: Zap, label: $t('code.modeFull'), hint: $t('code.modeFullHint'), run: () => selectMode('full') },
    { name: 'changes', icon: GitCompareArrows, label: $t('codeWs.changes'), hint: $t('code.slash.changesHint'), run: () => codeWorkspace.toggleChanges(true) },
    {
      name: 'terminal', icon: SquareTerminal, label: $t('codeWs.terminal'), hint: $t('code.slash.terminalHint'), disabled: !project,
      run: async () => {
        if (!project) return;
        try {
          await codeWorkspace.toggleBottom('terminal', project.rootPath);
        } catch (error) {
          toastStore.error($t('codeWs.terminalFailed', { values: { reason: (error as Error).message } }));
        }
      }
    },
    { name: 'skills', icon: Sparkles, label: 'Skills', hint: 'Project skills and custom commands', run: () => { dialog = 'skills'; } },
    { name: 'subagents', aliases: ['agents', 'subagent-models'], icon: Bot, label: 'Subagents', hint: 'Live work, output and model overrides', run: () => { dialog = 'agents'; } },
    { name: 'mcp', icon: Plug, label: 'MCP servers', hint: 'Tool server status and connections', run: () => { dialog = 'mcp'; } },
    { name: 'settings', icon: Settings2, label: 'Agent settings', hint: 'Compaction and parallel subagents', run: () => { dialog = 'settings'; } },
    { name: 'session', aliases: ['resume', 'sessions'], icon: MessageSquarePlus, label: 'Resume session', hint: 'Open a saved Rust session', run: () => { dialog = 'sessions'; } },
    { name: 'undo', icon: RotateCcw, label: 'Undo edits', hint: 'Restore the previous file contents', disabled: running, run: () => editFiles('undo') },
    { name: 'redo', icon: RotateCw, label: 'Redo edits', hint: 'Reapply the undone file changes', disabled: running, run: () => editFiles('redo') },
    { name: 'init', icon: FileIcon, label: 'Initialize project', hint: 'Create AGENTS.md and agent folders', disabled: !project,
      run: async () => { if (project) toastStore.info((await initProject(project.rootPath)).message); } },
    { name: 'export', icon: FileDown, label: 'Export conversation', hint: 'Download conversation and tool history as Markdown', run: () => downloadSessionMarkdown(chat) },
    { name: 'model', aliases: ['provider', 'refresh-models'], icon: Sparkles, label: 'Choose model', hint: 'Open the desktop model hub', run: openModelHub },
    { name: 'project', icon: FileIcon, label: 'Open project', hint: 'Choose a working folder', run: async () => { const selected = await codeStore.addProject(); if (selected) codeStore.newConversation(selected); } },
    { name: 'stop', icon: Square, label: 'Stop run', hint: 'Interrupt the running agent', disabled: !running, run: () => codeStore.stop(chat.id) },
    { name: 'mode', aliases: ['approve'], icon: ShieldCheck, label: 'Change mode', hint: 'Cycle plan, build and auto', run: () => selectMode(runtimeMode === 'plan' ? 'supervised' : runtimeMode === 'supervised' ? 'full' : 'plan') },
    { name: 'theme', icon: Settings2, label: 'Toggle theme', hint: 'Switch dark and light', run: () => themeStore.toggle() },
    { name: 'help', aliases: ['hotkeys'], icon: MoreHorizontal, label: 'Commands', hint: 'Show the Code command menu', run: () => { toolsMenuOpen = true; } }
  ]);

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
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  $effect(() => {
    void invoke<{ allow_media: AttachmentKind[] }>('agente_runtime_settings').then((settings) => (allowMedia = settings.allow_media)).catch(() => {});
  });
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
    if (!value || attaching) return;
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
      await codeStore.steer(chat.id, value, media);
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
    await codeStore.followUp(chat.id, value, media);
  }

  function onKeydown(event: KeyboardEvent) {
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
    const provider = appStore.activeProviderName;
    const model = appStore.activeModelLabel;
    const backend = appStore.backendMode;
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
      backend === 'local' ? String(appStore.config.llm?.local?.model || '') : model,
      thinking
    ).catch(() => {});
  });

  $effect(() => {
    const onFocusComposer = () => focusComposer();
    // Starter prompts fill the composer; they never send on their own.
    const onDraft = (event: Event) => {
      text = String((event as CustomEvent<string>).detail ?? '');
      void Promise.resolve().then(focusComposer);
    };
    window.addEventListener('focus-composer', onFocusComposer);
    window.addEventListener('code-composer-draft', onDraft);
    return () => {
      window.removeEventListener('focus-composer', onFocusComposer);
      window.removeEventListener('code-composer-draft', onDraft);
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
    const timer = setTimeout(() => appStore.persist(), 300);
    return () => clearTimeout(timer);
  });
  onDestroy(() => appStore.persist());
</script>

{#if dialog && project}<CodeProjectDialog chatId={chat.id} projectRoot={project.rootPath} section={dialog} onclose={() => (dialog = null)} />{/if}
{#if pendingMedia.length}
  <Dialog title="Attach media" onclose={() => (pendingMedia = [])} size="sm">
    <div class="space-y-3 p-4 text-sm"><p class="text-muted-foreground">Send these files to the selected model?</p>{#each pendingMedia as media, index (index)}<p class="truncate">{media.name} · {media.kind}</p>{/each}
      <div class="flex gap-2"><Button size="sm" onclick={() => acceptMedia()}>Attach</Button><Button size="sm" variant="ghost" onclick={() => acceptMedia(true)}>Always allow</Button></div>
    </div>
  </Dialog>
{/if}

<div class="composer-dock relative z-20 w-full shrink-0 px-3 pb-2 pt-2 md:px-6 md:pb-3" role="region" aria-label={$t('code.composerRegion')}>
  <div class="composer-frame mx-auto w-full" style="max-width: var(--thread-width);">
    {#if awaitingApproval}
      <button type="button" class="approval-pill mx-auto mb-2 flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium" onclick={scrollToApproval}>
        <ShieldCheck class="size-3.5" />
        {$t('code.awaitingApproval')}
      </button>
    {/if}
    {#if fileOpen}
      <div class="slash-menu" role="listbox" aria-label="Project files">
        {#each fileMatches as file, index (file)}
          <button type="button" role="option" aria-selected={index === fileIndex} class="slash-item" class:is-active={index === fileIndex} onmouseenter={() => (fileIndex = index)} onmousedown={(event) => event.preventDefault()} onclick={() => chooseFile(file)}><FileIcon class="size-4 shrink-0 text-muted-foreground" /><span class="truncate font-mono text-xs">{file}</span></button>
        {/each}
      </div>
    {:else if slashOpen}
      <div class="slash-menu" role="listbox" aria-label={$t('code.slash.title')}>
        {#each slashMatches as command, index (command.name)}
          {@const Icon = command.icon}
          <button
            type="button"
            role="option"
            aria-selected={index === slashIndex}
            aria-disabled={command.disabled}
            class="slash-item"
            class:is-active={index === slashIndex}
            class:is-disabled={command.disabled}
            onmouseenter={() => (slashIndex = index)}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => void runCommand(command)}
          >
            <Icon class="size-4 shrink-0 text-muted-foreground" />
            <span class="font-mono text-[12.5px] text-foreground">/{command.name}</span>
            <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{command.hint}</span>
          </button>
        {/each}
        <p class="slash-foot">{$t('code.slash.keys')}</p>
      </div>
    {/if}
    <div class="composer-shell aui-composer pointer-events-auto transition">
      <div class="composer-body">
        {#if attachments.length}
          <div class="mb-2 flex flex-wrap gap-1.5">
            {#each attachments as media, index (index)}<span class="flex max-w-64 items-center gap-1.5 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground"><Paperclip class="size-3" /><span class="truncate">{media.name}</span><button type="button" aria-label={`Remove ${media.name}`} onclick={() => (attachments = attachments.filter((_, i) => i !== index))}><X class="size-3" /></button></span>{/each}
          </div>
        {/if}
        <textarea
          bind:this={textarea}
          class="composer-textarea w-full resize-none bg-transparent text-foreground outline-none"
          {placeholder}
          rows="1"
          value={text}
          oninput={onInput}
          onkeydown={onKeydown}
          onpaste={onPaste}
          ondragover={(event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); }}
          ondrop={(event) => { const selected = [...(event.dataTransfer?.files || [])]; if (selected.length) { event.preventDefault(); void attachFiles(selected); } }}
          onselect={() => { if (textarea) caret = textarea.selectionStart; }}
        ></textarea>

        <div class="composer-actions">
          <div class="composer-selectors">
          <!-- Runtime mode gate — plan / supervised / full-auto. Scope lives on
               the left of the bar; the model picker answers on the right. -->
          <Menu bind:open={modeMenuOpen} placement="top-start" minWidth="20rem" label={$t('code.modeSelector')} class="p-1.5">
            {#snippet trigger(props)}
              <button
                type="button"
                class="mode-trigger flex h-8 items-center gap-1.5 px-2.5 transition"
                class:is-open={modeMenuOpen}
                aria-label={$t('code.modeSelector')}
                title={activeMode.hint}
                {...props}
              >
                <ModeIcon class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                <span class="trigger-label truncate">{activeMode.label}</span>
                <ChevronDown class={`h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150${modeMenuOpen ? ' rotate-180' : ''}`} />
              </button>
            {/snippet}
            <p class="px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">{$t('code.modeTitle')}</p>
            {#each modes as mode (mode.id)}
              {@const selected = mode.id === runtimeMode}
              <MenuItem class="mode-option !items-center !gap-3 !px-3 !py-2 {selected ? '!bg-[var(--surface-active)]' : ''}" onselect={() => selectMode(mode.id)}>
                <span class="min-w-0 flex-1">
                  <span class="block text-[13px] font-medium text-foreground">{mode.label}</span>
                  <span class="block text-[11.5px] leading-snug text-muted-foreground">{mode.hint}</span>
                </span>
                <Check class="size-4 shrink-0 text-foreground {selected ? '' : 'invisible'}" />
              </MenuItem>
            {/each}
          </Menu>

          <div class="model-slot"><ModelSwitcher compact showReasoning /></div>
          </div>

          {#if accountingLabel || showContextRing || (running && queuedCount > 0)}
            <div class="composer-accounting">
              {#if accountingLabel}<span class="spend-label" title="Conversation spend and reported prompt cache rate">{accountingLabel}</span>{/if}
              {#if running && queuedCount > 0}<span class="queue-label" role="status">{$t('code.queued', { values: { n: queuedCount } })}</span>{/if}
              {#if showContextRing && usage}
                <ContextUsageRing usedTokens={usage.promptTokens} maxTokens={usage.contextWindow ?? 0} />
              {/if}
            </div>
          {/if}

          <div class="trailing">
          <input bind:this={mediaPicker} type="file" class="hidden" accept={MEDIA_ACCEPT} multiple onchange={(event) => { void attachFiles([...((event.currentTarget as HTMLInputElement).files || [])]); event.currentTarget.value = ''; }} />
          <button type="button" class="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Attach media" disabled={attaching} onclick={() => mediaPicker?.click()}><Paperclip class="size-4" /></button>

          <Menu bind:open={toolsMenuOpen} placement="top-end" label="Code tools">
            {#snippet trigger(props)}<button type="button" class="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Code tools" {...props}><MoreHorizontal class="size-4" /></button>{/snippet}
            {#each commands as command (command.name)}<MenuItem icon={command.icon} label={command.label} description={command.hint} disabled={command.disabled} onselect={() => void runCommand(command)} />{/each}
          </Menu>

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
                title={$t('code.selectModel')}
              >
                <ArrowDownToLine class="size-3.5" />
                {copy.model.browseAll}
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
  .approval-pill {
    border: 1px solid color-mix(in srgb, var(--warning, #d97706) 45%, transparent);
    background: color-mix(in srgb, var(--warning, #d97706) 12%, var(--background));
    color: var(--foreground);
  }

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
    container: code-composer / inline-size;
    min-width: 0;
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
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 0.375rem;
    min-height: 2rem;
  }

  .composer-selectors {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
  }

  .model-slot {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 18rem;
  }

  .composer-accounting {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    min-width: 0;
    color: var(--muted-foreground);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .spend-label,
  .queue-label { white-space: nowrap; }

  .trailing { grid-column: 3; }

  @container code-composer (max-width: 560px) {
    .composer-actions { grid-template-columns: minmax(0, 1fr) auto; }
    .trailing { grid-column: 2; grid-row: 1; }
    .composer-accounting {
      grid-row: 2;
      grid-column: 1 / -1;
      justify-content: flex-start;
      flex-wrap: wrap;
      gap: 0.25rem 0.5rem;
    }
    .composer-accounting :global(.context-ring) { width: 1.5rem; height: 1.5rem; margin-left: auto; }
    .mode-trigger { padding-inline: 0.375rem; }
    .mode-trigger :global(svg:first-child) { display: none; }
  }

  .slash-menu {
    max-height: min(20rem, 40vh);
    overflow-y: auto;
    margin-bottom: 0.5rem;
    padding: 0.25rem;
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    background: var(--popover, var(--background));
    box-shadow: var(--shadow-lg);
  }
  .slash-item {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.625rem;
    padding: 0.4375rem 0.625rem;
    border-radius: 0.625rem;
    text-align: left;
  }
  .slash-item.is-active {
    background: var(--surface-active);
  }
  .slash-item.is-disabled {
    opacity: 0.45;
    cursor: default;
  }
  .slash-foot {
    padding: 0.375rem 0.625rem 0.25rem;
    font-size: 11px;
    color: var(--muted-foreground);
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
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-full);
    box-shadow: none;
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .mode-trigger:hover,
  .mode-trigger.is-open {
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
    background: var(--surface-active);
    color: var(--foreground);
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
