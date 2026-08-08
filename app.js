import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, onValue, set, get } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const tRef = ref(db, 'tournament');

const uid = () => Math.random().toString(36).slice(2, 9);
const pairKey = (a, b) => [a, b].sort().join('~');

function defaultState() {
  return {
    name: 'Hit Padel',
    adminPin: '2026',
    tipo: 'americano', // 'americano' | 'mini' | 'chaves'
    players: [],
    numCourts: 2,
    numRounds: 5,
    rounds: [],
    teams: [],
    bracket: [],
  };
}

// ---------- algoritmo americano (sorteio de duplas rotativas) ----------
function scoreGroup(g, history) {
  const pA = pairKey(g.teamA[0], g.teamA[1]);
  const pB = pairKey(g.teamB[0], g.teamB[1]);
  let s = (history.partner[pA] || 0) * 3 + (history.partner[pB] || 0) * 3;
  g.teamA.forEach((x) => g.teamB.forEach((y) => { s += history.opponent[pairKey(x, y)] || 0; }));
  return s;
}

function bestPairing(four, history) {
  const [a, b, c, d] = four;
  const options = [
    { teamA: [a, b], teamB: [c, d] },
    { teamA: [a, c], teamB: [b, d] },
    { teamA: [a, d], teamB: [b, c] },
  ];
  let best = options[0], bestScore = Infinity;
  options.forEach((o) => { const s = scoreGroup(o, history); if (s < bestScore) { bestScore = s; best = o; } });
  return best;
}

function generateSchedule(players, numCourts, numRounds) {
  const history = { partner: {}, opponent: {} };
  const n = players.length;
  const perRound = numCourts * 4;
  const rounds = [];
  let cursor = 0;

  for (let r = 0; r < numRounds; r++) {
    const numBye = Math.max(0, n - perRound);
    let byeIds = [];
    if (numBye > 0) {
      for (let i = 0; i < numBye; i++) byeIds.push(players[(cursor + i) % n].id);
      cursor = (cursor + numBye) % n;
    }
    const active = players.filter((p) => !byeIds.includes(p.id));

    let bestGroups = null, bestScore = Infinity;
    for (let attempt = 0; attempt < 180; attempt++) {
      const shuffled = [...active].sort(() => Math.random() - 0.5);
      const groups = [];
      for (let i = 0; i + 3 < shuffled.length; i += 4) {
        groups.push(bestPairing(shuffled.slice(i, i + 4).map((p) => p.id), history));
      }
      const s = groups.reduce((acc, g) => acc + scoreGroup(g, history), 0);
      if (s < bestScore) { bestScore = s; bestGroups = groups; }
    }
    if (!bestGroups) bestGroups = [];

    bestGroups.forEach((g) => {
      const pA = pairKey(g.teamA[0], g.teamA[1]);
      const pB = pairKey(g.teamB[0], g.teamB[1]);
      history.partner[pA] = (history.partner[pA] || 0) + 1;
      history.partner[pB] = (history.partner[pB] || 0) + 1;
      g.teamA.forEach((x) => g.teamB.forEach((y) => {
        const k = pairKey(x, y); history.opponent[k] = (history.opponent[k] || 0) + 1;
      }));
    });

    rounds.push({
      round: r + 1,
      byes: byeIds,
      matches: bestGroups.map((g, idx) => ({
        id: uid(), court: idx + 1, teamA: g.teamA, teamB: g.teamB, scoreA: null, scoreB: null,
      })),
    });
  }
  return rounds;
}

function computeStats(players, rounds) {
  const stats = {};
  players.forEach((p) => { stats[p.id] = { id: p.id, name: p.name, partidas: 0, vitorias: 0, derrotas: 0, gf: 0, gc: 0 }; });
  rounds.forEach((rd) => rd.matches.forEach((m) => {
    if (m.scoreA == null || m.scoreB == null) return;
    [[m.teamA, m.scoreA, m.scoreB], [m.teamB, m.scoreB, m.scoreA]].forEach(([team, gf, gc]) => {
      team.forEach((pid) => {
        const s = stats[pid]; if (!s) return;
        s.partidas++; s.gf += gf; s.gc += gc;
        if (gf > gc) s.vitorias++; else if (gf < gc) s.derrotas++;
      });
    });
  }));
  return Object.values(stats)
    .map((s) => ({ ...s, saldo: s.gf - s.gc, pontos: s.gf }))
    .sort((a, b) => b.pontos - a.pontos || b.saldo - a.saldo || b.vitorias - a.vitorias);
}

