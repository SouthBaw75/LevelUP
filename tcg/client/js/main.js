// main.js — app bootstrap, screen router, toasts, global net wiring.

import { loadCards, session, getName } from './state.js';
import * as net from './net.js';
import * as audio from './audio.js';
import * as home from './screens/home.js';
import * as lobby from './screens/lobby.js';
import * as builder from './screens/builder.js';
import * as game from './screens/game.js';

const SCREENS = { home, lobby, builder, game };
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
  // in-match music on the board, lobby music everywhere else
  audio.playMusic(name === 'game' ? 'music-game' : 'music-lobby');
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

// ---------- audio: mute toggle + UI click sounds ----------
const audioBtn = document.createElement('button');
audioBtn.id = 'audio-toggle';
audioBtn.className = 'audio-toggle';
const paintAudioBtn = () => {
  const m = audio.isMuted();
  audioBtn.textContent = m ? '🔇' : '🔊';
  audioBtn.title = m ? 'Sound off — click to enable' : 'Sound on — click to mute';
  audioBtn.classList.toggle('muted', m);
};
audioBtn.addEventListener('click', () => { audio.toggleMute(); paintAudioBtn(); });
paintAudioBtn();
document.body.appendChild(audioBtn);

// Click sound for menu buttons (not the game board, the audio toggle, or the
// faction cards — those have their own faction-select sting).
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn || btn === audioBtn) return;
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
