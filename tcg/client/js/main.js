// main.js — app bootstrap, screen router, toasts, global net wiring.

import { loadCards, session, getName } from './state.js';
import * as net from './net.js';
import * as audio from './audio.js';
import * as home from './screens/home.js';
import * as lobby from './screens/lobby.js';
import * as builder from './screens/builder.js';
import * as game from './screens/game.js';
import * as watch from './screens/watch.js';

const SCREENS = { home, lobby, builder, game, watch };
let current = null;
let currentName = null;

export function showScreen(name, params) {
  if (currentName === name) { SCREENS[name].enter?.(params); return; }
  if (current) {
    current.exit?.();
    const oldEl = document.getElementById('screen-' + currentName);
    oldEl.classList.remove('shown');
    oldEl.classList.remove('active');
  }
  currentName = name;
  current = SCREENS[name];
  const el = document.getElementById('screen-' + name);
  el.classList.add('active');
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('shown')));
  current.enter?.(params);
  // in-match music on the board, generic game music while spectating, lobby
  // music everywhere else
  if (name === 'game') playGameMusic(params?.view?.you?.faction);
  else if (name === 'watch') playGameMusic(null);
  else audio.playMusic('music-lobby');
}

/** In-match music keyed to the LOCAL player's own faction (not whichever CEO's
 *  turn it is) — assets/audio/music-<faction>.mp3, falling back to the
 *  generic music-game.mp3 if that faction's track hasn't been dropped in. */
export function playGameMusic(faction) {
  audio.playMusic(faction ? 'music-' + faction : 'music-game', 'music-game');
}

export function activeScreenName() { return currentName; }

// ---------- toasts ----------
export function toast(msg, cls = '', ms = 3200) {
  const layer = document.getElementById('toast-layer');
  const el = document.createElement('div');
  el.className = 'toast' + (cls ? ' ' + cls : '');
  el.textContent = msg;
  layer.appendChild(el);
  while (layer.childElementCount > 4) layer.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 350);
  }, ms);
  return el;
}

// ---------- connection badge ----------
const connBadge = document.createElement('div');
connBadge.className = 'conn-badge';
connBadge.textContent = 'CONNECTION LOST — RECONNECTING…';
document.body.appendChild(connBadge);

// ---------- audio settings: gear button + Music/SFX popover ----------
// This button is appended once to <body>, so it floats above every screen —
// lobby and in-game both get it without any per-screen wiring.
const audioBtn = document.createElement('button');
audioBtn.id = 'audio-settings-btn';
audioBtn.className = 'audio-toggle';
audioBtn.textContent = '⚙';
audioBtn.title = 'Sound settings';
document.body.appendChild(audioBtn);

const audioPopover = document.createElement('div');
audioPopover.id = 'audio-popover';
audioPopover.className = 'audio-popover';
audioPopover.innerHTML = `
  <div class="audio-pop-title">SOUND SETTINGS</div>
  <label class="audio-row"><span>Music</span>
    <button class="switch" id="audio-music-switch" role="switch"><span class="knob"></span></button>
  </label>
  <label class="audio-row"><span>Sound Effects</span>
    <button class="switch" id="audio-sfx-switch" role="switch"><span class="knob"></span></button>
  </label>
`;
document.body.appendChild(audioPopover);

const musicSwitch = audioPopover.querySelector('#audio-music-switch');
const sfxSwitch = audioPopover.querySelector('#audio-sfx-switch');

function paintSwitches() {
  musicSwitch.classList.toggle('on', audio.isMusicOn());
  musicSwitch.setAttribute('aria-checked', String(audio.isMusicOn()));
  sfxSwitch.classList.toggle('on', audio.isSfxOn());
  sfxSwitch.setAttribute('aria-checked', String(audio.isSfxOn()));
  audioBtn.classList.toggle('muted', !audio.isMusicOn() && !audio.isSfxOn());
}
paintSwitches();

musicSwitch.addEventListener('click', () => { audio.setMusicOn(!audio.isMusicOn()); paintSwitches(); });
sfxSwitch.addEventListener('click', () => { audio.setSfxOn(!audio.isSfxOn()); paintSwitches(); if (audio.isSfxOn()) audio.playSfx('ui-click'); });

audioBtn.addEventListener('click', (ev) => {
  ev.stopPropagation();
  audioPopover.classList.toggle('open');
});
document.addEventListener('click', (ev) => {
  if (audioPopover.classList.contains('open') && !audioPopover.contains(ev.target) && ev.target !== audioBtn) {
    audioPopover.classList.remove('open');
  }
});

// Click sound for menu buttons (not the game board, the audio controls, or
// the faction cards — those have their own faction-select sting).
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn || btn === audioBtn || audioPopover.contains(btn)) return;
  if (currentName === 'game') return;
  if (btn.closest('.faction-card')) return;
  audio.playSfx('ui-click');
});

// ---------- global net wiring ----------
let lostToastShown = false;

net.on('_open', () => {
  connBadge.classList.remove('show');
  if (lostToastShown) { toast('Connection restored.'); lostToastShown = false; }
  const name = session.name || getName();
  if (name) net.send({ t: 'hello', name });
});

net.on('_close', ({ byUs }) => {
  if (byUs) return;
  connBadge.classList.add('show');
  if (!lostToastShown) { toast('Connection lost — reconnecting…', 'warn', 4200); lostToastShown = true; }
});

net.on('helloOk', (msg) => {
  session.online = msg.online;
  home.onOnline?.(msg.online);
  lobby.onOnline?.(msg.online);
});

net.on('error', (msg) => toast(msg.msg || 'Server error', 'error'));
net.on('pong', () => { /* keepalive ack */ });

net.on('gameStart', (msg) => {
  session.inGame = true;
  showScreen('game', msg);
});

// ---------- global keyboard ----------
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && audioPopover.classList.contains('open')) {
    audioPopover.classList.remove('open');
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (current?.onKey && current.onKey(ev, typing)) { ev.preventDefault(); return; }
  if (typing) return;
});

// suppress default context menu during a match (right-click cancels targeting)
document.addEventListener('contextmenu', (ev) => {
  if (currentName === 'game') ev.preventDefault();
});

// ---------- boot ----------
async function boot() {
  for (const [name, mod] of Object.entries(SCREENS)) {
    mod.mount?.(document.getElementById('screen-' + name));
  }
  showScreen('home');
  try {
    await loadCards();
    home.onCardsLoaded?.();
  } catch (err) {
    console.error('card db load failed', err);
    toast('Failed to load card database — retrying…', 'error');
    setTimeout(async () => {
      try { await loadCards(); home.onCardsLoaded?.(); }
      catch { toast('Card database unavailable. Is the server running?', 'error', 8000); }
    }, 2500);
  }
}

boot();
