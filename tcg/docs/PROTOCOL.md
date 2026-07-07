# HOSTILE TAKEOVER — Client ⇄ Server Protocol

Transport: single WebSocket at `ws://<host>/ws`. All messages are JSON objects with a `t` field.
HTTP: server serves `client/` statically at `/`, plus `GET /api/cards` →
`{ cards: {id: cardDef, ...}, starterDecks: {...}, factions: {...meta...} }` (card defs WITHOUT `effects`).

The server is authoritative. The client never computes game state — it renders the `view`
from the contract (DESIGN_CONTRACT.md §5) and animates `events`.

## Client → Server

| message | payload | notes |
|---|---|---|
| `{t:"hello", name}` | display name, 1–20 chars | first message; server may trim/sanitize |
| `{t:"queue", deck}` | `deck: {faction, cards:[30 ids]}` | join casual matchmaking queue |
| `{t:"cancelQueue"}` | | |
| `{t:"createPrivate", deck}` | | server replies `privateCreated` with a 4-char code |
| `{t:"joinPrivate", code, deck}` | | |
| `{t:"cancelPrivate"}` | | host cancels an open private lobby |
| `{t:"playBot", deck, difficulty}` | difficulty: `"normal"` \| `"hard"` | instant game vs AI |
| `{t:"watchBots", factionA, factionB, matches, speed}` | factions: one of the 4; `matches` 1–50; `speed` scale (1=1×…0.02=max) | AI-vs-AI spectator run (starter decks) |
| `{t:"watchSpeed", speed}` | scale as above | live-adjust the running sim's pace |
| `{t:"watchStop"}` | | end the sim, tear down the watch room |
| `{t:"action", action}` | action per contract §5 | only valid during a game |
| `{t:"concede"}` | | (equivalent to action concede) |
| `{t:"emote", id}` | id: `"greetings"|"wellplayed"|"threaten"|"oops"|"thanks"` | rate-limited by server |
| `{t:"rematch"}` | | after gameOver; starts when both sides send it |
| `{t:"leaveGame"}` | | return to lobby (post-game or desertion=concede) |
| `{t:"ping"}` | | server replies `{t:"pong"}` |

## Server → Client

| message | payload |
|---|---|
| `{t:"helloOk", playerId, online}` | assigned session id, online player count |
| `{t:"queued"}` / `{t:"queueCanceled"}` | |
| `{t:"privateCreated", code}` | |
| `{t:"gameStart", you, view, opponent:{name, faction}, turnDeadline}` | `you`: 0 or 1; `view` per contract |
| `{t:"state", view, events, turnDeadline}` | after every accepted action (both players get their own redaction) |
| `{t:"actionError", msg}` | rejected action (only to the actor) |
| `{t:"emote", from, id}` | |
| `{t:"gameOver", winner, reason, view}` | terminal; reason per contract |
| `{t:"rematchOffered"}` / new `gameStart` | opponent wants a rematch / rematch begins |
| `{t:"opponentLeft"}` | opponent socket died mid-game → server ends game (winner = remaining player, reason "desertion") after a 30s reconnect grace |
| `{t:"error", msg}` | protocol-level errors (bad deck, bad message, not in game) |
| `{t:"pong"}` | |

### AI-vs-AI watch mode (spectator only)

A watch spectator has no seat; it receives a full-information god view (`view.players[0|1]`,
both hands revealed) instead of the redacted `you`/`opp` shape.

| message | payload |
|---|---|
| `{t:"watchStart", view, match, matches, factions:[a,b], firstSeat, tally}` | a match begins; `factions` map to fixed screen slots (`players[0]`=bottom) |
| `{t:"watchState", view, events, turnDeadline}` | after every bot action |
| `{t:"watchGameOver", view, winnerSeat, winnerFaction, reason, match, matches, tally, done}` | one match ended; `done` true on the last |
| `{t:"watchComplete", tally, log}` | whole run finished; `log` is the downloadable play log (per-match action stream + summaries) |

First player alternates each match (fair-alternation via `createGame`'s `firstPlayer`), so
neither faction keeps the coin-flip edge; the win `tally` is keyed by faction (mirror-safe).

`turnDeadline`: epoch ms when the active player's turn auto-ends (90s timer). Server sends a
fresh `state` (with a `turnStart` event) when it force-ends a turn.

## Server responsibilities

- Validate every deck with `validateDeck` before queue/create/join/playBot.
- Matchmaking: FIFO queue; pair the first two queued sockets. Coin-flip who goes first.
- Private lobbies: 4-char alphanumeric code (unambiguous chars), expire after 10 min.
- Rooms: hold `state`, apply actions via `applyAction`, broadcast per-player redacted
  `{view, events}` after every accepted action. Auto-run bot turns.
- Bot: picks from `legalActions` each step using `cloneState` + greedy evaluation
  (normal = shallow/noisy, hard = deeper/greedy). Bot acts with small delays (600–1200 ms,
  scaled by watch-mode speed) so its turns are watchable.
- Watch rooms (AI-vs-AI): both seats bot-driven, no PvP grace/rematch/emote. Auto-runs N
  matches, alternating first player, tallies wins by faction, records a downloadable play
  log. Reaped when the spectator disconnects.
- Reconnect: if a socket with the same `playerId` (sent as `?pid=` query param on the WS URL)
  reconnects within 30 s, reattach it to the running game and resend `gameStart` + current state.
- Rate-limit: drop clients sending > 20 messages/second. Emotes max 1 per 3 s.
