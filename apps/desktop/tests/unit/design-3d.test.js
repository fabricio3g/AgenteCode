import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCENE, DESIGN_3D_TOOL, sceneSchema } from '../../shared/design-3d.ts';

test('3D scenes and tool schema accept modeling, materials and render settings', () => {
  assert.equal(sceneSchema.parse(DEFAULT_SCENE).objects.length, 3);
  assert.equal(DESIGN_3D_TOOL.parameters.properties.scene.type, 'object');
  const scene = sceneSchema.parse({ objects: [{ id: 'Chair', type: 'mesh', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] }] });
  assert.equal(scene.render.engine, 'eevee');
  assert.deepEqual(scene.objects[0].scale, [1, 1, 1]);
});

test('3D scenes reject executable code, filesystem paths, invalid geometry and excessive renders', () => {
  for (const scene of [
    { ...DEFAULT_SCENE, python: 'import os' },
    { ...DEFAULT_SCENE, output: '../../outside' },
    { ...DEFAULT_SCENE, objects: [{ id: 'Mesh', type: 'mesh', vertices: [[0, 0, 0]], faces: [[0, 1, 2]] }] },
    { ...DEFAULT_SCENE, objects: [DEFAULT_SCENE.objects[0], DEFAULT_SCENE.objects[0]] },
    { ...DEFAULT_SCENE, render: { width: 100000 } },
    { ...DEFAULT_SCENE, materials: [{ id: 'clay', color: 'file:///secret' }] },
    { ...DEFAULT_SCENE, objects: [{ id: 'object', type: 'cube', material: 'missing' }] }
  ]) assert.equal(sceneSchema.safeParse(scene).success, false);
});
