import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blenderHardwareInfo } from '../../shared/blender-hardware.ts';
import { DEFAULT_SCENE, sceneSchema } from '../../shared/design-3d.ts';
import { BLENDER_SCRIPT, BLENDER_SCRIPT_HEAD, BLENDER_SCRIPT_TAIL } from '../../main/design/blender-script.ts';

test('reports machine resources as information without deriving a Blender budget', () => {
  const gb = 1024 ** 3;
  assert.deepEqual(blenderHardwareInfo(16 * gb, 3 * gb, 12), {
    totalMemoryGB: 16,
    availableMemoryGB: 3,
    logicalCores: 12,
  });
});

test('scene render settings accept high resolution and samples without hardware caps', () => {
  const scene = sceneSchema.parse({
    ...DEFAULT_SCENE,
    render: { ...DEFAULT_SCENE.render, width: 4096, height: 4096, samples: 256 },
  });
  assert.equal(scene.render.width, 4096);
  assert.equal(scene.render.samples, 256);
  assert.doesNotMatch(BLENDER_SCRIPT + BLENDER_SCRIPT_HEAD + BLENDER_SCRIPT_TAIL, /apply_resource_budget|maxRenderEdge|maxVertices|AGENTE_BLENDER_BUDGET/);
});
