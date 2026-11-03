/**
 * Fixed programs: scene data never becomes Python source or a filesystem path.
 * Build args after `--`: scene.json, output directory, render flag.
 */
export const BLENDER_SCRIPT = String.raw`
import bpy, json, math, os, sys, shutil
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
source, output, do_render = argv[0], argv[1], argv[2]
with open(source, encoding='utf-8') as handle:
    data = json.load(handle)

# --- Empty scene -------------------------------------------------------------
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for blocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.textures):
    for block in list(blocks):
        if block.users == 0:
            blocks.remove(block)

def rgba(hex_value):
    channels = [int(hex_value[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in channels]
    return tuple(linear) + (1.0,)

def set_input(bsdf, name, value):
    socket = bsdf.inputs.get(name)
    if socket is not None:
        socket.default_value = value

def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()

# --- Materials ---------------------------------------------------------------
PRESETS = {
    'painted_metal': {'metallic': 0.55, 'roughness': 0.38, 'coat': 0.15},
    'matte_plastic': {'roughness': 0.62},
    'brushed_metal': {'metallic': 1.0, 'roughness': 0.3},
    'glass': {'transmission': 0.95, 'roughness': 0.06, 'ior': 1.45},
    'ceramic': {'roughness': 0.3, 'coat': 0.3},
    'fabric': {'roughness': 0.93},
    'wood': {'roughness': 0.55},
    'stone': {'roughness': 0.78},
}
materials = {}
for spec in data['materials']:
    mat = bpy.data.materials.new(spec['id'])
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get('Principled BSDF')
    preset = PRESETS.get(spec.get('preset') or '', {})
    base = rgba(spec['color'])
    mat.diffuse_color = base
    set_input(bsdf, 'Base Color', base)
    set_input(bsdf, 'Metallic', preset.get('metallic', spec['metallic']))
    set_input(bsdf, 'Roughness', preset.get('roughness', spec['roughness']))
    set_input(bsdf, 'IOR', preset.get('ior', 1.45))
    set_input(bsdf, 'Transmission Weight', max(spec['transmission'], preset.get('transmission', 0.0)))
    set_input(bsdf, 'Coat Weight', max(spec['coat'], preset.get('coat', 0.0)))
    set_input(bsdf, 'Alpha', spec['alpha'])
    if spec['alpha'] < 1.0 and hasattr(mat, 'surface_render_method'):
        mat.surface_render_method = 'BLENDED'
    if spec.get('emission'):
        set_input(bsdf, 'Emission Color', rgba(spec['emission']['color']))
        set_input(bsdf, 'Emission Strength', spec['emission']['strength'])
    bump = spec.get('bump')
    if bump:
        kind = {'noise': 'ShaderNodeTexNoise', 'voronoi': 'ShaderNodeTexVoronoi', 'wave': 'ShaderNodeTexWave'}[bump['type']]
        texture = nodes.new(kind)
        texture.location = (-620, -260)
        set_input(texture, 'Scale', bump['scale'])
        height = texture.outputs.get('Fac') or texture.outputs.get('Distance')
        bump_node = nodes.new('ShaderNodeBump')
        bump_node.location = (-320, -260)
        set_input(bump_node, 'Strength', bump['strength'])
        links.new(height, bump_node.inputs['Height'])
        links.new(bump_node.outputs['Normal'], bsdf.inputs['Normal'])
    materials[spec['id']] = mat

# --- Objects -----------------------------------------------------------------
objects = {}
def primitive(kind):
    if kind == 'cube': bpy.ops.mesh.primitive_cube_add(size=2)
    elif kind == 'sphere': bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=1)
    elif kind == 'ico_sphere': bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1)
    elif kind == 'cylinder': bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=1, depth=2)
    elif kind == 'cone': bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=1, radius2=0, depth=2)
    elif kind == 'torus': bpy.ops.mesh.primitive_torus_add(major_radius=1, minor_radius=0.28, major_segments=64, minor_segments=24)
    elif kind == 'plane': bpy.ops.mesh.primitive_plane_add(size=2)
    elif kind == 'circle': bpy.ops.mesh.primitive_circle_add(vertices=64, radius=1, fill_type='NGON')
    elif kind == 'grid': bpy.ops.mesh.primitive_grid_add(x_subdivisions=24, y_subdivisions=24, size=2)

def make_curve(spec):
    curve = bpy.data.curves.new(spec['id'], 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = spec['resolution']
    curve.bevel_depth = spec['bevel_depth']
    curve.bevel_resolution = 4
    curve.use_fill_caps = True
    points = spec['points']
    if spec['spline'] == 'bezier':
        spline = curve.splines.new('BEZIER')
        spline.bezier_points.add(len(points) - 1)
        for point, co in zip(spline.bezier_points, points):
            point.co = co
            point.handle_left_type = 'AUTO'
            point.handle_right_type = 'AUTO'
    else:
        spline = curve.splines.new('NURBS' if spec['spline'] == 'nurbs' else 'POLY')
        spline.points.add(len(points) - 1)
        for point, co in zip(spline.points, points):
            point.co = (co[0], co[1], co[2], 1.0)
        if spec['spline'] == 'nurbs':
            spline.order_u = min(4, len(points))
            spline.use_endpoint_u = True
    spline.use_cyclic_u = spec['cyclic']
    obj = bpy.data.objects.new(spec['id'], curve)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    return obj

for spec in data['objects']:
    kind = spec['type']
    if kind == 'mesh':
        mesh = bpy.data.meshes.new(spec['id'])
        mesh.from_pydata(spec['vertices'], [], spec['faces'])
        mesh.update()
        obj = bpy.data.objects.new(spec['id'], mesh)
        bpy.context.collection.objects.link(obj)
        bpy.context.view_layer.objects.active = obj
    elif kind == 'curve':
        obj = make_curve(spec)
    elif kind == 'text':
        bpy.ops.object.text_add()
        text = bpy.context.object
        text.data.body = spec.get('text', '')
        text.data.align_x = 'CENTER'
        text.data.align_y = 'CENTER'
        bpy.ops.object.convert(target='MESH')
        obj = bpy.context.object
    else:
        primitive(kind)
        obj = bpy.context.object
    obj.name = spec['id']
    obj.location = spec['position']
    obj.rotation_euler = [math.radians(value) for value in spec['rotation']]
    obj.scale = spec['scale']
    if spec['material'] and spec['material'] in materials:
        obj.data.materials.append(materials[spec['material']])
    if spec['smooth'] and obj.type == 'MESH':
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    objects[spec['id']] = obj

# --- Modifier stacks (after every object exists, so booleans can resolve) -----
for spec in data['objects']:
    obj = objects[spec['id']]
    if obj.type not in {'MESH', 'CURVE', 'FONT'}:
        continue
    if spec['bevel']:
        mod = obj.modifiers.new('Bevel', 'BEVEL')
        mod.width, mod.segments = spec['bevel'], 2
        mod.limit_method, mod.angle_limit = 'ANGLE', math.radians(40)
    for item in spec['modifiers']:
        kind = item['type']
        if kind == 'subdivision':
            mod = obj.modifiers.new('Subdivision', 'SUBSURF')
            mod.levels, mod.render_levels = item['viewport'], max(item['render'], item['viewport'])
        elif kind == 'bevel':
            mod = obj.modifiers.new('Bevel', 'BEVEL')
            mod.width, mod.segments = item['width'], item['segments']
            mod.limit_method, mod.angle_limit = 'ANGLE', math.radians(item['angle'])
        elif kind == 'solidify':
            mod = obj.modifiers.new('Solidify', 'SOLIDIFY')
            mod.thickness, mod.offset = item['thickness'], item['offset']
        elif kind == 'mirror':
            mod = obj.modifiers.new('Mirror', 'MIRROR')
            axis = {'x': 0, 'y': 1, 'z': 2}[item['axis']]
            mod.use_axis = [axis == 0, axis == 1, axis == 2]
            if item['bisect']:
                mod.use_bisect_axis = [axis == 0, axis == 1, axis == 2]
        elif kind == 'array':
            mod = obj.modifiers.new('Array', 'ARRAY')
            mod.count = item['count']
            mod.use_relative_offset = False
            mod.use_constant_offset = True
            mod.constant_offset_displace = item['offset']
        elif kind == 'displace':
            texture = bpy.data.textures.new(spec['id'] + 'Displace', 'CLOUDS')
            texture.noise_scale = item['size']
            mod = obj.modifiers.new('Displace', 'DISPLACE')
            mod.texture = texture
            mod.strength = item['strength']
            mod.texture_coords = 'LOCAL'
            if item['direction'] != 'normal':
                mod.direction = item['direction'].upper()
        elif kind == 'wireframe':
            mod = obj.modifiers.new('Wireframe', 'WIREFRAME')
            mod.thickness = item['thickness']
        elif kind == 'remesh':
            mod = obj.modifiers.new('Remesh', 'REMESH')
            mod.mode, mod.voxel_size = 'VOXEL', item['voxel']
        elif kind == 'screw':
            mod = obj.modifiers.new('Screw', 'SCREW')
            mod.angle = math.radians(item['angle'])
            mod.steps = item['steps']
            mod.axis = item['axis'].upper()
        elif kind == 'boolean':
            target = objects.get(item['target'])
            if target is None:
                continue
            mod = obj.modifiers.new('Boolean', 'BOOLEAN')
            mod.operation = item['operation'].upper()
            mod.solver = 'EXACT'
            mod.object = target

# --- Parenting, collections, repeated copies ---------------------------------
for spec in data['objects']:
    obj = objects[spec['id']]
    if spec['parent'] and spec['parent'] in objects:
        parent = objects[spec['parent']]
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
    if spec.get('collection'):
        name = spec['collection']
        collection = bpy.data.collections.get(name)
        if collection is None:
            collection = bpy.data.collections.new(name)
            bpy.context.scene.collection.children.link(collection)
        for member in [obj]:
            for holder in list(member.users_collection):
                holder.objects.unlink(member)
            collection.objects.link(member)

def copy_object(obj):
    copy = obj.copy()
    if obj.data is not None:
        copy.data = obj.data
    bpy.context.scene.collection.objects.link(copy)
    return copy

for spec in data['objects']:
    instances = spec.get('instances')
    if not instances or instances['count'] <= 1:
        continue
    obj = objects[spec['id']]
    count = instances['count']
    step = instances['spacing']
    side = max(1, math.ceil(math.sqrt(count)))
    for index in range(1, count):
        copy = copy_object(obj)
        if instances['distribution'] == 'radial':
            angle = 2 * math.pi * index / count
            offset = (math.cos(angle) * instances['radius'], math.sin(angle) * instances['radius'], step[2] * index)
        elif instances['distribution'] == 'grid':
            offset = (step[0] * (index % side), step[1] * (index // side), 0.0)
        else:
            offset = (step[0] * index, step[1] * index, step[2] * index)
        copy.location = (
            obj.location[0] + offset[0],
            obj.location[1] + offset[1],
            obj.location[2] + offset[2]
        )

# --- Subject bounds ----------------------------------------------------------
def object_corners(obj):
    corners = []
    if obj.type == 'EMPTY':
        for child in obj.children:
            corners.extend(object_corners(child))
        if not corners:
            corners.append(obj.matrix_world @ Vector((0, 0, 0)))
        return corners
    for corner in obj.bound_box:
        corners.append(obj.matrix_world @ Vector(corner))
    return corners

def subject(name):
    if name == 'all':
        chosen = [obj for obj in objects.values() if max(obj.scale) < 50]
    else:
        chosen = [objects[name]] if name in objects else []
    corners = []
    for obj in chosen:
        corners.extend(object_corners(obj))
    if not corners:
        return Vector((0, 0, 0)), 2.0
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return (lo + hi) / 2, max((hi - lo).length / 2, 0.05)

focus, radius = subject('all')

# --- Lighting ----------------------------------------------------------------
def add_area(location, energy, size, color='#ffffff'):
    bpy.ops.object.light_add(type='AREA', location=location)
    lamp = bpy.context.object
    lamp.data.shape = 'DISK'
    lamp.data.size = size
    lamp.data.energy = energy
    lamp.data.color = rgba(color)[:3]
    aim(lamp, focus)
    return lamp

def add_sun(direction, energy, color='#fff4e2'):
    bpy.ops.object.light_add(type='SUN', location=focus + direction.normalized() * radius * 8)
    lamp = bpy.context.object
    lamp.data.energy = energy
    lamp.data.color = rgba(color)[:3]
    aim(lamp, focus)
    return lamp

lighting = data['lighting']
strength = lighting['strength']
world_strength = 0.35
scale = max(radius, 0.4)
power = strength * scale * scale
preset = lighting['preset']
if preset == 'studio_softbox':
    add_area(focus + Vector((-1.7, -1.9, 2.0)) * scale, 320 * power, 2.2 * scale, '#fff2e4')
    add_area(focus + Vector((2.1, -1.3, 0.9)) * scale, 90 * power, 2.6 * scale, '#e8f1ff')
    add_area(focus + Vector((-0.4, 2.3, 1.6)) * scale, 190 * power, 1.8 * scale)
    world_strength = 0.3
elif preset == 'product':
    add_area(focus + Vector((-1.4, -1.6, 1.6)) * scale, 240 * power, 3.0 * scale, '#ffffff')
    add_area(focus + Vector((0.2, 2.2, 1.2)) * scale, 120 * power, 2.0 * scale, '#ffffff')
    add_area(focus + Vector((1.8, -0.4, 0.4)) * scale, 70 * power, 2.4 * scale)
    world_strength = 0.55
elif preset == 'archviz_sun':
    add_sun(Vector((0.6, -0.7, 1.0)), 3.2 * strength)
    add_area(focus + Vector((0.0, 0.0, 3.2)) * scale, 120 * power, 4.0 * scale, '#dbeaff')
    world_strength = 0.85
elif preset == 'dramatic_rim':
    add_area(focus + Vector((2.2, 1.6, 1.4)) * scale, 260 * power, 1.2 * scale, '#cfe0ff')
    add_area(focus + Vector((-2.0, 1.8, 1.0)) * scale, 200 * power, 1.2 * scale, '#ffe2cf')
    add_area(focus + Vector((0.0, -1.6, 0.3)) * scale, 35 * power, 1.6 * scale)
    world_strength = 0.12
elif preset == 'flat':
    add_area(focus + Vector((-0.4, -2.4, 1.8)) * scale, 260 * power, 3.4 * scale, '#ffffff')
    add_area(focus + Vector((0.4, -2.2, 0.6)) * scale, 220 * power, 3.0 * scale, '#ffffff')
    world_strength = 0.9

for spec in data['lights']:
    bpy.ops.object.light_add(type=spec['type'].upper(), location=spec['position'])
    lamp = bpy.context.object
    lamp.data.energy = spec['energy']
    lamp.data.color = rgba(spec['color'])[:3]
    if spec['type'] == 'area':
        lamp.data.shape, lamp.data.size = 'DISK', spec['size']
    aim(lamp, spec['target'])

# --- Camera, world, render settings -----------------------------------------
camera_spec = data['camera']
bpy.ops.object.camera_add(location=camera_spec['position'])
camera = bpy.context.object
camera.data.lens = camera_spec['lens']
aim(camera, camera_spec['target'])
scene = bpy.context.scene
scene.camera = camera

focus = Vector(camera_spec['target'])
distance = (Vector(camera_spec['position']) - focus).length or 10.0
ortho_scale = camera_spec['ortho_scale']
if camera_spec.get('frame'):
    focus, size = subject(camera_spec['frame'])
    fov = 2 * math.atan(18.0 / camera_spec['lens'])
    distance = size / math.tan(fov / 2) * 1.5
    ortho_scale = max(ortho_scale, size * 2.6)

DIRECTIONS = {
    'three_quarter': Vector((1.0, -1.0, 0.55)),
    'front': Vector((0.0, -1.0, 0.08)),
    'side': Vector((1.0, 0.0, 0.08)),
    'top': Vector((0.0, -0.0001, 1.0)),
}

def place_camera(view):
    camera.location = focus + DIRECTIONS[view].normalized() * distance
    aim(camera, focus)
    camera.data.type = 'ORTHO' if camera_spec['ortho'] else 'PERSP'
    if camera_spec['ortho']:
        camera.data.ortho_scale = ortho_scale

scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 0.01 if data['unit'] == 'cm' else 1.0
scene.world.use_nodes = True
background = scene.world.node_tree.nodes.get('Background')
background.inputs[0].default_value = rgba(data['background'])
background.inputs[1].default_value = world_strength * max(strength, 0.2)

settings = data['render']
scene.render.engine = 'CYCLES' if settings['engine'] == 'cycles' else 'BLENDER_EEVEE_NEXT'
scene.cycles.samples = settings['samples']
scene.render.resolution_x, scene.render.resolution_y = settings['width'], settings['height']
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'

place_camera('three_quarter')
bpy.ops.export_scene.gltf(
    filepath=os.path.join(output, 'model.glb'), export_format='GLB',
    export_cameras=True, export_lights=True, export_apply=True
)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(output, 'scene.blend'))

views = settings.get('views') or ['three_quarter']
os.makedirs(os.path.join(output, 'views'), exist_ok=True)
rendered = []
for view in views:
    place_camera(view)
    path = os.path.join(output, 'views', view + '.png')
    scene.render.filepath = path
    if do_render == '1':
        bpy.ops.render.render(write_still=True)
        if os.path.isfile(path):
            rendered.append(path)
if rendered:
    shutil.copyfile(rendered[0], os.path.join(output, 'render.png'))
print('AGENTE_BLENDER_COMPLETE', flush=True)
`;

