#!/usr/bin/env python3
"""Build the small, deterministic, body-local G1 asset used by the floating stage.

Run with /tmp/lsite_tools/venv/bin/python tools/build_g1_model.py.
Source files are read only; no MuJoCo runtime or network access is needed.
"""

from pathlib import Path
import json
import xml.etree.ElementTree as ET

import fast_simplification
import numpy as np
import trimesh


SOURCE = Path('/tmp/lsite_tools/menagerie/unitree_g1')
OUTPUT = Path(__file__).resolve().parents[1] / 'assets' / 'models'
MAX_TRIANGLES = 72_000
MIN_TRIANGLES = 160


def vector(value, fallback, size):
    result = np.asarray([float(x) for x in (value or fallback).split()])
    if result.shape != (size,) or not np.isfinite(result).all():
        raise ValueError(f'Invalid {size}-vector: {value}')
    return result


def rotation(quat):
    if np.linalg.norm(quat) == 0:
        raise ValueError('Zero quaternion')
    return trimesh.transformations.quaternion_matrix(quat)[:3, :3]


def defaults(root):
    """Resolve nested MuJoCo default classes without losing inherited attributes."""
    classes = {}

    def visit(element, inherited):
        merged = {tag: attrs.copy() for tag, attrs in inherited.items()}
        for child in element:
            if child.tag != 'default':
                merged.setdefault(child.tag, {}).update(child.attrib)
        classes[element.get('class', '')] = merged
        for child in element.findall('default'):
            visit(child, merged)

    for element in root.findall('default'):
        visit(element, {})
    return classes


def attributes(element, classes, childclass):
    result = classes.get(element.get('class', childclass), {}).get(element.tag, {}).copy()
    result.update(element.attrib)
    return result


def weld(vertices, faces, grid=0.0002):
    """Weld near-duplicates on a 0.2 mm grid, below a gutter display pixel.

    This also removes CAD tessellation slivers which otherwise block decimation.
    Keep the first original coordinate rather than snapping the visible surface.
    """
    _, first, inverse = np.unique(np.round(vertices / grid), axis=0,
                                  return_index=True, return_inverse=True)
    vertices = vertices[first]
    faces = inverse[faces]
    valid = ((faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2])
             & (faces[:, 2] != faces[:, 0]))
    faces = faces[valid]
    _, unique = np.unique(np.sort(faces, axis=1), axis=0, return_index=True)
    faces = faces[np.sort(unique)]
    return np.ascontiguousarray(vertices), np.ascontiguousarray(faces, dtype=np.int32)


def crease_normals(vertices, faces):
    """Split vertex normals at 35 degrees without optional graph dependencies."""
    normals = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]],
                       vertices[faces[:, 2]] - vertices[faces[:, 0]])
    lengths = np.linalg.norm(normals, axis=1)
    faces, normals, lengths = faces[lengths > 1e-14], normals[lengths > 1e-14], lengths[lengths > 1e-14]
    normals /= lengths[:, None]
    buckets = [[] for _ in vertices]
    split_positions, sums, split_faces = [], [], []
    threshold = np.cos(np.radians(35))
    for face, normal in zip(faces, normals):
        split_face = []
        for vertex in face:
            candidates = buckets[vertex]
            index = next((i for i in candidates
                          if np.dot(sums[i], normal) >= threshold * np.linalg.norm(sums[i])), None)
            if index is None:
                index = len(split_positions)
                candidates.append(index)
                split_positions.append(vertices[vertex])
                sums.append(normal.copy())
            else:
                sums[index] += normal
            split_face.append(index)
        split_faces.append(split_face)
    normals = np.asarray(sums)
    normals /= np.linalg.norm(normals, axis=1)[:, None]
    return np.asarray(split_positions), np.asarray(split_faces), normals


def budgets(counts):
    """Proportional allocation, with small bodies pinned to the per-part floor."""
    if any(count < MIN_TRIANGLES for count in counts):
        raise ValueError('A source body has fewer than the minimum triangle floor')
    if sum(counts) <= MAX_TRIANGLES:
        return counts
    if len(counts) * MIN_TRIANGLES > MAX_TRIANGLES:
        raise ValueError('The minimum per-body budgets exceed the robot budget')
    result = [None] * len(counts)
    remaining = set(range(len(counts)))
    available = MAX_TRIANGLES
    while remaining:
        total = sum(counts[i] for i in remaining)
        small = [i for i in sorted(remaining) if available * counts[i] / total < MIN_TRIANGLES]
        if small:
            for i in small:
                result[i] = MIN_TRIANGLES
                remaining.remove(i)
                available -= MIN_TRIANGLES
            continue
        shares = {i: available * counts[i] / total for i in sorted(remaining)}
        for i, share in shares.items():
            result[i] = int(share)
        spare = available - sum(result[i] for i in remaining)
        order = sorted(remaining, key=lambda i: (-(shares[i] - result[i]), i))
        for i in order[:spare]:
            result[i] += 1
        break
    return result


