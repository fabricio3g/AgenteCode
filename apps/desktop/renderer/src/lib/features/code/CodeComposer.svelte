<svelte:options runes={true} />

<!--
  The Code composer: the same shell as Home's composer (ui-composer pill,
  two-row body, dock fade) so both spaces read as one product.

  Grammar follows the same bar split — scope on the left (runtime-mode gate),
  brain on the right (model), and a send control that only exists when there
  is something shippable. While a run is active the bar switches to steering:
  Enter course-corrects, Tab (or Alt+Enter) queues a follow-up, the button stops.
-->

<script lang="ts">
  import UiFileInput from '$lib/components/ui/FileInput.svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onDestroy, tick, untrack } from 'svelte';
  import { ChevronDown, ClipboardList, Cpu, Eye, EyeOff, File as FileIcon, LoaderCircle, Play, RefreshCw, ShieldCheck, Settings2, Target, Wrench, Zap } from '$lib/icons';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { userInputsStore } from '$lib/stores/user-inputs.svelte';
  import { codeWorkspace } from './workspace.svelte';
  import { exactSlashCommand, matchSlashCommands, slashQuery } from '$lib/features/shared/composer/slash-commands';
  import ComposerPicker from '$lib/features/shared/composer/ComposerPicker.svelte';
  import { codeCommands, type CodeCommand, type CodeDialog } from './code-commands';
  import { t } from 'svelte-i18n';
  import type { ChatSession, ReasoningLevel } from '$lib/types/chat';
  import { appStore } from '$lib/stores/app.svelte';
  import { isConfigModelReady } from '$lib/stores/chat-model';
  import { fetchReasoningCapabilities } from '$lib/services/chat-api';
  import { isElectron } from '$lib/services/bridge';
  import { ThinkingCapabilitiesController } from '$lib/stores/models/thinking-capabilities.svelte';
  import ModelMenu from '$lib/features/chat/model-menu/ModelMenu.svelte';
  import ComposerBar from '$lib/features/chat/composer/ComposerBar.svelte';
  import GenerationSpeed from '$lib/features/shared/composer/GenerationSpeed.svelte';
  import { latestGenerationSpeed } from '$lib/utils/generation-speed';
  import ContextUsageRing from '$lib/features/chat/composer/ContextUsageRing.svelte';
  import { conversationScope } from '$shared/workspace-scope';
  import { workspaceLayout } from '$lib/stores/workspace-layout.svelte';
  import { codeStore } from './code.svelte';
  import { clampModeForDriver, driverReadiness, driversStore, isExternalDriverId, supportedModesFor } from './drivers.svelte';
  import { initProject, projectFiles, setAgenteModel } from './code-ipc';
  import { restoreCodeEdits } from './code-edits';
  import CodeProjectDialog from './CodeProjectDialog.svelte';
  import CodeAttachmentShelf from './CodeAttachmentShelf.svelte';
  import DriverSelector from './DriverSelector.svelte';
  import ProjectSelector from './ProjectSelector.svelte';
  import PromptQueue from '$lib/features/shared/PromptQueue.svelte';
  import SessionGoal from '$lib/features/shared/SessionGoal.svelte';
  import { parseGoalCommand, type GoalCommand } from '$shared/session-goal';
  import { conversationSpend } from './accounting';
  import { fileMentionAt, insertFile, matchFiles } from './file-mention';
  import { downloadSessionMarkdown } from '$lib/features/shared/export-session';
  import { Button, Dialog, Switch } from '$lib/components/ui';
  import { swarmStore } from './swarm.svelte';
  import { invoke } from '$lib/services/bridge';
  import type { Attachment, AttachmentKind } from '$shared/agente-protocol.gen';
  import { isMediaPath, mediaData } from './code-media';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import ComposerGlyph from '$lib/features/shared/composer/ComposerGlyph.svelte';
  import DictationButton from '$lib/features/chat/composer/DictationButton.svelte';
  import MicBars from '$lib/features/shared/composer/MicBars.svelte';
  import ComposerShell from '$lib/features/shared/composer/ComposerShell.svelte';
  import { dictationSlotFor, handleApprovalKey, handlePickerKey, recallLastQueuedPrompt } from '$lib/features/shared/composer/composer-shared';
  import { Dictation } from '$lib/features/chat/composer/use-dictation.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { copy } from '$lib/copy';
  import { autogrowTextarea } from '$lib/features/shared/composer-autogrow';
  import { mergeDraft } from '$lib/features/canvas/canvas-doc';

  let { chat }: { chat: ChatSession } = $props();
  let goalControl = $state<{ command: (value: GoalCommand) => Promise<void> }>();

  function ensureGoalSession(): string {
    chat.codeAgent ??= { instanceId: 'agente', driverKind: 'agente', substrate: 'native', updatedAt: Date.now() };
    chat.codeAgent.sessionId ??= crypto.randomUUID();
    appStore.markChatDirty(chat.id);
    appStore.persist();
    return chat.codeAgent.sessionId;
  }

  async function insertGoalCommand() {
    text = `/goal ${text}`;
    await tick();
    textarea?.focus();
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  let textarea = $state<HTMLTextAreaElement | undefined>(undefined);
  let text = $state(untrack(() => chat.draft || ''));
  /**
   * Past one row: the send square belongs at the bottom edge, beside the last
   * line, rather than in the middle of a tall field.
   */
  let grown = $state(false);
  const dictation = new Dictation((addition) => { text = text.trimEnd() ? `${text.trimEnd()} ${addition}` : addition; });
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
  /**
   * A starter whose prompt is only the start of a sentence leaves a blank to
   * fill. The chip sits above the composer while the draft is still exactly
   * that prefix, and leaves the moment the user types the subject.
   */
  let starterSlot = $state<string | null>(null);
  let starterPrefix = $state('');
  /** The starter under the pointer, shown in the empty field as a preview. */
  let previewText = $state('');

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
  const instanceId = $derived(chat.codeAgent?.instanceId || 'agente');
  const isExternal = $derived(isExternalDriverId(instanceId));
  const activeDriver = $derived(driversStore.byId(instanceId));
  const ownModelReady = $derived(isConfigModelReady(ownConfig, appStore.localModelActive));
  const driverReadyInfo = $derived(driverReadiness(activeDriver, ownModelReady, instanceId));
  const allowedModes = $derived(supportedModesFor(activeDriver));
  const runtimeMode = $derived(clampModeForDriver(chat.codeAgent?.runtimeMode ?? codeStore.defaultMode, activeDriver));
  const driverCanSteer = $derived(!isExternal || (activeDriver?.capabilities.steer ?? true));
  const driverCanAttach = $derived(!isExternal || ((activeDriver?.capabilities.attachments?.length ?? 0) > 0));
  const driverCanCompact = $derived(!isExternal || (activeDriver?.capabilities.compact ?? false));
  const driverModels = $derived(activeDriver?.models ?? []);
  const selectedDriverModel = $derived(
    chat.codeAgent?.driverModel ??
    driverModels.find((item) => item.is_default)?.id ??
    driverModels[0]?.id ??
    null
  );
  const activeDriverModelObj = $derived(driverModels.find((item) => item.id === selectedDriverModel));
  const driverThinkingLevels = $derived.by(() => {
    const specific = activeDriverModelObj?.thinking_levels ?? [];
    if (specific.length) return specific;
    if (!activeDriver?.capabilities.thinking) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const model of driverModels) {
      for (const lvl of model.thinking_levels ?? []) {
        if (!seen.has(lvl)) {
          seen.add(lvl);
          out.push(lvl);
        }
      }
    }
    return out;
  });
  const selectedDriverEffort = $derived(chat.codeAgent?.driverEffort ?? null);
  let driverModelMenuOpen = $state(false);
  $effect(() => {
    const currentId = instanceId;
    const status = activeDriver?.status;
    const hasModels = driverModels.length > 0;
    if (isExternal && status === 'ready' && !hasModels) {
      void untrack(() => driversStore.ensureProbed(currentId));
    }
  });
  // Honest model visibility: without a usable model or ready CLI the bar says
  // so instead of letting a send die inside the provider.
  const modelReady = $derived(driverReadyInfo.ready);
  const canSend = $derived((!!text.trim() || attachments.length > 0) && !attaching && (modelReady || running));
  /** Nothing typed and nothing attached: the send slot has no message to send. */
  const fieldEmpty = $derived(!text.trim() && attachments.length === 0 && !attaching);
  /** The send slot's microphone: the bar's own button, moved into the empty field's corner. */
  const slotDictation = $derived(dictationSlotFor({
    running,
    fieldEmpty,
    supported: dictation.supported,
    listening: dictation.listening,
    label: copy.composer.dictate,
    onToggle: () => dictation.toggle(false),
    glyph: listeningBars
  }));
  // Real accounting from the engine: promptTokens of the last call is the
  // context footprint. Hidden until the first report, like Home's ring.
  const usage = $derived(run?.usage ?? [...chat.messages].reverse().find((message) => message.metadata?.codeUsage)?.metadata?.codeUsage);
  const showContextRing = $derived(!!usage && usage.promptTokens > 0 && (usage.contextWindow ?? 0) > 0);
  const speed = $derived(run?.tokensPerSecond ?? latestGenerationSpeed(chat.messages));
  const spend = $derived(conversationSpend(chat.messages, run ?? undefined));
  /** Input handed off but not yet consumed by a turn. */
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
  /** A paused run waiting on the user: the question rides on the prompt sheet. */
  const pendingApprovals = $derived(approvalsStore.forChat(chat.id));
  const pendingInputs = $derived(userInputsStore.forChat(chat.id));
  /** The transcript row an approval belongs to (it carries the diff). */
  function approvalStep(requestId: string) {
    for (let index = chat.messages.length - 1; index >= 0; index--) {
      const step = chat.messages[index]?.agentSteps?.find((candidate) => candidate.id === requestId);
      if (step) return step;
    }
    return undefined;
  }

  const allModes = $derived([
    // Short names and one-line hints: the menu is read at a glance; the full
    // sentence stays on the trigger's tooltip and in the slash commands.
    { id: 'plan' as const, icon: ClipboardList, label: $t('code.modeShort.plan'), brief: $t('code.modeBrief.plan'), hint: $t('code.modePlanHint') },
    { id: 'supervised' as const, icon: ShieldCheck, label: $t('code.modeShort.supervised'), brief: $t('code.modeBrief.supervised'), hint: $t('code.modeSupervisedHint') },
    { id: 'full' as const, icon: Zap, label: $t('code.modeShort.full'), brief: $t('code.modeBrief.full'), hint: $t('code.modeFullHint') }
  ]);
  const modes = $derived(allModes.filter((m) => allowedModes.includes(m.id)));
  const activeMode = $derived(modes.find((m) => m.id === runtimeMode) ?? modes[0] ?? allModes[1]!);
  // Svelte 5 dynamic components: a capitalized reference renders directly.
  const ModeIcon = $derived(activeMode.icon);

  function selectMode(mode: 'plan' | 'supervised' | 'full') {
    modeMenuOpen = false;
    if (!allowedModes.includes(mode)) return;
    if (mode !== runtimeMode) void codeStore.setMode(chat.id, mode).catch((error) => toastStore.error(String(error)));
  }

  /** Swarm rides on top of the mode: the switch lives in the mode menu and the trigger says it. */
  const swarmOn = $derived(swarmStore.enabled(chat.id));
  /** The switch follows the store; a failed change puts it back. */
  let swarmChecked = $state(false);
  $effect(() => { swarmChecked = swarmOn; });
  function setSwarm(on: boolean) {
    void swarmStore.setEnabled(chat.id, on).catch((error) => {
      swarmChecked = swarmStore.enabled(chat.id);
      toastStore.error(String(error));
    });
  }

  const editFiles = (action: 'undo' | 'redo') => restoreCodeEdits(chat, action);

  function openModelHub() {
    if (isExternal) {
      appStore.openSettings('external-clis');
      return;
    }
    appStore.openSettings('models');
  }

   const placeholder = $derived(
     running
       ? (driverCanSteer ? $t('code.steerPlaceholder') : $t('code.driverPicker.queuePlaceholder'))
       : !modelReady
         ? (isExternal
             ? $t('code.driverPicker.driverNotReady', { values: { driver: activeDriver?.label ?? instanceId } })
             : ownBackend === 'api' && ownModel ? copy.model.configureProvider : $t('code.selectModel'))
         : previewText && !text.trim()
           ? previewText
           : $t('code.composerPlaceholder')
   );

  const hint = $derived(
    running
      ? (driverCanSteer ? $t('code.steerHint') : $t('code.driverPicker.queueHint'))
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
  const commands = $derived<Command[]>([...codeCommands({
    t: (key) => $t(key),
    running,
    hasProject: !!project,
    canCompact: driverCanCompact,
    mode: runtimeMode,
    supportedModes: allowedModes,
    worktreeBranch: chat.codeAgent?.worktree?.branch ?? null,
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
    toggleWorktree: async () => {
      if (chat.codeAgent?.worktree) {
        codeWorkspace.toggleChanges(true);
        return;
      }
      await codeStore.enableWorktree(chat.id);
      codeWorkspace.toggleChanges(true);
    },
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
  }), { name: 'goal', icon: Target, label: $t('goal.title'), hint: $t('goal.hint'), run: () => insertGoalCommand() }]);
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
    return handlePickerKey(event, {
      open: fileOpen,
      count: fileMatches.length,
      index: fileIndex,
      onIndex: (next) => (fileIndex = next),
      onSelect: (index) => chooseFile(fileMatches[index]!),
      onDismiss: () => (fileDismissed = true)
    });
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
    return handlePickerKey(event, {
      open: slashOpen,
      count: slashMatches.length,
      index: slashIndex,
      onIndex: (next) => (slashIndex = next),
      onComplete: (index) => completeCommand(slashMatches[index]!),
      onSelect: (index) => void runCommand(slashMatches[index]!),
      onDismiss: () => (slashDismissed = true)
    });
  }

  /** Grow with the content; the stylesheet caps it at five rows (Home parity). */
  function autoGrow(element: HTMLTextAreaElement) {
    autogrowTextarea(element, null, (isGrown) => { grown = isGrown; });
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
    if (isExternal) {
      modelInputs = null;
      return;
    }
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
      const failed: string[] = [];
      for (const file of selected) {
        try {
          if (!isMediaPath(file.name) && (file.type.startsWith('text/') || /\.(txt|md|json|jsonc|csv|tsv|yaml|yml|toml|rs|js|ts|tsx|jsx|py|html|css|svg)$/i.test(file.name))) {
            if (file.size > 2 * 1024 * 1024) throw new Error('Text files are limited to 2 MB.');
            text = mergeDraft(text, `Attached file: ${file.name}\n\n${await file.text()}`);
          } else {
            if (!driverCanAttach) throw new Error($t('code.driverPicker.noAttachments'));
            const result = await invoke<{ attachment: Attachment }>('agente_media_import', await mediaData(file));
            if (result.attachment) imported.push(result.attachment);
          }
        } catch (error) { failed.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      offerMedia(imported);
      if (failed.length) toastStore.error(failed.join('\n'));
    } catch (error) { toastStore.error(String(error)); }
    finally { attaching = false; }
  }
  $effect(() => {
    const over = (event: DragEvent) => { if (appStore.currentChatId === chat.id && event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      if (event.defaultPrevented || appStore.currentChatId !== chat.id) return;
      const files = [...(event.dataTransfer?.files || [])];
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation(); void attachFiles(files);
    };
    document.addEventListener('dragover', over); document.addEventListener('drop', drop);
    return () => { document.removeEventListener('dragover', over); document.removeEventListener('drop', drop); };
  });
  async function attachPath(path: string): Promise<boolean> {
    if (!driverCanAttach) {
      toastStore.error($t('code.driverPicker.noAttachments'));
      return false;
    }
    try {
      const { attachment } = await invoke<{ attachment: Attachment | null }>('agente_media_import', { path, project_dir: project?.rootPath });
      if (!attachment) return false;
      offerMedia([attachment]);
      return true;
    } catch (error) { toastStore.error(String(error)); return false; }
  }
  function onPaste(event: ClipboardEvent) {
    const selected = [...(event.clipboardData?.files || [])];
    if (selected.length) { event.preventDefault(); event.stopPropagation(); void attachFiles(selected); return; }
    const pasted = event.clipboardData?.getData('text/plain') || '';
    if (isMediaPath(pasted)) {
      event.preventDefault();
      const start = textarea?.selectionStart || 0;
      const end = textarea?.selectionEnd || 0;
      void attachPath(pasted).then((attached) => { if (!attached) text = text.slice(0, start) + pasted + text.slice(end); });
    }
  }

   async function submit() {
     previewText = '';
     const value = text.trim() || (attachments.length ? 'Please review the attached media.' : '');
    const goalCommand = parseGoalCommand(value);
    if (goalCommand) { clearComposer(); await goalControl?.command(goalCommand); return; }
    if (attaching) return;
    starterSlot = null;
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
      if (driverCanSteer) void codeStore.steer(chat.id, value, media);
      else codeStore.queue(chat.id, value, media);
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
    if (recallLastQueuedPrompt(event, {
      isEmpty: !text && !attachments.length,
      prompts: chat.pendingPrompts,
      onRecall: (item) => {
        appStore.removeQueuedPrompt(chat.id, item.id);
        text = item.content;
        attachments = item.codeAttachments ?? [];
        void Promise.resolve().then(focusComposer);
      }
    })) return;
    if (event.key === 'Backspace' && !text && attachments.length) { event.preventDefault(); attachments = attachments.slice(0, -1); return; }
    if (onFileKey(event)) return;
    if (onSlashKey(event)) return;
    // Tab holds the message for after the run (Codex's split: Enter steers now).
    if (event.key === 'Tab' && !event.shiftKey && running && (text.trim() || attachments.length) && !event.isComposing) {
      event.preventDefault();
      void queueFollowUp();
      return;
    }
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      if (allowedModes.length > 1) {
        const idx = allowedModes.indexOf(runtimeMode);
        selectMode(allowedModes[(idx + 1) % allowedModes.length]!);
      }
      return;
    }
    /*
     * A call waiting on you owns Enter and Escape: Escape denies it (it used to
     * stop the whole run while the card said "Esc deny"), and Enter on an empty
     * field allows it. With words in the field Enter still sends them.
     */
    if (handleApprovalKey(event, {
      approval: pendingApprovals[0],
      isEmpty: !text.trim() && !attachments.length,
      resolve: (id, allow) => approvalsStore.resolve(id, allow)
    })) return;
    if (event.key === 'Escape' && pendingInputs.length && !pendingApprovals.length) {
      event.preventDefault();
      userInputsStore.resolve(pendingInputs[0]!.id, { action: 'decline' });
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

  function onInput(event: Event) {
    const element = event.currentTarget as HTMLTextAreaElement;
    text = element.value;
    caret = element.selectionStart;
    fileDismissed = false;
    slashDismissed = false;
    // The subject landed: the blank is no longer blank.
    if (starterSlot && element.value !== starterPrefix) starterSlot = null;
    autoGrow(element);
  }

  // Re-point the engine session when the app-wide model selection changes
  // (ModelSwitcher writes app config; the agente runtime keeps its own copy).
  let lastAppliedModel = $state('');
  $effect(() => {
    if (isExternal) return;
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
    // Starter prompts fill the composer; they never send on their own, and they
    // never throw away a draft — a second pick lands under the first.
    const onDraft = (event: Event) => {
      const detail = (event as CustomEvent<string | { chatId?: string; text?: string; slot?: string }>).detail;
      if ((typeof detail === 'object' ? detail.chatId : appStore.currentChatId) !== chat.id) return;
      const value = typeof detail === 'string' ? detail : detail?.text ?? '';
      const slot = typeof detail === 'object' ? detail?.slot : undefined;
      starterPrefix = slot ? value : '';
      starterSlot = slot ?? null;
      previewText = '';
      text = mergeDraft(text, value);
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
    const onPreview = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: string; text?: string }>).detail ?? {};
      if ((detail.chatId ?? appStore.currentChatId) !== chat.id) return;
      previewText = detail.text ?? '';
    };
    window.addEventListener('focus-composer', onFocusComposer);
    window.addEventListener('code-composer-draft', onDraft);
    window.addEventListener('code-composer-append', onAppend);
    window.addEventListener('code-composer-preview', onPreview);
    return () => {
      window.removeEventListener('focus-composer', onFocusComposer);
      window.removeEventListener('code-composer-draft', onDraft);
      window.removeEventListener('code-composer-append', onAppend);
      window.removeEventListener('code-composer-preview', onPreview);
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
  onDestroy(() => { dictation.dispose(); appStore.persist(); });
</script>

<!-- The bars that dance in the send square while it is listening. -->
{#snippet listeningBars()}<MicBars />{/snippet}

{#if dialog && (project || !PROJECT_SECTIONS.includes(dialog))}<CodeProjectDialog chatId={chat.id} projectRoot={project?.rootPath} section={dialog} onclose={() => { dialog = null; void refreshSettings(); }} />{/if}
{#if pendingMedia.length}
  <Dialog title={$t('code.media.title')} onclose={() => (pendingMedia = [])} size="sm">
    <div class="space-y-3 p-4 text-sm"><p class="text-muted-foreground">{$t('code.media.question')}</p>{#each pendingMedia as media, index (index)}<p class="truncate">{media.name} · {media.kind}</p>{/each}
      <div class="flex gap-2"><Button size="sm" onclick={() => acceptMedia()}>{$t('code.media.attach')}</Button><Button size="sm" variant="ghost" onclick={() => acceptMedia(true)}>{$t('code.media.always')}</Button></div>
    </div>
  </Dialog>
{/if}

{#snippet overflowMenu()}
            <!-- The tools menu sits with the space's own controls, as in Home. -->
            <Menu bind:open={toolsMenuOpen} placement="top-start" minWidth="14rem" label={$t('code.toolsMenu')}>
              {#snippet trigger(props)}<Tooltip label={$t('code.toolsMenu')} position="top"><UiIconButton label={$t('code.toolsMenu')} size="xs" type="button" class={uiClass("composer-icon-control", "ui-local-49e9c79c")}  {...props}><Wrench /></UiIconButton></Tooltip>{/snippet}
              {#each menuGroups as group, index (index)}
                {#if index > 0}<div class="ui-menu-separator" role="separator"></div>{/if}
                {#each group as command (command.name)}<MenuItem icon={command.icon} label={command.label} disabled={command.disabled} onselect={() => void runCommand(command)} />{/each}
              {/each}
            </Menu>
{/snippet}

{#snippet selectedMode()}
            {#if modes.length}
            <!-- Runtime mode gate — plan / supervised / full-auto (filtered honestly by driver capabilities). -->
            <Menu bind:open={modeMenuOpen} placement="top-start" minWidth="18rem" label={$t('code.modeSelector')} class="mode-menu">
              {#snippet trigger(props)}
                <Button variant="plain"
                  type="button"
                  class={uiClass("mode-trigger composer-selector flex h-6 items-center gap-1 px-2 transition", "ui-local-49e9c79c", {"is-open": modeMenuOpen})}

                  aria-label={$t('code.modeSelector')}
                  title={activeMode.hint}
                  {...props}
                >
                  <ModeIcon class="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                  <span class="trigger-label truncate">{activeMode.label}</span>
                  {#if !isExternal && swarmOn}<span class="swarm-tag">+ {$t('code.swarm.short')}</span>{/if}
                  <ChevronDown class={`mode-chevron h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150${modeMenuOpen ? ' rotate-180' : ''}`} />
                </Button>
              {/snippet}
              {#each modes as mode (mode.id)}
                {@const selected = mode.id === runtimeMode}
                <MenuItem class="mode-option" icon={mode.icon} active={selected} title={mode.hint} onselect={() => selectMode(mode.id)}>
                  <span class="mode-label">{mode.label}</span>
                  <span class="mode-brief">{mode.brief}</span>
                </MenuItem>
              {/each}
              {#if !isExternal}
                <!-- Swarm is not a fourth mode: it rides on whichever mode is on. -->
                <label class="swarm-row">
                  <span class="swarm-text">
                    <span class="mode-label">{$t('code.swarm.mode')}</span>
                    <span class="swarm-brief">{$t('code.swarm.brief')}</span>
                  </span>
                  <Switch label={$t('code.swarm.mode')} bind:checked={swarmChecked} onchange={setSwarm} />
                </label>
              {/if}
              {#if modes.length > 1}
                <p class="mode-cycle">{$t('code.modeCycle')}</p>
              {/if}
            </Menu>
            {/if}
{/snippet}

<ComposerShell
  ariaLabel={$t('code.composerRegion')}
  dockFade="compact"
  {dictation}
  {running}
  value={text}
  {placeholder}
  {grown}
  bind:textarea
  textareaClass="ui-local-49e9c79c"
  sendDisabled={!canSend}
  sendLabel={$t('code.send')}
  stopLabel={$t('code.stop')}
  stopShortcut="escape"
  dictationSlot={slotDictation}
  {pendingApprovals}
  {pendingInputs}
  {approvalStep}
  onpaste={onPaste}
  oninput={onInput}
  onkeydown={onKeydown}
  onselect={() => { if (textarea) caret = textarea.selectionStart; }}
  onsend={() => void submit()}
  onstop={() => void codeStore.stop(chat.id)}
>
  {#snippet beforeShell()}
    {#if fileOpen}
      <ComposerPicker label={$t('code.projectFiles')} selected={fileIndex}
        items={fileMatches.map(file => ({ id: file, label: file, icon: FileIcon }))}
        onhighlight={index => (fileIndex = index)} onselect={index => chooseFile(fileMatches[index]!)} />
    {:else if slashOpen}
      <ComposerPicker label={$t('code.slash.title')} selected={slashIndex}
        items={slashMatches.map(command => ({ id: command.name, label: `/${command.name}`, icon: command.icon, hint: command.hint, disabled: command.disabled }))}
        onhighlight={index => (slashIndex = index)} onselect={index => void runCommand(slashMatches[index]!)} />
    {/if}
    {#if chat.pendingPrompts?.length}
      <PromptQueue {running} steers={driverCanSteer} items={chat.pendingPrompts} onupdate={(id, content) => appStore.updateQueuedPrompt(chat.id, id, content)} onremove={(id) => { appStore.removeQueuedPrompt(chat.id, id); }} onsend={(id) => void codeStore.sendQueuedNow(chat.id, id)} />
    {/if}
    {#if starterSlot}
      <p class="starter-slot"><span class="slot">{starterSlot}</span></p>
    {/if}
    <SessionGoal bind:this={goalControl} chatId={chat.id} space="code" sessionId={chat.codeAgent?.sessionId} ensureSession={ensureGoalSession} />
    <CodeAttachmentShelf {attachments} onremove={path => attachments = attachments.filter(item => item.path !== path)} />
  {/snippet}

  {#snippet tray()}
    <ComposerBar>
      {#snippet attach()}
        <UiFileInput bind:ref={mediaPicker}  class={uiClass("hidden", "ui-local-49e9c79c")} accept="*/*" multiple onchange={(event) => { void attachFiles([...((event.currentTarget as HTMLInputElement).files || [])]); event.currentTarget.value = ''; }} />
        <Tooltip label={driverCanAttach ? $t('code.attach') : $t('code.driverPicker.noAttachments')} position="top">
          <UiIconButton label={$t('code.attach')} size="xs" type="button" class={uiClass("composer-icon-control", "ui-local-49e9c79c")} disabled={attaching || !driverCanAttach} onclick={() => mediaPicker?.click()}><ComposerGlyph name="add" /></UiIconButton>
        </Tooltip>
      {/snippet}
      {#snippet extras()}
        {@render overflowMenu()}
        <ProjectSelector {chat} />
        <DriverSelector {chat} />
        {@render selectedMode()}
        {#if isExternal && !modelReady}
          <Tooltip label={driverReadyInfo.detail || $t('code.driverPicker.configureDriver')} position="top"><UiIconButton label={$t('code.driverPicker.configureDriver')} size="xs" type="button" class={uiClass(" provider-setup", "ui-local-49e9c79c")} onclick={() => appStore.openSettings('external-clis')}><Settings2 class="size-3" /></UiIconButton></Tooltip>
        {:else if !isExternal && ownBackend !== 'local' && !modelReady}
          <Tooltip label={copy.model.configureProvider} position="top"><UiIconButton label={copy.model.configureProvider} size="xs" type="button" class={uiClass(" provider-setup", "ui-local-49e9c79c")}  onclick={()=>appStore.openSettings('providers')}><Settings2 class="size-3" /></UiIconButton></Tooltip>
        {/if}
      {/snippet}
      {#snippet model()}
        {#if !isExternal}
          <ModelMenu compact {chat} capabilities={ownThinking} level={chat.reasoningLevel} onlevel={setThinking} />
        {:else if driverModels.length > 0 || (activeDriver?.capabilities.models && activeDriver?.status === 'ready')}
          {@const probingModel = !!driversStore.probingIds[instanceId]}
          <Menu bind:open={driverModelMenuOpen} placement="top-start" minWidth="15rem" label={$t('code.driverPicker.driverModel')} class="driver-model-menu">
            {#snippet trigger(props)}
              {@const currentModel = driverModels.find((item) => item.id === selectedDriverModel)}
              {@const effortBadge = selectedDriverEffort && driverThinkingLevels.includes(selectedDriverEffort) ? ` · ${selectedDriverEffort}` : ''}
              <Button variant="plain" type="button" class={uiClass('composer-selector flex h-6 items-center gap-1 px-2 transition', { 'is-open': driverModelMenuOpen })} {...props}>
                {#if probingModel && !driverModels.length}
                  <LoaderCircle class="h-3 w-3 shrink-0 animate-spin text-[var(--text-muted)]" />
                {:else}
                  <Cpu class="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                {/if}
                <span class="trigger-label truncate">{`${currentModel?.label ?? selectedDriverModel ?? (probingModel ? $t('code.driverPicker.loadingModels') : $t('code.driverPicker.defaultModel'))}${effortBadge}`}</span>
                <ChevronDown class={`h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150${driverModelMenuOpen ? ' rotate-180' : ''}`} />
              </Button>
            {/snippet}
            <MenuItem active={!chat.codeAgent?.driverModel} label={$t('code.driverPicker.defaultModel')} onselect={() => { driverModelMenuOpen = false; void codeStore.setConversationDriverModel(chat.id, null); }} />
            {#if driverModels.length}
              <div class="ui-menu-separator" role="separator"></div>
              {#each driverModels as item (item.id)}
                <MenuItem class="mode-option" active={chat.codeAgent?.driverModel === item.id} title={item.id} onselect={() => { driverModelMenuOpen = false; void codeStore.setConversationDriverModel(chat.id, item.id); }}>
                  <span class="mode-label">{item.label}</span>
                  {#if item.id !== item.label}<span class="mode-brief">{item.id}</span>{/if}
                </MenuItem>
              {/each}
            {:else}
              <p class="px-2.5 py-1.5 text-xs text-muted-foreground">{probingModel ? $t('code.driverPicker.loadingModels') : $t('code.driverPicker.noModelsDiscovered')}</p>
            {/if}
            {#if driverThinkingLevels.length}
              <div class="ui-menu-separator" role="separator"></div>
              <div class="driver-effort-group">
                <p class="driver-effort-label">{$t('code.driverPicker.effortTitle')}</p>
                <div class="driver-effort-pills">
                  <button
                    type="button"
                    class="driver-effort-pill"
                    class:is-active={!selectedDriverEffort}
                    onclick={() => void codeStore.setConversationDriverEffort(chat.id, null)}
                  >{$t('code.driverPicker.defaultEffort')}</button>
                  {#each driverThinkingLevels as lvl (lvl)}
                    <button
                      type="button"
                      class="driver-effort-pill"
                      class:is-active={selectedDriverEffort === lvl}
                      onclick={() => void codeStore.setConversationDriverEffort(chat.id, lvl)}
                    >{lvl}</button>
                  {/each}
                </div>
              </div>
            {/if}
            <div class="ui-menu-separator" role="separator"></div>
            <MenuItem
              icon={probingModel ? LoaderCircle : RefreshCw}
              disabled={probingModel}
              label={$t('code.driverPicker.refreshModels')}
              onselect={() => { void driversStore.probe(instanceId); }}
            />
          </Menu>
        {/if}
      {/snippet}
      {#snippet status()}
        <GenerationSpeed value={speed} />
        {#if modelReady && modelInputs}
          <!-- Capability and policy in one glyph: what the model sees, and
               the door to the toggles that decide what gets attached. -->
          <Tooltip label={mediaLabel} position="top">
            <Button variant="plain" type="button" class={uiClass("media-status", "ui-local-49e9c79c")} aria-label={mediaLabel} onclick={() => (dialog = 'settings')}>
              {#if vision}<Eye class="size-3.5" />{:else}<EyeOff class="size-3.5" />{$t('code.media.textOnly')}{/if}
            </Button>
          </Tooltip>
        {/if}
        {#if modelReady && canContinue && !text.trim()}
          <!-- The run stopped short: one click picks the work back up. -->
          <Tooltip label={$t('code.continue')} position="top">
            <Button variant="plain" type="button" class={uiClass("composer-chip", "ui-local-49e9c79c")} onclick={() => void codeStore.followUp(chat.id, $t('code.continuePrompt'))}>
              <Play class="size-3.5" />
              {$t('code.continue')}
            </Button>
          </Tooltip>
        {/if}
      {/snippet}
      {#snippet microphone()}<DictationButton {dictation} hidden={!!slotDictation} />{/snippet}
      {#snippet trailing()}
        {@const sessionOpen = !!chat.projectId && (workspaceLayout.layouts[conversationScope(chat.id)]?.open.includes('session') ?? false)}
        {#if showContextRing && usage && !sessionOpen}
          <ContextUsageRing showLabel usedTokens={usage.promptTokens} maxTokens={usage.contextWindow ?? 0} breakdown={usage.breakdown} {spend} />
        {/if}
      {/snippet}
    </ComposerBar>
  {/snippet}

  {#snippet afterTray()}
    <p class="composer-hint sr-only mx-auto mt-[var(--dock-gap)] px-1 text-center text-xs text-muted-foreground opacity-70">
      {#if hint}
        {hint}
      {/if}
    </p>
  {/snippet}
</ComposerShell>

<style>

  /* The blank a starter left in the prompt: a token, on the composer's own left
     edge, where the missing words will land. Same chip as the row's, so the one
     the user clicked and the one above the composer read as the same object.

     It arrives with the pick, so it enters: 150ms, ease-out, two pixels of
     rise — never a scale from zero, which reads as appearing out of nowhere.
     It leaves with no animation at all: the user has already typed the subject
     and does not need to watch the chip go. */
  .starter-slot { display:flex;margin:0 0 0.375rem;padding:0 0.25rem;animation:slot-in var(--motion-fast) var(--motion-ease-out) both; }
  @keyframes slot-in { from { opacity:0;transform:translateY(2px); } to { opacity:1;transform:none; } }
  .slot {
    display:inline-flex;align-items:center;gap:0.25rem;
    padding:0.0625rem 0.375rem;
    border:1px dashed color-mix(in srgb, var(--foreground) 34%, transparent);
    border-radius:5px;
    color:var(--text-secondary);
    font-family:var(--font-mono);
    font-size:var(--text-xs);
    white-space:nowrap;
  }
  .slot::before { content:"+";opacity:0.7; }
  /* One muted base for both states: "Text only" is a quiet note, not the
     brightest thing on the bar. */
  :global(.media-status.ui-local-49e9c79c) {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: var(--radius-full);
    padding: 0.25rem 0.375rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    white-space: nowrap;
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  :global(.media-status:hover.ui-local-49e9c79c) { background: var(--surface-hover); color: var(--foreground); }
  /* Compact rectangle: clear edges, quiet depth, no pill or glyph motion. */
  :global(.mode-menu) {width:16rem;max-width:calc(100vw - 1.5rem);}
  :global(.mode-menu .mode-option) {padding:0.3125rem 0.625rem;}
  .mode-label {flex-shrink:0;}
  .mode-brief {min-width:0;margin-left:auto;padding-left:0.75rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted-foreground);font-size:var(--text-xs);}
  .swarm-row {display:flex;align-items:center;gap:0.75rem;margin-top:0.25rem;border-top:1px solid var(--border-subtle);padding:0.5rem 0.625rem 0.375rem;cursor:pointer;}
  .swarm-text {display:grid;min-width:0;flex:1;gap:0.0625rem;}
  .swarm-brief {color:var(--muted-foreground);font-size:var(--text-xs);line-height:1.4;}
  /* The mode name keeps its width; the swarm tag is the one that gives way. */
  .swarm-tag {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--brand-accent-strong);font-size:var(--text-xs);font-weight:500;}
  :global(.mode-trigger:has(.swarm-tag) .trigger-label) {flex-shrink:0;}
  .mode-cycle {margin:0.25rem 0 0;padding:0.375rem 0.625rem 0.125rem;border-top:1px solid var(--border-subtle);color:var(--muted-foreground);font-size:var(--text-xs);}
  :global(.mode-menu :is(.mode-option.is-active, :global(.mode-option.is-active.ui-local-49e9c79c))) {background:var(--float-row-selected);}
  :global(.mode-menu .ui-menu-item-hint) {white-space:normal;overflow-wrap:anywhere;}
  :global(.mode-menu .ui-menu-check) {color:var(--brand-accent-strong);}
  :global(.mode-trigger.ui-local-49e9c79c) {min-width:0;max-width:9rem;}
  :global(.mode-trigger:focus-visible.ui-local-49e9c79c) {outline:2px solid var(--brand-accent);outline-offset:2px;}
  :global(.mode-trigger.ui-local-49e9c79c) .trigger-label {
    color: inherit;
    font-size: var(--text-xs);
    font-weight: 400;
    letter-spacing: 0;
  }
  :global(.mode-trigger.ui-local-49e9c79c) {flex-shrink:0;}
  @container composer (max-width:480px) {
    :global(.mode-trigger.ui-local-49e9c79c) .trigger-label, :global(.mode-trigger.ui-local-49e9c79c) :global(.mode-chevron) {display:none;}
    :global(.mode-trigger.ui-local-49e9c79c) {padding-inline:0.375rem;}
  }
  .driver-effort-group { padding: 0.375rem 0.625rem 0.5rem; }
  .driver-effort-label { margin: 0 0 0.375rem; color: var(--muted-foreground); font-size: var(--text-xs); font-weight: 500; }
  .driver-effort-pills { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .driver-effort-pill {
    padding: 0.1875rem 0.5rem; border: 0; border-radius: var(--radius-full);
    background: var(--surface-fill, color-mix(in srgb, var(--foreground) 6%, transparent));
    color: var(--muted-foreground); font-size: var(--text-xs); line-height: 1.3; cursor: pointer;
    transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease);
  }
  .driver-effort-pill:hover { background: var(--float-row-hover); color: var(--foreground); }
  .driver-effort-pill.is-active { background: var(--float-row-selected); color: var(--brand-accent-strong); font-weight: 500; }

</style>