/**
 * Introspection: reads the built .blend without running embedded scripts and
 * reports what the scene actually contains.
 * Args after `--`: .blend file, result JSON path.
 */
export const BLENDER_INSPECT_SCRIPT = String.raw`
import bpy, json, sys
from mathutils import Vector

blend, result = sys.argv[sys.argv.index('--') + 1:][:2]
objects = []
triangles = 0
lo = Vector((1e18, 1e18, 1e18))
hi = Vector((-1e18, -1e18, -1e18))
for obj in bpy.data.objects:
    if obj.type == 'MESH':
        obj.data.calc_loop_triangles()
        count = len(obj.data.loop_triangles)
        triangles += count
        material = obj.data.materials[0].name if obj.data.materials else None
        objects.append({'name': obj.name, 'type': obj.type, 'triangles': count, 'material': material})
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, point.x), min(lo.y, point.y), min(lo.z, point.z)))
            hi = Vector((max(hi.x, point.x), max(hi.y, point.y), max(hi.z, point.z)))
    else:
        objects.append({'name': obj.name, 'type': obj.type, 'triangles': 0})
payload = {
    'objects': objects,
    'materials': [material.name for material in bpy.data.materials],
    'triangles': triangles,
    'bounds': [round(hi.x - lo.x, 4), round(hi.y - lo.y, 4), round(hi.z - lo.z, 4)] if hi.x > lo.x else None
}
with open(result, 'w', encoding='utf-8') as handle:
    json.dump(payload, handle)
print('AGENTE_BLENDER_INSPECTED', flush=True)
`;

