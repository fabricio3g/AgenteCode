import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeModelLists } from '../../main/providers/model-list-merge.ts';

test('live models first, then unlisted, then retired', () => {
  const merged = mergeModelLists(['glm-5.3', 'deepseek-v4-flash'], [
    { id: 'deepseek-v4-flash', status: 'active' },
    { id: 'glm-4.6', status: 'deprecated' },
    { id: 'kimi-k2.5', status: 'active' }
  ]);
  assert.deepEqual(merged.map((m) => [m.id, m.availability]), [
    ['deepseek-v4-flash', 'live'],
    ['glm-5.3', 'live'],
    ['kimi-k2.5', 'catalog'],
    ['glm-4.6', 'retired']
  ]);
});

test('a vendor-prefixed live id matches its bare catalog id', () => {
  const merged = mergeModelLists(['deepseek/deepseek-v4-flash'], [{ id: 'deepseek-v4-flash', status: 'active' }]);
  assert.equal(merged.length, 1);
});
