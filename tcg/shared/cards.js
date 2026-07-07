// HOSTILE TAKEOVER — card database (ENGINE module)
// Exports: CARDS (id -> card def), STARTER_DECKS.
//
// Effect DSL (engine-internal, opaque to server/client):
//   effects: {
//     targeting: null | "any" | "anyUnit" | "enemyUnit" | "friendlyUnit" | "enemyHero" | "anyHero"
//                | "enemyContract",
//     onboarding: [ops],   // ASSET: battlecry, runs when played from hand
//     play:       [ops],   // OPERATION / POWER: the card's effect
//     parachute:  [ops],   // ASSET: golden parachute (deathrattle)
//     endOfTurn:  [ops],   // ASSET/CONTRACT: end of its controller's turn
//     // CONTRACT-only (§3b):
//     startOfTurn: [ops],  // owner's turn, after the draw step, filing order
//     bothParties: true,   // startOfTurn fires on BOTH players' turns; ctx.player
//                          //   is the ACTIVE player ("that player" in card text)
//     onOperationPlayed: [ops],        // after the owner plays an OPERATION
//     onFriendlyAssetDestroyed: [ops], // when a friendly asset dies (any cause)
//     static: { opCostReduction?: N, opDamageBonus?: N },  // CONTRACT-only, live, stack
//     static: { contractCostReduction?: N },  // ASSET-only, live, stack (Corporate Lobbyist)
//     static: { enemyCostIncrease?: N },  // CONTRACT-only, live, stack (Regulatory Capture);
//                                         // raises the FILER's OPPONENT's costs, all types
//     reserve: { assetOnly: true },  // CONTRACT-only marker (War Chest): the filed instance
//                                    // banks Capital privately; Activate to spend it on ASSETS
//     combatBonus: { vsTag, damage },  // ASSET-only (Affiliate Influencer): +damage when this
//                                      // attacks a DEFENDER asset whose class includes vsTag
//   }
//   CONTRACT cards may also carry a top-level `term: N` (expires after N of the
//   owner's turns); no attack/health.
// Ops (see engine.js OPS/SPECIALS for implementations):
//   {op:"damage", amount, to}                    to: "target"|"self"|"friendlyHero"|"enemyHero"
//   {op:"aoeDamage", amount, side, includeHeroes} side: "enemy"|"friendly"|"all"
//   {op:"heal", amount, to}
//   {op:"draw", count, player?}                  player: "self"(default)|"opponent"
//   {op:"summon", cardId, count?, forOpponent?}
//   {op:"buff", attack?, health?, to}            to: "target"|"self"|"allFriendlyUnits"
//   {op:"grantKeyword", keyword, to}
//   {op:"destroy", to}                           to: "target"|"allUnits"|"allEnemyUnits"
//   {op:"returnToHand", to}                      to: "target"|"allEnemyUnits"
//   {op:"addCapital", amount, permanent?}        temp capital this turn, or +max capital
//   {op:"addCapital", perEnemyAsset:true}        temp capital = ASSETS the enemy played last turn (MLM)
//   {op:"discardRandom", count, player?}         player: "opponent"(default)|"self"
//   {op:"transform", cardId, to:"target"}
//   {op:"silence", to:"target"}
//   {op:"nullify", to:"target"}                  null & void a contract (targeting "enemyContract")
//   {op:"bankCapital", cap?}                     CONTRACT endOfTurn: bank unspent Capital on the instance (total ≤ cap, default 8)
//   {op:"special", key, ...}                     keyed handler: "stealUnit"|"summonCopy"|"liquidate"|"layoffTarget"

export const CARDS = {};

// Tribal tags (counter auras / future tribal cards match on these). Every ASSET
// carries one or more; the taxonomy is one signature tribe per faction plus two
// cross-faction connectors:
//   robotic   — machines, mechs, drones, golems, weapon platforms, appliances
//   software  — Nexus digital agents / AI / code / network constructs
//   facility  — fixed structures / installations / hardware clusters / barricades
//   organism  — Helix engineered bio-creatures (non-human)
//   financial — abstract money / corporate constructs (shells, funds, holdings)
//   personnel — human staff, execs, lawyers, guards, soldiers, reps (the DEFAULT)
// Only the five non-personnel tribes are listed here; any ASSET not present
// defaults to ['personnel'] in C(). Non-asset cards (CEO/POWER/OPERATION/
// CONTRACT) are untagged. When adding a new machine/creature/etc., add it here.
export const TAGS = ['robotic', 'software', 'facility', 'organism', 'financial', 'personnel'];
const ASSET_TAGS = {
  // robotic
  vx_t_scrapbot: ['robotic'], vx_002: ['robotic'], vx_011: ['robotic'],
  vx_016: ['robotic'], vx_017: ['robotic'], vx_022: ['robotic'],
  nx_001: ['robotic'], ntr_019: ['robotic'], ntr_031: ['robotic'],
  ob_021: ['robotic', 'financial'], // bullion golem: a machine AND a money-construct
  // software
  nx_t_legacy: ['software'], nx_002: ['software'], nx_003: ['software'],
  nx_006: ['software'], nx_007: ['software'], nx_012: ['software'], nx_021: ['software'],
  // facility
  nx_010: ['facility'], nx_011: ['facility'], nx_020: ['facility'],
  vx_009: ['facility'], vx_013: ['facility'], vx_015: ['facility'],
  hx_007: ['facility'], hx_009: ['facility'], ntr_012: ['facility'],
  ob_026: ['facility'], ob_027: ['facility'], ob_028: ['facility'],
  ob_029: ['facility'], ob_030: ['facility'], ob_031: ['facility'],
  // organism
  hx_t_hydra: ['organism'], hx_t_spore: ['organism'], hx_t_labrat: ['organism'],
  hx_001: ['organism'], hx_004: ['organism'], hx_008: ['organism'], hx_012: ['organism'],
  hx_014: ['organism'], hx_016: ['organism'], hx_017: ['organism'], hx_018: ['organism'],
  hx_020: ['organism'], hx_022: ['organism'],
  // financial (ob_021 dual-listed above under robotic)
  ob_t_shell: ['financial'], ob_004: ['financial'], ob_011: ['financial'],
  ob_013: ['financial'], ob_t_subsidiary: ['financial'], ob_024: ['financial'],
  ntr_025: ['financial'],
};

function C(card) {
  card.keywords = card.keywords || [];
  card.effects = card.effects || {};
  card.rarity = card.rarity || 'common';
  card.collectible = card.collectible !== undefined ? card.collectible : true;
  card.text = card.text || '';
  card.flavor = card.flavor || '';
  // Assets get their tribe(s) from ASSET_TAGS, defaulting to personnel; other
  // card types stay untagged. An explicit `tags` on the card def wins.
  card.tags = card.tags || ASSET_TAGS[card.id] || (card.type === 'ASSET' ? ['personnel'] : []);
  if (CARDS[card.id]) throw new Error('duplicate card id ' + card.id);
  CARDS[card.id] = card;
  return card;
}
// asset / operation shorthands
const A = (id, name, faction, cost, attack, health, extra = {}) =>
  C({ id, name, faction, type: 'ASSET', cost, attack, health, ...extra });
const O = (id, name, faction, cost, extra = {}) =>
  C({ id, name, faction, type: 'OPERATION', cost, ...extra });

// ---------------------------------------------------------------------------
// CEOs & CEO POWERS (non-collectible)
// ---------------------------------------------------------------------------
C({ id: 'nx_ceo', name: 'Vera Lang', faction: 'nexus', type: 'CEO', cost: 0, health: 40,
  powerId: 'nx_power', collectible: false, rarity: 'legendary',
  text: 'CEO of Nexus Dynamics.', flavor: 'She A/B tested her own personality. Variant B won.' });