/**
 * Head of a free-form job: an empty scene, the helpers a modelling program wants,
 * and the reference folder. The agent's program runs next, unchanged.
 * Args after `--`: output directory, render flag, views JSON, references directory.
 */
export const BLENDER_SCRIPT_HEAD = String.raw`
import bpy, json, math, os, sys, shutil, random
from mathutils import Vector, Euler

argv = sys.argv[sys.argv.index('--') + 1:]
output, do_render, views_json, references = argv[0], argv[1], argv[2], argv[3]
views = json.loads(views_json) or ['three_quarter']

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for blocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.textures):
    for block in list(blocks):
        if block.users == 0:
            blocks.remove(block)

def rgba(hex_value):
    channels = [int(hex_value[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in channels]
    return tuple(linear) + (1.0,)

def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()

def bounds():
    lo = Vector((1e18, 1e18, 1e18))
    hi = Vector((-1e18, -1e18, -1e18))
    found = False
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or max(obj.scale) > 50:
            continue
        found = True
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, point.x), min(lo.y, point.y), min(lo.z, point.z)))
            hi = Vector((max(hi.x, point.x), max(hi.y, point.y), max(hi.z, point.z)))
    if not found:
        return Vector((0, 0, 0)), 2.0
    return (lo + hi) / 2, max((hi - lo).length / 2, 0.05)

def add_area(location, energy=200, size=2, color='#ffffff', target=None):
    bpy.ops.object.light_add(type='AREA', location=location)
    lamp = bpy.context.object
    lamp.data.shape = 'DISK'
    lamp.data.size = size
    lamp.data.energy = energy
    lamp.data.color = rgba(color)[:3]
    aim(lamp, target if target is not None else bounds()[0])
    return lamp

def add_sun(direction=(0.6, -0.7, 1.0), energy=3.0, color='#fff4e2', target=None):
    center, radius = bounds()
    focus = Vector(target) if target is not None else center
    bpy.ops.object.light_add(type='SUN', location=focus + Vector(direction).normalized() * radius * 8)
    lamp = bpy.context.object
    lamp.data.energy = energy
    lamp.data.color = rgba(color)[:3]
    aim(lamp, focus)
    return lamp

def studio(strength=1.0, preset='studio_softbox'):
    center, radius = bounds()
    scale = max(radius, 0.4)
    power = strength * scale * scale
    if preset == 'flat':
        add_area(center + Vector((-0.4, -2.4, 1.8)) * scale, 260 * power, 3.4 * scale, '#ffffff', center)
        add_area(center + Vector((0.4, -2.2, 0.6)) * scale, 220 * power, 3.0 * scale, '#ffffff', center)
        return
    add_area(center + Vector((-1.7, -1.9, 2.0)) * scale, 320 * power, 2.2 * scale, '#fff2e4', center)
    add_area(center + Vector((2.1, -1.3, 0.9)) * scale, 90 * power, 2.6 * scale, '#e8f1ff', center)
    add_area(center + Vector((-0.4, 2.3, 1.6)) * scale, 190 * power, 1.8 * scale, '#ffffff', center)

DIRECTIONS = {
    'three_quarter': Vector((1.0, -1.0, 0.55)),
    'front': Vector((0.0, -1.0, 0.08)),
    'side': Vector((1.0, 0.0, 0.08)),
    'top': Vector((0.0, -0.0001, 1.0)),
}

def frame_camera(view='three_quarter', target=None, distance=None):
    center, radius = bounds()
    if target is not None:
        center = Vector(target)
    camera = bpy.context.scene.camera
    if camera is None:
        bpy.ops.object.camera_add(location=center + Vector((7, -9, 7)))
        camera = bpy.context.object
        bpy.context.scene.camera = camera
    lens = camera.data.lens or 50
    fov = 2 * math.atan(18.0 / lens)
    span = distance if distance is not None else radius / math.tan(fov / 2) * 1.5
    camera.location = center + DIRECTIONS.get(view, DIRECTIONS['three_quarter']).normalized() * span
    aim(camera, center)
    camera.data.type = 'PERSP'
    return camera
`;

