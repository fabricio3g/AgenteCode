// ── Append-only session tree (JSONL) ───────────────────────────────────
// One file per session, grouped by project slug (pi's --<cwd>-- layout).
// Every entry carries id/parentId so forking and branching stay possible
// without a format change. Compaction entries record a summary plus the cut
// point; buildContext() reconstructs the LLM-visible history from the
// current branch.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgentMessage, AssistantMessage, ToolCall } from '../../../shared/agent-core/types.ts';

export type SessionEntryKind =
  | 'user'
  | 'assistant'
  | 'tool_result'
  | 'model_change'
  | 'compaction'
  | 'custom';

export interface SessionHeader {
  v: 1;
  type: 'session';
  id: string;
  projectRoot: string;
  createdAt: number;
}

export interface SessionEntry {
  type: 'entry';
  id: string;
  parentId: string | null;
  ts: number;
  kind: SessionEntryKind;
  data: unknown;
}

export type SessionFileLine = SessionHeader | SessionEntry;

export function projectSlug(projectRoot: string): string {
  const base = path.basename(path.resolve(projectRoot)) || 'project';
  const safe = base.replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 40);
  return `${safe}-${crypto.createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 8)}`;
}

export function newSessionId(): string {
  return `agente-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

export class SessionTree {
  readonly header: SessionHeader;
  readonly filePath: string;
  private headId: string | null = null;
  private readonly entries: SessionEntry[] = [];

  private constructor(header: SessionHeader, entries: SessionEntry[], headId: string | null, filePath: string) {
    this.header = header;
    this.entries = entries;
    this.headId = headId;
    this.filePath = filePath;
  }

  static create(projectRoot: string, sessionsDir: string, id = newSessionId()): SessionTree {
    const header: SessionHeader = {
      v: 1,
      type: 'session',
      id,
      projectRoot,
      createdAt: Date.now()
    };
    const filePath = path.join(sessionsDir, projectSlug(projectRoot), `${header.createdAt}-${id}.jsonl`);
    return new SessionTree(header, [], null, filePath);
  }

  static async open(filePath: string): Promise<SessionTree> {
    const raw = await fsp.readFile(filePath, 'utf8');
    let header: SessionHeader | null = null;
    const entries: SessionEntry[] = [];
    let headId: string | null = null;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: SessionFileLine;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // torn tail write — ignore
      }
      if (parsed.type === 'session') {
        header = parsed;
      } else if (parsed.type === 'entry') {
        entries.push(parsed);
        headId = parsed.id;
      }
    }
    if (!header) throw new Error(`Session file has no header: ${filePath}`);
    return new SessionTree(header, entries, headId, filePath);
  }

  append(kind: SessionEntryKind, data: unknown): SessionEntry {
    const entry: SessionEntry = {
      type: 'entry',
      id: crypto.randomUUID(),
      parentId: this.headId,
      ts: Date.now(),
      kind,
      data
    };
    this.entries.push(entry);
    this.headId = entry.id;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, `${JSON.stringify(this.header)}\n`, 'utf8');
    }
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  get head(): SessionEntry | null {
    return this.headId ? (this.entries.find((e) => e.id === this.headId) ?? null) : null;
  }

  listEntries(): SessionEntry[] {
    return [...this.entries];
  }

  /**
   * Rebuild the LLM-visible context from the current (linear) branch: after
   * the newest compaction entry, its summary becomes the opening context.
   */
  buildContext(): AgentMessage[] {
    let cutIndex = -1;
    let summary: string | null = null;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (entry.kind === 'compaction') {
        cutIndex = i;
        summary = (entry.data as { summary?: string } | null)?.summary ?? null;
        break;
      }
    }

    const messages: AgentMessage[] = [];
    if (summary) {
      messages.push({
        role: 'user',
        content: `[conversation summary]\n${summary}`,
        ts: 0
      });
    }
    for (const entry of this.entries.slice(cutIndex + 1)) {
      const message = entryToMessage(entry);
      if (message) messages.push(message);
    }
    return messages;
  }

  /** Latest model_change entry (null before the first model switch). */
  lastModelChange(): { provider: string; model: string; thinkingLevel?: string } | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (entry.kind === 'model_change') return entry.data as { provider: string; model: string; thinkingLevel?: string };
    }
    return null;
  }
}

function entryToMessage(entry: SessionEntry): AgentMessage | null {
  const data = entry.data as Record<string, unknown> | null;
  if (entry.kind === 'user') {
    return { role: 'user', content: String(data?.content ?? ''), ts: entry.ts };
  }
  if (entry.kind === 'assistant') {
    return {
      role: 'assistant',
      content: String(data?.content ?? ''),
      reasoning: data?.reasoning ? String(data.reasoning) : undefined,
      toolCalls: Array.isArray(data?.toolCalls) ? (data!.toolCalls as ToolCall[]) : undefined,
      stopReason: (data?.stopReason as AssistantMessage['stopReason']) ?? undefined,
      errorMessage: data?.errorMessage ? String(data.errorMessage) : undefined,
      providerState: data?.providerState,
      reasoning_content: data?.reasoning_content ? String(data.reasoning_content) : undefined,
      ts: entry.ts
    };
  }
  if (entry.kind === 'tool_result') {
    return {
      role: 'tool',
      toolCallId: String(data?.toolCallId ?? ''),
      toolName: String(data?.toolName ?? ''),
      content: String(data?.content ?? ''),
      isError: !!data?.isError,
      ts: entry.ts
    };
  }
  return null;
}
