import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, onValue, set, get } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, setPersistence, browserLocalPersistence, browserSessionPersistence } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
const torneiosRef = ref(db, 'torneios');
const atletasRef = ref(db, 'atletas');
const ADMIN_EMAIL_DOMAIN = '@hitpadel.local';

const uid = () => Math.random().toString(36).slice(2, 9);
const pairKey = (a, b) => [a, b].sort().join('~');
const DEFAULT_CAT = '_default';
const CATEGORIA_SUGESTOES = ['Cat Iniciante', '7ª Cat', '6ª Cat', '5ª Cat', '4ª Cat', 'Soma 9', 'Soma 11', 'Soma 13', 'Masculina', 'Feminina', 'Mista'];
// Quantas jogadoras realmente entram em quadra numa rodada: limitado pela capacidade das quadras
// (4 por quadra) E arredondado pra baixo até múltiplo de 4, porque não dá pra formar um jogo com
// menos de 4 pessoas — a sobra vira folga também, mesmo quando "cabe" fisicamente na quadra.
function ativosPorRodadaReal(numPlayers, numCourts) {
  const cap = Math.min(numPlayers, numCourts * 4);
  return cap - (cap % 4);
}
// Uma partida só conta como "jogada" quando os dois placares existem e pelo menos um é maior que 0.
// 0x0 ou campos vazios ficam como pendente (permite salvar um "reset" do placar sem contar como resultado real).
function partidaJogada(m) {
  return m.scoreA != null && m.scoreB != null && (m.scoreA > 0 || m.scoreB > 0);
}

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
    horaInicioTorneio: '',
    duracaoJogoMin: 40,
    encerrado: false,
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
  const ativosPorRodada = ativosPorRodadaReal(n, numCourts);
  const rounds = [];
  let cursor = 0;
  for (let r = 0; r < numRounds; r++) {
    const numBye = Math.max(0, n - ativosPorRodada);
    let byeIds = [];
    if (numBye > 0) { for (let i = 0; i < numBye; i++) byeIds.push(players[(cursor + i) % n].id); cursor = (cursor + numBye) % n; }
    const active = players.filter((p) => !byeIds.includes(p.id));
    let bestGroups = null, bestScore = Infinity;
    let tentativas = 400;
    for (let onda = 0; onda < 3 && bestScore > 0; onda++) {
      for (let attempt = 0; attempt < tentativas; attempt++) {
        const shuffled = [...active].sort(() => Math.random() - 0.5);
        const groups = [];
        for (let i = 0; i + 3 < shuffled.length; i += 4) groups.push(bestPairing(shuffled.slice(i, i + 4).map((p) => p.id), history));
        const s = groups.reduce((acc, g) => acc + scoreGroup(g, history), 0);
        if (s < bestScore) { bestScore = s; bestGroups = groups; }
        if (bestScore === 0) break;
      }
      tentativas *= 3;
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
    if (!partidaJogada(m)) return;
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
        if (!partidaJogada(m)) return;
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
function minRoundsForGamesPerPlayer(numPlayers, numCourts, jogosDesejados) {
  if (numPlayers < 4 || jogosDesejados < 1) return 0;
  const ativosPorRodada = ativosPorRodadaReal(numPlayers, numCourts);
  if (ativosPorRodada === 0) return 0;
  return Math.ceil((jogosDesejados * numPlayers) / ativosPorRodada);
}
// Verdadeiro só quando dá pra distribuir os jogos exatamente igual entre todas as jogadoras
// (ninguém joga a mais, ninguém joga a menos, ninguém fica de fora).
function distribuicaoEhJusta(numPlayers, numCourts, numRounds) {
  if (numPlayers < 4 || numRounds < 1) return false;
  const ativosPorRodada = ativosPorRodadaReal(numPlayers, numCourts);
  if (ativosPorRodada === 0) return false;
  return (numRounds * ativosPorRodada) % numPlayers === 0;
}
function proximosRoundsValidos(numPlayers, numCourts, quantidade = 6, maxRounds = 30) {
  const validos = [];
  for (let n = 1; n <= maxRounds && validos.length < quantidade; n++) {
    if (distribuicaoEhJusta(numPlayers, numCourts, n)) validos.push(n);
  }
  return validos;
}
function proximoRoundsValidoApartirDe(numPlayers, numCourts, minimo, maxRounds = 30) {
  for (let n = Math.max(1, minimo); n <= maxRounds; n++) {
    if (distribuicaoEhJusta(numPlayers, numCourts, n)) return n;
  }
  return minimo;
}
function roundsWithoutScores(rounds) { return rounds.some((rd) => rd.matches.some((m) => !partidaJogada(m))); }
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
    if (!partidaJogada(m)) return;
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
        if (!partidaJogada(m)) return;
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
function allGroupMatchesScored(groups) { return groups.every((g) => g.matches.every((m) => partidaJogada(m))); }

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
let avisoDemoraMostrado = false;
let timerAvisoDemora = null;
function agendarAvisoSeDemorar() {
  if (timerAvisoDemora || avisoDemoraMostrado) return;
  timerAvisoDemora = setTimeout(() => {
    avisoDemoraMostrado = true;
    timerAvisoDemora = null;
    render();
  }, 4000);
}
function cancelarAvisoDemora() {
  if (timerAvisoDemora) { clearTimeout(timerAvisoDemora); timerAvisoDemora = null; }
  avisoDemoraMostrado = false;
}
const AVISO_DEMORA_HTML = '<div class="hint" style="margin-top:10px">Isso está demorando mais que o normal — geralmente é a conexão do aparelho. Continue aguardando ou tente recarregar a página.</div>';
let torneiosList = null;       // null = ainda carregando; {} ou {id: dados} depois
let rodadasEstadoManual = {}; // chave "catKey-ri" -> true (recolhida) / false (aberta), fixado explicitamente ao clicar
let atletasConhecidos = {};    // { nomeLowerCase: { nome, telefone } } — cadastro compartilhado entre todos os torneios do clube, só pra autocompletar
let unsubscribeTournament = null;
let painelAdmin = null;        // null = grade de módulos | 'config' | 'quadras' | 'inscricoes' | 'duplas' | 'chaveamento' | 'jogos'
let novoTorneioNome = '';
let tvSlide = 0;
let tvTimer = null;
let lobbyFiltroTipo = 'todos';
let mostrarAtletasConhecidos = false;
let lobbyFiltroStatus = 'todos';
let inscritosVisiveis = true;

const root = document.getElementById('root');

async function persist(next) {
  state = next; render();
  if (!currentTournamentId) return;
  try { await set(ref(db, 'torneios/' + currentTournamentId), next); } catch (e) { console.error('Falha ao salvar', e); }
}

function getUrlTournamentId() {
  return new URLSearchParams(window.location.search).get('t');
}
function isModoTV() {
  return new URLSearchParams(window.location.search).get('tv') === '1';
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

function notifKey(tid) { return `hitpadel_notif_seen_${tid}`; }
function notifAtivadoKey(tid) { return `hitpadel_notif_on_${tid}`; }
function notificacoesAtivas() {
  return !!(currentTournamentId && localStorage.getItem(notifAtivadoKey(currentTournamentId)) === '1');
}
function verificarNovasInscricoes(novoState) {
  if (!isAdmin || !currentTournamentId) return;
  if (typeof Notification === 'undefined') return;
  if (!notificacoesAtivas()) return;
  if (Notification.permission !== 'granted') return;
  const key = notifKey(currentTournamentId);
  const initKey = key + '_init';
  let seen;
  try { seen = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { seen = []; }
  const seenSet = new Set(seen);
  const entradas = [...(novoState.players || []), ...(novoState.teams || [])];
  if (localStorage.getItem(initKey) !== '1') {
    entradas.forEach((e) => seenSet.add(e.id));
    localStorage.setItem(key, JSON.stringify([...seenSet]));
    localStorage.setItem(initKey, '1');
    return;
  }
  const novas = entradas.filter((e) => !seenSet.has(e.id));
  entradas.forEach((e) => seenSet.add(e.id));
  localStorage.setItem(key, JSON.stringify([...seenSet]));
  novas.forEach((e) => {
    try { new Notification('Nova inscrição — ' + (novoState.name || 'Hit Padel'), { body: e.name, icon: './logo.png' }); } catch (err) { console.error(err); }
  });
}

async function toggleNotificacoesHandler() {
  if (!currentTournamentId) return;
  if (typeof Notification === 'undefined') { alert('Seu navegador não suporta notificações.'); return; }
  if (notificacoesAtivas()) {
    localStorage.setItem(notifAtivadoKey(currentTournamentId), '0');
    render();
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    localStorage.setItem(notifAtivadoKey(currentTournamentId), '1');
    const key = notifKey(currentTournamentId);
    const entradas = [...(state.players || []), ...(state.teams || [])];
    localStorage.setItem(key, JSON.stringify(entradas.map((e) => e.id)));
    localStorage.setItem(key + '_init', '1');
  } else {
    alert('Permissão de notificação negada. Ative nas configurações do navegador se quiser usar esse recurso.');
  }
  render();
}

function carregarTorneioAtual() {
  if (unsubscribeTournament) { unsubscribeTournament(); unsubscribeTournament = null; }
  rodadasEstadoManual = {};
  if (!currentTournamentId) { state = null; return; }
  const r = ref(db, 'torneios/' + currentTournamentId);
  unsubscribeTournament = onValue(r, (snap) => {
    if (snap.exists()) { state = { ...defaultState(), ...snap.val() }; }
    else { state = defaultState(); set(r, state); }
    verificarNovasInscricoes(state);
    render();
  });
}

async function criarNovoTorneio(nome, tipo, numCourts) {
  const id = uid() + uid();
  const novo = { ...defaultState(), name: nome || 'Novo torneio', tipo: tipo || 'americano', numCourts: Math.max(1, Math.min(20, Number(numCourts) || 2)), criadoEm: Date.now() };
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
onValue(atletasRef, (snap) => {
  atletasConhecidos = snap.val() || {};
  render();
});
function lembrarAtleta(nome, telefone) {
  if (!nome) return;
  const chave = nome.trim().toLowerCase();
  if (!chave) return;
  const atual = atletasConhecidos[chave];
  if (atual && (!telefone || atual.telefone === telefone)) return; // já conhecido, nada novo pra salvar
  set(ref(db, 'atletas/' + chave), { nome: nome.trim(), telefone: telefone || atual?.telefone || '' }).catch((e) => console.error('Falha ao lembrar atleta', e));
}
function editarAtletaHandler(chaveAntiga) {
  const nomeInput = [...document.querySelectorAll('[data-action="atleta-edit-nome"]')].find((el) => el.dataset.chave === chaveAntiga);
  const telInput = [...document.querySelectorAll('[data-action="atleta-edit-telefone"]')].find((el) => el.dataset.chave === chaveAntiga);
  if (!nomeInput || !telInput) return;
  const novoNome = nomeInput.value.trim();
  if (!novoNome) return;
  const chaveNova = novoNome.toLowerCase();
  const dados = { nome: novoNome, telefone: telInput.value.trim() };
  const promessas = [set(ref(db, 'atletas/' + chaveNova), dados)];
  if (chaveNova !== chaveAntiga) promessas.push(set(ref(db, 'atletas/' + chaveAntiga), null));
  Promise.all(promessas).catch((e) => console.error('Falha ao editar atleta', e));
}
function removerAtletaHandler(chave, nome) {
  if (!confirm(`Remover "${nome}" da lista de atletas conhecidos? Isso só afeta a sugestão automática, não mexe em nenhum torneio já cadastrado.`)) return;
  set(ref(db, 'atletas/' + chave), null).catch((e) => console.error('Falha ao remover atleta', e));
}

currentTournamentId = getUrlTournamentId();
if (currentTournamentId) carregarTorneioAtual();
window.addEventListener('popstate', () => {
  currentTournamentId = getUrlTournamentId();
  carregarTorneioAtual();
  render();
});

onAuthStateChanged(auth, (user) => {
  const eraAdmin = isAdmin;
  isAdmin = !!user;
  if (isAdmin && !eraAdmin && currentTournamentId) {
    selecionarTorneio(null); // sempre que vira admin (login manual ou sessão restaurada), volta pra Central de Gestão
  } else {
    render();
  }
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
function formatDataHora(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const hora = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `Criado em ${dia}/${mes} às ${hora}:${min}`;
}

function renderEstadoVazioPublico(catPlayers, catTeams, isChaves) {
  const lista = isChaves ? catTeams : catPlayers;
  const confirmadas = lista.filter((x) => x.confirmada).length;
  const total = lista.length;
  return `
    <div class="card cta-card" style="text-align:center;margin-top:16px">
      <div class="card-body">
        <div class="visaogeral-num" style="font-size:36px">${confirmadas}</div>
        <div class="visaogeral-label">${isChaves ? 'dupla(s)' : 'jogadora(s)'} confirmada(s)${total > confirmadas ? ` · ${total - confirmadas} aguardando confirmação` : ''}</div>
        <div class="hint" style="margin-top:8px">O sorteio ainda não saiu. Assim que sair, as rodadas aparecem aqui.</div>
      </div>
    </div>
  `;
}
function renderProximaPartidaPublica(catKey) {
  const resumo = resumoVisaoGeral(catKey);
  if (!resumo.proxima && !resumo.ultimoResultado) return '';
  return `
    <div class="proxima-banner">
      ${resumo.proxima ? `
        <div class="proxima-banner-label">📅 Próxima partida</div>
        <div class="proxima-banner-info">${formatData(resumo.proxima.data)} às ${esc(resumo.proxima.hora)}</div>
        <div class="proxima-banner-jogo">${esc(resumo.proxima.a)} <span class="vs-inline">×</span> ${esc(resumo.proxima.b)}</div>
      ` : ''}
      ${resumo.ultimoResultado ? `
        <div class="proxima-banner-label" style="margin-top:${resumo.proxima ? '12px' : '0'}">🏆 Último resultado</div>
        <div class="proxima-banner-jogo">${esc(resumo.ultimoResultado.a)} <b>${resumo.ultimoResultado.scoreA}</b> <span class="vs-inline">×</span> <b>${resumo.ultimoResultado.scoreB}</b> ${esc(resumo.ultimoResultado.b)}</div>
      ` : ''}
    </div>
  `;
}

function render() {
  if (!currentTournamentId) { renderLobby(); return; }
  if (!state) {
    agendarAvisoSeDemorar();
    root.innerHTML = `<div class="loading">Carregando quadra...${avisoDemoraMostrado ? AVISO_DEMORA_HTML : ''}</div>`;
    return;
  }
  cancelarAvisoDemora();
  if (isModoTV()) { renderModoTV(currentCategoria()); return; }
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
      ${!isAdmin && (catRounds.length || catGroups.length) ? renderBuscaAtleta() : ''}
      ${!isAdmin ? renderProximaPartidaPublica(catKey) : ''}
      ${catKeys.length > 1 ? renderCategoriaTabs(catKeys, catKey) : ''}
      ${renderInscricaoPublica()}
      ${!isAdmin ? renderInscritosPublico(catKey) : ''}
      ${isAdmin && (catRounds.length || catGroups.length) ? renderBuscaAtleta() : ''}
      ${!isAdmin && !catRounds.length && !catGroups.length ? renderEstadoVazioPublico(catPlayers, catTeams, isChaves) : ''}
      ${isChaves ? renderGroupsAndElimination(catGroups, catElim, catTeams, catKey) : renderAmericanoView(catRounds, stats, catPlayers, catKey)}
      `}
    </main>
    <datalist id="atletas-datalist">${Object.values(atletasConhecidos).map((a) => `<option value="${esc(a.nome)}"></option>`).join('')}</datalist>
    <div id="pin-modal-slot"></div>
    <footer class="hp-footer">atualiza automaticamente</footer>
  `;
  bindEvents();
}

function renderModoTV(catKey) {
  if (!tvTimer) tvTimer = setInterval(() => { tvSlide = (tvSlide + 1) % 2; render(); }, 8000);
  const catPlayers = state.players.filter((p) => categoriaOf(p) === catKey);
  const catRounds = state.rounds[catKey] || [];
  const catGroups = state.grupos.filter((g) => g.categoria === catKey);
  const stats = computeStats(catPlayers, catRounds);
  let titulo, conteudo;
  if (tvSlide === 0) {
    if (state.tipo === 'chaves') {
      titulo = 'Classificação';
      conteudo = catGroups.length ? catGroups.map((g) => renderGroupCard(g)).join('') : `<div class="tv-vazio">Aguardando sorteio das chaves...</div>`;
    } else {
      titulo = 'Ranking';
      conteudo = catRounds.length ? renderRanking(stats) : `<div class="tv-vazio">Aguardando sorteio das rodadas...</div>`;
    }
  } else {
    titulo = 'Ao vivo agora';
    conteudo = renderAoVivoModulo(catKey);
  }
  root.innerHTML = `
    <div class="tv-mode">
      <div class="tv-header"><img class="tv-logo" src="./logo.png" alt="" /><div class="tv-nome">${esc(state.name)}</div></div>
      <div class="tv-titulo">${titulo}</div>
      <div class="tv-body">${conteudo}</div>
    </div>
  `;
}

function partidasDoTorneio(t) {
  const items = [];
  const nomeJogador = (id) => (t.players || []).find((p) => p.id === id)?.name || '?';
  const nomeDupla = (id) => id ? ((t.teams || []).find((x) => x.id === id)?.name || '?') : 'aguardando';
  if (t.tipo === 'chaves') {
    (t.grupos || []).forEach((g) => g.matches.forEach((m) => items.push({ id: m.id, a: nomeDupla(m.teamA), b: nomeDupla(m.teamB), scoreA: m.scoreA, scoreB: m.scoreB })));
    Object.values(t.eliminatorias || {}).forEach((rounds) => rounds.forEach((rd) => rd.forEach((m) => { if (!m.isBye) items.push({ id: m.id, a: nomeDupla(m.teamA), b: nomeDupla(m.teamB), scoreA: m.scoreA, scoreB: m.scoreB }); })));
  } else {
    Object.values(t.rounds || {}).forEach((rounds) => rounds.forEach((rd) => rd.matches.forEach((m) => items.push({ id: m.id, a: (m.teamA || []).map(nomeJogador).join(' + '), b: (m.teamB || []).map(nomeJogador).join(' + '), scoreA: m.scoreA, scoreB: m.scoreB }))));
  }
  return items.map((it) => {
    const ag = (t.agendamentos || {})[it.id] || {};
    return { ...it, data: ag.data || '', hora: ag.hora || '' };
  });
}
function statsGeraisTorneios(lista) {
  const ativos = lista.filter((t) => !t.encerrado);
  const encerrados = lista.filter((t) => t.encerrado);
  const publicados = ativos.filter((t) => t.visivelPublico);
  const inscricoesAbertasCount = ativos.filter((t) => t.inscricoesAbertas).length;
  const hoje = hojeISO();
  let partidasHoje = 0, partidasPendentesHoje = 0;
  const proximas = [];
  ativos.forEach((t) => {
    partidasDoTorneio(t).forEach((it) => {
      if (it.data === hoje) { partidasHoje++; if (!partidaJogada(it)) partidasPendentesHoje++; }
      if (!partidaJogada(it) && it.data && it.hora) proximas.push({ ...it, torneioNome: t.name, torneioId: t.id });
    });
  });
  proximas.sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora));
  return { totalAtivos: ativos.length, totalEncerrados: encerrados.length, publicadosCount: publicados.length, inscricoesAbertasCount, partidasHoje, partidasPendentesHoje, proximas: proximas.slice(0, 5) };
}

function tipoLabelOf(tipo) {
  return tipo === 'chaves' ? 'Torneio' : tipo === 'mini' ? 'Americano + Final' : 'Torneio Americano';
}

function renderTorneioCard(t) {
  return `
    <div class="round-block torneio-card" data-action="abrir-torneio" data-id="${t.id}">
      <div class="round-title"><span>${esc(t.name || 'Torneio sem nome')}</span>${isAdmin ? `<span class="badge-${t.visivelPublico ? 'ok' : 'pending'}">${t.visivelPublico ? '✓ publicado' : '⏳ rascunho'}</span>` : ''}</div>
      <div class="hint" style="text-align:left">${formatDataRange(t) || 'Data não definida'}${t.encerrado ? ' · encerrado' : ''}</div>
      ${isAdmin ? `
        <div class="torneio-card-acoes">
          <button class="mode-btn" data-action="publicar-torneio" data-id="${t.id}" data-atual="${t.visivelPublico ? '1' : '0'}">${t.visivelPublico ? 'Despublicar' : 'Publicar'}</button>
          <button class="mode-btn" data-action="encerrar-torneio" data-id="${t.id}" data-atual="${t.encerrado ? '1' : '0'}">${t.encerrado ? 'Reabrir' : 'Encerrar'}</button>
          <button class="mode-btn btn-danger" data-action="remover-torneio" data-id="${t.id}" data-nome="${esc(t.name || 'este torneio')}">Remover</button>
        </div>
      ` : ''}
    </div>`;
}

function renderModuloTipo(tipo, lista, isAdminView) {
  const dessteTipo = lista.filter((t) => (t.tipo || 'americano') === tipo).sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0));
  if (!isAdminView && dessteTipo.length === 0) return '';
  return `
    <div class="round-title" style="margin-top:20px"><span>${tipoLabelOf(tipo)} (${dessteTipo.length})</span></div>
    ${dessteTipo.length === 0 ? `<div class="hint">Nenhum torneio deste tipo ainda.</div>` : `<div class="groups-wrap">${dessteTipo.map((t) => renderTorneioCard(t)).join('')}</div>`}
  `;
}

function renderChecklistPrimeirosPassos() {
  return `
    <div class="card cta-card" style="margin-top:12px">
      <div class="card-head-static">👋 Primeiros passos</div>
      <div class="card-body">
        <div class="hint" style="text-align:left">1. Crie seu primeiro torneio abaixo, escolhendo o tipo</div>
        <div class="hint" style="text-align:left;margin-top:6px">2. Dentro dele, cadastre as jogadoras (ou duplas) em "Inscrições"</div>
        <div class="hint" style="text-align:left;margin-top:6px">3. Sorteie as rodadas (ou gere as chaves)</div>
        <div class="hint" style="text-align:left;margin-top:6px">4. Publique o torneio e compartilhe o link com o grupo</div>
      </div>
    </div>
  `;
}
function renderCentralGestao(ativos, encerrados) {
  const stats = statsGeraisTorneios([...ativos, ...encerrados]);
  let listaFiltrada = ativos.concat(lobbyFiltroStatus === 'encerrados' ? encerrados : []);
  if (lobbyFiltroStatus === 'publicados') listaFiltrada = listaFiltrada.filter((t) => t.visivelPublico);
  if (lobbyFiltroStatus === 'rascunho') listaFiltrada = listaFiltrada.filter((t) => !t.visivelPublico);
  if (lobbyFiltroStatus === 'encerrados') listaFiltrada = encerrados;
  if (lobbyFiltroStatus === 'hoje') { const hoje = hojeISO(); listaFiltrada = listaFiltrada.filter((t) => t.dataInicio && hoje >= t.dataInicio && hoje <= (t.dataFim || t.dataInicio)); }
  if (lobbyFiltroTipo !== 'todos') listaFiltrada = listaFiltrada.filter((t) => (t.tipo || 'americano') === lobbyFiltroTipo);
  listaFiltrada = [...listaFiltrada].sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0));
  const clubeNovo = ativos.length === 0 && encerrados.length === 0;

  return `
    ${clubeNovo ? renderChecklistPrimeirosPassos() : ''}
    <div class="lobby-stats-grid">
      <div class="visaogeral-item"><div class="visaogeral-num">${stats.totalAtivos}</div><div class="visaogeral-label">Torneios ativos</div></div>
      <div class="visaogeral-item"><div class="visaogeral-num">${stats.publicadosCount}</div><div class="visaogeral-label">Publicados</div></div>
      <div class="visaogeral-item"><div class="visaogeral-num">${stats.inscricoesAbertasCount}</div><div class="visaogeral-label">Com inscrições abertas</div></div>
      <div class="visaogeral-item"><div class="visaogeral-num">${stats.partidasHoje}</div><div class="visaogeral-label">Partidas hoje</div></div>
      <div class="visaogeral-item"><div class="visaogeral-num">${stats.partidasPendentesHoje}</div><div class="visaogeral-label">Pendentes hoje</div></div>
      <div class="visaogeral-item"><div class="visaogeral-num">${stats.totalEncerrados}</div><div class="visaogeral-label">Encerrados</div></div>
    </div>
    <div class="lobby-grid-desktop">
      <div>
        <div class="lobby-filters">
          <input id="lobby-busca" placeholder="🔍 Buscar torneio..." />
          <select id="lobby-filtro-status" data-action="lobby-set-status">
            <option value="todos" ${lobbyFiltroStatus === 'todos' ? 'selected' : ''}>Todos os status</option>
            <option value="hoje" ${lobbyFiltroStatus === 'hoje' ? 'selected' : ''}>Acontecendo hoje</option>
            <option value="publicados" ${lobbyFiltroStatus === 'publicados' ? 'selected' : ''}>Publicados</option>
            <option value="rascunho" ${lobbyFiltroStatus === 'rascunho' ? 'selected' : ''}>Rascunho</option>
            <option value="encerrados" ${lobbyFiltroStatus === 'encerrados' ? 'selected' : ''}>Encerrados</option>
          </select>
          <select id="lobby-filtro-tipo" data-action="lobby-set-tipo">
            <option value="todos" ${lobbyFiltroTipo === 'todos' ? 'selected' : ''}>Todas categorias</option>
            <option value="americano" ${lobbyFiltroTipo === 'americano' ? 'selected' : ''}>Torneio Americano</option>
            <option value="mini" ${lobbyFiltroTipo === 'mini' ? 'selected' : ''}>Americano + Final</option>
            <option value="chaves" ${lobbyFiltroTipo === 'chaves' ? 'selected' : ''}>Torneio</option>
          </select>
        </div>
        <div class="table-scroll">
          <table class="ranking lobby-table">
            <thead><tr><th>Torneio</th><th>Tipo</th><th>Data</th><th>Participantes</th><th>Partidas</th><th>Status</th><th>Ações</th></tr></thead>
            <tbody>
              ${listaFiltrada.length === 0 ? `<tr><td colspan="7" class="hint">Nenhum torneio encontrado.</td></tr>` : listaFiltrada.map((t) => {
                const partidas = partidasDoTorneio(t);
                const jogadas = partidas.filter((p) => partidaJogada(p)).length;
                const participantes = t.tipo === 'chaves' ? (t.teams || []).length : (t.players || []).length;
                return `<tr class="lobby-row" data-action="abrir-torneio" data-id="${t.id}">
                  <td data-label="Torneio">${esc(t.name || 'Torneio sem nome')}<div class="lobby-criado-em">${formatDataHora(t.criadoEm)}</div></td>
                  <td data-label="Tipo">${esc(tipoLabelOf(t.tipo))}</td>
                  <td data-label="Data">${formatDataRange(t) || '–'}</td>
                  <td data-label="Participantes" class="c">${participantes}</td>
                  <td data-label="Partidas" class="c">${jogadas}/${partidas.length}</td>
                  <td data-label="Status">${t.encerrado ? '<span class="badge-pending">encerrado</span>' : (t.visivelPublico ? '<span class="badge-ok">✓ publicado</span>' : '<span class="badge-pending">rascunho</span>')}</td>
                  <td data-label="Ações" class="lobby-acoes-cell">
                    <button class="mode-btn" data-action="publicar-torneio" data-id="${t.id}" data-atual="${t.visivelPublico ? '1' : '0'}">${t.visivelPublico ? 'Despublicar' : 'Publicar'}</button>
                    <button class="mode-btn" data-action="encerrar-torneio" data-id="${t.id}" data-atual="${t.encerrado ? '1' : '0'}">${t.encerrado ? 'Reabrir' : 'Encerrar'}</button>
                    <button class="mode-btn btn-danger" data-action="remover-torneio" data-id="${t.id}" data-nome="${esc(t.name || 'este torneio')}">Remover</button>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div class="card" style="margin-top:20px">
          <div class="card-head-static">+ Criar novo torneio</div>
          <div class="card-body">
            <div class="field"><label>Nome do torneio</label><input id="novo-torneio-nome" placeholder="Ex: Torneio de Verão" /></div>
            <div class="field">
              <label>Tipo</label>
              <div class="mode-row">
                <button class="mode-btn tipo-novo-torneio active" data-action="sel-tipo-novo" data-tipo="americano">Torneio Americano</button>
                <button class="mode-btn tipo-novo-torneio" data-action="sel-tipo-novo" data-tipo="mini">Americano + Final</button>
                <button class="mode-btn tipo-novo-torneio" data-action="sel-tipo-novo" data-tipo="chaves">Torneio</button>
              </div>
            </div>
            <div class="field"><label>Quantidade de quadras</label><input type="number" min="1" max="20" id="novo-torneio-quadras" value="2" /></div>
            <button class="btn-primary" data-action="criar-torneio" data-tipo="americano">Criar e abrir</button>
          </div>
        </div>
        <div class="card" style="margin-top:20px">
          <div class="card-head-static" data-action="toggle-atletas-conhecidos" style="cursor:pointer">👥 Atletas conhecidos (${Object.keys(atletasConhecidos).length}) ${mostrarAtletasConhecidos ? '▲' : '▼'}</div>
          ${mostrarAtletasConhecidos ? `
          <div class="card-body">
            <div class="hint" style="text-align:left;margin-bottom:10px">Essa lista é só pra sugerir nome/telefone automaticamente na hora de inscrever alguém. Editar ou remover aqui não muda nada nos torneios já cadastrados.</div>
            ${Object.keys(atletasConhecidos).length === 0 ? `<div class="hint">Ninguém cadastrado ainda.</div>` : Object.entries(atletasConhecidos).sort((a, b) => a[1].nome.localeCompare(b[1].nome)).map(([chave, a]) => `
              <div class="row2" style="margin-bottom:8px">
                <input value="${esc(a.nome)}" data-action="atleta-edit-nome" data-chave="${esc(chave)}" />
                <input value="${esc(a.telefone || '')}" placeholder="Telefone" data-action="atleta-edit-telefone" data-chave="${esc(chave)}" />
              </div>
              <div class="row" style="margin-bottom:14px">
                <button class="mode-btn" data-action="atleta-salvar" data-chave="${esc(chave)}">Salvar</button>
                <button class="mode-btn btn-danger" data-action="atleta-remover" data-chave="${esc(chave)}" data-nome="${esc(a.nome)}">Remover</button>
              </div>
            `).join('')}
          </div>` : ''}
        </div>
      </div>
      <aside>
        <div class="card">
          <div class="card-head-static">Próximas partidas</div>
          <div class="card-body">
            ${stats.proximas.length === 0 ? `<div class="hint">Nenhuma partida com horário agendado.</div>` : stats.proximas.map((p) => `
              <div class="lobby-proxima-item" data-action="abrir-torneio" data-id="${p.torneioId}">
                <div class="lobby-proxima-hora">${formatData(p.data)} ${p.hora}</div>
                <div class="lobby-proxima-torneio">${esc(p.torneioNome)}</div>
                <div class="lobby-proxima-jogo">${esc(p.a)} × ${esc(p.b)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </aside>
    </div>
  `;
}

function renderLobby() {
  const lista = torneiosList ? Object.entries(torneiosList).map(([id, t]) => ({ id, ...t })) : null;
  if (lista !== null) cancelarAvisoDemora();
  const todos = lista || [];
  const visiveis = isAdmin ? todos : todos.filter((t) => t.visivelPublico);
  const ativos = visiveis.filter((t) => !t.encerrado);
  const encerrados = visiveis.filter((t) => t.encerrado);
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
    <main class="hp-main ${isAdmin ? 'hp-main-wide' : ''}">
      <div class="round-title" style="margin-top:16px"><span>${isAdmin ? 'Central de gestão' : 'Torneios em andamento'}</span></div>
      ${lista === null ? (agendarAvisoSeDemorar(), `<div class="hint">Carregando...${avisoDemoraMostrado ? AVISO_DEMORA_HTML : ''}</div>`) : ''}
      ${lista !== null && isAdmin ? renderCentralGestao(ativos, encerrados) : ''}
      ${lista !== null && !isAdmin ? `
        ${ativos.length === 0 ? '<div class="hint">Nenhum torneio em andamento no momento.</div>' : ''}
        ${renderModuloTipo('americano', ativos, false)}
        ${renderModuloTipo('mini', ativos, false)}
        ${renderModuloTipo('chaves', ativos, false)}
      ` : ''}
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
          <input id="pub-team-j1" placeholder="Seu nome" style="margin-bottom:8px" list="atletas-datalist" />
          <input id="pub-team-tel1" type="tel" placeholder="Seu telefone (whatsapp)" style="margin-bottom:8px" />
          <label class="checkbox-row"><input type="checkbox" id="pub-team-sem-parceiro" data-action="toggle-sem-parceiro-pub" /> Estou sem parceiro(a) — procurando dupla</label>
          <div id="pub-team-parceiro-wrap">
            <input id="pub-team-j2" placeholder="Nome do(a) parceiro(a)" style="margin-bottom:8px" list="atletas-datalist" />
            <input id="pub-team-tel2" type="tel" placeholder="Telefone do(a) parceiro(a) (opcional)" style="margin-bottom:8px" />
          </div>
          <button data-action="pub-add-team" style="width:100%">Inscrever</button>
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
          <input id="pub-player-name" placeholder="Seu nome" style="margin-bottom:8px" list="atletas-datalist" />
          <div class="row"><input id="pub-player-phone" type="tel" placeholder="Telefone (whatsapp)" /><button data-action="pub-add-player">Inscrever</button></div>
          ${flashMsg}
        </div>
      </div>
    </section>`;
}

function renderInscritosPublico(catKey) {
  const list = state.tipo === 'chaves' ? state.teams : state.players;
  const catList = list.filter((x) => categoriaOf(x) === catKey && !x.oculto).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  if (!catList.length) return '';
  return `
    <section class="card">
      <div class="card-head-static inscritos-header" data-action="toggle-inscritos-publico">
        <span>👥 Inscritas (${catList.length})</span>
        <span class="round-toggle-icon">${inscritosVisiveis ? '▲ ocultar' : '▼ mostrar'}</span>
      </div>
      ${inscritosVisiveis ? `
      <div class="card-body">
        <div class="inscritos-grid">
          ${catList.map((x) => `<div class="inscrito-item">${esc(x.name)} ${x.confirmada ? '<span class="badge-ok">✓</span>' : '<span class="badge-pending">⏳</span>'}</div>`).join('')}
        </div>
      </div>` : ''}
    </section>`;
}
function renderBuscaAtleta() {
  return isAdmin
    ? `<div class="field search-field"><input id="busca-atleta" placeholder="🔍 Buscar por atleta ou dupla..." /></div>`
    : `<div class="field search-field search-field-destaque"><label>🔍 Digite seu nome pra encontrar sua partida</label><input id="busca-atleta" placeholder="Seu nome ou o da sua dupla..." /></div>`;
}
function renderCategoriaTabs(catKeys, current) {
  return `<div class="tabs cat-tabs">
    ${catKeys.map((k) => `<button class="tab ${k === current ? 'active' : ''}" data-action="sel-cat" data-cat="${esc(k)}">${esc(catLabel(k) || 'Geral')}</button>`).join('')}
  </div>`;
}

function renderGerarHorariosPanel(catKey) {
  const items = collectJogos(catKey);
  const semData = items.filter((i) => !i.data).length;
  if (!isAdmin || semData === 0) return '';
  return `
    <div class="card" style="margin-bottom:14px">
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
    </div>`;
}
function renderAmericanoView(catRounds, stats, catPlayers, catKey) {
  if (!catRounds.length) return '';
  const podeGerarFinal = state.tipo === 'mini' && !catRounds.some((r) => r.isFinal) && catRounds.length > 0 && !roundsWithoutScores(catRounds) && catPlayers.length >= 4;
  return `
    <div class="tabs">
      <button class="tab ${tab === 'rodadas' ? 'active' : ''}" data-action="tab" data-tab="rodadas">Rodadas</button>
      <button class="tab ${tab === 'ranking' ? 'active' : ''}" data-action="tab" data-tab="ranking">Ranking</button>
      <button class="tab ${tab === 'aovivo' ? 'active' : ''}" data-action="tab" data-tab="aovivo">Ao Vivo</button>
    </div>
    ${isAdmin && podeGerarFinal ? `<button class="btn-primary" style="margin-bottom:14px" data-action="gerar-final">🏆 Gerar final (top 4)</button>` : ''}
    ${tab === 'rodadas' ? renderGerarHorariosPanel(catKey) + renderRounds(catRounds, catKey) : ''}
    ${tab === 'ranking' ? renderRanking(stats) : ''}
    ${tab === 'aovivo' ? renderAoVivoModulo(catKey) : ''}
  `;
}

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function resumoVisaoGeral(catKey) {
  const items = collectJogos(catKey);
  const total = items.length;
  const jogados = items.filter((it) => partidaJogada(it)).length;
  const pendentes = total - jogados;
  const agora = new Date();
  const hoje = hojeISO();
  const agoraMin = agora.getHours() * 60 + agora.getMinutes();
  const futuros = items.filter((it) => !partidaJogada(it) && it.data && it.hora && (it.data > hoje || (it.data === hoje && (it.hora.split(':').map(Number)[0] * 60 + it.hora.split(':').map(Number)[1]) >= agoraMin)));
  futuros.sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora));
  const jogadosComHorario = items.filter((it) => partidaJogada(it) && it.data && it.hora);
  jogadosComHorario.sort((a, b) => (b.data + b.hora).localeCompare(a.data + a.hora));
  const atrasadas = items.filter((it) => !partidaJogada(it) && it.data && it.hora && (it.data < hoje || (it.data === hoje && (it.hora.split(':').map(Number)[0] * 60 + it.hora.split(':').map(Number)[1]) < agoraMin)));
  return { total, jogados, pendentes, proxima: futuros[0] || null, ultimoResultado: jogadosComHorario[0] || null, atrasadas: atrasadas.length };
}
function statusQuadrasAoVivo(catKey) {
  const items = collectJogos(catKey);
  const hoje = hojeISO();
  const agora = new Date();
  const agoraMin = agora.getHours() * 60 + agora.getMinutes();
  const board = [];
  for (let q = 1; q <= state.numCourts; q++) {
    const doDia = items.filter((it) => it.court === q && it.data === hoje && !partidaJogada(it) && it.hora)
      .sort((a, b) => a.hora.localeCompare(b.hora));
    let entry = { quadra: q, nome: quadraNome(state, q), status: 'livre', jogo: null };
    for (const it of doDia) {
      const [h, mi] = it.hora.split(':').map(Number);
      const inicioMin = h * 60 + mi;
      if (agoraMin < inicioMin) { entry = { quadra: q, nome: quadraNome(state, q), status: 'proxima', jogo: it }; break; }
      if (agoraMin < inicioMin + 60) { entry = { quadra: q, nome: quadraNome(state, q), status: 'andamento', jogo: it }; break; }
      entry = { quadra: q, nome: quadraNome(state, q), status: 'pendente', jogo: it };
      break;
    }
    board.push(entry);
  }
  return board;
}
const STATUS_AO_VIVO = {
  andamento: { emoji: '🟢', texto: 'Em andamento' },
  proxima: { emoji: '🟡', texto: 'Próxima partida' },
  pendente: { emoji: '🔴', texto: 'Resultado pendente' },
  livre: { emoji: '⚪', texto: 'Livre' },
};
function renderAoVivoModulo(catKey) {
  if (state.tipo === 'chaves') {
    const items = collectJogos(catKey);
    const hoje = hojeISO();
    const agora = new Date();
    const agoraMin = agora.getHours() * 60 + agora.getMinutes();
    const doDia = items.filter((it) => it.data === hoje && !partidaJogada(it));
    const atrasadas = doDia.filter((it) => it.hora && (it.hora.split(':').map(Number)[0] * 60 + it.hora.split(':').map(Number)[1]) < agoraMin);
    const proximas = doDia.filter((it) => !atrasadas.includes(it));
    return `
      <div class="hint" style="text-align:left;margin-bottom:10px">No modo Torneio as partidas não têm quadra fixa, então a lista abaixo é organizada por horário de hoje em vez de por quadra.</div>
      <div class="round-title"><span>🔴 Resultado pendente (${atrasadas.length})</span></div>
      ${atrasadas.length ? atrasadas.map((it) => renderAoVivoLinha(it)).join('') : `<div class="hint">Nenhuma.</div>`}
      <div class="round-title" style="margin-top:14px"><span>🟡 Próximas hoje (${proximas.length})</span></div>
      ${proximas.length ? proximas.map((it) => renderAoVivoLinha(it)).join('') : `<div class="hint">Nenhuma.</div>`}
    `;
  }
  const board = statusQuadrasAoVivo(catKey);
  return `
    <div class="aovivo-grid">
      ${board.map((e) => `
        <div class="aovivo-card aovivo-${e.status}">
          <div class="aovivo-quadra">${esc(e.nome)}</div>
          <div class="aovivo-status">${STATUS_AO_VIVO[e.status].emoji} ${STATUS_AO_VIVO[e.status].texto}</div>
          ${e.jogo ? `<div class="aovivo-jogo">${e.jogo.hora} · ${esc(e.jogo.a)} × ${esc(e.jogo.b)}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}
function renderAoVivoLinha(it) {
  return `<div class="match"><div class="match-head"><span class="court-tag">${it.hora || 'sem horário'}</span></div><div class="team-row"><span class="team-name">${esc(it.a)}</span></div><div class="vs">×</div><div class="team-row"><span class="team-name">${esc(it.b)}</span></div></div>`;
}

function renderAdminDashboard(maxCourts, catPlayers, catTeams) {
  if (painelAdmin) return renderPainelModulo(painelAdmin, maxCourts, catPlayers, catTeams);
  const catKey = currentCategoria();
  const totalConfirmadas = state.tipo === 'chaves'
    ? state.teams.filter((t) => categoriaOf(t) === catKey && t.confirmada).length
    : catPlayers.filter((p) => p.confirmada).length;
  const rodadasGeradas = (state.rounds[catKey] || []).length;
  const gruposGerados = state.grupos.filter((g) => g.categoria === catKey).length;
  const tipoLabel = tipoLabelOf(state.tipo);
  const resumo = resumoVisaoGeral(catKey);
  const naoGerouAinda = state.tipo === 'chaves' ? state.grupos.length === 0 : Object.values(state.rounds).every((r) => r.length === 0);
  return `
  <section class="card">
    <div class="card-head-static">📊 Visão geral</div>
    <div class="card-body">
      ${resumo.atrasadas > 0 ? `<div class="alerta-atraso">⚠️ ${resumo.atrasadas} partida${resumo.atrasadas > 1 ? 's' : ''} passou do horário marcado sem placar lançado</div>` : ''}
      <div class="visaogeral-grid">
        <div class="visaogeral-item"><div class="visaogeral-num">${resumo.total}</div><div class="visaogeral-label">Partidas totais</div></div>
        <div class="visaogeral-item"><div class="visaogeral-num">${resumo.jogados}</div><div class="visaogeral-label">Com resultado</div></div>
        <div class="visaogeral-item"><div class="visaogeral-num">${resumo.pendentes}</div><div class="visaogeral-label">Pendentes</div></div>
      </div>
      ${resumo.proxima ? `<div class="hint" style="text-align:left;margin-top:6px">Próxima: ${formatData(resumo.proxima.data)} ${resumo.proxima.hora} — ${esc(resumo.proxima.a)} × ${esc(resumo.proxima.b)}</div>` : `<div class="hint" style="text-align:left;margin-top:6px">Nenhuma partida com horário agendado pendente.</div>`}
      <button class="mode-btn" style="width:100%;margin-top:10px" data-action="compartilhar-whatsapp">📲 Compartilhar torneio no WhatsApp</button>
      <button class="mode-btn" style="width:100%;margin-top:8px" data-action="abrir-modo-tv">📺 Abrir tela do clube (TV/projetor)</button>
    </div>
  </section>
  <section class="card cta-card">
    <div class="card-body">
      <button class="btn-primary" style="width:100%" data-action="${state.tipo === 'chaves' ? 'gerar-grupos' : 'sortear'}">🔀 ${naoGerouAinda ? (state.tipo === 'chaves' ? 'Gerar chaves' : 'Sortear rodadas') : (state.tipo === 'chaves' ? 'Gerar chaves novamente' : 'Sortear novamente')}</button>
      <div class="hint" style="text-align:left;margin-top:6px">${naoGerouAinda ? `Cadastre as ${state.tipo === 'chaves' ? 'duplas' : 'jogadoras'} em "Inscrições" antes de sortear.` : 'Pode sortear quantas vezes quiser — cada vez gera uma combinação nova. Isso apaga os placares já lançados.'}</div>
    </div>
  </section>
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
          <div class="dash-title">${state.tipo === 'chaves' ? 'Duplas' : 'Jogadoras'}</div>
          <div class="dash-sub">${totalConfirmadas} confirmada(s)</div>
        </button>
        <button class="dash-card" data-action="abrir-painel" data-painel="chaveamento">
          <div class="dash-title">${state.tipo === 'chaves' ? 'Chaveamento' : 'Sorteio de Rodadas'}</div>
          <div class="dash-sub">${state.tipo === 'chaves' ? `${gruposGerados} chave(s)` : `${rodadasGeradas} rodada(s)`}</div>
        </button>
        <button class="dash-card" data-action="abrir-painel" data-painel="aovivo">
          <div class="dash-title">Ao Vivo</div>
          <div class="dash-sub">Status por quadra agora</div>
        </button>
        ${state.tipo === 'chaves' ? `
        <button class="dash-card" data-action="ir-jogos">
          <div class="dash-title">Jogos</div>
          <div class="dash-sub">Ver e agendar horários</div>
        </button>` : ''}
      </div>
    </div>
  </section>`;
}

function renderPainelModulo(painel, maxCourts, catPlayers, catTeams) {
  const minRounds = minRoundsForFullCoverage(catPlayers.length, Math.min(state.numCourts, maxCourts));
  const titulos = { config: 'Configurações', quadras: 'Quadras e Rodadas', inscricoes: 'Inscrições', duplas: state.tipo === 'chaves' ? 'Duplas' : 'Jogadoras', chaveamento: state.tipo === 'chaves' ? 'Chaveamento' : 'Sorteio de Rodadas', aovivo: 'Ao Vivo' };
  let content = '';
  if (painel === 'config') content = renderConfigModulo();
  else if (painel === 'quadras') content = renderQuadrasModulo(maxCourts, minRounds, catPlayers.length);
  else if (painel === 'inscricoes') content = state.tipo === 'chaves' ? renderTeamsSetup() : renderPlayersSetup(minRounds);
  else if (painel === 'duplas') content = renderDuplasModulo(catTeams, catPlayers);
  else if (painel === 'chaveamento') content = renderChaveamentoModulo();
  else if (painel === 'aovivo') content = renderAoVivoModulo(currentCategoria());
  return `
  <section class="card">
    <button class="card-head" data-action="fechar-painel"><span>← ${esc(titulos[painel] || 'Voltar')}</span><span>▲</span></button>
    <div class="card-body">${content}</div>
  </section>`;
}

function renderConfigModulo() {
  return `
    <div class="field">
      <label>Nome do torneio</label>
      <input id="config-nome-torneio" value="${esc(state.name)}" data-action="rename" />
    </div>
    <div class="field">
      <label>Visibilidade pro público</label>
      <button class="mode-btn ${state.visivelPublico ? 'active' : ''}" data-action="toggle-visivel">${state.visivelPublico ? '✓ Visível (torneio postado)' : 'Oculto'}</button>
      <div class="hint" style="text-align:left;margin-top:4px">${state.visivelPublico ? 'Qualquer pessoa com o link já vê rodadas, chaves e ranking.' : 'Ninguém vê nada do torneio ainda. Ative quando quiser divulgar.'}</div>
    </div>
    <div class="field">
      <label>Notificações de inscrição</label>
      <button class="mode-btn ${notificacoesAtivas() ? 'active' : ''}" data-action="toggle-notificacoes">${notificacoesAtivas() ? '✓ Ativadas' : 'Ativar notificações'}</button>
      <div class="hint" style="text-align:left;margin-top:4px">Mostra um aviso no navegador quando alguém se inscrever, enquanto esta aba estiver aberta.</div>
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

function renderQuadrasModulo(maxCourts, minRounds, numJogadoras) {
  const cortesReais = Math.min(state.numCourts, maxCourts);
  const justa = state.tipo !== 'chaves' && numJogadoras >= 4 ? distribuicaoEhJusta(numJogadoras, cortesReais, state.numRounds) : true;
  const numeroImpar = numJogadoras % 2 === 1;
  return `
    <div class="row2">
      <div class="field"><label>Quadras (máx ${maxCourts})</label><input type="number" min="1" max="${maxCourts}" id="num-courts" value="${state.numCourts}" data-action="set-courts" /></div>
      <div class="field"><label>Rodadas</label><input type="number" min="1" max="30" id="num-rounds" value="${state.numRounds}" data-action="set-rounds" /></div>
    </div>
    ${state.tipo !== 'chaves' && numJogadoras >= 4 ? `
      <div class="hint ${justa ? '' : 'hint-alerta'}" style="text-align:left;margin-top:-8px;margin-bottom:10px">
        ${justa ? `✓ Com ${state.numRounds} rodada(s), todas as ${numJogadoras} jogadoras jogam a mesma quantidade de jogos.` : `⚠ Com ${state.numRounds} rodada(s), NÃO dá pra deixar os jogos iguais pra todas.${numeroImpar ? ' Com número ímpar de jogadoras, use o campo "jogos por jogadora" abaixo, que calcula um número de rodadas que funciona automaticamente.' : ` Números que funcionam: ${proximosRoundsValidos(numJogadoras, cortesReais).join(', ')}.`}`}
      </div>
    ` : ''}
    ${state.tipo !== 'chaves' && minRounds > 0 && numJogadoras >= 4 ? (numeroImpar ? `
      <div class="hint" style="text-align:left;margin-top:4px">Com número ímpar de jogadoras, "todos contra todos" não é uma opção prática (exigiria rodadas demais). Use o campo "jogos por jogadora" abaixo.</div>
    ` : `
      <button class="mode-btn" data-action="usar-cobertura-total" data-min="${minRounds}">Preencher com ~${minRounds} rodadas (todos jogam com todos)</button>
      <div class="hint" style="text-align:left;margin-top:4px">Com as jogadoras confirmadas na categoria atual e ${state.numCourts} quadra(s), seriam necessárias ~${minRounds} rodadas pra garantir que todo mundo jogue com todo mundo pelo menos 1 vez.</div>
    `) : ''}
    ${state.tipo !== 'chaves' ? `
      <div class="field" style="margin-top:10px">
        <label>Ou escolha quantos jogos cada jogadora deve jogar</label>
        <div class="row">
          <input type="number" min="1" id="jogos-por-jogadora" placeholder="Ex: 4 ou 5" />
          <button data-action="calcular-rodadas-por-jogos">Calcular e preencher rodadas</button>
        </div>
        <div class="hint" style="text-align:left;margin-top:4px" id="jogos-por-jogadora-resultado"></div>
      </div>
    ` : ''}
    <div class="field">
      <label>Nome das quadras</label>
      <div class="row2">
        ${Array.from({ length: state.numCourts }, (_, i) => `<input class="court-name-input" data-action="set-court-name" data-idx="${i}" value="${esc(state.nomesQuadras[i] || `Quadra ${String(i + 1).padStart(2, '0')}`)}" />`).join('')}
      </div>
    </div>
    <div class="row2">
      <div class="field"><label>Horário de início dos jogos</label><input type="time" id="hora-inicio-torneio" value="${esc(state.horaInicioTorneio)}" data-action="set-hora-inicio-torneio" /></div>
      <div class="field"><label>Duração de cada jogo (min)</label><input type="number" min="1" id="duracao-jogo-min" value="${state.duracaoJogoMin}" data-action="set-duracao-jogo-min" /></div>
    </div>
    <div class="hint" style="text-align:left">Preenchidos junto com a Data de início (na Configuração), os horários de todos os jogos são gerados automaticamente assim que você sortear as rodadas ou gerar as chaves — sem precisar entrar na aba Jogos depois.</div>
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
  const pendentes = state.players.filter((p) => !p.confirmada).length;
  return `
    <div class="field">
      <label>Jogadoras (${state.players.length})</label>
      ${pendentes > 0 ? `<button class="mode-btn" data-action="confirmar-todas-jogadoras" style="margin-bottom:8px">✓ Confirmar todas (${pendentes} pendente${pendentes > 1 ? 's' : ''})</button>` : ''}
      <div class="chips">
        ${state.players.map((p) => `<span class="chip ${p.oculto ? 'is-oculto' : ''}">${esc(p.name)}${p.categoria ? ` <em>(${esc(p.categoria)})</em>` : ''}${p.telefone ? ` <span class="tel">📞${esc(p.telefone)}</span>` : ''} <button class="conf-badge ${p.confirmada ? 'yes' : 'no'}" data-action="toggle-confirm-player" data-id="${p.id}" title="${p.confirmada ? 'Confirmada — clique pra marcar como pendente' : 'Pendente — clique pra confirmar'}">${p.confirmada ? '✓' : '⏳'}</button> <button class="vis-badge" data-action="toggle-oculto-player" data-id="${p.id}" title="${p.oculto ? 'Oculta do público — clique pra mostrar' : 'Visível ao público — clique pra ocultar'}">${p.oculto ? '🚫' : '👁'}</button> <button data-action="remove-player" data-id="${p.id}" data-nome="${esc(p.name)}">×</button></span>`).join('')}
      </div>
      <div class="row">
        <input id="new-player" placeholder="Nome da jogadora" list="atletas-datalist" />
        ${showCatSelect ? `<select id="new-player-cat">${state.categorias.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>` : ''}
        <button data-action="add-player">+</button>
      </div>
    </div>`;
}

function montarNomeDupla(j1, j2, semParceiro) {
  if (semParceiro || !j2) return `${j1} (sem parceiro)`;
  return `${j1} & ${j2}`;
}

function renderTeamsSetup() {
  const showCatSelect = state.categorias.length > 0;
  const pendentes = state.teams.filter((t) => !t.confirmada).length;
  return `
    <div class="field">
      <label>Duplas (${state.teams.length})</label>
      ${pendentes > 0 ? `<button class="mode-btn" data-action="confirmar-todas-duplas" style="margin-bottom:8px">✓ Confirmar todas (${pendentes} pendente${pendentes > 1 ? 's' : ''})</button>` : ''}
      <div class="chips">
        ${state.teams.map((t) => {
          const tel1 = t.telefone1 || t.telefone || '';
          const tel2 = t.telefone2 || '';
          return `<span class="chip ${t.oculto ? 'is-oculto' : ''}">${esc(t.name)}${t.categoria ? ` <em>(${esc(t.categoria)})</em>` : ''}${tel1 ? ` <span class="tel">📞${esc(tel1)}</span>` : ''}${tel2 ? ` <span class="tel">📞${esc(tel2)}</span>` : ''} <button class="conf-badge ${t.confirmada ? 'yes' : 'no'}" data-action="toggle-confirm-team" data-id="${t.id}" title="${t.confirmada ? 'Confirmada — clique pra marcar como pendente' : 'Pendente — clique pra confirmar'}">${t.confirmada ? '✓' : '⏳'}</button> <button class="vis-badge" data-action="toggle-oculto-team" data-id="${t.id}" title="${t.oculto ? 'Oculta do público — clique pra mostrar' : 'Visível ao público — clique pra ocultar'}">${t.oculto ? '🚫' : '👁'}</button> <button data-action="remove-team" data-id="${t.id}" data-nome="${esc(t.name)}">×</button></span>`;
        }).join('')}
      </div>
      <div class="row2">
        <input id="new-team-j1" placeholder="Nome jogador(a) 1" list="atletas-datalist" />
        <input id="new-team-tel1" placeholder="Telefone 1 (opcional)" />
      </div>
      <label class="checkbox-row"><input type="checkbox" id="new-team-sem-parceiro" data-action="toggle-sem-parceiro-admin" /> Sem parceiro(a) ainda</label>
      <div id="new-team-parceiro-wrap" class="row2">
        <input id="new-team-j2" placeholder="Nome jogador(a) 2" list="atletas-datalist" />
        <input id="new-team-tel2" placeholder="Telefone 2 (opcional)" />
      </div>
      <div class="row">
        ${showCatSelect ? `<select id="new-team-cat">${state.categorias.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>` : ''}
        <button data-action="add-team">Adicionar dupla</button>
      </div>
    </div>`;
}

function renderRounds(catRounds, catKey) {
  return `<div class="rounds">
    ${catRounds.map((rd, ri) => {
      const chave = `${catKey}-${ri}`;
      const todasJogadas = rd.matches.every((m) => partidaJogada(m));
      const recolhida = chave in rodadasEstadoManual ? rodadasEstadoManual[chave] : todasJogadas;
      const jogadasCount = rd.matches.filter((m) => partidaJogada(m)).length;
      return `
      <div class="round-block ${rd.isFinal ? 'is-final' : ''}">
        <div class="round-title round-title-toggle" data-action="toggle-rodada" data-chave="${chave}" data-recolhida="${recolhida ? '1' : '0'}">
          <span>${rd.isFinal ? '🏆 GRANDE FINAL' : `Rodada ${rd.round}`}${recolhida ? ` <em class="round-resumo">(${jogadasCount}/${rd.matches.length} jogadas)</em>` : ''}</span>
          ${rd.byes && rd.byes.length && !recolhida ? `<span class="bye">folga: ${rd.byes.map(nameOf).map(esc).join(', ')}</span>` : ''}
          <span class="round-toggle-icon">${recolhida ? '▼' : '▲'}</span>
        </div>
        ${recolhida ? '' : `<div class="matches">${rd.matches.map((m) => renderMatch(m, ri)).join('')}</div>`}
      </div>`;
    }).join('')}
  </div>`;
}
function quadraNome(state, courtNum) {
  return state.nomesQuadras[courtNum - 1] || `Quadra ${String(courtNum).padStart(2, '0')}`;
}
function renderScoreStepper(matchId, side, value, actionPrefix = 'score') {
  return `<div class="score-stepper">
    <button type="button" class="score-btn" data-action="${actionPrefix}-dec" data-match="${matchId}" data-side="${side}">−</button>
    <input type="number" min="0" class="score-input" data-action="${actionPrefix}-${side}" data-match="${matchId}" value="${value}" />
    <button type="button" class="score-btn" data-action="${actionPrefix}-inc" data-match="${matchId}" data-side="${side}">+</button>
  </div>`;
}
function renderMatch(m, ri) {
  const d = drafts[m.id] || { a: m.scoreA ?? '', b: m.scoreB ?? '' };
  const done = partidaJogada(m);
  const editing = editingMatches.has(m.id);
  const showInputs = isAdmin && (!done || editing);
  const ag = state.agendamentos[m.id] || {};
  return `
  <div class="match">
    <div class="match-head"><span class="court-tag">${esc(quadraNome(state, m.court))}</span>${ag.data ? `<span class="jogo-hora">🕐 ${formatData(ag.data)} ${esc(ag.hora || '')}</span>` : ''}${done && !editing ? '<span class="check">✓</span>' : ''}</div>
    <div class="team-row">
      <span class="team-name">${m.teamA.map(nameOf).map(esc).join(' + ')}</span>
      ${showInputs ? renderScoreStepper(m.id, 'a', d.a) : `<span class="score">${m.scoreA ?? '–'}</span>`}
    </div>
    <div class="vs">×</div>
    <div class="team-row">
      <span class="team-name">${m.teamB.map(nameOf).map(esc).join(' + ')}</span>
      ${showInputs ? renderScoreStepper(m.id, 'b', d.b) : `<span class="score">${m.scoreB ?? '–'}</span>`}
    </div>
    ${isAdmin && showInputs ? `<button class="btn-save" data-action="save-score" data-match="${m.id}">${done ? 'Salvar alteração' : 'Salvar placar'}</button>` : ''}
    ${isAdmin && done && !editing ? `<div class="saved-row"><span class="saved-tag">✓ Salvo</span><button class="btn-edit" data-action="edit-score" data-match="${m.id}">Editar</button></div>` : ''}
    ${isAdmin ? `
      <div class="row" style="margin-top:8px">
        <input type="date" class="agendamento-data" data-match="${m.id}" value="${esc(ag.data || '')}" />
        <input type="time" class="agendamento-hora" data-match="${m.id}" value="${esc(ag.hora || '')}" />
      </div>
    ` : ''}
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
  return `<div class="table-scroll"><table class="ranking"><thead><tr><th>#</th><th>Jogadora</th><th>J</th><th>V</th><th>Pts</th></tr></thead><tbody>
    ${stats.map((s, i) => `<tr><td class="${i < 3 ? 'top' : ''}">${i + 1}</td><td>${esc(s.name)}</td><td class="c">${s.partidas}</td><td class="c">${s.vitorias}</td><td class="pts">${s.pontos}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="hint" style="text-align:left;margin-top:8px">Critério de desempate: pontuação total → vitórias → confronto direto.</div>`;
}

// ---------- grupos + eliminatória (Chaves) ----------
function renderGroupsAndElimination(catGroups, catElim, catTeams, catKey) {
  if (!catGroups.length) return '';
  return `
    <div class="tabs">
      <button class="tab ${tab === 'rodadas' ? 'active' : ''}" data-action="tab" data-tab="rodadas">Chaveamento</button>
      <button class="tab ${tab === 'jogos' ? 'active' : ''}" data-action="tab" data-tab="jogos">Jogos</button>
      <button class="tab ${tab === 'aovivo' ? 'active' : ''}" data-action="tab" data-tab="aovivo">Ao Vivo</button>
    </div>
    ${tab === 'jogos' ? renderJogosView(catKey) : tab === 'aovivo' ? renderAoVivoModulo(catKey) : `
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
    ${!isAdmin ? `<div class="hint" style="text-align:left;margin-bottom:4px">V = vitórias · Saldo Sets = vitórias menos derrotas · Saldo Games = diferença de pontos</div>` : ''}
    ${empatou ? `<div class="hint" style="margin-bottom:8px">Houve empate em vitórias/saldo — desempate aplicado: vitórias → saldo de sets → confronto direto.</div>` : ''}
    <div class="matches">${g.matches.map((m) => renderGroupMatch(m)).join('')}</div>
  </div>`;
}
function renderGroupMatch(m) {
  const d = drafts[m.id] || { a: m.scoreA ?? '', b: m.scoreB ?? '' };
  const done = partidaJogada(m);
  const editing = editingMatches.has(m.id);
  const showInputs = isAdmin && (!done || editing);
  return `
  <div class="match">
    <div class="match-head"><span></span>${done && !editing ? '<span class="check">✓</span>' : ''}</div>
    <div class="team-row"><span class="team-name">${esc(teamNameOf(m.teamA))}</span>
      ${showInputs ? renderScoreStepper(m.id, 'a', d.a, 'gscore') : `<span class="score">${m.scoreA ?? '–'}</span>`}</div>
    <div class="vs">×</div>
    <div class="team-row"><span class="team-name">${esc(teamNameOf(m.teamB))}</span>
      ${showInputs ? renderScoreStepper(m.id, 'b', d.b, 'gscore') : `<span class="score">${m.scoreB ?? '–'}</span>`}</div>
    ${isAdmin && showInputs ? `<button class="btn-save" data-action="save-group-score" data-match="${m.id}">${done ? 'Salvar alteração' : 'Salvar placar'}</button>` : ''}
    ${isAdmin && done && !editing ? `<div class="saved-row"><span class="saved-tag">✓ Salvo</span><button class="btn-edit" data-action="edit-score" data-match="${m.id}">Editar</button></div>` : ''}
  </div>`;
}
function renderEliminationView(catElim) {
  const champion = catElim[catElim.length - 1][0]?.winner;
  return `<div class="rounds">
    ${champion ? `<div class="champion-banner">🏆 Campeã: ${esc(teamNameOf(champion))}</div>` : ''}
    ${catElim.map((rd) => `<div class="round-block"><div class="round-title"><span>${roundName(rd.length)}</span></div><div class="matches bracket-matches">${rd.map((m) => renderBracketMatch(m)).join('')}</div></div>`).join('')}
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
      ${isAdmin && !done ? renderScoreStepper(m.id, 'a', d.a, 'bscore') : `<span class="score">${m.scoreA ?? '–'}</span>`}</div>
    <div class="vs">×</div>
    <div class="team-row ${m.winner === m.teamB ? 'winner' : ''}"><span class="team-name">${esc(teamNameOf(m.teamB))}</span>
      ${isAdmin && !done ? renderScoreStepper(m.id, 'b', d.b, 'bscore') : `<span class="score">${m.scoreB ?? '–'}</span>`}</div>
    ${isAdmin && !done ? `<button class="btn-save" data-action="save-bracket-score" data-match="${m.id}">${savedFlash === m.id ? 'Salvo ✓' : 'Salvar placar'}</button>` : ''}
  </div>`;
}

function collectJogos(catKey) {
  const items = [];
  if (state.tipo === 'chaves') {
    state.grupos.filter((g) => g.categoria === catKey).forEach((g) => {
      g.matches.forEach((m) => items.push({ id: m.id, fase: g.nome, faseGrupo: g.nome, a: teamNameOf(m.teamA), b: teamNameOf(m.teamB), scoreA: m.scoreA, scoreB: m.scoreB }));
    });
    (state.eliminatorias[catKey] || []).forEach((rd) => {
      rd.forEach((m) => {
        if (m.isBye) return;
        items.push({ id: m.id, fase: roundName(rd.length), faseGrupo: roundName(rd.length), a: teamNameOf(m.teamA), b: teamNameOf(m.teamB), scoreA: m.scoreA, scoreB: m.scoreB });
      });
    });
  } else {
    (state.rounds[catKey] || []).forEach((rd) => {
      const faseBase = rd.isFinal ? 'Final' : `Rodada ${rd.round}`;
      rd.matches.forEach((m) => items.push({ id: m.id, fase: `${faseBase} · ${quadraNome(state, m.court)}`, faseGrupo: faseBase, a: m.teamA.map(nameOf).join(' + '), b: m.teamB.map(nameOf).join(' + '), scoreA: m.scoreA, scoreB: m.scoreB, court: m.court }));
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
    <label class="checkbox-row"><input type="checkbox" id="login-manter-conectado" checked /> Manter conectado neste dispositivo</label>
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
    if (action === 'ir-jogos') el.addEventListener('click', () => { painelAdmin = null; tab = state.tipo === 'chaves' ? 'jogos' : 'rodadas'; render(); });
    if (action === 'voltar-lobby') el.addEventListener('click', () => selecionarTorneio(null));
    if (action === 'abrir-torneio') el.addEventListener('click', () => selecionarTorneio(el.dataset.id));
    if (action === 'publicar-torneio') el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = el.dataset.id;
      const novoValor = el.dataset.atual !== '1';
      try { await set(ref(db, 'torneios/' + id + '/visivelPublico'), novoValor); } catch (err) { console.error(err); }
    });
    if (action === 'encerrar-torneio') el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = el.dataset.id;
      const novoValor = el.dataset.atual !== '1';
      try { await set(ref(db, 'torneios/' + id + '/encerrado'), novoValor); } catch (err) { console.error(err); }
    });
    if (action === 'remover-torneio') el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = el.dataset.id;
      const nome = el.dataset.nome;
      if (!confirm(`Remover "${nome}" definitivamente? Essa ação não pode ser desfeita — todos os dados desse torneio serão apagados.`)) return;
      try { await set(ref(db, 'torneios/' + id), null); } catch (err) { console.error(err); }
    });
    if (action === 'sel-tipo-novo') el.addEventListener('click', () => {
      document.querySelectorAll('.tipo-novo-torneio').forEach((b) => b.classList.remove('active'));
      el.classList.add('active');
      document.querySelector('[data-action="criar-torneio"]').dataset.tipo = el.dataset.tipo;
    });
    if (action === 'criar-torneio') el.addEventListener('click', () => {
      const nomeInput = document.getElementById('novo-torneio-nome');
      const nome = nomeInput.value.trim();
      if (!nome) {
        alert('Preencha o nome do torneio antes de criar.');
        nomeInput.focus();
        return;
      }
      const quadras = document.getElementById('novo-torneio-quadras')?.value;
      criarNovoTorneio(nome, el.dataset.tipo, quadras);
    });
    if (action === 'lobby-set-status') el.addEventListener('change', () => { lobbyFiltroStatus = el.value; renderLobby(); });
    if (action === 'lobby-set-tipo') el.addEventListener('change', () => { lobbyFiltroTipo = el.value; renderLobby(); });
    if (action === 'set-tipo') el.addEventListener('click', () => setTipoHandler(el.dataset.tipo));
    if (action === 'toggle-inscricoes') el.addEventListener('click', () => persist({ ...state, inscricoesAbertas: !state.inscricoesAbertas }));
    if (action === 'toggle-visivel') el.addEventListener('click', () => persist({ ...state, visivelPublico: !state.visivelPublico }));
    if (action === 'compartilhar-whatsapp') el.addEventListener('click', () => compartilharTorneioHandler());
    if (action === 'abrir-modo-tv') el.addEventListener('click', () => {
      window.open(`${window.location.origin}${window.location.pathname}?t=${currentTournamentId}&tv=1`, '_blank');
    });
    if (action === 'toggle-rodada') el.addEventListener('click', () => {
      const chave = el.dataset.chave;
      const atualRecolhida = el.dataset.recolhida === '1';
      rodadasEstadoManual[chave] = !atualRecolhida;
      render();
    });
    if (action === 'toggle-atletas-conhecidos') el.addEventListener('click', () => { mostrarAtletasConhecidos = !mostrarAtletasConhecidos; render(); });
    if (action === 'toggle-inscritos-publico') el.addEventListener('click', () => { inscritosVisiveis = !inscritosVisiveis; render(); });
    if (action === 'atleta-salvar') el.addEventListener('click', () => editarAtletaHandler(el.dataset.chave));
    if (action === 'atleta-remover') el.addEventListener('click', () => removerAtletaHandler(el.dataset.chave, el.dataset.nome));
    if (action === 'toggle-notificacoes') el.addEventListener('click', toggleNotificacoesHandler);
    if (action === 'set-data-inicio') el.addEventListener('change', () => persist({ ...state, dataInicio: el.value }));
    if (action === 'set-data-fim') el.addEventListener('change', () => persist({ ...state, dataFim: el.value }));
    if (action === 'sel-cat') el.addEventListener('click', () => { selectedCategoria = el.dataset.cat; tab = 'rodadas'; render(); });
    if (action === 'jogos-filtro-data') el.addEventListener('click', () => { jogosFiltroData = el.dataset.data; render(); });
    if (action === 'gerar-horarios') el.addEventListener('click', () => gerarHorariosHandler(el.dataset.cat));
    if (action === 'add-cat') el.addEventListener('click', addCategoriaHandler);
    if (action === 'add-cat-sugg') el.addEventListener('click', () => addCategoria(el.dataset.cat));
    if (action === 'remove-cat') el.addEventListener('click', () => removeCategoriaHandler(el.dataset.cat));
    if (action === 'remove-player') el.addEventListener('click', () => {
      const nome = el.dataset.nome || 'esta jogadora';
      if (!confirm(`Remover "${nome}" do torneio? Essa ação não pode ser desfeita.`)) return;
      persist({ ...state, players: state.players.filter((p) => p.id !== el.dataset.id) });
    });
    if (action === 'toggle-confirm-player') el.addEventListener('click', () => toggleConfirmHandler('players', el.dataset.id));
    if (action === 'toggle-confirm-team') el.addEventListener('click', () => toggleConfirmHandler('teams', el.dataset.id));
    if (action === 'confirmar-todas-jogadoras') el.addEventListener('click', () => persist({ ...state, players: state.players.map((p) => ({ ...p, confirmada: true })) }));
    if (action === 'confirmar-todas-duplas') el.addEventListener('click', () => persist({ ...state, teams: state.teams.map((t) => ({ ...t, confirmada: true })) }));
    if (action === 'toggle-oculto-player') el.addEventListener('click', () => toggleOcultoHandler('players', el.dataset.id));
    if (action === 'toggle-oculto-team') el.addEventListener('click', () => toggleOcultoHandler('teams', el.dataset.id));
    if (action === 'add-player') el.addEventListener('click', addPlayerHandler);
    if (action === 'remove-team') el.addEventListener('click', () => {
      const nome = el.dataset.nome || 'esta dupla';
      if (!confirm(`Remover "${nome}" do torneio? Essa ação não pode ser desfeita.`)) return;
      persist({ ...state, teams: state.teams.filter((t) => t.id !== el.dataset.id) });
    });
    if (action === 'add-team') el.addEventListener('click', addTeamHandler);
    if (action === 'toggle-sem-parceiro-admin') el.addEventListener('change', () => {
      document.getElementById('new-team-parceiro-wrap').style.display = el.checked ? 'none' : '';
    });
    if (action === 'toggle-sem-parceiro-pub') el.addEventListener('change', () => {
      document.getElementById('pub-team-parceiro-wrap').style.display = el.checked ? 'none' : '';
    });
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
    if (action === 'usar-cobertura-total') el.addEventListener('click', () => {
      const catKey = currentCategoria();
      const numJogadoras = state.players.filter((p) => categoriaOf(p) === catKey).length;
      const minimo = Number(el.dataset.min);
      const rodadas = proximoRoundsValidoApartirDe(numJogadoras, state.numCourts, minimo);
      persist({ ...state, numRounds: Math.min(30, rodadas) });
    });
    if (action === 'calcular-rodadas-por-jogos') el.addEventListener('click', () => {
      const desejado = Number(document.getElementById('jogos-por-jogadora').value);
      const resultadoEl = document.getElementById('jogos-por-jogadora-resultado');
      if (!desejado || desejado < 1) { if (resultadoEl) resultadoEl.textContent = 'Digite quantos jogos por jogadora primeiro.'; return; }
      const catKey = currentCategoria();
      const numJogadoras = state.players.filter((p) => categoriaOf(p) === catKey).length;
      const minimo = minRoundsForGamesPerPlayer(numJogadoras, state.numCourts, desejado);
      if (minimo === 0) { if (resultadoEl) resultadoEl.textContent = 'Cadastre pelo menos 4 jogadoras na categoria atual primeiro.'; return; }
      const rodadas = proximoRoundsValidoApartirDe(numJogadoras, state.numCourts, minimo);
      persist({ ...state, numRounds: Math.min(30, rodadas) });
    });
    if (action === 'set-hora-inicio-torneio') el.addEventListener('change', () => persist({ ...state, horaInicioTorneio: el.value }));
    if (action === 'set-duracao-jogo-min') el.addEventListener('change', () => persist({ ...state, duracaoJogoMin: Math.max(1, Number(el.value) || 40) }));
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
    if (['score-inc', 'score-dec', 'gscore-inc', 'gscore-dec', 'bscore-inc', 'bscore-dec'].includes(action)) {
      el.addEventListener('click', () => {
        const id = el.dataset.match;
        const side = el.dataset.side;
        const cur = drafts[id] || { a: '', b: '' };
        const atual = Number(cur[side]) || 0;
        const novo = Math.max(0, atual + (action.endsWith('-inc') ? 1 : -1));
        drafts[id] = { ...cur, [side]: novo };
        const input = el.parentElement.querySelector('.score-input');
        if (input) input.value = novo;
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
  ['new-team-j1', 'new-team-tel1', 'new-team-j2', 'new-team-tel2'].forEach((id) => {
    document.getElementById(id)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTeamHandler(); });
  });
  const pubPlayerInput = document.getElementById('pub-player-name');
  if (pubPlayerInput) pubPlayerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pubAddPlayerHandler(); });
  const pubPlayerPhone = document.getElementById('pub-player-phone');
  if (pubPlayerPhone) pubPlayerPhone.addEventListener('keydown', (e) => { if (e.key === 'Enter') pubAddPlayerHandler(); });
  ['pub-team-j1', 'pub-team-tel1', 'pub-team-j2', 'pub-team-tel2'].forEach((id) => {
    document.getElementById(id)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') pubAddTeamHandler(); });
  });
  const buscaInput = document.getElementById('busca-atleta');
  if (buscaInput) buscaInput.addEventListener('input', () => {
    const termo = buscaInput.value.trim().toLowerCase();
    document.querySelectorAll('.round-block').forEach((block) => {
      let algumVisivel = false;
      const naChave = new Set(block.querySelectorAll('.bracket-matches .match'));
      block.querySelectorAll('.match').forEach((m) => {
        if (naChave.has(m)) {
          // fase eliminatória: nunca esconde (quebraria a chave), só destaca "você está aqui"
          const acha = termo && m.textContent.toLowerCase().includes(termo);
          m.classList.toggle('match-destaque', acha);
          algumVisivel = true;
        } else {
          const show = !termo || m.textContent.toLowerCase().includes(termo);
          m.style.display = show ? '' : 'none';
          if (show) algumVisivel = true;
        }
      });
      block.style.display = algumVisivel ? '' : 'none';
    });
  });
  const newCatInput = document.getElementById('new-cat');
  if (newCatInput) newCatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCategoriaHandler(); });
  const lobbyBuscaInput = document.getElementById('lobby-busca');
  if (lobbyBuscaInput) lobbyBuscaInput.addEventListener('input', () => {
    const termo = lobbyBuscaInput.value.trim().toLowerCase();
    document.querySelectorAll('.lobby-row').forEach((row) => {
      const nome = row.children[0]?.textContent.toLowerCase() || '';
      row.style.display = (!termo || nome.includes(termo)) ? '' : 'none';
    });
  });
  [['pub-player-name', 'pub-player-phone'], ['pub-team-j1', 'pub-team-tel1'], ['pub-team-j2', 'pub-team-tel2'], ['new-team-j1', 'new-team-tel1'], ['new-team-j2', 'new-team-tel2']].forEach(([nomeId, telId]) => {
    const nomeEl = document.getElementById(nomeId);
    const telEl = document.getElementById(telId);
    if (!nomeEl || !telEl) return;
    nomeEl.addEventListener('change', () => {
      if (telEl.value) return; // não sobrescreve telefone já digitado
      const conhecido = atletasConhecidos[nomeEl.value.trim().toLowerCase()];
      if (conhecido && conhecido.telefone) telEl.value = conhecido.telefone;
    });
  });
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
function compartilharTorneioHandler() {
  if (!state.visivelPublico) {
    if (!confirm('Esse torneio ainda está oculto pro público — quem receber o link vai ver "não disponível". Publicar agora e compartilhar?')) return;
    persist({ ...state, visivelPublico: true });
  }
  const link = `${window.location.origin}${window.location.pathname}?t=${currentTournamentId}`;
  const mensagem = `🎾 ${state.name}\nAcompanhe rodadas, ranking e resultados ao vivo, direto do celular:\n${link}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(mensagem)}`, '_blank');
}

async function tryUnlock() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value.toLowerCase();
  const manterConectado = document.getElementById('login-manter-conectado')?.checked;
  const btn = document.querySelector('[data-action="try-unlock"]');
  if (btn) btn.textContent = 'Entrando...';
  try {
    await setPersistence(auth, manterConectado ? browserLocalPersistence : browserSessionPersistence);
    await signInWithEmailAndPassword(auth, user.toLowerCase() + ADMIN_EMAIL_DOMAIN, pass);
    closePinModal();
    // onAuthStateChanged já cuida de levar pra Central de Gestão quando vira admin
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
  lembrarAtleta(name, '');
}
function addTeamHandler() {
  const j1 = document.getElementById('new-team-j1').value.trim();
  if (!j1) return;
  const tel1 = document.getElementById('new-team-tel1').value.trim();
  const semParceiro = document.getElementById('new-team-sem-parceiro').checked;
  const j2 = semParceiro ? '' : document.getElementById('new-team-j2').value.trim();
  const tel2 = semParceiro ? '' : document.getElementById('new-team-tel2').value.trim();
  const catSelect = document.getElementById('new-team-cat');
  const categoria = catSelect ? catSelect.value : '';
  const name = montarNomeDupla(j1, j2, semParceiro);
  persist({ ...state, teams: [...state.teams, { id: uid(), name, jogador1: j1, telefone1: tel1, jogador2: j2, telefone2: tel2, semParceiro, categoria, confirmada: true, oculto: false }] });
  lembrarAtleta(j1, tel1);
  if (j2) lembrarAtleta(j2, tel2);
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
  lembrarAtleta(name, telefone);
  nameInput.value = ''; phoneInput.value = '';
  pubSignupFlash = `"${name}" inscrita(o) ✓ (aguardando confirmação do organizador)`;
  render();
  setTimeout(() => { pubSignupFlash = null; render(); }, 3500);
}
function pubAddTeamHandler() {
  const j1 = document.getElementById('pub-team-j1').value.trim();
  const tel1 = document.getElementById('pub-team-tel1').value.trim();
  const semParceiro = document.getElementById('pub-team-sem-parceiro').checked;
  const j2 = semParceiro ? '' : document.getElementById('pub-team-j2').value.trim();
  const tel2 = semParceiro ? '' : document.getElementById('pub-team-tel2').value.trim();
  if (!j1 || !tel1) { alert('Preencha seu nome e telefone pra se inscrever.'); return; }
  if (!semParceiro && !j2) { alert('Preencha o nome do(a) parceiro(a), ou marque "sem parceiro(a)".'); return; }
  const catKey = currentCategoria();
  const categoria = catKey === DEFAULT_CAT ? '' : catKey;
  const name = montarNomeDupla(j1, j2, semParceiro);
  persist({ ...state, teams: [...state.teams, { id: uid(), name, jogador1: j1, telefone1: tel1, jogador2: j2, telefone2: tel2, semParceiro, categoria, confirmada: false, oculto: false }] });
  lembrarAtleta(j1, tel1);
  if (j2) lembrarAtleta(j2, tel2);
  document.getElementById('pub-team-j1').value = '';
  document.getElementById('pub-team-tel1').value = '';
  document.getElementById('pub-team-j2').value = '';
  document.getElementById('pub-team-tel2').value = '';
  document.getElementById('pub-team-sem-parceiro').checked = false;
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
function agendamentosAutoParaRounds(roundsPorCategoria, dataInput, horaInput, duracao, agendamentosBase) {
  const agendamentos = { ...agendamentosBase };
  Object.values(roundsPorCategoria).forEach((catRounds) => {
    const [h, m] = horaInput.split(':').map(Number);
    let cursorMin = h * 60 + m;
    catRounds.forEach((rd) => {
      const horaStr = `${String(Math.floor(cursorMin / 60) % 24).padStart(2, '0')}:${String(cursorMin % 60).padStart(2, '0')}`;
      rd.matches.forEach((m2) => { agendamentos[m2.id] = { data: dataInput, hora: horaStr }; });
      cursorMin += duracao;
    });
  });
  return agendamentos;
}
function agendamentosAutoParaGrupos(novosGrupos, dataInput, horaInput, duracao, agendamentosBase) {
  const agendamentos = { ...agendamentosBase };
  const porCategoria = {};
  novosGrupos.forEach((g) => { (porCategoria[g.categoria] ||= []).push(g); });
  Object.values(porCategoria).forEach((grupos) => {
    const [h, m] = horaInput.split(':').map(Number);
    let cursorMin = h * 60 + m;
    grupos.forEach((g) => {
      const horaStr = `${String(Math.floor(cursorMin / 60) % 24).padStart(2, '0')}:${String(cursorMin % 60).padStart(2, '0')}`;
      g.matches.forEach((m2) => { agendamentos[m2.id] = { data: dataInput, hora: horaStr }; });
      cursorMin += duracao;
    });
  });
  return agendamentos;
}
function sortearHandler() {
  for (const catKey of categoriaKeys(state)) {
    const catPlayers = state.players.filter((p) => categoriaOf(p) === catKey);
    if (catPlayers.length < 4) continue;
    const maxCourts = Math.max(1, Math.floor(catPlayers.length / 4));
    const courtsReais = Math.min(state.numCourts, maxCourts);
    if (!distribuicaoEhJusta(catPlayers.length, courtsReais, state.numRounds)) {
      const catLabelTxt = catKey === DEFAULT_CAT ? '' : ` na categoria "${catLabel(catKey)}"`;
      const numeroImpar = catPlayers.length % 2 === 1;
      const sugestao = numeroImpar
        ? 'Com número ímpar de jogadoras, não dá pra sortear direto com esse número de rodadas. Use o campo "quantos jogos cada jogadora deve jogar" (em Quadras e Rodadas) — ele calcula e preenche um número de rodadas que funciona automaticamente.'
        : `Rodadas que resultam em jogos 100% iguais pra todas: ${proximosRoundsValidos(catPlayers.length, courtsReais).join(', ')}.\n\nAjuste o número de rodadas e tente sortear de novo.`;
      alert(`Com ${catPlayers.length} jogadoras${catLabelTxt} e ${courtsReais} quadra(s), ${state.numRounds} rodada(s) NÃO permite que todas joguem exatamente a mesma quantidade de jogos — alguém jogaria a mais e alguém a menos.\n\n${sugestao}`);
      return;
    }
  }
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
  const novoState = { ...state, rounds: newRounds };
  if (state.dataInicio && state.horaInicioTorneio) {
    novoState.agendamentos = agendamentosAutoParaRounds(newRounds, state.dataInicio, state.horaInicioTorneio, state.duracaoJogoMin || 40, state.agendamentos);
  }
  persist(novoState);
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
  const novoState = { ...state, grupos: novosGrupos, eliminatorias: {} };
  if (state.dataInicio && state.horaInicioTorneio) {
    novoState.agendamentos = agendamentosAutoParaGrupos(novosGrupos, state.dataInicio, state.horaInicioTorneio, state.duracaoJogoMin || 40, state.agendamentos);
  }
  persist(novoState);
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
    const chave = it.faseGrupo || it.fase;
    if (!byFase[chave]) { byFase[chave] = []; faseOrder.push(chave); }
    byFase[chave].push(it);
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
  if (!d) return;
  const bothEmpty = d.a === '' && d.b === '';
  const bothFilled = d.a !== '' && d.b !== '';
  if (!bothEmpty && !bothFilled) return;
  const a = bothEmpty ? null : Number(d.a);
  const b = bothEmpty ? null : Number(d.b);
  if (!bothEmpty && a === b) { alert('Não pode empatar — ajuste o placar.'); return; }
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
  if (!d) return;
  const bothEmpty = d.a === '' && d.b === '';
  const bothFilled = d.a !== '' && d.b !== '';
  if (!bothEmpty && !bothFilled) return;
  const a = bothEmpty ? null : Number(d.a);
  const b = bothEmpty ? null : Number(d.b);
  const newRounds = { ...state.rounds };
  Object.keys(newRounds).forEach((catKey) => {
    newRounds[catKey] = newRounds[catKey].map((rd) => ({ ...rd, matches: rd.matches.map((m) => m.id === matchId ? { ...m, scoreA: a, scoreB: b } : m) }));
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
