# HOSTILE TAKEOVER — server

Node 22 ESM game server. Single process, single port: HTTP (static client + JSON API)
and WebSocket (`/ws`) multiplexed on the same `node:http` server. Only dependency: `ws`.

## Run

```sh
npm start            # node server/index.js, listens on PORT env or 3000
```

Requires the engine (`shared/engine.js`, `shared/cards.js`) to be present — the server
is a thin, authoritative shell around the contract §5 engine API and never implements
game rules itself.

## Architecture map

| file | responsibility |
|---|---|
| `index.js` | boot: builds the cached `/api/cards` JSON (card defs with `effects` stripped + `STARTER_DECKS` + faction metadata), creates the HTTP server, upgrades `/ws` connections (parsing `?pid=` for reconnect), process-level error guards, graceful shutdown |
| `static.js` | plain-`node:http` request handler: static files from `../client/` (correct MIME types, path-traversal safe, GET/HEAD only, 404 fallback), `GET /api/cards`, `GET /api/status` → `{online, inQueue, activeGames}` |
| `lobby.js` | per-socket lifecycle: `hello` handshake + name sanitization, JSON-parse guarding, rate limiting (>20 msgs/s → close 1008), heartbeat ping/pong reaping, FIFO matchmaking queue, private lobbies (4-char unambiguous codes, 10-min expiry), `playBot`, deck validation via `validateDeck`, reconnect routing, disconnect cleanup |
| `room.js` | one game: engine `state` (created with a crypto-random seed; the lobby coin-flips who is player 0), action sanitizing + `applyAction`, per-player broadcasts (`getView` / `redactEvents`), 90 s turn timer with forced `endTurn`, 30 s disconnect grace → desertion, rematch (seats swap), emotes (1 per 3 s), teardown that always clears every timer |
| `bot.js` | in-room AI (`normal` / `hard`): scores every `legalActions` candidate by applying it to a `cloneState` and evaluating the position; acts through the room's normal action path with 600–1200 ms delays; 50-actions-per-turn loop guard |

No state is shared between rooms; a room owns its timers and clears them on destroy.
All engine calls and all message handling are wrapped so malformed/hostile input can
never crash the process or leak into another game.

## Message flow

```
client ──HTTP──> GET /            static client
                 GET /api/cards   cached JSON (cards w/o effects, starterDecks, factions)
                 GET /api/status  lobby ticker

client ──WS /ws?pid=<id>──> lobby.addSocket
  hello ────────────────> helloOk {playerId, online}; if a running game holds
                          that pid in its 30s grace window → reattach + gameStart
  queue/createPrivate/joinPrivate/playBot
        ── validateDeck ─> queued / privateCreated / error
        ── pairing ──────> Room.start(): createGame(seed) → gameStart to both
  action ───────────────> Room: sanitize → applyAction
        ok  ────────────> both get {t:"state", view, events(redacted), turnDeadline}
        err ────────────> actor only gets {t:"actionError", msg}
  (90s timer fires) ────> server applies endTurn itself, broadcasts turnStart state
  state.over ───────────> {t:"gameOver", winner, reason, view} to both
  rematch ──────────────> rematchOffered; both agree → seats swap, fresh gameStart
  leaveGame ────────────> mid-game = concede; room reaped when everyone is gone
  disconnect ───────────> opponent gets opponentLeft; 30s grace; reconnect resends
                          gameStart, else remaining player wins ("desertion");
                          both gone → room destroyed
```

## Bot design

Each bot step: `legalActions(state, bot)` → for every candidate, `cloneState` +
`applyAction` + static evaluation of the result. Evaluation terms: terminal states
dominate (always takes lethal, never walks into a known loss), CEO integrity
differential, board material (attack/health plus keyword bonuses, enemy board
weighted slightly higher to encourage trades), hand-size advantage, and pressure
bonuses when either CEO is low. `hard` plays the argmax; `normal` makes a weighted
pick among the top three non-suicidal candidates. It funnels actions through the
room's normal broadcast path with 600–1200 ms delays so its turn is watchable, and
a 50-action cap per turn guards against loops. Bot decks are a random starter deck.
