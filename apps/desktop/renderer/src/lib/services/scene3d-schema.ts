import { z } from 'zod';

/**
 * Declarative wire format for `create_scene_3d`.
 *
 * Models can either pick a domain preset (`dna`, `molecule`, `orbit`,
 * `exploded_stack`, `surface`) with custom labels/layers, or describe any
 * spatial structure directly with `nodes`, `edges`, and `planes`.
 */

const node3dSchema = z.object({
  id: z.string().min(1).optional(),
  x: z.coerce.number(),
  y: z.coerce.number(),
  z: z.coerce.number(),
  label: z.string().optional(),
  radius: z.coerce.number().positive().max(32).optional(),
  accent: z.boolean().optional()
}).passthrough();

const edge3dSchema = z.object({
  from: z.union([z.coerce.number().int().nonnegative(), z.string().min(1)]),
  to: z.union([z.coerce.number().int().nonnegative(), z.string().min(1)]),
  accent: z.boolean().optional()
}).passthrough();

const layer3dSchema = z.object({
  label: z.string().min(1),
  accent: z.boolean().optional()
}).passthrough();

export const scene3dArgsSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  preset: z.enum(['dna', 'molecule', 'orbit', 'exploded_stack', 'surface', 'custom']).default('custom'),
  paramLabel: z.string().optional(),
  paramValue: z.coerce.number().min(0).max(100).optional(),
  takeaway: z.string().optional(),
  layers: z.array(layer3dSchema).max(8).optional(),
  nodes: z.array(node3dSchema).max(120).optional(),
  edges: z.array(edge3dSchema).max(240).optional(),
  autoRotate: z.boolean().optional(),
  path: z.string().min(1).optional()
}).passthrough();

export function repairScene3dArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  const rawPreset = String(args.preset ?? '').trim().toLowerCase();
  if (rawPreset === 'stack' || rawPreset === 'layers' || rawPreset === 'architecture') out.preset = 'exploded_stack';
  else if (rawPreset === 'orbits' || rawPreset === 'solar' || rawPreset === 'planets') out.preset = 'orbit';
  else if (rawPreset === 'wave' || rawPreset === 'terrain' || rawPreset === 'mesh') out.preset = 'surface';
  else if (rawPreset === 'helix') out.preset = 'dna';
  else if (rawPreset === 'ch4' || rawPreset === 'atom' || rawPreset === 'atoms') out.preset = 'molecule';
  else if (!rawPreset) out.preset = Array.isArray(args.layers) ? 'exploded_stack' : Array.isArray(args.nodes) ? 'custom' : 'surface';

  if (Array.isArray(args.layers)) {
    out.layers = args.layers.map((entry) =>
      typeof entry === 'string' ? { label: entry } : entry
    );
  }
  return out;
}
