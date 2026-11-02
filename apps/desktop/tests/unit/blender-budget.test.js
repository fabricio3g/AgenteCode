import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blenderBudget, BLENDER_RESOURCE_SCRIPT } from '../../shared/blender-budget.ts';
const GB = 1024 ** 3;
test('budgets leave RAM and CPU for the desktop instead of using every core', () => {
  const small=blenderBudget(8*GB,5*GB,4);
  assert.equal(small.canStart,true); assert.equal(small.threads,1);
  assert.equal(small.maxRenderEdge,512); assert.equal(small.maxSamples,16);
  assert(small.reserveBytes>=2*GB);
  const large=blenderBudget(64*GB,32*GB,32);
  assert.equal(large.threads,2); assert.equal(large.maxRenderEdge,1024);
  assert.equal(large.maxSamples,32); assert(large.reserveBytes>=6*GB);
});
test('low free memory refuses another job even on a large machine', () => {
  assert.equal(blenderBudget(32*GB,2*GB,16).canStart,false);
  assert.equal(blenderBudget(8*GB,2*GB,4).canStart,false);
  assert.equal(blenderBudget(8*GB,5*GB,1).threads,1);
});
test('fixed Blender wrapper enforces CPU rendering, samples and geometry limits', () => {
  assert.match(BLENDER_RESOURCE_SCRIPT,/scene\.cycles\.device = 'CPU'/);
  assert.match(BLENDER_RESOURCE_SCRIPT,/maxRenderEdge/);
  assert.match(BLENDER_RESOURCE_SCRIPT,/maxVertices/);
});
