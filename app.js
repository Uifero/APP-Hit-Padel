import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, onValue, set, get } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const tRef = ref(db, 'tournament');

const uid = () => Math.random().toString(36).slice(2, 9);
const pairKey = (a, b) => [a, b].sort().join('~');
const DEFAULT_CAT = '_default';
const CATEGORIA_SUGESTOES = ['Cat Iniciante', '7ª Cat', '6ª Cat', '5ª Cat', '4ª Cat', 'Soma 9', 'Soma 11', 'Soma 13', 'Masculina', 'Feminina', 'Mista'];

function defaultState() {
  return {
    name: 'Hit Padel',
    adminPin: '2026',
    tipo: 'americano', // 'americano' | 'mini' | 'chaves'
    categorias: [],
    players: [],
    teams: [],
    numCourts: 2,
    numRounds: 5,
    rounds: {},        // { [categoria]: [ {round, byes, matches} ] }
    grupos: [],         // [ { id, nome, categoria, teamIds, matches } ]
    eliminatorias: {},  // { [categoria]: [ [match,...], [match,...] ] }
  };
}

function categoriaOf(entity) { return entity.categoria || DEFAULT_CAT; }
function categoriaKeys(state) { return state.categorias.length ? state.categorias : [DEFAULT_CAT]; }

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
  const options = [{ teamA: [a, b], teamB: [c, d] }, { teamA: [a, c], teamB: [b, d] }, { teamA: [a, d], teamB: [b, c] }];
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
    if (numBye > 0) { for (let i = 0; i < numBye; i++) byeIds.push(players[(cursor + i) % n].id); cursor = (cursor + numBye) % n; }
    const active = players.filter((p) => !byeIds.includes(p.id));
    let bestGroups = null, bestScore = Infinity;
    for (let attempt = 0; attempt < 180; attempt++) {
      const shuffled = [...active].sort(() => Math.random() - 0.5);
      const groups = [];
      for (let i = 0; i + 3 < shuffled.length; i += 4) groups.push(bestPairing(shuffled.slice(i, i + 4).map((p) => p.id), history));
      const s = groups.reduce((acc, g) => acc + scoreGroup(g, history), 0);
      if (s < bestScore) { bestScore = s; bestGroups = groups; }
    }
    if (!bestGroups) bestGroups = [];
    bestGroups.forEach((g) => {
      const pA = pairKey(g.teamA[0], g.teamA[1]), pB = pairKey(g.teamB[0], g.teamB[1]);
      history.partner[pA] = (history.partner[pA] || 0) + 1;
      history.partner[pB] = (history.partner[pB] || 0) + 1;
      g.teamA.forEach((x) => g.teamB.forEach((y) => { const k = pairKey(x, y); history.opponent[k] = (history.opponent[k] || 0) + 1; }));
    });
    rounds.push({ round: r + 1, byes: byeIds, matches: bestGroups.map((g, idx) => ({ id: uid(), court: idx + 1, teamA: g.teamA, teamB: g.teamB, scoreA: null, scoreB: null })) });
  }
  return rounds;
}

// Desempate Americano: pontos (sets) -> vitórias -> confronto direto
function computeStats(players, rounds) {
  const stats = {};
  players.forEach((p) => { stats[p.id] = { id: p.id, name: p.name, partidas: 0, vitorias: 0, derrotas: 0, gf: 0, gc: 0 }; });
  rounds.forEach((rd) => rd.matches.forEach((m) => {
    if (m.scoreA == null || m.scoreB == null) return;
    [[m.teamA, m.scoreA, m.scoreB], [m.teamB, m.scoreB, m.scoreA]].forEach(([team, gf, gc]) => {
      team.forEach((pid) => { const s = stats[pid]; if (!s) return; s.partidas++; s.gf += gf; s.gc += gc; if (gf > gc) s.vitorias++; else if (gf < gc) s.derrotas++; });
    });
  }));
  const list = Object.values(stats).map((s) => ({ ...s, saldo: s.gf - s.gc, pontos: s.gf }));
  list.sort((a, b) => b.pontos - a.pontos || b.vitorias - a.vitorias);
  const clusters = []; let i = 0;
  while (i < list.length) { let j = i + 1; while (j < list.length && list[j].pontos === list[i].pontos && list[j].vitorias === list[i].vitorias) j++; clusters.push(list.slice(i, j)); i = j; }
  const final = [];
  clusters.forEach((cluster) => {
    if (cluster.length <= 1) { final.push(...cluster); return; }
    const ids = new Set(cluster.map((p) => p.id));
    const withH2H = cluster.map((p) => ({ ...p, h2h: 0 }));
    withH2H.forEach((p) => {
      rounds.forEach((rd) => rd.matches.forEach((m) => {
        if (m.scoreA == null || m.scoreB == null) return;
        const inA = m.teamA.includes(p.id), inB = m.teamB.includes(p.id);
        if (!inA && !inB) return;
        const oppTeam = inA ? m.teamB : m.teamA;
        if (!oppTeam.some((oid) => ids.has(oid))) return;
        const won = inA ? m.scoreA > m.scoreB : m.scoreB > m.scoreA;
        if (won) p.h2h++;
      }));
    });
    withH2H.sort((a, b) => b.h2h - a.h2h || b.saldo - a.saldo);
    final.push(...withH2H);
  });
  return final;
}
function minRoundsForFullCoverage(numPlayers, numCourts) {
  if (numPlayers < 4) return 0;
  const totalPairs = (numPlayers * (numPlayers - 1)) / 2;
  return Math.ceil(totalPairs / (numCourts * 2));
}
function roundsWithoutScores(rounds) { return rounds.some((rd) => rd.matches.some((m) => m.scoreA == null || m.scoreB == null)); }
function generateFinalRound(players, rounds) {
  const stats = computeStats(players, rounds);
  const top4 = stats.slice(0, 4);
  return { round: rounds.length + 1, isFinal: true, byes: [], matches: [{ id: uid(), court: 1, teamA: [top4[0].id, top4[3].id], teamB: [top4[1].id, top4[2].id], scoreA: null, scoreB: null }] };
}

