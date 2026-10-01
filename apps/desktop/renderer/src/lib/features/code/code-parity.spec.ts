import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types/chat';
import { acceptMessage, isPlanWaiting, parsePlan, pendingPlan } from './plan-review';
import { fileMentionAt, insertFile, matchFiles } from './file-mention';
import { activitySummary, stepKind } from './activity';
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

  it('keeps an answered plan readable but no longer waiting', () => {
    const presented = message({ agentSteps: [{ id: 's', type: 'tool', label: 'Plan', toolName: 'present_plan', status: 'done', output: PLAN }] });
    const plan = parsePlan(PLAN)!;
    expect(isPlanWaiting([presented], plan)).toBe(true);
    expect(isPlanWaiting([presented, message({ role: 'user', content: 'ok' })], plan)).toBe(false);
    expect(isPlanWaiting([presented], { ...plan, body: 'an older plan' })).toBe(false);
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

describe('compact activity and composer accounting', () => {
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


describe('activity summary', () => {
  const step = (toolName: string, status: 'done' | 'running' = 'done', path?: string) =>
    ({ id: Math.random().toString(36), type: 'tool', label: toolName, toolName, status, ...(path ? { fileChanges: [{ path }] } : {}) }) as never;

  it('knows the Rust core tool names', () => {
    expect(stepKind(step('read_file'))).toBe('read');
    expect(stepKind(step('find'))).toBe('search');
    expect(stepKind(step('shell'))).toBe('command');
    expect(stepKind(step('mcp__github__issues'))).toBe('other');
  });

  it('counts a mixed run by kind, edits by distinct file', () => {
    const summary = activitySummary([step('read_file'), step('find'), step('read_file'), step('edit_file', 'done', 'a.ts'), step('edit_file', 'done', 'a.ts'), step('shell', 'running')]);
    expect(summary.running).toBe(true);
    expect(summary.counts).toEqual([
      { kind: 'edit', count: 1, running: false },
      { kind: 'command', count: 1, running: true },
      { kind: 'read', count: 2, running: false },
      { kind: 'search', count: 1, running: false }
    ]);
  });
});

describe('tool kinds for UI names', () => {
  it('reads the names main gives Rust tools and the browser tools', () => {
    const kind = (toolName: string) => stepKind({ id: 'x', type: 'tool', label: '', toolName, status: 'done' });
    expect([kind('bash'), kind('ls'), kind('write'), kind('browser_navigate')]).toEqual(['command', 'list', 'edit', 'web']);
  });
});

import { buildSessionMarkdown } from '$lib/features/shared/export-session';

describe('export', () => {
  it('lists a code run’s tools before its reply', () => {
    const markdown = buildSessionMarkdown({ title: 'Fix bug', messages: [
      message({ role: 'user', content: 'Fix the bug' }),
      message({ content: 'Done.', agentSteps: [{ id: 't', type: 'tool', label: 'src/a.ts', toolName: 'edit', status: 'done' }] })
    ] }, '2026-09-29');
    expect(markdown).toContain('**You:**\n\nFix the bug');
    expect(markdown).toContain('**Assistant**:\n\n- `edit` src/a.ts\n\nDone.');
  });
});
