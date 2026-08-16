import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ExtensionRunner } from '../../main/agente/extensions/extension-runner.ts';
import { createBuiltinExtensions } from '../../main/agente/extensions/builtin.ts';

function makeRunner() {
  return new ExtensionRunner(
    { projectRoot: '/proj', sessionId: 's1', runtimeMode: 'supervised', appendEntry: () => {} },
    () => {}
  );
}

describe('agente extension runner', () => {
  it('registers tools from setup() and adapts them to AgentTool shape', async () => {
    const runner = makeRunner();
    await runner.load([
      {
        id: 'ext',
        name: 'Ext',
        description: '',
        async setup(pi) {
          pi.registerTool({
            name: 'hello',
            description: 'says hi',
            parameters: { type: 'object', properties: {} },
            async execute(args, ctx) {
              return { content: `hi ${ctx.projectRoot} ${JSON.stringify(args)}` };
            }
          });
        }
      }
    ]);

    assert.strictEqual(runner.tools.length, 1);
    const tool = runner.tools[0];
    assert.strictEqual(tool.name, 'hello');
    const result = await tool.execute('c1', {}, { signal: new AbortController().signal });
    assert.strictEqual(result.content, 'hi /proj {}');
  });

  it('isolates a throwing extension without breaking the others', async () => {
    const runner = makeRunner();
    await runner.load([
      {
        id: 'broken',
        name: 'Broken',
        description: '',
        setup() {
          throw new Error('boom at setup');
        }
      },
      {
        id: 'works',
        name: 'Works',
        description: '',
        setup(pi) {
          pi.registerTool({
            name: 'fine',
            description: '',
            parameters: { type: 'object', properties: {} },
            async execute() {
              return { content: 'ok' };
            }
          });
        }
      }
    ]);

    assert.deepStrictEqual(runner.loaded, ['works']);
    assert.strictEqual(runner.errors.length, 1);
    assert.match(runner.errors[0].error, /boom at setup/);
    assert.strictEqual(runner.tools.length, 1);
  });

  it('merges tool_call blocks: first block wins', async () => {
    const runner = makeRunner();
    await runner.load([
      {
        id: 'a',
        name: 'A',
        description: '',
        async setup(pi) {
          pi.on('tool_call', async () => ({ block: 'first' }));
        }
      },
      {
        id: 'b',
        name: 'B',
        description: '',
        async setup(pi) {
          pi.on('tool_call', async () => ({ block: 'second' }));
        }
      }
    ]);

    const verdict = await runner.dispatch({ event: 'tool_call', toolName: 'bash', args: { command: 'x' } });
    assert.strictEqual(verdict.block, 'first');
  });

  it('contains a throwing hook and still returns other results', async () => {
    const runner = makeRunner();
    await runner.load([
      {
        id: 'thrower',
        name: 'Thrower',
        description: '',
        async setup(pi) {
          pi.on('tool_call', async () => {
            throw new Error('hook exploded');
          });
        }
      },
      {
        id: 'clean',
        name: 'Clean',
        description: '',
        async setup(pi) {
          pi.on('tool_call', async () => ({ block: 'clean block' }));
        }
      }
    ]);

    const verdict = await runner.dispatch({ event: 'tool_call', toolName: 'bash', args: {} });
    assert.strictEqual(verdict.block, 'clean block');
    assert.strictEqual(runner.errors.filter((e) => e.extensionId === 'thrower').length, 1);
  });

  it('applies context rewrites in registration order', async () => {
    const runner = makeRunner();
    await runner.load([
      {
        id: 'trim',
        name: 'Trim',
        description: '',
        async setup(pi) {
          pi.on('context', async (payload) => ({
            rewritten: (payload.messages ?? []).filter((m) => m.role !== 'user' || !m.content.startsWith('[noise]'))
          }));
        }
      }
    ]);

    const messages = [
      { role: 'user', content: '[noise] drop me', ts: 1 },
      { role: 'user', content: 'keep me', ts: 2 }
    ];
    const result = await runner.applyContextHooks(messages);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].content, 'keep me');
  });

  it('merges tool_result overrides field-wise', async () => {
    const runner = makeRunner();
    const merged = runner.mergeToolResult({ content: 'raw', isError: false }, { content: 'overridden', terminate: true });
    assert.strictEqual(merged.content, 'overridden');
    assert.strictEqual(merged.isError, false);
    assert.strictEqual(merged.terminate, true);
  });
});

describe('agente builtin extensions', () => {
  it('safety-rails blocks force pushes and rm -rf through tool_call hooks', async () => {
    const runner = makeRunner();
    await runner.load(createBuiltinExtensions().filter((e) => e.id === 'safety-rails'));

    const blocked = await runner.dispatch({ event: 'tool_call', toolName: 'bash', args: { command: 'git push origin main --force' } });
    assert.ok(blocked.block, 'force push must be blocked');

    const rmrf = await runner.dispatch({ event: 'tool_call', toolName: 'bash', args: { command: 'rm -rf /tmp/x' } });
    assert.ok(rmrf.block, 'rm -rf must be blocked');

    const safe = await runner.dispatch({ event: 'tool_call', toolName: 'bash', args: { command: 'npm test' } });
    assert.ok(!safe.block, 'npm test must pass through');
  });

  it('git-tools registers git_status and git_diff as parallel tools', async () => {
    const runner = makeRunner();
    await runner.load(createBuiltinExtensions().filter((e) => e.id === 'git-tools'));
    const names = runner.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['git_diff', 'git_status']);
    assert.ok(runner.tools.every((t) => t.executionMode === 'parallel'));
    // git_status errors cleanly outside a git repo (isError, no throw).
    const status = runner.tools.find((t) => t.name === 'git_status');
    const result = await status.execute('c1', {}, { signal: new AbortController().signal });
    assert.ok(result.isError || typeof result.content === 'string');
  });
});