// ---------- fase de grupos (chaves de 2 ou 3 duplas) + eliminatória ----------
function shuffleArr(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function generateGroups(teams, categoria) {
  const n = teams.length;
  const numGroups = Math.max(1, Math.ceil(n / 3));
  const shuffled = shuffleArr(teams);
  const groups = Array.from({ length: numGroups }, (_, i) => ({ id: uid(), nome: `Grupo ${String.fromCharCode(65 + i)}`, categoria, teamIds: [], matches: [] }));
  shuffled.forEach((t, i) => groups[i % numGroups].teamIds.push(t.id));
  groups.forEach((g) => {
    for (let i = 0; i < g.teamIds.length; i++) for (let j = i + 1; j < g.teamIds.length; j++)
      g.matches.push({ id: uid(), teamA: g.teamIds[i], teamB: g.teamIds[j], scoreA: null, scoreB: null });
  });
  return groups;
}
// Desempate de grupo: vitórias -> saldo de sets -> confronto direto
function computeGroupStandings(group) {
  const stats = {};
  group.teamIds.forEach((id) => { stats[id] = { id, vitorias: 0, derrotas: 0, saldo: 0 }; });
  group.matches.forEach((m) => {
    if (m.scoreA == null || m.scoreB == null) return;
    const diff = m.scoreA - m.scoreB;
    if (diff > 0) { stats[m.teamA].vitorias++; stats[m.teamB].derrotas++; } else { stats[m.teamB].vitorias++; stats[m.teamA].derrotas++; }
    stats[m.teamA].saldo += diff; stats[m.teamB].saldo += -diff;
  });
  let list = Object.values(stats);
  list.sort((a, b) => b.vitorias - a.vitorias || b.saldo - a.saldo);
  const clusters = []; let i = 0;
  while (i < list.length) { let j = i + 1; while (j < list.length && list[j].vitorias === list[i].vitorias && list[j].saldo === list[i].saldo) j++; clusters.push(list.slice(i, j)); i = j; }
  const final = [];
  clusters.forEach((cluster) => {
    if (cluster.length <= 1) { final.push(...cluster); return; }
    const ids = new Set(cluster.map((p) => p.id));
    const withH2H = cluster.map((p) => ({ ...p, h2h: 0 }));
    withH2H.forEach((p) => {
      group.matches.forEach((m) => {
        if (m.scoreA == null || m.scoreB == null) return;
        const inA = m.teamA === p.id, inB = m.teamB === p.id;
        if (!inA && !inB) return;
        const oppId = inA ? m.teamB : m.teamA;
        if (!ids.has(oppId)) return;
        const won = inA ? m.scoreA > m.scoreB : m.scoreB > m.scoreA;
        if (won) p.h2h++;
      });
    });
    withH2H.sort((a, b) => b.h2h - a.h2h || b.saldo - a.saldo);
    final.push(...withH2H);
  });
  return final;
}
function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }
function roundName(matchCount) {
  const map = { 1: 'Final', 2: 'Semifinal', 4: 'Quartas de final', 8: 'Oitavas de final', 16: '16-avos de final', 32: '32-avos de final' };
  return map[matchCount] || `Rodada (${matchCount * 2} duplas)`;
}
function seedOrder(size) {
  if (size === 1) return [1];
  const prev = seedOrder(size / 2);
  const result = [];
  prev.forEach((s) => { result.push(s); result.push(size + 1 - s); });
  return result;
}
function repairSameGroupClashes(round1, groupOf) {
  for (let i = 0; i < round1.length; i++) {
    const m = round1[i];
    if (m.isBye || !m.teamB) continue;
    if (groupOf[m.teamA] !== groupOf[m.teamB]) continue;
    for (let j = 0; j < round1.length; j++) {
      if (j === i) continue;
      const other = round1[j];
      if (other.isBye || !other.teamB) continue;
      if (groupOf[m.teamA] !== groupOf[other.teamB] && groupOf[other.teamA] !== groupOf[m.teamB]) {
        const tmp = m.teamB; m.teamB = other.teamB; other.teamB = tmp; break;
      }
    }
  }
}
function propagateWinner(bracket, roundIdx, matchIdx, winnerId) {
  if (roundIdx + 1 < bracket.length) {
    const next = bracket[roundIdx + 1][Math.floor(matchIdx / 2)];
    if (matchIdx % 2 === 0) next.teamA = winnerId; else next.teamB = winnerId;
  }
}
function generateEliminationFromGroups(groups) {
  const groupOf = {};
  groups.forEach((g) => g.teamIds.forEach((id) => { groupOf[id] = g.id; }));
  const standingsByGroup = groups.map((g) => computeGroupStandings(g));
  const primeiros = standingsByGroup.map((s) => s[0]).filter(Boolean);
  const segundos = standingsByGroup.map((s) => s[1]).filter(Boolean);
  const qualifiers = [...primeiros, ...segundos];
  const n = qualifiers.length;
  const size = nextPow2(Math.max(n, 2));
  const order = seedOrder(size);
  const round1 = [];
  for (let i = 0; i < order.length; i += 2) {
    const seedA = order[i], seedB = order[i + 1];
    const teamA = seedA <= n ? qualifiers[seedA - 1].id : null;
    const teamB = seedB <= n ? qualifiers[seedB - 1].id : null;
    if (teamA && !teamB) round1.push({ id: uid(), teamA, teamB: null, scoreA: null, scoreB: null, winner: teamA, isBye: true });
    else if (!teamA && teamB) round1.push({ id: uid(), teamA: teamB, teamB: null, scoreA: null, scoreB: null, winner: teamB, isBye: true });
    else round1.push({ id: uid(), teamA, teamB, scoreA: null, scoreB: null, winner: null, isBye: false });
  }
  repairSameGroupClashes(round1, groupOf);
  const bracket = [round1];
  let mc = round1.length;
  while (mc > 1) { mc /= 2; bracket.push(Array.from({ length: mc }, () => ({ id: uid(), teamA: null, teamB: null, scoreA: null, scoreB: null, winner: null }))); }
  round1.forEach((m, i) => { if (m.isBye) propagateWinner(bracket, 0, i, m.winner); });
  return bracket;
}
function allGroupMatchesScored(groups) { return groups.every((g) => g.matches.every((m) => m.scoreA != null && m.scoreB != null)); }

