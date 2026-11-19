import * as THREE from '../../vendor/three.module.min.js';

let modelRequest;
function loadModel() {
  // Cache the source bytes, while each scene owns and disposes its shared geometries.
  if (!modelRequest) modelRequest = Promise.all([
    fetch('assets/models/g1.json').then((response) => {
      if (!response.ok) throw new Error('G1 metadata unavailable.');
      return response.json();
    }),
    fetch('assets/models/g1.bin').then((response) => {
      if (!response.ok) throw new Error('G1 geometry unavailable.');
      return response.arrayBuffer();
    })
  ]).then(([model, buffer]) => {
    if (model.up !== 'z' || model.units !== 'm' || !Number.isFinite(model.standingPelvisHeight) ||
        !Array.isArray(model.bodies) || !model.bodies.length || model.positions.type !== 'float32' ||
        !['uint16', 'uint32'].includes(model.indices.type) || model.normals?.type !== 'float32' ||
        model.normals.count !== model.positions.count) throw new Error('Invalid G1 model.');
    const positions = new Float32Array(buffer, model.positions.byteOffset, model.positions.count);
    const normals = new Float32Array(buffer, model.normals.byteOffset, model.normals.count);
    const IndexArray = model.indices.type === 'uint32' ? Uint32Array : Uint16Array;
    const indices = new IndexArray(buffer, model.indices.byteOffset, model.indices.count);
    if (![...positions, ...normals].every(Number.isFinite)) throw new Error('Non-finite G1 geometry.');
    model.bodies.forEach((body, index) => {
      if (!Number.isInteger(body.parent) || body.parent < -1 || body.parent >= index ||
          (index > 0 && body.parent < 0) || body.pos?.length !== 3 || body.quat?.length !== 4 ||
          ![...body.pos, ...body.quat].every(Number.isFinite)) throw new Error('Invalid G1 body.');
      if (body.joint && (body.joint.axis?.length !== 3 || body.joint.range?.length !== 2 ||
          ![...body.joint.axis, ...body.joint.range].every(Number.isFinite) ||
          Math.hypot(...body.joint.axis) < .001 || body.joint.range[0] > body.joint.range[1])) {
        throw new Error('Invalid G1 joint.');
      }
      if (!body.mesh) return;
      const { vStart, vCount, iStart, iCount } = body.mesh;
      if (![vStart, vCount, iStart, iCount].every((value) => Number.isInteger(value) && value >= 0) ||
          (vStart + vCount) * 3 > positions.length || iStart + iCount > indices.length || iCount % 3) {
        throw new Error('Invalid G1 mesh range.');
      }
      if (!body.mesh.groups?.length || body.mesh.groups.reduce((sum, group) => sum + group.count, 0) !== iCount ||
          body.mesh.groups.some((group, i, groups) => !['body', 'joint'].includes(group.material) ||
            group.start !== (i ? groups[i - 1].start + groups[i - 1].count : 0) ||
            !Number.isInteger(group.count) || group.count <= 0 || group.count % 3)) throw new Error('Invalid G1 material groups.');
      for (let i = iStart; i < iStart + iCount; i++) {
        if (indices[i] >= vCount) throw new Error('Invalid G1 mesh index.');
      }
    });
    return { model, positions, normals, indices };
  });
  return modelRequest;
}

