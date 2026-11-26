// The Code composer's commands: every one is a slash command; the ones with
// a `menu` group also appear in the "…" menu (actions first, then the
// project's own settings). Modes, panes and the model have their own
// controls, so they are slash-only.

import { Archive, Bot, ClipboardList, File as FileIcon, FileDown, FolderOpen, GitBranch, GitCompareArrows, MessageSquarePlus, Plug, RotateCcw, RotateCw, Settings2, ShieldCheck, Sparkles, Square, SquareTerminal, Zap, History, Cpu } from '$lib/icons';
import type { SlashCommand } from '$lib/features/shared/composer/slash-commands';

export type CodeDialog = 'skills' | 'agents' | 'mcp' | 'sessions' | 'settings';
type Mode = 'plan' | 'supervised' | 'full';

export type CodeCommand = SlashCommand & {
  icon: typeof Archive;
  label: string;
  hint: string;
  /** Also listed in the "…" menu, in this group. */
  menu?: 'actions' | 'project';
  disabled?: boolean;
  run: () => void | Promise<void>;
};

export interface CommandContext {
  t: (key: string) => string;
  running: boolean;
  hasProject: boolean;
  canCompact?: boolean;
  mode: Mode;
  supportedModes?: readonly Mode[];
  worktreeBranch?: string | null;
  compact: () => Promise<void>;
  newConversation: () => void;
  setMode: (mode: Mode) => void;
  showChanges: () => void;
  toggleWorktree?: () => void | Promise<void>;
  toggleTerminal: () => Promise<void>;
  openDialog: (dialog: CodeDialog) => void;
  edits: (action: 'undo' | 'redo') => Promise<void>;
  init: () => Promise<void>;
  exportConversation: () => void;
  openModels: () => void;
  openProject: () => Promise<void>;
  stop: () => void;
}

const NEXT_MODE: Record<Mode, Mode> = { plan: 'supervised', supervised: 'full', full: 'plan' };

export function codeCommands(c: CommandContext): CodeCommand[] {
  const cmd = (name: string) => ({ label: c.t(`code.cmd.${name}.label`), hint: c.t(`code.cmd.${name}.hint`) });
  const allowedModes = c.supportedModes?.length ? c.supportedModes : (['plan', 'supervised', 'full'] as const);
  const nextSupportedMode = () => {
    const idx = allowedModes.indexOf(c.mode);
    return allowedModes[(idx + 1) % allowedModes.length] ?? NEXT_MODE[c.mode];
  };
  return [
    // "…" menu: actions on this conversation
    { name: 'new', aliases: ['tab'], icon: MessageSquarePlus, label: c.t('code.newConversation'), hint: c.t('code.slash.newHint'), menu: 'actions', disabled: !c.hasProject, run: c.newConversation },
    ...(c.canCompact === false
      ? []
      : [{ name: 'compact', icon: Archive, label: c.t('code.slash.compact'), hint: c.t('code.compactHint'), menu: 'actions' as const, disabled: c.running, run: c.compact }]),
    ...(c.toggleWorktree
      ? [{
          name: 'worktree',
          aliases: ['wt'],
          icon: GitBranch,
          label: c.worktreeBranch ? `${c.t('code.worktree.activePrefix')}: ${c.worktreeBranch}` : c.t('code.worktree.isolate'),
          hint: c.t('code.worktree.commandHint'),
          menu: 'actions' as const,
          disabled: !c.hasProject || (!c.worktreeBranch && c.running),
          run: c.toggleWorktree
        }]
      : []),
    { name: 'undo', icon: RotateCcw, ...cmd('undo'), menu: 'actions', disabled: c.running, run: () => c.edits('undo') },
    { name: 'redo', icon: RotateCw, ...cmd('redo'), menu: 'actions', disabled: c.running, run: () => c.edits('redo') },
    { name: 'export', icon: FileDown, ...cmd('export'), menu: 'actions', run: c.exportConversation },
    { name: 'session', aliases: ['resume', 'sessions'], icon: History, ...cmd('session'), menu: 'actions', run: () => c.openDialog('sessions') },
    // "…" menu: this project's agent setup
    { name: 'init', icon: FileIcon, ...cmd('init'), menu: 'project', disabled: !c.hasProject, run: c.init },
    { name: 'skills', icon: Sparkles, ...cmd('skills'), menu: 'project', run: () => c.openDialog('skills') },
    { name: 'subagents', aliases: ['agents', 'subagent-models'], icon: Bot, ...cmd('subagents'), menu: 'project', run: () => c.openDialog('agents') },
    { name: 'mcp', icon: Plug, ...cmd('mcp'), menu: 'project', run: () => c.openDialog('mcp') },
    { name: 'settings', icon: Settings2, ...cmd('settings'), menu: 'project', run: () => c.openDialog('settings') },
    // Slash only: these have their own controls
    ...(allowedModes.includes('plan') ? [{ name: 'plan', icon: ClipboardList, label: c.t('code.modePlan'), hint: c.t('code.modePlanHint'), run: () => c.setMode('plan') }] : []),
    ...(allowedModes.includes('supervised') ? [{ name: 'supervised', aliases: ['build'], icon: ShieldCheck, label: c.t('code.modeSupervised'), hint: c.t('code.modeSupervisedHint'), run: () => c.setMode('supervised') }] : []),
    ...(allowedModes.includes('full') ? [{ name: 'full', aliases: ['auto'], icon: Zap, label: c.t('code.modeFull'), hint: c.t('code.modeFullHint'), run: () => c.setMode('full') }] : []),
    ...(allowedModes.length > 1 ? [{ name: 'mode', aliases: ['approve'], icon: ShieldCheck, ...cmd('mode'), run: () => c.setMode(nextSupportedMode()) }] : []),
    { name: 'changes', icon: GitCompareArrows, label: c.t('codeWs.changes'), hint: c.t('code.slash.changesHint'), run: c.showChanges },
    { name: 'terminal', icon: SquareTerminal, label: c.t('codeWs.terminal'), hint: c.t('code.slash.terminalHint'), disabled: !c.hasProject, run: c.toggleTerminal },
    { name: 'model', aliases: ['provider', 'refresh-models'], icon: Cpu, ...cmd('model'), run: c.openModels },
    { name: 'project', icon: FolderOpen, ...cmd('project'), run: c.openProject },
    { name: 'stop', icon: Square, ...cmd('stop'), disabled: !c.running, run: c.stop }
  ];
}
