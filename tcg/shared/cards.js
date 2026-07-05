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
//     static: { opCostReduction?: N, opDamageBonus?: N },  // live modifiers, stack
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
//   {op:"discardRandom", count, player?}         player: "opponent"(default)|"self"
//   {op:"transform", cardId, to:"target"}
//   {op:"silence", to:"target"}
//   {op:"nullify", to:"target"}                  null & void a contract (targeting "enemyContract")
//   {op:"special", key, ...}                     keyed handler: "stealUnit"|"summonCopy"|"liquidate"|"layoffTarget"

export const CARDS = {};

function C(card) {
  card.keywords = card.keywords || [];
  card.effects = card.effects || {};
  card.rarity = card.rarity || 'common';
  card.collectible = card.collectible !== undefined ? card.collectible : true;
  card.text = card.text || '';
  card.flavor = card.flavor || '';
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
C({ id: 'nx_ceo', name: 'Vera Lang', faction: 'nexus', type: 'CEO', cost: 0, health: 30,
  powerId: 'nx_power', collectible: false, rarity: 'legendary',
  text: 'CEO of Nexus Dynamics.', flavor: 'She A/B tested her own personality. Variant B won.' });
C({ id: 'nx_power', name: 'Crunch Time', faction: 'nexus', type: 'POWER', cost: 2,
  collectible: false, text: 'Draw a card. Deal 2 damage to your CEO.',
  flavor: 'Sleep is technical debt.',
  effects: { targeting: null, play: [{ op: 'draw', count: 1 }, { op: 'damage', amount: 2, to: 'friendlyHero' }] } });

C({ id: 'vx_ceo', name: 'Brock Hammond', faction: 'vulcan', type: 'CEO', cost: 0, health: 30,
  powerId: 'vx_power', collectible: false, rarity: 'legendary',
  text: 'CEO of Vulcan Heavy Industries.', flavor: 'His handshake has a recoil warning.' });
C({ id: 'vx_power', name: 'Precision Strike', faction: 'vulcan', type: 'POWER', cost: 2,
  collectible: false, text: 'Deal 1 damage to any target.',
  flavor: 'Collateral is a line item.',
  effects: { targeting: 'any', play: [{ op: 'damage', amount: 1, to: 'target' }] } });

C({ id: 'hx_ceo', name: 'Dr. Jin-Ho Park', faction: 'helix', type: 'CEO', cost: 0, health: 30,
  powerId: 'hx_power', collectible: false, rarity: 'legendary',
  text: 'CEO of Helix Biosystems.', flavor: 'Technically he is his own emergency contact. Four times over.' });
C({ id: 'hx_power', name: 'Gene Therapy', faction: 'helix', type: 'POWER', cost: 2,
  collectible: false, text: 'Restore 2 Integrity to any character.',
  flavor: 'Side effects include quarterly growth.',
  effects: { targeting: 'any', play: [{ op: 'heal', amount: 2, to: 'target' }] } });

C({ id: 'ob_ceo', name: 'Sterling Voss', faction: 'obsidian', type: 'CEO', cost: 0, health: 30,
  powerId: 'ob_power', collectible: false, rarity: 'legendary',
  text: 'CEO of Obsidian Capital.', flavor: 'He shorted his own retirement party.' });
C({ id: 'ob_power', name: 'Shell Company', faction: 'obsidian', type: 'POWER', cost: 2,
  collectible: false, text: 'Summon a 1/1 Shell Corp.',
  flavor: 'Registered in a jurisdiction that is technically a boat.',
  effects: { targeting: null, play: [{ op: 'summon', cardId: 'ob_t_shell' }] } });

// ---------------------------------------------------------------------------
// Tokens (non-collectible)
// ---------------------------------------------------------------------------
A('ob_t_shell', 'Shell Corp', 'obsidian', 1, 1, 1, { collectible: false,
  flavor: 'One employee, zero products, immaculate paperwork.' });
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
A('nx_012', 'The Algorithm', 'nexus', 8, 6, 6, { rarity: 'legendary',
  text: 'At the end of your turn, draw a card.',
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
  flavor: 'Mines synergy at 4.2 exaflops.' });
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
  flavor: 'OSHA-compliant, Geneva-adjacent.' });
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
A('vx_016', 'Twin-Barrel Colossus', 'vulcan', 8, 8, 8, { keywords: ['overtime'], rarity: 'epic',
  text: 'OVERTIME.',
  flavor: 'Why fire once when the invoice covers twice?' });