export async function loadG1(ctx) {
  const { model, positions, normals, indices } = await loadModel();
  const geometries = model.bodies.map((body) => {
    if (!body.mesh) return null;
    const { vStart, vCount, iStart, iCount } = body.mesh;
    const geometry = ctx.own(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(vStart * 3, (vStart + vCount) * 3), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals.subarray(vStart * 3, (vStart + vCount) * 3), 3));
    body.mesh.groups.forEach((group) => geometry.addGroup(group.start, group.count, group.material === 'body' ? 0 : 1));
    geometry.setIndex(new THREE.BufferAttribute(indices.subarray(iStart, iStart + iCount), 1));
    return geometry;
  });
  const surfaces = [ctx.material('solid', 'body'), ctx.material('solid', 'joint')];
  const instances = new THREE.Group(), robots = [];
  const batches = geometries.map((geometry) => {
    if (!geometry) return null;
    const mesh = ctx.own(new THREE.InstancedMesh(geometry, surfaces, 10));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    instances.add(mesh);
    return mesh;
  });
  const inverse = new THREE.Matrix4(), matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  function makeRobot(index) {
    const root = new THREE.Group();
    const body = new THREE.Group();
    body.rotation.x = -Math.PI / 2;
    root.add(body);
    const skeleton = new THREE.Group();
    body.add(skeleton);
    const joints = new Map();
    const nodes = model.bodies.map((definition, i) => {
      const node = new THREE.Group();
      node.position.fromArray(definition.pos);
      const [w, x, y, z] = definition.quat;
      node.quaternion.set(x, y, z, w).normalize();
      if (definition.joint) joints.set(definition.joint.name, {
        node, rest: node.quaternion.clone(), axis: new THREE.Vector3(...definition.joint.axis).normalize(),
        range: definition.joint.range, angle: 0
      });
      return node;
    });
    model.bodies.forEach((definition, i) => (definition.parent < 0 ? skeleton : nodes[definition.parent]).add(nodes[i]));
    skeleton.position.z = model.standingPelvisHeight - model.bodies[0].pos[2];
    // Retain the team act's shadow anchor; grounding now uses the shared sun map.
    const shadow = new THREE.Group();
    root.add(shadow);
    const find = (name) => nodes[model.bodies.findIndex((item) => item.name === name)];
    const head = find('head_link');
    if (!head) throw new Error('G1 head visual node missing.');
    const headRest = head.quaternion.clone();
    const yawRotation = new THREE.Quaternion(), pitchRotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 0, 1), lateral = new THREE.Vector3(0, 1, 0);
    const local = new THREE.Vector3(), headPosition = new THREE.Vector3();
    const states = { yaw: { value: 0, velocity: 0 }, pitch: { value: 0, velocity: 0 }, waist: { value: 0, velocity: 0 } };
    let idleTime = index * .7;
    function spring(state, target, dt) {
      if (ctx.reducedMotion) { state.value = target; state.velocity = 0; return; }
      // Analytic critically damped spring, ~250 ms settling, independent of fps.
      const omega = 24, delta = state.value - target, decay = Math.exp(-omega * dt);
      const impulse = state.velocity + omega * delta;
      state.value = target + (delta + impulse * dt) * decay;
      state.velocity = (state.velocity - omega * impulse * dt) * decay;
    }
    const robot = { root, body, skeleton, joints, nodes, shadow,
      resetGaze() {
        for (const state of Object.values(states)) state.value = state.velocity = 0;
        head.quaternion.copy(headRest);
      },
      lookAt(target, dt, idle) {
        if (!ctx.reducedMotion) idleTime += dt;
        head.getWorldPosition(headPosition); body.worldToLocal(headPosition);
        let yaw = 0, pitch = 0;
        if (target) {
          local.copy(target); body.worldToLocal(local); local.sub(headPosition);
          yaw = Math.atan2(local.y, local.x);
          pitch = Math.atan2(local.z, Math.hypot(local.x, local.y));
        }
        if (idle) { yaw += Math.sin(idleTime * .7) * .12; pitch += Math.sin(idleTime * .43) * .05; }
        const waist = THREE.MathUtils.clamp(yaw * .38, -Math.PI / 6, Math.PI / 6);
        const targets = { waist, yaw: THREE.MathUtils.clamp(yaw - waist, -Math.PI * 50 / 180, Math.PI * 50 / 180),
          pitch: THREE.MathUtils.clamp(pitch, -Math.PI * 25 / 180, Math.PI * 25 / 180) };
        for (const name of Object.keys(states)) spring(states[name], targets[name], dt);
        robot.setJoint('waist_yaw_joint', states.waist.value);
        head.quaternion.copy(headRest).multiply(yawRotation.setFromAxisAngle(up, states.yaw.value))
          .multiply(pitchRotation.setFromAxisAngle(lateral, -states.pitch.value));
        return !ctx.reducedMotion && Object.keys(states).some((name) => Math.abs(states[name].value - targets[name]) > .002 || Math.abs(states[name].velocity) > .01);
      },
      view(origin, direction) {
        head.updateWorldMatrix(true, false);
        origin.set(.04, 0, .08); head.localToWorld(origin);
        direction.set(1, 0, 0).transformDirection(head.matrixWorld);
      },
      hands: ['left', 'right'].map((side) => ({ side, node: find(`${side}_wrist_yaw_link`) })),
      feet: ['left', 'right'].map((side) => find(`${side}_ankle_roll_link`)),
      setJoint(name, value) {
        const joint = joints.get(name);
        if (!joint || !Number.isFinite(value)) throw new Error(`Invalid G1 joint: ${name}`);
        joint.angle = THREE.MathUtils.clamp(value, joint.range[0], joint.range[1]);
        joint.node.quaternion.copy(joint.rest).multiply(rotation.setFromAxisAngle(joint.axis, joint.angle));
      }
    };
    robots.push(robot);
    return robot;
  }
  function updateInstances() {
    inverse.copy(instances.matrixWorld).invert();
    batches.forEach((mesh, i) => {
      if (!mesh) return;
      let count = 0;
      for (const robot of robots) if (robot.root.visible) {
        matrix.multiplyMatrices(inverse, robot.nodes[i].matrixWorld);
        mesh.setMatrixAt(count++, matrix);
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    });
  }
  return { model, makeRobot, instances, updateInstances };
}
