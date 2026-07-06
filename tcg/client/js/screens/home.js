// screens/home.js — boot screen: logo, tagline, name entry, online ticker.

import { getName, setName, session } from '../state.js';
import * as net from '../net.js';
import { showScreen, toast } from '../main.js';
import { findSplashLogo } from '../art.js';

let root = null;
let nameInput = null;
let connectBtn = null;
let onlineEl = null;
let statusEl = null;
let statusTimer = null;
let connecting = false;
let cardsReady = false;

const LOGO_SVG = `
<svg class="home-logo" viewBox="0 0 760 150" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="HOSTILE TAKEOVER">
  <defs>
    <linearGradient id="lg-h" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e6f9fd"/><stop offset="0.55" stop-color="#22d3ee"/><stop offset="1" stop-color="#0e7c93"/>
    </linearGradient>
    <linearGradient id="lg-t" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe4c8"/><stop offset="0.55" stop-color="#f97316"/><stop offset="1" stop-color="#9a3f06"/>
    </linearGradient>
  </defs>
  <text x="380" y="62" text-anchor="middle" font-family="-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"
        font-size="58" font-weight="800" letter-spacing="14" fill="url(#lg-h)" stroke="#0a3d49" stroke-width="0.8">HOSTILE</text>
  <text x="380" y="126" text-anchor="middle" font-family="-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"
        font-size="58" font-weight="800" letter-spacing="8" fill="url(#lg-t)" stroke="#4a1f04" stroke-width="0.8">TAKEOVER</text>
  <g stroke="#22d3ee" stroke-width="2" opacity="0.85">
    <path d="M28 75 h84" /><path d="M648 75 h84" />
    <path d="M28 75 l10 -8 m-10 8 l10 8" fill="none"/>
    <path d="M732 75 l-10 -8 m10 8 l-10 8" fill="none"/>
  </g>
  <g font-family="ui-monospace,Menlo,Consolas,monospace" font-size="10" letter-spacing="3" fill="#4a5a72">
    <text x="380" y="12" text-anchor="middle">MKT:DOMINANCE &#9650; 34.7%   VOL:HEAVY   SECTOR:ALL</text>
  </g>
</svg>`;

const TICKER_ITEMS = [
  ['NEXUS DYNAMICS', '+4.21%', 'up'], ['VULCAN HEAVY IND', '-1.08%', 'down'],
  ['HELIX BIOSYSTEMS', '+2.67%', 'up'], ['OBSIDIAN CAPITAL', '+9.99%', 'up'],
  ['GLOBAL LITIGATION INDEX', '-0.44%', 'down'], ['HOSTILE TAKEOVERS YTD', '+312', 'up'],
  ['BOARD CONFIDENCE', 'LOW', 'down'], ['SEVERANCE FUTURES', '+18.2%', 'up'],
  ['ANTITRUST HEAT', 'ELEVATED', 'down'], ['SYNERGY (ANNUALIZED)', '+6.66%', 'up'],
];

export function mount(el) {
  root = el;
  const tickerHtml = TICKER_ITEMS.concat(TICKER_ITEMS)
    .map(([n, v, dir]) => `<span style="margin:0 26px">${n} <span class="${dir}">${v}</span></span>`)
    .join('');
  el.innerHTML = `
    <div class="home-inner">
      <div class="home-brand">
        ${LOGO_SVG}
        <div class="home-tagline">MARKET DOMINANCE IS <b>NOT NEGOTIABLE</b></div>
      </div>
      <div class="home-entry">
        <input id="home-name" class="input" maxlength="20" placeholder="EXECUTIVE NAME" autocomplete="off" spellcheck="false">
        <button id="home-connect" class="btn primary">ENTER THE MARKET</button>
      </div>
      <div class="home-status">
        <span id="home-net-status"><span class="dot"></span>OFFLINE</span>
        <span id="home-online"></span>
        <span>v1.0 · TERMINAL BUILD</span>
      </div>
    </div>
    <div class="ticker"><div class="ticker-track">${tickerHtml}</div></div>
  `;
  nameInput = el.querySelector('#home-name');
  connectBtn = el.querySelector('#home-connect');
  onlineEl = el.querySelector('#home-online');
  statusEl = el.querySelector('#home-net-status');
  nameInput.value = getName();
  connectBtn.addEventListener('click', submit);

  // Drop-in full logo lockup: assets/splash-screen/logo.(png|jpg|webp). When
  // present, it replaces BOTH the text wordmark SVG and the tagline line
  // (the image is expected to already contain the title + slogan). Falls
  // back to the SVG+tagline exactly as before when no file is dropped in.
  findSplashLogo().then((url) => {
    const brand = el.querySelector('.home-brand');
    if (!url || !brand) return;
    brand.innerHTML = `<img class="home-logo-img" src="${url}" alt="HOSTILE TAKEOVER">`;
  });
}

export function enter() {
  session.inGame = false;
  connecting = false;
  connectBtn.disabled = false;
  connectBtn.textContent = 'ENTER THE MARKET';
  setTimeout(() => nameInput?.focus(), 120);
  pollStatus();
  clearInterval(statusTimer);
  statusTimer = setInterval(pollStatus, 10000);
}

export function exit() {
  clearInterval(statusTimer);
  statusTimer = null;
}

export function onKey(ev) {
  if (ev.key === 'Enter' && document.activeElement === nameInput) { submit(); return true; }
  return false;
}

export function onCardsLoaded() {
  cardsReady = true;
}

export function onOnline(n) {
  session.online = n;
  renderOnline(n);
  if (connecting) {
    connecting = false;
    showScreen('lobby');
  }
}

function renderOnline(n) {
  if (typeof n === 'number') onlineEl.innerHTML = `EXECUTIVES ONLINE: <span class="val">${n}</span>`;
}

async function pollStatus() {
  // Online-count ticker. Degrades gracefully if the endpoint is absent.
  try {
    const res = await fetch('/api/status');
    if (res.ok) {
      const j = await res.json();
      if (j && typeof j.online === 'number') renderOnline(j.online);
    }
  } catch { /* endpoint optional */ }
  const live = session.connected;
  statusEl.innerHTML = `<span class="dot"></span>${live ? 'LINK ESTABLISHED' : 'STANDBY'}`;
  statusEl.classList.toggle('live', live);
}

function submit() {
  const name = nameInput.value.trim().slice(0, 20);
  if (!name) { toast('Enter an executive name first.', 'warn'); nameInput.focus(); return; }
  if (!cardsReady) { toast('Card database still loading…', 'warn'); return; }
  setName(name);
  connecting = true;
  connectBtn.disabled = true;
  connectBtn.textContent = 'CONNECTING…';
  if (net.isOpen()) {
    net.send({ t: 'hello', name });
  } else {
    net.connect();
  }
  // safety: if nothing came back, re-enable
  setTimeout(() => {
    if (connecting) {
      connecting = false;
      connectBtn.disabled = false;
      connectBtn.textContent = 'ENTER THE MARKET';
      toast('No response from server — retrying in background.', 'warn');
    }
  }, 6000);
}