C({ id: 'nx_power', name: 'Crunch Time', faction: 'nexus', type: 'POWER', cost: 2,
  collectible: false, text: 'Draw a card. Deal 1 damage to your CEO.',
  flavor: 'Sleep is technical debt.',
  effects: { targeting: null, play: [{ op: 'draw', count: 1 }, { op: 'damage', amount: 1, to: 'friendlyHero' }] } });

C({ id: 'vx_ceo', name: 'Brock Hammond', faction: 'vulcan', type: 'CEO', cost: 0, health: 40,
  powerId: 'vx_power', collectible: false, rarity: 'legendary',
  text: 'CEO of Vulcan Heavy Industries.', flavor: 'His handshake has a recoil warning.' });
C({ id: 'vx_power', name: 'Precision Strike', faction: 'vulcan', type: 'POWER', cost: 2,
  collectible: false, text: 'Deal 1 damage to any target. Must target a FIREWALL asset first if the enemy has one.',
  flavor: 'Collateral is a line item.',
  effects: { targeting: 'anyRespectFirewall', play: [{ op: 'damage', amount: 1, to: 'target' }] } });

C({ id: 'hx_ceo', name: 'Dr. Jin-Ho Park', faction: 'helix', type: 'CEO', cost: 0, health: 40,
  powerId: 'hx_power', collectible: false, rarity: 'legendary',
  text: 'CEO of Helix Biosystems.', flavor: 'Technically he is his own emergency contact. Four times over.' });
C({ id: 'hx_power', name: 'Gene Therapy', faction: 'helix', type: 'POWER', cost: 2,
  collectible: false, text: 'Restore 2 Integrity to any character.',
  flavor: 'Side effects include quarterly growth.',
  effects: { targeting: 'any', play: [{ op: 'heal', amount: 2, to: 'target' }] } });

C({ id: 'ob_ceo', name: 'Sterling Voss', faction: 'obsidian', type: 'CEO', cost: 0, health: 40,
  powerId: 'ob_power', collectible: false, rarity: 'legendary',
  text: 'CEO of Obsidian Capital.', flavor: 'He shorted his own retirement party.' });
C({ id: 'ob_power', name: 'Shell Company', faction: 'obsidian', type: 'POWER', cost: 2,
  collectible: false, text: 'Summon a 1/2 Shell Corp.',
  flavor: 'Registered in a jurisdiction that is technically a boat.',
  effects: { targeting: null, play: [{ op: 'summon', cardId: 'ob_t_shell' }] } });

// ---------------------------------------------------------------------------
// Tokens (non-collectible)
// ---------------------------------------------------------------------------
A('ob_t_shell', 'Shell Corp', 'obsidian', 1, 1, 2, { collectible: false, keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'One employee, zero products, immaculate paperwork, and a wall of liability nobody wants to touch first.' });
A('vx_t_scrapbot', 'Scrap Bot', 'vulcan', 1, 2, 1, { collectible: false,
  keywords: ['layoff'], text: 'LAYOFF.',
  flavor: 'Assembled from recalls.' });
A('hx_t_hydra', 'Hydra Clone', 'helix', 3, 3, 3, { collectible: false,
  flavor: 'Cut costs, get two departments.' });
A('hx_t_spore', 'Spore', 'helix', 1, 1, 1, { collectible: false,
  flavor: 'It grows on you. Clinically.' });
A('hx_t_labrat', 'Lab Rat', 'helix', 1, 1, 1, { collectible: false,
  flavor: 'Reassigned pending further study.' });
A('nx_t_legacy', 'Legacy Code', 'nexus', 1, 1, 1, { collectible: false,
  flavor: 'Nobody knows what it does. Nobody dares turn it off.' });
O('ntr_subsidy', 'Government Subsidy', 'neutral', 0, { collectible: false,
  text: 'Gain 1 Capital this turn only.',
  flavor: 'Too big to fail, small enough to pocket.',
  effects: { targeting: null, play: [{ op: 'addCapital', amount: 1 }] } });

// ---------------------------------------------------------------------------
// NEXUS DYNAMICS (nx) — AI & software. Tempo/control: draw, bounce, cheap ops.
// ---------------------------------------------------------------------------
A('nx_001', 'Intern Bot', 'nexus', 1, 1, 2, {
  flavor: 'Paid in exposure and firmware updates.' });
A('nx_002', 'Web Crawler', 'nexus', 2, 1, 1, {
  text: 'ONBOARDING: Draw a card.',
  flavor: 'It respects robots.txt the way lawyers respect loopholes.',
  effects: { onboarding: [{ op: 'draw', count: 1 }] } });
A('nx_003', 'Spyware Agent', 'nexus', 2, 2, 1, { keywords: ['stealth'],
  text: 'STEALTH MODE.',
  flavor: 'You agreed to this in section 47(b) of the EULA.' });
A('nx_004', 'QA Analyst', 'nexus', 2, 2, 3, {
  flavor: 'Finds every bug except the one in production.' });
A('nx_005', 'Scrum Master', 'nexus', 3, 2, 3, { rarity: 'rare',
  text: 'ONBOARDING: Draw a card.',
  flavor: 'Turns one meeting into three, and three cards into four.',
  effects: { onboarding: [{ op: 'draw', count: 1 }] } });
A('nx_006', 'Silent Daemon', 'nexus', 3, 4, 2, { keywords: ['stealth'], rarity: 'rare',
  text: 'STEALTH MODE.',
  flavor: 'Runs in the background. Bills in the foreground.' });
A('nx_007', 'Firewall Node', 'nexus', 3, 1, 6, { keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'DENY ALL, including performance reviews.' });
A('nx_008', 'Cease & Desist Squad', 'nexus', 4, 3, 3, { rarity: 'rare',
  text: 'ONBOARDING: Return an enemy asset to its owner’s hand.',
  flavor: 'The letterhead alone does most of the damage.',
  effects: { targeting: 'enemyUnit', onboarding: [{ op: 'returnToHand', to: 'target' }] } });
A('nx_009', 'Chief Architect', 'nexus', 5, 4, 4, { rarity: 'rare',
  text: 'ONBOARDING: Draw a card.',
  flavor: 'The whiteboard diagram has achieved sentience.',
  effects: { onboarding: [{ op: 'draw', count: 1 }] } });
A('nx_010', 'Data Center', 'nexus', 6, 4, 7, { keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'Cooled by the tears of on-call engineers.' });
A('nx_011', 'Quantum Cluster', 'nexus', 7, 6, 6, { rarity: 'epic',
  text: 'ONBOARDING: Draw 2 cards.',
  flavor: 'Simultaneously over and under budget until observed.',
  effects: { onboarding: [{ op: 'draw', count: 2 }] } });
A('nx_012', 'The Algorithm', 'nexus', 8, 6, 6, { keywords: ['bullish'], rarity: 'legendary',
  text: 'BULLISH. At the end of your turn, draw a card.',
  flavor: 'It optimized for engagement. Now it engages in hostile takeovers.',
  effects: { endOfTurn: [{ op: 'draw', count: 1 }] } });
O('nx_013', 'Ping', 'nexus', 0, {
  text: 'Deal 1 damage to any target.',
  flavor: '64 bytes of pure passive aggression.',
  effects: { targeting: 'any', play: [{ op: 'damage', amount: 1, to: 'target' }] } });
