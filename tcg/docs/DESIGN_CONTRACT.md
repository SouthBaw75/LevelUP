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
- **Healing is uncapped**: effects that restore integrity/durability (SIPHON, heal
  ops, CEO powers) always add their full amount, even past the base value — a CEO
  at 30/30 healed for 2 goes to 32; a full-health asset can be healed above its
  printed durability. `maxIntegrity`/`maxHealth` are the *base* stats used for
  display and damaged-styling, not a ceiling.
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
  - **CONTRACT** — a persistent card filed to the owner's contract zone (see §3b).
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
| `layoff`         | LAYOFF              | Once, any time on your turn: sacrifice this asset for free; your CEO gains Integrity equal to its current Durability (see §3c) |
| `severance`      | SEVERANCE           | When destroyed by an ENEMY, its owner draws a card (compensation payout; see §3d) |
| Triggered abilities (not stand-alone keywords, defined per-card in effect data):          |
| `onboarding`     | ONBOARDING          | Effect when played from hand (Battlecry)                        |
| `parachute`      | GOLDEN PARACHUTE    | Effect when destroyed (Deathrattle)                             |

## 3b. CONTRACTS (v1)

Persistent cards representing corporate agreements. Rules:

- Played from hand like any card (cost in capital), **filed** to the owner's contract
  zone. **Max 3 filed contracts** per player — a 4th is unplayable until a slot frees.
- Contracts do NOT occupy board slots, cannot attack, cannot be attacked, and cannot be
  targeted by damage/heal/buff effects. The ONLY ways a contract leaves play:
  1. **Null & void** — an effect explicitly voiding it (targeting `enemyContract`).
  2. **Expiry** — fixed-term contracts (`term: N`) expire after N of the owner's turns.
