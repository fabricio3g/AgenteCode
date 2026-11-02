/** Fixed program: scene data never becomes Python source or a filesystem path. */
export const BLENDER_SCRIPT = String.raw`
import bpy, json, math, os, sys
from mathutils import Vector
source, output, do_render = sys.argv[sys.argv.index('--') + 1:]
with open(source, encoding='utf-8') as f:
    data = json.load(f)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
def rgba(hex):
    values = [int(hex[i:i+2], 16) / 255 for i in (1,3,5)]
    return tuple(v/12.92 if v <= 0.04045 else ((v+0.055)/1.055)**2.4 for v in values) + (1,)
def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()
materials = {}
for spec in data['materials']:
    mat = bpy.data.materials.new(spec['id'])
    mat.diffuse_color = rgba(spec['color'])
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = mat.diffuse_color
    bsdf.inputs['Metallic'].default_value = spec['metallic']
    bsdf.inputs['Roughness'].default_value = spec['roughness']
    materials[spec['id']] = mat
for spec in data['objects']:
    kind = spec['type']
    if kind == 'cube': bpy.ops.mesh.primitive_cube_add()
    elif kind == 'sphere': bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24)
    elif kind == 'cylinder': bpy.ops.mesh.primitive_cylinder_add(vertices=48)
    elif kind == 'cone': bpy.ops.mesh.primitive_cone_add(vertices=48)
    elif kind == 'torus': bpy.ops.mesh.primitive_torus_add(major_segments=64, minor_segments=24)
    elif kind == 'plane': bpy.ops.mesh.primitive_plane_add()
    elif kind == 'text':
        bpy.ops.object.text_add()
        bpy.context.object.data.body = spec.get('text', '')
    elif kind == 'mesh':
        mesh = bpy.data.meshes.new(spec['id'])
        mesh.from_pydata(spec['vertices'], [], spec['faces'])
        mesh.update()
        obj = bpy.data.objects.new(spec['id'], mesh)
        bpy.context.collection.objects.link(obj)
        bpy.context.view_layer.objects.active = obj
    obj = bpy.context.object
    obj.name = spec['id']
    obj.location = spec['position']
    obj.rotation_euler = [math.radians(v) for v in spec['rotation']]
    obj.scale = spec['scale']
    if spec.get('material'): obj.data.materials.append(materials[spec['material']])
    if obj.type == 'MESH':
        if spec['bevel']:
            mod = obj.modifiers.new('Bevel', 'BEVEL')
            mod.width, mod.segments = spec['bevel'], 3
        if spec['smooth']:
            for polygon in obj.data.polygons: polygon.use_smooth = True
    if obj.type == 'FONT':
        bpy.ops.object.convert(target='MESH')
camera_spec = data['camera']
bpy.ops.object.camera_add(location=camera_spec['position'])
camera = bpy.context.object
camera.data.lens = camera_spec['lens']
aim(camera, camera_spec['target'])
scene = bpy.context.scene
scene.camera = camera
for spec in data['lights']:
    bpy.ops.object.light_add(type=spec['type'].upper(), location=spec['position'])
    lamp = bpy.context.object
    lamp.data.energy = spec['energy']
    lamp.data.color = rgba(spec['color'])[:3]
    if spec['type'] == 'area': lamp.data.shape, lamp.data.size = 'DISK', spec['size']
    aim(lamp, spec['target'])
scene.world.use_nodes = True
scene.world.node_tree.nodes.get('Background').inputs[0].default_value = rgba(data['background'])
scene.world.node_tree.nodes.get('Background').inputs[1].default_value = 0.3
settings = data['render']
scene.render.engine = 'CYCLES' if settings['engine'] == 'cycles' else 'BLENDER_EEVEE_NEXT'
scene.cycles.device = 'CPU'
scene.cycles.samples = settings['samples']
scene.render.resolution_x, scene.render.resolution_y = settings['width'], settings['height']
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = os.path.join(output, 'render.png')
scene.view_settings.view_transform = 'AgX'
bpy.ops.export_scene.gltf(filepath=os.path.join(output, 'model.glb'), export_format='GLB', export_cameras=True, export_lights=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(output, 'scene.blend'))
if do_render == '1': bpy.ops.render.render(write_still=True)
print('AGENTE_BLENDER_COMPLETE', flush=True)
`;
