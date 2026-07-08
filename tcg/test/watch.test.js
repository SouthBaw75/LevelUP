// AI-vs-AI watch mode: the WatchRoom drives two bots through N complete matches,
// tallies wins by faction, alternates first player, and produces a downloadable
// play log. Also covers createGame's firstPlayer option (the fair-alternation
// primitive) and the god-mode spectator view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, getSpectatorView } from '../shared/engine.js';
import { WatchRoom, isFaction } from '../server/watchroom.js';

// --- createGame firstPlayer -------------------------------------------------

test('createGame firstPlayer: seat 1 can take the opening turn', () => {
  const decks = [
    { faction: 'nexus', cards: [] },
    { faction: 'obsidian', cards: [] },
  ];
  // empty decks are fine — we only inspect the opening setup, not play
  const s0 = createGame({ decks, names: ['A', 'B'], seed: 7, firstPlayer: 0 });
  const s1 = createGame({ decks, names: ['A', 'B'], seed: 7, firstPlayer: 1 });
  assert.equal(s0.activePlayer, 0);
  assert.equal(s1.activePlayer, 1);
  // the second player (the one NOT going first) holds Government Subsidy
  assert.ok(s0.players[1].hand.includes('ntr_subsidy'), 'p1 gets subsidy when p0 first');
  assert.ok(s1.players[0].hand.includes('ntr_subsidy'), 'p0 gets subsidy when p1 first');
  assert.ok(!s0.players[0].hand.includes('ntr_subsidy'));
  assert.ok(!s1.players[1].hand.includes('ntr_subsidy'));
});

test('createGame firstPlayer defaults to 0 (unchanged behavior)', () => {
  const decks = [
    { faction: 'nexus', cards: [] },
    { faction: 'obsidian', cards: [] },
  ];
  const s = createGame({ decks, names: ['A', 'B'], seed: 3 });
  assert.equal(s.activePlayer, 0);
  assert.ok(s.players[1].hand.includes('ntr_subsidy'));
});

// --- spectator view ---------------------------------------------------------

test('getSpectatorView reveals BOTH hands (god mode)', () => {
  const decks = [
    { faction: 'nexus', cards: Array(40).fill('nx_001') },
    { faction: 'obsidian', cards: Array(40).fill('ob_001') },
  ];
  const s = createGame({ decks, names: ['A', 'B'], seed: 11 });
  const v = getSpectatorView(s);
  assert.equal(v.players.length, 2);
  assert.ok(Array.isArray(v.players[0].hand), 'seat 0 hand visible');
  assert.ok(Array.isArray(v.players[1].hand), 'seat 1 hand visible');
  assert.equal(v.players[0].handCount, undefined, 'no hidden handCount in god view');
});

test('isFaction guards the four conglomerates', () => {
  for (const f of ['nexus', 'vulcan', 'helix', 'obsidian']) assert.ok(isFaction(f));
  for (const f of ['neutral', 'x', '', null, undefined]) assert.ok(!isFaction(f));
});

// --- WatchRoom end-to-end ---------------------------------------------------

// Minimal fake lobby: captures messages sent to the spectator client.
function fakeSetup() {
  const messages = [];
  const spectator = { pid: 'spec', watchRoom: null };
  const lobby = {
    sendTo(client, msg) { if (client === spectator) messages.push(msg); },
    removeWatchRoom() {},
  };
  return { lobby, spectator, messages };
}

function runWatch(cfg) {
  const { lobby, spectator, messages } = fakeSetup();
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('watch run timed out')), 20_000);
    const room = new WatchRoom(lobby, spectator, cfg);
    // resolve once the run reports completion
    const origSend = lobby.sendTo;
    lobby.sendTo = (client, msg) => {
      origSend(client, msg);
      if (msg && msg.t === 'watchComplete') {
        clearTimeout(guard);
        resolve({ room, messages, complete: msg });
      }
    };
    room.start();
  });
}

test('WatchRoom plays a full 3-match run to completion', async () => {
  const { room, messages, complete } = await runWatch({
    factionA: 'nexus', factionB: 'obsidian', matches: 3, speed: 0.02, difficulty: 'hard',
  });

  // exactly one watchStart and one watchGameOver per match
  const starts = messages.filter((m) => m.t === 'watchStart');
  const overs = messages.filter((m) => m.t === 'watchGameOver');
  assert.equal(starts.length, 3, 'three matches started');
  assert.equal(overs.length, 3, 'three matches finished');

  // every match produced a decisive result (bots always reach lethal); wins +
  // draws across the tally must equal the number of matches played
  const t = complete.tally;
  const decided = (t.nexus || 0) + (t.obsidian || 0) + (t.draws || 0);
  assert.equal(decided, 3, 'tally accounts for all 3 matches');

  // the downloadable log carries one game record per match with a winner faction
  assert.equal(complete.log.games.length, 3);
  for (const g of complete.log.games) {
    assert.ok(g.turns > 0, 'match ran at least one turn');
    assert.ok(Array.isArray(g.actions) && g.actions.length > 0, 'match logged actions');
    assert.ok(g.reason, 'match has an end reason');
  }

  // first player alternated across matches (fair-alternation primitive)
  assert.equal(complete.log.games[0].firstFaction, 'nexus');
  assert.equal(complete.log.games[1].firstFaction, 'obsidian');
  assert.equal(complete.log.games[2].firstFaction, 'nexus');

  room.destroy();
});

