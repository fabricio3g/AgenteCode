import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCENE, DESIGN_3D_TOOL, RENDER_VIEWS, sceneSchema } from '../../shared/design-3d.ts';
import { SCRIPT_LIMIT, screenScript } from '../../shared/design-script.ts';

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
    { ...DEFAULT_SCENE, objects: [{ id: 'object', type: 'cube', material: 'missing' }] },
    { ...DEFAULT_SCENE, objects: [{ id: 'asset', type: 'cube', asset: 'polyhaven:Chair' }] }
  ]) assert.equal(sceneSchema.safeParse(scene).success, false);
});

test('a scene can carry modifier stacks, curves, a framed camera and several views', () => {
  const scene = sceneSchema.parse({
    camera: { frame: 'all', lens: 70 },
    lighting: { preset: 'product', strength: 1.4 },
    render: { views: ['three_quarter', 'side'] },
    materials: [{ id: 'shell', color: '#aabbcc', preset: 'brushed_metal', bump: { type: 'voronoi', scale: 40 } }],
    objects: [
      { id: 'Body', type: 'cube', material: 'shell', modifiers: [{ type: 'subdivision' }, { type: 'boolean', target: 'Cut' }] },
      { id: 'Cut', type: 'sphere', position: [1, 0, 0] },
      { id: 'Handle', type: 'curve', spline: 'bezier', points: [[0, 0, 0], [0, 1, 1]], bevel_depth: 0.05 }
    ]
  });
  assert.equal(scene.objects[0].modifiers[0].render, 2);
  assert.equal(scene.objects[0].modifiers[1].operation, 'difference');
  assert.equal(scene.objects[2].bevel_depth, 0.05);
  assert.equal(scene.materials[0].bump.scale, 40);
  assert.equal(scene.lighting.preset, 'product');
  assert.equal(scene.camera.frame, 'all');
  assert.deepEqual(scene.render.views, ['three_quarter', 'side']);
  assert.deepEqual(RENDER_VIEWS, ['three_quarter', 'front', 'side', 'top']);
});

test('modifier, curve and parent mistakes fail before Blender starts', () => {
  for (const objects of [
    [{ id: 'A', type: 'cube', modifiers: [{ type: 'boolean', target: 'Missing' }] }],
    [{ id: 'A', type: 'cube', modifiers: [{ type: 'boolean', target: 'A' }] }],
    [{ id: 'A', type: 'curve', points: [[0, 0, 0]] }],
    [{ id: 'A', type: 'cube', parent: 'A' }],
    [{ id: 'A', type: 'cube', parent: 'Missing' }],
    [{ id: 'A', type: 'cube', modifiers: [{ type: 'unknown' }] }]
  ]) assert.equal(sceneSchema.safeParse({ objects }).success, false);
  assert.equal(sceneSchema.safeParse({ objects: [{ id: 'A', type: 'cube' }], camera: { frame: 'Missing' } }).success, false);
});

test('free scripting is screened before it reaches Blender', () => {
  assert.equal(screenScript('import bpy\nbpy.ops.mesh.primitive_cube_add()').ok, true);
  assert.match(screenScript('import subprocess').reason, /network or process/);
  assert.match(screenScript('import socket').reason, /network or process/);
  assert.match(screenScript('os.system("ls")').reason, /another program/);
  assert.match(screenScript('import ctypes').reason, /network or process/);
  assert.equal(screenScript('   ').ok, false);
  assert.equal(screenScript('x'.repeat(SCRIPT_LIMIT + 1)).ok, false);
  assert.equal(DESIGN_3D_TOOL.parameters.properties.action.enum.includes('script'), true);
  assert.equal(DESIGN_3D_TOOL.parameters.properties.python.type, 'string');
});
