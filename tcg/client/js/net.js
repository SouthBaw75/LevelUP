// net.js — WebSocket connection layer per docs/PROTOCOL.md.
// Auto-reconnects with backoff (aggressively while in a game — server holds a
// 30 s reconnect grace), ping keepalive, and a simple typed message router.

import { getPid, session } from './state.js';

const listeners = new Map(); // type -> Set<fn>   (also meta types: _open, _close, _reconnecting)
let ws = null;
let wantOpen = false;
let backoff = 600;
let reconnectTimer = null;
let pingTimer = null;
let closedByUs = false;

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => off(type, fn);
}

export function off(type, fn) {
  const set = listeners.get(type);
  if (set) set.delete(fn);
}

function emit(type, msg) {
  const set = listeners.get(type);
  if (set) for (const fn of [...set]) {
    try { fn(msg); } catch (err) { console.error('[net] handler error for', type, err); }
  }
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?pid=${encodeURIComponent(getPid())}`;
}

export function connect() {
  wantOpen = true;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  open();
}

export function disconnect() {
  wantOpen = false;
  closedByUs = true;
  clearTimeout(reconnectTimer);
  stopPing();
  if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
  session.connected = false;
}

export function isOpen() {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

export function send(obj) {
  if (!isOpen()) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

export function sendAction(action) { return send({ t: 'action', action }); }

function open() {
  closedByUs = false;
  let sock;
  try {
    sock = new WebSocket(wsUrl());
  } catch (err) {
    console.error('[net] websocket create failed', err);
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.onopen = () => {
    if (sock !== ws) return;
    backoff = 600;
    session.connected = true;
    startPing();
    emit('_open', {});
  };

  sock.onmessage = (ev) => {
    if (sock !== ws) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    emit(msg.t, msg);
    emit('_any', msg);
  };

  sock.onclose = () => {
    if (sock !== ws) return;
    ws = null;
    session.connected = false;
    stopPing();
    emit('_close', { byUs: closedByUs });
    if (wantOpen && !closedByUs) scheduleReconnect();
  };

  sock.onerror = () => { /* onclose follows; avoid console noise */ };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  // While in a game the server keeps our seat for 30s — hurry back.
  const cap = session.inGame ? 2500 : 8000;
  const delay = Math.min(backoff, cap);
  backoff = Math.min(backoff * 1.7, 8000);
  emit('_reconnecting', { delay });
  reconnectTimer = setTimeout(() => { if (wantOpen) open(); }, delay);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => { send({ t: 'ping' }); }, 15000);
}

function stopPing() {
  clearInterval(pingTimer);
  pingTimer = null;
}
