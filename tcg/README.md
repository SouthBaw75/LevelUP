# HOSTILE TAKEOVER 🏙️

An online multiplayer trading-card game of corporate warfare. Giant tech conglomerates
battle for market dominance — deploy assets, launch operations, and reduce the enemy
CEO's integrity to zero to complete the hostile takeover.

## Play

```bash
cd tcg
npm install
npm start          # http://localhost:3000  (PORT env to override)
```

Open the URL in two browser windows (or share your host with a friend) and:

- **Ranked Queue** — casual matchmaking against anyone online
- **Private Match** — create a 4-character lobby code and share it
- **VS Bot** — practice against the AI (normal / hard)
- **Deck Builder** — build 30-card decks from your chosen conglomerate + independent contractors

## The conglomerates

| Faction | Industry | Playstyle |
|---|---|---|
| **Nexus Dynamics** | AI & software | Tempo & control — card draw, bounce, efficient operations |
| **Vulcan Heavy Industries** | Manufacturing & defense | Aggression — direct damage, FAST-TRACK units, huge late-game assets |
| **Helix Biosystems** | Biotech | Growth — healing, buffs, clone tokens, SIPHON |
| **Obsidian Capital** | Finance & private equity | Greed — capital ramp, sacrifice value, GOLDEN PARACHUTE payoffs |

## Rules in 30 seconds

Each turn you gain a **Capital** crystal (max 10, refills every turn). Spend it to deploy
**ASSETS** (units) and run **OPERATIONS** (spells). Assets fight with Output/Integrity
stats and corporate keywords — **FIREWALL** (taunt), **FAST-TRACK** (charge), **STEALTH
MODE**, **PATENT PROTECTION** (shield), **OVERTIME** (attack twice), **TOXIC ASSET**
(destroy on damage), **SIPHON** (lifesteal) — plus **ONBOARDING** (on-play) and **GOLDEN
PARACHUTE** (on-death) abilities. Your CEO has a once-per-turn power. First CEO to 0
integrity is liquidated.

## Architecture

```
tcg/
├── shared/    game engine + card database (pure logic, authoritative, seeded RNG)
├── server/    Node WebSocket server — matchmaking, private lobbies, game rooms, bot AI
├── client/    zero-build browser client (vanilla ES modules, procedural SVG card art)
├── test/      engine test suites (`npm test`)
└── docs/      DESIGN_CONTRACT.md (rules/engine/view/event contract) · PROTOCOL.md (WS protocol)
```

The server is fully authoritative: clients only send intents and render redacted views;
all game logic runs in `shared/engine.js`. One npm dependency (`ws`). Node ≥ 20.
