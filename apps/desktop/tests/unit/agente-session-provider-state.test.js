import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { SessionTree } from '../../main/agente/sessions/session-tree.ts';

function tempProject() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'agente-prov-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('agente session provider-state echo (#9)', () => {
  it('round-trips providerState and reasoning_content on assistant entries', async () => {
    const { root, cleanup } = tempProject();
    const sessionsDir = path.join(root, '.sessions');
    try {
      const tree = SessionTree.create(root, sessionsDir, 'sess-prov');
      tree.append('user', { content: 'think step by step' });
      tree.append('assistant', {
        content: 'done',
        reasoning: 'visible trace',
        stopReason: 'stop',
        providerState: { provider: 'deepseek', blocks: [{ signature: 'opaque==' }] },
        reasoning_content: 'native reasoning channel'
      });

      const reopened = await SessionTree.open(tree.filePath);
      const context = reopened.buildContext();
      assert.strictEqual(context.length, 2);
      const assistant = context[1];
      assert.strictEqual(assistant.role, 'assistant');
      assert.deepStrictEqual(assistant.providerState, { provider: 'deepseek', blocks: [{ signature: 'opaque==' }] });
      assert.strictEqual(assistant.reasoning_content, 'native reasoning channel');
      // The display channel is untouched by the echo fields.
      assert.strictEqual(assistant.reasoning, 'visible trace');
    } finally {
      cleanup();
    }
  });

  it('leaves the echo fields undefined for entries written before #9', async () => {
    const { root, cleanup } = tempProject();
    const sessionsDir = path.join(root, '.sessions');
    try {
      const tree = SessionTree.create(root, sessionsDir, 'sess-legacy');
      tree.append('assistant', { content: 'old answer', stopReason: 'stop' });

      const reopened = await SessionTree.open(tree.filePath);
      const assistant = reopened.buildContext()[0];
      assert.strictEqual(assistant.providerState, undefined);
      assert.strictEqual(assistant.reasoning_content, undefined);
    } finally {
      cleanup();
    }
  });
});