O('nx_014', 'Rollback', 'nexus', 1, {
  text: 'Return an asset to its owner’s hand.',
  flavor: 'Works on deployments, mergers, and apologies.',
  effects: { targeting: 'anyUnit', play: [{ op: 'returnToHand', to: 'target' }] } });
O('nx_015', 'Sprint Planning', 'nexus', 3, {
  text: 'Draw 2 cards.',
  flavor: 'Two-week sprint, six-week deliverable, one-page retro.',
  effects: { targeting: null, play: [{ op: 'draw', count: 2 }] } });
O('nx_016', 'Short Circuit', 'nexus', 2, {
  text: 'Deal 3 damage to an asset.',
  flavor: 'Root cause: someone. Resolution: won’t fix.',
  effects: { targeting: 'anyUnit', play: [{ op: 'damage', amount: 3, to: 'target' }] } });
O('nx_017', 'System Purge', 'nexus', 4, { rarity: 'rare',
  text: 'Deal 2 damage to all enemy assets.',
  flavor: 'Have you tried turning their org chart off and on again?',
  effects: { targeting: null, play: [{ op: 'aoeDamage', amount: 2, side: 'enemy' }] } });
O('nx_018', 'Deprecate', 'nexus', 4, { rarity: 'epic',
  text: 'Transform an enemy asset into 1/1 Legacy Code.',
  flavor: 'Support ends Tuesday. Dignity ended earlier.',
  effects: { targeting: 'enemyUnit', play: [{ op: 'transform', cardId: 'nx_t_legacy', to: 'target' }] } });
O('nx_019', 'Telemetry', 'nexus', 1, {
  text: 'Draw a card.',
  flavor: 'Anonymized, aggregated, and absolutely about you.',
  effects: { targeting: null, play: [{ op: 'draw', count: 1 }] } });
A('nx_020', 'Compute Cluster', 'nexus', 5, 5, 6, {
  text: 'Adjacent SOFTWARE assets gain +1/+1.',
  flavor: 'Mines synergy at 4.2 exaflops.',
  effects: { adjacencyBuff: { attack: 1, health: 1, match: { tag: 'software' } } } });
A('nx_021', 'Zero-Day Agent', 'nexus', 6, 5, 5, { keywords: ['stealth'], rarity: 'epic',
  text: 'STEALTH MODE.',
  flavor: 'Disclosed responsibly, deployed irresponsibly.' });
O('nx_022', 'Mass Recall', 'nexus', 7, { rarity: 'epic',
  text: 'Return all enemy assets to their owner’s hand.',
  flavor: 'RE: RE: RE: URGENT: please disregard previous org chart.',
  effects: { targeting: null, play: [{ op: 'returnToHand', to: 'allEnemyUnits' }] } });

// ---------------------------------------------------------------------------
// VULCAN HEAVY INDUSTRIES (vx) — manufacturing/defense. Aggro: damage, FAST-TRACK.
// ---------------------------------------------------------------------------
A('vx_001', 'Line Welder', 'vulcan', 1, 2, 1, {
  flavor: 'Sparks joy. Also just sparks.' });
A('vx_002', 'Rapid Response Drone', 'vulcan', 2, 2, 1, { keywords: ['fasttrack'],
  text: 'FAST-TRACK.',
  flavor: 'Ships same-day. Explodes same-day.' });
O('vx_003', 'Shrapnel Burst', 'vulcan', 1, {
  text: 'Deal 2 damage to an asset.',
  flavor: 'Now with 30% more plausible deniability.',
  effects: { targeting: 'anyUnit', play: [{ op: 'damage', amount: 2, to: 'target' }] } });
A('vx_004', 'Strike Battalion', 'vulcan', 4, 4, 3, { keywords: ['fasttrack'], rarity: 'rare',
  text: 'FAST-TRACK. Onboarding: deal 1 damage to the enemy CEO.',
  flavor: 'Quarterly targets are not a suggestion.',
  effects: { onboarding: [{ op: 'damage', amount: 1, to: 'enemyHero' }] } });
A('vx_005', 'Foundry Worker', 'vulcan', 2, 3, 2, {
  flavor: 'Forged in fire, unionized in writing.' });
O('vx_006', 'Artillery Barrage', 'vulcan', 2, {
  text: 'Deal 2 damage to any target.',
  flavor: 'Our earnings call features live ordnance.',
  effects: { targeting: 'any', play: [{ op: 'damage', amount: 2, to: 'target' }] } });
A('vx_007', 'Double-Shift Foreman', 'vulcan', 3, 2, 3, { keywords: ['overtime'],
  text: 'OVERTIME.',
  flavor: 'Clocks out only to clock back in.' });
A('vx_008', 'Repo Squad', 'vulcan', 3, 3, 1, { keywords: ['fasttrack'],
  text: 'FAST-TRACK.',
  flavor: 'They repossess first and read the paperwork in the truck.' });
A('vx_009', 'Armor Plant', 'vulcan', 4, 4, 5, {
  text: 'When an asset is placed to the immediate left or right of this, it gains +1 Integrity.',
  flavor: 'OSHA-compliant, Geneva-adjacent.',
  effects: { adjacencyBuff: { health: 1 } } });
O('vx_010', 'Carpet Bombing', 'vulcan', 4, { rarity: 'rare',
  text: 'Deal 2 damage to all enemy assets.',
  flavor: 'Restructuring, delivered by air.',
  effects: { targeting: null, play: [{ op: 'aoeDamage', amount: 2, side: 'enemy' }] } });
A('vx_011', 'Blitz Mech', 'vulcan', 5, 5, 3, { keywords: ['fasttrack'], rarity: 'rare',
  text: 'FAST-TRACK.',
  flavor: 'Zero to liability in 1.8 seconds.' });
O('vx_012', 'Railgun Prototype', 'vulcan', 4, { rarity: 'rare',
  text: 'Deal 5 damage to an asset.',
  flavor: 'The demo unit only works during demos to competitors.',
  effects: { targeting: 'anyUnit', play: [{ op: 'damage', amount: 5, to: 'target' }] } });
A('vx_013', 'War Factory', 'vulcan', 6, 6, 7, {
  flavor: 'Produces tanks, noise complaints, and shareholder value.' });
A('vx_014', 'Plasma Trooper', 'vulcan', 6, 6, 5, { rarity: 'rare',
  text: 'ONBOARDING: Deal 3 damage to any target.',
  flavor: 'His onboarding packet was a target list.',
  effects: { targeting: 'any', onboarding: [{ op: 'damage', amount: 3, to: 'target' }] } });
A('vx_015', 'Bunker Complex', 'vulcan', 7, 7, 7, { keywords: ['firewall'], rarity: 'rare',
  text: 'FIREWALL.',
  flavor: 'The break room is rated for direct hits.' });
A('vx_016', 'Twin-Barrel Colossus', 'vulcan', 8, 8, 8, { keywords: ['overtime', 'bullish'], rarity: 'epic',
  text: 'OVERTIME. BULLISH.',
  flavor: 'Why fire once when the invoice covers twice?' });
A('vx_017', 'The Juggernaut', 'vulcan', 9, 8, 8, { keywords: ['fasttrack', 'bullish'], rarity: 'legendary',
  text: 'FAST-TRACK. BULLISH.',
  flavor: 'Line item: one (1) unstoppable object. Warranty void.' });
O('vx_018', 'Overclock', 'vulcan', 1, {
  text: 'Give a friendly asset +2 Attack.',
  flavor: 'The red line on the gauge is a KPI now.',
  effects: { targeting: 'friendlyUnit', play: [{ op: 'buff', attack: 2, health: 0, to: 'target' }] } });