A('vx_017', 'The Juggernaut', 'vulcan', 9, 8, 8, { keywords: ['fasttrack'], rarity: 'legendary',
  text: 'FAST-TRACK.',
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
  flavor: 'Feed it grant money and it produces more grant applications.' });
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
A('hx_022', 'Gigafauna', 'helix', 9, 9, 9, { keywords: ['siphon'], rarity: 'epic',
  text: 'SIPHON.',
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
O('ob_006', 'Aggressive Expansion', 'obsidian', 2, { rarity: 'rare',
  text: 'Gain 1 permanent maximum Capital.',
  flavor: 'Growth strategy: buy the strategy department of a growth company.',
  effects: { targeting: null, play: [{ op: 'addCapital', amount: 1, permanent: true }] } });
A('ob_007', 'Departing Executive', 'obsidian', 3, 3, 2, {
  text: 'GOLDEN PARACHUTE: Draw a card.',
  flavor: 'Failed upward with such velocity he achieved orbit.',
  effects: { parachute: [{ op: 'draw', count: 1 }] } });
A('ob_008', 'Shell Game Operator', 'obsidian', 4, 3, 3, { keywords: ['shielded'], rarity: 'rare',
  text: 'PATENT PROTECTION.',
  flavor: 'Follow the money. You won’t.' });
A('ob_009', 'Corporate Raider', 'obsidian', 4, 4, 5, {
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
A('ob_021', 'Bullion Golem', 'obsidian', 8, 8, 8, { rarity: 'epic',
  flavor: 'A hedge against inflation, sentiment, and small-arms fire.' });
A('ob_022', 'Repo Crew', 'obsidian', 2, 3, 2, {
  flavor: 'They accept cash, cars, and kidneys, in that order.' });

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
A('ntr_011', 'Ambulance Chaser', 'neutral', 3, 4, 2, {
  flavor: 'Have YOU been injured by a rival conglomerate?' });
A('ntr_012', 'Front Desk Barricade', 'neutral', 3, 1, 4, { keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'You can’t hostile-takeover without an appointment.' });
A('ntr_013', 'Middle Management', 'neutral', 4, 4, 5, {
  flavor: 'Adds a layer. Of what, nobody asks.' });
A('ntr_014', 'Compliance Officer', 'neutral', 4, 2, 6, { keywords: ['firewall'],
  text: 'FIREWALL.',
  flavor: 'Fun is a reportable incident.' });
A('ntr_015', 'Process Server', 'neutral', 4, 3, 3, {
  text: 'ONBOARDING: Deal 1 damage to any target.',
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
  text: 'Destroy a friendly asset. Restore Integrity to your CEO equal to its Durability.',
  flavor: 'Your position has been consolidated into the CEO’s wellness plan.',
  effects: { targeting: 'friendlyUnit', play: [{ op: 'special', key: 'layoffTarget' }] } });

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

K('hx_c01', 'Corporate Wellness Program', 'helix', 3, {
  text: 'At the end of your turn, restore 2 Integrity to your CEO.',
  flavor: 'Participation is voluntary and enrollment is automatic.',
  effects: { endOfTurn: [{ op: 'heal', amount: 2, to: 'friendlyHero' }] } });
K('hx_c02', 'Regeneration Rider', 'helix', 4, { rarity: 'rare',
  text: 'At the start of your turn, restore 1 Durability to each friendly asset.',
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

// ---------------------------------------------------------------------------
// STARTER DECKS — 30 cards, max 2 copies, faction + neutral
// ---------------------------------------------------------------------------
const pairs = (ids) => ids.flatMap((id) => [id, id]);

// §3b: each starter deck swaps in ONE copy of one of its faction's contracts
// plus ONE ntr_c02 Void Clause, cutting one copy each of two existing cards
// (still exactly 30, still passes validateDeck).
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
      'nx_009', 'nx_015', 'nx_016', 'nx_017', 'nx_020', 'nx_010', 'ntr_007', 'ntr_013'],
    ['nx_010', 'ntr_013'], 'nx_c01'),
  },
  vulcan: {
    // swaps: -1 ntr_003, -1 ntr_006 / +1 vx_c02 (Overtime Mandate), +1 ntr_c02
    name: 'Vulcan Heavy Industries — Q3 Shock & Awe',
    faction: 'vulcan',
    cards: withContracts(['vx_001', 'vx_002', 'vx_003', 'vx_004', 'vx_005', 'vx_006', 'vx_007',
      'vx_008', 'vx_009', 'vx_011', 'vx_013', 'vx_014', 'vx_018', 'ntr_003', 'ntr_006'],
    ['ntr_003', 'ntr_006'], 'vx_c02'),
  },
  helix: {
    // swaps: -1 ntr_005, -1 ntr_013 / +1 hx_c01 (Corporate Wellness Program), +1 ntr_c02
    name: 'Helix Biosystems — Compound Growth',
    faction: 'helix',
    cards: withContracts(['hx_001', 'hx_002', 'hx_003', 'hx_004', 'hx_005', 'hx_006', 'hx_007',
      'hx_009', 'hx_011', 'hx_012', 'hx_013', 'hx_014', 'hx_020', 'ntr_005', 'ntr_013'],
    ['ntr_005', 'ntr_013'], 'hx_c01'),
  },
  obsidian: {
    // swaps: -1 ntr_013, -1 ntr_016 / +1 ob_c03 (Liquidation Rights), +1 ntr_c02
    name: 'Obsidian Capital — Leveraged Everything',
    faction: 'obsidian',
    cards: withContracts(['ob_001', 'ob_003', 'ob_005', 'ob_006', 'ob_007', 'ob_008', 'ob_009',
      'ob_010', 'ob_012', 'ob_013', 'ob_018', 'ob_019', 'ob_022', 'ntr_013', 'ntr_016'],
    ['ntr_013', 'ntr_016'], 'ob_c03'),
  },
};
