// audio.js — drop-in sound system. Looping background music and one-shot sound
// effects are loaded by filename convention from assets/audio/ (see that
// folder's README.md). Any file that doesn't exist is silently ignored, so
// sound can be added incrementally with zero code changes.

const AUDIO_DIR = 'assets/audio';
const EXTS = ['mp3', 'ogg', 'm4a', 'wav']; // probed in this order
const urlCache = new Map(); // name -> Promise<string|null>

const LS_MUTE = 'ht_muted';
const MUSIC_VOL = 0.4;
const SFX_VOL = 0.7;

let muted = localStorage.getItem(LS_MUTE) === '1';
let musicEl = null;
let currentMusic = null; // name currently loaded into musicEl
let wantMusic = null;    // name we want playing (for autoplay/unmute retry)
let fadeTimer = null;
let gestureArmed = false;

// Resolve <name> to the first assets/audio/<name>.<ext> that exists, else null.
// Cached so a screen re-entry never re-probes the same files.
function findAudio(name) {
  if (urlCache.has(name)) return urlCache.get(name);
  const p = (async () => {
    for (const ext of EXTS) {
      const url = `${AUDIO_DIR}/${name}.${ext}`;
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (res.ok) return url;
      } catch { /* network/format issue — try next ext */ }
    }
    return null;
  })();
  urlCache.set(name, p);
  return p;
}

// Browsers block audio until the first user gesture. If play() is rejected,
// wait for the next pointerdown and start the wanted track then.
function armGesture() {
  if (gestureArmed) return;
  gestureArmed = true;
  const handler = () => {
    gestureArmed = false;
    window.removeEventListener('pointerdown', handler);
    if (wantMusic && !muted) playMusic(wantMusic);
  };
  window.addEventListener('pointerdown', handler, { once: true });
}

function fadeTo(target, ms = 600) {
  if (!musicEl) return;
  clearInterval(fadeTimer);
  const start = musicEl.volume;
  const steps = 12;
  let i = 0;
  fadeTimer = setInterval(() => {
    i += 1;
    musicEl.volume = Math.max(0, Math.min(1, start + (target - start) * (i / steps)));
    if (i >= steps) {
      clearInterval(fadeTimer);
      if (target === 0 && musicEl) musicEl.pause();
    }
  }, ms / steps);
}

/** Loop a background music track by name (e.g. "music-lobby"). No-op if muted
 *  or the file is absent. Crossfades from any current track. */
export async function playMusic(name) {
  wantMusic = name;
  if (muted) return;
  const url = await findAudio(name);
  if (!url) { currentMusic = null; return; }
  if (currentMusic === name && musicEl && !musicEl.paused) return;
  if (!musicEl) { musicEl = new Audio(); musicEl.loop = true; }
  currentMusic = name;
  musicEl.src = url;
  musicEl.volume = 0;
  try {
    await musicEl.play();
    fadeTo(MUSIC_VOL);
  } catch {
    armGesture(); // autoplay blocked until a user gesture
  }
}

export function stopMusic() {
  wantMusic = null;
  currentMusic = null;
  if (musicEl) fadeTo(0);
}

/** Play a one-shot sound effect by name, optionally falling back to another
 *  name if the first file is absent. No-op if muted or neither file exists. */
export async function playSfx(name, fallback) {
  if (muted) return;
  let url = await findAudio(name);
  if (!url && fallback) url = await findAudio(fallback);
  if (!url) return;
  const a = new Audio(url);
  a.volume = SFX_VOL;
  a.play().catch(() => {});
}

/** Faction-select sting: assets/audio/select-<faction>.*, falling back to a
 *  generic assets/audio/ui-select.* if no per-faction file exists. */
export function playFactionSelect(faction) {
  playSfx('select-' + faction, 'ui-select');
}

export function isMuted() { return muted; }

/** Toggle global mute; persists to localStorage. Returns the new muted state. */
export function toggleMute() {
  muted = !muted;
  localStorage.setItem(LS_MUTE, muted ? '1' : '0');
  if (muted) {
    if (musicEl) fadeTo(0);
  } else if (wantMusic) {
    playMusic(wantMusic);
  }
  return muted;
}