O('vx_019', 'Reinforcements', 'vulcan', 3, {
  text: 'Summon two 2/1 Scrap Bots.',
  flavor: 'Some assembly required. Assembly sold separately.',
  effects: { targeting: null, play: [{ op: 'summon', cardId: 'vx_t_scrapbot', count: 2 }] } });
A('vx_020', 'Riot Trooper', 'vulcan', 1, 1, 1, { keywords: ['shielded'],
  text: 'PATENT PROTECTION.',
  flavor: 'The shield is patented. The riot is open source.' });
A('vx_021', 'Gun Runner', 'vulcan', 3, 3, 2, {
  text: 'ONBOARDING: Deal 1 damage to any target.',
  flavor: 'Free shipping on orders over one warlord.',
  effects: { targeting: 'any', onboarding: [{ op: 'damage', amount: 1, to: 'target' }] } });
A('vx_022', 'Orbital Superweapon', 'vulcan', 10, 8, 8, { rarity: 'epic',
  text: 'ONBOARDING: Deal 3 damage to all enemies.',
  flavor: 'Technically a satellite. Technically.',
  effects: { onboarding: [{ op: 'aoeDamage', amount: 3, side: 'enemy', includeHeroes: true }] } });

// ---------------------------------------------------------------------------
// HELIX BIOSYSTEMS (hx) — biotech. Growth: healing, buffs, clones, SIPHON.
// ---------------------------------------------------------------------------
A('hx_001', 'Lab Culture', 'helix', 1, 1, 3, {
  flavor: 'It was yogurt last quarter.' });
O('hx_002', 'Growth Hormone', 'helix', 1, {
  text: 'Give a friendly asset +1/+2.',
  flavor: 'FDA approval pending. Growth is not.',
  effects: { targeting: 'friendlyUnit', play: [{ op: 'buff', attack: 1, health: 2, to: 'target' }] } });
A('hx_003', 'Gene Splicer', 'helix', 2, 2, 3, {
  flavor: 'Cut, copy, paste, patent.' });
A('hx_004', 'Plasma Leech', 'helix', 2, 1, 3, { keywords: ['siphon'],
  text: 'SIPHON.',
  flavor: 'Our most honest revenue model.' });
O('hx_005', 'Booster Shot', 'helix', 2, {
  text: 'Restore 3 Integrity to any character. Draw a card.',
  flavor: 'Now bundled with a loyalty program.',
  effects: { targeting: 'any', play: [{ op: 'heal', amount: 3, to: 'target' }, { op: 'draw', count: 1 }] } });
A('hx_006', 'Field Medics', 'helix', 3, 2, 4, {
  text: 'ONBOARDING: Restore 2 Integrity to any character.',
  flavor: 'In-network, out of patience.',
  effects: { targeting: 'any', onboarding: [{ op: 'heal', amount: 2, to: 'target' }] } });
A('hx_007', 'Bioreactor', 'helix', 3, 3, 4, {
  text: 'Adjacent ORGANISMS gain +1/+1.',
  flavor: 'Feed it grant money and it produces more grant applications.',
  effects: { adjacencyBuff: { attack: 1, health: 1, match: { tag: 'organism' } } } });
A('hx_008', 'Designer Pathogen', 'helix', 2, 1, 1, { keywords: ['toxic', 'stealth'], rarity: 'epic',
  text: 'TOXIC ASSET. STEALTH MODE.',
  flavor: 'Bespoke. Artisanal. Airborne.' });
A('hx_009', 'Containment Unit', 'helix', 4, 2, 6, { keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'The biohazard sticker is load-bearing.' });
O('hx_010', 'Mitosis', 'helix', 5, { rarity: 'epic',
  text: 'Summon a copy of a friendly asset.',
  flavor: 'Headcount doubled. Payroll pending legal review.',
  effects: { targeting: 'friendlyUnit', play: [{ op: 'special', key: 'summonCopy' }] } });
A('hx_011', 'Enhancement Coach', 'helix', 4, 3, 3, { rarity: 'rare',
  text: 'ONBOARDING: Give a friendly asset +2/+2.',
  flavor: 'Performance improvement plan, injectable.',
  effects: { targeting: 'friendlyUnit', onboarding: [{ op: 'buff', attack: 2, health: 2, to: 'target' }] } });
A('hx_012', 'Hemo Harvester', 'helix', 5, 4, 5, { keywords: ['siphon'], rarity: 'rare',
  text: 'SIPHON.',
  flavor: 'Blood from a stone? Amateurs. Blood from a competitor.' });
O('hx_013', 'Rapid Evolution', 'helix', 5, { rarity: 'rare',
  text: 'Give your assets +2/+2.',
  flavor: 'Survival of the best-funded.',
  effects: { targeting: null, play: [{ op: 'buff', attack: 2, health: 2, to: 'allFriendlyUnits' }] } });
A('hx_014', 'Apex Specimen', 'helix', 6, 6, 7, {
  flavor: 'Escaped the enclosure, aced the interview.' });
O('hx_015', 'Airborne Strain', 'helix', 6, { rarity: 'rare',
  text: 'Deal 3 damage to all enemy assets.',
  flavor: 'Patient zero was the marketing department.',
  effects: { targeting: null, play: [{ op: 'aoeDamage', amount: 3, side: 'enemy' }] } });
A('hx_016', 'Symbiotic Titan', 'helix', 7, 6, 8, { keywords: ['firewall', 'siphon'], rarity: 'epic',
  text: 'FIREWALL. SIPHON.',
  flavor: 'A mutually beneficial relationship, per its lawyers.' });
A('hx_017', 'The Hydra Initiative', 'helix', 8, 7, 7, { rarity: 'legendary',
  text: 'GOLDEN PARACHUTE: Summon two 3/3 Hydra Clones.',
  flavor: 'Terminate one department and two more appear in the budget.',
  effects: { parachute: [{ op: 'summon', cardId: 'hx_t_hydra', count: 2 }] } });
A('hx_018', 'Spore Pod', 'helix', 1, 1, 1, { keywords: ['layoff'],
  text: 'LAYOFF. GOLDEN PARACHUTE: Summon a 1/1 Spore.',
  flavor: 'Severance package includes spores.',
  effects: { parachute: [{ op: 'summon', cardId: 'hx_t_spore' }] } });
O('hx_019', 'Regrowth', 'helix', 3, {
  text: 'Restore 8 Integrity to a CEO.',
  flavor: 'The board approved a new spine.',
  effects: { targeting: 'anyHero', play: [{ op: 'heal', amount: 8, to: 'target' }] } });
A('hx_020', 'Chimera Calf', 'helix', 4, 4, 5, {
  flavor: 'One-third lion, one-third goat, one-third intellectual property.' });
O('hx_021', 'Forced Mutation', 'helix', 6, { rarity: 'rare',
  text: 'Transform an enemy asset into a 1/1 Lab Rat.',
  flavor: 'Demoted to preclinical.',
  effects: { targeting: 'enemyUnit', play: [{ op: 'transform', cardId: 'hx_t_labrat', to: 'target' }] } });
A('hx_022', 'Gigafauna', 'helix', 9, 9, 9, { keywords: ['siphon', 'bullish'], rarity: 'epic',
  text: 'SIPHON. BULLISH.',
  flavor: 'The petting zoo IPO went differently than planned.' });

// ---------------------------------------------------------------------------
// OBSIDIAN CAPITAL (ob) — finance/PE. Greed: ramp, sacrifice, parachute value.
// ---------------------------------------------------------------------------
A('ob_001', 'Day Trader', 'obsidian', 1, 2, 1, {
  flavor: 'Diversified across seventeen energy drinks.' });
