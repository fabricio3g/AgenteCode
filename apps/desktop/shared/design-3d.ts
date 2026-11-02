/** Declarative 3D scene. Main validates this before the trusted Blender script reads it. */
import { z } from 'zod';

const number = z.number().finite();
const vec = z.tuple([number.min(-10000).max(10000), number.min(-10000).max(10000), number.min(-10000).max(10000)]);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const id = z.string().regex(/^[\w -]{1,80}$/);
export const sceneSchema = z.object({
  title: z.string().max(160).default('Untitled scene'),
  background: color.default('#ece8e2'),
  materials: z.array(z.object({
    id, color, metallic: number.min(0).max(1).default(0), roughness: number.min(0).max(1).default(0.45)
  }).strict()).max(64).default([]),
  objects: z.array(z.object({
    id, type: z.enum(['cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'text', 'mesh']),
    position: vec.default([0, 0, 0]), rotation: vec.default([0, 0, 0]),
    scale: z.tuple([number.positive().max(1000), number.positive().max(1000), number.positive().max(1000)]).default([1, 1, 1]),
    material: id.optional(), text: z.string().max(1000).optional(),
    bevel: number.min(0).max(10).default(0), smooth: z.boolean().default(false),
    vertices: z.array(vec).max(10000).optional(),
    faces: z.array(z.array(z.number().int().min(0).max(9999)).min(3).max(16)).max(10000).optional()
  }).strict()).min(1).max(200),
  camera: z.object({ position: vec.default([7, -9, 7]), target: vec.default([0, 0, 0]), lens: number.min(10).max(200).default(50) }).strict().default({ position: [7, -9, 7], target: [0, 0, 0], lens: 50 }),
  lights: z.array(z.object({
    type: z.enum(['area', 'point', 'sun']), position: vec, target: vec.default([0, 0, 0]),
    color: color.default('#ffffff'), energy: number.min(0).max(10000).default(1000), size: number.min(0.01).max(100).default(5)
  }).strict()).max(16).default([{ type: 'area', position: [3, -4, 7], target: [0, 0, 0], color: '#ffffff', energy: 1000, size: 5 }]),
  render: z.object({
    width: z.number().int().min(128).max(2048).default(1024), height: z.number().int().min(128).max(2048).default(1024),
    engine: z.enum(['eevee', 'cycles']).default('eevee'), samples: z.number().int().min(1).max(128).default(32)
  }).strict().default({ width: 1024, height: 1024, engine: 'eevee', samples: 32 })
}).strict().superRefine((scene, ctx) => {
  for (const [kind, items] of [['objects', scene.objects], ['materials', scene.materials]] as const) {
    if (new Set(items.map(item => item.id)).size !== items.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${kind} IDs` });
  }
  const materials = new Set(scene.materials.map(material => material.id));
  for (const object of scene.objects) {
    if (object.material && !materials.has(object.material)) ctx.addIssue({ code: 'custom', message: `Unknown material: ${object.material}` });
    if (object.type === 'mesh' && (!object.vertices?.length || !object.faces?.length || object.faces.some(face => face.some(index => index >= object.vertices!.length)))) ctx.addIssue({ code: 'custom', message: `Invalid mesh: ${object.id}` });
  }
});
export type DesignScene = z.infer<typeof sceneSchema>;
export interface BlenderState {
  available: boolean; executable?: string; installing?: boolean;
  busy: boolean; jobId?: string; phase?: string; log?: string; error?: string;
  scene?: DesignScene; model?: boolean; render?: boolean; updatedAt?: number;
}
export const DEFAULT_SCENE: DesignScene = sceneSchema.parse({
  title: 'Studio', materials: [{ id: 'clay', color: '#c98c70' }, { id: 'floor', color: '#e9e4dc' }],
  objects: [
    { id: 'Sculpture', type: 'torus', position: [0, 0, 1.3], rotation: [65, 15, 20], material: 'clay', smooth: true },
    { id: 'Plinth', type: 'cylinder', position: [0, 0, 0.25], scale: [1.4, 1.4, 0.25], material: 'clay', bevel: 0.08, smooth: true },
    { id: 'Ground', type: 'plane', scale: [200, 200, 1], material: 'floor' }
  ]
});

export const DESIGN_3D_TOOL = {
  name: 'design_3d',
  description: 'Create and revise a Blender scene, export an interactive GLB model, and render PNG images. Uses the locally installed Blender engine. Call status first; if unavailable tell the user to install/choose Blender in the 3D panel. No downloads or arbitrary Python via this tool. Read scene.json with design_read to revise an existing scene. Coordinates are Blender Z-up, rotation in degrees. Primitives have default diameter/size 2 before scale; torus major radius 1. Camera and lights look at target. Render returns an image for vision models.',
  parameters: {
    type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'build', 'render'] },
      scene: z.toJSONSchema(sceneSchema, { io: 'input' }),
      render: { type: 'boolean', description: 'Also render a PNG after building; default true. Use false for fast modeling iterations.' }
    }, required: ['action']
  }
};
