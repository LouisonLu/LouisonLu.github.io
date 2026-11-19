import { createProps } from './props.js';

// HH-Bench beats shown here: 'Stair carry' → 'Precise placement'.
export function create(ctx) {
  const { THREE, own, material, robots } = ctx, { model } = ctx.g1;
  const props = createProps(ctx), group = props.group;
  const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
  const ease = t => { t = clamp(t,0,1); return t*t*(3-2*t); };
  const bubbleAnchor = new THREE.Group(); group.add(bubbleAnchor); bubbleAnchor.visible = false;
  const bubble = ctx.label('', new THREE.Vector3(), bubbleAnchor, 'command-bubble');
  const sound = material('fill','signal',.5);
  const ring = new THREE.Mesh(own(new THREE.RingGeometry(.98,1,48)), sound);
  ring.rotation.x = -Math.PI/2; ring.visible = false; group.add(ring);
  const commands = ['Lift', 'Turn right', 'Turn left', 'Put down'];
  const states = robots.map(robot => ({ robot, active: false, posed: false, joining: false, retiring: false, stride: 0 }));
  const endpoint = new THREE.Vector3(), pivot = new THREE.Vector3(), axis = new THREE.Vector3();
  const toward = new THREE.Vector3(), current = new THREE.Vector3(), cross = new THREE.Vector3();
  const goal = new THREE.Vector3(), localTip = new THREE.Vector3(.1,0,0);
  const turn = new THREE.Quaternion(), inverseBody = new THREE.Matrix4();
  let beat = -1, pending = null, commandIndex = 0, lift = 0, advance = 0, heading = 0, moving = false;
  const cargo = new THREE.Vector3();
  let tilt = 0, caption = '', shown = 0;
  const ramp = x => clamp((x+1.05)*.5,0,.9);
  const stairHeight = x => clamp(Math.floor((x+1.05)/.3)+1,0,6)*.15;
  function command() {
    if (ctx.act !== 'heaveho' || pending) return;
    // Cycle: Lift → turn out → turn back to the start heading (no overshoot) → Put down.
    // The turn direction alternates every cycle: right-then-left, then left-then-right.
    const count = commandIndex++, index = count % 4, mirrored = Math.floor(count/4) % 2 === 1;
    const out = mirrored ? 'Turn left' : 'Turn right', back = mirrored ? 'Turn right' : 'Turn left';
    const goal = index === 1 ? (mirrored ? Math.PI/2 : -Math.PI/2) : 0;
    bubble.element.textContent = index === 1 ? out : index === 2 ? back : commands[index]; bubbleAnchor.visible = true;
    pending = { index, goal, elapsed: 0, lift, advance, heading };
    ctx.requestRender();
  }
  function animateCommand(dt) {
    if (!pending) return;
    pending.elapsed += dt;
    const t = ctx.reducedMotion ? 1 : ease((pending.elapsed-.25)/1.3);
    ring.visible = !ctx.reducedMotion && pending.elapsed < .4;
    ring.scale.setScalar(Math.max(.01,pending.elapsed*5));
    if (pending.index === 0) lift = lerp(pending.lift,.1,t);
    if (pending.index === 1 || pending.index === 2) heading = lerp(pending.heading,pending.goal,t);
    if (pending.index === 3) lift = lerp(pending.lift,-.23,t);
    // Keep the English command readable even when motion is reduced.
    if (pending.elapsed >= 1.65) { pending = null; ring.visible = bubbleAnchor.visible = false; }
  }
  // Reuse the constrained hand solver in each real G1's local z-up frame.
  function holdBox(state, hand, target) {
    const { robot } = state;
    robot.body.updateWorldMatrix(true, false);
    inverseBody.copy(robot.body.matrixWorld).invert();
    const names = ['elbow', 'shoulder_pitch', 'shoulder_roll', 'shoulder_yaw'];
    let passes = state.posed ? 2 : 8, retried = false;
    for (let iteration = 0; iteration < passes; iteration++) {
      for (const name of names) {
        const jointName = `${hand.side}_${name}_joint`;
        const joint = robot.joints.get(jointName);
        endpoint.copy(localTip); hand.node.localToWorld(endpoint); robot.body.worldToLocal(endpoint);
        joint.node.getWorldPosition(pivot); robot.body.worldToLocal(pivot);
        axis.copy(joint.axis).applyQuaternion(joint.node.getWorldQuaternion(turn));
        axis.transformDirection(inverseBody);
        current.subVectors(endpoint, pivot); current.addScaledVector(axis, -current.dot(axis));
        toward.subVectors(target, pivot); toward.addScaledVector(axis, -toward.dot(axis));
        if (current.lengthSq() < 1e-9 || toward.lengthSq() < 1e-9) continue;
        current.normalize(); toward.normalize();
        const angle = Math.atan2(axis.dot(cross.crossVectors(current, toward)), clamp(current.dot(toward), -1, 1));
        robot.setJoint(jointName, joint.angle + clamp(angle, -.35, .35));
      }
      if (iteration === passes - 1 && !retried) {
        endpoint.copy(localTip); hand.node.localToWorld(endpoint); robot.body.worldToLocal(endpoint);
        if (endpoint.distanceToSquared(target) > .0009) {
          passes += 6; retried = true;
        }
      }
    }
  }
  function footOnTread(state, foot, side, target) {
    const { robot } = state;
    // CCD in the same z-up model frame as the hand solver; ankle stays on a tread.
    robot.body.worldToLocal(target);
    inverseBody.copy(robot.body.matrixWorld).invert();
    let passes = state.posed ? 2 : 10, retried = false;
    for (let pass=0;pass<passes;pass++) {
      for (const name of ['knee','hip_pitch','ankle_pitch']) {
        const joint = robot.joints.get(`${side}_${name}_joint`);
        endpoint.set(.025,0,-.028); foot.localToWorld(endpoint); robot.body.worldToLocal(endpoint);
        joint.node.getWorldPosition(pivot); robot.body.worldToLocal(pivot);
        axis.copy(joint.axis).applyQuaternion(joint.node.getWorldQuaternion(turn)).transformDirection(inverseBody);
        current.subVectors(endpoint,pivot); current.addScaledVector(axis,-current.dot(axis));
        toward.subVectors(target,pivot); toward.addScaledVector(axis,-toward.dot(axis));
        if (current.lengthSq()<1e-9 || toward.lengthSq()<1e-9) continue;
        current.normalize(); toward.normalize();
        robot.setJoint(`${side}_${name}_joint`,joint.angle+clamp(Math.atan2(axis.dot(cross.crossVectors(current,toward)),current.dot(toward)),-.3,.3));
      }
      if (pass === passes-1 && !retried) {
        endpoint.set(.025,0,-.028); foot.localToWorld(endpoint); robot.body.worldToLocal(endpoint);
        if (endpoint.distanceToSquared(target) > .0009) {
          // Recover the original bend if the warm start reaches a joint limit.
          ['hip_pitch','knee','ankle_pitch'].forEach((name,i) => robot.setJoint(`${side}_${name}_joint`,state[side][i]));
          passes += 6; retried = true;
        }
      }
    }
  }
  function poseRobot(state, dt, target, face, squat, held, width, depth) {
    const { robot } = state;
    const delta = target.clone().sub(robot.root.position), distance = Math.hypot(delta.x,delta.z);
    // Carriers sit exactly on their grips. The act's progress itself is rate-limited
    // (see `shown`), so box and robots always move together: no chasing, no lag, no
    // hands through the box when the page is scrolled fast.
    const stride = distance;
    robot.root.position.x = target.x; robot.root.position.z = target.z;
    state.stride += stride;
    state.joining = distance > .035;
    // Step whenever the body actually moves (scroll moves targets in small increments).
    state.speed = THREE.MathUtils.damp(state.speed||0,dt>0 ? stride/dt : 0,6,dt);
    const gait = ctx.reducedMotion ? 0 : clamp(state.speed/.2,0,1)*Math.sin(state.stride*17);
    robot.root.position.y = beat === 2 ? stairHeight(robot.root.position.x) : 0;
    robot.root.rotation.set(0,0,0);
    const desiredFace = state.joining && !held ? Math.atan2(-delta.z,delta.x) : face;
    robot.body.rotation.z += Math.atan2(Math.sin(desiredFace-robot.body.rotation.z),Math.cos(desiredFace-robot.body.rotation.z)) * (ctx.reducedMotion ? 1 : 1-Math.exp(-dt*9));
    robot.skeleton.position.z = model.standingPelvisHeight-model.bodies[0].pos[2];
    for (const [side,sign] of [['left',1],['right',-1]]) {
      const legPose = [-squat/2+gait*sign*.18, squat+Math.max(0,-gait*sign)*.22, -squat/2-gait*sign*.09];
      const previousPose = state[side];
      const warmPose = state[side+'Warm'] ||= [];
      ['hip_pitch','knee','ankle_pitch'].forEach((name,i) => {
        const jointName = `${side}_${name}_joint`;
        const previous = state.posed && previousPose ? robot.joints.get(jointName).angle-previousPose[i] : 0;
        warmPose[i] = previous+legPose[i];
        // Ground the pelvis from the original gait, then restore the solved legs.
        robot.setJoint(jointName,legPose[i]);
      });
      state[side] = legPose;
      for (const name of ['ankle_roll','hip_roll','hip_yaw','wrist_pitch','wrist_roll','wrist_yaw']) robot.setJoint(`${side}_${name}_joint`,0);
      if (!state.posed || !held) {
        robot.setJoint(`${side}_shoulder_pitch_joint`,held ? .3 : -gait*sign*.1);
        robot.setJoint(`${side}_shoulder_roll_joint`,sign*.12);
        robot.setJoint(`${side}_shoulder_yaw_joint`,0);
        robot.setJoint(`${side}_elbow_joint`,held ? -.65 : .15);
      }
    }
    robot.setJoint('waist_roll_joint',0); robot.setJoint('waist_pitch_joint',0);
    let low = Infinity;
    for (const foot of robot.feet) { endpoint.set(.025,0,-.028); foot.localToWorld(endpoint); low = Math.min(low,endpoint.y-robot.root.position.y); }
    robot.skeleton.position.z -= low;
    if (beat === 2) robot.feet.forEach((foot,i) => {
      const sign = i ? -1 : 1;
      const x = robot.root.position.x + (ctx.reducedMotion ? 0 : gait*sign*.12);
      goal.set(x,stairHeight(x)+Math.max(0,gait*sign)*.07,robot.root.position.z + sign*.1);
      const side = i ? 'right' : 'left';
      ['hip_pitch','knee','ankle_pitch'].forEach((name,j) => robot.setJoint(`${side}_${name}_joint`,state[side+'Warm'][j]));
      footOnTread(state,foot,i ? 'right' : 'left',goal);
    });
    const leader = robots[0].root.position;
    ctx.updateGaze(robot,dt,robot===robots[0] ? null : new THREE.Vector3(leader.x,leader.y+1.2,leader.z));
    if (held) robot.hands.forEach(hand => {
      // Clamp grip: each hand on its own long side of the box, near the robot's end.
      const angle = props.tasks[beat].cargo.rotation.y;
      const c = Math.cos(angle), s = Math.sin(angle);
      const dx = robot.root.position.x-cargo.x, dz = robot.root.position.z-cargo.z;
      const along = dx*c-dz*s;
      robot.joints.get(`${hand.side}_shoulder_pitch_joint`).node.getWorldPosition(goal);
      const side = (goal.x-cargo.x)*s+(goal.z-cargo.z)*c;
      const x = Math.sign(along||1)*(width/2-.12), z = Math.sign(side||(hand.side==='left' ? 1 : -1))*(depth/2+.025);
      goal.set(cargo.x+x*c+z*s,cargo.y+x*Math.sin(tilt),cargo.z-x*s+z*c);
      // Approaching robots reach only when within arm's length.
      if (Math.hypot(goal.x-robot.root.position.x,goal.z-robot.root.position.z)>.6) return;
      robot.body.worldToLocal(goal); holdBox(state,hand,goal);
    });
    state.posed = true;
  }
  function update(dt,p) {
    if (ctx.act !== 'heaveho') return;
    if (!Number.isFinite(p) || !Number.isFinite(dt) || dt<0) throw new TypeError('Finite team progress and nonnegative dt required.');
    p = clamp(p,0,1);
    // One continuous act (user choice): Stair carry up to the landing, then Precise
    // placement of the SAME long box on the landing pad. Robots start at their grips.
    const entering = beat === -1;
    // Rate-limited act progress: fast scrolling is followed at a steady walking pace.
    if (entering || ctx.reducedMotion) shown = p;
    else shown += clamp(p-shown,-dt*.22,dt*.22);
    const climb = ease(shown/.48), lower = ease((shown-.52)/.16);  // done at 68 %, then hold
    if (beat !== 2) {
      beat = 2; commandIndex = 0; pending = null; lift = advance = heading = 0;
      bubbleAnchor.visible = ring.visible = false;
      states.forEach(state => { state.posed = false; });
    }
    const phase = shown < .5 ? 'Stair carry' : 'Precise placement';
    if (phase !== caption) { caption = phase; ctx.setCaption('HH-Bench · '+phase); }
    animateCommand(dt);
    const total = 2, held = [true,true], slots = [[.77,0],[-.77,0]];
    const squat = .22+Math.max(0,-lift)*4+lower*2.25, width = props.tasks[2].size[0], depth = .4;
    const turnAngle = heading*.3;
    // Both robots hold at the same height above their own feet; the box tilts with the
    // stairs and is level again on the landing before it is lowered onto the pad.
    cargo.set(lerp(-1.9,1.6,climb),0,0);
    const front = ramp(cargo.x+.77), rear = ramp(cargo.x-.77);
    tilt = Math.atan2(front-rear,1.54);
    cargo.y = lerp((front+rear)/2+.9,1.04,lower)+lift;
    cargo.y = Math.max(Math.max(stairHeight(cargo.x-.6),stairHeight(cargo.x+.6))+.14,cargo.y);
    const payload = props.tasks[2].cargo;
    payload.position.copy(cargo); payload.rotation.set(0,turnAngle,tilt);
    moving = false;
    states.forEach((state,i) => {
      const active = i<total;
      if (!active && !state.active && !state.retiring) { state.robot.root.visible = false; return; }
      if (active && !state.active) {
        // Newly arriving partners begin at the street edge, never at their grip.
        // Entry paths stay clear of the truck (x -2.7…-.97, z -.13….83).
        if (!state.robot.root.visible) state.robot.root.position.set(i%2 ? 2.8 : -1.45,0,i%2 ? 1.8 : -2.6);
        state.robot.root.visible = true; state.posed = false;
      }
      state.active = active; state.retiring = !active;
      const slot = slots[i] || [i%2 ? 3 : -3,2.6];
      const target = active ? new THREE.Vector3(cargo.x+slot[0]*Math.cos(turnAngle)+slot[1]*Math.sin(turnAngle),0,cargo.z-slot[0]*Math.sin(turnAngle)+slot[1]*Math.cos(turnAngle)) : new THREE.Vector3(slot[0],0,slot[1]);
      const face = (i===0 ? Math.PI : 0)+turnAngle;
      if (entering && active) {
        state.robot.root.position.copy(target); state.robot.root.visible = true;
        state.robot.body.rotation.z = face; state.posed = false;
      }
      poseRobot(state,dt,target,face,squat,active&&held[i],width,depth);
      if (!active && (ctx.reducedMotion || !state.joining)) { state.robot.root.visible = false; state.retiring = false; }
      moving ||= state.joining || state.speed > .01;
    });
    moving ||= Math.abs(p-shown) > 1e-4;
    props.update(dt,beat,Math.abs(cargo.x-1.6)<.025 && Math.abs(cargo.y-1.04)<.025);
    bubbleAnchor.position.copy(robots[0].root.position).add(new THREE.Vector3(0,1.65,0));
    ring.position.copy(robots[0].root.position); ring.position.y += .9;
  }
  return { group, update, command, stream: props.stream,
    busy: () => props.busy() || pending !== null || (!ctx.reducedMotion && moving),
    enter() { beat = -1; caption = ''; states.forEach(state => { state.active = state.retiring = state.posed = false; }); update(0,ctx.progress); },
    leave() { pending = null; ring.visible = bubbleAnchor.visible = false; }
  };
}