O('ob_002', 'Asset Strip', 'obsidian', 2, { rarity: 'rare',
  text: 'Destroy a friendly asset. Draw 2 cards.',
  flavor: 'We prefer the term "value extraction event."',
  effects: { targeting: 'friendlyUnit', play: [{ op: 'destroy', to: 'target' }, { op: 'draw', count: 2 }] } });
A('ob_003', 'Junior Analyst', 'obsidian', 2, 2, 3, {
  flavor: 'Model, pitch, cry, repeat.' });
A('ob_004', 'Toxic Asset', 'obsidian', 2, 1, 1, { keywords: ['toxic'], rarity: 'rare',
  text: 'TOXIC ASSET.',
  flavor: 'Rated AAA by an agency we also own.' });
O('ob_005', 'Liquidation Order', 'obsidian', 5, {
  text: 'Destroy an enemy asset.',
  flavor: 'Everything must go. Especially you.',
  effects: { targeting: 'enemyUnit', play: [{ op: 'destroy', to: 'target' }] } });
O('ob_032', 'Margin Call', 'obsidian', 1, {
  text: 'Destroy an enemy asset with 2 or less Health.',
  flavor: 'Collateral shortfall. Liquidated before lunch.',
  effects: { targeting: 'enemyUnitLowHealth', play: [{ op: 'destroy', to: 'target' }] } });
O('ob_006', 'Aggressive Expansion', 'obsidian', 2, { rarity: 'rare',
  text: 'Gain 1 permanent maximum Capital.',
  flavor: 'Growth strategy: buy the strategy department of a growth company.',
  effects: { targeting: null, play: [{ op: 'addCapital', amount: 1, permanent: true }] } });
A('ob_007', 'Departing Executive', 'obsidian', 3, 3, 2, { keywords: ['severance'],
  text: 'SEVERANCE. GOLDEN PARACHUTE: Draw a card.',
  flavor: 'Failed upward with such velocity he achieved orbit.',
  effects: { parachute: [{ op: 'draw', count: 1 }] } });
A('ob_008', 'Shell Game Operator', 'obsidian', 4, 3, 3, { keywords: ['shielded'], rarity: 'rare',
  text: 'PATENT PROTECTION.',
  flavor: 'Follow the money. You won’t.' });
A('ob_009', 'Corporate Raider', 'obsidian', 4, 4, 5, { keywords: ['raid'],
  text: 'RAID.',
  flavor: 'He circles distressed companies the way vultures circle, well, him.' });
O('ob_010', 'Insider Trading', 'obsidian', 3, {
  text: 'Draw 2 cards. Deal 2 damage to your CEO.',
  flavor: 'The information wanted to be free. The fine was not.',
  effects: { targeting: null, play: [{ op: 'draw', count: 2 }, { op: 'damage', amount: 2, to: 'friendlyHero' }] } });
A('ob_011', 'Vulture Fund', 'obsidian', 5, 4, 4, { rarity: 'epic',
  text: 'ONBOARDING: Gain 1 permanent maximum Capital.',
  flavor: 'It feeds on carrion and mid-cap manufacturers.',
  effects: { onboarding: [{ op: 'addCapital', amount: 1, permanent: true }] } });
A('ob_012', 'Monopoly Enforcer', 'obsidian', 6, 6, 7, {
  flavor: 'There is no competition clause. There is no competition.' });
A('ob_013', 'Holding Company', 'obsidian', 6, 4, 5, { rarity: 'rare',
  text: 'GOLDEN PARACHUTE: Summon a 4/5 Subsidiary.',
  flavor: 'It holds one thing: another company shaped exactly like it.',
  effects: { parachute: [{ op: 'summon', cardId: 'ob_t_subsidiary' }] } });
A('ob_t_subsidiary', 'Subsidiary', 'obsidian', 6, 4, 5, { collectible: false,
  flavor: 'Wholly owned, partially understood.' });
O('ob_014', 'Market Crash', 'obsidian', 8, { rarity: 'epic',
  text: 'Destroy ALL assets.',
  flavor: 'Somewhere, an economist updates a chart and screams.',
  effects: { targeting: null, play: [{ op: 'destroy', to: 'allUnits' }] } });
O('ob_015', 'Hostile Takeover', 'obsidian', 9, { rarity: 'legendary',
  text: 'Take control of an enemy asset.',
  flavor: 'The offer was declined. The acquisition proceeded.',
  effects: { targeting: 'enemyUnit', play: [{ op: 'special', key: 'stealUnit' }] } });
A('ob_016', 'The Liquidator', 'obsidian', 6, 5, 5, { rarity: 'legendary',
  text: 'ONBOARDING: Destroy a friendly asset and gain Capital equal to its cost this turn.',
  flavor: 'She can find the resale value of anything, including morale.',
  effects: { targeting: 'friendlyUnit', onboarding: [{ op: 'special', key: 'liquidate' }] } });
A('ob_017', 'Escrow Guard', 'obsidian', 1, 1, 3, { keywords: ['layoff'],
  text: 'LAYOFF.',
  flavor: 'Holds funds, grudges, and the elevator.' });
O('ob_018', 'Depreciation', 'obsidian', 2, {
  text: 'Give an enemy asset -2/-2.',
  flavor: 'Booked as a loss the moment it was hired.',
  effects: { targeting: 'enemyUnit', play: [{ op: 'buff', attack: -2, health: -2, to: 'target' }] } });
A('ob_019', 'Security Detail', 'obsidian', 3, 2, 4, { keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'Sunglasses indoors: mandatory. Smiling: prohibited.' });
O('ob_020', 'Pension Raid', 'obsidian', 4, { rarity: 'rare',
  text: 'Deal 3 damage to any target. Restore 3 Integrity to your CEO.',
  flavor: 'The retirement plan retired.',
  effects: { targeting: 'any', play: [{ op: 'damage', amount: 3, to: 'target' }, { op: 'heal', amount: 3, to: 'friendlyHero' }] } });
A('ob_021', 'Bullion Golem', 'obsidian', 8, 8, 8, { keywords: ['bullish'], rarity: 'epic',
  text: 'BULLISH.',
  flavor: 'A hedge against inflation, sentiment, and small-arms fire.' });
A('ob_022', 'Repo Crew', 'obsidian', 2, 3, 2, {
  flavor: 'They accept cash, cars, and kidneys, in that order.' });
O('ob_023', 'Counter Offer', 'obsidian', 5, { rarity: 'epic',
  text: 'Take control of an enemy asset that costs 4 or less.',
  flavor: 'Name your price. They already did. We doubled it and kept the receipt.',
  effects: { targeting: 'enemyUnitCost4', play: [{ op: 'special', key: 'stealUnit' }] } });
A('ob_024', 'Hedge Fund', 'obsidian', 5, 0, 5, { keywords: ['stealth'], rarity: 'epic',
  keywordLabels: { stealth: 'CORPORATE VEIL' },
  text: 'This asset’s Attack always equals your current Capital.',
  flavor: 'It is long on everything and accountable for nothing.',
  effects: { dynamicAttack: 'capital' } });
O('ob_025', 'Franchise', 'obsidian', 3, { rarity: 'rare',
  text: 'Summon a copy of any FACILITY asset (yours or the enemy’s).',
  flavor: 'Same logo, same layout, same suspiciously flat soda. Now on their side of the street too.',
  effects: { targeting: 'facilityUnit', play: [{ op: 'special', key: 'summonCopy' }] } });
A('ob_026', 'Executive Suite', 'obsidian', 5, 4, 6, { rarity: 'epic',
  text: 'Adjacent FINANCIAL assets gain +1/+1.',
  flavor: 'Everyone at this table bills more per hour than you make per year.',
  effects: { adjacencyBuff: { attack: 1, health: 1, match: { tag: 'financial' } } } });
