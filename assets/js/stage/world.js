const SEED = 731;
const SPACING = .78;
function hash(x, z, salt = 0) {
  let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(SEED + salt, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function create(ctx) {
  const nightMaps = Array.from({length:2}, () => ({ color: {value:null}, normal: {value:null}, roughness: {value:null} }));
  const { THREE, own, material } = ctx;
  const group = new THREE.Group();
  const unit = own(new THREE.BoxGeometry(1, 1, 1));
  const edges = own(new THREE.EdgesGeometry(unit, 40)).attributes.position;
  unit.clearGroups();
  const cells = [];
  for (let z = -7; z <= 7; z++) for (let x = -7; x <= 7; x++) {
    if (x % 4 === 0 || z % 4 === 0 || Math.hypot(x, z) < 2 || Math.hypot(x, z) > 7 || hash(x, z) < .18) continue;
    const tower = hash(x, z, 4) > .92;
    const floors = tower ? 12 + Math.floor(hash(x, z, 1) * 8) : 3 + Math.floor(hash(x, z, 1) * 6);
    cells.push({ x: x * SPACING, z: z * SPACING, height: floors * .22, tower,
      facade: Math.floor(hash(x, z, 3) * 4), seed: hash(x, z, 2), seen: 0, hypothesis: 1 });
  }
  // Per-instance alpha gives a continuous 350 ms transition without opacity buckets.
  // UVs use the instance dimensions, so a taller building gets more windows.
  function instanceMaterial(m, facade = false, depth = false, facadeIndex = 0) {
    m.userData.vertexAlpha = true;
    m.depthWrite = depth;
    const compile = m.onBeforeCompile;
    const parentKey = m.customProgramCacheKey();
    m.customProgramCacheKey = () => `cell:${facade}:${depth}:${parentKey}`;
    m.onBeforeCompile = (shader, renderer) => {
      compile.call(m, shader, renderer);
      if (facade) {
        const maps = nightMaps[facadeIndex % 2];
        shader.uniforms.nightFacade = maps.color; shader.uniforms.nightNormal = maps.normal; shader.uniforms.nightRoughness = maps.roughness;
        shader.uniforms.cityNight = ctx.cityNight;
        shader.vertexShader = 'varying vec2 cityFacadeUv; varying float cityCellSeed;\n' + shader.vertexShader;
        shader.fragmentShader = 'uniform sampler2D nightFacade; uniform sampler2D nightNormal; uniform sampler2D nightRoughness; uniform float cityNight; varying vec2 cityFacadeUv; varying float cityCellSeed;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('diffuseColor.rgb = mix(diffuseColor.rgb, photo.rgb, realism);',
          'diffuseColor.rgb = mix(diffuseColor.rgb, mix(photo.rgb, texture2D(nightFacade, vMapUv).rgb, cityNight), realism);');
        shader.fragmentShader = shader.fragmentShader.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
          'vec3 mapN = mix(texture2D(normalMap,vNormalMapUv).xyz,texture2D(nightNormal,vNormalMapUv).xyz,cityNight)*2.0-1.0;');
        shader.fragmentShader = shader.fragmentShader.replace('vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );',
          'vec4 texelRoughness = mix(texture2D(roughnessMap,vRoughnessMapUv),texture2D(nightRoughness,vRoughnessMapUv),cityNight);');
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
          #include <emissivemap_fragment>
          vec2 windowCell = floor(cityFacadeUv * vec2(6.,8.));
          float threshold = .1 + .75 * fract(sin(dot(windowCell,vec2(12.9898,78.233)) + cityCellSeed)*43758.5453);
          totalEmissiveRadiance *= smoothstep(threshold,threshold+.08,cityNight);`);
      }
      shader.vertexShader = 'attribute float visibility; varying float cellAlpha;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        cellAlpha = visibility;`);
      if (facade) shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `
        #include <uv_vertex>
        vec3 dimensions = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vec3 metres = position * dimensions;
        vec2 facadeUv = vec2(abs(normal.x) > .5 ? metres.z : metres.x, metres.y + dimensions.y * .5) / vec2(.65, .88);
        cityFacadeUv = facadeUv;
        cityCellSeed = instanceMatrix[3].x * 17. + instanceMatrix[3].z * 31.;
        #ifdef USE_EMISSIVEMAP
          vEmissiveMapUv = facadeUv;
        #endif
        #ifdef USE_MAP
          vMapUv = facadeUv;
          vNormalMapUv = facadeUv;
          vRoughnessMapUv = facadeUv;
          vMetalnessMapUv = facadeUv;
        #endif`);
      shader.fragmentShader = 'varying float cellAlpha;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', depth ?
        'if (cellAlpha < .5) discard;\n#include <alphatest_fragment>' :
        `#ifdef RESOLVED_BUILDING
          if (cellAlpha < .99999) discard;
        #elif defined(FADING_BUILDING)
          if (cellAlpha >= .99999) discard;
        #endif
        diffuseColor.a *= cellAlpha; if (diffuseColor.a < .001) discard;
        #include <alphatest_fragment>`);
    };
    return m;
  }
  function batch(entries, m, casts = true) {
    const geometry = own(unit.clone());
    const visibility = new THREE.InstancedBufferAttribute(new Float32Array(entries.length), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('visibility', visibility);
    const mesh = own(new THREE.InstancedMesh(geometry, m, entries.length));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = casts;
    if (casts) {
      mesh.customDepthMaterial = instanceMaterial(own(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })), false, true);
      // Resolved cells write depth; only cells in transition need alpha blending.
      // Both passes share transforms/geometry and stay inside the draw-call budget.
      const solid = own(m.clone());
      solid.onBeforeCompile = m.onBeforeCompile;
      solid.customProgramCacheKey = m.customProgramCacheKey;
      solid.color = m.color;
      solid.userData.realism = m.userData.realism;
      solid.userData.solidBatch = true;
      solid.defines = { ...solid.defines, RESOLVED_BUILDING: 1 };
      m.defines = { ...m.defines, FADING_BUILDING: 1 };
      m.userData.solidMaterial = solid;
      const resolved = own(new THREE.InstancedMesh(geometry, solid, entries.length));
      resolved.instanceMatrix = mesh.instanceMatrix;
      resolved.frustumCulled = false;
      resolved.receiveShadow = true;
      group.add(resolved);
    }
    group.add(mesh);
    return { mesh, entries, visibility };
  }
  const entries = cells.flatMap((cell) => cell.tower ? [{ cell, tier: false }, { cell, tier: true }] : [{ cell, tier: false }]);
  const ids = ['Facade001', 'Facade006', 'Facade018A', 'Facade020A'];
  const facades = ids.map((id, i) => {
    const m = instanceMaterial(ctx.pbrMaterial({ roughness: 1, metalness: i === 1 ? .5 : 1, side: THREE.FrontSide,
      normalScale: new THREE.Vector2(.55, .55) }), true, false, i);
    return { id, ...batch(entries.filter(({ cell }) => cell.facade === i), m) };
  });
  const roofMaterial = instanceMaterial(own(new THREE.MeshStandardMaterial({ color: '#b5b1a7', roughness: .95,
    metalness: .03, transparent: true })));
  const roofs = batch(entries, roofMaterial);
  const glassMaterial = instanceMaterial(own(new THREE.MeshStandardMaterial({ color: '#9dc4dd', roughness: .16,
    metalness: .25, transparent: true, opacity: .18, depthWrite: false, side: THREE.FrontSide })));
  glassMaterial.userData.baseOpacity = .18;
  const imagined = batch(cells.map((cell) => ({ cell })), glassMaterial, false);
  const guessGeometry = own(new THREE.BufferGeometry());
  const guessArray = new Float32Array(cells.length * edges.count * 3);
  const edgeAlpha = new Float32Array(cells.length * edges.count);
  guessGeometry.setAttribute('position', new THREE.BufferAttribute(guessArray, 3).setUsage(THREE.DynamicDrawUsage));
  guessGeometry.setAttribute('visibility', new THREE.BufferAttribute(edgeAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  const outline = material('dash', 'steel', .42);
  const outlineCompile = outline.onBeforeCompile;
  outline.onBeforeCompile = (shader) => {
    outlineCompile.call(outline, shader);
    shader.vertexShader = 'attribute float visibility; varying float edgeAlpha;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nedgeAlpha = visibility;');
    shader.fragmentShader = 'varying float edgeAlpha;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= edgeAlpha;');
  };
  const guesses = new THREE.LineSegments(guessGeometry, outline);
  guesses.frustumCulled = false; group.add(guesses);
  const coneGeometry = own(new THREE.BufferGeometry());
  const coneArray = new Float32Array(32 * 9);
  coneGeometry.setAttribute('position', new THREE.BufferAttribute(coneArray, 3).setUsage(THREE.DynamicDrawUsage));
  const cone = new THREE.Mesh(coneGeometry, material('fill', 'signal', .075));
  cone.frustumCulled = false; group.add(cone);
  const raysGeometry = own(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 4 }, () => new THREE.Vector3())));
  const rays = new THREE.LineSegments(raysGeometry, material('line', 'signal', .2));
  rays.frustumCulled = false; group.add(rays);
  const targetRing = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(own(new THREE.RingGeometry(.17 + i * .025, .2 + i * .025, 48)), material('fill', 'signal', .22 / (i + 1)));
    ring.rotation.x = -Math.PI / 2; targetRing.add(ring);
  }
  targetRing.position.y = .015; group.add(targetRing);
  const trailMaterial = material('fill','steel',.15);
  const trail = own(new THREE.InstancedMesh(own(new THREE.PlaneGeometry(.065,.14)),trailMaterial,32));
  trail.rotation.x = -Math.PI/2; trail.position.y = .008; trail.frustumCulled = false; group.add(trail);
  const lampMaterial = own(new THREE.MeshStandardMaterial({ color:'#424a4d',roughness:.5,metalness:.55,transparent:true }));
  const headMaterial = own(new THREE.MeshStandardMaterial({ color:'#ffe6bd',emissive:'#ffcf8a',emissiveIntensity:0,transparent:true }));
  const lampGeometry = own(new THREE.CylinderGeometry(.025,.035,1.65,8));
  const lampHead = own(new THREE.BoxGeometry(.24,.08,.16));
  // Lights live outside the fading city: their visible count must stay constant.
  const lamps = new THREE.Group(); ctx.scene.add(lamps);
  const lampLights = [];
  const cityLamps = [[-1.2,1.68,.65],[1.8,1.68,-.65],[3.1,1.68,.65]];
  const carryLamps = [[-2.4,1.9,-1.05],[.6,2.6,1.05],[2.6,2.6,-1.05]];
  const lampMeshes = [];
  for (const [x,y,z] of cityLamps) {
    const post = new THREE.Mesh(lampGeometry,lampMaterial); post.position.set(x,.825,z); lamps.add(post);
    const head = new THREE.Mesh(lampHead,headMaterial); head.position.set(x,1.68,z); lamps.add(head);
    const light = new THREE.PointLight('#ffd4a0',0,3.5,2); light.position.set(x,1.55,z); lamps.add(light); lampLights.push(light);
    lampMeshes.push({ post, head });
  }
  function updateLamps() {
    const carrying = ctx.act === 'heaveho';
    const night = ctx.dark && ctx.act !== 'pwp' ? (carrying ? 1 : ctx.cityNight.value) : 0;
    const alpha = carrying ? 1 : group.userData.fade ?? 1;
    headMaterial.emissiveIntensity = night*(carrying ? 3 : 2);
    headMaterial.opacity = lampMaterial.opacity = alpha;
    headMaterial.depthWrite = lampMaterial.depthWrite = alpha >= .999;
    const positions = carrying ? carryLamps : cityLamps;
    lampLights.forEach((light,i) => {
      const [x,y,z] = positions[i], { post, head } = lampMeshes[i];
      post.visible = head.visible = night > .001 && alpha > .001;
      post.scale.y = (y-.03)/1.65; post.position.set(x,(y-.03)/2,z);
      head.position.set(x,y,z); light.position.set(x,y-.13,z);
      light.intensity = night*(carrying ? 2.4 : 1.4*alpha);
      light.distance = carrying ? 5 : 3.5;
    });
  }
  const headlampMaterial = material('fill','signal',.12);
  // A radial alpha falloff gives the ground projection a soft headlamp edge.
  headlampMaterial.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec2 spotUv;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>','#include <uv_vertex>\nspotUv = uv;');
    shader.fragmentShader = 'varying vec2 spotUv;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.a *= pow(max(0.,1.-length((spotUv-.5)*2.)),2.);');
  };
  const headlamp = new THREE.Mesh(own(new THREE.PlaneGeometry(1.25,2.7)),headlampMaterial);
  headlamp.rotation.x = -Math.PI/2; headlamp.position.y = .018; group.add(headlamp);
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion();
  const position = new THREE.Vector3(), scale = new THREE.Vector3();
  const destination = new THREE.Vector3(), origin = new THREE.Vector3();
  let elapsed = ctx.reducedMotion ? 2.5 : 0, walking = false, travel = 0;
  let resolvePoint = null, resolveUntil = 0;
  function walkTo(point) {
    const robot = ctx.robots[0];
    // A command is a few steps, never an unbounded journey through the page.
    destination.copy(point).sub(robot.root.position); destination.y = 0;
    destination.clampLength(0, 2.1).add(robot.root.position);
    destination.x = THREE.MathUtils.clamp(destination.x, -3, 3);
    destination.z = THREE.MathUtils.clamp(destination.z, -3, 3);
    // Use the actual shifted camera to retain only on-screen destinations.
    const screen = destination.clone().project(ctx.camera);
    screen.x = THREE.MathUtils.clamp(screen.x, -.85, .85);
    screen.y = THREE.MathUtils.clamp(screen.y, -.75, .75);
    const ray = new THREE.Raycaster(); ray.setFromCamera(screen, ctx.camera);
    ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), destination);
    destination.sub(robot.root.position).clampLength(0, 2.1).add(robot.root.position);
    if (ctx.act === 'explore') { resolvePoint = destination.clone(); resolveUntil = elapsed + 4; return; }
    if (ctx.reducedMotion) robot.root.position.copy(destination);
    else walking = true;
    resolvePoint = destination.clone(); resolveUntil = elapsed + 4;
  }
  function pose(dt) {
    const robot = ctx.robots[0];
    if (ctx.act === 'explore') {
      const p = ctx.progress;
      const walk = THREE.MathUtils.smoothstep(p,0,1/3);
      destination.set(-2.4+walk*4.2,0,0);
      if (ctx.reducedMotion) { robot.root.position.copy(destination); walking = false; }
      else walking = robot.root.position.distanceToSquared(destination)>.0004;
    }
    if (ctx.reducedMotion) walking = false;
    const delta = destination.clone().sub(robot.root.position);
    if (walking && delta.length() < .035) walking = false;
    let gait = 0;
    if (walking) {
      const heading = Math.atan2(-delta.z, delta.x);
      robot.body.rotation.z += Math.atan2(Math.sin(heading - robot.body.rotation.z), Math.cos(heading - robot.body.rotation.z)) * (1 - Math.exp(-dt * 8));
      const distance = Math.min(delta.length(), dt * .65);
      robot.root.position.addScaledVector(delta.normalize(), distance); travel += distance;
      gait = Math.sin(travel * 17) * .24;
    } else if (ctx.act === 'explore') {
      const face = ctx.progress > .67 ? -.65 : 0;
      robot.body.rotation.z += (face-robot.body.rotation.z)*(ctx.reducedMotion ? 1 : 1-Math.exp(-dt*5));
    }
    for (const [side, sign] of [['left', 1], ['right', -1]]) {
      robot.setJoint(side + '_hip_pitch_joint', gait * sign);
      robot.setJoint(side + '_knee_joint', Math.max(0, -gait * sign) * 1.5);
      robot.setJoint(side + '_ankle_pitch_joint', -gait * sign * .5);
      robot.setJoint(side + '_shoulder_pitch_joint', -gait * sign * .5);
      robot.setJoint(side + '_elbow_joint', .15);
    }
    let glance = null;
    if (ctx.act === 'explore' && ctx.progress>1/3 && ctx.progress<2/3) {
      const angle = Math.sin((ctx.progress-1/3)*3*Math.PI*3)*.8;
      const scripted = robot.root.position.clone().add(new THREE.Vector3(Math.cos(angle)*3,1.2,Math.sin(angle)*3));
      glance = ctx.gaze.active ? scripted.lerp(ctx.gaze.look,.55) : scripted;
    }
    ctx.updateGaze(robot, dt, glance);
  }
  function update(dt) {
    if (ctx.act === 'explore') ctx.setCityTime(ctx.progress);
    const night = ctx.cityNight.value;
    trail.visible = ctx.act === 'explore';
    const trailCount = ctx.act === 'explore' ? Math.min(32,Math.floor(THREE.MathUtils.smoothstep(ctx.progress,0,1/3)*32)) : 0;
    trail.count = trailCount;
    for (let i=0;i<trailCount;i++) {
      matrix.makeTranslation(-2.4+i*.13,(i%2 ? -.08 : .08),0); trail.setMatrixAt(i,matrix);
    }
    trail.instanceMatrix.needsUpdate = true;
    if (ctx.reducedMotion) elapsed = Math.max(elapsed, 2.5); else elapsed += dt;
    const solo = ctx.act === 'intro' || ctx.act === 'explore';
    if (solo && !ctx.pendingRobots) pose(dt);
    origin.copy(ctx.gaze.origin); origin.y = .012;
    const yaw = Math.atan2(ctx.gaze.direction.z, ctx.gaze.direction.x);
    const half = Math.PI / 5;
    const reach = THREE.MathUtils.clamp(4.8 + ctx.gaze.direction.y * 3, 2.5, 5.5);
    const bloom = ctx.reducedMotion ? 1 : THREE.MathUtils.smoothstep(elapsed, .25, 2.5);
    let edgeOffset = 0;
    for (const cell of cells) {
      const dx = cell.x - origin.x, dz = cell.z - origin.z, distance = Math.hypot(dx, dz);
      const dot = (dx * Math.cos(yaw) + dz * Math.sin(yaw)) / Math.max(.001, distance);
      const nearCommand = resolvePoint && elapsed < resolveUntil && Math.hypot(cell.x - resolvePoint.x, cell.z - resolvePoint.z) < 1.5;
      const mapped = ctx.act === 'explore' && Math.abs(cell.z)<2.1 && cell.x<ctx.robots[0].root.position.x+.7;
      const seen = mapped || distance < reach && dot > Math.cos(half) || nearCommand ? 1 : 0;
      cell.seen = ctx.reducedMotion ? seen : THREE.MathUtils.clamp(cell.seen + Math.sign(seen - cell.seen) * dt / .35, 0, 1);
      const alternative = 1 + Math.round(Math.sin(elapsed * .55 + cell.seed * 14)) * .16;
      cell.hypothesis = ctx.reducedMotion ? 1 : THREE.MathUtils.damp(cell.hypothesis, alternative, 2, dt);
      cell.realHeight = cell.height * Math.max(.01, bloom) * (1 + .035 * (1 - cell.seen));
      cell.guessHeight = cell.height * cell.hypothesis * Math.max(.01, bloom);
      if (cell.seen < 1) for (let i = 0; i < edges.count; i++) {
        edgeAlpha[edgeOffset / 3] = 1 - cell.seen;
        guessArray[edgeOffset++] = edges.getX(i) * .5 + cell.x;
        guessArray[edgeOffset++] = edges.getY(i) * cell.guessHeight + cell.guessHeight / 2;
        guessArray[edgeOffset++] = edges.getZ(i) * .5 + cell.z;
      }
    }
    for (const item of [...facades, roofs, imagined]) {
      item.entries.forEach(({ cell, tier }, i) => {
        const guess = item === imagined, roof = item === roofs;
        const full = guess ? cell.guessHeight : cell.realHeight;
        const height = tier ? full * .28 : cell.tower && !guess ? full * .72 : full;
        const bottom = tier ? full * .72 : 0;
        const width = tier ? .36 : .5;
        position.set(cell.x, bottom + (roof ? height + .012 : height / 2), cell.z);
        scale.set(width, roof ? .024 : height, width);
        matrix.compose(position, rotation, scale);
        item.mesh.setMatrixAt(i, matrix);
        item.visibility.setX(i, guess ? 1 - cell.seen : cell.seen);
      });
      item.mesh.instanceMatrix.needsUpdate = item.visibility.needsUpdate = true;
    }
    guessGeometry.setDrawRange(0, edgeOffset / 3);
    guessGeometry.attributes.position.needsUpdate = guessGeometry.attributes.visibility.needsUpdate = true;
    guesses.computeLineDistances();
    for (let i = 0; i < 32; i++) {
      const a = yaw - half + i / 32 * half * 2, b = yaw - half + (i + 1) / 32 * half * 2;
      coneArray.set([origin.x, origin.y, origin.z, origin.x + Math.cos(a) * reach, origin.y, origin.z + Math.sin(a) * reach,
        origin.x + Math.cos(b) * reach, origin.y, origin.z + Math.sin(b) * reach], i * 9);
    }
    coneGeometry.attributes.position.needsUpdate = true;
    const rayArray = raysGeometry.attributes.position.array;
    rayArray.set([...ctx.gaze.origin.toArray(), origin.x + Math.cos(yaw - half) * reach, origin.y, origin.z + Math.sin(yaw - half) * reach,
      ...ctx.gaze.origin.toArray(), origin.x + Math.cos(yaw + half) * reach, origin.y, origin.z + Math.sin(yaw + half) * reach]);
    raysGeometry.attributes.position.needsUpdate = true;
    cone.visible = rays.visible = solo && night<.5;
    headlamp.visible = solo && night>.01;
    headlampMaterial.userData.baseOpacity = night*.35;
    headlamp.position.set(origin.x+Math.cos(yaw)*1.4,.018,origin.z+Math.sin(yaw)*1.4);
    headlamp.rotation.z = Math.PI/2-yaw;
    targetRing.visible = solo && ctx.gaze.active;
    targetRing.position.x = ctx.gaze.point.x; targetRing.position.z = ctx.gaze.point.z;
  }
  async function stream() {
    for (const { id, mesh } of facades) await ctx.streamPbr(mesh.material, id);
  }
  async function streamNight() {
    // Both facade pairs share the same cached night maps.
    for (const [i, nightId] of ['Facade009', 'Facade017'].entries()) {
      const maps = await Promise.all(['Color','NormalGL','Roughness','Emission'].map(name => ctx.loadTexture(`assets/textures/${nightId}/${name}.jpg`,name==='Color'||name==='Emission')));
      await ctx.prepareMaterials(() => {
        const target = nightMaps[i]; target.color.value = maps[0]; target.normal.value = maps[1]; target.roughness.value = maps[2];
        facades.forEach(({mesh}, index) => {
          if (index % 2 !== i) return;
          for (const m of [mesh.material,mesh.material.userData.solidMaterial]) {
            m.emissive.set('#ffd6a4'); m.emissiveMap = maps[3]; m.needsUpdate = true;
          }
        });
      });
    }
  }
  return { group, lamps, updateLamps, stream, streamNight, enter() { update(0); }, leave() { walking = false; }, update, walkTo,
    busy: () => !ctx.reducedMotion && (elapsed < 2.5 || walking) };
}
