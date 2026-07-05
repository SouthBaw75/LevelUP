// audio.js — drop-in sound system. Looping background music and one-shot sound
// effects are loaded by filename convention from assets/audio/ (see that
// folder's README.md). Any file that doesn't exist is silently ignored, so
// sound can be added incrementally with zero code changes.
//
// Music and sound effects are independently enabled/disabled (see the
// settings popover wired up in main.js) and each choice persists separately.

const AUDIO_DIR = 'assets/audio';
const EXTS = ['mp3', 'ogg', 'm4a', 'wav']; // probed in this order
const MAX_VARIANTS = 8; // sfx-destroy-1 .. sfx-destroy-8
const urlCache = new Map();     // name -> Promise<string|null>
const variantCache = new Map(); // name -> Promise<string[]> (all found variant URLs)

const LS_MUSIC = 'ht_music_on';
const LS_SFX = 'ht_sfx_on';
const MUSIC_VOL = 0.4;
const SFX_VOL = 0.7;

let musicOn = localStorage.getItem(LS_MUSIC) !== '0'; // default on
let sfxOn = localStorage.getItem(LS_SFX) !== '0';      // default on
let musicEl = null;
let currentMusic = null; // name currently loaded into musicEl
let wantMusic = null;    // name we want playing (for autoplay/settings-change retry)
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

// A sound effect can have multiple randomized takes: assets/audio/<name>.*
// (the plain file) plus assets/audio/<name>-1.*, <name>-2.*, ... <name>-8.*.
// Both <name>-N (hyphenated) and <name>N (bare) suffixes are probed, since
// files have shown up saved either way — every variant found (either style)
// goes into the same pool. Every variant that exists is collected once
// (cached), then playSfx picks a random one on each play. A single plain
// file works exactly as before.
function findVariants(name) {
  if (variantCache.has(name)) return variantCache.get(name);
  const candidates = [name];
  for (let i = 1; i <= MAX_VARIANTS; i++) { candidates.push(`${name}-${i}`); candidates.push(`${name}${i}`); }
  const p = Promise.all(candidates.map(findAudio)).then((urls) => urls.filter(Boolean));
  variantCache.set(name, p);
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
    if (wantMusic && musicOn) playMusic(wantMusic);
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

/** Loop a background music track by name (e.g. "music-lobby"). No-op if music
 *  is disabled or the file is absent. Crossfades from any current track. */
export async function playMusic(name) {
  wantMusic = name;
  if (!musicOn) return;
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
 *  name if the first has no files at all. No-op if SFX are disabled or no
 *  file exists. If multiple numbered variants exist for the name (e.g.
 *  sfx-destroy-1, sfx-destroy-2, ...), one is picked at random each call. */
export async function playSfx(name, fallback) {
  if (!sfxOn) return;
  let urls = await findVariants(name);
  if (!urls.length && fallback) urls = await findVariants(fallback);
  if (!urls.length) return;
  const url = urls[Math.floor(Math.random() * urls.length)];
  const a = new Audio(url);
  a.volume = SFX_VOL;
  a.play().catch(() => {});
}

/** Faction-select sting: assets/audio/select-<faction>.*, falling back to a
 *  generic assets/audio/ui-select.* if no per-faction file exists. */
export function playFactionSelect(faction) {
  playSfx('select-' + faction, 'ui-select');
}

/** Winning CEO's victory taunt: assets/audio/ceo-taunts/<faction>.*, plus any
 *  numbered variants (<faction>-1.*, <faction>-2.*, ...) picked at random —
 *  same convention as the sfx-destroy variants, just nested one folder down. */
export function playCeoTaunt(faction) {
  playSfx('ceo-taunts/' + faction);
}

export function isMusicOn() { return musicOn; }
export function isSfxOn() { return sfxOn; }

/** Set music on/off; persists to localStorage. */
export function setMusicOn(on) {
  musicOn = on;
  localStorage.setItem(LS_MUSIC, on ? '1' : '0');
  if (!on) {
    if (musicEl) fadeTo(0);
  } else if (wantMusic) {
    playMusic(wantMusic);
  }
}

/** Set sound effects on/off; persists to localStorage. */
export function setSfxOn(on) {
  sfxOn = on;
  localStorage.setItem(LS_SFX, on ? '1' : '0');
}
