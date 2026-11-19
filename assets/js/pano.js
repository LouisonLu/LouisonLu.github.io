// A single local ERP video is sampled through a full-screen ray projection.
// Raw WebGL keeps the phone player independent of the desktop three.js scenes.
export function init(figureElement) {
  const stage = figureElement.querySelector('.pano-stage');
  const video = figureElement.querySelector('#pano-video');
  const controls = figureElement.querySelector('.pano-controls');
  const playButton = figureElement.querySelector('.pano-play');
  const readout = figureElement.querySelector('.pano-readout');
  const modeButtons = [...figureElement.querySelectorAll('[data-pano-mode]')];
  if (!stage || !video || !controls || !playButton || !readout || modeButtons.length !== 2) {
    throw new Error('Incomplete panorama figure');
  }
  const canvas = document.createElement('canvas');
  let gl;
  try {
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false });
  } catch { /* A native video remains usable when WebGL is disabled. */ }
  if (!gl) return { destroy() {} };

  const original = { hidden: video.hidden, controls: video.controls, playHidden: playButton.hidden };
  const shaders = [];
  let program;
  let buffer;
  let texture;
  function release() {
    if (texture) gl.deleteTexture(texture);
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    shaders.forEach((shader) => gl.deleteShader(shader));
  }
  function compile(type, source) {
    const shader = gl.createShader(type);
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Projection unavailable');
    return shader;
  }
  try {
    const vertex = compile(gl.VERTEX_SHADER, `
      attribute vec2 position;
      varying vec2 screen;
      void main() { screen = position; gl_Position = vec4(position, 0., 1.); }
    `);
    const fragment = compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec2 screen;
      uniform sampler2D panorama;
      uniform float aspect;
      uniform float yaw;
      uniform float pitch;
      uniform float fov;
      uniform float planet;
      const float PI = 3.14159265359;
      void main() {
        float extent = tan(fov * .5);
        vec2 point = screen * vec2(aspect, 1.) * extent;
        vec3 ray;
        if (planet > .5) {
          // Inverse stereographic projection: nadir at centre, horizon at radius 1.
          float radius2 = dot(point, point);
          ray = vec3(2. * point.x, radius2 - 1., -2. * point.y) / (1. + radius2);
        } else {
          ray = normalize(vec3(point, -1.));
        }
        float cp = cos(pitch), sp = sin(pitch);
        ray = vec3(ray.x, cp * ray.y - sp * ray.z, sp * ray.y + cp * ray.z);
        float cy = cos(yaw), sy = sin(yaw);
        ray = vec3(cy * ray.x - sy * ray.z, ray.y, sy * ray.x + cy * ray.z);
        vec2 erp = vec2(fract(atan(ray.x, -ray.z) / (2. * PI) + .5), asin(clamp(ray.y, -1., 1.)) / PI + .5);
        gl_FragColor = texture2D(panorama, erp);
      }
    `);
    program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Projection unavailable');
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([24, 28, 29]));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  } catch {
    release();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { destroy() {} };
  }
  const locations = Object.fromEntries(['aspect', 'yaw', 'pitch', 'fov', 'planet', 'panorama'].map((key) => [key, gl.getUniformLocation(program, key)]));
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const theme = matchMedia('(prefers-color-scheme: dark)');
  const pointers = new Map();
  const listeners = [];
  const degrees = Math.PI / 180;
  let destroyed = false;
  let failed = false;
  let visible = !('IntersectionObserver' in window);
  let frame = 0;
  let yaw = 0;
  let pitch = 0;
  let fov = 90;
  let planet = false;
  let velocityX = 0;
  let velocityY = 0;
  let previousTime = 0;
  let userPlayed = false;
  let userPaused = false;
  let pinchDistance = 0;
  let pinchFov = 90;
  let loaded = false;
  let posterReady = false;
  let textureReady = false;
  let palette = {};
  const poster = new Image();
  function listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    listeners.push(() => target.removeEventListener(event, handler, options));
  }
  function canRender() { return !destroyed && !failed && visible && !document.hidden; }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
  }
  function requestRender() {
    if (!frame && canRender()) frame = requestAnimationFrame(render);
  }
  function updateReadout() {
    const wrapYaw = ((yaw / degrees + 180) % 360 + 360) % 360 - 180;
    readout.textContent = `yaw ${Math.round(wrapYaw)}° · pitch ${Math.round(pitch / degrees)}° · fov ${Math.round(fov)}°`;
  }
  function updatePlayButton() {
    playButton.textContent = video.paused ? 'Play' : 'Pause';
    playButton.setAttribute('aria-label', `${video.paused ? 'Play' : 'Pause'} PwP 360° video`);
  }
  function syncPlayback() {
    if (failed || destroyed) return;
    const shouldPlay = visible && !document.hidden && !userPaused && (!motion.matches || userPlayed);
    if (shouldPlay) {
      if (!loaded) { video.load(); loaded = true; }
      video.play().catch(() => { if (!destroyed) updatePlayButton(); });
      requestRender();
    } else {
      video.pause();
      if (!canRender()) stop();
      else requestRender();
    }
    updatePlayButton();
  }
  function setFallback() {
    if (failed || destroyed) return;
    failed = true;
    stop();
    video.pause();
    video.hidden = original.hidden;
    video.controls = original.controls;
    canvas.hidden = true;
    controls.hidden = true;
    playButton.hidden = original.playHidden;
  }
  function render(now) {
    frame = 0;
    if (!canRender()) return;
    const elapsed = previousTime ? Math.min((now - previousTime) / 16.667, 3) : 1;
    previousTime = now;
    if (!motion.matches && pointers.size === 0) {
      yaw += velocityX * elapsed;
      pitch = Math.max(-85 * degrees, Math.min(85 * degrees, pitch + velocityY * elapsed));
      const damping = Math.pow(.9, elapsed);
      velocityX *= damping;
      velocityY *= damping;
    }
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (video.readyState >= 2) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
        textureReady = true;
      }
      catch { setFallback(); return; }
    } else if (posterReady) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, poster);
      posterReady = false;
      textureReady = true;
    }
    if (!textureReady) {
      // Keep the native poster visible until a real local frame is uploaded.
      updateReadout();
      if (!video.paused) requestRender();
      return;
    }
    // The opaque projection covers the native video while it stays in-page for
    // mobile video playback policies; its poster also survives before upload.
    canvas.hidden = false;
    gl.uniform1i(locations.panorama, 0);
    gl.uniform1f(locations.aspect, canvas.width / canvas.height);
    gl.uniform1f(locations.yaw, yaw);
    gl.uniform1f(locations.pitch, pitch);
    gl.uniform1f(locations.fov, fov * degrees);
    gl.uniform1f(locations.planet, planet ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    updateReadout();
    if (!video.paused || (!motion.matches && (Math.abs(velocityX) + Math.abs(velocityY) > .00005))) requestRender();
    else previousTime = 0;
  }
  function resize() {
    if (destroyed || failed) return;
    const bounds = stage.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    gl.viewport(0, 0, canvas.width, canvas.height);
    requestRender();
  }
  function readTheme() {
    const styles = getComputedStyle(document.documentElement);
    palette = Object.fromEntries(['paper', 'ink', 'steel', 'line', 'tape-ink'].map((name) => [name, styles.getPropertyValue(`--${({ paper: 'page', 'tape-ink': 'signal-ink' })[name] || name}`).trim()]));
    canvas.style.background = palette.paper;
    canvas.style.color = palette.ink;
    canvas.style.outlineColor = palette['tape-ink'];
    canvas.style.borderColor = palette.line;
    readout.style.color = palette.steel;
    requestRender();
  }
  function pointerDistance() {
    const values = [...pointers.values()];
    return values.length >= 2 ? Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) : 0;
  }
  listen(canvas, 'pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    velocityX = velocityY = 0;
    if (pointers.size === 2) { pinchDistance = pointerDistance(); pinchFov = fov; }
    requestRender();
  });
  listen(canvas, 'pointermove', (event) => {
    const old = pointers.get(event.pointerId);
    if (!old) return;
    const dx = event.clientX - old.x;
    const dy = event.clientY - old.y;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      const distance = pointerDistance();
      if (pinchDistance > 0 && distance > 0) fov = Math.max(50, Math.min(110, pinchFov * pinchDistance / distance));
    } else {
      const sensitivity = fov * degrees / Math.max(stage.clientHeight, 1);
      const horizontal = -dx * sensitivity;
      const vertical = dy * sensitivity;
      yaw += horizontal;
      pitch = Math.max(-85 * degrees, Math.min(85 * degrees, pitch + vertical));
      velocityX = motion.matches ? 0 : horizontal * .6;
      velocityY = motion.matches ? 0 : vertical * .6;
    }
    requestRender();
  });
  function endPointer(event) {
    pointers.delete(event.pointerId);
    pinchDistance = 0;
    requestRender();
  }
  listen(canvas, 'pointerup', endPointer);
  listen(canvas, 'pointercancel', endPointer);
  listen(canvas, 'lostpointercapture', endPointer);
  listen(canvas, 'wheel', (event) => {
    event.preventDefault();
    fov = Math.max(50, Math.min(110, fov + event.deltaY * .04));
    requestRender();
  }, { passive: false });
  listen(canvas, 'keydown', (event) => {
    const actions = { ArrowLeft: () => { yaw -= 5 * degrees; }, ArrowRight: () => { yaw += 5 * degrees; }, ArrowUp: () => { pitch = Math.min(85 * degrees, pitch + 5 * degrees); }, ArrowDown: () => { pitch = Math.max(-85 * degrees, pitch - 5 * degrees); }, '+': () => { fov = Math.max(50, fov - 5); }, '-': () => { fov = Math.min(110, fov + 5); } };
    if (!actions[event.key]) return;
    event.preventDefault();
    actions[event.key]();
    requestRender();
  });
  for (const button of modeButtons) {
    listen(button, 'click', () => {
      planet = button.dataset.panoMode === 'planet';
      modeButtons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      velocityX = velocityY = 0;
      requestRender();
    });
  }
  listen(playButton, 'click', () => {
    if (video.paused) { userPaused = false; userPlayed = true; }
    else userPaused = true;
    syncPlayback();
  });
  listen(video, 'play', () => { updatePlayButton(); requestRender(); });
  listen(video, 'pause', updatePlayButton);
  listen(video, 'loadeddata', requestRender);
  listen(video, 'seeked', requestRender);
  listen(video, 'error', setFallback);
  listen(canvas, 'webglcontextlost', (event) => { event.preventDefault(); setFallback(); });
  listen(document, 'visibilitychange', () => { velocityX = velocityY = 0; syncPlayback(); });
  listen(theme, 'change', readTheme);
  listen(motion, 'change', () => { velocityX = velocityY = 0; userPlayed = false; syncPlayback(); });
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  const visibilityObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    if (!visible) { velocityX = velocityY = 0; pointers.clear(); }
    syncPlayback();
  }, { threshold: 0 }) : null;
  visibilityObserver?.observe(stage);
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'PwP 360° video. Drag to look around; use arrow keys to look, plus or minus to zoom.');
  canvas.style.touchAction = 'none';
  canvas.hidden = true;
  stage.append(canvas);
  video.controls = false;
  video.muted = true;
  video.loop = true;
  video.autoplay = false;
  controls.hidden = false;
  playButton.hidden = false;
  poster.onload = () => { if (!destroyed && !failed) { posterReady = true; requestRender(); } };
  poster.src = video.poster;
  readTheme();
  resize();
  syncPlayback();
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      video.pause();
      listeners.forEach((remove) => remove());
      resizeObserver.disconnect();
      visibilityObserver?.disconnect();
      poster.onload = null;
      pointers.clear();
      release();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
      video.hidden = original.hidden;
      video.controls = original.controls;
      controls.hidden = true;
      playButton.hidden = original.playHidden;
      readout.style.removeProperty('color');
    }
  };
}