/**
 * Tail of a free-form job: the fixed program owns the artifacts, so whatever the
 * agent built still comes back as model.glb, scene.blend and the view PNGs.
 */
export const BLENDER_SCRIPT_TAIL = String.raw`
os.makedirs(os.path.join(output, 'views'), exist_ok=True)
scene = bpy.context.scene
if scene.camera is None:
    frame_camera('three_quarter')
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'AgX'
scene.render.resolution_percentage = 100
reference_camera = scene.camera
reference_matrix = reference_camera.matrix_world.copy()
reference_lens = reference_camera.data.lens
reference_ortho = reference_camera.data.ortho_scale
bpy.ops.export_scene.gltf(
    filepath=os.path.join(output, 'model.glb'), export_format='GLB',
    export_cameras=True, export_lights=True, export_apply=True
)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(output, 'scene.blend'))
rendered = []
for view in views:
    if view == 'three_quarter':
        scene.camera = reference_camera
        reference_camera.matrix_world = reference_matrix.copy()
        reference_camera.data.lens = reference_lens
        reference_camera.data.ortho_scale = reference_ortho
    else:
        frame_camera(view)
    path = os.path.join(output, 'views', view + '.png')
    scene.render.filepath = path
    if do_render == '1':
        bpy.ops.render.render(write_still=True)
        if os.path.isfile(path):
            rendered.append(path)
if rendered:
    shutil.copyfile(rendered[0], os.path.join(output, 'render.png'))
print('AGENTE_BLENDER_COMPLETE', flush=True)
`;
