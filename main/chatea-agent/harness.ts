import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ChateaAgentStartSessionArgs, ChateaAgentStartSessionResult, ChateaAgentDetectArgs, ChateaAgentDetectResult, ChateaCommand } from './types.ts';
import { getSession, setSession, removeSession, listActiveSessions } from './session-pool.ts';
import { emitCodeAgentEvent } from './event-bridge.ts';

const FORCE_KILL_AFTER_MS = 2000;
const DEFAULT_BINARY = process.platform === 'win32' ? 'chatea.cmd' : 'chatea';

function resolveSpawnCommand(binaryPath: string): { command: string; shell: boolean } {
  const lower = binaryPath.toLowerCase();
  const needsShell = process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'));
  return { command: binaryPath, shell: needsShell };
}

function attachStdoutReader(chatId: string, child: ChildProcess): void {
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event.type === 'string' && event.chatId) {
        emitCodeAgentEvent(null, event);
      }
    } catch {
      // Non-JSON stdout (logs, etc.) — ignore silently
    }
  });
}

function attachStderrLogger(child: ChildProcess): void {
  const rl = createInterface({ input: child.stderr!, crlfDelay: Infinity });
  rl.on('line', (line: string) => {
    console.error(`[chatea-agent stderr] ${line}`);
  });
}

export async function detectChateaAgent(args: ChateaAgentDetectArgs): Promise<ChateaAgentDetectResult> {
  void args;
  return { status: 'ready' };
}

export async function startChateaAgentSession(args: ChateaAgentStartSessionArgs): Promise<ChateaAgentStartSessionResult> {
  const sessionId = `chatea-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const binaryPath = process.env.CHATEA_BINARY || DEFAULT_BINARY;
  const { command, shell } = resolveSpawnCommand(binaryPath);
  const spawnArgs = ['serve', '--project', args.projectRoot];

  const child = spawn(command, spawnArgs, {
    cwd: args.projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell,
    env: { ...process.env, CHATEA_SESSION_ID: sessionId, CHATEA_CHAT_ID: args.chatId },
  });

  setSession(args.chatId, {
    chatId: args.chatId,
    sessionId,
    createdAt: Date.now(),
    disposed: false,
    childProcess: child,
  });

  const initCommand: ChateaCommand = {
    type: 'initialize',
    chatId: args.chatId,
    projectRoot: args.projectRoot,
    provider: args.provider,
    model: args.model,
    runtimeMode: args.runtimeMode,
    thinkingLevel: args.thinkingLevel,
    checkpointsEnabled: args.checkpointsEnabled,
    systemPromptOverride: args.systemPromptOverride,
  };

  attachStdoutReader(args.chatId, child);
  attachStderrLogger(child);

  child.on('exit', (code) => {
    emitCodeAgentEvent(null, { type: 'agent_end', chatId: args.chatId });
    const entry = getSession(args.chatId);
    if (entry && !entry.disposed) {
      removeSession(args.chatId);
    }
  });

  child.on('error', (err) => {
    console.error(`[chatea-agent] process error for ${args.chatId}:`, err.message);
    emitCodeAgentEvent(null, { type: 'error', chatId: args.chatId, message: `Process error: ${err.message}` });
    removeSession(args.chatId);
  });

  // Send initialize command after a short delay to let the process boot
  await new Promise<void>((resolve) => {
    child.stdin!.write(JSON.stringify(initCommand) + '\n', 'utf-8', () => resolve());
  });

  return { sessionId };
}

export function sendCommand(chatId: string, command: ChateaCommand): void {
  const entry = getSession(chatId);
  if (!entry || entry.disposed || !entry.childProcess) {
    console.warn(`[chatea-agent] Cannot send command to ${chatId}: no active session`);
    return;
  }
  const line = JSON.stringify(command) + '\n';
  entry.childProcess.stdin!.write(line, 'utf-8', (err) => {
    if (err) {
      console.error(`[chatea-agent] Failed to write to ${chatId}:`, err.message);
    }
  });
}

export async function closeChateaAgentSession(chatId: string): Promise<void> {
  const entry = getSession(chatId);
  if (!entry || entry.disposed) return;

  try {
    sendCommand(chatId, { type: 'shutdown', chatId });
  } catch {
    // ignore write errors during shutdown
  }

  const child = entry.childProcess;
  if (child && !child.killed) {
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, FORCE_KILL_AFTER_MS);

      child.on('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });
    });
  }

  removeSession(chatId);
}

export async function disposeAllChateaAgentSessions(): Promise<void> {
  const entries = listActiveSessions();
  await Promise.all(entries.map((e) => closeChateaAgentSession(e.chatId)));
}
