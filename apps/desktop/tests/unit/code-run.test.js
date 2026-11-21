import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const desktopRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const libRoot = path.join(desktopRoot, 'renderer', 'src', 'lib');
const sharedRoot = path.join(desktopRoot, 'shared');
const copyEnUrl = pathToFileURL(path.join(libRoot, 'copy', 'en.ts')).href;

function resolveWithTs(basePath) {
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) return pathToFileURL(basePath).href;
  for (const ext of ['.ts', '.js', '/index.ts', '/index.js']) {
    const candidate = `${basePath}${ext}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return pathToFileURL(candidate).href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '$lib/copy') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,import { COPY_EN } from ${JSON.stringify(copyEnUrl)}; export const copy = COPY_EN;`
      };
    }
    if (specifier.startsWith('$lib/')) {
      const target = resolveWithTs(path.join(libRoot, specifier.slice(5)));
      if (target) return { shortCircuit: true, url: target };
    }
    if (specifier.startsWith('$shared/')) {
      const target = resolveWithTs(path.join(sharedRoot, specifier.slice(8)));
      if (target) return { shortCircuit: true, url: target };
    }
    return nextResolve(specifier, context);
  }
});

const { applyCodeAgentEvent, createCodeRunState } = await import('../../renderer/src/lib/features/code/code-run.ts');
const { linkChildToStep } = await import('../../renderer/src/lib/features/code/subagent-row.ts');

describe('code-run parallel step and subagent cleanup', () => {
  it('marks all still-running parallel steps and subagents as error in failRun (error event)', () => {
    const state = createCodeRunState();
    applyCodeAgentEvent(state, { type: 'agent_start', chatId: 'c1' });
    applyCodeAgentEvent(state, { type: 'tool_start', chatId: 'c1', toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } });
    applyCodeAgentEvent(state, { type: 'tool_start', chatId: 'c1', toolCallId: 't2', toolName: 'grep', args: { pattern: 'foo' } });
    applyCodeAgentEvent(state, {
      type: 'runtime_event',
      chatId: 'c1',
      event: { type: 'child_started', run_id: 'child-1', kind: 'explore', description: 'Scan repo' }
    });
    applyCodeAgentEvent(state, {
      type: 'runtime_event',
      chatId: 'c1',
      event: { type: 'child_tool', run_id: 'child-1', call_id: 'ct1', name: 'read_file', content: '', finished: false, is_error: false }
    });
    applyCodeAgentEvent(state, {
      type: 'runtime_event',
      chatId: 'c1',
      event: { type: 'child_started', run_id: 'child-2', kind: 'explore', description: 'Check tests' }
    });

    applyCodeAgentEvent(state, { type: 'error', chatId: 'c1', message: 'connection dropped' });

    assert.equal(state.done, true);
    assert.deepEqual(state.steps.map((s) => s.status), ['error', 'error']);
    assert.deepEqual(state.children.map((c) => c.status), ['error', 'error']);
    assert.ok(state.children.every((c) => typeof c.finishedAt === 'number'));
    assert.equal(state.children[0].tools[0].status, 'error');
  });

  it('closes all still-running parallel steps and subagents on agent_end', () => {
    const state = createCodeRunState();
    applyCodeAgentEvent(state, { type: 'agent_start', chatId: 'c1' });
    applyCodeAgentEvent(state, { type: 'tool_start', chatId: 'c1', toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } });
    applyCodeAgentEvent(state, { type: 'tool_start', chatId: 'c1', toolCallId: 't2', toolName: 'read', args: { path: 'b.ts' } });
    applyCodeAgentEvent(state, {
      type: 'runtime_event',
      chatId: 'c1',
      event: { type: 'child_started', run_id: 'child-1', kind: 'explore', description: 'First child' }
    });
    applyCodeAgentEvent(state, {
      type: 'runtime_event',
      chatId: 'c1',
      event: { type: 'child_started', run_id: 'child-2', kind: 'explore', description: 'Second child' }
    });

    applyCodeAgentEvent(state, { type: 'agent_end', chatId: 'c1', stopReason: 'stop' });

    assert.equal(state.done, true);
    assert.deepEqual(state.steps.map((s) => s.status), ['done', 'done']);
    assert.deepEqual(state.children.map((c) => c.status), ['done', 'done']);
    assert.ok(state.children.every((c) => typeof c.finishedAt === 'number'));
  });

  it('normalizes multiline and long descriptions with firstLine(..., 160) in linkChildToStep', () => {
    const longDesc = `${'a'.repeat(200)}\nsecond line ignored`;
    const state = createCodeRunState();
    applyCodeAgentEvent(state, {
      type: 'tool_start',
      chatId: 'c1',
      toolCallId: 'task-1',
      toolName: 'task',
      args: { subagent_type: 'explore', description: longDesc }
    });

    assert.equal(linkChildToStep(state.steps, longDesc), 'task-1');

    applyCodeAgentEvent(state, {
      type: 'runtime_event',
      chatId: 'c1',
      event: { type: 'child_started', run_id: 'child-long', kind: 'explore', description: longDesc }
    });
    assert.equal(state.steps[0].subagentId, 'child-long');
  });
});
