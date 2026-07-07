// HOSTILE TAKEOVER — server entry point.
// HTTP (static client + /api/cards + /api/status) and WebSocket (/ws) on one port.
// Run: `npm start` (PORT env or 3000).

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CARDS, STARTER_DECKS } from '../shared/cards.js';
import { createRequestHandler } from './static.js';
import { Lobby } from './lobby.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const MAX_WS_PAYLOAD = 32 * 1024; // largest legit message is a 30-card deck

// Faction metadata (contract §2).
const FACTIONS = {
  nexus: {
    id: 'nexus',
    name: 'Nexus Dynamics',
    industry: 'AI & software',
    color: '#22d3ee',
    tagline: 'The market is a training set.',
  },
  vulcan: {
    id: 'vulcan',
    name: 'Vulcan Heavy Industries',
    industry: 'Manufacturing/defense',
    color: '#f97316',
    tagline: 'Quarterly targets are not a suggestion.',
  },
  helix: {
    id: 'helix',
    name: 'Helix Biosystems',
    industry: 'Biotech',
    color: '#4ade80',
    tagline: 'Growth is a moral imperative.',
  },
  obsidian: {
    id: 'obsidian',
    name: 'Obsidian Capital',
    industry: 'Finance/private equity',
    color: '#c084fc',
    tagline: 'Everything is for sale. Especially you.',
  },
  neutral: {
    id: 'neutral',
    name: 'Independent Contractors',
    industry: '—',
    color: '#94a3b8',
    tagline: 'Loyalty sold separately.',
  },
};

// GET /api/cards payload, serialized once at boot: card defs WITHOUT `effects`.
// A few structural markers the CLIENT needs for rendering (but which live
// inside the otherwise-opaque `effects` DSL) are surfaced as flat booleans:
//   reserve — War Chest-style capital reserve; the tile draws a safe/vault
//             glyph instead of the generic contract folder (for BOTH players,
//             since the bank amount itself stays private).
function buildCardsJson() {
  const cards = {};
  for (const [id, def] of Object.entries(CARDS)) {
    if (!def || typeof def !== 'object') continue;
    const { effects, ...pub } = def;
    if (effects && effects.reserve) pub.reserve = true;
    cards[id] = pub;
  }
  return JSON.stringify({ cards, starterDecks: STARTER_DECKS, factions: FACTIONS });
}

const lobby = new Lobby();

const httpServer = http.createServer(
  createRequestHandler({
    clientDir: CLIENT_DIR,
    cardsJson: buildCardsJson(),
    getStatus: () => lobby.counts(),
  })
);

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

httpServer.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const pid = url.searchParams.get('pid');
    wss.handleUpgrade(req, socket, head, (ws) => {
      lobby.addSocket(ws, pid);
    });
  } catch {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
});

// A rogue socket error must never take the process down.
wss.on('error', (err) => console.error('[wss] error:', err));
httpServer.on('error', (err) => {
  console.error('[http] error:', err);
  if (err && err.code === 'EADDRINUSE') process.exit(1);
});
process.on('uncaughtException', (err) => console.error('[fatal-guard] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[fatal-guard] unhandledRejection:', err));

httpServer.listen(PORT, () => {
  console.log(`HOSTILE TAKEOVER server listening on http://localhost:${PORT} (ws path /ws)`);
});

function shutdown() {
  console.log('Shutting down...');
  lobby.shutdown();
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