test('WatchRoom supports a mirror match (same faction both sides)', async () => {
  const { room, complete } = await runWatch({
    factionA: 'helix', factionB: 'helix', matches: 2, speed: 0.02, difficulty: 'hard',
  });
  // both sides Helix: the single tally key accumulates both wins (+ any draws)
  const decided = (complete.tally.helix || 0) + (complete.tally.draws || 0);
  assert.equal(decided, 2);
  assert.equal(complete.log.games.length, 2);
  room.destroy();
});

// --- spectator disconnect / reconnect grace ---------------------------------
// A dropped WebSocket must NOT kill a running simulation outright — bots keep
// playing through the gap, and a reconnect within the grace window picks the
// client's screen back up from the live state instead of leaving it stuck.

function fakeLobbyMulti() {
  const sent = []; // { client, msg }
  const lobby = {
    sendTo(client, msg) { sent.push({ client, msg }); },
    removeWatchRoom() {},
  };
  return { lobby, sent };
}

test('disconnect: simulation is NOT destroyed immediately, keeps a grace timer', () => {
  const { lobby } = fakeLobbyMulti();
  const spectator = { pid: 'spec-1', watchRoom: null };
  const room = new WatchRoom(lobby, spectator, { factionA: 'nexus', factionB: 'vulcan', matches: 1, speed: 0.02 });
  room.start();

  room.handleSpectatorGone();
  assert.equal(room.destroyed, false, 'still running — bots keep playing');
  assert.equal(room.spectator, null, 'spectator cleared');
  assert.ok(room.graceTimer, 'a grace timer is pending');

  room.destroy(); // cleanup: don't leave a live timer/bots after the test
});

test('reconnect within the grace window resumes with the live state', () => {
  const { lobby, sent } = fakeLobbyMulti();
  const spectator = { pid: 'spec-2', watchRoom: null };
  const room = new WatchRoom(lobby, spectator, { factionA: 'nexus', factionB: 'vulcan', matches: 5, speed: 0.02 });
  room.start();
  room.handleSpectatorGone();

  const newClient = { pid: 'spec-2', watchRoom: null }; // same pid, new socket/object
  const ok = room.handleReconnect(newClient);
  assert.equal(ok, true);
  assert.equal(room.spectator, newClient, 'reattached to the new client');
  assert.equal(newClient.watchRoom, room);
  assert.equal(room.graceTimer, null, 'grace timer cleared');

  const resume = sent.find((s) => s.client === newClient && s.msg.t === 'watchResume');
  assert.ok(resume, 'a watchResume message was sent to the reconnecting client');
  assert.equal(resume.msg.matches, 5);
  assert.ok(resume.msg.view, 'carries the current live view');
  assert.ok(resume.msg.tally, 'carries the current tally');

  room.destroy();
});

test('reconnect with a mismatched pid is rejected (does not steal another spectator\'s room)', () => {
  const { lobby } = fakeLobbyMulti();
  const spectator = { pid: 'spec-3', watchRoom: null };
  const room = new WatchRoom(lobby, spectator, { factionA: 'nexus', factionB: 'vulcan', matches: 1, speed: 0.02 });
  room.start();
  room.handleSpectatorGone();

  const stranger = { pid: 'someone-else', watchRoom: null };
  const ok = room.handleReconnect(stranger);
  assert.equal(ok, false);
  assert.equal(room.spectator, null, 'room is still awaiting its real spectator');
  assert.equal(stranger.watchRoom, null);

  room.destroy();
});

test('reconnect after the whole run has already finished resends watchComplete, not watchResume', async () => {
  const { room, complete } = await runWatch({
    factionA: 'nexus', factionB: 'obsidian', matches: 1, speed: 0.02, difficulty: 'hard',
  });
  assert.ok(complete); // the run is over; room deliberately stays alive for downloads

  const { lobby, sent } = fakeLobbyMulti();
  room.lobby = lobby; // swap in a lobby we can inspect sends on
  room.handleSpectatorGone();
  assert.equal(room.destroyed, false, 'a finished room still gets a grace window');

  const newClient = { pid: room.spectatorPid, watchRoom: null };
  const ok = room.handleReconnect(newClient);
  assert.equal(ok, true);
  const msg = sent.find((s) => s.client === newClient);
  assert.equal(msg.msg.t, 'watchComplete', 'terminal state resends the completion payload, not a mid-run resume');
  assert.ok(msg.msg.log, 'download log is included again');

  room.destroy();
});
