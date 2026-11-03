/** Declarative 3D scene. Main validates this before the trusted Blender program reads it. */
import { z } from 'zod';

const number = z.number().finite();
const vec = z.tuple([number.min(-10000).max(10000), number.min(-10000).max(10000), number.min(-10000).max(10000)]);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const id = z.string().regex(/^[\w -]{1,80}$/);
/** One step of an object's modifier stack, in the order it is listed. */
export const modifierSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subdivision'), viewport: z.number().int().min(0).max(6).default(1),
    render: z.number().int().min(0).max(6).default(2)
  }).strict(),
  z.object({
    type: z.literal('bevel'), width: number.min(0).max(100).default(0.02),
    segments: z.number().int().min(1).max(12).default(2), angle: number.min(0).max(180).default(30)
  }).strict(),
  z.object({ type: z.literal('solidify'), thickness: number.min(0.001).max(100).default(0.05), offset: number.min(-1).max(1).default(-1) }).strict(),
  z.object({ type: z.literal('mirror'), axis: z.enum(['x', 'y', 'z']).default('x'), bisect: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('array'), count: z.number().int().min(1).max(200).default(2), offset: vec.default([0, 0, 1.2]) }).strict(),
  z.object({
    type: z.literal('displace'), strength: number.min(-100).max(100).default(0.2),
    size: number.min(0.001).max(100).default(0.5), direction: z.enum(['normal', 'x', 'y', 'z']).default('normal')
  }).strict(),
  z.object({ type: z.literal('wireframe'), thickness: number.min(0.001).max(10).default(0.02) }).strict(),
  z.object({ type: z.literal('remesh'), voxel: number.min(0.001).max(10).default(0.08) }).strict(),
  z.object({
    type: z.literal('screw'), angle: number.min(1).max(3600).default(360),
    steps: z.number().int().min(2).max(512).default(48), axis: z.enum(['x', 'y', 'z']).default('z')
  }).strict(),
  z.object({
    type: z.literal('boolean'), operation: z.enum(['difference', 'union', 'intersect']).default('difference'),
    target: id
  }).strict()
]);
export type Modifier = z.infer<typeof modifierSchema>;

/** Named surface recipes the fixed node graph understands, so the model does not invent nodes. */
export const MATERIAL_PRESETS = ['painted_metal', 'matte_plastic', 'brushed_metal', 'glass', 'ceramic', 'fabric', 'wood', 'stone'] as const;

const materialSchema = z.object({
  id, color,
  metallic: number.min(0).max(1).default(0), roughness: number.min(0).max(1).default(0.45),
  preset: z.enum(MATERIAL_PRESETS).optional(),
  emission: z.object({ color: color.default('#ffffff'), strength: number.min(0).max(100).default(1) }).strict().optional(),
  transmission: number.min(0).max(1).default(0),
  coat: number.min(0).max(1).default(0),
  alpha: number.min(0).max(1).default(1),
  bump: z.object({
    type: z.enum(['noise', 'voronoi', 'wave']).default('noise'),
    scale: number.min(0.1).max(200).default(24), strength: number.min(0).max(2).default(0.25)
  }).strict().optional()
}).strict();

export const OBJECT_TYPES = ['cube', 'sphere', 'ico_sphere', 'cylinder', 'cone', 'torus', 'plane', 'circle', 'grid', 'text', 'mesh', 'curve'] as const;
export const RENDER_VIEWS = ['three_quarter', 'front', 'side', 'top'] as const;
export const LIGHTING_PRESETS = ['studio_softbox', 'product', 'archviz_sun', 'dramatic_rim', 'flat', 'custom'] as const;

const objectSchema = z.object({
  id,
  type: z.enum(OBJECT_TYPES),
  position: vec.default([0, 0, 0]), rotation: vec.default([0, 0, 0]),
  scale: z.tuple([number.positive().max(1000), number.positive().max(1000), number.positive().max(1000)]).default([1, 1, 1]),
  material: id.optional(), text: z.string().max(1000).optional(),
  bevel: number.min(0).max(10).default(0), smooth: z.boolean().default(false),
  /** Shorthand applied first; `modifiers` runs after it, in order. */
  modifiers: z.array(modifierSchema).max(12).default([]),
  vertices: z.array(vec).max(10000).optional(),
  faces: z.array(z.array(z.number().int().min(0).max(9999)).min(3).max(16)).max(10000).optional(),
  /** Curve geometry: a spline through `points` with a round bevel, for tubes, cables and handles. */
  spline: z.enum(['bezier', 'nurbs', 'poly']).default('bezier'),
  points: z.array(vec).max(256).default([]),
  cyclic: z.boolean().default(false),
  bevel_depth: number.min(0).max(10).default(0.02),
  resolution: z.number().int().min(1).max(64).default(12),
  parent: id.optional(),
  collection: z.string().regex(/^[\w -]{1,80}$/).optional(),
  /** Repeated copies along a line, a grid or a circle. */
  instances: z.object({
    count: z.number().int().min(1).max(200).default(2),
    distribution: z.enum(['line', 'grid', 'radial']).default('line'),
    spacing: vec.default([1.2, 0, 0]), radius: number.min(0).max(1000).default(3)
  }).strict().optional()
}).strict();
export type SceneObject = z.infer<typeof objectSchema>;

