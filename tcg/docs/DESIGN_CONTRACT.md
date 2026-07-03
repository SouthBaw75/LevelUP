# HOSTILE TAKEOVER — Design & Engine Contract

**This document is the binding contract between all modules (engine, server, client, data).
Do not deviate from the interfaces defined here. If something is unspecified, choose sensibly
and document it in your module, but never change a name/shape defined here.**

Game: an online multiplayer TCG themed around corporate warfare. Giant tech conglomerates
battle for industry dominance. Tone: sleek corporate cyberpunk, dry satirical flavor text
(think Bloomberg terminal meets Blade Runner boardroom).

---

## 1. Core rules (Hearthstone-style turn structure — no priority stack)

- 2 players. Each player is a **CEO** of a conglomerate with **30 INTEGRITY** (health).
  Reduce the enemy CEO to 0 integrity → you win (a "hostile takeover").
- Resource: **CAPITAL**. Player's max capital starts at 1 on their first turn, grows +1 each
  of their turns (cap **10**), and refills to max at the start of their turn.
- Deck: exactly **30 cards**, max **2 copies** of any card, from **one faction + NEUTRAL** cards.
- Going first: 3 opening cards. Going second: 4 opening cards **plus** the bonus card
  `ntr_subsidy` ("Government Subsidy": Operation, cost 0, "Gain 1 Capital this turn only").
- No mulligan in v1.
- Hand limit **10** (a drawn card beyond 10 is destroyed — "shredded" — with a `mill` event).
- Empty-deck draws cause **fatigue**: 1, 2, 3, … escalating damage to the CEO per empty draw.
- Board limit: **7 ASSETS** per player.
- Turn timer: **90 seconds** (enforced by server, not engine). Auto end-turn on expiry.
- Cards in play are called by their card `type`:
  - **ASSET** — a unit (minion). Has cost, ATTACK (aka *Output*), HEALTH (aka *Durability*).
    Summoning sickness: cannot attack the turn it's deployed unless it has FAST-TRACK.
    Assets attack once per turn (twice with OVERTIME). Attackers can target enemy assets
    or the enemy CEO — but must attack a FIREWALL asset if any exists (STEALTH ignores nothing;
    firewall rule applies to attackers regardless).
  - **OPERATION** — a spell. One-time effect, then discarded.
- Each faction's CEO has a **CEO POWER**: cost 2, usable once per turn (defined in card data).
- Combat: attacker and defender deal damage to each other simultaneously (asset vs asset).
  Attacking the enemy CEO: only the attacker deals damage.

## 2. Factions

| id        | Name                     | Industry              | Identity / mechanics                                  | Accent color |
|-----------|--------------------------|-----------------------|-------------------------------------------------------|--------------|
| `nexus`   | Nexus Dynamics           | AI & software         | Tempo/control: card draw, bounce, cheap efficient ops  | cyan `#22d3ee` |
| `vulcan`  | Vulcan Heavy Industries  | Manufacturing/defense | Aggro: direct damage, FAST-TRACK, big late-game assets | orange `#f97316` |
| `helix`   | Helix Biosystems         | Biotech               | Growth: healing, buffs, clone tokens, SIPHON           | green `#4ade80` |
| `obsidian`| Obsidian Capital         | Finance/private equity| Greed: capital ramp, sacrifice, GOLDEN PARACHUTE value | violet-gold `#c084fc` |
| `neutral` | Independent Contractors  | —                     | Usable in any deck                                     | gray `#94a3b8` |

## 3. Keywords (fixed list — engine implements exactly these)

