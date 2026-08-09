import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, onValue, set, get } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
const torneiosRef = ref(db, 'torneios');
const ADMIN_EMAIL_DOMAIN = '@hitpadel.local';

const uid = () => Math.random().toString(36).slice(2, 9);
const pairKey = (a, b) => [a, b].sort().join('~');
const DEFAULT_CAT = '_default';
const CATEGORIA_SUGESTOES = ['Cat Iniciante', '7ª Cat', '6ª Cat', '5ª Cat', '4ª Cat', 'Soma 9', 'Soma 11', 'Soma 13', 'Masculina', 'Feminina', 'Mista'];

function defaultState() {
  return {
    name: 'Hit Padel',
    tipo: 'americano', // 'americano' | 'mini' | 'chaves'
    categorias: [],
    players: [],
    teams: [],
    numCourts: 2,
    numRounds: 5,
    rounds: {},        // { [categoria]: [ {round, byes, matches} ] }
    grupos: [],         // [ { id, nome, categoria, teamIds, matches } ]
    eliminatorias: {},  // { [categoria]: [ [match,...], [match,...] ] }
    inscricoesAbertas: false,
    visivelPublico: false,
    dataInicio: '',
    dataFim: '',
    nomesQuadras: ['Quadra 01', 'Quadra 02'],
    agendamentos: {},   // { [matchId]: { data, hora } }
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
  const groups = Array.from({ length: numGroups }, (_, i) => ({ id: uid(), nome: `Chave ${String.fromCharCode(65 + i)}`, categoria, teamIds: [], matches: [] }));
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
let isAdmin = false;
let tab = 'rodadas';
let setupOpen = true;
let drafts = {};
let savedFlash = null;
let editingMatches = new Set();
let selectedCategoria = null;
let jogosFiltroData = 'todas';
let pubSignupFlash = null;
let currentTournamentId = null;
let torneiosList = null;       // null = ainda carregando; {} ou {id: dados} depois
let unsubscribeTournament = null;
let painelAdmin = null;        // null = grade de módulos | 'config' | 'quadras' | 'inscricoes' | 'duplas' | 'chaveamento' | 'jogos'
let novoTorneioNome = '';

const root = document.getElementById('root');

async function persist(next) {
  state = next; render();
  if (!currentTournamentId) return;
  try { await set(ref(db, 'torneios/' + currentTournamentId), next); } catch (e) { console.error('Falha ao salvar', e); }
}

function getUrlTournamentId() {
  return new URLSearchParams(window.location.search).get('t');
}

function selecionarTorneio(id) {
  currentTournamentId = id;
  painelAdmin = null;
  tab = 'rodadas';
  selectedCategoria = null;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('t', id); else url.searchParams.delete('t');
  window.history.pushState({}, '', url);
  carregarTorneioAtual();
  render();
}

function carregarTorneioAtual() {
  if (unsubscribeTournament) { unsubscribeTournament(); unsubscribeTournament = null; }
  if (!currentTournamentId) { state = null; return; }
  const r = ref(db, 'torneios/' + currentTournamentId);
  unsubscribeTournament = onValue(r, (snap) => {
    if (snap.exists()) { state = { ...defaultState(), ...snap.val() }; }
    else { state = defaultState(); set(r, state); }
    render();
  });
}

async function criarNovoTorneio(nome) {
  const id = uid() + uid();
  const novo = { ...defaultState(), name: nome || 'Novo torneio' };
  try { await set(ref(db, 'torneios/' + id), novo); } catch (e) { console.error('Falha ao criar torneio', e); }
  selecionarTorneio(id);
}

let migracaoTentada = false;
async function migrarTorneioLegado() {
  if (migracaoTentada) return;
  migracaoTentada = true;
  if (torneiosList && Object.keys(torneiosList).length > 0) return; // já tem torneio(s), não precisa migrar
  try {
    const legadoSnap = await get(ref(db, 'tournament'));
    if (!legadoSnap.exists()) return;
    const legado = legadoSnap.val();
    if (!legado || (!legado.players?.length && !legado.teams?.length)) return;
    const id = uid() + uid();
    await set(ref(db, 'torneios/' + id), { ...defaultState(), ...legado });
    console.log('Torneio anterior migrado para o novo formato com sucesso:', id);
  } catch (e) { console.error('Falha ao migrar torneio antigo', e); }
}

onValue(torneiosRef, (snap) => {
  torneiosList = snap.val() || {};
  migrarTorneioLegado();
  render();
});

onAuthStateChanged(auth, (user) => {
  isAdmin = !!user;
  render();
});

currentTournamentId = getUrlTournamentId();
if (currentTournamentId) carregarTorneioAtual();
window.addEventListener('popstate', () => {
  currentTournamentId = getUrlTournamentId();
  carregarTorneioAtual();
  render();
});

function nameOf(id) { return state.players.find((p) => p.id === id)?.name || '?'; }
function teamNameOf(id) { return state.teams.find((t) => t.id === id)?.name || (id ? '?' : 'aguardando'); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function catLabel(k) { return k === DEFAULT_CAT ? '' : k; }

function currentCategoria() {
  const keys = categoriaKeys(state);
  if (!selectedCategoria || !keys.includes(selectedCategoria)) selectedCategoria = keys[0];
  return selectedCategoria;
}

function formatData(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}`;
}
function formatDataRange(state) {
  if (!state.dataInicio && !state.dataFim) return '';
  if (state.dataInicio && state.dataFim && state.dataInicio !== state.dataFim) return `📅 ${formatData(state.dataInicio)} a ${formatData(state.dataFim)}`;
  return `📅 ${formatData(state.dataInicio || state.dataFim)}`;
}

function render() {
  if (!currentTournamentId) { renderLobby(); return; }
  if (!state) { root.innerHTML = '<div class="loading">Carregando quadra...</div>'; return; }
  const isChaves = state.tipo === 'chaves';
  const catKeys = categoriaKeys(state);
  const catKey = currentCategoria();
  const showSetup = isAdmin;
  const dataRangeTxt = formatDataRange(state);

  const catPlayers = state.players.filter((p) => categoriaOf(p) === catKey);
  const catTeams = state.teams.filter((t) => categoriaOf(t) === catKey);
  const catRounds = state.rounds[catKey] || [];
  const catGroups = state.grupos.filter((g) => g.categoria === catKey);
  const catElim = state.eliminatorias[catKey] || [];
  const stats = computeStats(catPlayers, catRounds);
  const maxCourts = Math.max(1, Math.floor(catPlayers.length / 4)) || 1;
  const ocultoDoPublico = !isAdmin && !state.visivelPublico;

  root.innerHTML = `
    <header class="hp-header">
      <div class="hp-header-inner">
        <div class="hp-brand">
          <img class="hp-logo" src="./logo.png" alt="Hit Padel Tuparendi" />
          <div>
            ${isAdmin ? `<input class="hp-name-input" data-action="rename" value="${esc(state.name)}" />` : `<div class="hp-name">${esc(state.name)}</div>`}
            <div class="hp-live">${dataRangeTxt ? `<span>${esc(dataRangeTxt)}</span> · ` : ''}<span class="dot"></span> ao vivo</div>
          </div>
        </div>
        <div class="hp-header-actions">
          <button class="hp-back-btn" data-action="voltar-lobby">◀ Meus torneios</button>
          <button class="hp-admin-btn ${isAdmin ? 'on' : ''}" data-action="toggle-admin">${isAdmin ? 'Admin' : 'Ver como admin'}</button>
        </div>
      </div>
    </header>
    <main class="hp-main">
      ${isAdmin ? renderAdminDashboard(maxCourts, catPlayers, catTeams) : ''}
      ${ocultoDoPublico ? '<div class="hint" style="margin-top:16px">Este torneio ainda não está disponível pra visualização pública.</div>' : `
      ${catKeys.length > 1 ? renderCategoriaTabs(catKeys, catKey) : ''}
      ${renderInscricaoPublica()}
      ${!isAdmin ? renderInscritosPublico(catKey) : ''}
      ${(catRounds.length || catGroups.length) ? renderBuscaAtleta() : ''}
      ${isChaves ? renderGroupsAndElimination(catGroups, catElim, catTeams, catKey) : renderAmericanoView(catRounds, stats, catPlayers, catKey)}
      `}
    </main>
    <div id="pin-modal-slot"></div>
    <footer class="hp-footer">atualiza automaticamente</footer>
  `;
  bindEvents();
}

function renderLobby() {
  const dataRangeTxtLobby = '';
  const lista = torneiosList ? Object.entries(torneiosList).map(([id, t]) => ({ id, ...t })) : null;
  const meus = lista || [];
  const publicados = meus.filter((t) => t.visivelPublico);
  const listaParaMostrar = isAdmin ? meus : publicados;
  root.innerHTML = `
    <header class="hp-header">
      <div class="hp-header-inner">
        <div class="hp-brand">
          <img class="hp-logo" src="./logo.png" alt="Hit Padel Tuparendi" />
          <div><div class="hp-name">HIT PADEL</div><div class="hp-live"><span class="dot"></span> ao vivo</div></div>
        </div>
        <button class="hp-admin-btn ${isAdmin ? 'on' : ''}" data-action="toggle-admin">${isAdmin ? 'Admin' : 'Ver como admin'}</button>
      </div>
    </header>
    <main class="hp-main">
      <div class="round-title" style="margin-top:16px"><span>${isAdmin ? 'Meus torneios' : 'Torneios em andamento'}</span></div>
      ${lista === null ? '<div class="hint">Carregando...</div>' : ''}
      ${lista !== null && listaParaMostrar.length === 0 ? `<div class="hint">${isAdmin ? 'Nenhum torneio criado ainda.' : 'Nenhum torneio publicado no momento.'}</div>` : ''}
      <div class="groups-wrap">
        ${listaParaMostrar.map((t) => `
          <div class="round-block torneio-card" data-action="abrir-torneio" data-id="${t.id}">
            <div class="round-title"><span>${esc(t.name || 'Torneio sem nome')}</span>${isAdmin ? `<span class="badge-${t.visivelPublico ? 'ok' : 'pending'}">${t.visivelPublico ? '✓ publicado' : '⏳ rascunho'}</span>` : ''}</div>
            <div class="hint" style="text-align:left">${formatDataRange(t) || 'Data não definida'} · ${t.tipo === 'chaves' ? 'Torneio (chaves)' : t.tipo === 'mini' ? 'Americano + Final' : 'Americano'}</div>
            ${isAdmin ? `<button class="mode-btn" style="margin-top:8px" data-action="publicar-torneio" data-id="${t.id}" data-atual="${t.visivelPublico ? '1' : '0'}">${t.visivelPublico ? 'Despublicar' : 'Publicar torneio'}</button>` : ''}
          </div>
        `).join('')}
      </div>
      ${isAdmin ? `
      <div class="card" style="margin-top:20px">
        <div class="card-head-static">+ Criar novo torneio</div>
        <div class="card-body">
          <div class="field"><input id="novo-torneio-nome" placeholder="Nome do torneio" /></div>
          <button class="btn-primary" data-action="criar-torneio">Criar e abrir</button>
        </div>
      </div>` : ''}
    </main>
    <div id="pin-modal-slot"></div>
    <footer class="hp-footer">atualiza automaticamente</footer>
  `;
  bindEvents();
}

function renderInscricaoPublica() {
  if (isAdmin || !state.inscricoesAbertas) return '';
  const catKey = currentCategoria();
  const catLabelTxt = state.categorias.length ? ` — ${esc(catLabel(catKey) || 'Geral')}` : '';
  const flashMsg = pubSignupFlash ? `<div class="signup-ok">${esc(pubSignupFlash)}</div>` : '';
  if (state.tipo === 'chaves') {
    return `
    <section class="card signup-card">
      <div class="card-body">
        <div class="field">
          <label>📝 Inscreva sua dupla${catLabelTxt}</label>
          <input id="pub-team-name" placeholder="Ex: Ana & Bruna" style="margin-bottom:8px" />
          <div class="row"><input id="pub-team-phone" type="tel" placeholder="Telefone (whatsapp)" /><button data-action="pub-add-team">Inscrever</button></div>
          ${flashMsg}
        </div>
      </div>
    </section>`;
  }
  return `
    <section class="card signup-card">
      <div class="card-body">
        <div class="field">
          <label>📝 Inscreva-se${catLabelTxt}</label>
          <input id="pub-player-name" placeholder="Seu nome" style="margin-bottom:8px" />
          <div class="row"><input id="pub-player-phone" type="tel" placeholder="Telefone (whatsapp)" /><button data-action="pub-add-player">Inscrever</button></div>
          ${flashMsg}
        </div>
      </div>
    </section>`;
}

function renderInscritosPublico(catKey) {
  const list = state.tipo === 'chaves' ? state.teams : state.players;
  const catList = list.filter((x) => categoriaOf(x) === catKey && !x.oculto);
  if (!catList.length) return '';
  return `
    <section class="card">
      <div class="card-head-static">👥 Inscritas (${catList.length})</div>
      <div class="card-body">
        <div class="chips">
          ${catList.map((x) => `<span class="chip">${esc(x.name)} ${x.confirmada ? '<span class="badge-ok">✓ confirmada</span>' : '<span class="badge-pending">⏳ pendente</span>'}</span>`).join('')}
        </div>
      </div>
    </section>`;
}
function renderBuscaAtleta() {
  return `<div class="field search-field"><input id="busca-atleta" placeholder="🔍 Buscar por atleta ou dupla..." /></div>`;
}
function renderCategoriaTabs(catKeys, current) {
  return `<div class="tabs cat-tabs">
    ${catKeys.map((k) => `<button class="tab ${k === current ? 'active' : ''}" data-action="sel-cat" data-cat="${esc(k)}">${esc(catLabel(k) || 'Geral')}</button>`).join('')}
  </div>`;
}

function renderAmericanoView(catRounds, stats, catPlayers, catKey) {
  if (!catRounds.length) return '';
  const podeGerarFinal = state.tipo === 'mini' && !catRounds.some((r) => r.isFinal) && catRounds.length > 0 && !roundsWithoutScores(catRounds) && catPlayers.length >= 4;
  return `
    <div class="tabs">
      <button class="tab ${tab === 'rodadas' ? 'active' : ''}" data-action="tab" data-tab="rodadas">Rodadas</button>
      <button class="tab ${tab === 'ranking' ? 'active' : ''}" data-action="tab" data-tab="ranking">Ranking</button>
      <button class="tab ${tab === 'jogos' ? 'active' : ''}" data-action="tab" data-tab="jogos">Jogos</button>
    </div>
    ${isAdmin && podeGerarFinal ? `<button class="btn-primary" style="margin-bottom:14px" data-action="gerar-final">🏆 Gerar final (top 4)</button>` : ''}
    ${tab === 'rodadas' ? renderRounds(catRounds) : ''}
    ${tab === 'ranking' ? renderRanking(stats) : ''}
    ${tab === 'jogos' ? renderJogosView(catKey) : ''}
  `;
}

function renderAdminDashboard(maxCourts, catPlayers, catTeams) {
  if (painelAdmin) return renderPainelModulo(painelAdmin, maxCourts, catPlayers, catTeams);
  const catKey = currentCategoria();
  const totalConfirmadas = state.tipo === 'chaves'
    ? state.teams.filter((t) => categoriaOf(t) === catKey && t.confirmada).length
    : catPlayers.filter((p) => p.confirmada).length;
  const rodadasGeradas = (state.rounds[catKey] || []).length;
  const gruposGerados = state.grupos.filter((g) => g.categoria === catKey).length;
  const tipoLabel = state.tipo === 'chaves' ? 'Torneio' : state.tipo === 'mini' ? 'Americano + Final' : 'Americano';
  return `
  <section class="card">
    <div class="card-head-static">📋 Painel de gestão</div>
    <div class="card-body">
      <div class="dash-grid">
        <button class="dash-card" data-action="abrir-painel" data-painel="config">
          <div class="dash-title">Configurações</div>
          <div class="dash-sub">${esc(tipoLabel)}${state.categorias.length ? ` · ${state.categorias.length} categoria(s)` : ''}</div>
        </button>
        <button class="dash-card" data-action="abrir-painel" data-painel="quadras">
          <div class="dash-title">Quadras e Rodadas</div>
          <div class="dash-sub">${state.numCourts} quadra(s) · ${state.numRounds} rodada(s)</div>
        </button>
        <button class="dash-card" data-action="abrir-painel" data-painel="inscricoes">
          <div class="dash-title">Inscrições</div>
          <div class="dash-sub">${state.tipo === 'chaves' ? state.teams.length : state.players.length} no total</div>
        </button>
        <button class="dash-card" data-action="abrir-painel" data-painel="duplas">
          <div class="dash-title">Duplas</div>
          <div class="dash-sub">${totalConfirmadas} confirmada(s)</div>
        </button>
        <button class="dash-card" data-action="abrir-painel" data-painel="chaveamento">
          <div class="dash-title">Chaveamento</div>
          <div class="dash-sub">${state.tipo === 'chaves' ? `${gruposGerados} chave(s)` : `${rodadasGeradas} rodada(s)`}</div>
        </button>
        <button class="dash-card" data-action="ir-jogos">
          <div class="dash-title">Jogos</div>
          <div class="dash-sub">Ver e agendar horários</div>
        </button>
      </div>
    </div>
  </section>`;
}

function renderPainelModulo(painel, maxCourts, catPlayers, catTeams) {
  const minRounds = minRoundsForFullCoverage(catPlayers.length, Math.min(state.numCourts, maxCourts));
  const titulos = { config: 'Configurações', quadras: 'Quadras e Rodadas', inscricoes: 'Inscrições', duplas: 'Duplas', chaveamento: 'Chaveamento' };
  let content = '';
  if (painel === 'config') content = renderConfigModulo();
  else if (painel === 'quadras') content = renderQuadrasModulo(maxCourts);
  else if (painel === 'inscricoes') content = state.tipo === 'chaves' ? renderTeamsSetup() : renderPlayersSetup(minRounds);
  else if (painel === 'duplas') content = renderDuplasModulo(catTeams, catPlayers);
  else if (painel === 'chaveamento') content = renderChaveamentoModulo();
  return `
  <section class="card">
    <button class="card-head" data-action="fechar-painel"><span>← ${esc(titulos[painel] || 'Voltar')}</span><span>▲</span></button>
    <div class="card-body">${content}</div>
  </section>`;
}

function renderConfigModulo() {
  return `
    <div class="field">
      <label>Visibilidade pro público</label>
      <button class="mode-btn ${state.visivelPublico ? 'active' : ''}" data-action="toggle-visivel">${state.visivelPublico ? '✓ Visível (torneio postado)' : 'Oculto'}</button>
      <div class="hint" style="text-align:left;margin-top:4px">${state.visivelPublico ? 'Qualquer pessoa com o link já vê rodadas, chaves e ranking.' : 'Ninguém vê nada do torneio ainda. Ative quando quiser divulgar.'}</div>
    </div>
    <div class="row2">
      <div class="field"><label>Data de início</label><input type="date" id="data-inicio" value="${esc(state.dataInicio)}" data-action="set-data-inicio" /></div>
      <div class="field"><label>Data de término</label><input type="date" id="data-fim" value="${esc(state.dataFim)}" data-action="set-data-fim" /></div>
    </div>
    <div class="field">
      <label>Inscrições públicas</label>
      <button class="mode-btn ${state.inscricoesAbertas ? 'active' : ''}" data-action="toggle-inscricoes">${state.inscricoesAbertas ? '✓ Abertas' : 'Fechadas'}</button>
      <div class="hint" style="text-align:left;margin-top:4px">${state.inscricoesAbertas ? 'Qualquer pessoa com o link já pode se inscrever sozinha.' : 'Ninguém vê o formulário de inscrição ainda.'}</div>
    </div>
    <div class="field">
      <label>Tipo de torneio</label>
      <div class="mode-row">
        <button class="mode-btn ${state.tipo === 'americano' ? 'active' : ''}" data-action="set-tipo" data-tipo="americano">Americano</button>
        <button class="mode-btn ${state.tipo === 'mini' ? 'active' : ''}" data-action="set-tipo" data-tipo="mini">Americano + Final</button>
        <button class="mode-btn ${state.tipo === 'chaves' ? 'active' : ''}" data-action="set-tipo" data-tipo="chaves">Torneio</button>
      </div>
      <div class="hint" style="text-align:left;margin-top:4px">
        ${state.tipo === 'americano' ? 'Duplas rotativas, todo mundo joga com e contra todo mundo o máximo possível. Desempate: pontos → vitórias → confronto direto.' : ''}
        ${state.tipo === 'mini' ? 'Igual ao Americano, mas ao final você gera uma grande final com as 4 melhores colocadas.' : ''}
        ${state.tipo === 'chaves' ? 'Duplas fixas em chaves de 2 ou 3. As 2 melhores avançam pra eliminatória automaticamente. Desempate: vitórias → saldo de sets → confronto direto.' : ''}
      </div>
    </div>
    ${renderCategoriasSetup()}
    <div class="field"><label>Login de admin</label><div class="hint" style="text-align:left">Gerenciado no Firebase Authentication.</div></div>
  `;
}

function renderQuadrasModulo(maxCourts) {
  return `
    <div class="row2">
      <div class="field"><label>Quadras (máx ${maxCourts})</label><input type="number" min="1" max="${maxCourts}" id="num-courts" value="${state.numCourts}" data-action="set-courts" /></div>
      <div class="field"><label>Rodadas</label><input type="number" min="1" max="30" id="num-rounds" value="${state.numRounds}" data-action="set-rounds" /></div>
    </div>
    <div class="field">
      <label>Nome das quadras</label>
      <div class="row2">
        ${Array.from({ length: state.numCourts }, (_, i) => `<input class="court-name-input" data-action="set-court-name" data-idx="${i}" value="${esc(state.nomesQuadras[i] || `Quadra ${String(i + 1).padStart(2, '0')}`)}" />`).join('')}
      </div>
    </div>
  `;
}

function renderDuplasModulo(catTeams, catPlayers) {
  if (state.tipo === 'chaves') {
    const confirmadas = catTeams.filter((t) => t.confirmada && !t.oculto);
    if (!confirmadas.length) return `<div class="hint">Nenhuma dupla confirmada ainda nessa categoria.</div>`;
    return `<div class="chips">${confirmadas.map((t) => `<span class="chip">${esc(t.name)}</span>`).join('')}</div>`;
  }
  const confirmadas = catPlayers.filter((p) => p.confirmada && !p.oculto);
  if (!confirmadas.length) return `<div class="hint">Nenhuma jogadora confirmada ainda nessa categoria.</div>`;
  return `<div class="hint" style="text-align:left;margin-bottom:8px">Duplas se formam automaticamente no sorteio (Americano) — esta lista é só das jogadoras confirmadas.</div>
    <div class="chips">${confirmadas.map((p) => `<span class="chip">${esc(p.name)}</span>`).join('')}</div>`;
}

function renderChaveamentoModulo() {
  return state.tipo === 'chaves' ? `
    <button class="btn-primary" data-action="gerar-grupos">Gerar chaves</button>
    <div class="hint">Cadastre pelo menos 2 duplas por categoria em "Inscrições" primeiro.</div>
  ` : `
    <button class="btn-primary" data-action="sortear">Sortear rodadas</button>
    <div class="hint">Cadastre pelo menos 4 jogadoras por categoria em "Inscrições" primeiro.</div>
  `;
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

function renderPlayersSetup(minRounds) {
  const showCatSelect = state.categorias.length > 0;
  return `
    <div class="field">
      <label>Jogadoras (${state.players.length})</label>
      <div class="chips">
        ${state.players.map((p) => `<span class="chip ${p.oculto ? 'is-oculto' : ''}">${esc(p.name)}${p.categoria ? ` <em>(${esc(p.categoria)})</em>` : ''}${p.telefone ? ` <span class="tel">📞${esc(p.telefone)}</span>` : ''} <button class="conf-badge ${p.confirmada ? 'yes' : 'no'}" data-action="toggle-confirm-player" data-id="${p.id}" title="${p.confirmada ? 'Confirmada — clique pra marcar como pendente' : 'Pendente — clique pra confirmar'}">${p.confirmada ? '✓' : '⏳'}</button> <button class="vis-badge" data-action="toggle-oculto-player" data-id="${p.id}" title="${p.oculto ? 'Oculta do público — clique pra mostrar' : 'Visível ao público — clique pra ocultar'}">${p.oculto ? '🚫' : '👁'}</button> <button data-action="remove-player" data-id="${p.id}">×</button></span>`).join('')}
      </div>
      <div class="row">
        <input id="new-player" placeholder="Nome da jogadora" />
        ${showCatSelect ? `<select id="new-player-cat">${state.categorias.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>` : ''}
        <button data-action="add-player">+</button>
      </div>
    </div>
    ${minRounds > 0 ? `<div class="hint" style="text-align:left">Com ${state.players.filter((p) => categoriaOf(p) === currentCategoria()).length} jogadoras (categoria atual) e ${state.numCourts} quadra(s), seriam necessárias <b>~${minRounds} rodadas</b> pra cobertura total.</div>` : ''}
  `;
}

function renderTeamsSetup() {
  const showCatSelect = state.categorias.length > 0;
  return `
    <div class="field">
      <label>Duplas (${state.teams.length})</label>
      <div class="chips">
        ${state.teams.map((t) => `<span class="chip ${t.oculto ? 'is-oculto' : ''}">${esc(t.name)}${t.categoria ? ` <em>(${esc(t.categoria)})</em>` : ''}${t.telefone ? ` <span class="tel">📞${esc(t.telefone)}</span>` : ''} <button class="conf-badge ${t.confirmada ? 'yes' : 'no'}" data-action="toggle-confirm-team" data-id="${t.id}" title="${t.confirmada ? 'Confirmada — clique pra marcar como pendente' : 'Pendente — clique pra confirmar'}">${t.confirmada ? '✓' : '⏳'}</button> <button class="vis-badge" data-action="toggle-oculto-team" data-id="${t.id}" title="${t.oculto ? 'Oculta do público — clique pra mostrar' : 'Visível ao público — clique pra ocultar'}">${t.oculto ? '🚫' : '👁'}</button> <button data-action="remove-team" data-id="${t.id}">×</button></span>`).join('')}
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
function quadraNome(state, courtNum) {
  return state.nomesQuadras[courtNum - 1] || `Quadra ${String(courtNum).padStart(2, '0')}`;
}
function renderMatch(m, ri) {
  const d = drafts[m.id] || { a: m.scoreA ?? '', b: m.scoreB ?? '' };
  const done = m.scoreA != null && m.scoreB != null;
  const editing = editingMatches.has(m.id);
  const showInputs = isAdmin && (!done || editing);
  return `
  <div class="match">
    <div class="match-head"><span class="court-tag">${esc(quadraNome(state, m.court))}</span>${done && !editing ? '<span class="check">✓</span>' : ''}</div>
    <div class="team-row">
      <span class="team-name">${m.teamA.map(nameOf).map(esc).join(' + ')}</span>
      ${showInputs ? `<input type="number" min="0" class="score-input" data-action="score-a" data-match="${m.id}" value="${d.a}" />` : `<span class="score">${m.scoreA ?? '–'}</span>`}
    </div>
    <div class="vs">×</div>
    <div class="team-row">
      <span class="team-name">${m.teamB.map(nameOf).map(esc).join(' + ')}</span>
      ${showInputs ? `<input type="number" min="0" class="score-input" data-action="score-b" data-match="${m.id}" value="${d.b}" />` : `<span class="score">${m.scoreB ?? '–'}</span>`}
    </div>
    ${isAdmin && showInputs ? `<button class="btn-save" data-action="save-score" data-match="${m.id}">${done ? 'Salvar alteração' : 'Salvar placar'}</button>` : ''}
    ${isAdmin && done && !editing ? `<div class="saved-row"><span class="saved-tag">✓ Salvo</span><button class="btn-edit" data-action="edit-score" data-match="${m.id}">Editar</button></div>` : ''}
  </div>`;
}
function hasEmpate(list, keyFn) {
  const seen = new Set();
  for (const item of list) {
    const k = keyFn(item);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}
function renderRanking(stats) {
  if (!stats.length) return `<div class="card-body hint">Nenhum resultado lançado ainda.</div>`;
  const empatou = hasEmpate(stats, (s) => `${s.pontos}|${s.vitorias}`);
  return `<div class="table-scroll"><table class="ranking"><thead><tr><th>#</th><th>Jogadora</th><th>J</th><th>V</th><th>SS</th><th>SG</th><th>Pts</th></tr></thead><tbody>
    ${stats.map((s, i) => {
      const ss = s.vitorias - s.derrotas;
      return `<tr><td class="${i < 3 ? 'top' : ''}">${i + 1}</td><td>${esc(s.name)}</td><td class="c">${s.partidas}</td><td class="c">${s.vitorias}</td><td class="c">${ss > 0 ? '+' + ss : ss}</td><td class="c">${s.saldo > 0 ? '+' + s.saldo : s.saldo}</td><td class="pts">${s.pontos}</td></tr>`;
    }).join('')}
  </tbody></table></div>
  ${empatou ? `<div class="hint" style="margin-top:8px">Houve empate em pontos/vitórias — desempate aplicado: pontos → vitórias → confronto direto.</div>` : ''}`;
}

// ---------- grupos + eliminatória (Chaves) ----------
function renderGroupsAndElimination(catGroups, catElim, catTeams, catKey) {
  if (!catGroups.length) return '';
  return `
    <div class="tabs">
      <button class="tab ${tab === 'rodadas' ? 'active' : ''}" data-action="tab" data-tab="rodadas">Chaveamento</button>
      <button class="tab ${tab === 'jogos' ? 'active' : ''}" data-action="tab" data-tab="jogos">Jogos</button>
    </div>
    ${tab === 'jogos' ? renderJogosView(catKey) : `
    <div class="groups-wrap">
      ${catGroups.map((g) => renderGroupCard(g)).join('')}
    </div>
    ${catElim.length ? renderEliminationView(catElim) : (allGroupMatchesScored(catGroups) ? '' : `<div class="hint" style="margin-top:12px">A eliminatória é gerada automaticamente assim que todos os placares das chaves forem lançados.</div>`)}
    `}
  `;
}
function renderGroupCard(g) {
  const standings = computeGroupStandings(g);
  const empatou = hasEmpate(standings, (s) => `${s.vitorias}|${s.saldo}`);
  return `
  <div class="round-block">
    <div class="round-title"><span>${esc(g.nome)}</span></div>
    <div class="table-scroll">
    <table class="ranking" style="margin-bottom:10px">
      <thead><tr><th>#</th><th>Dupla</th><th>V</th><th>Saldo Sets</th><th>Saldo Games</th></tr></thead>
      <tbody>${standings.map((s, i) => {
        const ss = s.vitorias - s.derrotas;
        return `<tr><td class="${i < 2 ? 'top' : ''}">${i + 1}</td><td>${esc(teamNameOf(s.id))}</td><td class="c">${s.vitorias}</td><td class="c">${ss > 0 ? '+' + ss : ss}</td><td class="c">${s.saldo > 0 ? '+' + s.saldo : s.saldo}</td></tr>`;
      }).join('')}</tbody>
    </table>
    </div>
    ${empatou ? `<div class="hint" style="margin-bottom:8px">Houve empate em vitórias/saldo — desempate aplicado: vitórias → saldo de sets → confronto direto.</div>` : ''}
    <div class="matches">${g.matches.map((m) => renderGroupMatch(m)).join('')}</div>
  </div>`;
}
function renderGroupMatch(m) {
  const d = drafts[m.id] || { a: m.scoreA ?? '', b: m.scoreB ?? '' };
  const done = m.scoreA != null && m.scoreB != null;
  const editing = editingMatches.has(m.id);
  const showInputs = isAdmin && (!done || editing);
  return `
  <div class="match">
    <div class="match-head"><span></span>${done && !editing ? '<span class="check">✓</span>' : ''}</div>
    <div class="team-row"><span class="team-name">${esc(teamNameOf(m.teamA))}</span>
      ${showInputs ? `<input type="number" min="0" class="score-input" data-action="gscore-a" data-match="${m.id}" value="${d.a}" />` : `<span class="score">${m.scoreA ?? '–'}</span>`}</div>
    <div class="vs">×</div>
    <div class="team-row"><span class="team-name">${esc(teamNameOf(m.teamB))}</span>
      ${showInputs ? `<input type="number" min="0" class="score-input" data-action="gscore-b" data-match="${m.id}" value="${d.b}" />` : `<span class="score">${m.scoreB ?? '–'}</span>`}</div>
    ${isAdmin && showInputs ? `<button class="btn-save" data-action="save-group-score" data-match="${m.id}">${done ? 'Salvar alteração' : 'Salvar placar'}</button>` : ''}
    ${isAdmin && done && !editing ? `<div class="saved-row"><span class="saved-tag">✓ Salvo</span><button class="btn-edit" data-action="edit-score" data-match="${m.id}">Editar</button></div>` : ''}
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

function collectJogos(catKey) {
  const items = [];
  if (state.tipo === 'chaves') {
    state.grupos.filter((g) => g.categoria === catKey).forEach((g) => {
      g.matches.forEach((m) => items.push({ id: m.id, fase: g.nome, a: teamNameOf(m.teamA), b: teamNameOf(m.teamB), scoreA: m.scoreA, scoreB: m.scoreB }));
    });
    (state.eliminatorias[catKey] || []).forEach((rd) => {
      rd.forEach((m) => {
        if (m.isBye) return;
        items.push({ id: m.id, fase: roundName(rd.length), a: teamNameOf(m.teamA), b: teamNameOf(m.teamB), scoreA: m.scoreA, scoreB: m.scoreB });
      });
    });
  } else {
    (state.rounds[catKey] || []).forEach((rd) => {
      rd.matches.forEach((m) => items.push({ id: m.id, fase: rd.isFinal ? 'Final' : `Rodada ${rd.round}`, a: m.teamA.map(nameOf).join(' + '), b: m.teamB.map(nameOf).join(' + '), scoreA: m.scoreA, scoreB: m.scoreB, court: m.court }));
    });
  }
  return items.map((it) => {
    const ag = state.agendamentos[it.id] || {};
    return { ...it, data: ag.data || '', hora: ag.hora || '' };
  });
}

function renderJogosView(catKey) {
  const items = collectJogos(catKey);
  if (!items.length) return `<div class="hint" style="margin-top:12px">Nenhum jogo gerado ainda.</div>`;
  const semData = items.filter((i) => !i.data).length;
  const datasUnicas = [...new Set(items.filter((i) => i.data).map((i) => i.data))].sort();
  const filtered = jogosFiltroData === 'todas' ? items : items.filter((i) => i.data === jogosFiltroData);
  filtered.sort((x, y) => {
    const dx = x.data || '9999-99-99', dy = y.data || '9999-99-99';
    if (dx !== dy) return dx < dy ? -1 : 1;
    const hx = x.hora || '99:99', hy = y.hora || '99:99';
    return hx < hy ? -1 : hx > hy ? 1 : 0;
  });
  const grupos = [];
  filtered.forEach((it) => {
    const key = it.data || 'sem-data';
    let g = grupos.find((x) => x.key === key);
    if (!g) { g = { key, data: it.data, items: [] }; grupos.push(g); }
    g.items.push(it);
  });
  return `
    ${isAdmin && semData > 0 ? `
    <div class="card" style="margin-top:14px">
      <div class="card-head-static">🕐 Gerar horários automaticamente (${semData} jogo${semData > 1 ? 's' : ''} sem data)</div>
      <div class="card-body">
        <div class="field"><label>Data dos jogos</label><input type="date" id="auto-data" /></div>
        <div class="row2">
          <div class="field"><label>Horário de início (1º jogo)</label><input type="time" id="auto-hora-inicio" /></div>
          <div class="field"><label>Duração por jogo (min)</label><input type="number" min="1" id="auto-duracao" value="40" /></div>
        </div>
        <button class="btn-primary" data-action="gerar-horarios" data-cat="${esc(catKey)}">Gerar horários em sequência</button>
        <div class="hint" style="text-align:left">Jogos da mesma rodada/fase recebem o mesmo horário (jogam ao mesmo tempo); a próxima rodada/fase começa depois da duração informada. Só preenche jogos que ainda não têm data.</div>
      </div>
    </div>` : ''}
    ${datasUnicas.length ? `<div class="tabs cat-tabs">
      <button class="tab ${jogosFiltroData === 'todas' ? 'active' : ''}" data-action="jogos-filtro-data" data-data="todas">Todas</button>
      ${datasUnicas.map((d) => `<button class="tab ${jogosFiltroData === d ? 'active' : ''}" data-action="jogos-filtro-data" data-data="${d}">${formatData(d)}</button>`).join('')}
    </div>` : ''}
    <div class="rounds">
      ${grupos.map((g) => `
        <div class="round-block">
          <div class="round-title"><span>${g.data ? formatData(g.data) : 'Sem data definida'}</span></div>
          <div class="matches">${g.items.map((it) => renderJogoItem(it)).join('')}</div>
        </div>
      `).join('')}
    </div>
  `;
}
function renderJogoItem(it) {
  return `
  <div class="match">
    <div class="match-head"><span class="court-tag">${esc(it.fase)}</span>${it.hora ? `<span class="jogo-hora">🕐 ${esc(it.hora)}</span>` : ''}</div>
    <div class="team-row"><span class="team-name">${esc(it.a)}</span><span class="score">${it.scoreA ?? '–'}</span></div>
    <div class="vs">×</div>
    <div class="team-row"><span class="team-name">${esc(it.b)}</span><span class="score">${it.scoreB ?? '–'}</span></div>
    ${isAdmin ? `
      <div class="row" style="margin-top:8px">
        <input type="date" class="agendamento-data" data-match="${it.id}" value="${esc(it.data)}" />
        <input type="time" class="agendamento-hora" data-match="${it.id}" value="${esc(it.hora)}" />
      </div>
    ` : ''}
  </div>`;
}

function renderPinModal() {
  return `<div class="modal-bg" data-action="close-pin-bg"><div class="modal" data-action="stop-bubble">
    <div class="modal-title">Entrar como admin</div>
    <input id="login-user" placeholder="Usuário" autofocus style="margin-bottom:8px" />
    <div class="pass-wrap">
      <input id="login-pass" type="password" placeholder="Senha" />
      <button type="button" class="toggle-pass" data-action="toggle-pass" title="Mostrar senha">👁</button>
    </div>
    <div id="pin-error" class="pin-error"></div>
    <div class="modal-actions"><button data-action="close-pin">Cancelar</button><button class="btn-primary" data-action="try-unlock">Entrar</button></div>
  </div></div>`;
}

function bindEvents() {
  root.querySelectorAll('[data-action]').forEach((el) => {
    const action = el.dataset.action;
    if (action === 'rename') el.addEventListener('change', () => persist({ ...state, name: el.value }));
    if (action === 'toggle-admin') el.addEventListener('click', () => {
      if (isAdmin) { signOut(auth); }
      else { document.getElementById('pin-modal-slot').innerHTML = renderPinModal(); bindPinModal(); }
    });
    if (action === 'toggle-setup') el.addEventListener('click', () => { setupOpen = !setupOpen; render(); });
    if (action === 'abrir-painel') el.addEventListener('click', () => { painelAdmin = el.dataset.painel; render(); });
    if (action === 'fechar-painel') el.addEventListener('click', () => { painelAdmin = null; render(); });
    if (action === 'ir-jogos') el.addEventListener('click', () => { painelAdmin = null; tab = 'jogos'; render(); });
    if (action === 'voltar-lobby') el.addEventListener('click', () => selecionarTorneio(null));
    if (action === 'abrir-torneio') el.addEventListener('click', () => selecionarTorneio(el.dataset.id));
    if (action === 'publicar-torneio') el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = el.dataset.id;
      const novoValor = el.dataset.atual !== '1';
      try { await set(ref(db, 'torneios/' + id + '/visivelPublico'), novoValor); } catch (err) { console.error(err); }
    });
    if (action === 'criar-torneio') el.addEventListener('click', () => {
      const nome = document.getElementById('novo-torneio-nome').value.trim();
      criarNovoTorneio(nome);
    });
    if (action === 'set-tipo') el.addEventListener('click', () => setTipoHandler(el.dataset.tipo));
    if (action === 'toggle-inscricoes') el.addEventListener('click', () => persist({ ...state, inscricoesAbertas: !state.inscricoesAbertas }));
    if (action === 'toggle-visivel') el.addEventListener('click', () => persist({ ...state, visivelPublico: !state.visivelPublico }));
    if (action === 'set-data-inicio') el.addEventListener('change', () => persist({ ...state, dataInicio: el.value }));
    if (action === 'set-data-fim') el.addEventListener('change', () => persist({ ...state, dataFim: el.value }));
    if (action === 'sel-cat') el.addEventListener('click', () => { selectedCategoria = el.dataset.cat; tab = 'rodadas'; render(); });
    if (action === 'jogos-filtro-data') el.addEventListener('click', () => { jogosFiltroData = el.dataset.data; render(); });
    if (action === 'gerar-horarios') el.addEventListener('click', () => gerarHorariosHandler(el.dataset.cat));
    if (action === 'add-cat') el.addEventListener('click', addCategoriaHandler);
    if (action === 'add-cat-sugg') el.addEventListener('click', () => addCategoria(el.dataset.cat));
    if (action === 'remove-cat') el.addEventListener('click', () => removeCategoriaHandler(el.dataset.cat));
    if (action === 'remove-player') el.addEventListener('click', () => persist({ ...state, players: state.players.filter((p) => p.id !== el.dataset.id) }));
    if (action === 'toggle-confirm-player') el.addEventListener('click', () => toggleConfirmHandler('players', el.dataset.id));
    if (action === 'toggle-confirm-team') el.addEventListener('click', () => toggleConfirmHandler('teams', el.dataset.id));
    if (action === 'toggle-oculto-player') el.addEventListener('click', () => toggleOcultoHandler('players', el.dataset.id));
    if (action === 'toggle-oculto-team') el.addEventListener('click', () => toggleOcultoHandler('teams', el.dataset.id));
    if (action === 'add-player') el.addEventListener('click', addPlayerHandler);
    if (action === 'remove-team') el.addEventListener('click', () => persist({ ...state, teams: state.teams.filter((t) => t.id !== el.dataset.id) }));
    if (action === 'add-team') el.addEventListener('click', addTeamHandler);
    if (action === 'pub-add-player') el.addEventListener('click', pubAddPlayerHandler);
    if (action === 'pub-add-team') el.addEventListener('click', pubAddTeamHandler);
    if (action === 'set-courts') el.addEventListener('change', () => persist({ ...state, numCourts: Math.max(1, Number(el.value) || 1) }));
    if (action === 'set-court-name') el.addEventListener('change', () => {
      const idx = Number(el.dataset.idx);
      const nomes = [...state.nomesQuadras];
      while (nomes.length <= idx) nomes.push(`Quadra ${String(nomes.length + 1).padStart(2, '0')}`);
      nomes[idx] = el.value || `Quadra ${String(idx + 1).padStart(2, '0')}`;
      persist({ ...state, nomesQuadras: nomes });
    });
    if (action === 'set-rounds') el.addEventListener('change', () => persist({ ...state, numRounds: Math.max(1, Math.min(30, Number(el.value) || 1)) }));
    if (action === 'sortear') el.addEventListener('click', sortearHandler);
    if (action === 'gerar-grupos') el.addEventListener('click', gerarGruposHandler);
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
    if (action === 'edit-score') el.addEventListener('click', () => { editingMatches.add(el.dataset.match); render(); });
    if (action === 'save-group-score') el.addEventListener('click', () => saveGroupScoreHandler(el.dataset.match));
    if (action === 'save-bracket-score') el.addEventListener('click', () => saveBracketScoreHandler(el.dataset.match));
  });
  document.querySelectorAll('.agendamento-data, .agendamento-hora').forEach((el) => {
    el.addEventListener('change', () => {
      const matchId = el.dataset.match;
      const atual = state.agendamentos[matchId] || { data: '', hora: '' };
      const campo = el.classList.contains('agendamento-data') ? 'data' : 'hora';
      persist({ ...state, agendamentos: { ...state.agendamentos, [matchId]: { ...atual, [campo]: el.value } } });
    });
  });
  const newPlayerInput = document.getElementById('new-player');
  if (newPlayerInput) newPlayerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPlayerHandler(); });
  const newTeamInput = document.getElementById('new-team');
  if (newTeamInput) newTeamInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTeamHandler(); });
  const pubPlayerInput = document.getElementById('pub-player-name');
  if (pubPlayerInput) pubPlayerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pubAddPlayerHandler(); });
  const pubPlayerPhone = document.getElementById('pub-player-phone');
  if (pubPlayerPhone) pubPlayerPhone.addEventListener('keydown', (e) => { if (e.key === 'Enter') pubAddPlayerHandler(); });
  const pubTeamInput = document.getElementById('pub-team-name');
  if (pubTeamInput) pubTeamInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pubAddTeamHandler(); });
  const pubTeamPhone = document.getElementById('pub-team-phone');
  if (pubTeamPhone) pubTeamPhone.addEventListener('keydown', (e) => { if (e.key === 'Enter') pubAddTeamHandler(); });
  const buscaInput = document.getElementById('busca-atleta');
  if (buscaInput) buscaInput.addEventListener('input', () => {
    const termo = buscaInput.value.trim().toLowerCase();
    document.querySelectorAll('.round-block').forEach((block) => {
      let algumVisivel = false;
      block.querySelectorAll('.match').forEach((m) => {
        const show = !termo || m.textContent.toLowerCase().includes(termo);
        m.style.display = show ? '' : 'none';
        if (show) algumVisivel = true;
      });
      block.style.display = algumVisivel ? '' : 'none';
    });
  });
  const newCatInput = document.getElementById('new-cat');
  if (newCatInput) newCatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCategoriaHandler(); });
}

function bindPinModal() {
  document.querySelector('[data-action="close-pin-bg"]')?.addEventListener('click', closePinModal);
  document.querySelector('[data-action="stop-bubble"]')?.addEventListener('click', (e) => e.stopPropagation());
  document.querySelector('[data-action="close-pin"]')?.addEventListener('click', closePinModal);
  document.querySelector('[data-action="try-unlock"]')?.addEventListener('click', tryUnlock);
  document.getElementById('login-user')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  document.getElementById('login-pass')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  document.querySelector('[data-action="toggle-pass"]')?.addEventListener('click', (e) => {
    const input = document.getElementById('login-pass');
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    e.currentTarget.textContent = isHidden ? '🙈' : '👁';
    e.currentTarget.title = isHidden ? 'Ocultar senha' : 'Mostrar senha';
    input.focus();
  });
}
function closePinModal() { document.getElementById('pin-modal-slot').innerHTML = ''; }
async function tryUnlock() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const btn = document.querySelector('[data-action="try-unlock"]');
  if (btn) btn.textContent = 'Entrando...';
  try {
    await signInWithEmailAndPassword(auth, user.toLowerCase() + ADMIN_EMAIL_DOMAIN, pass);
    closePinModal();
  } catch (e) {
    const err = document.getElementById('pin-error');
    if (err) err.textContent = 'Usuário ou senha incorretos';
    if (btn) btn.textContent = 'Entrar';
  }
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
  persist({ ...state, players: [...state.players, { id: uid(), name, categoria, confirmada: true, oculto: false }] });
}
function addTeamHandler() {
  const input = document.getElementById('new-team');
  const name = input.value.trim();
  if (!name) return;
  const catSelect = document.getElementById('new-team-cat');
  const categoria = catSelect ? catSelect.value : '';
  persist({ ...state, teams: [...state.teams, { id: uid(), name, categoria, confirmada: true, oculto: false }] });
}
function pubAddPlayerHandler() {
  const nameInput = document.getElementById('pub-player-name');
  const phoneInput = document.getElementById('pub-player-phone');
  const name = nameInput.value.trim();
  const telefone = phoneInput.value.trim();
  if (!name || !telefone) { alert('Preencha nome e telefone pra se inscrever.'); return; }
  const catKey = currentCategoria();
  const categoria = catKey === DEFAULT_CAT ? '' : catKey;
  persist({ ...state, players: [...state.players, { id: uid(), name, telefone, categoria, confirmada: false, oculto: false }] });
  nameInput.value = ''; phoneInput.value = '';
  pubSignupFlash = `"${name}" inscrita(o) ✓ (aguardando confirmação do organizador)`;
  render();
  setTimeout(() => { pubSignupFlash = null; render(); }, 3500);
}
function pubAddTeamHandler() {
  const nameInput = document.getElementById('pub-team-name');
  const phoneInput = document.getElementById('pub-team-phone');
  const name = nameInput.value.trim();
  const telefone = phoneInput.value.trim();
  if (!name || !telefone) { alert('Preencha o nome da dupla e o telefone pra se inscrever.'); return; }
  const catKey = currentCategoria();
  const categoria = catKey === DEFAULT_CAT ? '' : catKey;
  persist({ ...state, teams: [...state.teams, { id: uid(), name, telefone, categoria, confirmada: false, oculto: false }] });
  nameInput.value = ''; phoneInput.value = '';
  pubSignupFlash = `"${name}" inscrita ✓ (aguardando confirmação do organizador)`;
  render();
  setTimeout(() => { pubSignupFlash = null; render(); }, 3500);
}
function toggleConfirmHandler(list, id) {
  const key = list === 'players' ? 'players' : 'teams';
  persist({ ...state, [key]: state[key].map((x) => x.id === id ? { ...x, confirmada: !x.confirmada } : x) });
}
function toggleOcultoHandler(list, id) {
  const key = list === 'players' ? 'players' : 'teams';
  persist({ ...state, [key]: state[key].map((x) => x.id === id ? { ...x, oculto: !x.oculto } : x) });
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
function gerarHorariosHandler(catKey) {
  const dataInput = document.getElementById('auto-data').value;
  const horaInput = document.getElementById('auto-hora-inicio').value;
  const duracao = Number(document.getElementById('auto-duracao').value) || 40;
  if (!dataInput || !horaInput) { alert('Preencha a data e o horário de início.'); return; }
  const items = collectJogos(catKey).filter((it) => !it.data);
  const faseOrder = [];
  const byFase = {};
  items.forEach((it) => {
    if (!byFase[it.fase]) { byFase[it.fase] = []; faseOrder.push(it.fase); }
    byFase[it.fase].push(it);
  });
  const [h, m] = horaInput.split(':').map(Number);
  let cursorMin = h * 60 + m;
  const agendamentos = { ...state.agendamentos };
  faseOrder.forEach((fase) => {
    const horaStr = `${String(Math.floor(cursorMin / 60) % 24).padStart(2, '0')}:${String(cursorMin % 60).padStart(2, '0')}`;
    byFase[fase].forEach((it) => { agendamentos[it.id] = { data: dataInput, hora: horaStr }; });
    cursorMin += duracao;
  });
  persist({ ...state, agendamentos });
}

function gerarEliminatoriaSeNecessario(grupos, catKey, eliminatoriasAtuais) {
  const catGroups = grupos.filter((g) => g.categoria === catKey);
  const jaExiste = eliminatoriasAtuais[catKey] && eliminatoriasAtuais[catKey].length;
  if (jaExiste || !catGroups.length || !allGroupMatchesScored(catGroups)) return eliminatoriasAtuais;
  const bracket = generateEliminationFromGroups(catGroups);
  return { ...eliminatoriasAtuais, [catKey]: bracket };
}
function saveGroupScoreHandler(matchId) {
  const d = drafts[matchId];
  if (!d || d.a === '' || d.b === '') return;
  const a = Number(d.a), b = Number(d.b);
  if (a === b) { alert('Não pode empatar — ajuste o placar.'); return; }
  const grupos = state.grupos.map((g) => ({ ...g, matches: g.matches.map((m) => m.id === matchId ? { ...m, scoreA: a, scoreB: b } : m) }));
  const scoredGroup = grupos.find((g) => g.matches.some((m) => m.id === matchId));
  const eliminatorias = scoredGroup ? gerarEliminatoriaSeNecessario(grupos, scoredGroup.categoria, state.eliminatorias) : state.eliminatorias;
  editingMatches.delete(matchId);
  persist({ ...state, grupos, eliminatorias });
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
  editingMatches.delete(matchId);
  persist({ ...state, rounds: newRounds });
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