// ---------- estado local / UI ----------
let state = null;
let isAdmin = localStorage.getItem('hitpadel_admin') === 'true';
let tab = 'rodadas';
let setupOpen = true;
let drafts = {};
let savedFlash = null;
let selectedCategoria = null;

const root = document.getElementById('root');

async function persist(next) {
  state = next; render();
  try { await set(tRef, next); } catch (e) { console.error('Falha ao salvar', e); }
}
onValue(tRef, (snap) => {
  if (snap.exists()) { state = { ...defaultState(), ...snap.val() }; } else { state = defaultState(); set(tRef, state); }
  render();
});
get(tRef).then((snap) => { if (!snap.exists()) set(tRef, defaultState()); });

function nameOf(id) { return state.players.find((p) => p.id === id)?.name || '?'; }
function teamNameOf(id) { return state.teams.find((t) => t.id === id)?.name || (id ? '?' : 'aguardando'); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function catLabel(k) { return k === DEFAULT_CAT ? '' : k; }

function currentCategoria() {
  const keys = categoriaKeys(state);
  if (!selectedCategoria || !keys.includes(selectedCategoria)) selectedCategoria = keys[0];
  return selectedCategoria;
}

function render() {
  if (!state) { root.innerHTML = '<div class="loading">Carregando quadra...</div>'; return; }
  const isChaves = state.tipo === 'chaves';
  const catKeys = categoriaKeys(state);
  const catKey = currentCategoria();
  const showSetup = isAdmin || (state.players.length === 0 && state.teams.length === 0);

  const catPlayers = state.players.filter((p) => categoriaOf(p) === catKey);
  const catTeams = state.teams.filter((t) => categoriaOf(t) === catKey);
  const catRounds = state.rounds[catKey] || [];
  const catGroups = state.grupos.filter((g) => g.categoria === catKey);
  const catElim = state.eliminatorias[catKey] || [];
  const stats = computeStats(catPlayers, catRounds);
  const maxCourts = Math.max(1, Math.floor(catPlayers.length / 4)) || 1;

  root.innerHTML = `
    <header class="hp-header">
      <div class="hp-header-inner">
        <div class="hp-brand">
          <img class="hp-logo" src="./logo.png" alt="Hit Padel Tuparendi" />
          <div>
            ${isAdmin ? `<input class="hp-name-input" data-action="rename" value="${esc(state.name)}" />` : `<div class="hp-name">${esc(state.name)}</div>`}
            <div class="hp-live"><span class="dot"></span> ao vivo</div>
          </div>
        </div>
        <button class="hp-admin-btn ${isAdmin ? 'on' : ''}" data-action="toggle-admin">${isAdmin ? 'Admin' : 'Ver como admin'}</button>
      </div>
    </header>
    <main class="hp-main">
      ${showSetup ? renderSetup(maxCourts) : ''}
      ${catKeys.length > 1 ? renderCategoriaTabs(catKeys, catKey) : ''}
      ${isChaves ? renderGroupsAndElimination(catGroups, catElim, catTeams) : renderAmericanoView(catRounds, stats, catPlayers)}
    </main>
    <div id="pin-modal-slot"></div>
    <footer class="hp-footer">atualiza automaticamente</footer>
  `;
  bindEvents();
}

function renderCategoriaTabs(catKeys, current) {
  return `<div class="tabs cat-tabs">
    ${catKeys.map((k) => `<button class="tab ${k === current ? 'active' : ''}" data-action="sel-cat" data-cat="${esc(k)}">${esc(catLabel(k) || 'Geral')}</button>`).join('')}
  </div>`;
}

function renderAmericanoView(catRounds, stats, catPlayers) {
  if (!catRounds.length) return '';
  const podeGerarFinal = state.tipo === 'mini' && !catRounds.some((r) => r.isFinal) && catRounds.length > 0 && !roundsWithoutScores(catRounds) && catPlayers.length >= 4;
  return `
    <div class="tabs">
      <button class="tab ${tab === 'rodadas' ? 'active' : ''}" data-action="tab" data-tab="rodadas">Rodadas</button>
      <button class="tab ${tab === 'ranking' ? 'active' : ''}" data-action="tab" data-tab="ranking">Ranking</button>
    </div>
    ${isAdmin && podeGerarFinal ? `<button class="btn-primary" style="margin-bottom:14px" data-action="gerar-final">🏆 Gerar final (top 4)</button>` : ''}
    ${tab === 'rodadas' ? renderRounds(catRounds) : ''}
    ${tab === 'ranking' ? renderRanking(stats) : ''}
  `;
}

function renderSetup(maxCourts) {
  const catKey = currentCategoria();
  const catPlayers = state.players.filter((p) => categoriaOf(p) === catKey);
  const minRounds = minRoundsForFullCoverage(catPlayers.length, Math.min(state.numCourts, maxCourts));
  return `
  <section class="card">
    <button class="card-head" data-action="toggle-setup"><span>Configuração</span><span>${setupOpen ? '▲' : '▼'}</span></button>
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
            ${state.tipo === 'americano' ? 'Duplas rotativas, todo mundo joga com e contra todo mundo o máximo possível. Ranking individual (desempate: pontos → vitórias → confronto direto).' : ''}
            ${state.tipo === 'mini' ? 'Igual ao Americano, mas ao final você gera uma grande final com as 4 melhores colocadas.' : ''}
            ${state.tipo === 'chaves' ? 'Duplas fixas em grupos de 2 ou 3 (todas contra todas dentro do grupo). As 2 melhores de cada grupo avançam pra eliminatória (oitavas/quartas/semi/final). Desempate de grupo: vitórias → saldo de sets → confronto direto.' : ''}
          </div>
        </div>

        ${renderCategoriasSetup()}
        ${state.tipo === 'chaves' ? renderTeamsSetup() : renderPlayersSetup(maxCourts, minRounds)}

        <div class="field"><label>PIN de admin</label><input id="admin-pin" value="${esc(state.adminPin)}" data-action="set-pin" /></div>

        ${state.tipo === 'chaves' ? `
          <button class="btn-primary" data-action="gerar-grupos">Gerar grupos</button>
          <div class="hint">Cadastre pelo menos 2 duplas por categoria</div>
        ` : `
          <button class="btn-primary" data-action="sortear">Sortear rodadas</button>
          <div class="hint">Cadastre pelo menos 4 jogadoras por categoria</div>
        `}
      ` : `<div class="hint">O torneio ainda não foi configurado. Peça para o organizador entrar como admin.</div>`}
    </div>` : ''}
  </section>`;
}