def main():
    root = ET.parse(SOURCE / 'g1.xml').getroot()
    compiler = root.find('compiler')
    if compiler is not None and compiler.get('angle', 'degree') != 'radian':
        raise ValueError('Expected radian joint ranges')
    meshdir = SOURCE / (compiler.get('meshdir', '') if compiler is not None else '')
    classes = defaults(root)
    assets = {}
    for element in root.findall('./asset/mesh'):
        attrs = attributes(element, classes, '')
        name = attrs.get('name', Path(attrs['file']).stem)
        if name in assets:
            raise ValueError(f'Duplicate mesh name: {name}')
        assets[name] = attrs

    pelvis = root.find('./worldbody/body[@name="pelvis"]')
    if pelvis is None:
        raise ValueError('No pelvis under worldbody')
    standing_height = vector(pelvis.get('pos'), '0 0 0', 3)[2]
    stand = root.find('./keyframe/key[@name="stand"]')
    if stand is not None and stand.get('qpos'):
        standing_height = float(stand.get('qpos').split()[2])
    if standing_height <= 0:
        raise ValueError('Standing pelvis height must be positive')
    bodies, meshes = [], []
    visual_count, skipped_count = 0, 0

    def visit(element, parent, inherited_class):
        nonlocal visual_count, skipped_count
        childclass = element.get('childclass', inherited_class)
        body = {'name': element.attrib['name'], 'parent': parent,
                'pos': vector(element.get('pos'), '0 0 0', 3).tolist(),
                'quat': vector(element.get('quat'), '1 0 0 0', 4).tolist(),
                'joint': None, 'mesh': None}
        # Store pelvis at the origin; standingPelvisHeight supplies its world height.
        if parent == -1:
            body['pos'] = [0.0, 0.0, 0.0]
        rotation(np.asarray(body['quat']))
        joints = element.findall('joint')
        if len(joints) > 1:
            raise ValueError(f'Multiple joints in body {body["name"]}')
        if joints:
            joint = attributes(joints[0], classes, childclass)
            if joint.get('type', 'hinge') != 'hinge':
                raise ValueError('Only hinge joints fit the asset contract')
            if np.any(vector(joint.get('pos'), '0 0 0', 3)):
                raise ValueError('Nonzero joint pivots need an extended asset contract')
            axis = vector(joint.get('axis'), '0 0 1', 3)
            if not np.linalg.norm(axis):
                raise ValueError('Joint axis is zero')
            limits = vector(joint.get('range'), '', 2)
            if limits[0] > limits[1]:
                raise ValueError('Reversed joint range')
            body['joint'] = {'name': joint['name'], 'axis': (axis / np.linalg.norm(axis)).tolist(),
                             'range': limits.tolist()}
        index = len(bodies)
        bodies.append(body)
        parts = {'body': [], 'joint': []}
        head_parts = []
        for geom in element.findall('geom'):
            attrs = attributes(geom, classes, childclass)
            # In g1.xml visual inherits group=2, contype=conaffinity=0;
            # collision/foot inherits group=3 and is deliberately excluded.
            visual = (attrs.get('type') == 'mesh' and attrs.get('group') == '2'
                      and attrs.get('contype') == '0' and attrs.get('conaffinity') == '0')
            if not visual:
                skipped_count += 1
                continue
            mesh_attrs = assets[attrs['mesh']]
            mesh = trimesh.load_mesh(meshdir / mesh_attrs['file'], process=False)
            if not isinstance(mesh, trimesh.Trimesh) or not len(mesh.faces):
                raise ValueError(f'Empty or invalid mesh: {mesh_attrs["file"]}')
            vertices = np.asarray(mesh.vertices) * vector(mesh_attrs.get('scale'), '1 1 1', 3)
            vertices = vertices @ rotation(vector(attrs.get('quat'), '1 0 0 0', 4)).T
            vertices += vector(attrs.get('pos'), '0 0 0', 3)
            if not np.isfinite(vertices).all():
                raise ValueError('Mesh contains non-finite positions')
            surface = 'joint' if attrs.get('material') == 'black' else 'body'
            if attrs['mesh'] == 'head_link':
                head_parts.append((vertices, np.asarray(mesh.faces)))
            else:
                parts[surface].append((vertices, np.asarray(mesh.faces)))
            visual_count += 1
        body_parts = []
        for surface, items in parts.items():
            if not items:
                continue
            vertices, faces, offset = [], [], 0
            for points, triangles in items:
                vertices.append(points)
                faces.append(triangles + offset)
                offset += len(points)
            points, triangles = weld(np.concatenate(vertices), np.concatenate(faces))
            body_parts.append((surface, points, triangles))
        meshes.append(body_parts)
        if head_parts:
            # Menagerie fixes the head visual to the torso. Give only that visual
            # a body node at its base; this introduces no fictitious neck joint.
            if len(head_parts) != 1:
                raise ValueError('Expected one G1 head visual')
            points, triangles = head_parts[0]
            pivot = (points.min(axis=0) + points.max(axis=0)) / 2
            pivot[2] = points[:, 2].min()
            points, triangles = weld(points - pivot, triangles)
            bodies.append({'name': 'head_link', 'parent': index, 'pos': pivot.tolist(),
                           'quat': [1.0, 0.0, 0.0, 0.0], 'joint': None, 'mesh': None})
            meshes.append([('joint', points, triangles)])
        for child in element.findall('body'):
            visit(child, index, childclass)

    visit(pelvis, -1, '')
    # Allocate from welded faces; the small hands and pelvis contour retain a floor.
    counts = [len(faces) for parts in meshes for _, _, faces in parts]
    allocation = iter(budgets(counts))
    positions, normals, indices = [], [], []
    vertex_offset, index_offset, total_triangles = 0, 0, 0
    largest_body = 0
    print(f'Visual selection: group 2 mesh geoms, contype=0, conaffinity=0; '
          f'{visual_count} included, {skipped_count} collision/foot geoms skipped')
    print(f'{len(bodies)} bodies, {sum(body["joint"] is not None for body in bodies)} joints; '
          f'standing pelvis height {standing_height:g} m')
    for body, parts in zip(bodies, meshes):
        if not parts:
            print(f'  {body["name"]}: no visual mesh')
            continue
        body_vertices, body_indices = 0, 0
        groups = []
        for surface, vertices, faces in parts:
            original = len(faces)
            target = next(allocation)
            if len(faces) > target:
                source_vertices, source_faces = vertices, faces
                for grid in (0.0002, 0.0005, 0.001, 0.002):
                    vertices, faces = weld(source_vertices, source_faces, grid)
                    if len(faces) > target:
                        vertices, faces = fast_simplification.simplify(vertices, faces, target_count=target)
                    if len(faces) <= target:
                        break
            if not MIN_TRIANGLES <= len(faces) <= target:
                raise ValueError(f'Simplifier missed budget for {body["name"]}: {len(faces)} / {target}')
            vertices, faces, vertex_normals = crease_normals(vertices, faces)
            if not len(faces) or np.max(faces) >= len(vertices) or np.min(faces) < 0:
                raise ValueError('Mesh indices exceed vertex bounds')
            groups.append({'start': body_indices, 'count': faces.size, 'material': surface})
            positions.append(np.asarray(vertices, dtype='<f4').ravel())
            normals.append(np.asarray(vertex_normals, dtype='<f4').ravel())
            indices.append((faces + body_vertices).ravel())
            body_vertices += len(vertices)
            body_indices += faces.size
            total_triangles += len(faces)
            print(f'  {body["name"]} ({surface}): {original} -> {len(faces)} triangles (budget {target})')
        body['mesh'] = {'vStart': vertex_offset, 'vCount': body_vertices,
                        'iStart': index_offset, 'iCount': body_indices, 'groups': groups}
        largest_body = max(largest_body, body_vertices)
        vertex_offset += body_vertices
        index_offset += body_indices
    index_type = 'uint16' if largest_body <= 65536 else 'uint32'
    index_dtype = '<u2' if index_type == 'uint16' else '<u4'
    position_data = np.concatenate(positions).tobytes()
    normal_data = np.concatenate(normals).tobytes()
    index_data = np.asarray(np.concatenate(indices), dtype=index_dtype).tobytes()
    data = position_data + normal_data + index_data
    if not 60_000 <= total_triangles <= 90_000 or len(data) > 2_621_440:
        raise ValueError(f'Model exceeds triangle or byte budget: {total_triangles}, {len(data)}')
    result = {'source': 'MuJoCo Menagerie unitree_g1 (BSD-3-Clause)', 'up': 'z', 'units': 'm',
              'standingPelvisHeight': standing_height, 'bodies': bodies,
              'positions': {'byteOffset': 0, 'count': len(position_data) // 4, 'type': 'float32'},
              'normals': {'byteOffset': len(position_data), 'count': len(normal_data) // 4,
                          'type': 'float32', 'creaseAngle': 35},
              'indices': {'byteOffset': len(position_data) + len(normal_data),
                          'count': len(index_data) // np.dtype(index_dtype).itemsize, 'type': index_type}}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'g1.bin').write_bytes(data)
    (OUTPUT / 'g1.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    print(f'Total: {total_triangles} triangles')
    for name in ('g1.json', 'g1.bin'):
        print(f'{name}: {(OUTPUT / name).stat().st_size} bytes')


if __name__ == '__main__':
    main()