// número mínimo teórico de rodadas pra cobrir todas as duplas de parceria possíveis
function minRoundsForFullCoverage(numPlayers, numCourts) {
  if (numPlayers < 4) return 0;
  const totalPairs = (numPlayers * (numPlayers - 1)) / 2;
  const pairsPerRound = numCourts * 2;
  return Math.ceil(totalPairs / pairsPerRound);
}

function roundsWithoutScores(rounds) {
  return rounds.some((rd) => rd.matches.some((m) => m.scoreA == null || m.scoreB == null));
}

function generateFinalRound(players, rounds) {
  const stats = computeStats(players, rounds);
  const top4 = stats.slice(0, 4);
  return {
    round: rounds.length + 1,
    isFinal: true,
    byes: [],
    matches: [{
      id: uid(), court: 1,
      teamA: [top4[0].id, top4[3].id],
      teamB: [top4[1].id, top4[2].id],
      scoreA: null, scoreB: null,
    }],
  };
}

// ---------- chaveamento eliminatório (duplas fixas) ----------
function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }
function roundName(matchCount) {
  const map = { 1: 'Final', 2: 'Semifinal', 4: 'Quartas de final', 8: 'Oitavas de final', 16: '16-avos de final', 32: '32-avos de final' };
  return map[matchCount] || `Rodada (${matchCount * 2} duplas)`;
}
function shuffleArr(arr) { return [...arr].sort(() => Math.random() - 0.5); }

function propagateWinner(bracket, roundIdx, matchIdx, winnerId) {
  if (roundIdx + 1 < bracket.length) {
    const nextMatch = bracket[roundIdx + 1][Math.floor(matchIdx / 2)];
    if (matchIdx % 2 === 0) nextMatch.teamA = winnerId; else nextMatch.teamB = winnerId;
  }
}

function generateBracket(teams) {
  const size = nextPow2(teams.length);
  const numByes = size - teams.length;
  const shuffled = shuffleArr(teams);
  const byeTeams = shuffled.slice(0, numByes);
  const playTeams = shuffled.slice(numByes);
  const round1SlotCount = size / 2;
  const slotTypes = shuffleArr([...Array(numByes).fill('bye'), ...Array(round1SlotCount - numByes).fill('match')]);
  let bi = 0, pi = 0;
  const round1 = slotTypes.map((type) => {
    if (type === 'bye') {
      const t = byeTeams[bi++];
      return { id: uid(), teamA: t.id, teamB: null, scoreA: null, scoreB: null, winner: t.id, isBye: true };
    }
    const a = playTeams[pi++], b = playTeams[pi++];
    return { id: uid(), teamA: a.id, teamB: b.id, scoreA: null, scoreB: null, winner: null, isBye: false };
  });
  const bracket = [round1];
  let mc = round1SlotCount;
  while (mc > 1) { mc = mc / 2; bracket.push(Array.from({ length: mc }, () => ({ id: uid(), teamA: null, teamB: null, scoreA: null, scoreB: null, winner: null }))); }
  round1.forEach((m, i) => { if (m.isBye) propagateWinner(bracket, 0, i, m.winner); });
  return bracket;
}

// ---------- estado local / UI ----------
let state = null;
let isAdmin = localStorage.getItem('hitpadel_admin') === 'true';
let tab = 'rodadas';
let setupOpen = true;
let drafts = {};
let savedFlash = null;

const root = document.getElementById('root');

async function persist(next) {
  state = next;
  render();
  try { await set(tRef, next); } catch (e) { console.error('Falha ao salvar', e); }
}

onValue(tRef, (snap) => {
  if (snap.exists()) { state = { ...defaultState(), ...snap.val() }; }
  else { state = defaultState(); set(tRef, state); }
  render();
});