- Contract instance ids: `"c<N>"` (shared counter with nothing else; distinct from `u<N>`).
- Trigger timing: a contract's `startOfTurn` effects fire on its OWNER's turn after the
  draw step, in filing order; `endOfTurn` effects fire at the end of the owner's turn
  before the opponent's `turnStart`. **Both-parties contracts** fire on BOTH players'
  turns (the "that player" in their text refers to whoever's turn it is). Term countdown:
  decrement at the start of the owner's turn AFTER its trigger fires; at 0 → voided
  (reason `expired`).
- Static modifiers (implemented at engine chokepoints, evaluated live):
  - `opCostReduction`: reduces the owner's OPERATION costs (min 0).
  - `opDamageBonus`: owner's non-combat damage (operations + CEO power) deals +N.
  Multiple copies stack.
- New events (§5 list extended): `contractFiled {player, contract:{id, cardId, turnsLeft}}`
  and `contractVoided {contractId, cardId, reason: "nullified"|"expired"}`.
- View (§5) gains `contracts: [{id, cardId, turnsLeft}]` on BOTH `you` and `opp`
  (contracts are public). Targeting enum gains `"enemyContract"`. `playCard`'s `target`
  may be a `"c<N>"` id for null-&-void effects. Board limit 7 is unaffected.
- Deck rules unchanged: contracts are collectible, count in the 30, max 2 copies.

## 3c. LAYOFF (v1)

Active sacrifice mechanic: convert an asset's remaining Durability into CEO Integrity.

- **Action** (new, §5 list extended): `{ "type": "layoff", "unitId": "u<N>" }`.
  Legal when: game not over, it is the actor's turn, the unit is on the ACTOR's board,
  and the unit's live `keywords` include `layoff`. **No capital cost. No exhaustion
  requirement** — a just-deployed or already-attacked asset may still be laid off.
  Silence empties `unit.keywords`, so a silenced asset cannot be laid off (correct).
- **Resolution order** (fixed — client animates in this order):
  1. Emit `layoff {unitId, cardId, player}`.
  2. Heal the actor's CEO by the unit's CURRENT health (captured before removal),
     via the standard heal path → emits `heal {targetId:"hero<p>", amount}`.
     Uncapped per §1 healing rule. Amount may be reduced by damage already taken.
  3. Destroy the unit through the SAME death path as the `destroy` op (health→0 +
     standard death sweep) so GOLDEN PARACHUTE and `onFriendlyAssetDestroyed`
     contract triggers (e.g. hx_c03 Life Insurance Policy) fire normally.
- **`legalActions()`** enumerates one `layoff` action per eligible friendly unit
  (this is what teaches the bot the mechanic; `evaluate()` needs no special case).
- **Operation-card variant**: a new SPECIALS key `layoffTarget` performs steps 1-3 on a
  TARGETED friendly asset (targeting `friendlyUnit`) — used by the Layoff Notice card.
  It emits the same `layoff` event so both paths animate identically.
- **New event** (§5 list extended): `layoff {unitId, cardId, player}`.
- **v1 card changes**:
  - NEW `ntr_033` **Layoff Notice** — neutral OPERATION, cost 1, rare.
    Text: "Destroy a friendly asset. Restore Integrity to your CEO equal to its Durability."
    `effects: { targeting:'friendlyUnit', play:[{op:'special', key:'layoffTarget'}] }`.
  - Keyword `layoff` ADDED to: `ntr_001` Unpaid Intern, `ob_017` Escrow Guard,
    `hx_018` Spore Pod, `vx_t_scrapbot` Scrap Bot (token). Their face text gains "LAYOFF."
- **Client UX**: clicking a friendly LAYOFF unit on your turn (when not already in a
  targeting mode) opens a two-option chooser anchored to the unit — ATTACK (enters the
  normal attack flow; disabled with the usual toast reason if it can't attack) and
  LAYOFF (free; sends the action). Click-away/right-click cancels, same as other modes.
  Units without the keyword keep the existing click behavior exactly.

## 3d. SEVERANCE (v1)

Passive death-reaction keyword: an asset that compensates its OWNER for being destroyed
— real severance is a payout to the departed, not a suit against the company.

- **Effect**: when a unit with live keyword `severance` (not silenced) dies AND its death
  was caused by the enemy, its OWNER **draws a card**. Does NOT fire when the owner
  destroys their own unit (LAYOFF, Asset Strip, The Liquidator, own AoE, own destroy op)
  — you don't get severance for quitting.
- **Kill attribution (the core engine addition)**: units carry a `killedBy` field
  (player index | null; initialized null at creation, cloned by `cloneState`). It is set
  to the **causing player** at every point a unit is put on a path to death:
  - `dealDamage()` — whenever it reduces a unit's `health`, or sets `pendingDestroy` via
    the attacker's TOXIC: `unit.killedBy = source.player` (guard: only when
    `typeof source.player === 'number'`). In combat both directions already pass the
    opponent as `source.player`; effect damage passes the caster; so the killing blow's
    owner is always recorded, last-writer-wins.
  - Every other `pendingDestroy = true` site MUST set `killedBy` too, so a stale tag from
    an earlier non-lethal hit can never mis-fire: `destroy` op → `ctx.player`; `layoffUnit`
    → the owner (self-sacrifice, so no severance); transform/silence paths as applicable.
    The engine agent audits ALL `pendingDestroy = true` assignments.
- **Firing in `sweepDeaths`**: after the existing `onFriendlyAssetDestroyed` and
  `parachute` resolution for a death wave, iterate the same `dead` list; for each unit
  with `severance` (and `!silenced`) whose `killedBy === (1 - owner)`, emit the event then
  draw one card for `owner` via the standard draw path (fatigue-safe — an empty deck pays
  fatigue damage instead, handled by the draw helper itself). This sits INSIDE the guarded
  sweep loop, so a lethal fatigue draw is caught by the next `checkHeroes` iteration.
- **Emits**: a `severance {unitId, cardId, player}` event BEFORE its `draw` event (so the
  client can animate the payout arc), where `player` = the severance unit's owner (also
  the player who draws). (§5 event list extended.)
- **No new action or targeting**; purely reactive. `evaluate()` in the bot may optionally
  add a small value bonus for owning severance units, but is not required.
- **v1 card changes**:
  - Keyword `severance` ADDED to existing assets (face text gains "SEVERANCE."):
    `ob_007` Departing Executive, `ntr_011` Ambulance Chaser, `ntr_015` Process Server.
  - NEW `ntr_034` **Whistleblower** — neutral ASSET, cost 3, stats 2/4, rare,
    keywords `['severance']`, text "SEVERANCE.",
    flavor: a dry corporate-satire one-liner in house style (agent writes it).
