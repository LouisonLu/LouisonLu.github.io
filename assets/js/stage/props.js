// All dimensions are metres. Reuse one box geometry and a handful of PBR surfaces.
export function createProps(ctx) {
  const { THREE, own } = ctx;
  const group = new THREE.Group(), unit = own(new THREE.BoxGeometry(1, 1, 1));
  unit.clearGroups();
  const tasks = [];
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion();
  const wood = '#93623c', concrete = '#a4a39a', paint = '#657b80';
  function surface(color, metalness = 0, roughness = .75, grain = false) {
    const m = own(new THREE.MeshStandardMaterial({ color, metalness, roughness, transparent: true }));
    if (grain) m.onBeforeCompile = shader => {
      shader.vertexShader = 'varying vec3 woodPoint;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nwoodPoint = position;');
      shader.fragmentShader = 'varying vec3 woodPoint;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        float grain = sin(woodPoint.z*140. + sin(woodPoint.x*9.)*2. + woodPoint.y*20.);
        diffuseColor.rgb *= .89 + .11 * grain;`);
    };
    m.userData.baseOpacity = 0; return m;
  }
  function boxes(parent, parts, m) {
    const mesh = own(new THREE.InstancedMesh(unit, m, parts.length));
    parts.forEach(([x,y,z,w,h,d], i) => {
      matrix.compose(new THREE.Vector3(x,y,z), rotation, new THREE.Vector3(w,h,d)); mesh.setMatrixAt(i, matrix);
    });
    mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  function task() {
    const root = new THREE.Group(), cargo = new THREE.Group(); root.add(cargo); group.add(root);
    const entry = { root, cargo, surfaces: [], alpha: 0 }; tasks.push(entry); return entry;
  }
  const table = task(), tableWood = surface(wood,0,.75,true);
  table.surfaces.push(tableWood);
  boxes(table.cargo, [[0,0,0,1.15,.09,.72], ...[-.46,.46].flatMap(x => [-.25,.25].map(z => [x,-.29,z,.07,.52,.07]))], tableWood);
  for (let beat=1;beat<5;beat++) {
    const entry = task(), boxWood = surface(beat === 2 ? '#b28756' : '#a87949',0,.8,true);
    entry.surfaces.push(boxWood);
    entry.size = beat === 2 ? [1.2,.28,.42] : [.58,.4,.4];
    boxes(entry.cargo, [[0,0,0,...entry.size]], boxWood);
  }
  const door = tasks[1], frame = surface('#7c817b', .15), wall = surface('#b6aca0');
  door.surfaces.push(frame, wall);
  // A .84 m opening requires a tandem pair to turn to fit the .4 m wide box.
  boxes(door.root, [[0,.8,-1.05,.18,1.6,1.26],[0,.8,1.05,.18,1.6,1.26]], wall);
  boxes(door.root, [[0,.88,-.46,.25,1.76,.08],[0,.88,.46,.25,1.76,.08],[0,1.8,0,.25,.08,1]], frame);
  const stairs = tasks[2], stone = surface(concrete, 0, .95);
  stairs.surfaces.push(stone);
  boxes(stairs.root, [...Array.from({length:6}, (_, i) => [-.9 + i * .3,(i+1)*.075,0,.3,(i+1)*.15,1.3]),
    [1.65,.45,0,1.9,.9,1.3]], stone);  // landing x .7…2.6 holds both carriers
  const truck = tasks[3], metal = surface(paint, .55, .35), tyre = surface('#292d30', .05, .9);
  truck.surfaces.push(metal, tyre);
  // Truck sits .25 m further back (+z) so the picker can stand beside the bed.
  boxes(truck.root, [[-1.6,.86,.35,1.25,.08,.95],[-2.43,.8,.35,.55,.75,.94],[-2.43,1.28,.35,.55,.2,.94],
    [-1.65,.51,.35,2.1,.12,.7]], metal);
  boxes(truck.root, [-2.24,-1.15].flatMap(x => [-.2,.9].map(z => [x,.27,z,.38,.42,.18])), tyre);
  const pad = tasks[4], padMaterial = surface('#69706a', .05, .9);
  pad.surfaces.push(padMaterial);
  boxes(pad.root, [[1.6,.912,0,1.3,.024,.55]], padMaterial);  // pad on the stair landing
  const outline = own(new THREE.LineBasicMaterial({ color: '#ff5a1f', transparent: true }));
  outline.userData.baseOpacity = 0;
  pad.surfaces.push(outline);
  const geometry = own(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(.95,.928,-.275),new THREE.Vector3(2.25,.928,-.275),new THREE.Vector3(2.25,.928,.275),
    new THREE.Vector3(.95,.928,.275),new THREE.Vector3(.95,.928,-.275)]));
  const marking = new THREE.Line(geometry, outline); pad.root.add(marking);
  let moving = false;
  // Stair carry + placement share one scene: stairs, landing pad and one box (tasks[2].cargo).
  tasks[4].cargo.visible = false;
  function update(dt, beat, aligned) {
    moving = false;
    tasks.forEach((entry, i) => {
      const target = Number(i === beat || (beat === 2 && i === 4));
      entry.alpha = ctx.reducedMotion ? target : THREE.MathUtils.clamp(target, entry.alpha - dt/.4, entry.alpha + dt/.4);
      entry.root.visible = entry.alpha > 0;
      entry.root.position.y = -.04 * (1-entry.alpha);
      for (const m of entry.surfaces) { m.userData.baseOpacity = entry.alpha; m.opacity = entry.alpha; m.depthWrite = entry.alpha === 1; }
      moving ||= entry.alpha !== target;
    });
    outline.color.set(aligned ? ctx.colors.signal : '#69706a');
    outline.userData.baseOpacity = tasks[4].alpha * (aligned ? 1 : .45);
    outline.opacity = outline.userData.baseOpacity;
  }
  async function stream() {
    const normal = await ctx.loadTexture('assets/textures/ground/NormalGL.jpg');
    await ctx.prepareMaterials(() => {
      stone.normalMap = normal;
      stone.normalScale = new THREE.Vector2(.45,.45); stone.needsUpdate = true;
    });
  }
  return { group, tasks, update, stream, busy: () => moving };
}