get(tRef).then((snap) => { if (!snap.exists()) set(tRef, defaultState()); });

function nameOf(id) { return state.players.find((p) => p.id === id)?.name || '?'; }
function teamNameOf(id) { return state.teams.find((t) => t.id === id)?.name || (id ? '?' : 'aguardando'); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function render() {
  if (!state) { root.innerHTML = '<div class="loading">Carregando quadra...</div>'; return; }
  const maxCourts = Math.max(1, Math.floor(state.players.length / 4)) || 1;
  const stats = computeStats(state.players, state.rounds);
  const showSetup = isAdmin || (state.players.length === 0 && state.teams.length === 0);
  const hasContent = state.tipo === 'chaves' ? state.bracket.length > 0 : state.rounds.length > 0;

  root.innerHTML = `
    <header class="hp-header">
      <div class="hp-header-inner">
        <div class="hp-brand">
          <img class="hp-logo" src="./logo.png" alt="Hit Padel Tuparendi" />
          <div>
            ${isAdmin
              ? `<input class="hp-name-input" data-action="rename" value="${esc(state.name)}" />`
              : `<div class="hp-name">${esc(state.name)}</div>`}
            <div class="hp-live"><span class="dot"></span> ao vivo</div>
          </div>
        </div>
        <button class="hp-admin-btn ${isAdmin ? 'on' : ''}" data-action="toggle-admin">
          ${isAdmin ? 'Admin' : 'Ver como admin'}
        </button>
      </div>
    </header>

    <main class="hp-main">
      ${showSetup ? renderSetup(maxCourts) : ''}
      ${state.tipo === 'chaves' ? renderBracketView() : renderAmericanoView(hasContent, stats)}
    </main>

    <div id="pin-modal-slot"></div>
    <footer class="hp-footer">atualiza automaticamente</footer>
  `;
  bindEvents();
}

function renderAmericanoView(hasContent, stats) {
  if (!hasContent) return '';
  const podeGerarFinal = state.tipo === 'mini'
    && !state.rounds.some((r) => r.isFinal)
    && state.rounds.length > 0
    && !roundsWithoutScores(state.rounds)
    && state.players.length >= 4;
  return `
    <div class="tabs">
      <button class="tab ${tab === 'rodadas' ? 'active' : ''}" data-action="tab" data-tab="rodadas">Rodadas</button>
      <button class="tab ${tab === 'ranking' ? 'active' : ''}" data-action="tab" data-tab="ranking">Ranking</button>
    </div>
    ${isAdmin && podeGerarFinal ? `<button class="btn-primary" style="margin-bottom:14px" data-action="gerar-final">🏆 Gerar final (top 4)</button>` : ''}
    ${tab === 'rodadas' ? renderRounds() : ''}
    ${tab === 'ranking' ? renderRanking(stats) : ''}
  `;
}

function renderSetup(maxCourts) {
  const minRounds = minRoundsForFullCoverage(state.players.length, Math.min(state.numCourts, maxCourts));
  return `
  <section class="card">
    <button class="card-head" data-action="toggle-setup">
      <span>Configuração</span><span>${setupOpen ? '▲' : '▼'}</span>
    </button>
    ${setupOpen ? `
    <div class="card-body">
      ${isAdmin ? `
        <div class="field">
          <label>Tipo de torneio</label>
          <div class="mode-row">
            <button class="mode-btn ${state.tipo === 'americano' ? 'active' : ''}" data-action="set-tipo" data-tipo="americano">Americano</button>
            <button class="mode-btn ${state.tipo === 'mini' ? 'active' : ''}" data-action="set-tipo" data-tipo="mini">Americano + Final</button>
            <button class="mode-btn ${state.tipo === 'chaves' ? 'active' : ''}" data-action="set-tipo" data-tipo="chaves">Chaves (mata-mata)</button>
          </div>
          <div class="hint" style="text-align:left;margin-top:4px">
            ${state.tipo === 'americano' ? 'Duplas rotativas, todo mundo joga com e contra todo mundo o máximo possível. Ranking individual.' : ''}
            ${state.tipo === 'mini' ? 'Igual ao Americano, mas ao final das rodadas você gera uma grande final com as 4 melhores colocadas.' : ''}
            ${state.tipo === 'chaves' ? 'Duplas fixas cadastradas de antemão, eliminatória direta (oitavas/quartas/semi/final) até sair a campeã.' : ''}
          </div>
        </div>

        ${state.tipo === 'chaves' ? renderTeamsSetup() : renderPlayersSetup(maxCourts, minRounds)}

        <div class="field">
          <label>PIN de admin</label>
          <input id="admin-pin" value="${esc(state.adminPin)}" data-action="set-pin" />
        </div>

        ${state.tipo === 'chaves' ? `
          <button class="btn-primary" data-action="gerar-chave" ${state.teams.length < 2 ? 'disabled' : ''}>Gerar chaveamento</button>
          ${state.teams.length < 2 ? '<div class="hint">Cadastre pelo menos 2 duplas</div>' : ''}
        ` : `
          <button class="btn-primary" data-action="sortear" ${state.players.length < 4 ? 'disabled' : ''}>Sortear rodadas</button>
          ${state.players.length < 4 ? '<div class="hint">Cadastre pelo menos 4 jogadoras</div>' : ''}
        `}
      ` : `<div class="hint">O torneio ainda não foi configurado. Peça para o organizador entrar como admin.</div>`}
    </div>` : ''}
  </section>`;
}

function renderPlayersSetup(maxCourts, minRounds) {
  return `
    <div class="field">
      <label>Jogadoras (${state.players.length})</label>
      <div class="chips">
        ${state.players.map((p) => `
          <span class="chip">${esc(p.name)} <button data-action="remove-player" data-id="${p.id}">×</button></span>
        `).join('')}
      </div>
      <div class="row">
        <input id="new-player" placeholder="Nome da jogadora" />
        <button data-action="add-player">+</button>
      </div>
    </div>
    <div class="row2">
      <div class="field">
        <label>Quadras (máx ${maxCourts})</label>
        <input type="number" min="1" max="${maxCourts}" id="num-courts" value="${state.numCourts}" data-action="set-courts" />
      </div>
      <div class="field">
        <label>Rodadas</label>
        <input type="number" min="1" max="30" id="num-rounds" value="${state.numRounds}" data-action="set-rounds" />
      </div>
    </div>
    ${minRounds > 0 ? `<div class="hint" style="text-align:left">Com ${state.players.length} jogadoras e ${Math.min(state.numCourts, maxCourts)} quadra(s), seriam necessárias <b>~${minRounds} rodadas</b> pra todo mundo jogar com todo mundo pelo menos 1x (bem mais que o normal — poucas rodadas já garantem boa mistura).</div>` : ''}
  `;
}

function renderTeamsSetup() {
  return `
    <div class="field">
      <label>Duplas (${state.teams.length})</label>
      <div class="chips">
        ${state.teams.map((t) => `
          <span class="chip">${esc(t.name)} <button data-action="remove-team" data-id="${t.id}">×</button></span>
        `).join('')}
      </div>
      <div class="row">
        <input id="new-team" placeholder="Ex: Ana & Bruna" />
        <button data-action="add-team">+</button>
      </div>
    </div>
  `;
}

function renderRounds() {
  return `<div class="rounds">
    ${state.rounds.map((rd, ri) => `
      <div class="round-block ${rd.isFinal ? 'is-final' : ''}">
        <div class="round-title">
          <span>${rd.isFinal ? '🏆 GRANDE FINAL' : `Rodada ${rd.round}`}</span>
          ${rd.byes && rd.byes.length ? `<span class="bye">folga: ${rd.byes.map(nameOf).map(esc).join(', ')}</span>` : ''}
        </div>
        <div class="matches">
          ${rd.matches.map((m) => renderMatch(m, ri)).join('')}
        </div>
      </div>
    `).join('')}
  </div>`;
}

function renderMatch(m, ri) {
  const d = drafts[m.id] || { a: m.scoreA ?? '', b: m.scoreB ?? '' };
  const done = m.scoreA != null && m.scoreB != null;
  return `
  <div class="match">
    <div class="match-head">
      <span class="court-tag">QUADRA ${m.court}</span>
      ${done ? '<span class="check">✓</span>' : ''}
    </div>
    <div class="team-row">
      <span class="team-name">${m.teamA.map(nameOf).map(esc).join(' + ')}</span>
      ${isAdmin
        ? `<input type="number" min="0" class="score-input" data-action="score-a" data-match="${m.id}" data-round="${ri}" value="${d.a}" />`
        : `<span class="score">${m.scoreA ?? '–'}</span>`}
    </div>
    <div class="vs">×</div>
    <div class="team-row">
      <span class="team-name">${m.teamB.map(nameOf).map(esc).join(' + ')}</span>
      ${isAdmin
        ? `<input type="number" min="0" class="score-input" data-action="score-b" data-match="${m.id}" data-round="${ri}" value="${d.b}" />`
        : `<span class="score">${m.scoreB ?? '–'}</span>`}
    </div>
    ${isAdmin ? `<button class="btn-save" data-action="save-score" data-match="${m.id}" data-round="${ri}">
      ${savedFlash === m.id ? 'Salvo ✓' : 'Salvar placar'}
    </button>` : ''}
  </div>`;
}

function renderRanking(stats) {
  if (!stats.length) return `<div class="card-body hint">Nenhum resultado lançado ainda.</div>`;
  return `
  <table class="ranking">
    <thead><tr><th>#</th><th>Jogadora</th><th>J</th><th>V</th><th>SG</th><th>Pts</th></tr></thead>
    <tbody>
      ${stats.map((s, i) => `
        <tr>
          <td class="${i < 3 ? 'top' : ''}">${i + 1}</td>
          <td>${esc(s.name)}</td>
          <td class="c">${s.partidas}</td>
          <td class="c">${s.vitorias}</td>
          <td class="c">${s.saldo > 0 ? '+' + s.saldo : s.saldo}</td>
          <td class="pts">${s.pontos}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>`;
}

function renderBracketView() {
  if (!state.bracket.length) return '';
  const champion = state.bracket[state.bracket.length - 1][0]?.winner;
  return `
  <div class="rounds">
    ${champion ? `<div class="champion-banner">🏆 Campeã: ${esc(teamNameOf(champion))}</div>` : ''}
    ${state.bracket.map((rd, ri) => `
      <div class="round-block">
        <div class="round-title"><span>${roundName(rd.length)}</span></div>
        <div class="matches">
          ${rd.map((m) => renderBracketMatch(m, ri)).join('')}
        </div>
      </div>
    `).join('')}
  </div>`;
}

function renderBracketMatch(m, ri) {
  if (m.isBye) {
    return `<div class="match bye-match"><span class="team-name">${esc(teamNameOf(m.teamA))}</span><span class="bye-tag">passou direto</span></div>`;
  }
  if (m.teamA == null || m.teamB == null) {
    return `<div class="match pending-match">${esc(teamNameOf(m.teamA))} <span class="vs">×</span> ${esc(teamNameOf(m.teamB))} <span class="hint">(aguardando fase anterior)</span></div>`;
  }
  const d = drafts[m.id] || { a: m.scoreA ?? '', b: m.scoreB ?? '' };
  const done = m.winner != null;
  return `
  <div class="match ${done ? 'decided' : ''}">
    <div class="team-row ${m.winner === m.teamA ? 'winner' : ''}">
      <span class="team-name">${esc(teamNameOf(m.teamA))}</span>
      ${isAdmin && !done
        ? `<input type="number" min="0" class="score-input" data-action="bscore-a" data-match="${m.id}" data-round="${ri}" value="${d.a}" />`
        : `<span class="score">${m.scoreA ?? '–'}</span>`}
    </div>
    <div class="vs">×</div>
    <div class="team-row ${m.winner === m.teamB ? 'winner' : ''}">
      <span class="team-name">${esc(teamNameOf(m.teamB))}</span>
      ${isAdmin && !done
        ? `<input type="number" min="0" class="score-input" data-action="bscore-b" data-match="${m.id}" data-round="${ri}" value="${d.b}" />`
        : `<span class="score">${m.scoreB ?? '–'}</span>`}
    </div>
    ${isAdmin && !done ? `<button class="btn-save" data-action="save-bracket-score" data-match="${m.id}" data-round="${ri}">
      ${savedFlash === m.id ? 'Salvo ✓' : 'Salvar placar'}
    </button>` : ''}
  </div>`;
}

function renderPinModal() {
  return `
  <div class="modal-bg" data-action="close-pin-bg">
    <div class="modal" data-action="stop-bubble">
      <div class="modal-title">Entrar como admin</div>
      <input id="pin-input" type="password" placeholder="PIN" autofocus />
      <div id="pin-error" class="pin-error"></div>
      <div class="modal-actions">
        <button data-action="close-pin">Cancelar</button>
        <button class="btn-primary" data-action="try-unlock">Entrar</button>
      </div>
      <div class="hint" style="margin-top:8px">PIN padrão: 2026 (troque em Configuração)</div>
    </div>
  </div>`;
}

function bindEvents() {
  root.querySelectorAll('[data-action]').forEach((el) => {
    const action = el.dataset.action;
    if (action === 'rename') el.addEventListener('change', () => persist({ ...state, name: el.value }));
    if (action === 'toggle-admin') {
      el.addEventListener('click', () => {
        if (isAdmin) { isAdmin = false; localStorage.removeItem('hitpadel_admin'); render(); }
        else { document.getElementById('pin-modal-slot').innerHTML = renderPinModal(); bindPinModal(); }
      });
    }
    if (action === 'toggle-setup') el.addEventListener('click', () => { setupOpen = !setupOpen; render(); });
    if (action === 'set-tipo') el.addEventListener('click', () => setTipoHandler(el.dataset.tipo));
    if (action === 'remove-player') el.addEventListener('click', () => persist({ ...state, players: state.players.filter((p) => p.id !== el.dataset.id) }));
    if (action === 'add-player') el.addEventListener('click', addPlayerHandler);
    if (action === 'remove-team') el.addEventListener('click', () => persist({ ...state, teams: state.teams.filter((t) => t.id !== el.dataset.id) }));
    if (action === 'add-team') el.addEventListener('click', addTeamHandler);
    if (action === 'set-courts') el.addEventListener('change', () => persist({ ...state, numCourts: Math.max(1, Number(el.value) || 1) }));
    if (action === 'set-rounds') el.addEventListener('change', () => persist({ ...state, numRounds: Math.max(1, Math.min(30, Number(el.value) || 1)) }));
    if (action === 'set-pin') el.addEventListener('change', () => persist({ ...state, adminPin: el.value }));
    if (action === 'sortear') el.addEventListener('click', sortearHandler);
    if (action === 'gerar-chave') el.addEventListener('click', gerarChaveHandler);
    if (action === 'gerar-final') el.addEventListener('click', gerarFinalHandler);
    if (action === 'tab') el.addEventListener('click', () => { tab = el.dataset.tab; render(); });
    if (action === 'score-a' || action === 'score-b') {
      el.addEventListener('input', () => {
        const id = el.dataset.match;
        const cur = drafts[id] || { a: '', b: '' };
        drafts[id] = { ...cur, [action === 'score-a' ? 'a' : 'b']: el.value };
      });
    }
    if (action === 'bscore-a' || action === 'bscore-b') {
      el.addEventListener('input', () => {
        const id = el.dataset.match;
        const cur = drafts[id] || { a: '', b: '' };
        drafts[id] = { ...cur, [action === 'bscore-a' ? 'a' : 'b']: el.value };
      });
    }
    if (action === 'save-score') el.addEventListener('click', () => saveScoreHandler(el.dataset.match, Number(el.dataset.round)));
    if (action === 'save-bracket-score') el.addEventListener('click', () => saveBracketScoreHandler(el.dataset.match, Number(el.dataset.round)));
  });
  const newPlayerInput = document.getElementById('new-player');
  if (newPlayerInput) newPlayerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPlayerHandler(); });
  const newTeamInput = document.getElementById('new-team');
  if (newTeamInput) newTeamInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTeamHandler(); });
}

function bindPinModal() {
  const bg = document.querySelector('[data-action="close-pin-bg"]');
  bg?.addEventListener('click', closePinModal);
  document.querySelector('[data-action="stop-bubble"]')?.addEventListener('click', (e) => e.stopPropagation());
  document.querySelector('[data-action="close-pin"]')?.addEventListener('click', closePinModal);
  document.querySelector('[data-action="try-unlock"]')?.addEventListener('click', tryUnlock);
  document.getElementById('pin-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
}
function closePinModal() { document.getElementById('pin-modal-slot').innerHTML = ''; }
function tryUnlock() {
  const val = document.getElementById('pin-input').value;
  if (val === state.adminPin) {
    isAdmin = true; localStorage.setItem('hitpadel_admin', 'true'); closePinModal(); render();
  } else {
    document.getElementById('pin-error').textContent = 'PIN incorreto';
  }
}

function setTipoHandler(tipo) {
  if (tipo === state.tipo) return;
  const temDados = state.rounds.length > 0 || state.bracket.length > 0;
  if (temDados && !confirm('Trocar o tipo de torneio vai apagar o sorteio/chave atual. Continuar?')) return;
  persist({ ...state, tipo, rounds: [], bracket: [] });
}

function addPlayerHandler() {
  const input = document.getElementById('new-player');
  const name = input.value.trim();
  if (!name) return;
  persist({ ...state, players: [...state.players, { id: uid(), name }] });
}

function addTeamHandler() {
  const input = document.getElementById('new-team');
  const name = input.value.trim();
  if (!name) return;
  persist({ ...state, teams: [...state.teams, { id: uid(), name }] });
}

function sortearHandler() {
  if (state.players.length < 4) return;
  if (state.rounds.length && !confirm('Isso vai gerar um novo sorteio e apagar os placares atuais. Continuar?')) return;
  const maxCourts = Math.max(1, Math.floor(state.players.length / 4));
  const rounds = generateSchedule(state.players, Math.min(state.numCourts, maxCourts), state.numRounds);
  persist({ ...state, rounds });
  tab = 'rodadas';
}

function gerarChaveHandler() {
  if (state.teams.length < 2) return;
  if (state.bracket.length && !confirm('Isso vai gerar uma nova chave e apagar os resultados atuais. Continuar?')) return;
  const bracket = generateBracket(state.teams);
  persist({ ...state, bracket });
}

function gerarFinalHandler() {
  if (state.rounds.some((r) => r.isFinal)) return;
  const finalRound = generateFinalRound(state.players, state.rounds);
  persist({ ...state, rounds: [...state.rounds, finalRound] });
}

function saveScoreHandler(matchId, roundIdx) {
  const d = drafts[matchId];
  if (!d || d.a === '' || d.b === '' || d.a === undefined || d.b === undefined) return;
  const rounds = state.rounds.map((rd, i) => {
    if (i !== roundIdx) return rd;
    return { ...rd, matches: rd.matches.map((m) => m.id === matchId ? { ...m, scoreA: Number(d.a), scoreB: Number(d.b) } : m) };
  });
  persist({ ...state, rounds });
  savedFlash = matchId;
  render();
  setTimeout(() => { savedFlash = null; render(); }, 1500);
}

function saveBracketScoreHandler(matchId, roundIdx) {
  const d = drafts[matchId];
  if (!d || d.a === '' || d.b === '' || d.a === undefined || d.b === undefined) return;
  const a = Number(d.a), b = Number(d.b);
  if (a === b) { alert('Não pode empatar numa eliminatória — ajuste o placar.'); return; }
  const bracket = state.bracket.map((rd) => rd.map((m) => ({ ...m })));
  const m = bracket[roundIdx].find((mm) => mm.id === matchId);
  m.scoreA = a; m.scoreB = b;
  m.winner = a > b ? m.teamA : m.teamB;
  propagateWinner(bracket, roundIdx, bracket[roundIdx].indexOf(m), m.winner);
  persist({ ...state, bracket });
  savedFlash = matchId;
  render();
  setTimeout(() => { savedFlash = null; render(); }, 1500);
}

render();