export const sceneSchema = z.object({
  title: z.string().max(160).default('Untitled scene'),
  background: color.default('#ece8e2'),
  unit: z.enum(['m', 'cm']).default('m'),
  materials: z.array(materialSchema).max(64).default([]),
  objects: z.array(objectSchema).min(1).max(200),
  camera: z.object({
    position: vec.default([7, -9, 7]), target: vec.default([0, 0, 0]),
    lens: number.min(10).max(200).default(50),
    /** Frame these objects instead of `position`/`target`: an object id or `all`. */
    frame: z.string().max(80).optional(),
    ortho: z.boolean().default(false), ortho_scale: number.min(0.1).max(1000).default(6)
  }).strict().default({ position: [7, -9, 7], target: [0, 0, 0], lens: 50, ortho: false, ortho_scale: 6 }),
  lighting: z.object({
    preset: z.enum(LIGHTING_PRESETS).default('studio_softbox'),
    strength: number.min(0).max(10).default(1)
  }).strict().default({ preset: 'studio_softbox', strength: 1 }),
  /** Literal lights, added on top of the preset (or alone with `preset: 'custom'`). */
  lights: z.array(z.object({
    type: z.enum(['area', 'point', 'sun']), position: vec, target: vec.default([0, 0, 0]),
    color: color.default('#ffffff'), energy: number.min(0).max(10000).default(1000), size: number.min(0.01).max(100).default(5)
  }).strict()).max(16).default([]),
  render: z.object({
    width: z.number().int().min(128).default(1024), height: z.number().int().min(128).default(1024),
    engine: z.enum(['eevee', 'cycles']).default('eevee'), samples: z.number().int().min(1).default(32),
    views: z.array(z.enum(RENDER_VIEWS)).max(4).default(['three_quarter'])
  }).strict().default({ width: 1024, height: 1024, engine: 'eevee', samples: 32, views: ['three_quarter'] })
}).strict().superRefine((scene, ctx) => {
  const duplicate = (kind: string, values: string[]) => {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${kind} IDs` });
  };
  duplicate('objects', scene.objects.map(object => object.id));
  duplicate('materials', scene.materials.map(material => material.id));
  const materials = new Set(scene.materials.map(material => material.id));
  const objects = new Map(scene.objects.map(object => [object.id, object]));
  for (const object of scene.objects) {
    if (object.material && !materials.has(object.material)) ctx.addIssue({ code: 'custom', message: `Unknown material: ${object.material}` });
    if (object.type === 'mesh' && (!object.vertices?.length || !object.faces?.length || object.faces.some(face => face.some(index => index >= object.vertices!.length)))) {
      ctx.addIssue({ code: 'custom', message: `Invalid mesh: ${object.id}` });
    }
    if (object.type === 'curve' && object.points.length < 2) ctx.addIssue({ code: 'custom', message: `Curve needs at least two points: ${object.id}` });
    for (const modifier of object.modifiers) {
      if (modifier.type !== 'boolean') continue;
      if (modifier.target === object.id) ctx.addIssue({ code: 'custom', message: `Boolean cannot target itself: ${object.id}` });
      else if (!objects.has(modifier.target)) ctx.addIssue({ code: 'custom', message: `Unknown boolean target: ${modifier.target}` });
    }
    let parent = object.parent;
    const seen = new Set([object.id]);
    while (parent) {
      if (seen.has(parent)) { ctx.addIssue({ code: 'custom', message: `Parent loop: ${object.id}` }); break; }
      seen.add(parent);
      const next = objects.get(parent);
      if (!next) { ctx.addIssue({ code: 'custom', message: `Unknown parent: ${parent}` }); break; }
      parent = next.parent;
    }
  }
  if (scene.camera.frame && scene.camera.frame !== 'all' && !objects.has(scene.camera.frame)) {
    ctx.addIssue({ code: 'custom', message: `Unknown camera frame: ${scene.camera.frame}` });
  }
});
export type DesignScene = z.infer<typeof sceneSchema>;
export type SceneMaterial = z.infer<typeof materialSchema>;

/** What `inspect` reports about a built scene, so the model can check its work without a render. */
export interface SceneInspection {
  objects: { name: string; type: string; triangles: number; material?: string }[];
  materials: string[];
  triangles: number;
  bounds: [number, number, number] | null;
}
export interface BlenderState {
  available: boolean; executable?: string; installing?: boolean;
  busy: boolean; jobId?: string; phase?: string; log?: string; error?: string;
  scene?: DesignScene; model?: boolean; render?: boolean; views?: string[];
  inspection?: SceneInspection; scriptAllowed?: boolean;
  hardware?: import('./blender-hardware').BlenderHardwareInfo;
  updatedAt?: number;
}
export const DEFAULT_SCENE: DesignScene = sceneSchema.parse({
  title: 'Studio', materials: [{ id: 'clay', color: '#c98c70', preset: 'ceramic' }, { id: 'floor', color: '#e9e4dc', preset: 'stone' }],
  lighting: { preset: 'studio_softbox', strength: 1 },
  camera: { position: [7, -9, 7], target: [0, 0, 1.2], lens: 60, frame: 'Sculpture', ortho: false, ortho_scale: 6 },
  render: { width: 1024, height: 1024, engine: 'eevee', samples: 32, views: ['three_quarter'] },
  objects: [
    {
      id: 'Sculpture', type: 'torus', position: [0, 0, 1.3], rotation: [65, 15, 20], material: 'clay', smooth: true,
      modifiers: [{ type: 'subdivision', viewport: 1, render: 2 }]
    },
    {
      id: 'Plinth', type: 'cylinder', position: [0, 0, 0.25], scale: [1.4, 1.4, 0.25], material: 'clay',
      bevel: 0.08, smooth: true, modifiers: [{ type: 'bevel', width: 0.04, segments: 3, angle: 30 }]
    },
    { id: 'Ground', type: 'plane', scale: [200, 200, 1], material: 'floor' }
  ]
});

export const DESIGN_3D_TOOL = {
  name: 'design_3d',
  description: `Create and revise a Blender scene, export an interactive GLB model, and render PNG images from several angles. Uses the locally installed Blender engine. Call status first; if unavailable tell the user to install/choose Blender in the 3D panel. Read scene.json with design_read to revise a declarative scene. Coordinates are Blender Z-up, rotation in degrees, primitives have default size 2 before scale.
Objects: primitives (cube, sphere, ico_sphere, cylinder, cone, torus, plane, circle, grid, text), custom indexed meshes and curves (bezier/nurbs/poly spline through points with a round bevel: tubes, cables, handles, wire).
A primitive alone is a placeholder: build real objects with a modifier stack (subdivision, bevel, solidify, mirror, array, displace, wireframe, remesh, screw, boolean difference/union/intersect against another object id), and use curves for anything tube-like.
Materials carry color, metallic, roughness, transmission, coat, alpha, emission and a procedural bump; use one material per real material and the presets for believable surfaces. Lighting presets (studio_softbox, product, archviz_sun, dramatic_rim, flat) are a starting rig; add literal lights only to adjust.
Camera.frame ('all' or an object id) frames the subject automatically. render.views picks the angles rendered; inspect reports what was actually built. Prefer render:false while modelling, then render the views and fix the silhouette before adding detail.
When the declarative scene cannot express the request (particles and hair, cloth or soft bodies, geometry nodes, shaders, sculpting, procedural textures, an image the user attached used as texture or displacement), use action script with Blender Python. Scripts start in an empty scene with helpers (rgba, aim, add_area, add_sun, studio, frame_camera), the design references folder in references, and output as the only writable directory; a fixed tail exports model.glb, scene.blend and the view PNGs. The user enables free scripting in the 3D panel, so if it is refused ask them to turn it on.`,
  parameters: {
    type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'build', 'render', 'inspect', 'script'] },
      scene: z.toJSONSchema(sceneSchema, { io: 'input' }),
      python: { type: 'string', description: 'For script: complete Blender Python for the scene. The scene starts empty and output/references are ready. No network or process calls.' },
      render: { type: 'boolean', description: 'Also render PNG views after building; default true. Use false for fast modelling iterations.' },
      views: {
        type: 'array', items: { type: 'string', enum: RENDER_VIEWS },
        description: 'Angles to render, overriding scene.render.views (build) or the default three_quarter (script).'
      }
    }, required: ['action']
  }
};