function renderCategoriasSetup() {
  const faltando = CATEGORIA_SUGESTOES.filter((s) => !state.categorias.includes(s));
  return `
    <div class="field">
      <label>Categorias (opcional — deixe vazio se for só 1 categoria)</label>
      <div class="chips">
        ${state.categorias.map((c) => `<span class="chip">${esc(c)} <button data-action="remove-cat" data-cat="${esc(c)}">×</button></span>`).join('')}
      </div>
      <div class="row"><input id="new-cat" placeholder="Nome da categoria" /><button data-action="add-cat">+</button></div>
      ${faltando.length ? `<div class="cat-suggestions">${faltando.map((s) => `<button class="sugg-chip" data-action="add-cat-sugg" data-cat="${esc(s)}">+ ${esc(s)}</button>`).join('')}</div>` : ''}
    </div>`;
}

function renderPlayersSetup(maxCourts, minRounds) {
  const showCatSelect = state.categorias.length > 0;
  return `
    <div class="field">
      <label>Jogadoras (${state.players.length})</label>
      <div class="chips">
        ${state.players.map((p) => `<span class="chip">${esc(p.name)}${p.categoria ? ` <em>(${esc(p.categoria)})</em>` : ''} <button data-action="remove-player" data-id="${p.id}">×</button></span>`).join('')}
      </div>
      <div class="row">
        <input id="new-player" placeholder="Nome da jogadora" />
        ${showCatSelect ? `<select id="new-player-cat">${state.categorias.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>` : ''}
        <button data-action="add-player">+</button>
      </div>
    </div>
    <div class="row2">
      <div class="field"><label>Quadras (máx ${maxCourts})</label><input type="number" min="1" max="${maxCourts}" id="num-courts" value="${state.numCourts}" data-action="set-courts" /></div>
      <div class="field"><label>Rodadas</label><input type="number" min="1" max="30" id="num-rounds" value="${state.numRounds}" data-action="set-rounds" /></div>
    </div>
    ${minRounds > 0 ? `<div class="hint" style="text-align:left">Com ${state.players.filter((p) => categoriaOf(p) === currentCategoria()).length} jogadoras (categoria atual) e ${Math.min(state.numCourts, maxCourts)} quadra(s), seriam necessárias <b>~${minRounds} rodadas</b> pra cobertura total.</div>` : ''}
  `;
}

function renderTeamsSetup() {
  const showCatSelect = state.categorias.length > 0;
  return `
    <div class="field">
      <label>Duplas (${state.teams.length})</label>
      <div class="chips">
        ${state.teams.map((t) => `<span class="chip">${esc(t.name)}${t.categoria ? ` <em>(${esc(t.categoria)})</em>` : ''} <button data-action="remove-team" data-id="${t.id}">×</button></span>`).join('')}
      </div>
      <div class="row">
        <input id="new-team" placeholder="Ex: Ana & Bruna" />
        ${showCatSelect ? `<select id="new-team-cat">${state.categorias.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>` : ''}
        <button data-action="add-team">+</button>
      </div>
    </div>`;
}

function renderRounds(catRounds) {
  return `<div class="rounds">
    ${catRounds.map((rd, ri) => `
      <div class="round-block ${rd.isFinal ? 'is-final' : ''}">
        <div class="round-title"><span>${rd.isFinal ? '🏆 GRANDE FINAL' : `Rodada ${rd.round}`}</span>${rd.byes && rd.byes.length ? `<span class="bye">folga: ${rd.byes.map(nameOf).map(esc).join(', ')}</span>` : ''}</div>
        <div class="matches">${rd.matches.map((m) => renderMatch(m, ri)).join('')}</div>
      </div>`).join('')}
  </div>`;
}
function renderMatch(m, ri) {
  const d = drafts[m.id] || { a: m.scoreA ?? '', b: m.scoreB ?? '' };
  const done = m.scoreA != null && m.scoreB != null;
  return `
  <div class="match">
    <div class="match-head"><span class="court-tag">QUADRA ${m.court}</span>${done ? '<span class="check">✓</span>' : ''}</div>
    <div class="team-row">
      <span class="team-name">${m.teamA.map(nameOf).map(esc).join(' + ')}</span>
      ${isAdmin ? `<input type="number" min="0" class="score-input" data-action="score-a" data-match="${m.id}" value="${d.a}" />` : `<span class="score">${m.scoreA ?? '–'}</span>`}
    </div>
    <div class="vs">×</div>
    <div class="team-row">
      <span class="team-name">${m.teamB.map(nameOf).map(esc).join(' + ')}</span>
      ${isAdmin ? `<input type="number" min="0" class="score-input" data-action="score-b" data-match="${m.id}" value="${d.b}" />` : `<span class="score">${m.scoreB ?? '–'}</span>`}
    </div>
    ${isAdmin ? `<button class="btn-save" data-action="save-score" data-match="${m.id}">${savedFlash === m.id ? 'Salvo ✓' : 'Salvar placar'}</button>` : ''}
  </div>`;
}
function renderRanking(stats) {
  if (!stats.length) return `<div class="card-body hint">Nenhum resultado lançado ainda.</div>`;
  return `<table class="ranking"><thead><tr><th>#</th><th>Jogadora</th><th>J</th><th>V</th><th>SG</th><th>Pts</th></tr></thead><tbody>
    ${stats.map((s, i) => `<tr><td class="${i < 3 ? 'top' : ''}">${i + 1}</td><td>${esc(s.name)}</td><td class="c">${s.partidas}</td><td class="c">${s.vitorias}</td><td class="c">${s.saldo > 0 ? '+' + s.saldo : s.saldo}</td><td class="pts">${s.pontos}</td></tr>`).join('')}
  </tbody></table>`;
}

// ---------- grupos + eliminatória (Chaves) ----------
function renderGroupsAndElimination(catGroups, catElim, catTeams) {
  if (!catGroups.length) return '';
  const podeGerarElim = isAdmin && catElim.length === 0 && allGroupMatchesScored(catGroups);
  return `
    <div class="groups-wrap">
      ${catGroups.map((g) => renderGroupCard(g)).join('')}
    </div>
    ${podeGerarElim ? `<button class="btn-primary" style="margin:14px 0" data-action="gerar-eliminatoria" data-cat="${esc(catGroups[0].categoria)}">Gerar fase eliminatória</button>` : ''}
    ${catElim.length ? renderEliminationView(catElim) : ''}
  `;
}
function renderGroupCard(g) {
  const standings = computeGroupStandings(g);
  return `
  <div class="round-block">
    <div class="round-title"><span>${esc(g.nome)}</span></div>
    <table class="ranking" style="margin-bottom:10px">
      <thead><tr><th>#</th><th>Dupla</th><th>V</th><th>D</th><th>Saldo</th></tr></thead>
      <tbody>${standings.map((s, i) => `<tr><td class="${i < 2 ? 'top' : ''}">${i + 1}</td><td>${esc(teamNameOf(s.id))}</td><td class="c">${s.vitorias}</td><td class="c">${s.derrotas}</td><td class="c">${s.saldo > 0 ? '+' + s.saldo : s.saldo}</td></tr>`).join('')}</tbody>
    </table>
    <div class="matches">${g.matches.map((m) => renderGroupMatch(m)).join('')}</div>
  </div>`;
}
function renderGroupMatch(m) {
  const d = drafts[m.id] || { a: m.scoreA ?? '', b: m.scoreB ?? '' };
  const done = m.scoreA != null && m.scoreB != null;
  return `
  <div class="match">
    <div class="match-head"><span></span>${done ? '<span class="check">✓</span>' : ''}</div>
    <div class="team-row"><span class="team-name">${esc(teamNameOf(m.teamA))}</span>
      ${isAdmin && !done ? `<input type="number" min="0" class="score-input" data-action="gscore-a" data-match="${m.id}" value="${d.a}" />` : `<span class="score">${m.scoreA ?? '–'}</span>`}</div>
    <div class="vs">×</div>
    <div class="team-row"><span class="team-name">${esc(teamNameOf(m.teamB))}</span>
      ${isAdmin && !done ? `<input type="number" min="0" class="score-input" data-action="gscore-b" data-match="${m.id}" value="${d.b}" />` : `<span class="score">${m.scoreB ?? '–'}</span>`}</div>
    ${isAdmin && !done ? `<button class="btn-save" data-action="save-group-score" data-match="${m.id}">${savedFlash === m.id ? 'Salvo ✓' : 'Salvar placar'}</button>` : ''}
  </div>`;
}
function renderEliminationView(catElim) {
  const champion = catElim[catElim.length - 1][0]?.winner;
  return `<div class="rounds">
    ${champion ? `<div class="champion-banner">🏆 Campeã: ${esc(teamNameOf(champion))}</div>` : ''}
    ${catElim.map((rd) => `<div class="round-block"><div class="round-title"><span>${roundName(rd.length)}</span></div><div class="matches">${rd.map((m) => renderBracketMatch(m)).join('')}</div></div>`).join('')}
  </div>`;
}
function renderBracketMatch(m) {
  if (m.isBye) return `<div class="match bye-match"><span class="team-name">${esc(teamNameOf(m.teamA))}</span><span class="bye-tag">passou direto</span></div>`;
  if (m.teamA == null || m.teamB == null) return `<div class="match pending-match">${esc(teamNameOf(m.teamA))} <span class="vs">×</span> ${esc(teamNameOf(m.teamB))} <span class="hint">(aguardando fase anterior)</span></div>`;
  const d = drafts[m.id] || { a: m.scoreA ?? '', b: m.scoreB ?? '' };
  const done = m.winner != null;
  return `
  <div class="match ${done ? 'decided' : ''}">
    <div class="team-row ${m.winner === m.teamA ? 'winner' : ''}"><span class="team-name">${esc(teamNameOf(m.teamA))}</span>
      ${isAdmin && !done ? `<input type="number" min="0" class="score-input" data-action="bscore-a" data-match="${m.id}" value="${d.a}" />` : `<span class="score">${m.scoreA ?? '–'}</span>`}</div>
    <div class="vs">×</div>
    <div class="team-row ${m.winner === m.teamB ? 'winner' : ''}"><span class="team-name">${esc(teamNameOf(m.teamB))}</span>
      ${isAdmin && !done ? `<input type="number" min="0" class="score-input" data-action="bscore-b" data-match="${m.id}" value="${d.b}" />` : `<span class="score">${m.scoreB ?? '–'}</span>`}</div>
    ${isAdmin && !done ? `<button class="btn-save" data-action="save-bracket-score" data-match="${m.id}">${savedFlash === m.id ? 'Salvo ✓' : 'Salvar placar'}</button>` : ''}
  </div>`;
}

function renderPinModal() {
  return `<div class="modal-bg" data-action="close-pin-bg"><div class="modal" data-action="stop-bubble">
    <div class="modal-title">Entrar como admin</div>
    <input id="pin-input" type="password" placeholder="PIN" autofocus />
    <div id="pin-error" class="pin-error"></div>
    <div class="modal-actions"><button data-action="close-pin">Cancelar</button><button class="btn-primary" data-action="try-unlock">Entrar</button></div>
    <div class="hint" style="margin-top:8px">PIN padrão: 2026 (troque em Configuração)</div>
  </div></div>`;
}

function bindEvents() {
  root.querySelectorAll('[data-action]').forEach((el) => {
    const action = el.dataset.action;
    if (action === 'rename') el.addEventListener('change', () => persist({ ...state, name: el.value }));
    if (action === 'toggle-admin') el.addEventListener('click', () => {
      if (isAdmin) { isAdmin = false; localStorage.removeItem('hitpadel_admin'); render(); }
      else { document.getElementById('pin-modal-slot').innerHTML = renderPinModal(); bindPinModal(); }
    });
    if (action === 'toggle-setup') el.addEventListener('click', () => { setupOpen = !setupOpen; render(); });
    if (action === 'set-tipo') el.addEventListener('click', () => setTipoHandler(el.dataset.tipo));
    if (action === 'sel-cat') el.addEventListener('click', () => { selectedCategoria = el.dataset.cat; tab = 'rodadas'; render(); });
    if (action === 'add-cat') el.addEventListener('click', addCategoriaHandler);
    if (action === 'add-cat-sugg') el.addEventListener('click', () => addCategoria(el.dataset.cat));
    if (action === 'remove-cat') el.addEventListener('click', () => removeCategoriaHandler(el.dataset.cat));
    if (action === 'remove-player') el.addEventListener('click', () => persist({ ...state, players: state.players.filter((p) => p.id !== el.dataset.id) }));
    if (action === 'add-player') el.addEventListener('click', addPlayerHandler);
    if (action === 'remove-team') el.addEventListener('click', () => persist({ ...state, teams: state.teams.filter((t) => t.id !== el.dataset.id) }));
    if (action === 'add-team') el.addEventListener('click', addTeamHandler);
    if (action === 'set-courts') el.addEventListener('change', () => persist({ ...state, numCourts: Math.max(1, Number(el.value) || 1) }));
    if (action === 'set-rounds') el.addEventListener('change', () => persist({ ...state, numRounds: Math.max(1, Math.min(30, Number(el.value) || 1)) }));
    if (action === 'set-pin') el.addEventListener('change', () => persist({ ...state, adminPin: el.value }));
    if (action === 'sortear') el.addEventListener('click', sortearHandler);
    if (action === 'gerar-grupos') el.addEventListener('click', gerarGruposHandler);
    if (action === 'gerar-eliminatoria') el.addEventListener('click', () => gerarEliminatoriaHandler(currentCategoria()));
    if (action === 'gerar-final') el.addEventListener('click', gerarFinalHandler);
    if (action === 'tab') el.addEventListener('click', () => { tab = el.dataset.tab; render(); });
    if (['score-a', 'score-b', 'gscore-a', 'gscore-b', 'bscore-a', 'bscore-b'].includes(action)) {
      el.addEventListener('input', () => {
        const id = el.dataset.match;
        const cur = drafts[id] || { a: '', b: '' };
        const key = action.endsWith('-a') ? 'a' : 'b';
        drafts[id] = { ...cur, [key]: el.value };
      });
    }
    if (action === 'save-score') el.addEventListener('click', () => saveScoreHandler(el.dataset.match));
    if (action === 'save-group-score') el.addEventListener('click', () => saveGroupScoreHandler(el.dataset.match));
    if (action === 'save-bracket-score') el.addEventListener('click', () => saveBracketScoreHandler(el.dataset.match));
  });
  const newPlayerInput = document.getElementById('new-player');
  if (newPlayerInput) newPlayerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPlayerHandler(); });
  const newTeamInput = document.getElementById('new-team');
  if (newTeamInput) newTeamInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTeamHandler(); });
  const newCatInput = document.getElementById('new-cat');
  if (newCatInput) newCatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCategoriaHandler(); });
}