A('ob_027', 'Mega Yacht', 'obsidian', 6, 5, 7, { rarity: 'epic',
  text: 'GOLDEN PARACHUTE: Gain 3 Capital this turn.',
  flavor: 'When the company goes under, it’s the only thing that still floats.',
  effects: { parachute: [{ op: 'addCapital', amount: 3 }] } });
A('ob_028', 'Federal Reserve Annex', 'obsidian', 3, 2, 5, { keywords: ['firewall'], rarity: 'epic',
  text: 'FIREWALL. At the end of your turn, gain 1 permanent maximum Capital.',
  flavor: 'Older than the company, sturdier than the company, and printing the whole time.',
  effects: { endOfTurn: [{ op: 'addCapital', amount: 1, permanent: true }] } });
A('ob_029', 'Cayman Clearinghouse', 'obsidian', 4, 3, 5, { rarity: 'epic',
  text: 'GOLDEN PARACHUTE: Gain 1 Capital for each other FINANCIAL asset you control.',
  flavor: 'No sign out front. No employees inside. Just numbers, moving.',
  effects: { parachute: [{ op: 'addCapital', perFriendlyTag: 'financial' }] } });
A('ob_030', 'The Exchange', 'obsidian', 5, 4, 5, { rarity: 'epic',
  text: 'Whenever you play a FINANCIAL asset, gain 1 Capital.',
  flavor: 'Every trade lights up a window. Most of the building is dark by noon.',
  effects: { onFriendlyAssetPlayed: { match: { tag: 'financial' }, capital: 1 } } });
A('ob_031', 'Talent Acquisition Center', 'obsidian', 4, 3, 5, { rarity: 'rare',
  text: 'Adjacent PERSONNEL assets gain +1/+1.',
  flavor: 'The line outside wraps the block. Most of them are here for the free coffee.',
  effects: { adjacencyBuff: { attack: 1, health: 1, match: { tag: 'personnel' } } } });

// ---------------------------------------------------------------------------
// NEUTRAL — Independent Contractors (ntr)
// ---------------------------------------------------------------------------
A('ntr_001', 'Unpaid Intern', 'neutral', 0, 1, 1, { keywords: ['layoff'],
  text: 'LAYOFF.',
  flavor: 'Compensation: one (1) line on a résumé.' });
A('ntr_002', 'Temp Worker', 'neutral', 1, 1, 2, {
  flavor: 'Day 400 of the two-week assignment.' });
A('ntr_003', 'Gig Courier', 'neutral', 1, 2, 1, {
  flavor: 'Four stars. Would deliver corporate secrets again.' });
A('ntr_004', 'Patent Clerk', 'neutral', 1, 1, 1, { keywords: ['shielded'],
  text: 'PATENT PROTECTION.',
  flavor: 'Filed a patent on being fired. It’s pending.' });
A('ntr_005', 'Office Manager', 'neutral', 2, 2, 3, {
  flavor: 'Controls the thermostat. Therefore, controls everything.' });
A('ntr_006', 'Sales Rep', 'neutral', 2, 3, 2, {
  flavor: 'Just circling back to touch base about synergies.' });
A('ntr_007', 'Security Guard', 'neutral', 2, 2, 2, { keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'Sign in. SIGN. IN.' });
A('ntr_008', 'Records Clerk', 'neutral', 2, 2, 1, {
  text: 'GOLDEN PARACHUTE: Draw a card.',
  flavor: 'Shredded, in triplicate.',
  effects: { parachute: [{ op: 'draw', count: 1 }] } });
A('ntr_009', 'Consultant', 'neutral', 3, 3, 4, {
  flavor: 'Borrowed your watch to bill you the time.' });
A('ntr_010', 'HR Department', 'neutral', 3, 2, 5, {
  flavor: 'This conversation is confidential and already forwarded.' });
A('ntr_011', 'Ambulance Chaser', 'neutral', 3, 4, 2, { keywords: ['severance'],
  text: 'SEVERANCE.',
  flavor: 'Have YOU been injured by a rival conglomerate?' });
A('ntr_012', 'Front Desk Barricade', 'neutral', 3, 1, 4, { keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'You can’t hostile-takeover without an appointment.' });
A('ntr_013', 'Middle Management', 'neutral', 4, 4, 5, {
  flavor: 'Adds a layer. Of what, nobody asks.' });
A('ntr_014', 'Compliance Officer', 'neutral', 4, 2, 6, { keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'Fun is a reportable incident.' });
A('ntr_015', 'Process Server', 'neutral', 4, 3, 3, { keywords: ['severance'],
  text: 'SEVERANCE. ONBOARDING: Deal 1 damage to any target.',
  flavor: 'You’ve been served. Literally and legally.',
  effects: { targeting: 'any', onboarding: [{ op: 'damage', amount: 1, to: 'target' }] } });
A('ntr_016', 'Teamsters Rep', 'neutral', 5, 5, 6, {
  flavor: 'Negotiates with a clipboard and the implication of forklifts.' });
A('ntr_017', 'Building Security', 'neutral', 5, 3, 6, { keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'The badge reader hungers.' });
A('ntr_018', 'Senior Partner', 'neutral', 6, 6, 7, {
  flavor: 'Bills in six-minute increments, including this one.' });
A('ntr_019', 'Litigation Engine', 'neutral', 7, 7, 7, {
  flavor: 'Objection sustained. Objection manufactured. Objection shipped.' });
A('ntr_020', 'Patent Troll', 'neutral', 2, 1, 1, { keywords: ['toxic'], rarity: 'rare',
  text: 'TOXIC ASSET.',
  flavor: 'Owns the patent on rounded corners and, somehow, grief.' });
A('ntr_021', 'Corporate Spy', 'neutral', 3, 3, 2, { keywords: ['stealth'], rarity: 'rare',
  text: 'STEALTH MODE.',
  flavor: 'The janitor with the Harvard MBA.' });
A('ntr_022', 'Picket Line', 'neutral', 4, 3, 5, { keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'No contract, no crossing.' });
A('ntr_023', 'Headhunter', 'neutral', 5, 4, 4, { rarity: 'rare',
  text: 'ONBOARDING: Draw a card.',
  flavor: 'It’s not poaching if you use a spreadsheet.',
  effects: { onboarding: [{ op: 'draw', count: 1 }] } });
A('ntr_024', 'Loan Shark', 'neutral', 6, 4, 5, { keywords: ['siphon'], rarity: 'rare',
  text: 'SIPHON.',
  flavor: 'APR: yes.' });
A('ntr_025', 'The Umbrella Fund', 'neutral', 7, 6, 6, { keywords: ['shielded'], rarity: 'epic',
  text: 'PATENT PROTECTION.',
  flavor: 'Insured against acts of God, market, and marketing.' });
O('ntr_026', 'Team Building Exercise', 'neutral', 3, { rarity: 'rare',
  text: 'Give your assets +1/+1.',
  flavor: 'Trust falls, mandatory. Trust, optional.',
  effects: { targeting: null, play: [{ op: 'buff', attack: 1, health: 1, to: 'allFriendlyUnits' }] } });
O('ntr_027', 'Budget Cuts', 'neutral', 3, {
  text: 'Deal 1 damage to all assets.',
  flavor: 'The scissors were also cut from the budget.',
  effects: { targeting: null, play: [{ op: 'aoeDamage', amount: 1, side: 'all' }] } });