| Keyword id       | Display name        | Meaning (classic analog)                                        |
|------------------|---------------------|-----------------------------------------------------------------|
| `firewall`       | FIREWALL            | Enemies must attack this asset first (Taunt)                    |
| `fasttrack`      | FAST-TRACK          | Can attack the turn it's deployed (Charge)                      |
| `stealth`        | STEALTH MODE        | Can't be targeted/attacked until it deals damage (Stealth)      |
| `shielded`       | PATENT PROTECTION   | Ignores the first damage it would take (Divine Shield)          |
| `overtime`       | OVERTIME            | Can attack twice per turn (Windfury)                            |
| `toxic`          | TOXIC ASSET         | Destroys any asset it damages (Poisonous)                       |
| `siphon`         | SIPHON              | Damage dealt by this also restores your CEO's integrity (Lifesteal) |
| Triggered abilities (not stand-alone keywords, defined per-card in effect data):          |
| `onboarding`     | ONBOARDING          | Effect when played from hand (Battlecry)                        |
| `parachute`      | GOLDEN PARACHUTE    | Effect when destroyed (Deathrattle)                             |

## 4. Card data schema (what client & server see)

Card definitions live in `shared/cards.js` (ESM, exports `CARDS` map id→def and `STARTER_DECKS`).
The server exposes them to the client as JSON via `GET /api/cards`.

```jsonc
{
  "id": "vx_004",             // <factionprefix>_<number>; prefixes: nx, vx, hx, ob, ntr
  "name": "Strike Battalion",
  "faction": "vulcan",         // nexus|vulcan|helix|obsidian|neutral
  "type": "ASSET",             // ASSET | OPERATION | CEO | POWER
  "cost": 4,
  "attack": 4,                 // ASSET only
  "health": 3,                 // ASSET only (CEO uses health: 30)
  "keywords": ["fasttrack"],  // stand-alone keywords only (section 3)
  "text": "FAST-TRACK. Onboarding: deal 1 damage to the enemy CEO.",
  "flavor": "Quarterly targets are not a suggestion.",
  "rarity": "common",          // common | rare | epic | legendary
  "collectible": true,          // false for tokens / CEO / POWER cards
  "effects": { }               // engine-internal effect DSL — opaque to client/server
}
```

### Card artwork placeholders

Card art is convention-based so real artwork can be dropped in later without code changes:
the client looks for `client/assets/card-art/<cardId>.png` (also try `.jpg`/`.webp`) for every
card. If present, it fills the card's art frame (recommended source ratio ~4:3 landscape,
≥ 512×384). If absent, the client renders a **procedural placeholder** in the art frame
(faction-colored, deterministic per card id, visibly a placeholder — e.g. subtle
"ART PENDING" watermark treatment). `client/assets/card-art/README.md` documents the
convention. The card data schema needs no art field.

- `type: "CEO"` cards (one per faction, e.g. `nx_ceo`) define the hero: name, 30 health, `powerId`.
- `type: "POWER"` cards define the CEO power: cost 2, `text`, effects.
- Tokens (summoned units) are non-collectible ASSET cards in the same map.
- **~120 collectible cards total**: ~22 per faction + ~30 neutral. Costs 0–10, all rarities.

`STARTER_DECKS`: `{ nexus: {name, faction, cards:[30 ids]}, vulcan: {...}, helix: {...}, obsidian: {...} }`
— four tuned, playable prebuilt decks.

## 5. Engine API (`shared/engine.js`, ESM)

The engine is **pure game logic**: no I/O, no timers, no randomness outside its own seeded RNG.
The server holds one `state` per game room and is the only writer.

```js
import { createGame, applyAction, legalActions, getView, redactEvents, cloneState, validateDeck, CARDS } from './engine.js'

// createGame({ decks: [deck0, deck1], names: ["Alice","Bob"], seed: 12345 }) -> state
//   deck: { faction: "nexus", cards: [30 card ids] }   (player 0 goes first)
// validateDeck(deck) -> { ok: true } | { ok: false, error: "reason" }
// applyAction(state, playerIndex, action) -> { ok: true, events: [...] } | { ok: false, error: "msg" }
//   MUTATES state. Rejects out-of-turn / illegal actions with ok:false (never throws on bad input).
// legalActions(state, playerIndex) -> [action, ...]  (empty if not your turn; always includes endTurn on your turn)
// getView(state, playerIndex) -> redacted view (below)
// redactEvents(events, playerIndex) -> events safe to send to that player (hides opponent draws etc.)
// cloneState(state) -> deep copy (for bot simulation)
// state.over: boolean, state.winner: null | 0 | 1
```

