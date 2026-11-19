import { init as initStage } from './js/stage/core.js';
import { init as initPano } from './js/pano.js';

const toggle = document.querySelector('.theme-toggle');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]').setAttribute('content', theme);
  const dark = theme === 'dark';
  toggle.setAttribute('aria-pressed', String(dark));
  toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  document.dispatchEvent(new Event('themechange'));
}
applyTheme(document.documentElement.dataset.theme || 'light');
toggle.hidden = false;
toggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { localStorage.setItem('theme', theme); } catch {}
});

document.querySelectorAll('a[data-u][data-d]').forEach((link) => {
  const address = `${link.dataset.u}@${link.dataset.d}`;
  link.textContent = address;
  link.href = `mailto:${address}`;
});
document.querySelectorAll('.copy-email').forEach((copy) => {
  const row = copy.closest('.email-row');
  const status = row.querySelector('.copy-status');
  let timer;
  copy.hidden = false;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(row.querySelector('a[data-u]').textContent);
      copy.textContent = 'Copied';
      status.textContent = 'Email address copied.';
      clearTimeout(timer);
      timer = setTimeout(() => { copy.textContent = 'Copy'; status.textContent = ''; }, 1500);
    } catch {
      status.textContent = 'Copy unavailable. Select the email address to copy it.';
    }
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(timer);
    copy.textContent = 'Copy';
    status.textContent = '';
  });
});

const stageElement = document.querySelector('.stage');
if (stageElement) {
  const caption = document.querySelector('.stage-caption');
  const stage = initStage(stageElement, { onCaption: (text) => { caption.textContent = text; caption.hidden = !text; } });
  const sections = [...document.querySelectorAll('section[data-act]')];
  const tracks = [...document.querySelectorAll('[data-track]')];
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let active = sections[0], progress = 0, scheduled = 0;
  function syncStage() {
    scheduled = 0;
    const line = innerHeight * .36;
    // Complete all geometry reads before stage/caption/ARIA writes.
    const rects = sections.map(section => section.getBoundingClientRect());
    let index = 0;
    rects.forEach((rect, i) => { if (rect.top <= line) index = i; });
    active = sections[index];
    const rect = rects[index];
    progress = Math.max(0, Math.min(1, (line - rect.top) / Math.max(1, rect.height)));
    const explore = sections.filter(section => section.dataset.act === 'explore');
    const exploreIndex = explore.indexOf(active);
    const exploreProgress = motion.matches ? [0,.5,1][Math.min(2, Math.max(0, exploreIndex))] : (exploreIndex + progress) / explore.length;
    const shown = rects.at(-1).bottom > line;
    stage.setVisible(shown);
    stage.setAct(active.dataset.act, progress, exploreProgress);
    tracks.forEach((link) => {
      if (shown && link.dataset.track === active.dataset.act) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  function requestSync() { if (!scheduled) scheduled = requestAnimationFrame(syncStage); }
  const approachObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) {
      stage.approach(entry.target.dataset.act);
      approachObserver.unobserve(entry.target);
    }
  }, { rootMargin: `${innerHeight}px 0px` });
  sections.filter(section => section.dataset.act !== 'intro').forEach(section => approachObserver.observe(section));
  const sectionObserver = new IntersectionObserver(requestSync);
  sections.forEach((section) => sectionObserver.observe(section));
  window.addEventListener('scroll', requestSync, { passive: true });
  window.addEventListener('resize', requestSync, { passive: true });
  tracks.forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    const section = document.getElementById(link.hash.slice(1));
    section.scrollIntoView({ behavior: motion.matches ? 'instant' : 'smooth', block: 'start' });
    history.replaceState(null, '', link.hash);
  }));
  const command = document.querySelector('.command-button');
  command.hidden = false;
  command.addEventListener('click', () => {
    stage.setAct('heaveho', active.dataset.act === 'heaveho' ? progress : 0);
    stage.command();
  });

  const videos = [...document.querySelectorAll('.visible-video')];
  const inView = new Set(), userPaused = new WeakSet();
  const automaticPauses = new WeakSet();
  function pauseAutomatically(video) {
    if (!video.paused) {
      automaticPauses.add(video);
      video.pause();
    }
  }
  function playVisible(video) {
    if (!document.hidden && inView.has(video) && !video.hidden && !motion.matches && !userPaused.has(video)) video.play().catch(() => {});
    else pauseAutomatically(video);
  }
  const videoObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) inView.add(entry.target); else inView.delete(entry.target);
      playVisible(entry.target);
    });
  }, { threshold: .2 });
  videos.forEach((video) => {
    video.addEventListener('pause', () => {
      if (automaticPauses.has(video)) automaticPauses.delete(video);
      else if (inView.has(video) && !document.hidden) userPaused.add(video);
    });
    video.addEventListener('play', () => userPaused.delete(video));
    videoObserver.observe(video);
  });
  document.addEventListener('visibilitychange', () => videos.forEach(playVisible));
  motion.addEventListener('change', () => videos.forEach(playVisible));
  const teamVideo = document.getElementById('team-video');
  const clips = { heaveho: 'Two humanoid robots carrying a box through a narrow door together', hh_real4: 'Four G1 humanoids carrying a table', hh_human: 'Three G1 humanoids and a person collaborating', hh_sim10: 'Ten G1 humanoids collaborating in simulation' };
  const tabs = [...document.querySelectorAll('[data-clip]')];
  document.querySelector('.clip-tabs').hidden = false;
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    const clip = tab.dataset.clip;
    if (!Object.hasOwn(clips, clip)) throw new Error('Unknown Heave-Ho clip.');
    tabs.forEach((item) => item.setAttribute('aria-pressed', String(item === tab)));
    pauseAutomatically(teamVideo);
    teamVideo.poster = `assets/media/${clip}.jpg`;
    teamVideo.querySelector('source').src = `assets/media/${clip}.mp4`;
    teamVideo.setAttribute('aria-label', clips[clip]);
    userPaused.delete(teamVideo);
    teamVideo.load();
    playVisible(teamVideo);
  }));
  let pano;
  const panoReadout = document.querySelector('.pano-readout');
  function formatPanoReadout() {
    const formatted = panoReadout.textContent.replaceAll(' · ', ', ');
    if (formatted !== panoReadout.textContent) panoReadout.textContent = formatted;
  }
  const readoutObserver = new MutationObserver(formatPanoReadout);
  readoutObserver.observe(panoReadout, { childList: true });
  formatPanoReadout();
  const look = document.querySelector('.look-around');
  const figure = document.getElementById('pwp-pano');
  const teaser = document.getElementById('pwp-teaser');
  look.hidden = false;
  look.addEventListener('click', () => {
    const open = look.getAttribute('aria-expanded') !== 'true';
    look.setAttribute('aria-expanded', String(open));
    figure.hidden = !open;
    teaser.hidden = open;
    if (open) {
      pauseAutomatically(teaser);
      pano = initPano(figure);
    } else {
      pano?.destroy(); pano = null;
      document.getElementById('pano-video').pause();
      playVisible(teaser);
    }
  });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    cancelAnimationFrame(scheduled);
    sectionObserver.disconnect(); approachObserver.disconnect(); videoObserver.disconnect(); readoutObserver.disconnect();
    pano?.destroy(); stage.destroy();
  });
  syncStage();
}