function bindPinModal() {
  document.querySelector('[data-action="close-pin-bg"]')?.addEventListener('click', closePinModal);
  document.querySelector('[data-action="stop-bubble"]')?.addEventListener('click', (e) => e.stopPropagation());
  document.querySelector('[data-action="close-pin"]')?.addEventListener('click', closePinModal);
  document.querySelector('[data-action="try-unlock"]')?.addEventListener('click', tryUnlock);
  document.getElementById('pin-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
}
function closePinModal() { document.getElementById('pin-modal-slot').innerHTML = ''; }
function tryUnlock() {
  const val = document.getElementById('pin-input').value;
  if (val === state.adminPin) { isAdmin = true; localStorage.setItem('hitpadel_admin', 'true'); closePinModal(); render(); }
  else document.getElementById('pin-error').textContent = 'PIN incorreto';
}

function setTipoHandler(tipo) {
  if (tipo === state.tipo) return;
  const temDados = Object.values(state.rounds).some((r) => r.length) || state.grupos.length;
  if (temDados && !confirm('Trocar o tipo de torneio vai apagar o sorteio/grupos atuais. Continuar?')) return;
  persist({ ...state, tipo, rounds: {}, grupos: [], eliminatorias: {} });
}
function addCategoria(name) {
  name = name.trim();
  if (!name || state.categorias.includes(name)) return;
  persist({ ...state, categorias: [...state.categorias, name] });
}
function addCategoriaHandler() {
  const input = document.getElementById('new-cat');
  addCategoria(input.value);
}
function removeCategoriaHandler(cat) {
  if (!confirm(`Remover a categoria "${cat}"? Jogadoras/duplas cadastradas nela continuam, mas sem categoria.`)) return;
  persist({ ...state, categorias: state.categorias.filter((c) => c !== cat) });
}
function addPlayerHandler() {
  const input = document.getElementById('new-player');
  const name = input.value.trim();
  if (!name) return;
  const catSelect = document.getElementById('new-player-cat');
  const categoria = catSelect ? catSelect.value : '';
  persist({ ...state, players: [...state.players, { id: uid(), name, categoria }] });
}
function addTeamHandler() {
  const input = document.getElementById('new-team');
  const name = input.value.trim();
  if (!name) return;
  const catSelect = document.getElementById('new-team-cat');
  const categoria = catSelect ? catSelect.value : '';
  persist({ ...state, teams: [...state.teams, { id: uid(), name, categoria }] });
}
function sortearHandler() {
  const newRounds = { ...state.rounds };
  let algumaGerada = false;
  categoriaKeys(state).forEach((catKey) => {
    const catPlayers = state.players.filter((p) => categoriaOf(p) === catKey);
    if (catPlayers.length < 4) return;
    const maxCourts = Math.max(1, Math.floor(catPlayers.length / 4));
    newRounds[catKey] = generateSchedule(catPlayers, Math.min(state.numCourts, maxCourts), state.numRounds);
    algumaGerada = true;
  });
  if (!algumaGerada) return;
  const temDadosAntes = Object.values(state.rounds).some((r) => r.length);
  if (temDadosAntes && !confirm('Isso vai gerar um novo sorteio e apagar os placares atuais. Continuar?')) return;
  persist({ ...state, rounds: newRounds });
  tab = 'rodadas';
}
function gerarGruposHandler() {
  const temDadosAntes = state.grupos.length > 0;
  if (temDadosAntes && !confirm('Isso vai gerar novos grupos e apagar os resultados atuais. Continuar?')) return;
  let novosGrupos = [];
  categoriaKeys(state).forEach((catKey) => {
    const catTeams = state.teams.filter((t) => categoriaOf(t) === catKey);
    if (catTeams.length < 2) return;
    novosGrupos = novosGrupos.concat(generateGroups(catTeams, catKey));
  });
  if (!novosGrupos.length) return;
  persist({ ...state, grupos: novosGrupos, eliminatorias: {} });
}
function gerarEliminatoriaHandler(catKey) {
  const catGroups = state.grupos.filter((g) => g.categoria === catKey);
  if (!catGroups.length || !allGroupMatchesScored(catGroups)) return;
  const bracket = generateEliminationFromGroups(catGroups);
  persist({ ...state, eliminatorias: { ...state.eliminatorias, [catKey]: bracket } });
}
function gerarFinalHandler() {
  const catKey = currentCategoria();
  const catRounds = state.rounds[catKey] || [];
  const catPlayers = state.players.filter((p) => categoriaOf(p) === catKey);
  if (catRounds.some((r) => r.isFinal)) return;
  const finalRound = generateFinalRound(catPlayers, catRounds);
  persist({ ...state, rounds: { ...state.rounds, [catKey]: [...catRounds, finalRound] } });
}
function saveScoreHandler(matchId) {
  const d = drafts[matchId];
  if (!d || d.a === '' || d.b === '') return;
  const newRounds = { ...state.rounds };
  Object.keys(newRounds).forEach((catKey) => {
    newRounds[catKey] = newRounds[catKey].map((rd) => ({ ...rd, matches: rd.matches.map((m) => m.id === matchId ? { ...m, scoreA: Number(d.a), scoreB: Number(d.b) } : m) }));
  });
  persist({ ...state, rounds: newRounds });
  savedFlash = matchId; render();
  setTimeout(() => { savedFlash = null; render(); }, 1500);
}
function saveGroupScoreHandler(matchId) {
  const d = drafts[matchId];
  if (!d || d.a === '' || d.b === '') return;
  const a = Number(d.a), b = Number(d.b);
  if (a === b) { alert('Não pode empatar — ajuste o placar.'); return; }
  const grupos = state.grupos.map((g) => ({ ...g, matches: g.matches.map((m) => m.id === matchId ? { ...m, scoreA: a, scoreB: b } : m) }));
  persist({ ...state, grupos });
  savedFlash = matchId; render();
  setTimeout(() => { savedFlash = null; render(); }, 1500);
}
function saveBracketScoreHandler(matchId) {
  const d = drafts[matchId];
  if (!d || d.a === '' || d.b === '') return;
  const a = Number(d.a), b = Number(d.b);
  if (a === b) { alert('Não pode empatar numa eliminatória — ajuste o placar.'); return; }
  const eliminatorias = {};
  Object.keys(state.eliminatorias).forEach((catKey) => {
    const bracket = state.eliminatorias[catKey].map((rd) => rd.map((m) => ({ ...m })));
    bracket.forEach((rd, ri) => {
      const idx = rd.findIndex((m) => m.id === matchId);
      if (idx === -1) return;
      const m = rd[idx];
      m.scoreA = a; m.scoreB = b; m.winner = a > b ? m.teamA : m.teamB;
      propagateWinner(bracket, ri, idx, m.winner);
    });
    eliminatorias[catKey] = bracket;
  });
  persist({ ...state, eliminatorias });
  savedFlash = matchId; render();
  setTimeout(() => { savedFlash = null; render(); }, 1500);
}

render();
