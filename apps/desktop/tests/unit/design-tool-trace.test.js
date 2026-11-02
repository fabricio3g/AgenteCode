import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDesignToolStep, finishDesignToolStep, traceText } from '../../renderer/src/lib/features/design/design-tool-trace.ts';

test('a Design tool exposes its arguments while it runs, then its result and duration', () => {
  const step = startDesignToolStep('call-a','design_write','Write',{path:'index.html',content:'<h1>Hello</h1>'},100);
  assert.equal(step.status,'running'); assert.equal(step.detail,'index.html');
  assert.equal(JSON.parse(step.toolInput).content,'<h1>Hello</h1>');
  finishDesignToolStep(step,'Wrote index.html',false,850);
  assert.equal(step.status,'done'); assert.equal(step.output,'Wrote index.html'); assert.equal(step.durationMs,750);
});
test('Blender and failed calls retain their own identities and failure details', () => {
  const step=startDesignToolStep('call-b','design_3d','Blender',{action:'script',python:'import bpy'},200);
  assert.equal(step.toolName,'design_3d'); assert.equal(step.detail,'script');
  finishDesignToolStep(step,'Not enough free RAM',true,400);
  assert.equal(step.status,'error'); assert.equal(step.output,'Not enough free RAM');
});
test('large input and output traces stay bounded', () => {
  const text=traceText('x'.repeat(1_000_000));
  assert(text.length<33_000); assert(text.endsWith('… truncated'));
});
