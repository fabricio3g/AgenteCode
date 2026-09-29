import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types/chat';
import { acceptMessage, parsePlan, pendingPlan } from './plan-review';
import { fileMentionAt, insertFile, matchFiles } from './file-mention';
import { chatToMarkdown, exportFileName } from './export-chat';
import { activitySummary } from './activity';
import { conversationSpend, spendLabel } from './accounting';
import { emptySpend } from './code-run';

const PLAN = 'Plan ready\n\n__PLAN_READY__\n.agente/plan.md\n__PLAN_TITLE__\nMy Plan\n__PLAN_BODY__\n# My Plan\n\n1. Do it\n';

function message(partial: Partial<ChatMessage>): ChatMessage {
  return { id: Math.random().toString(36), role: 'assistant', content: '', timestamp: 0, ...partial } as ChatMessage;
}

describe('plan review', () => {
  it('reads a presented plan', () => {
    expect(parsePlan(PLAN)).toEqual({ path: '.agente/plan.md', title: 'My Plan', body: '# My Plan\n\n1. Do it' });
    expect(parsePlan('ordinary output')).toBeNull();
  });

  it('waits for an answer only while nothing was said after it', () => {
    const presented = message({ agentSteps: [{ id: 's', type: 'tool', label: 'Plan', toolName: 'present_plan', status: 'done', output: PLAN }] });
    expect(pendingPlan([presented])?.title).toBe('My Plan');
    expect(pendingPlan([presented, message({ role: 'user', content: 'ok' })])).toBeNull();
    expect(acceptMessage(parsePlan(PLAN)!)).toContain('.agente/plan.md');
  });
});

describe('@ file mentions', () => {
  const files = ['src/app.ts', 'src/lib/apple.ts', 'README.md', 'docs/app-guide.md'];

  it('finds the mention at the caret, not in emails', () => {
    expect(fileMentionAt('look at @src/a', 14)).toEqual({ start: 8, query: 'src/a' });
    expect(fileMentionAt('mail me@x.com', 13)).toBeNull();
  });

  it('ranks names that start with the query first', () => {
    expect(matchFiles(files, 'app')).toEqual(['src/app.ts', 'src/lib/apple.ts', 'docs/app-guide.md']);
    expect(matchFiles(files, '', 2)).toEqual(['README.md', 'src/app.ts']);
  });

  it('inserts the path and moves the caret after it', () => {
    expect(insertFile('fix @ap now', 7, { start: 4, query: 'ap' }, 'src/app.ts')).toEqual({ text: 'fix @src/app.ts now', caret: 16 });
  });
});

describe('export', () => {
  it('writes the conversation as markdown', () => {
    const markdown = chatToMarkdown('Fix bug', [
      message({ role: 'user', content: 'Fix the bug' }),
      message({ content: 'Done.', agentSteps: [{ id: 't', type: 'tool', label: 'src/a.ts', toolName: 'edit_file', status: 'done' }] })
    ]);
    expect(markdown).toBe('# Fix bug\n\n## You\n\nFix the bug\n\n## Agente\n\n- `edit_file` src/a.ts\n\nDone.\n');
    expect(exportFileName('Fix the Bug!')).toBe('fix-the-bug.md');
  });
});

describe('compact activity and composer accounting', () => {
  it('counts active commands rather than earlier completed commands', () => {
    expect(activitySummary([
      { id: 'old', type: 'executing', toolName: 'bash', label: 'Run', status: 'done' },
      { id: 'live', type: 'executing', toolName: 'bash', label: 'Run', status: 'running' }
    ])).toEqual({ kind: 'commands', running: true, count: 1 });
  });

  it('counts edited files once when several edits touch the same file', () => {
    expect(activitySummary([
      { id: 'a', type: 'writing', toolName: 'edit', label: 'Edit', detail: 'src/app.ts', status: 'done' },
      { id: 'b', type: 'writing', toolName: 'edit', label: 'Edit', detail: 'src/app.ts', status: 'done' },
      { id: 'c', type: 'writing', toolName: 'write', label: 'Write', detail: 'README.md', status: 'done' }
    ])).toEqual({ kind: 'edits', running: false, count: 2 });
  });

  it('uses live accounting once and keeps prior turns when resuming', () => {
    const prior = { ...emptySpend(), costUsd: 0.01, promptTokens: 20, cacheReadTokens: 80, estimated: true };
    const current = { ...emptySpend(), costUsd: 0.02, promptTokens: 20, cacheReadTokens: 80 };
    const saved = [message({ id: 'a', metadata: { codeSpend: prior } }), message({ id: 'b', metadata: { codeSpend: current } })];
    const live = { assistantMessageId: 'b', spend: { ...current, costUsd: 0.03 } };
    expect(spendLabel(conversationSpend(saved))).toBe('~$0.030 · 80% cached');
    expect(spendLabel(conversationSpend(saved, live))).toBe('~$0.040 · 80% cached');
    // A stale run left behind after rewind contributes nothing.
    expect(spendLabel(conversationSpend(saved.slice(0, 1), live))).toBe('~$0.010 · 80% cached');
  });
});
