import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DomainPack } from '../../shared/domains.ts';
import { operation, projectOperations, reference, positive } from './registry.ts';
import { confinedFile } from './store.ts';
import { withTemp, probe } from './audio.ts';
import { runProcess } from './jobs.ts';

const ffmpegDependency = { id: 'ffmpeg', label: 'FFmpeg', optional: false, docsUrl: 'https://ffmpeg.org/download.html' };
const probeDependency = { id: 'ffprobe', label: 'FFprobe', optional: false, docsUrl: 'https://ffmpeg.org/download.html' };
export const designPack: Omit<DomainPack, 'tools'> = { version: 1, id: 'design', name: 'Visual Design', description: 'Inspect and transform images, extract palettes and edit vector assets locally.', capabilities: ['Images', 'Compositing', 'Palettes', 'SVG', 'Asset variants'], previewTypes: ['image'], dependencies: [] };
export const videoPack: Omit<DomainPack, 'tools'> = { version: 1, id: 'video', name: 'Video', description: 'Inspect footage, build contact sheets and assemble local video deliveries.', capabilities: ['Frames', 'Timeline', 'Captions', 'Assembly', 'Export'], previewTypes: ['video', 'image', 'audio'], dependencies: [ffmpegDependency, probeDependency] };
export const scenePack: Omit<DomainPack, 'tools'> = { version: 1, id: '3d', name: '3D', description: 'Inspect scenes, create procedural geometry and render using local Blender.', capabilities: ['Scene inspection', 'Geometry', 'Materials', 'Lighting', 'Rendering'], previewTypes: ['scene', 'image'], dependencies: [{ id: 'blender', label: 'Blender', optional: false, docsUrl: 'https://www.blender.org/download/' }] };
const create = (domain: string) => operation('create_project', 'Create a persistent local creative project.', 'write', z.object({ title: z.string().min(1).max(200) }), [], async (a, c) => c.store.create(domain, a.title));
const importAsset = (domain: string, kind: 'image' | 'video' | 'scene') => operation('import', 'Import a workspace file into the project without changing the original.', 'write', z.object({ projectId: reference, expectedRevision: z.number().int().nonnegative(), path: z.string().min(1).max(4096) }), [], async (a, c) => {
  const file = await confinedFile(c.workspaceRoot, a.path); const name = path.basename(file); const mime = kind === 'scene' ? 'application/x-blender' : kind === 'video' ? 'video/mp4' : name.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  const asset = await c.store.asset(file, name, kind, mime); const project = await c.store.read(a.projectId);
  if (project.domain !== domain) throw new Error('Project belongs to another domain.');
  return c.store.patch({ projectId: project.id, expectedRevision: a.expectedRevision, label: `Import ${name}`, changes: { assets: [...project.assets.filter(v => v.id !== asset.id), asset] } });
});
export const designOperations = [
  ...projectOperations(), create('design'), importAsset('design', 'image'),
  operation('inspect', 'Read image size, channels, color space, format, and alpha information.', 'read', z.object({ assetId: reference }), [], async (a, c) => { const sharp = (await import('sharp')).default; const asset = await c.store.getAsset(a.assetId); return { asset, metadata: await sharp(asset.path).metadata() }; }),
  operation('transform', 'Create a resized, cropped, rotated or composited PNG/WebP variant with local Sharp processing. Originals remain unchanged.', 'write', z.object({ assetId: reference, width: z.number().int().min(1).max(16384).optional(), height: z.number().int().min(1).max(16384).optional(), crop: z.object({ left: z.number().int().nonnegative(), top: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }).optional(), rotate: z.number().min(-360).max(360).default(0), overlayId: reference.optional(), format: z.enum(['png', 'webp']).default('png') }), [], async (a, c) => withTemp(c, async dir => {
    const sharp = (await import('sharp')).default; const asset = await c.store.getAsset(a.assetId); let image = sharp(asset.path, { limitInputPixels: 100000000 });
    if (a.crop) image = image.extract(a.crop); if (a.rotate) image = image.rotate(a.rotate); if (a.width || a.height) image = image.resize(a.width, a.height, { fit: 'inside', withoutEnlargement: false });
    if (a.overlayId) image = image.composite([{ input: (await c.store.getAsset(a.overlayId)).path }]);
    const output = path.join(dir, `variant.${a.format}`); c.update('Rendering image variant'); await image.toFormat(a.format).toFile(output);
    return c.store.asset(output, `variant.${a.format}`, 'image', `image/${a.format}`, asset.id);
  })),
  operation('palette', 'Extract dominant quantized colors with relative pixel proportions.', 'read', z.object({ assetId: reference, count: z.number().int().min(1).max(16).default(8) }), [], async (a, c) => {
    const sharp = (await import('sharp')).default; const asset = await c.store.getAsset(a.assetId); const { data, info } = await sharp(asset.path).resize(128, 128, { fit: 'inside' }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true }); const counts = new Map<string, number>();
    for (let i = 0; i < data.length; i += info.channels) { const color = `#${[data[i], data[i + 1], data[i + 2]].map(v => (Math.min(255, Math.floor(v / 32) * 32 + 16)).toString(16).padStart(2, '0').slice(-2)).join('')}`; counts.set(color, (counts.get(color) || 0) + 1); }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, a.count).map(([color, count]) => ({ color, proportion: count / (info.width * info.height) }));
  }),
  operation('svg_read', 'Read a local SVG as editable vector source.', 'read', z.object({ assetId: reference }), [], async (a, c) => { const asset = await c.store.getAsset(a.assetId); if (!asset.name.toLowerCase().endsWith('.svg') || asset.bytes > 2 * 1024 * 1024) throw new Error('Select an SVG smaller than 2 MB.'); return { asset, svg: await fs.readFile(asset.path, 'utf8') }; }),
  operation('svg_write', 'Create an SVG vector asset and a local raster preview. External resources and scripts are not allowed.', 'write', z.object({ svg: z.string().min(1).max(2000000), name: z.string().min(1).max(200).default('design.svg') }), [], async (a, c) => withTemp(c, async dir => {
    if (!/<svg[\s>]/i.test(a.svg) || /<script|<foreignObject|<!DOCTYPE|<!ENTITY|\bon\w+\s*=|(?:href|url)\s*[=(][\s"']*(?:https?:|file:|\/\/)/i.test(a.svg)) throw new Error('Use a self-contained SVG without scripts, external references or embedded HTML.');
    const output = path.join(dir, 'design.svg'); await fs.writeFile(output, a.svg); const asset = await c.store.asset(output, `${a.name.replace(/\.svg$/i, '')}.svg`, 'image', 'image/svg+xml');
    const sharp = (await import('sharp')).default; const png = path.join(dir, 'preview.png'); await sharp(output).resize(1200, 1200, { fit: 'inside' }).png().toFile(png); return { asset, preview: await c.store.asset(png, 'vector-preview.png', 'image', 'image/png', asset.id) };
  }))
];
const filterPath = (file: string) => file.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
export const videoOperations = [
  ...projectOperations(), create('video'), importAsset('video', 'video'),
  operation('inspect', 'Read video duration, frame rate, dimensions, codec and audio streams.', 'read', z.object({ assetId: reference }), ['ffprobe'], async (a, c) => { const asset = await c.store.getAsset(a.assetId); return { asset, metadata: await probe(asset.path, c) }; }),
  operation('frames', 'Create a contact sheet of evenly spaced frames from a bounded region.', 'read', z.object({ assetId: reference, start: z.number().nonnegative().default(0), duration: positive.max(3600).default(30), count: z.number().int().min(1).max(64).default(12) }), ['ffmpeg'], async (a, c) => withTemp(c, async dir => {
    const asset = await c.store.getAsset(a.assetId); const output = path.join(dir, 'frames.jpg'); const columns = Math.min(4, a.count);
    await runProcess(await c.binary('ffmpeg'), ['-v', 'error', '-nostdin', '-ss', String(a.start), '-i', asset.path, '-t', String(a.duration), '-vf', `fps=${a.count / a.duration},scale=320:-1,tile=${columns}x${Math.ceil(a.count / columns)}`, '-frames:v', '1', '-y', output], c);
    return { asset: await c.store.asset(output, 'contact-sheet.jpg', 'image', 'image/jpeg', asset.id), times: Array.from({ length: a.count }, (_, i) => a.start + i * a.duration / a.count) };
  })),
  operation('edit', 'Trim a video, replace its audio, apply fade transitions, or burn supplied SRT captions; creates a new MP4.', 'write', z.object({ assetId: reference, start: z.number().nonnegative().default(0), duration: positive.optional(), audioId: reference.optional(), captionsSrt: z.string().max(1000000).optional(), fadeIn: z.number().nonnegative().max(30).default(0), fadeOut: z.number().nonnegative().max(30).default(0) }), ['ffmpeg'], async (a, c) => withTemp(c, async dir => {
    const asset = await c.store.getAsset(a.assetId); const output = path.join(dir, 'edited.mp4'); const args = ['-v', 'error', '-nostdin', '-ss', String(a.start), '-i', asset.path];
    if (a.audioId) args.push('-i', (await c.store.getAsset(a.audioId)).path, '-map', '0:v:0', '-map', '1:a:0', '-shortest');
    if (a.duration) args.push('-t', String(a.duration)); const filters: string[] = [];
    if (a.fadeIn) filters.push(`fade=t=in:st=0:d=${a.fadeIn}`);
    if (a.fadeOut) { if (!a.duration) throw new Error('Set duration when applying an ending fade.'); filters.push(`fade=t=out:st=${Math.max(0, a.duration - a.fadeOut)}:d=${a.fadeOut}`); }
    if (a.captionsSrt) { const captions = path.join(dir, 'captions.srt'); await fs.writeFile(captions, a.captionsSrt); filters.push(`subtitles='${filterPath(captions)}'`); }
    if (filters.length) args.push('-vf', filters.join(',')); args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', '-y', output); c.update('Rendering edited video'); await runProcess(await c.binary('ffmpeg'), args, c);
    return c.store.asset(output, 'edited.mp4', 'video', 'video/mp4', asset.id);
  })),
  operation('assemble', 'Concatenate compatible video clips into one MP4 using normalized local encoding.', 'write', z.object({ assetIds: z.array(reference).min(1).max(100) }), ['ffmpeg'], async (a, c) => withTemp(c, async dir => {
    const list: string[] = [];
    for (const [i, id] of a.assetIds.entries()) { const asset = await c.store.getAsset(id); const file = path.join(dir, `${i}.mp4`); await runProcess(await c.binary('ffmpeg'), ['-v', 'error', '-nostdin', '-i', asset.path, '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1', '-r', '30', '-c:v', 'libx264', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-y', file], c); list.push(`file '${i}.mp4'`); }
    const manifest = path.join(dir, 'clips.txt'); await fs.writeFile(manifest, list.join('\n')); const output = path.join(dir, 'assembly.mp4'); await runProcess(await c.binary('ffmpeg'), ['-v', 'error', '-nostdin', '-f', 'concat', '-safe', '1', '-i', manifest, '-c', 'copy', '-movflags', '+faststart', '-y', output], c, { cwd: dir }); return c.store.asset(output, 'assembly.mp4', 'video', 'video/mp4');
  }))
];
const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const sceneSchema = z.object({ objects: z.array(z.object({ name: z.string().max(100), type: z.enum(['cube', 'sphere', 'cylinder', 'plane', 'torus']), location: vector, scale: vector, color: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]) })).max(1000), camera: z.object({ location: vector, rotation: vector }), lights: z.array(z.object({ type: z.enum(['AREA', 'POINT', 'SUN']), location: vector, energy: z.number().min(0).max(100000) })).max(100), width: z.number().int().min(64).max(4096).default(1024), height: z.number().int().min(64).max(4096).default(768) });
export const sceneOperations = [
  ...projectOperations(), create('3d'), importAsset('3d', 'scene'),
  operation('inspect', 'Inspect objects, materials, camera and geometry statistics in a .blend scene without running its embedded scripts.', 'read', z.object({ assetId: reference }), ['blender'], async (a, c) => withTemp(c, async dir => {
    const asset = await c.store.getAsset(a.assetId); const script = path.join(dir, 'inspect.py'); const result = path.join(dir, 'scene.json');
    await fs.writeFile(script, `import bpy,json,sys\njson.dump({'objects':[{'name':o.name,'type':o.type,'location':list(o.location),'vertices':len(o.data.vertices) if o.type=='MESH' else 0,'materials':[m.name for m in o.data.materials if m] if o.type=='MESH' else []} for o in bpy.data.objects],'camera':bpy.context.scene.camera.name if bpy.context.scene.camera else None},open(sys.argv[-1],'w'))\n`);
    await runProcess(await c.binary('blender'), ['--background', '--disable-autoexec', asset.path, '--python', script, '--', result], c); return JSON.parse(await fs.readFile(result, 'utf8'));
  })),
  operation('render', 'Create a procedural Blender scene from typed geometry/material/camera/light parameters, save .blend and render a PNG locally.', 'write', sceneSchema, ['blender'], async (a, c) => withTemp(c, async dir => {
    const input = path.join(dir, 'input.json'); const script = path.join(dir, 'render.py'); const blend = path.join(dir, 'scene.blend'); const png = path.join(dir, 'render.png'); await fs.writeFile(input, JSON.stringify(a));
    await fs.writeFile(script, `import bpy,json,sys\nfrom mathutils import Vector\nc=json.load(open(sys.argv[-3]));bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)\nops={'cube':bpy.ops.mesh.primitive_cube_add,'sphere':bpy.ops.mesh.primitive_uv_sphere_add,'cylinder':bpy.ops.mesh.primitive_cylinder_add,'plane':bpy.ops.mesh.primitive_plane_add,'torus':bpy.ops.mesh.primitive_torus_add}\nfor item in c['objects']:\n ops[item['type']](location=item['location']);o=bpy.context.object;o.name=item['name'];o.scale=item['scale'];m=bpy.data.materials.new(item['name']+' material');m.diffuse_color=item['color'];o.data.materials.append(m)\nbpy.ops.object.camera_add(location=c['camera']['location']);camera=bpy.context.object;camera.rotation_euler=c['camera']['rotation'];bpy.context.scene.camera=camera\nfor item in c['lights']:\n d=bpy.data.lights.new('Light',item['type']);d.energy=item['energy'];o=bpy.data.objects.new('Light',d);bpy.context.collection.objects.link(o);o.location=item['location']\ns=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=32;s.render.resolution_x=c['width'];s.render.resolution_y=c['height'];s.render.resolution_percentage=100;s.render.image_settings.file_format='PNG';s.render.filepath=sys.argv[-1];bpy.ops.wm.save_as_mainfile(filepath=sys.argv[-2]);bpy.ops.render.render(write_still=True)\n`);
    c.update('Rendering Blender scene'); await runProcess(await c.binary('blender'), ['--background', '--factory-startup', '--disable-autoexec', '--python', script, '--', input, blend, png], c);
    return { scene: await c.store.asset(blend, 'scene.blend', 'scene', 'application/x-blender'), preview: await c.store.asset(png, 'render.png', 'image', 'image/png') };
  }))
];