O('ntr_028', 'Mandatory Overtime', 'neutral', 2, { rarity: 'rare',
  text: 'Give a friendly asset OVERTIME.',
  flavor: 'The beatings will continue until productivity doubles.',
  effects: { targeting: 'friendlyUnit', play: [{ op: 'grantKeyword', keyword: 'overtime', to: 'target' }] } });
O('ntr_029', 'Gag Order', 'neutral', 2, { rarity: 'rare',
  text: 'Silence an asset.',
  flavor: 'Per the settlement, this flavor text does not exist.',
  effects: { targeting: 'anyUnit', play: [{ op: 'silence', to: 'target' }] } });
A('ntr_030', 'Randall Quicke, Talent Poacher', 'neutral', 5, 4, 4, { rarity: 'legendary',
  text: 'ONBOARDING: Your opponent discards a random card.',
  flavor: 'He doesn’t steal employees. He liberates head-count.',
  effects: { onboarding: [{ op: 'discardRandom', count: 1, player: 'opponent' }] } });
A('ntr_031', 'Free Coffee Machine', 'neutral', 4, 7, 7, { rarity: 'legendary',
  text: 'ONBOARDING: Your opponent draws 2 cards.',
  flavor: 'Nothing is free. The machine knows this and waits.',
  effects: { onboarding: [{ op: 'draw', count: 2, player: 'opponent' }] } });
O('ntr_032', 'All-Hands Meeting', 'neutral', 4, {
  text: 'Summon three 1/1 Unpaid Interns.',
  flavor: 'This meeting could have been three emails and one resignation.',
  effects: { targeting: null, play: [{ op: 'summon', cardId: 'ntr_001', count: 3 }] } });
O('ntr_033', 'Layoff Notice', 'neutral', 1, { rarity: 'rare',
  text: 'Destroy a friendly asset. Restore Integrity to your CEO equal to its Integrity.',
  flavor: 'Your position has been consolidated into the CEO’s wellness plan.',
  effects: { targeting: 'friendlyUnit', play: [{ op: 'special', key: 'layoffTarget' }] } });
A('ntr_034', 'Whistleblower', 'neutral', 3, 2, 4, { keywords: ['severance'], rarity: 'rare',
  text: 'SEVERANCE.',
  flavor: 'Retained counsel before HR retained a reason.' });
O('ntr_035', 'The Nuclear Option', 'neutral', 9, { rarity: 'legendary',
  text: 'Destroy ALL assets.',
  flavor: 'When the board can’t be won, it is instead ended. Every party. No survivors. Full compliance.',
  effects: { targeting: null, play: [{ op: 'destroy', to: 'allUnits' }] } });
O('ntr_036', 'Firewall Upgrade', 'neutral', 1, {
  text: 'Give a friendly asset FIREWALL.',
  flavor: 'Patched, hardened, and now legally a load-bearing wall.',
  effects: { targeting: 'friendlyUnitNoFirewall', play: [{ op: 'grantKeyword', keyword: 'firewall', to: 'target' }] } });
O('ntr_037', 'Flirty Intern', 'neutral', 2, { rarity: 'rare',
  text: 'Distract an enemy asset — it can’t attack for 3 of its turns.',
  flavor: 'Turns out “let’s circle back after lunch” is a load-bearing sentence.',
  effects: { targeting: 'enemyUnit', play: [{ op: 'distract', turns: 3, to: 'target' }] } });
A('ntr_038', 'Corporate Lobbyist', 'neutral', 3, 2, 4, { rarity: 'rare',
  text: 'While in play, your CONTRACTS cost (1) less.',
  flavor: 'He didn’t write the loophole. He just made sure it was load-bearing.',
  effects: { static: { contractCostReduction: 1 } } });
A('ntr_039', 'Affiliate Influencer', 'neutral', 3, 3, 4, { rarity: 'rare',
  text: 'When this attacks a PERSONNEL asset, deal 1 extra damage.',
  flavor: 'Every opinion is authentic and brought to you by our partners.',
  effects: { combatBonus: { vsTag: 'personnel', damage: 1 } } });
O('ntr_040', 'Multilevel Marketing', 'neutral', 0, { rarity: 'rare',
  text: 'Gain 1 Capital this turn for each asset your opponent played last turn.',
  flavor: 'It’s not a pyramid. Pyramids are load-bearing.',
  effects: { targeting: null, play: [{ op: 'addCapital', perEnemyAsset: true }] } });

// ---------------------------------------------------------------------------
// CONTRACTS (§3b) — persistent corporate agreements, plus the two neutral
// answers (Contract Attorney is an ASSET, Void Clause an OPERATION).
// ---------------------------------------------------------------------------
const K = (id, name, faction, cost, extra = {}) =>
  C({ id, name, faction, type: 'CONTRACT', cost, ...extra });

K('nx_c01', 'Terms of Service', 'nexus', 3, { rarity: 'rare',
  text: 'Your OPERATIONS cost (1) less.',
  flavor: 'By reading this sentence, you have agreed to it.',
  effects: { static: { opCostReduction: 1 } } });
K('nx_c02', 'Data Harvesting Agreement', 'nexus', 4, { rarity: 'rare', term: 3,
  text: 'TERM 3. At the start of your turn, draw a card.',
  flavor: 'Your data is perfectly safe with us and our 340 trusted partners.',
  effects: { startOfTurn: [{ op: 'draw', count: 1 }] } });
K('nx_c03', 'Push Notification Consent', 'nexus', 2, {
  text: 'Whenever you play an OPERATION, deal 1 damage to the enemy CEO.',
  flavor: 'You may opt out at any time, in person, at headquarters, during the eclipse.',
  effects: { onOperationPlayed: [{ op: 'damage', amount: 1, to: 'enemyHero' }] } });

K('vx_c01', 'Munitions Contract', 'vulcan', 4, { rarity: 'rare',
  text: 'Your operations and CEO power deal +1 damage.',
  flavor: 'Warranty void where prohibited. Prohibition void where profitable.',
  effects: { static: { opDamageBonus: 1 } } });
K('vx_c02', 'Overtime Mandate', 'vulcan', 3, {
  text: 'At the end of your turn, deal 1 damage to the enemy CEO.',
  flavor: 'Clause 9(a): the workday ends when the quota says it ends.',
  effects: { endOfTurn: [{ op: 'damage', amount: 1, to: 'enemyHero' }] } });
K('vx_c03', 'Escalation Clause', 'vulcan', 5, { rarity: 'epic',
  text: 'BOTH PARTIES. At the start of each player’s turn, that player’s CEO takes 1 damage.',
  flavor: 'Both parties agree to escalate in good faith.',
  effects: { bothParties: true, startOfTurn: [{ op: 'damage', amount: 1, to: 'friendlyHero' }] } });
// §counters (Phase 1): a live ATTACK aura on the ROBOTIC asset class.
K('vx_c04', 'Retooling Order', 'vulcan', 3, { rarity: 'rare',
  text: 'While in play, your ROBOTIC-class assets have +1 Attack.',
  flavor: 'Every machine on the floor gets a firmware patch and a grievance.',
  effects: { aura: { match: { tag: 'robotic' }, attack: 1 } } });

K('hx_c01', 'Corporate Wellness Program', 'helix', 3, {
  text: 'At the end of your turn, restore 2 Integrity to your CEO.',
  flavor: 'Participation is voluntary and enrollment is automatic.',
  effects: { endOfTurn: [{ op: 'heal', amount: 2, to: 'friendlyHero' }] } });
K('hx_c02', 'Regeneration Rider', 'helix', 4, { rarity: 'rare',
  text: 'At the start of your turn, restore 1 Integrity to each friendly asset.',
  flavor: 'Coverage renews nightly. Exclusions apply to pre-existing employees.',
  effects: { startOfTurn: [{ op: 'heal', amount: 1, to: 'allFriendlyUnits' }] } });
