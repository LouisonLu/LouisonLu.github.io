import * as THREE from '../../vendor/three.module.min.js';
import { loadG1 } from './g1.js';
import { create as createWorld } from './world.js';
import { create as createPwp } from './pwp.js';
import { create as createTeam } from './team.js';

const ACTS = {
  intro: { camera: [8, 7, 10], target: [0, .4, 0], span: 9, caption: 'A world model imagines the city around the robot. Dashed blocks are guesses; solid ones were seen.' },
  pwp: { camera: [-3.2, 2.4, 4], target: [1.5, 1.3, 0], span: 4.8, caption: 'One view in, a full 360° world out. Where the robot looks, the imagined lines become the real scene.' },
  heaveho: { camera: [7, 6, 9], target: [0, .6, 0], span: 6.2, caption: 'HH-Bench · Stair carry' },
  explore: { camera: [8, 7, 10], target: [0, .4, 0], span: 10, caption: '' }
};

// Act contract: create(ctx) => { group, enter(), leave(), update(dt, p), busy?(), command?() }.
// Coordinates are y-up; the ten robots share one geometry per body. material() and
// own() register theme/disposal ownership. label() projects into the fixed overlay.
// gaze holds the head's actual world-space direction, shared by the city and PwP.
export function init(stageEl, { onCaption } = {}) {
  if (!stageEl) throw new TypeError('Stage element required.');
  const view = stageEl.querySelector('.stage-view');
  const layer = stageEl.querySelector('.stage-labels');
  if (!view || !layer) throw new Error('Stage view and label layer required.');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let destroyed = false, ready = false, visible = true, frame = 0, timer = 0, previous = 0;
  let current = 'intro', progress = 0, lastInput = -Infinity;
  let cityTransition = false;
  let cityTime = 0, cityTimeTarget = 0;
  const environmentBlend = { value: 0 }, nightEnvironment = { value: null };
  const daySun = new THREE.Color('#fff4de'), eveningSun = new THREE.Color('#ffaf68'), moon = new THREE.Color('#aabfff');
  let renderer, scene, camera, ctx, acts, resizeObserver, pmrem;
  let width = 1, height = 1;
  let streamsStarted = false;
  const lowDevice = navigator.deviceMemory <= 4 || navigator.hardwareConcurrency <= 4 || innerWidth < 760;
  let pixelRatioCap = lowDevice ? 1 : 1.75, smallShadows = lowDevice;
  let tier = lowDevice ? 'low' : 'high', continuous = false;
  const frameTimes = [];
  // ?perf=1 enables logging only; normal visits allocate no observer or interval.
  const perfEnabled = new URLSearchParams(location.search).get('perf') === '1';
  let perfObserver, perfTimer, perfFrames = 0, perfSince = performance.now();
  let perfHeavehoMs = 0, perfHeavehoFrames = 0;
  const perfTimes = [];
  const idleJobs = [], groups = [], queuedGroups = new Set(), approached = new Set();
  let idleHandle = 0, draining = false;
  const nativeIdle = typeof window.requestIdleCallback === 'function';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  const resources = new Set(), compilations = new Set(), themed = [], labels = [], listeners = [];
  function listen(target, name, handler, options) {
    target.addEventListener(name, handler, options);
    listeners.push(() => target.removeEventListener(name, handler, options));
  }
  // Share idle slots between uploads, PMREM and shader preparation: one job per slot.
  function scheduleIdle() {
    if (idleHandle || destroyed || !idleJobs.length) return;
    const run = () => {
      idleHandle = 0;
      const job = idleJobs.shift();
      try { Promise.resolve(job.work()).then(job.resolve, job.reject); }
      catch (error) { job.reject(error); }
      scheduleIdle();
    };
    idleHandle = nativeIdle ? window.requestIdleCallback(run, { timeout: 1500 }) : setTimeout(run, 200);
  }
  function idle(work) {
    if (destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => { idleJobs.push({ work, resolve, reject }); scheduleIdle(); });
  }
  async function drainGroups() {
    if (draining || !streamsStarted || destroyed) return;
    draining = true;
    try {
      while (groups.length && !destroyed) {
        const { name, work } = groups.shift();
        await idle(() => {});
        if (destroyed) break;
        try { await work(); }
        catch (error) { if (!destroyed) console.error(`Stage ${name} assets unavailable:`, error); }
      }
    } finally { draining = false; }
  }
  function queueGroup(name, work, priority = false) {
    if (destroyed || queuedGroups.has(name)) return;
    queuedGroups.add(name);
    const group = { name, work };
    if (priority) {
      const dayIndex = groups.findIndex(item => item.name === 'day');
      const carryIndex = groups.findIndex(item => item.name === 'heaveho');
      groups.splice(Math.max(dayIndex, carryIndex) + 1, 0, group);
    } else groups.push(group);
    drainGroups();
  }
  function approach(name) {
    approached.add(name);
    if (!streamsStarted || !acts) return;
    if (name === 'pwp') queueGroup('pwp', () => acts.pwp.stream());
    else if (name === 'heaveho') queueHeaveho();
    else if (name === 'explore') queueNight();
  }
  function withHeavehoVisible(work) {
    const visibility = new Map();
    const show = object => { visibility.set(object,object.visible); object.visible = true; };
    acts.heaveho.group.traverse(show);
    acts.intro.lamps.traverse(show);
    show(robotGroup); show(ctx.robots[1].root);
    // All changes are synchronous inside one idle callback; no frame sees them.
    try { return work(); }
    finally { visibility.forEach((value,object) => { object.visible = value; }); }
  }
  function compileShaders() {
    const pending = withHeavehoVisible(() => renderer.compileAsync(scene, camera));
    compilations.add(pending);
    pending.then(() => compilations.delete(pending), () => compilations.delete(pending));
    // r160 compileAsync can stay pending (e.g. hidden materials); warm-up must never
    // block the asset queue, so continue after 1.5 s while compilation finishes on its own.
    return Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 1500))]);
  }
  async function prepareMaterials(apply = () => {}) {
    await idle(() => {
      if (destroyed) return;
      apply();
      return compileShaders();
    });
    if (!destroyed) request();
  }
  function queueHeaveho() {
    queueGroup('heaveho', async () => {
      await acts.heaveho.stream();
      await idle(() => {
        if (destroyed) return;
        const target = renderer.getRenderTarget();
        const cubeFace = renderer.getActiveCubeFace(), mipLevel = renderer.getActiveMipmapLevel();
        try {
          withHeavehoVisible(() => {
            renderer.compile(scene, camera);
            scene.updateMatrixWorld(true); ctx.g1.updateInstances();
            // A tiny offscreen render also builds the real shadow depth programs.
            renderer.setRenderTarget(warmTarget);
            renderer.render(scene, camera);
          });
        } finally {
          renderer.setRenderTarget(target,cubeFace,mipLevel);
          scene.updateMatrixWorld(true); ctx.g1.updateInstances();
        }
      });
    });
  }
  function queueNight() {
    if (!streamsStarted) return;
    queueGroup('night', async () => {
      await acts.intro.streamNight();
      await streamEnvironment('hansaplatz_2k.jpg', true);
    }, true);
  }
  function setCaption(text) { onCaption?.(text); }
  function caption() { stageEl.dataset.act = current; setCaption(ACTS[current].caption); }
  function fallback(error) {
    ready = false;
    pause();
    stageEl.classList.add('no-webgl');
    layer.hidden = true;
    canvas.remove();
    onCaption?.('');
    if (error) console.error('Stage unavailable:', error);
  }
  function setVisible(value) {
    visible = Boolean(value);
    if (ctx) ctx.stageVisible = visible;
    if (visible) request(); else pause();
  }
  caption();
  try {
    const context = canvas.getContext('webgl2', { antialias: true, alpha: true }) || canvas.getContext('webgl', { antialias: true, alpha: true });
    if (!context) { fallback(); return { setAct, setVisible, approach, command() {}, destroy }; }
    renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: true });
  } catch (error) { fallback(error); return { setAct, setVisible, approach, command() {}, destroy }; }
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = lowDevice ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  view.prepend(canvas);
  scene = new THREE.Scene();
  const sky = new THREE.HemisphereLight(0xffffff, 0x5e6a72, 2.4);
  const key = new THREE.DirectionalLight(0xffffff, 3);
  // The bright horizon near the panorama's wrap maps to the -x side.
  key.position.set(-8, 5, .5);
  key.castShadow = true;
  key.shadow.mapSize.set(lowDevice ? 512 : 1024, lowDevice ? 512 : 1024);
  Object.assign(key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: .5, far: 30 });
  key.shadow.bias = -.0004;
  key.shadow.normalBias = .025;
  resources.add(key.shadow);
  scene.add(sky, key);
  camera = new THREE.OrthographicCamera(-6, 6, 6, -6, .1, 150);
  const rig = { position: new THREE.Vector3(...ACTS.intro.camera), target: new THREE.Vector3(...ACTS.intro.target), span: ACTS.intro.span };
  const robotGroup = new THREE.Group();
  scene.add(robotGroup);
  let robotLayout = 'solo', pendingRobots = false, queuedCommand = false;
  const colors = {};
  const dashTime = { value: 0 }, night = { value: 0 };
  function own(resource) { if (destroyed) resource.dispose(); else resources.add(resource); return resource; }
  const warmTarget = own(new THREE.WebGLRenderTarget(1,1));
  function material(kind, token = 'ink', opacity = 1) {
    const options = { color: colors[token], transparent: true, opacity, depthWrite: opacity === 1 };
    const m = kind === 'solid' ? new THREE.MeshStandardMaterial({ ...options, roughness: .45, metalness: .35, side: THREE.DoubleSide }) :
      kind === 'fill' ? new THREE.MeshBasicMaterial({ ...options, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }) :
      kind === 'dash' ? new THREE.LineDashedMaterial({ ...options, dashSize: .11, gapSize: .07 }) : new THREE.LineBasicMaterial(options);
    if (kind === 'dash') {
      m.onBeforeCompile = (shader) => {
        shader.uniforms.dashTime = dashTime;
        shader.fragmentShader = 'uniform float dashTime;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('mod( vLineDistance, totalSize )', 'mod( vLineDistance + dashTime * .25, totalSize )');
      };
      m.customProgramCacheKey = () => 'crawling-dashes';
    }
    m.userData.baseOpacity = opacity;
    themed.push({ material: m, token });
    return own(m);
  }
  const textureRequests = new Map(), pbrSurfaces = [];
  const bitmapLoader = typeof createImageBitmap === 'function' ? new THREE.ImageBitmapLoader().setOptions({
    imageOrientation: 'flipY', premultiplyAlpha: 'none'
  }) : null;
  const textureLoader = bitmapLoader || new THREE.TextureLoader();
  function loadTexture(path, color = false) {
    if (destroyed) return Promise.reject(new Error('Stage destroyed.'));
    if (!textureRequests.has(path)) textureRequests.set(path, textureLoader.loadAsync(path).then(async (image) => {
      const texture = bitmapLoader ? new THREE.Texture(image) : image;
      if (bitmapLoader) {
        texture.flipY = false; // The bitmap decoder already flipped the pixels.
        texture.addEventListener('dispose', () => image.close());
        texture.needsUpdate = true;
      }
      if (color) texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = path.startsWith('assets/textures/') ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      own(texture);
      // Each upload gets its own idle callback, including cached/shared PBR maps.
      await idle(() => { if (!destroyed) renderer.initTexture(texture); });
      return texture;
    }));
    return textureRequests.get(path);
  }
  function pbrMaterial(options, token = 'page') {
    const m = material('solid', token);
    Object.assign(m, options);
    const blend = { value: 0 };
    m.userData.realism = blend;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.realism = blend;
      shader.fragmentShader = 'uniform float realism;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 photo = texture2D(map, vMapUv);
          diffuseColor.rgb = mix(diffuseColor.rgb, photo.rgb, realism);
        #endif`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>',
        THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * realism;'));
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>',
        THREE.ShaderChunk.roughnessmap_fragment + '\nroughnessFactor = mix(.45, roughnessFactor, realism);');
      shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>',
        THREE.ShaderChunk.metalnessmap_fragment + '\nmetalnessFactor = mix(.35, metalnessFactor, realism);');
    };
    pbrSurfaces.push(m);
    return m;
  }
  async function streamPbr(m, id, metallic = true) {
    const maps = [['map', 'Color', true], ['normalMap', 'NormalGL'], ['roughnessMap', 'Roughness']];
    if (metallic) maps.push(['metalnessMap', 'Metalness']);
    const textures = await Promise.all(maps.map(([, name, color]) => loadTexture(`assets/textures/${id}/${name}.jpg`, color)));
    if (destroyed) return;
    await prepareMaterials(() => {
      maps.forEach(([name], i) => {
        m[name] = textures[i];
        if (m.userData.solidMaterial) m.userData.solidMaterial[name] = textures[i];
      });
      m.userData.texturesReady = true;
      m.needsUpdate = true;
      if (m.userData.solidMaterial) m.userData.solidMaterial.needsUpdate = true;
    });
  }

  function label(text, position, group, className = '') {
    const element = document.createElement('div');
    element.className = ('stage-label ' + className).trim();
    element.textContent = text;
    layer.append(element);
    labels.push({ element, position, group });
    return { element };
  }
  function theme() {
    const css = getComputedStyle(document.documentElement);
    for (const token of ['page', 'stage', 'ink', 'steel', 'line', 'signal', 'signal-ink']) colors[token] = css.getPropertyValue('--' + token).trim();
    const dark = document.documentElement.dataset.theme === 'dark';
    if (dark) queueNight();
    night.value = Number(dark);
    if (!ready) environmentBlend.value = Number(dark);
    if (ctx) { ctx.dark = dark; ctx.environmentIntensity = dark ? .32 : 1; }
    colors.body = dark ? '#a8adb5' : '#c9ccd1';
    colors.joint = dark ? '#202329' : '#2a2d33';
    scene.background = null;
    sky.intensity = dark ? .7 : 1.5;
    key.intensity = dark ? 1.1 : 3;
    key.color.set(dark ? '#b8caff' : '#fff4de');
    for (const resource of resources) if (resource.isMeshStandardMaterial) resource.envMapIntensity = (resource.userData.environmentIntensity ?? 1) * (dark ? .32 : 1);
    themed.forEach((item) => item.material.color.set(colors[item.token]));
    request();
  }
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const gaze = { point: new THREE.Vector3(2, 0, 0), look: new THREE.Vector3(3, 1.2, 0),
    origin: new THREE.Vector3(0, 1.2, 0), direction: new THREE.Vector3(1, 0, 0), active: false, idle: true };
  let pointerInside = false;
  const sphereCenter = new THREE.Vector3();
  function aimPointer() {
    raycaster.setFromCamera(pointer, camera);
    const point = raycaster.ray.intersectPlane(groundPlane, gaze.point);
    gaze.active = pointerInside && Boolean(point);
    if (point) { gaze.point.x = THREE.MathUtils.clamp(point.x, -4.5, 4.5); gaze.point.z = THREE.MathUtils.clamp(point.z, -4.5, 4.5); }
    if (current === 'pwp' && acts?.pwp?.group) {
      // Look at the far inner wall of the 360° shell under the cursor, so the seen
      // region follows the pointer continuously (no flip when crossing the robot).
      const center = acts.pwp.group.getWorldPosition(sphereCenter), r = acts.pwp.radius;
      const along = center.clone().sub(raycaster.ray.origin).dot(raycaster.ray.direction);
      raycaster.ray.at(along, gaze.look);
      const miss = gaze.look.distanceToSquared(center);
      if (miss <= r * r) raycaster.ray.at(along + Math.sqrt(r * r - miss), gaze.look);
      else gaze.look.sub(center).setLength(r).add(center);
      gaze.active = pointerInside;
      return;
    }
    const depth = gaze.origin.clone().sub(raycaster.ray.origin).dot(raycaster.ray.direction);
    raycaster.ray.at(Math.max(0, depth), gaze.look);
  }
  function updateGaze(robot, dt, target) {
    const moving = robot.lookAt(target || (gaze.active ? gaze.look : null), dt,
      !reduced.matches && gaze.idle && performance.now() - lastInput > 1800);
    ctx.gazeBusy ||= moving && performance.now() - lastInput < 1000;
    if (robot === ctx.robots[0]) robot.view(gaze.origin, gaze.direction);
  }
  ctx = { THREE, scene, camera, rig, colors, own, material, pbrMaterial, streamPbr, loadTexture, prepareMaterials, label, labelLayer: layer, robots: [], robotGroup,
    dashTime, night, cityNight: environmentBlend, setCaption, setCityTime(value) { cityTimeTarget = value; }, reducedMotion: reduced.matches, stageVisible: visible, act: current, progress, gaze, updateGaze, requestRender: request };
  theme();
  const groundMaterial = pbrMaterial({ roughness: 1, metalness: 0, normalScale: new THREE.Vector2(.5, .5), side: THREE.FrontSide }, 'stage');
  const groundCompile = groundMaterial.onBeforeCompile;
  groundMaterial.onBeforeCompile = (shader) => {
    groundCompile(shader);
    shader.vertexShader = 'varying vec2 groundUv;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `
      #include <uv_vertex>
      groundUv = uv;
      #ifdef USE_MAP
        vMapUv = uv * 12.;
        vNormalMapUv = vMapUv;
        vRoughnessMapUv = vMapUv;
      #endif`);
    shader.fragmentShader = 'varying vec2 groundUv;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float radius = length((groundUv - .5) * 2.);
      diffuseColor.a *= (1. - smoothstep(.6, 1., radius)) * mix(.16, .94, realism);`);
  };
  const ground = new THREE.Mesh(own(new THREE.PlaneGeometry(24, 24)), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -.012;
  ground.receiveShadow = true;
  ground.renderOrder = -2;
  ground.userData.fade = 1;
  scene.add(ground);
  // A shadow-only receiver keeps the solo robot grounded when PwP hides paving.
  const contactShadow = new THREE.Group();
  const receiver = new THREE.Mesh(own(new THREE.PlaneGeometry(6, 6)), own(new THREE.ShadowMaterial({ opacity: .24, depthWrite: false })));
  receiver.material.userData.baseOpacity = .24;
  receiver.rotation.x = -Math.PI / 2; receiver.position.y = -.011;
  receiver.receiveShadow = true;
  contactShadow.add(receiver); scene.add(contactShadow);
  async function streamEnvironment(path, isNight) {
    const texture = await loadTexture('assets/pano/' + path, true);
    if (destroyed) return;
    await idle(() => {
      if (destroyed) return;
      texture.mapping = THREE.EquirectangularReflectionMapping;
      pmrem ||= own(new THREE.PMREMGenerator(renderer));
      try {
        const env = own(pmrem.fromEquirectangular(texture)).texture;
        if (isNight) nightEnvironment.value = env;
        else scene.environment = env;
      } finally { texture.dispose(); resources.delete(texture); }
      // Issue new environment shader variants in the same idle slot.
      return compileShaders();
    });
    request();
  }
  function startStreams() {
    // Called only after the first G1 frame; each group finishes before the next.
    queueGroup('warmup', () => prepareMaterials());
    queueGroup('day', async () => {
      await acts.intro.stream();
      await streamPbr(groundMaterial, 'ground', false);
    });
    queueHeaveho();
    queueGroup('day-environment', () => streamEnvironment('canary_wharf_2k.jpg', false));
    streamsStarted = true;
    drainGroups();
    if (ctx.dark) queueNight();
    for (const name of approached) approach(name);
  }
  function cityLighting(dt) {
    const target = current === 'explore' ? cityTimeTarget : 0;
    cityTime = reduced.matches ? target : THREE.MathUtils.damp(cityTime,target,6,dt);
    const warm = THREE.MathUtils.smoothstep(cityTime,1/3,2/3);
    const dusk = THREE.MathUtils.smoothstep(cityTime,.64,.98);
    const blend = ctx.dark ? 1 : dusk;
    environmentBlend.value = reduced.matches ? blend : THREE.MathUtils.damp(environmentBlend.value,blend,6,dt);
    ctx.environmentIntensity = ctx.dark ? THREE.MathUtils.lerp(.32,.16,cityTime) : THREE.MathUtils.lerp(1,.24,dusk);
    sky.intensity = ctx.dark ? .4-.15*cityTime : THREE.MathUtils.lerp(1.5,.3,dusk);
    key.position.set(-8,THREE.MathUtils.lerp(5,.7,warm),THREE.MathUtils.lerp(.5,3,warm));
    key.color.copy(daySun).lerp(eveningSun,warm).lerp(moon,environmentBlend.value);
    key.intensity = ctx.dark ? .38 : THREE.MathUtils.lerp(3,.35,dusk);
    for (const resource of resources) if (resource.isMeshStandardMaterial) {
      resource.envMapIntensity = (resource.userData.environmentIntensity ?? 1)*ctx.environmentIntensity;
      if (resource.userData.cityEnvironment) continue;
      resource.userData.cityEnvironment = true;
      const compile = resource.onBeforeCompile, cacheKey = resource.customProgramCacheKey();
      resource.customProgramCacheKey = () => cacheKey + ':city-environment';
      resource.onBeforeCompile = (shader, renderer) => {
        compile.call(resource,shader,renderer);
        shader.uniforms.cityNightBlend = environmentBlend;
        shader.uniforms.cityNightEnv = nightEnvironment;
        const chunk = THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
          /textureCubeUV\( envMap, ([^,]+), ([^)]+) \)/g,
          'mix(textureCubeUV(envMap, $1, $2), textureCubeUV(cityNightEnv, $1, $2), cityNightBlend)');
        shader.fragmentShader = 'uniform sampler2D cityNightEnv;\nuniform float cityNightBlend;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>',chunk);
      };
      resource.needsUpdate = true;
    }
    // A valid day sampler is used until the night texture finishes streaming.
    if (!nightEnvironment.value && scene.environment) nightEnvironment.value = scene.environment;
    return Math.abs(cityTime-target)>.001 || Math.abs(environmentBlend.value-blend)>.001;
  }
  function setAct(name, p = 0, exploreProgress = p) {
    if (!Object.hasOwn(ACTS, name)) throw new Error('Unknown stage act: ' + name);
    if (!Number.isFinite(p)) throw new TypeError('Act progress must be finite.');
    const changed = name !== current;
    if (changed && (name === 'pwp' || current === 'pwp')) cityTransition = true;
    if (ready && changed) acts[current].leave?.();
    current = name;
    progress = THREE.MathUtils.clamp(p, 0, 1);
    if (name === 'explore') {
      if (!Number.isFinite(exploreProgress)) throw new TypeError('Explore progress must be finite.');
      progress = THREE.MathUtils.clamp(exploreProgress, 0, 1);
    }
    cityTimeTarget = name === 'explore' ? progress : 0;
    if (ctx) Object.assign(ctx, { act: current, progress });
    if (changed) {
      if (!stageEl.classList.contains('no-webgl')) caption();
      if (ready) {
        queuedCommand = false;
        const movedSolo = current === 'pwp' && ctx.robots[0].root.position.lengthSq() > .0001;
        pendingRobots = (layoutFor(current) !== robotLayout || movedSolo) && !reduced.matches && (robotGroup.userData.fade ?? 0) > .001;
        ctx.pendingRobots = pendingRobots;
        if (!pendingRobots) activateRobots();
        if (current !== 'heaveho') acts[current].enter?.();
      }
    }
    request();
  }
  function layoutFor(name) { return name === 'heaveho' ? 'team' : 'solo'; }
  function activateRobots() {
    pendingRobots = ctx.pendingRobots = false;
    const changed = layoutFor(current) !== robotLayout;
    const movedSolo = current === 'pwp' && ctx.robots[0].root.position.lengthSq() > .0001;
    robotLayout = layoutFor(current);
    if (current === 'heaveho') {
      acts.heaveho.enter?.();
      if (queuedCommand) { queuedCommand = false; acts.heaveho.command?.(); }
    } else if (changed || movedSolo || !ready) settleRobots();
  }
  function settleRobots() {
    ctx.robots.forEach((robot, i) => {
      robot.root.visible = i === 0;
      robot.root.position.set(0, 0, 0);
      robot.root.rotation.set(0, 0, 0);
      robot.body.rotation.z = 0;
      robot.skeleton.position.z = ctx.g1.model.standingPelvisHeight - ctx.g1.model.bodies[0].pos[2];
      robot.joints.forEach((joint, name) => robot.setJoint(name, 0));
      robot.resetGaze();
    });
  }
  function command() {
    if (ready && current === 'heaveho') {
      if (pendingRobots) queuedCommand = true; else acts.heaveho.command?.();
      request();
    }
  }
  function canRender() { return ready && !destroyed && visible && !document.hidden; }
  function request() {
    clearTimeout(timer); timer = 0;
    if (!frame && canRender()) frame = requestAnimationFrame(render);
  }
  function pause() {
    cancelAnimationFrame(frame); clearTimeout(timer); frame = timer = 0; previous = 0; continuous = false;
    acts?.pwp.suspend();
  }
  function resize() {
    const nextWidth = view.clientWidth, nextHeight = view.clientHeight;
    if (nextWidth && nextHeight) {
      width = nextWidth; height = nextHeight;
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, pixelRatioCap));
      renderer.setSize(width, height, false);
      request();
    }
  }
  function sampleFrame(ms) {
    frameTimes.push(ms);
    if (frameTimes.length > 40) frameTimes.shift();
    if (frameTimes.length < 40 || frameTimes.reduce((sum, value) => sum + value, 0) / 40 <= 24) return;
    const dpr = renderer.getPixelRatio();
    if (dpr > 1.25) { pixelRatioCap = 1.25; tier = 'medium'; }
    else if (dpr > 1) { pixelRatioCap = 1; tier = 'low'; }
    else if (!smallShadows) {
      smallShadows = true; pixelRatioCap = 1; tier = 'low';
      key.shadow.mapSize.set(512, 512);
      key.shadow.map?.dispose(); key.shadow.map = null;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      // Shadow type is part of the program key; prepare its variants off the frame.
      prepareMaterials().catch(error => console.error('Shadow warm-up unavailable:', error));
    } else return;
    frameTimes.length = 0;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, pixelRatioCap));
  }
  if (perfEnabled) {
    if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      perfObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (entry.duration > 80) console.info(`[perf] longtask ${entry.duration.toFixed(1)}ms`);
      });
      perfObserver.observe({ type: 'longtask', buffered: true });
    }
    perfTimer = setInterval(() => {
      const now = performance.now(), times = perfTimes.splice(0).sort((a, b) => a - b);
      const p95 = times.length ? times[Math.ceil(times.length * .95) - 1] : 0;
      console.info(`[perf] fps=${(perfFrames * 1000 / (now - perfSince)).toFixed(1)} p95=${p95.toFixed(1)}ms tier=${tier} dpr=${renderer.getPixelRatio().toFixed(2)}`);
      if (perfHeavehoFrames) console.info(`[perf] heaveho ${(perfHeavehoMs / perfHeavehoFrames).toFixed(3)}ms`);
      perfHeavehoMs = perfHeavehoFrames = 0;
      perfFrames = 0; perfSince = now;
    }, 1000);
  }
  function fade(group, target, dt, duration = 0) {
    const from = group.userData.fade ?? 0;
    const value = reduced.matches ? target : duration ? THREE.MathUtils.clamp(target, from - dt / duration, from + dt / duration) : THREE.MathUtils.damp(from, target, 6, dt);
    group.userData.fade = Math.abs(value - target) < .002 ? target : value;
    group.visible = group.userData.fade > .001;
    group.traverse((object) => {
      if (!object.material) return;
      for (const m of Array.isArray(object.material) ? object.material : [object.material]) {
        m.opacity = (m.userData.baseOpacity ?? 1) * group.userData.fade;
        m.depthWrite = (m.userData.seenBatch || !m.userData.vertexAlpha) && m.opacity >= .999;
        if (m.userData.solidBatch) {
          const transparent = m.opacity < .999;
          if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
          m.depthWrite = !m.transparent;
        }
      }
    });
    return group.userData.fade !== target;
  }
  const cameraPosition = new THREE.Vector3(), cameraTarget = new THREE.Vector3();
  function render(now) {
    frame = 0;
    if (!canRender()) return;
    const frameMs = continuous && previous ? now - previous : 0;
    const dt = previous ? Math.min((now - previous) / 1000, .1) : 1 / 60;
    previous = now;
    ctx.reducedMotion = reduced.matches;
    if (!reduced.matches) dashTime.value += dt;
    ctx.gazeBusy = false;
    if (pendingRobots && reduced.matches) activateRobots();
    const spec = ACTS[current];
    const smooth = reduced.matches ? 1 : 1 - Math.exp(-dt * 5);
    cameraPosition.fromArray(spec.camera); cameraTarget.fromArray(spec.target);
    rig.position.lerp(cameraPosition, smooth); rig.target.lerp(cameraTarget, smooth);
    rig.span += (spec.span - rig.span) * smooth;
    camera.position.copy(rig.position); camera.lookAt(rig.target);
    const aspect = width / height;
    camera.top = rig.span / 2; camera.bottom = -rig.span / 2;
    camera.left = -rig.span * aspect / 2; camera.right = rig.span * aspect / 2;
    if (aspect < 1) { camera.top /= aspect; camera.bottom /= aspect; camera.left /= aspect; camera.right /= aspect; }
    camera.setViewOffset(width, height, width >= 1024 ? -width * (.22 + (current === 'pwp' ? .16 : 0)) : 0, width >= 1024 ? 0 : height * .18, width, height);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    if (pointerInside) aimPointer();
    if (current === 'pwp' && !pendingRobots) updateGaze(ctx.robots[0], dt);
    const entries = [[acts.intro, current === 'heaveho' ? .12 : current === 'pwp' ? 0 : 1],
      [acts.pwp, current === 'pwp' ? 1 : 0], [acts.heaveho, current === 'heaveho' ? 1 : 0]];
    let changing = cityLighting(dt);
    for (const m of pbrSurfaces) {
      const blend = m.userData.realism;
      const target = m.userData.texturesReady ? 1 : 0;
      blend.value = reduced.matches ? target : Math.min(target, blend.value + dt / .35);
      changing ||= blend.value !== target;
    }
    for (const [act, target] of entries) {
      if (target && !(act === acts.heaveho && pendingRobots)) {
        const timed = perfEnabled && act === acts.heaveho;
        const started = timed ? performance.now() : 0;
        act.update(dt, progress);
        if (timed) { perfHeavehoMs += performance.now()-started; perfHeavehoFrames++; }
      }
      const fading = fade(act.group, target, dt, act === acts.intro && cityTransition ? .4 : 0);
      if (act === acts.intro && !fading) cityTransition = false;
      changing = fading || changing;
    }
    acts.intro.updateLamps();
    changing = fade(ground, current === 'pwp' ? 0 : 1, dt, .4) || changing;
    changing = fade(contactShadow, current === 'pwp' ? 1 : 0, dt, .4) || changing;
    // Video draws over shell lines without depth testing; the robot draws last.
    robotGroup.traverse((object) => { if (object.isMesh) object.renderOrder = current === 'pwp' ? 4 : 0; });
    changing = fade(robotGroup, pendingRobots ? 0 : 1, dt) || changing;
    if (pendingRobots && robotGroup.userData.fade === 0) activateRobots();
    scene.updateMatrixWorld(true);
    ctx.g1.updateInstances();
    labels.forEach((item) => {
      const point = item.position.clone(); item.group.localToWorld(point); point.project(camera);
      let opacity = 1, shown = true;
      for (let parent = item.group; parent; parent = parent.parent) { opacity *= parent.userData.fade ?? 1; shown &&= parent.visible; }
      item.element.style.opacity = opacity;
      item.element.hidden = !shown || opacity < .03 || point.z < -1 || point.z > 1;
      item.element.style.left = (point.x * .5 + .5) * width + 'px';
      item.element.style.top = (-point.y * .5 + .5) * height + 'px';
    });
    renderer.render(scene, camera);
    if (!streamsStarted) startStreams();
    if (perfEnabled) { perfFrames++; if (frameMs) perfTimes.push(frameMs); }
    if (frameMs && !reduced.matches) sampleFrame(frameMs);
    changing ||= rig.position.distanceToSquared(cameraPosition) > .0001 || Math.abs(rig.span - spec.span) > .001;
    const busy = changing || ctx.gazeBusy || acts[current].busy?.() || (!reduced.matches && now - lastInput < 350);
    continuous = Boolean(busy);
    if (busy) request();
    else if (!reduced.matches) timer = setTimeout(request, 1000 / 15);
  }
  resizeObserver = new ResizeObserver(resize); resizeObserver.observe(view);
  listen(document, 'visibilitychange', () => document.hidden ? pause() : request());
  listen(document, 'themechange', theme);
  listen(reduced, 'change', () => {
    ctx.reducedMotion = reduced.matches; pause(); acts?.pwp.syncPlayback(); request();
  });
  listen(window, 'pointermove', (event) => {
    pointer.set(event.clientX / innerWidth * 2 - 1, 1 - event.clientY / innerHeight * 2);
    pointerInside = true; gaze.idle = true; lastInput = performance.now(); request();
  }, { passive: true });
  listen(window, 'pointerleave', (event) => {
    if (event.relatedTarget !== null) return;
    pointerInside = gaze.active = gaze.idle = false; lastInput = performance.now(); request();
  }, { capture: true, passive: true });
  listen(window, 'click', (event) => {
    if (!ready || event.target.closest('a,button,video,img,p,h1,h2,h3,li,dd,dt,figure,header')) return;
    // Direct text nodes inside otherwise empty containers still belong to content.
    if ([...event.target.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())) return;
    pointer.set(event.clientX / innerWidth * 2 - 1, 1 - event.clientY / innerHeight * 2);
    pointerInside = true; aimPointer(); lastInput = performance.now();
    if (current === 'heaveho') command();
    else if ((current === 'intro' || current === 'explore') && gaze.active) acts.intro.walkTo(gaze.point);
    request();
  });
  listen(canvas, 'webglcontextlost', (event) => { event.preventDefault(); fallback(new Error('WebGL context lost.')); });
  loadG1(ctx).then((g1) => {
    if (destroyed) return;
    ctx.g1 = g1; ctx.robots = Array.from({ length: 10 }, (_, i) => g1.makeRobot(i));
    ctx.robots.forEach((robot) => robotGroup.add(robot.root));
    robotGroup.add(g1.instances);
    const world = createWorld(ctx);
    acts = { intro: world, explore: world, pwp: createPwp(ctx), heaveho: createTeam(ctx) };
    for (const act of new Set(Object.values(acts))) { scene.add(act.group); act.group.userData.fade = 0; }
    settleRobots(); robotLayout = layoutFor(current);
    ready = true; theme(); acts[current].enter?.(); resize();
  }).catch((error) => { if (!destroyed) fallback(error); });
  function destroy() {
    if (destroyed) return;
    destroyed = true; pause(); resizeObserver?.disconnect(); listeners.forEach((remove) => remove());
    if (nativeIdle) window.cancelIdleCallback(idleHandle); else clearTimeout(idleHandle);
    idleJobs.splice(0).forEach(job => job.resolve()); groups.length = 0;
    clearInterval(perfTimer); perfObserver?.disconnect();
    if (acts) for (const act of new Set(Object.values(acts))) { act.leave?.(); act.destroy?.(); }
    labels.forEach((item) => item.element.remove()); canvas.remove();
    const release = () => {
      resources.forEach((resource) => resource.dispose());
      renderer?.dispose(); renderer?.forceContextLoss();
    };
    // r160 compileAsync polls material program properties. Keep them alive until
    // every started compilation settles, even after the canvas has been removed.
    Promise.allSettled([...compilations]).then(release).catch(error => console.error('Stage cleanup unavailable:', error));
  }
  return { setAct, setVisible, approach, command, destroy };
}
