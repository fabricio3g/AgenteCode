const GB = 1024 ** 3;
export interface BlenderHardwareBudget {
  totalMemoryGB: number; availableMemoryGB: number; logicalCores: number;
  threads: number; reserveBytes: number; canStart: boolean;
  maxRenderEdge: number; maxSamples: number; maxVertices: number;
}
/** Small pure calculation: no benchmark, GPU probe, subprocess or allocation. */
export function blenderBudget(total: number, free: number, cores: number): BlenderHardwareBudget {
  const reserveBytes = Math.max(2 * GB, Math.min(6 * GB, total * 0.3));
  const constrained = total < 16 * GB || free < 6 * GB;
  return {
    totalMemoryGB: Math.round(total / GB * 10) / 10,
    availableMemoryGB: Math.round(free / GB * 10) / 10,
    logicalCores: cores, threads: Math.max(1, Math.min(2, Math.floor(cores / 4))),
    reserveBytes, canStart: free >= reserveBytes + GB,
    maxRenderEdge: constrained ? 512 : 1024, maxSamples: constrained ? 16 : 32,
    maxVertices: constrained ? 250_000 : 750_000
  };
}

export const BLENDER_RESOURCE_SCRIPT = String.raw`
import bpy, json, os
hardware = json.loads(os.environ.get('AGENTE_BLENDER_BUDGET', '{}'))
def apply_resource_budget(scene):
    edge = hardware.get('maxRenderEdge', 512)
    largest = max(scene.render.resolution_x, scene.render.resolution_y, 1)
    scale = min(1.0, edge / largest)
    scene.render.resolution_x = max(64, int(scene.render.resolution_x * scale))
    scene.render.resolution_y = max(64, int(scene.render.resolution_y * scale))
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = hardware.get('threads', 1)
    # Keep the display GPU available to the desktop; no assumed VRAM capacity.
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = min(scene.cycles.samples, hardware.get('maxSamples', 16))
    scene.render.use_persistent_data = False
    scene.render.use_simplify = True
    scene.render.simplify_subdivision = 1
    scene.render.simplify_subdivision_render = 2
    vertices = sum(len(mesh.vertices) for mesh in bpy.data.meshes)
    if vertices > hardware.get('maxVertices', 250000):
        raise RuntimeError('Scene exceeds the hardware vertex budget. Use instances and reduce geometry before retrying.')
    for obj in scene.objects:
        for modifier in obj.modifiers:
            if modifier.type == 'SUBSURF':
                modifier.levels = min(modifier.levels, 1)
                modifier.render_levels = min(modifier.render_levels, 2)
`;
