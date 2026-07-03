// howtoplay.js — static "How to Play" rules primer. Reachable anytime from
// the lobby, and auto-opened once on a player's first-ever visit there.
// Pure content/DOM — no server/game-state dependency.

import { KEYWORD_NAMES, KEYWORD_HELP, hasSeenTutorial, setSeenTutorial } from './state.js';

const SECTIONS = [
  {
    id: 'objective', title: 'The Objective',
    body: `
      <p>You are the <b>CEO</b> of a conglomerate with <b>30 INTEGRITY</b> (your health).
      Your rival CEO has 30 too. Reduce theirs to <b>0</b> and you complete a
      <b>hostile takeover</b> — you win. That's it.</p>`,
  },
  {
    id: 'capital', title: 'Capital — your resource',
    body: `
      <p><b>Capital</b> is what you spend to play cards — the crystal counter above
      your CEO. You do <b>not</b> choose to "spin up" capital yourself; it grows
      automatically:</p>
      <ul>
        <li>On your very first turn you have <b>1</b> capital.</li>
        <li>Every one of your turns after that, your maximum capital goes up by
        <b>1</b> (capped at <b>10</b>).</li>
        <li>At the start of each of your turns, your capital <b>refills</b> to
        your current maximum — unused capital does not carry over.</li>
      </ul>
      <p>Cards cost capital to play (the gold number on the top-left corner of
      the card). Some CEO powers and operations grant a temporary or permanent
      capital bonus — that's the only other way to gain more.</p>`,
  },
  {
    id: 'turn', title: 'Turn structure',
    body: `
      <p>Turns alternate. On your turn, in any order you like:</p>
      <ul>
        <li><b>Draw</b> happens automatically at the start of your turn.</li>
        <li><b>Play cards</b> from your hand — spend capital to deploy
        <b>ASSETS</b> (units) onto your board or cast one-shot
        <b>OPERATIONS</b> (spells).</li>
        <li><b>Attack</b> with any ready asset (see Combat below).</li>
        <li>Use your <b>CEO POWER</b> — a cost-2 ability, usable once per
        turn, shown next to your portrait.</li>
        <li>Click <b>END TURN</b> (or press Space/E) when you're done. A
        90-second timer auto-ends your turn if you run out of time.</li>
      </ul>
      <p>Going first, you start with 3 cards. Going second, you start with 4
      cards <i>plus</i> a bonus "Government Subsidy" card (free capital) to
      make up for the tempo disadvantage.</p>`,
  },
  {
    id: 'combat', title: 'Combat & defending your CEO',
    body: `
      <p>An asset can attack once per turn, but <b>not</b> the turn it's
      deployed (it has to onboard first) — unless it has <b>FAST-TRACK</b>.
      Click a ready asset, then click what you want it to hit: an enemy
      asset, or the enemy CEO directly.</p>
      <p>When two assets fight, they damage <i>each other</i> simultaneously.
      When an asset attacks the enemy CEO, only the CEO takes damage.</p>
      <p><b>Blocking an attack on your CEO:</b> there's no "block" action to
      react with — defense is proactive. Play an asset with the
      <b>FIREWALL</b> keyword and any enemy attacker is <b>forced</b> to
      attack it before it can touch your CEO or your other assets. Keep a
      firewall unit alive and your CEO is untouchable by combat.</p>`,
  },
  {
    id: 'keywords', title: 'Keyword glossary', kind: 'keywords',
  },
  {
    id: 'limits', title: 'Hand limit, board limit & fatigue',
    body: `
      <p>Your hand holds at most <b>10</b> cards — a draw past that limit
      is destroyed instead ("shredded"). Your board holds at most <b>7</b>
      assets at once.</p>
      <p>If your deck runs out, drawing still happens — except it now deals
      escalating <b>fatigue</b> damage to your own CEO instead of giving you
      a card (1, then 2, then 3...). Watch your deck count.</p>`,
  },
  {
    id: 'tips', title: 'Quick tips',
    body: `
      <ul>
        <li>Hover any card to see a full-size preview with its complete
        rules text and flavor text.</li>
        <li>Cards you can currently afford and legally play glow — likewise
        for assets that are ready to attack.</li>
        <li>The collapsible transaction log on the game screen spells out
        exactly what just happened if an exchange moves fast.</li>
        <li>Build a custom 30-card deck (max 2 copies of any card) in the
        Deck Builder before you queue up.</li>
      </ul>`,
  },
];

let veil = null;

function keywordGlossaryHtml() {
  const rows = Object.keys(KEYWORD_NAMES).map((k) => `
    <div class="htp-kw-row">
      <span class="kw-badge kw-${k}">${KEYWORD_NAMES[k]}</span>
      <span class="htp-kw-desc">${KEYWORD_HELP[k]}</span>
    </div>`).join('');
  return `<div class="htp-kw-grid">${rows}</div>`;
}

function build() {
  veil = document.createElement('div');
  veil.className = 'modal-veil htp-veil';
  const box = document.createElement('div');
  box.className = 'modal htp-modal';
  box.innerHTML = `
    <div class="htp-head">
      <h3>How to Play</h3>
      <button class="btn ghost small" id="htp-close">CLOSE ✕</button>
    </div>
    <div class="htp-body">
      <nav class="htp-nav">${SECTIONS.map((s) => `<a href="#htp-${s.id}">${s.title}</a>`).join('')}</nav>
      <div class="htp-scroll">
        ${SECTIONS.map((s) => `
          <section class="htp-section" id="htp-${s.id}">
            <h4>${s.title}</h4>
            ${s.kind === 'keywords' ? keywordGlossaryHtml() : s.body}
          </section>`).join('')}
      </div>
    </div>
  `;
  veil.appendChild(box);
  box.querySelector('#htp-close').addEventListener('click', close);
  veil.addEventListener('mousedown', (ev) => { if (ev.target === veil) close(); });
  box.querySelectorAll('.htp-nav a').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      box.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  document.body.appendChild(veil);
  document.addEventListener('keydown', onKey);
}

function onKey(ev) {
  if (ev.key === 'Escape') close();
}

export function openHowToPlay() {
  if (veil) return;
  setSeenTutorial();
  build();
}

export function close() {
  if (!veil) return;
  veil.remove();
  veil = null;
  document.removeEventListener('keydown', onKey);
}

export function isOpen() { return !!veil; }

/** Auto-open once, the first time a player ever reaches the lobby. */
export function maybeAutoShow() {
  if (hasSeenTutorial()) return;
  openHowToPlay();
}
