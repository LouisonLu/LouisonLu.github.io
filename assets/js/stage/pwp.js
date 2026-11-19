export function create(ctx) {
  const { THREE, own, material } = ctx;
  const group = new THREE.Group();
  group.position.y = 1.15;
  const radius = 1.6, sector = Math.PI * 2 / 7, halfWidth = sector * .7725 / 2;
  // Fixed v8 seen range: direction.dot(ctx.gaze.direction) > .72, from the head origin.
  const uniforms = { gaze: { value: new THREE.Vector3(1, 0, 0) }, cutoff: { value: .72 }, gazeOrigin: { value: new THREE.Vector3() },
    shellView: { value: new THREE.Vector3() }, signal: { value: new THREE.Color(ctx.colors.signal) } };
  const maskShader = `
    varying vec3 panoramaDirection;
    uniform vec3 gaze;
    uniform vec3 gazeOrigin;
    uniform float cutoff;
    uniform vec3 shellView;
    uniform vec3 signal;
    float seenMask() {
      float angle = acos(clamp(cutoff, -1., 1.));
      float distance = acos(clamp(dot(normalize(panoramaDirection - gazeOrigin), normalize(gaze)), -1., 1.));
      // A six-degree feather, measured in angle rather than dot-product space.
      return 1. - smoothstep(angle - .05236, angle + .05236, distance);
    }
  `;
  function masked(m, video = false) {
    m.userData.vertexAlpha = true;
    const compile = m.onBeforeCompile;
    m.customProgramCacheKey = () => `pwp:${video}:${m.isLineDashedMaterial}`;
    m.onBeforeCompile = (shader) => {
      compile.call(m, shader);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = 'varying vec3 panoramaDirection;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\npanoramaDirection = position;');
      shader.fragmentShader = maskShader + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        float seen = seenMask();
        ${video ? `
          diffuseColor.a = seen;
          float rim = 4. * seen * (1. - seen);
          diffuseColor.rgb = mix(diffuseColor.rgb, signal, rim * .13);
        ` : `
          float nearHalf = step(0., dot(normalize(panoramaDirection), shellView));
          diffuseColor.a *= (1. - seen) * mix(1., .35, nearHalf);
        `}
      `);
    };
    return m;
  }
  function point(phi, height) {
    const horizontal = Math.sqrt(Math.max(0, 1 - height * height));
    return new THREE.Vector3(Math.cos(phi) * horizontal * radius, height * radius, Math.sin(phi) * horizontal * radius);
  }
  function lines(points, m) {
    const line = new THREE.LineSegments(own(new THREE.BufferGeometry().setFromPoints(points)), masked(m));
    line.renderOrder = 1;
    group.add(line);
    return line;
  }
  // Imagined shell: one uniform 30° × 30° dashed latitude/longitude grid (equal blocks
  // that read as a globe) plus the seven camera frustums.
  const grid = [], frustums = [];
  for (let latitude = -60; latitude <= 60; latitude += 30) {
    const height = Math.sin(THREE.MathUtils.degToRad(latitude));
    for (let i = 0; i < 96; i++) grid.push(point(i * Math.PI / 48, height), point((i + 1) * Math.PI / 48, height));
  }
  for (let longitude = 0; longitude < 12; longitude++) for (let i = 0; i < 48; i++) {
    const phi = longitude * Math.PI / 6, a = -Math.PI / 2 + i * Math.PI / 48, b = a + Math.PI / 48;
    grid.push(point(phi, Math.sin(a)), point(phi, Math.sin(b)));
  }
  for (let i = 0; i < 7; i++) {
    const center = i * sector, left = center - halfWidth, right = center + halfWidth;
    const corners = [point(left, -.4), point(right, -.4), point(right, .4), point(left, .4)];
    for (let j = 0; j < 4; j++) frustums.push(new THREE.Vector3(), corners[j], corners[j], corners[(j + 1) % 4]);
  }
  lines(grid, material('dash', 'signal', .42)).computeLineDistances();
  lines(frustums, material('line', 'ink', .18));
  const video = document.createElement('video');
  video.muted = true; video.loop = true; video.playsInline = true;
  video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
  video.preload = 'metadata';
  const texture = own(new THREE.VideoTexture(video));
  texture.colorSpace = THREE.SRGBColorSpace;
  const surface = masked(own(new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide,
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false })), true);
  const geometry = own(new THREE.SphereGeometry(radius * .99, 96, 48));
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
  const sphere = new THREE.Mesh(geometry, surface);
  sphere.renderOrder = 2;
  sphere.visible = false;
  group.add(sphere);
  // The preserved v9a camera is outside this small shell. BackSide supplies the
  // far hemisphere; its companion lets a near-side gaze resolve into video too.
  const nearSurface = masked(own(surface.clone()), true);
  nearSurface.side = THREE.FrontSide;
  const nearSphere = new THREE.Mesh(geometry, nearSurface);
  nearSphere.renderOrder = 3;
  nearSphere.visible = false;
  group.add(nearSphere);
  let loaded = false, ready = false, disposed = false, playPending = false, playBlocked = false;
  let wasReduced = ctx.reducedMotion;
  function suspend() { video.pause(); }
  function syncPlayback() {
    if (disposed || !loaded) return;
    if (ctx.reducedMotion !== wasReduced) {
      wasReduced = ctx.reducedMotion;
      if (wasReduced) { suspend(); video.currentTime = 0; }
    }
    const visible = ctx.act === 'pwp' && ctx.stageVisible && !document.hidden;
    if (!visible || ctx.reducedMotion) { suspend(); return; }
    if (video.paused && ready && !playPending && !playBlocked) {
      playPending = true;
      video.play().then(() => {
        if (disposed || ctx.act !== 'pwp' || !ctx.stageVisible || document.hidden || ctx.reducedMotion) suspend();
      }).catch((error) => {
        // pause()/load() can interrupt a pending play when the act/tab is hidden.
        if (error.name === 'AbortError' || disposed) return;
        playBlocked = true;
        console.error('PwP video playback unavailable:', error);
      }).finally(() => { playPending = false; });
    }
  }
  function frameReady() { ready = true; ctx.requestRender(); }
  function videoError() { console.error('PwP video unavailable:', video.error); }
  video.addEventListener('loadeddata', frameReady);
  video.addEventListener('seeked', frameReady);
  video.addEventListener('error', videoError);
  function stream() {
    if (disposed || loaded) return;
    loaded = true;
    // Local 360° scene, independently of the paper player controls.
    video.poster = 'assets/media/robot360.jpg';
    video.preload = 'auto';
    video.src = 'assets/media/robot360.mp4'; video.load();
  }
  // Keep the v9a head-steered narrow frustum geometry and its projection.
  const frustumGeometry = own(new THREE.BufferGeometry());
  const positions = new THREE.BufferAttribute(new Float32Array(16 * 3), 3).setUsage(THREE.DynamicDrawUsage);
  frustumGeometry.setAttribute('position', positions);
  const frustumInk = masked(material('line', 'signal', .28));
  const frustum = new THREE.LineSegments(frustumGeometry, frustumInk);
  frustum.frustumCulled = false; frustum.renderOrder = 1;
  group.add(frustum);
  const forward = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  const origin = new THREE.Vector3(), corners = Array.from({ length: 4 }, () => new THREE.Vector3());
  let walkTime = 0;
  // The sphere video is a walking 360° camera, so the robot walks in place with it
  // (same joint pattern as the city walk; frozen under reduced motion or a paused video).
  function walkInPlace(dt) {
    const robot = ctx.robots[0];
    if (!robot || ctx.act !== 'pwp' || ctx.pendingRobots) return;
    const walking = !ctx.reducedMotion && ready && !video.paused;
    if (walking) walkTime += dt;
    const gait = walking ? Math.sin(walkTime * 7) * .24 : 0;
    for (const [side, sign] of [['left', 1], ['right', -1]]) {
      robot.setJoint(side + '_hip_pitch_joint', gait * sign);
      robot.setJoint(side + '_knee_joint', Math.max(0, -gait * sign) * 1.5);
      robot.setJoint(side + '_ankle_pitch_joint', -gait * sign * .5);
      robot.setJoint(side + '_shoulder_pitch_joint', -gait * sign * .5);
      robot.setJoint(side + '_elbow_joint', .15);
    }
  }
  function update(dt, p) {
    syncPlayback();
    walkInPlace(dt);
    uniforms.signal.value.set(ctx.colors.signal);
    uniforms.gaze.value.copy(ctx.gaze.direction);
    uniforms.gazeOrigin.value.copy(ctx.gaze.origin).sub(group.position);
    ctx.camera.getWorldDirection(uniforms.shellView.value).negate();
    sphere.visible = nearSphere.visible = ready;
    frustumInk.userData.baseOpacity = .28 * (1 - p);
    frustum.visible = p < .999;
    origin.copy(ctx.gaze.origin).sub(group.position);
    forward.copy(ctx.gaze.direction).normalize();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    up.crossVectors(right, forward).normalize();
    corners.forEach((corner, i) => corner.copy(origin).addScaledVector(forward, 2.2)
      .addScaledVector(right, (i === 0 || i === 3 ? -1 : 1) * .78)
      .addScaledVector(up, (i < 2 ? -1 : 1) * .52));
    let index = 0;
    for (let i = 0; i < 4; i++) for (const point of [origin, corners[i], corners[i], corners[(i + 1) % 4]]) {
      positions.setXYZ(index++, point.x, point.y, point.z);
    }
    positions.needsUpdate = true;
  }
  function destroy() {
    disposed = true; suspend();
    video.removeEventListener('loadeddata', frameReady);
    video.removeEventListener('seeked', frameReady);
    video.removeEventListener('error', videoError);
    video.removeAttribute('src'); video.load();
  }
  return { group, radius, stream, enter() { playBlocked = false; update(0, ctx.progress); },
    leave() { suspend(); sphere.visible = nearSphere.visible = false; },
    suspend, syncPlayback, destroy, update,
    busy: () => !ctx.reducedMotion && ready && !video.paused };
}