- **Client**: keyword name/help/face-gloss/unit-badge added exactly as LAYOFF was; the
  `severance` animation is a small paperwork+payout motif flying from the dying unit's
  position to its OWNER's own deck (arc like the CEO power beam), landing with a gold
  "PAID" stamp that foreshadows the `draw` event immediately following (that event renders
  the actual card-to-hand flight — the severance beat renders no card of its own). How-to-play
  picks it up automatically if it derives from the keyword maps.

### v1 contract set (12 faction + 2 neutral answers)

| id | Name | Cost | Effect |
|---|---|---|---|
| `nx_c01` | Terms of Service | 3 | Your OPERATIONS cost (1) less. |
| `nx_c02` | Data Harvesting Agreement | 4 | **Term 3.** At the start of your turn, draw a card. |
| `nx_c03` | Push Notification Consent | 2 | Whenever you play an OPERATION, deal 1 damage to the enemy CEO. |
| `vx_c01` | Munitions Contract | 4 | Your operations and CEO power deal +1 damage. |
| `vx_c02` | Overtime Mandate | 3 | At the end of your turn, deal 1 damage to the enemy CEO. |
| `vx_c03` | Escalation Clause | 5 | **Both parties.** At the start of each player's turn, that player's CEO takes 1 damage. |
| `hx_c01` | Corporate Wellness Program | 3 | At the end of your turn, restore 2 integrity to your CEO. |
| `hx_c02` | Regeneration Rider | 4 | At the start of your turn, restore 1 durability to each friendly asset. |
| `hx_c03` | Life Insurance Policy | 2 | Whenever a friendly asset is destroyed, restore 2 integrity to your CEO. |
| `ob_c01` | Payday Lending Agreement | 2 | At the start of your turn, gain 1 Capital this turn only. **Fine print:** your CEO takes 1 damage each turn. |
| `ob_c02` | Bridge Loan | 4 | **Term 2.** At the start of your turn, gain +1 permanent max Capital. |
| `ob_c03` | Liquidation Rights | 3 | Whenever a friendly asset is destroyed, gain 1 Capital this turn only. |
| `ntr_c01` | Contract Attorney | 3 | ASSET 2/3. ONBOARDING: declare an enemy contract null & void. |
| `ntr_c02` | Void Clause | 1 | OPERATION. Declare an enemy contract null & void. |

Flavor bar: every contract gets dry legal-satire flavor text ("fine print" energy).
Rarity spread: commons/rares; `vx_c03` and `ob_c02` epic. Starter decks: each starter
deck swaps in 1 of its faction's contracts (2 copies → no; ONE copy, cutting one
existing card) plus each deck gains one `ntr_c02` Void Clause (cutting one card),
keeping exactly 30 and passing validateDeck.

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
{ "type": "layoff", "unitId": "u17" }   // §3c — free sacrifice, LAYOFF keyword holders only
{ "type": "concede" }
```

- Unit instance ids: `"u<N>"` unique per game. CEO target ids: `"hero0"`, `"hero1"` (by player index).
- `target` is required by cards whose effect needs a target (`targeting` field in view hand cards
  tells the client: `null | "any" | "anyUnit" | "enemyUnit" | "enemyUnitCost4" | "friendlyUnit" | "enemyHero" | "anyHero" | "enemyContract"`).
  `enemyUnitCost4` = enemy assets whose printed cost is ≤ 4 (Counter Offer's outbid-poach); both
  the engine `validTargets` and the client highlighter filter on `CARDS[cardId].cost`, which is
  never modified in-game.

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
- `contractFiled {player, contract:{id, cardId, turnsLeft}}` · `contractVoided {contractId, cardId, reason}` (§3b)
- `layoff {unitId, cardId, player}` (§3c — always followed by `heal` on the owner's hero, then `death`)
- `severance {unitId, cardId, player}` (§3d — emitted during the death sweep, immediately before its `draw` for the owner)

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