K('hx_c03', 'Life Insurance Policy', 'helix', 2, {
  text: 'Whenever a friendly asset is destroyed, restore 2 Integrity to your CEO.',
  flavor: 'Sole beneficiary: the company. It is always the company.',
  effects: { onFriendlyAssetDestroyed: [{ op: 'heal', amount: 2, to: 'friendlyHero' }] } });

K('ob_c01', 'Payday Lending Agreement', 'obsidian', 2, {
  text: 'At the start of your turn, gain 1 Capital this turn only. Fine print: your CEO takes 1 damage each turn.',
  flavor: 'APR disclosed in Appendix F, font size 0.5, printed in white.',
  effects: { startOfTurn: [
    { op: 'addCapital', amount: 1 },
    { op: 'damage', amount: 1, to: 'friendlyHero' },
  ] } });
K('ob_c02', 'Bridge Loan', 'obsidian', 4, { rarity: 'epic', term: 2,
  text: 'TERM 2. At the start of your turn, gain +1 permanent maximum Capital.',
  flavor: 'Short-term financing for long-term regret.',
  effects: { startOfTurn: [{ op: 'addCapital', amount: 1, permanent: true }] } });
K('ob_c03', 'Liquidation Rights', 'obsidian', 3, { rarity: 'rare',
  text: 'Whenever a friendly asset is destroyed, gain 1 Capital this turn only.',
  flavor: 'Anything not nailed down is collateral. The nails are a separate schedule.',
  effects: { onFriendlyAssetDestroyed: [{ op: 'addCapital', amount: 1 }] } });

A('ntr_c01', 'Contract Attorney', 'neutral', 3, 2, 3, { rarity: 'rare',
  text: 'ONBOARDING: Declare an enemy contract null & void.',
  flavor: 'Bills by the hour, wins by the loophole.',
  effects: { targeting: 'enemyContract', onboarding: [{ op: 'nullify', to: 'target' }] } });
O('ntr_c02', 'Void Clause', 'neutral', 1, {
  text: 'Declare an enemy contract null & void.',
  flavor: 'This clause supersedes all prior clauses, including itself.',
  effects: { targeting: 'enemyContract', play: [{ op: 'nullify', to: 'target' }] } });
K('ntr_c03', 'Regulatory Capture', 'neutral', 4, { rarity: 'epic',
  text: 'While in play, your opponent’s cards cost (1) more.',
  flavor: 'The agency meant to police the industry now takes minutes at its board meetings.',
  effects: { static: { enemyCostIncrease: 1 } } });
K('ntr_c04', 'War Chest', 'neutral', 2, { rarity: 'epic',
  text: 'At the end of your turn, bank your unspent Capital (max 8). Activate: spend the bank on ASSETS this turn.',
  flavor: 'Filed under “miscellaneous.” Audited by no one, twice a year.',
  effects: { endOfTurn: [{ op: 'bankCapital', cap: 8 }], reserve: { assetOnly: true } } });

// ---------------------------------------------------------------------------
// STARTER DECKS — 40 cards, max 2 copies, faction + neutral
// ---------------------------------------------------------------------------
const pairs = (ids) => ids.flatMap((id) => [id, id]);

// §3b: each starter deck swaps in ONE copy of one of its faction's contracts
// plus ONE ntr_c02 Void Clause, cutting one copy each of two existing cards
// (still exactly 40, still passes validateDeck).
const withContracts = (baseIds, cuts, contractId) => {
  const cards = pairs(baseIds);
  for (const id of cuts) cards.splice(cards.indexOf(id), 1);
  cards.push(contractId, 'ntr_c02');
  return cards;
};

export const STARTER_DECKS = {
  nexus: {
    // swaps: -1 nx_010, -1 ntr_013 / +1 nx_c01 (Terms of Service), +1 ntr_c02
    name: 'Nexus Dynamics — Move Fast, Sue Things',
    faction: 'nexus',
    cards: withContracts(['nx_001', 'nx_002', 'nx_003', 'nx_004', 'nx_005', 'nx_007', 'nx_008',
      'nx_009', 'nx_015', 'nx_016', 'nx_017', 'nx_020', 'nx_010', 'ntr_007', 'ntr_013',
      'nx_006', 'nx_011', 'nx_013', 'nx_014', 'nx_018'],
    ['nx_010', 'ntr_013'], 'nx_c01'),
  },
  vulcan: {
    // swaps: -1 ntr_003 / +1 vx_c02 (Overtime Mandate), +1 ntr_c02;
    // -2 ntr_006 (Sales Rep) / +1 vx_c04 (Retooling Order, robotic +1 Atk aura)
    name: 'Vulcan Heavy Industries — Q3 Shock & Awe',
    faction: 'vulcan',
    cards: withContracts(['vx_001', 'vx_002', 'vx_003', 'vx_004', 'vx_005', 'vx_006', 'vx_007',
      'vx_008', 'vx_009', 'vx_011', 'vx_013', 'vx_014', 'vx_018', 'ntr_003', 'vx_c04',
      'vx_010', 'vx_015', 'vx_016', 'vx_019', 'vx_020'],
    ['ntr_003', 'vx_c04'], 'vx_c02'),
  },
  helix: {
    // swaps: -1 ntr_005, -1 ntr_013 / +1 hx_c01 (Corporate Wellness Program), +1 ntr_c02
    name: 'Helix Biosystems — Compound Growth',
    faction: 'helix',
    cards: withContracts(['hx_001', 'hx_002', 'hx_003', 'hx_004', 'hx_005', 'hx_006', 'hx_007',
      'hx_009', 'hx_011', 'hx_012', 'hx_013', 'hx_014', 'hx_020', 'ntr_005', 'ntr_013',
      'hx_008', 'hx_010', 'hx_016', 'hx_018', 'hx_019'],
    ['ntr_005', 'ntr_013'], 'hx_c01'),
  },
  obsidian: {
    // swaps: +1 ob_c03 (Liquidation Rights), +1 ntr_c02;
    // -2 ntr_016 (Teamsters Rep) / +1 ob_023 (Counter Offer, faction steal);
    // -1 ntr_013 (Middle Management) / +1 ob_024 (Hedge Fund);
    // -1 ob_022 (Repo Crew, vanilla) / +1 ntr_037 (Flirty Intern);
    // -2 ob_018 (Depreciation, a -2/-2 debuff that can't finish anything) / +2
    // ob_032 (Margin Call — a cheap kill spell in the same "answer a small
    // threat" slot, but it actually removes the body). AI-vs-AI playtesting
    // (watch mode) showed Obsidian had no removal under 2 cost, while Nexus's
    // cheap efficient removal + card draw ran away with the matchup; Vulcan's
    // healthier 60/40 record against the same Nexus deck tracked with having
    // real cheap removal of its own (Shrapnel Burst et al.), not card-draw
    // parity — so this targets the actual lever, not a guess.
    name: 'Obsidian Capital — Leveraged Everything',
    faction: 'obsidian',
    cards: withContracts(['ob_001', 'ob_003', 'ob_005', 'ob_006', 'ob_007', 'ob_008', 'ob_009',
      'ob_010', 'ob_012', 'ob_013', 'ob_019', 'ob_022', 'ob_024', 'ob_023', 'ntr_037',
      'ob_002', 'ob_011', 'ob_016', 'ob_017', 'ob_020', 'ob_032'],
    ['ob_024', 'ob_023', 'ob_022', 'ntr_037'], 'ob_c03'),
  },
};