### Actions (exact shapes)

```jsonc
{ "type": "endTurn" }
{ "type": "playCard", "handIndex": 2, "target": "u17" | "hero0" | "hero1" | null, "position": 0-6 | null }
{ "type": "attack", "attackerId": "u17", "targetId": "u4" | "hero1" }
{ "type": "heroPower", "target": "u17" | "hero0" | "hero1" | null }
{ "type": "concede" }
```

- Unit instance ids: `"u<N>"` unique per game. CEO target ids: `"hero0"`, `"hero1"` (by player index).
- `target` is required by cards whose effect needs a target (`targeting` field in view hand cards
  tells the client: `null | "any" | "anyUnit" | "enemyUnit" | "friendlyUnit" | "enemyHero" | "anyHero"`).

### View shape (getView result — this exact shape goes over the wire)

```jsonc
{
  "turn": 3,                    // total turn counter (1-based)
  "activePlayer": 0,
  "you": {
    "index": 0, "name": "Alice", "faction": "nexus",
    "integrity": 27, "maxIntegrity": 30,
    "capital": 4, "maxCapital": 4,
    "ceo": { "cardId": "nx_ceo", "name": "..." },
    "power": { "cardId": "nx_power", "cost": 2, "used": false, "targeting": null },
    "hand": [ { "cardId": "nx_003", "cost": 2, "playable": true, "targeting": "enemyUnit", "validPositions": true } ],
    "board": [ { "id": "u4", "cardId": "nx_007", "attack": 3, "health": 2, "maxHealth": 4,
                  "keywords": ["firewall"], "canAttack": true, "exhausted": false, "damaged": true } ],
    "deckCount": 21, "fatigue": 0
  },
  "opp": { /* same minus hand → "handCount": 5; playable/canAttack always false */ },
  "over": false, "winner": null
}
```

### Events (emitted by applyAction, consumed by client for animation)

Every event: `{ "e": "<type>", ...fields }`. Types (fixed list):

- `turnStart {player, turn}` · `capital {player, capital, maxCapital}`
- `draw {player, cardId|null}` (cardId null after redaction for opponent) · `mill {player, cardId}` · `fatigue {player, amount}`
- `cardPlayed {player, cardId, handIndex}` · `summon {player, unit:{id,cardId,attack,health,keywords}, position}`
- `attack {attackerId, targetId}` · `damage {targetId, amount, source?}` · `heal {targetId, amount}`
- `shieldBreak {targetId}` · `death {unitId, cardId}` · `buff {unitId, attack, health}` · `keyword {unitId, keyword}`
- `heroPower {player}` · `returnToHand {unitId}` · `silence {unitId}` *(if used)* · `transform {unitId, cardId}`
- `gameOver {winner, reason}`  // reason: "takeover" | "concede" | "timeout" | "desertion"

After applying redacted events, the client re-renders from the authoritative `view` that
accompanies every state broadcast — events are for animation only, never for state derivation.

## 6. Module ownership (do not write outside your module)

| Path            | Owner agent | Contents |
|-----------------|-------------|----------|
| `shared/`       | ENGINE      | `engine.js`, `cards.js`, plus any internal helpers |
| `test/`         | ENGINE      | `node --test` suites for engine + cards |
| `server/`       | SERVER      | `index.js` + helpers: HTTP static + `/api/cards`, WS protocol, lobby, matchmaking, rooms, bot |
| `client/`       | CLIENT      | static site: `index.html`, `css/`, `js/` — no build step, no external CDNs/fonts/assets |
| `docs/`, `package.json` | ORCHESTRATOR | contracts (this file, PROTOCOL.md), README |

Node 22, ESM everywhere (`"type": "module"`). Only npm dependency allowed: `ws`.
Client is plain browser ES modules + CSS — **zero external network fetches** (all art is
procedural CSS/inline-SVG; use system font stacks).
