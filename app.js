import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, onValue, set, get } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, setPersistence, browserLocalPersistence, browserSessionPersistence } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  uid, pairKey, DEFAULT_CAT, CATEGORIA_SUGESTOES, ativosPorRodadaReal, partidaJogada, defaultState,
  categoriaOf, categoriaKeys, scoreGroup, bestPairing, gerarParceriasRoundRobin, particoesEmPares,
  coberturaDeConfrontos, buscarConfrontosCobrindoTudo, gerarRodadasGarantidas, gerarRodadasComByesJustos, generateSchedule,
  computeStats, minRoundsForFullCoverage, minRoundsForGamesPerPlayer, distribuicaoEhJusta,
  proximosRoundsValidos, proximoRoundsValidoApartirDe, roundsWithoutScores, generateFinalRound,
  shuffleArr, generateGroups, computeGroupStandings, nextPow2, roundName, seedOrder,
  repairSameGroupClashes, propagateWinner, generateEliminationFromGroups, allGroupMatchesScored,
  horaParaMinutos, minutosParaHora, ajustarCursorParaPausa, maiorSequenciaSemFolga,
} from './scheduling.js';


const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
const torneiosRef = ref(db, 'torneios');
const atletasRef = ref(db, 'atletas');
const pixConfigRef = ref(db, 'config/pix');
const ADMIN_EMAIL_DOMAIN = '@hitpadel.local';


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
let jogoSelecionadoParaTroca = null; // id do jogo marcado pra trocar quadra/horário com outro (2 cliques)
let rodadaSelecionadaParaTroca = null; // { catKey, indice } — rodada do Americano marcada pra trocar de lugar com outra (2 cliques)
let pubSignupFlash = null;
let currentTournamentId = null;
let avisoDemoraMostrado = false;
let timerAvisoDemora = null;
function agendarAvisoSeDemorar() {
  if (timerAvisoDemora || avisoDemoraMostrado) return;
  timerAvisoDemora = setTimeout(() => {
    avisoDemoraMostrado = true;
    timerAvisoDemora = null;
    // Sem resposta do Firebase depois de 4s e ninguém logado como admin: tenta a última versão
    // salva neste aparelho em vez de deixar a jogadora presa no spinner. Só pra visão pública —
    // admin nunca edita em cima de um estado potencialmente desatualizado (ver persist()/gravação
    // do cache em carregarTorneioAtual).
    if (!state && !isAdmin && currentTournamentId) {
      const cache = lerCacheTorneio(currentTournamentId);
      if (cache) { state = cache; usandoCacheOffline = true; }
    }
    render();
  }, 4000);
}
function cancelarAvisoDemora() {
  if (timerAvisoDemora) { clearTimeout(timerAvisoDemora); timerAvisoDemora = null; }
  avisoDemoraMostrado = false;
}
const AVISO_DEMORA_HTML = '<div class="hint" style="margin-top:10px">Isso está demorando mais que o normal — geralmente é a conexão do aparelho. Continue aguardando ou tente recarregar a página.</div>';
function torneioCacheKey(tid) { return `hitpadel_cache_${tid}`; }
function lerCacheTorneio(tid) {
  try {
    const raw = localStorage.getItem(torneioCacheKey(tid));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
// Lembra o que a jogadora digitou em "🔍 Buscar por atleta" (por torneio, neste aparelho) — só
// pra pré-preencher a busca e personalizar o banner "Próximo jogo" nas próximas visitas. Nunca é
// usado pra decidir permissão de nada (ex: pagamento), só pra conveniência de exibição.
function buscaLembradaKey(tid) { return `hitpadel_busca_${tid}`; }
function lerBuscaLembrada(tid) {
  try { return localStorage.getItem(buscaLembradaKey(tid)) || ''; } catch (e) { return ''; }
}
function lembrarBusca(tid, termo) {
  try { localStorage.setItem(buscaLembradaKey(tid), termo); } catch (e) { /* localStorage indisponível: só perde a personalização */ }
}
let torneiosList = null;       // null = ainda carregando; {} ou {id: dados} depois
let rodadasEstadoManual = {}; // chave "catKey-ri" -> true (recolhida) / false (aberta), fixado explicitamente ao clicar
let atletasConhecidos = {};    // { nomeLowerCase: { nome, telefone } } — cadastro compartilhado entre todos os torneios do clube, só pra autocompletar
let unsubscribeTournament = null;
let usandoCacheOffline = false; // true quando o estado exibido veio do localStorage (sem sinal), não do Firebase ao vivo
let painelAdmin = null;        // null = grade de módulos | 'config' | 'quadras' | 'inscricoes' | 'duplas' | 'chaveamento' | 'jogos'
let novoTorneioNome = '';
let tvSlide = 0;
let tvTimer = null;
let lobbyFiltroTipo = 'todos';
let mostrarAtletasConhecidos = false;
let lobbyFiltroStatus = 'todos';
let inscritosVisiveis = true;
let pixConfig = { chave: '', nome: '', cidade: '' }; // config/pix — uma chave só, compartilhada por todos os torneios do clube
let pubPagamentoAtivo = null; // { list: 'players'|'teams', id } — controla o card de pagamento aberto na tela pública após inscrição
let pubPagamentoCarregando = false; // não usado no fluxo atual (chave Pix é exibida na hora) — mantido só por segurança de estado
let pubPagamentoErroMsg = null; // mensagem de erro (ex.: organizador sem chave Pix configurada)
let pubComprovanteEnviando = false; // true enquanto o comprovante está subindo pro Storage
let pubComprovanteErroMsg = null; // erro do envio do comprovante

// ---------- Reserva de quadra (agenda avulsa, independente de torneio) ----------
// Grade fixa de horários do dia — 1h30 por reserva. O de 21:30 começa só 30min depois do anterior,
// pra aproveitar até o fechamento, mas a reserva em si dura 1h30 do mesmo jeito (termina 23:00).
// Ajuste esta lista pra mudar a grade — nada é recalculado na mão em nenhum outro lugar.
const HORARIOS_RESERVA = ['09:00', '10:30', '12:00', '13:30', '15:00', '16:30', '18:00', '19:30', '21:00', '21:30'];
const DURACAO_RESERVA_MIN = 90;
const DIAS_ANTECEDENCIA_RESERVA = 7; // mostra/permite de hoje até +7 dias
let reservasView = false;
let quadrasReserva = null;   // null = carregando | [{ id, nome }] (config/quadrasReserva)
let reservasData = null;     // null = carregando | { [data]: { [quadraId]: { [horario]: reserva } } }
let unsubQuadrasReserva = null;
let unsubReservas = null;
let selectedReservaData = null;   // 'YYYY-MM-DD'
let reservaModal = null;          // { modo:'novo'|'pagamento'|'editar', data, quadraId, horario, id? }
let reservaFlash = null;          // mensagem de sucesso curta (admin)
let reservaEnviandoComprovante = false;
let reservaErroMsg = null;

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
function getUrlParam(nome) {
  return new URLSearchParams(window.location.search).get(nome);
}
// Reflete categoria/aba selecionadas na URL (replaceState — não polui o histórico a cada clique de
// aba) pra um link copiado da barra de endereço, ou um F5, cair no mesmo lugar de volta.
function syncUrlEstadoView() {
  const url = new URL(window.location.href);
  if (selectedCategoria) url.searchParams.set('cat', selectedCategoria); else url.searchParams.delete('cat');
  if (tab && tab !== 'rodadas') url.searchParams.set('tab', tab); else url.searchParams.delete('tab');
  window.history.replaceState({}, '', url);
}

function selecionarTorneio(id) {
  currentTournamentId = id;
  painelAdmin = null;
  tab = 'rodadas';
  selectedCategoria = null;
  pubPagamentoAtivo = null;
  pubPagamentoCarregando = false;
  pubPagamentoErroMsg = null;
  pubComprovanteEnviando = false;
  pubComprovanteErroMsg = null;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('t', id); else url.searchParams.delete('t');
  url.searchParams.delete('cat'); url.searchParams.delete('tab');
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
  usandoCacheOffline = false;
  if (!currentTournamentId) { state = null; return; }
  const tid = currentTournamentId;
  const r = ref(db, 'torneios/' + tid);
  unsubscribeTournament = onValue(r, (snap) => {
    if (snap.exists()) { state = { ...defaultState(), ...snap.val() }; }
    else { state = defaultState(); set(r, state); }
    usandoCacheOffline = false;
    try { localStorage.setItem(torneioCacheKey(tid), JSON.stringify(state)); } catch (e) { /* localStorage cheio/bloqueado: cache offline só não fica disponível, resto do app segue normal */ }
    verificarNovasInscricoes(state);
    render();
  });
}

async function criarNovoTorneio(nome, tipo, numCourts, valorInscricao) {
  const id = uid() + uid();
  const novo = { ...defaultState(), name: nome || 'Novo torneio', tipo: tipo || 'americano', numCourts: Math.max(1, Math.min(20, Number(numCourts) || 2)), valorInscricao: Math.max(0, Number(valorInscricao) || 0), criadoEm: Date.now() };
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
onValue(pixConfigRef, (snap) => {
  pixConfig = snap.val() || { chave: '', nome: '', cidade: '' };
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
// Chave Pix da conta — uma só, compartilhada por todos os torneios (config/pix). É exibida em texto
// pro atleta pagar manualmente; não guarda nenhum dado bancário além do que já é público num Pix.
function pixSalvarHandler() {
  const chave = document.getElementById('pix-chave').value.trim();
  const nome = document.getElementById('pix-nome').value.trim();
  const cidade = document.getElementById('pix-cidade').value.trim();
  if (!chave) { alert('Preencha a chave Pix.'); return; }
  if (!nome) { alert('Preencha o nome do recebedor.'); return; }
  if (!cidade) { alert('Preencha a cidade.'); return; }
  set(pixConfigRef, { chave, nome, cidade }).catch((e) => { console.error('Falha ao salvar chave Pix', e); alert('Erro ao salvar a chave Pix. Tente de novo.'); });
}

currentTournamentId = getUrlTournamentId();
selectedCategoria = getUrlParam('cat') || null;
tab = getUrlParam('tab') || 'rodadas';
if (getUrlParam('reservas') === '1') entrarReservas();
else if (currentTournamentId) carregarTorneioAtual();
window.addEventListener('popstate', () => {
  currentTournamentId = getUrlTournamentId();
  selectedCategoria = getUrlParam('cat') || null;
  tab = getUrlParam('tab') || 'rodadas';
  if (getUrlParam('reservas') === '1') { entrarReservas(); return; }
  if (reservasView) sairReservas();
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

// ---------- Pix (chave estática exibida em texto) — sem gateway de pagamento, sem QR Code ----------
function formatMoeda(v) { return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function copiarPixHandler(texto) {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignora — clipboard indisponível */ }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).catch(fallback);
  else fallback();
  alert('Chave Pix copiada! Cole no app do seu banco pra pagar.');
}

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
  const termoLembrado = currentTournamentId ? lerBuscaLembrada(currentTournamentId) : '';
  const meuJogo = meuProximoJogo(catKey, termoLembrado);
  if (meuJogo) {
    return `
      <div class="proxima-banner">
        <div class="proxima-banner-label">🎾 Seu próximo jogo</div>
        <div class="proxima-banner-info">${formatData(meuJogo.data)} às ${esc(meuJogo.hora)}</div>
        <div class="proxima-banner-jogo">${esc(meuJogo.a)} <span class="vs-inline">×</span> ${esc(meuJogo.b)}</div>
      </div>
    `;
  }
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
  if (reservasView) { renderReservas(); return; }
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
      ${usandoCacheOffline ? `<div class="alerta-atraso">📡 Sem conexão agora — mostrando a última versão salva neste aparelho. Atualiza sozinho assim que a internet voltar.</div>` : ''}
      ${isAdmin ? renderAdminDashboard(maxCourts, catPlayers, catTeams) : ''}
      ${ocultoDoPublico ? '<div class="hint" style="margin-top:16px">Este torneio ainda não está disponível pra visualização pública.</div>' : `
      ${!isAdmin && (catRounds.length || catGroups.length) ? renderBuscaAtleta() : ''}
      ${!isAdmin ? renderProximaPartidaPublica(catKey) : ''}
      ${catKeys.length > 1 ? renderCategoriaTabs(catKeys, catKey) : ''}
      ${renderInscricaoPublica()}
      ${!isAdmin ? renderPagamentoCard() : ''}
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
          <div class="card-head-static">💳 Receber pagamentos (Pix)</div>
          <div class="card-body">
            <div class="hint" style="text-align:left;margin-bottom:4px">Configure sua chave Pix uma vez só — ela aparece em texto pro atleta pagar em qualquer torneio que tiver valor de inscrição.</div>
            <div class="field"><label>Chave Pix</label><input id="pix-chave" placeholder="CPF, e-mail, telefone ou chave aleatória" value="${esc(pixConfig.chave || '')}" /></div>
            <div class="row2">
              <div class="field"><label>Nome do recebedor</label><input id="pix-nome" placeholder="Seu nome ou do clube" value="${esc(pixConfig.nome || '')}" /></div>
              <div class="field"><label>Cidade</label><input id="pix-cidade" placeholder="Ex: Tuparendi" value="${esc(pixConfig.cidade || '')}" /></div>
            </div>
            <button class="btn-primary" data-action="pix-salvar">Salvar chave Pix</button>
            <div class="hint" style="text-align:left">${pixConfig.chave ? '✓ Chave Pix configurada — já aparece pra quem se inscrever em torneios com valor.' : '⚠ Sem chave Pix configurada, torneios com valor de inscrição não conseguem mostrar a chave pra pagamento.'}</div>
          </div>
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
            <div class="field">
              <label>Valor da inscrição (R$) — opcional</label>
              <input type="number" min="0" step="0.01" id="novo-torneio-valor" placeholder="0,00 = torneio gratuito" />
              <div class="hint" style="text-align:left;margin-top:4px">No "Torneio" (chaves), o valor é sempre cobrado por dupla inteira. No Americano/Americano + Final, é por atleta.</div>
            </div>
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
        <div class="hp-header-actions">
          <button class="hp-back-btn" data-action="abrir-reservas">🎾 Reservar quadra</button>
          <button class="hp-admin-btn ${isAdmin ? 'on' : ''}" data-action="toggle-admin">${isAdmin ? 'Admin' : 'Ver como admin'}</button>
        </div>
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
  const temValor = state.valorInscricao > 0;
  const avisoValor = temValor ? `<div class="hint" style="text-align:left;margin-bottom:8px">💰 Inscrição: <strong>${formatMoeda(state.valorInscricao)}</strong>${state.tipo === 'chaves' ? ' por dupla (mesmo sem parceiro(a) ainda)' : ' por atleta'}. Ao inscrever, aparece a chave Pix pra pagar e anexar o comprovante — a inscrição fica pendente até o organizador confirmar o pagamento.</div>` : '';
  if (state.tipo === 'chaves') {
    return `
    <section class="card signup-card">
      <div class="card-body">
        <div class="field">
          <label>📝 Inscreva sua dupla${catLabelTxt}</label>
          ${avisoValor}
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
          ${avisoValor}
          <input id="pub-player-name" placeholder="Seu nome" style="margin-bottom:8px" list="atletas-datalist" />
          <div class="row"><input id="pub-player-phone" type="tel" placeholder="Telefone (whatsapp)" /><button data-action="pub-add-player">Inscrever</button></div>
          ${flashMsg}
        </div>
      </div>
    </section>`;
}
// Card de pagamento Pix — abre sozinho logo após a inscrição (quando o torneio tem valor) e também pode
// ser reaberto clicando em "Pagar" na lista de inscritas, pra quem fechou sem pagar ainda.
function renderPagamentoCard() {
  if (!pubPagamentoAtivo) return '';
  const { list, id } = pubPagamentoAtivo;
  const registro = (state[list] || []).find((x) => x.id === id);
  if (!registro || !(Number(registro.valor) > 0) || registro.statusPagamento === 'pago') return '';
  const valor = Number(registro.valor);
  const aguardando = registro.statusPagamento === 'aguardando_confirmacao';
  const temChave = !!(pixConfig && pixConfig.chave);
  return `
  <section class="card signup-card" style="border-color:var(--yellow)">
    <div class="card-body">
      <div class="field">
        <label>💳 Pagamento — ${esc(registro.name)}</label>
        <div class="hint" style="text-align:left;margin-bottom:4px">Valor: <strong>${formatMoeda(valor)}</strong></div>
        <div class="hint" style="text-align:left;margin-bottom:8px">${
          aguardando ? '🕓 Avisamos o organizador que você já pagou — assim que ele confirmar, sua inscrição vira confirmada.'
          : 'Pague no Pix com a chave abaixo e anexe o comprovante. Sua inscrição fica pendente até o organizador confirmar o pagamento.'
        }</div>
        ${!aguardando && temChave ? `
        <label>Chave Pix</label>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
          <input readonly class="pix-copia-cola" style="min-height:auto;padding:9px 12px;font-family:inherit;font-size:14px" id="pix-chave-exibida-${esc(id)}" value="${esc(pixConfig.chave)}" />
          <button class="mode-btn" data-action="copiar-pix" data-texto="${esc(pixConfig.chave)}">📋 Copiar</button>
        </div>
        ${pixConfig.nome ? `<div class="hint" style="text-align:left;margin-bottom:8px">Recebedor: ${esc(pixConfig.nome)}${pixConfig.cidade ? ` — ${esc(pixConfig.cidade)}` : ''}</div>` : ''}
        ` : ''}
        ${!aguardando && !temChave ? `<div class="hint hint-alerta" style="text-align:left;margin-bottom:8px">O organizador ainda não configurou a chave Pix. Fale com ele pra combinar o pagamento.</div>` : ''}
        ${!aguardando ? `
        <label style="margin-top:12px">📎 Anexar comprovante do Pix (foto ou PDF)</label>
        <div class="hint" style="text-align:left;margin-bottom:6px">Pague, tire um print ou foto do comprovante e anexe aqui — o organizador confere e confirma sua inscrição manualmente.</div>
        <input type="file" accept="image/*,application/pdf" id="comprovante-input-${esc(id)}" style="margin-bottom:8px" />
        <button class="btn-primary" data-action="enviar-comprovante" data-list="${list}" data-id="${id}" ${pubComprovanteEnviando ? 'disabled' : ''}>${pubComprovanteEnviando ? 'Enviando...' : '📎 Enviar comprovante'}</button>
        ${pubComprovanteErroMsg ? `<div class="hint hint-alerta" style="text-align:left;margin-top:4px">${esc(pubComprovanteErroMsg)}</div>` : ''}
        ${registro.comprovantePath ? `<div class="hint" style="text-align:left;margin-top:6px">✓ Comprovante enviado — aguardando o organizador conferir.</div>` : ''}
        ` : ''}
        ${!aguardando ? `<button class="mode-btn" style="margin-top:10px" data-action="pub-declarar-pago" data-list="${list}" data-id="${id}">Já paguei sem anexar comprovante</button>` : ''}
        <button class="mode-btn" style="margin-top:6px" data-action="pub-fechar-pagamento">Fechar</button>
      </div>
    </div>
  </section>`;
}

function renderStatusPublico(x, listKey) {
  if (!(state.valorInscricao > 0)) return x.confirmada ? '<span class="badge-ok">✓</span>' : '<span class="badge-pending">⏳</span>';
  const status = x.statusPagamento || 'pendente';
  if (status === 'pago') return '<span class="badge-ok">✓ pago</span>';
  if (status === 'aguardando_confirmacao') return '<span class="badge-pending">🕓 aguardando confirmação</span>';
  return `<span class="badge-pending">⏳ pendente</span> <button class="mode-btn" style="padding:3px 8px;font-size:11px" data-action="pub-ver-pix" data-list="${listKey}" data-id="${x.id}" data-valor="${Number(x.valor) || 0}" data-nome="${esc(x.name)}">Pagar</button>`;
}
function renderInscritosPublico(catKey) {
  const listKey = state.tipo === 'chaves' ? 'teams' : 'players';
  const list = state[listKey];
  const ativos = list.filter((x) => categoriaOf(x) === catKey && !x.oculto && !x.filaEspera).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const espera = list.filter((x) => categoriaOf(x) === catKey && !x.oculto && x.filaEspera).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  if (!ativos.length && !espera.length) return '';
  return `
    <section class="card">
      <div class="card-head-static inscritos-header" data-action="toggle-inscritos-publico">
        <span>👥 Inscritas (${ativos.length}${espera.length ? ` · ${espera.length} na fila de espera` : ''})</span>
        <span class="round-toggle-icon">${inscritosVisiveis ? '▲ ocultar' : '▼ mostrar'}</span>
      </div>
      ${inscritosVisiveis ? `
      <div class="card-body">
        <div class="inscritos-lista">
          ${ativos.map((x, i) => `<div class="inscrito-item"><span><span class="inscrito-item-num">${i + 1}.</span>${esc(x.name)}</span> ${renderStatusPublico(x, listKey)}</div>`).join('')}
        </div>
        ${espera.length ? `
        <div class="hint" style="text-align:left;margin-top:14px;margin-bottom:4px">🕓 Fila de espera — vagas lotadas, aguardando o organizador liberar</div>
        <div class="inscritos-lista">
          ${espera.map((x, i) => `<div class="inscrito-item"><span><span class="inscrito-item-num">${i + 1}.</span>${esc(x.name)}</span> <span class="badge-pending">🕓 fila de espera</span></div>`).join('')}
        </div>
        ` : ''}
      </div>` : ''}
    </section>`;
}
function renderBuscaAtleta() {
  const termoLembrado = !isAdmin && currentTournamentId ? lerBuscaLembrada(currentTournamentId) : '';
  return isAdmin
    ? `<div class="field search-field"><input id="busca-atleta" placeholder="🔍 Buscar por atleta ou dupla..." /></div>`
    : `<div class="field search-field search-field-destaque"><label>🔍 Digite seu nome pra encontrar sua partida</label><input id="busca-atleta" placeholder="Seu nome ou o da sua dupla..." value="${esc(termoLembrado)}" /></div>`;
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
// Aviso pós-sorteio (não bloqueia nada): quando não dá pra manter no máximo LIMITE_DESCANSO jogos
// seguidos sem folga pra todo mundo — mesmo depois do reordenarPorDescanso (scheduling.js) já ter
// tentado espalhar as folgas ao máximo — avisa quem ficou no limite e sugere a troca manual de
// rodada que já existe (🔁 Trocar essa rodada com outra) pra quem quiser tentar ajustar na mão.
const LIMITE_DESCANSO = 4;
function renderAvisoDescanso(catRounds, catPlayers) {
  if (!isAdmin) return '';
  const rodadasNormais = catRounds.filter((r) => !r.isFinal);
  if (rodadasNormais.length <= LIMITE_DESCANSO) return '';
  const { maxSequencia, jogadorasNoLimite } = maiorSequenciaSemFolga(rodadasNormais, catPlayers.map((p) => p.id));
  if (maxSequencia <= LIMITE_DESCANSO) return '';
  const nomes = jogadorasNoLimite.slice(0, 3).map(nameOf).map(esc).join(', ');
  const resto = jogadorasNoLimite.length > 3 ? ` e mais ${jogadorasNoLimite.length - 3}` : '';
  const verbo = jogadorasNoLimite.length > 1 ? 'vão jogar' : 'vai jogar';
  return `<div class="hint hint-alerta" style="text-align:left;margin-bottom:10px">⚠ ${nomes}${resto} ${verbo} ${maxSequencia} rodadas seguidas sem folga — já tentamos espalhar as folgas ao máximo, mas com ${state.numCourts} quadra(s) e essa quantidade de jogadoras não dá pra descer de ${maxSequencia}. Se quiser tentar melhorar na mão, use "🔁 Trocar essa rodada com outra" na lista abaixo.</div>`;
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
    ${tab === 'rodadas' ? renderAvisoDescanso(catRounds, catPlayers) + renderGerarHorariosPanel(catKey) + renderRounds(catRounds, catKey) : ''}
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
// Mesmo filtro de "próxima" do resumoVisaoGeral, mas restrito aos jogos que citam o termo buscado
// (nome da jogadora/dupla) — usado pra personalizar o banner público assim que alguém já buscou o
// próprio nome uma vez (busca fica lembrada neste aparelho, ver lerBuscaLembrada).
function meuProximoJogo(catKey, termo) {
  const t = (termo || '').trim().toLowerCase();
  if (!t) return null;
  const items = collectJogos(catKey).filter((it) => `${it.a} ${it.b}`.toLowerCase().includes(t));
  if (!items.length) return null;
  const hoje = hojeISO();
  const agora = new Date();
  const agoraMin = agora.getHours() * 60 + agora.getMinutes();
  const futuros = items.filter((it) => !partidaJogada(it) && it.data && it.hora && (it.data > hoje || (it.data === hoje && (it.hora.split(':').map(Number)[0] * 60 + it.hora.split(':').map(Number)[1]) >= agoraMin)));
  futuros.sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora));
  return futuros[0] || null;
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
// Aceita tanto um link colado (youtube.com/watch?v=..., youtu.be/..., .../live/..., .../shorts/...)
// quanto o ID puro do vídeo, e devolve só o ID (11 caracteres) — ou '' se não reconhecer o formato.
function extrairYoutubeId(input) {
  const raw = (input || '').trim();
  if (!raw) return '';
  if (/^[\w-]{11}$/.test(raw)) return raw;
  const padroes = [/youtu\.be\/([\w-]{11})/, /[?&]v=([\w-]{11})/, /youtube\.com\/embed\/([\w-]{11})/, /youtube\.com\/live\/([\w-]{11})/, /youtube\.com\/shorts\/([\w-]{11})/];
  for (const re of padroes) {
    const m = raw.match(re);
    if (m) return m[1];
  }
  return '';
}
// Transmissão ao vivo por câmera: cada "câmera" é, na prática, uma live do YouTube que o admin
// inicia pelo celular (app do YouTube, apontando pra quadra) e cola o link aqui. O app não recebe
// nem retransmite vídeo nenhum — só exibe o player embutido do YouTube quando o admin marca como
// ativa, e esconde quando desativa. Dá pra ter várias câmeras (uma por quadra) ligadas ao mesmo tempo.
function renderCamerasAoVivo() {
  const cameras = state.camerasAoVivo || [];
  const ativas = cameras.filter((c) => c.ativa && c.youtubeId);
  const gestao = isAdmin ? `
    <div class="field" style="margin-bottom:14px">
      <label>📹 Transmissão ao vivo (câmeras)</label>
      <div class="hint" style="text-align:left;margin-bottom:8px">Transmita pelo app do YouTube no celular (Criar → Transmitir ao vivo) apontando pra quadra, cole o link da live aqui e ative quando quiser que apareça pra todo mundo. Desative quando terminar — dá pra reativar depois com o mesmo link.</div>
      ${cameras.map((c) => `
        <div class="camera-ao-vivo-item">
          <div class="row" style="align-items:center">
            <span style="flex:1;font-size:14px;font-weight:600">${esc(c.nome)}</span>
            <button class="mode-btn ${c.ativa ? 'active' : ''}" data-action="toggle-camera-ativa" data-id="${c.id}">${c.ativa ? '🔴 Ao vivo' : '⏸ Desativada'}</button>
            <button class="mode-btn btn-danger" data-action="remove-camera-ao-vivo" data-id="${c.id}" data-nome="${esc(c.nome)}">Remover</button>
          </div>
          <input style="margin-top:4px" placeholder="Cole aqui o link da live no YouTube" value="${esc(c.youtubeId ? `https://youtu.be/${c.youtubeId}` : '')}" data-action="set-camera-link" data-id="${c.id}" />
        </div>
      `).join('')}
      <div class="row" style="margin-top:6px">
        <input id="new-camera-nome" placeholder="Nome da câmera (ex: Quadra 1)" />
        <button data-action="add-camera-ao-vivo">+</button>
      </div>
    </div>` : '';
  const vitrine = ativas.length ? `
    <div class="cameras-ao-vivo-grid">
      ${ativas.map((c) => `
        <div class="camera-ao-vivo-player">
          <div class="hint" style="text-align:left;margin-bottom:4px">🔴 ${esc(c.nome)} — ao vivo</div>
          <div class="camera-ao-vivo-frame" id="camera-frame-${c.id}">
            <iframe id="camera-iframe-${c.id}" src="https://www.youtube.com/embed/${esc(c.youtubeId)}" title="${esc(c.nome)}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen webkitallowfullscreen mozallowfullscreen></iframe>
            <div class="camera-ao-vivo-watermark">
              <img src="./logo.png" alt="" />
              <span>${esc(state.name)}</span>
            </div>
          </div>
          <div class="row" style="margin-top:6px">
            <button class="mode-btn" data-action="tela-cheia-camera" data-id="${c.id}">⛶ Tela cheia</button>
            <a class="mode-btn" style="text-decoration:none" href="https://youtu.be/${esc(c.youtubeId)}" target="_blank" rel="noopener">▶ Abrir no YouTube</a>
          </div>
        </div>
      `).join('')}
    </div>` : '';
  return gestao + vitrine;
}
function renderAoVivoModulo(catKey) {
  const cameras = renderCamerasAoVivo();
  if (state.tipo === 'chaves') {
    const items = collectJogos(catKey);
    const hoje = hojeISO();
    const agora = new Date();
    const agoraMin = agora.getHours() * 60 + agora.getMinutes();
    const doDia = items.filter((it) => it.data === hoje && !partidaJogada(it));
    const atrasadas = doDia.filter((it) => it.hora && (it.hora.split(':').map(Number)[0] * 60 + it.hora.split(':').map(Number)[1]) < agoraMin);
    const proximas = doDia.filter((it) => !atrasadas.includes(it));
    return `
      ${cameras}
      <div class="hint" style="text-align:left;margin-bottom:10px">No modo Torneio as partidas não têm quadra fixa, então a lista abaixo é organizada por horário de hoje em vez de por quadra.</div>
      <div class="round-title"><span>🔴 Resultado pendente (${atrasadas.length})</span></div>
      ${atrasadas.length ? atrasadas.map((it) => renderAoVivoLinha(it)).join('') : `<div class="hint">Nenhuma.</div>`}
      <div class="round-title" style="margin-top:14px"><span>🟡 Próximas hoje (${proximas.length})</span></div>
      ${proximas.length ? proximas.map((it) => renderAoVivoLinha(it)).join('') : `<div class="hint">Nenhuma.</div>`}
    `;
  }
  const board = statusQuadrasAoVivo(catKey);
  return `
    ${cameras}
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
    </div>
  </section>
  <section class="card cta-card">
    <div class="card-body">
      <button class="btn-primary" style="width:100%" data-action="${state.tipo === 'chaves' ? 'gerar-grupos' : 'sortear'}">🔀 ${naoGerouAinda ? (state.tipo === 'chaves' ? 'Gerar chaves' : 'Sortear rodadas') : (state.tipo === 'chaves' ? 'Gerar chaves novamente' : 'Sortear novamente')}</button>
      <div class="hint" style="text-align:left;margin-top:6px">${naoGerouAinda ? `Cadastre as ${state.tipo === 'chaves' ? 'duplas' : 'jogadoras'} em "Inscrições" antes de sortear.` : 'Pode sortear quantas vezes quiser — cada vez gera uma combinação nova. Isso apaga os placares já lançados.'}</div>
    </div>
  </section>
  <section class="card">
    <div class="card-head-static">📲 Compartilhar</div>
    <div class="card-body">
      <button class="mode-btn" style="width:100%" data-action="compartilhar-whatsapp">📲 Compartilhar torneio no WhatsApp</button>
      <button class="mode-btn" style="width:100%;margin-top:8px" data-action="abrir-modo-tv">📺 Abrir tela do clube (TV/projetor)</button>
      <button class="mode-btn" style="width:100%;margin-top:8px" data-action="mostrar-qr">🔗 Gerar QR Code do torneio</button>
      <button class="mode-btn" style="width:100%;margin-top:8px" data-action="exportar-pdf">🖨️ Exportar agenda/placar em PDF</button>
    </div>
  </section>
  <section class="card">
    <div class="card-head-static">📋 Painel de gestão</div>
    <div class="card-body">
      <div class="dash-grid">
        <button class="dash-card" data-action="abrir-painel" data-painel="config">
          <div class="dash-title">Configurações</div>
          <div class="dash-sub">${esc(tipoLabel)}${state.categorias.length ? ` · ${state.categorias.length} categoria(s)` : ''}${state.valorInscricao > 0 ? ` · ${formatMoeda(state.valorInscricao)}` : ''}</div>
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
    <div class="field">
      <label>Valor da inscrição (R$)</label>
      <input type="number" min="0" step="0.01" id="config-valor-inscricao" value="${state.valorInscricao || ''}" placeholder="0,00 = grátis" data-action="set-valor-inscricao" />
      <div class="hint" style="text-align:left;margin-top:4px">
        ${state.tipo === 'chaves' ? 'Cobrado sempre o valor total da dupla, mesmo quando ela se inscreve "sem parceiro(a)".' : 'Cobrado por atleta (as duplas do Americano são sorteadas e mudam a cada rodada).'}
        ${state.valorInscricao > 0 && !pixConfig.chave ? ' <span class="hint-alerta">⚠ Configure sua chave Pix na Central de Gestão pra ela aparecer na hora do pagamento.</span>' : ''}
      </div>
    </div>
    ${renderCategoriasSetup()}
    ${renderLimitesPorCategoria()}
    <div class="field"><label>Login de admin</label><div class="hint" style="text-align:left">Gerenciado no Firebase Authentication.</div></div>
  `;
}

// Pra múltiplo de 4 (e número par), a construção garantida (gerarRodadasComByesJustos, ver
// scheduling.js) cobre cada dupla exatamente 1 vez com jogos iguais num número fixo de rodadas.
// Devolve null quando essa construção não se aplica (ímpar, <4, ou "chaves").
function rodadasExatasGarantidas(numJogadoras, numCourts) {
  const numeroImpar = numJogadoras % 2 === 1;
  if (state.tipo === 'chaves' || numJogadoras < 4 || numeroImpar || numJogadoras % 4 !== 0) return null;
  return gerarRodadasComByesJustos(Array.from({ length: numJogadoras }, (_, i) => ({ id: 'x' + i })), numCourts).length;
}
// A fórmula distribuicaoEhJusta assume rodadas todas do mesmo tamanho — vale pro sorteio heurístico
// de sempre, mas não pra construção garantida (que tem rodadas de tamanho variável, pra caber nas
// quadras). Essa função sabe reconhecer os dois casos, pra nunca dar uma resposta diferente na tela
// de "Quadras e Rodadas" e no botão de sortear (foi exatamente essa divergência que já apareceu 2
// vezes: um aviso de "não é justo" embaixo de um botão dizendo "jogos iguais pra todas", e depois um
// alert de bloqueio no sorteio pro mesmo número de rodadas que o botão tinha acabado de preencher).
function distribuicaoRodadasEhJustaComExato(numJogadoras, numCourts, numRounds, rodadasExatas) {
  if (rodadasExatas == null) return distribuicaoEhJusta(numJogadoras, numCourts, numRounds);
  if (numRounds === rodadasExatas) return true;
  if (numRounds > rodadasExatas) return distribuicaoEhJusta(numJogadoras, numCourts, numRounds - rodadasExatas);
  return distribuicaoEhJusta(numJogadoras, numCourts, numRounds);
}
function distribuicaoRodadasEhJusta(numJogadoras, numCourts, numRounds) {
  return distribuicaoRodadasEhJustaComExato(numJogadoras, numCourts, numRounds, rodadasExatasGarantidas(numJogadoras, numCourts));
}
// Mesma lista que proximosRoundsValidos, mas ciente da construção garantida (inclui o número exato
// dela e os excedentes que também ficam justos por cima, além dos valores puramente heurísticos).
function proximasRodadasJustasReais(numJogadoras, numCourts, quantidade = 6, maxRounds = 60) {
  const rodadasExatas = rodadasExatasGarantidas(numJogadoras, numCourts);
  const validos = [];
  for (let n = 1; n <= maxRounds && validos.length < quantidade; n++) {
    if (distribuicaoRodadasEhJustaComExato(numJogadoras, numCourts, n, rodadasExatas)) validos.push(n);
  }
  return validos;
}

function renderQuadrasModulo(maxCourts, minRounds, numJogadoras) {
  const cortesReais = Math.min(state.numCourts, maxCourts);
  const numeroImpar = numJogadoras % 2 === 1;
  const multiploDe4 = state.tipo !== 'chaves' && numJogadoras >= 4 && !numeroImpar && numJogadoras % 4 === 0;
  // Pra múltiplo de 4, dá pra garantir cada dupla EXATAMENTE 1 vez (nem mais, nem menos) — usa o
  // tamanho real de gerarRodadasComByesJustos (a mesma construção que generateSchedule de fato usa
  // nesse caso) em vez de uma fórmula separada, pra o número mostrado aqui nunca desalinhar do que
  // o sorteio de rodadas realmente vai gerar. Pra quantidade que não é múltiplo de 4, só dá pra
  // garantir jogos iguais (não zero repetição), então usa proximoRoundsValidoApartirDe.
  const rodadasExatas = multiploDe4
    ? rodadasExatasGarantidas(numJogadoras, cortesReais)
    : (state.tipo !== 'chaves' && minRounds > 0 && numJogadoras >= 4 && !numeroImpar ? proximoRoundsValidoApartirDe(numJogadoras, cortesReais, minRounds) : null);
  const justa = state.tipo !== 'chaves' && numJogadoras >= 4 ? distribuicaoRodadasEhJusta(numJogadoras, cortesReais, state.numRounds) : true;
  const mostrarAvisosDuplas = state.tipo !== 'chaves' && numJogadoras >= 4;
  const totalDuplas = numJogadoras * (numJogadoras - 1) / 2;
  // Parâmetro 2 (todos jogam de dupla com todos / nunca repetir dupla), sempre avaliado contra o
  // state.numRounds ATUAL — pra múltiplo de 4 o teto é exato e garantido (mesma rodadasExatas de
  // cima: abaixo dela ninguém repetiu ainda mas também não fechou cobertura total; acima dela,
  // repetição já é matematicamente inevitável). Pros demais tamanhos só existe uma estimativa
  // (mínimo pra cobrir todo mundo), porque esses caem no sorteio heurístico, que minimiza repetição
  // mas não garante zero — por isso o texto nunca promete "exatamente" fora do caso múltiplo de 4.
  let coberturaOk = null, coberturaMsg = '';
  if (mostrarAvisosDuplas) {
    if (numeroImpar) {
      coberturaOk = false;
      coberturaMsg = 'Com número ímpar de jogadoras, não dá pra garantir que todas joguem de dupla com todas sem exigir rodadas demais. Use "jogos por jogadora" abaixo pra achar o melhor equilíbrio.';
    } else if (multiploDe4 && rodadasExatas != null) {
      if (state.numRounds < rodadasExatas) { coberturaOk = false; coberturaMsg = `Com ${state.numRounds} rodada(s), ainda faltam ${rodadasExatas - state.numRounds} rodada(s) pra todas jogarem de dupla com todas (o número exato é ${rodadasExatas}).`; }
      else if (state.numRounds === rodadasExatas) { coberturaOk = true; coberturaMsg = `Com ${state.numRounds} rodada(s), todas jogam de dupla com todas exatamente 1 vez — nenhuma dupla se repete.`; }
      else { coberturaOk = false; coberturaMsg = `Com ${state.numRounds} rodada(s), a partir da rodada ${rodadasExatas + 1} as duplas começam a se repetir (o máximo sem repetir nenhuma é ${rodadasExatas}).`; }
    } else if (minRounds > 0) {
      coberturaOk = state.numRounds >= minRounds;
      coberturaMsg = coberturaOk
        ? `Com ${state.numRounds} rodada(s), todas já devem ter jogado de dupla com quase todas (estimativa — esse total de jogadoras não tem um número exato garantido contra repetição, só o sorteio tentando ao máximo evitar).`
        : `Com ${state.numRounds} rodada(s), ainda não dá pra todas jogarem de dupla com todas pelo menos 1 vez — são necessárias pelo menos ${minRounds} rodadas (estimativa).`;
    }
  }
  return `
    <div class="row2">
      <div class="field"><label>Quadras (máx ${maxCourts})</label><input type="number" min="1" max="${maxCourts}" id="num-courts" value="${state.numCourts}" data-action="set-courts" /></div>
      <div class="field"><label>Rodadas</label><input type="number" min="1" max="60" id="num-rounds" value="${state.numRounds}" data-action="set-rounds" /></div>
    </div>
    ${mostrarAvisosDuplas ? `<div class="hint" style="text-align:left;margin-top:-8px">Com ${numJogadoras} jogadoras, existem ${totalDuplas} duplas diferentes possíveis.</div>` : ''}
    ${state.tipo !== 'chaves' && numJogadoras >= 4 ? `
      <div class="hint ${justa ? '' : 'hint-alerta'}" style="text-align:left;margin-top:4px;margin-bottom:4px">
        ${justa ? `✓ Com ${state.numRounds} rodada(s), todas as ${numJogadoras} jogadoras jogam a mesma quantidade de jogos.` : `⚠ Com ${state.numRounds} rodada(s), NÃO dá pra deixar os jogos iguais pra todas.${numeroImpar ? ' Com número ímpar de jogadoras, use o campo "jogos por jogadora" abaixo, que calcula um número de rodadas que funciona automaticamente.' : ` Números que funcionam: ${proximasRodadasJustasReais(numJogadoras, cortesReais).join(', ')}.`}`}
      </div>
    ` : ''}
    ${coberturaMsg ? `<div class="hint ${coberturaOk === false ? 'hint-alerta' : ''}" style="text-align:left;margin-bottom:10px">${coberturaOk === false ? '⚠' : coberturaOk === true ? '✓' : 'ℹ'} ${coberturaMsg}</div>` : ''}
    ${state.tipo !== 'chaves' && minRounds > 0 && numJogadoras >= 4 && !numeroImpar ? (() => {
      const precisouAjustar = rodadasExatas > minRounds;
      const rotulo = multiploDe4 ? 'todos jogam com todos exatamente 1 vez, jogos iguais pra todas' : 'todos jogam com todos, jogos iguais pra todas';
      const explicacao = multiploDe4
        ? `são necessárias exatamente ${rodadasExatas} rodadas pra garantir que cada dupla de jogadoras aconteça exatamente 1 vez — nem mais, nem menos — com jogos e folgas idênticos pra todas`
        : `são necessárias exatamente ${rodadasExatas} rodadas pra garantir que todo mundo jogue com todo mundo pelo menos 1 vez e que todas joguem a mesma quantidade de jogos${precisouAjustar ? ` (${minRounds} já cobririam todo mundo, mas só a partir de ${rodadasExatas} a quantidade de jogos fica igual pra todas)` : ''}`;
      return `
      <button class="mode-btn" data-action="usar-cobertura-total" data-min="${rodadasExatas}">Preencher com ${rodadasExatas} rodadas (${rotulo})</button>
      <div class="hint" style="text-align:left;margin-top:4px">Com as jogadoras confirmadas na categoria atual e ${state.numCourts} quadra(s), ${explicacao}.</div>
    `; })() : ''}
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
    <div class="row2">
      <div class="field"><label>Início da pausa (opcional)</label><input type="time" id="pausa-inicio" value="${esc(state.pausaInicio || '')}" data-action="set-pausa-inicio" /></div>
      <div class="field"><label>Volta dos jogos após a pausa</label><input type="time" id="pausa-fim" value="${esc(state.pausaFim || '')}" data-action="set-pausa-fim" /></div>
    </div>
    <div class="hint" style="text-align:left">Se algum jogo cair dentro desse intervalo (ex: almoço, troca de turno), ele e os jogos seguintes são empurrados pra começar só a partir da hora de volta.</div>
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

// Texto "X inscritos agora / com esse limite seriam Y rodadas", usado tanto na primeira renderização
// quanto atualizado ao vivo (sem re-render completo) enquanto o admin digita o limite. numRoundsFullCoverage
// é a mesma conta usada em "Cobertura total" — quantas rodadas são necessárias pra todo mundo se
// enfrentar pelo menos 1 vez, dado o número de quadras atual.
function textoLimitePreview(catKey, limiteOverride) {
  const lista = state.tipo === 'chaves' ? state.teams : state.players;
  const inscritos = lista.filter((x) => categoriaOf(x) === catKey && !x.oculto).length;
  const numCourts = Math.max(1, Number(state.numCourts) || 1);
  const limite = limiteOverride != null ? limiteOverride : limiteDaCategoria(catKey);
  const rodadasAtual = inscritos >= 4 ? minRoundsForFullCoverage(inscritos, numCourts) : null;
  const rodadasLimite = limite > 0 && limite >= 4 ? minRoundsForFullCoverage(limite, numCourts) : null;
  return `${inscritos} inscrito(s) agora${rodadasAtual ? ` — ~${rodadasAtual} rodada(s) pra todos jogarem contra todos (${numCourts} quadra(s))` : ''}.${rodadasLimite ? ` Com o limite de ${limite}, seriam ~${rodadasLimite} rodada(s).` : ''}`;
}
// Limite de vagas configurável por categoria (uma categoria pode ter mais vagas que outra). Sem
// categorias cadastradas, mostra um único campo pra "Geral". Ao bater o limite de uma categoria,
// as próximas inscrições daquela categoria entram na fila de espera (ver categoriaLotada()).
function renderLimitesPorCategoria() {
  const keys = categoriaKeys(state);
  const unidade = state.tipo === 'chaves' ? 'duplas' : 'atletas';
  return `
    <div class="field">
      <label>Limite de vagas por categoria (${unidade})</label>
      <div class="hint" style="text-align:left;margin-bottom:8px">Deixe em branco/0 pra não ter limite naquela categoria. Ao bater o limite, novas inscrições entram na fila de espera até você aprovar.</div>
      ${keys.map((k) => `
        <div class="limite-cat-block" data-cat="${esc(k)}" style="margin-bottom:10px">
          <div class="row" style="align-items:center;margin-top:0;margin-bottom:2px">
            <span style="flex:1;font-size:14px">${esc(catLabel(k) || 'Geral')}</span>
            <input type="number" min="0" step="1" style="flex:0 0 100px;min-width:70px" data-action="set-limite-categoria" data-cat="${esc(k)}" value="${limiteDaCategoria(k) || ''}" placeholder="sem limite" />
          </div>
          <div class="hint limite-cat-preview" style="text-align:left">${textoLimitePreview(k)}</div>
        </div>
      `).join('')}
    </div>`;
}

// Badge de status (confirmação simples pra torneio grátis, ou status de pagamento pra torneio pago).
// Reaproveita o campo "confirmada" existente como resultado final: quando há valor, confirmada só vira
// true junto com statusPagamento 'pago' — assim todo o resto do app (sorteio, chaveamento, contagens)
// que já filtra por "confirmada" continua funcionando sem precisar tocar em mais nada.
function renderComprovanteLink(x) {
  if (!x.comprovantePath) return '';
  return ` <button class="mode-btn" style="padding:3px 8px;font-size:11px" data-action="ver-comprovante" data-caminho="${esc(x.comprovantePath)}" title="Abrir o comprovante anexado">📎 ver comprovante</button>`;
}
// Mostra o status de pagamento de quem tá na fila de espera (sem os botões de marcar/desmarcar pago —
// isso só faz sentido depois de aprovado), pra o admin já ver se a pessoa pagou antes de liberar a vaga.
function renderStatusFilaEspera(x) {
  if (!(state.valorInscricao > 0)) return '';
  const status = x.statusPagamento || 'pendente';
  const label = status === 'pago' ? '✓ pago' : status === 'aguardando_confirmacao' ? '🕓 aguardando confirmação' : '⏳ pendente';
  return ` <span class="badge-pending">${label}</span>${renderComprovanteLink(x)}`;
}
function renderStatusBadge(x, list) {
  const acaoToggle = list === 'players' ? 'toggle-confirm-player' : 'toggle-confirm-team';
  if (!(state.valorInscricao > 0)) {
    return `<button class="conf-badge ${x.confirmada ? 'yes' : 'no'}" data-action="${acaoToggle}" data-id="${x.id}" title="${x.confirmada ? 'Confirmada — clique pra marcar como pendente' : 'Pendente — clique pra confirmar'}">${x.confirmada ? '✓' : '⏳'}</button>`;
  }
  const status = x.statusPagamento || 'pendente';
  const comprovante = renderComprovanteLink(x);
  if (status === 'pago') return `<button class="pag-badge pago" data-action="desmarcar-pago" data-list="${list}" data-id="${x.id}" title="Pago — clique pra desfazer">✓ pago</button>${comprovante}`;
  if (status === 'aguardando_confirmacao') return `<button class="pag-badge aguardando" data-action="marcar-pago" data-list="${list}" data-id="${x.id}" title="Atleta avisou que pagou — clique pra confirmar">🕓 confirmar pagamento?</button>${comprovante}`;
  return `<button class="pag-badge pendente" data-action="marcar-pago" data-list="${list}" data-id="${x.id}" title="Pendente — clique pra marcar como pago">⏳ marcar pago</button>${comprovante}`;
}
function renderResumoPagamentos(lista, tipoLabel) {
  if (!(state.valorInscricao > 0)) return '';
  const pagos = lista.filter((x) => x.statusPagamento === 'pago').length;
  const aguardando = lista.filter((x) => x.statusPagamento === 'aguardando_confirmacao').length;
  const pendentes = lista.length - pagos - aguardando;
  return `<div class="hint" style="text-align:left;margin-bottom:8px">💰 ${formatMoeda(state.valorInscricao)} por ${tipoLabel} — ${pagos} pago(s)${aguardando ? `, ${aguardando} aguardando confirmação` : ''}${pendentes ? `, ${pendentes} pendente(s)` : ''}.</div>`;
}
function renderPlayersSetup(minRounds) {
  const showCatSelect = state.categorias.length > 0;
  const ativos = state.players.filter((p) => !p.filaEspera);
  const espera = state.players.filter((p) => p.filaEspera);
  const pendentes = ativos.filter((p) => !p.confirmada).length;
  return `
    <div class="field">
      <label>Jogadoras (${ativos.length}${espera.length ? ` · ${espera.length} na fila de espera` : ''})</label>
      ${renderResumoPagamentos(ativos, 'atleta')}
      ${pendentes > 0 && !(state.valorInscricao > 0) ? `<button class="mode-btn" data-action="confirmar-todas-jogadoras" style="margin-bottom:8px">✓ Confirmar todas (${pendentes} pendente${pendentes > 1 ? 's' : ''})</button>` : ''}
      <div class="chips chips-lista">
        ${ativos.map((p, i) => `<span class="chip ${p.oculto ? 'is-oculto' : ''}"><span class="chip-num">${i + 1}.</span>${esc(p.name)}${p.categoria ? ` <em>(${esc(p.categoria)})</em>` : ''}${p.telefone ? ` <span class="tel">📞${esc(p.telefone)}</span>` : ''} ${renderStatusBadge(p, 'players')} <button class="vis-badge" data-action="toggle-oculto-player" data-id="${p.id}" title="${p.oculto ? 'Oculta do público — clique pra mostrar' : 'Visível ao público — clique pra ocultar'}">${p.oculto ? '🚫' : '👁'}</button> <button data-action="remove-player" data-id="${p.id}" data-nome="${esc(p.name)}">×</button></span>`).join('')}
      </div>
      ${espera.length ? `
      <div class="hint" style="text-align:left;margin-top:12px;margin-bottom:4px">🕓 Fila de espera — vagas lotadas nessa categoria, clique em "aprovar" pra liberar uma vaga</div>
      <div class="chips chips-lista">
        ${espera.map((p, i) => `<span class="chip">${i + 1}. ${esc(p.name)}${p.categoria ? ` <em>(${esc(p.categoria)})</em>` : ''}${p.telefone ? ` <span class="tel">📞${esc(p.telefone)}</span>` : ''}${renderStatusFilaEspera(p)} <button class="mode-btn" style="padding:3px 8px;font-size:11px" data-action="aprovar-fila-espera" data-list="players" data-id="${p.id}">✓ aprovar</button> <button data-action="remove-player" data-id="${p.id}" data-nome="${esc(p.name)}">×</button></span>`).join('')}
      </div>
      ` : ''}
      <div class="row">
        <input id="new-player" placeholder="Nome do jogador" list="atletas-datalist" />
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
  const ativos = state.teams.filter((t) => !t.filaEspera);
  const espera = state.teams.filter((t) => t.filaEspera);
  const pendentes = ativos.filter((t) => !t.confirmada).length;
  return `
    <div class="field">
      <label>Duplas (${ativos.length}${espera.length ? ` · ${espera.length} na fila de espera` : ''})</label>
      ${renderResumoPagamentos(ativos, 'dupla')}
      ${pendentes > 0 && !(state.valorInscricao > 0) ? `<button class="mode-btn" data-action="confirmar-todas-duplas" style="margin-bottom:8px">✓ Confirmar todas (${pendentes} pendente${pendentes > 1 ? 's' : ''})</button>` : ''}
      <div class="chips chips-lista">
        ${ativos.map((t, i) => {
          const tel1 = t.telefone1 || t.telefone || '';
          const tel2 = t.telefone2 || '';
          return `<span class="chip ${t.oculto ? 'is-oculto' : ''}"><span class="chip-num">${i + 1}.</span>${esc(t.name)}${t.categoria ? ` <em>(${esc(t.categoria)})</em>` : ''}${tel1 ? ` <span class="tel">📞${esc(tel1)}</span>` : ''}${tel2 ? ` <span class="tel">📞${esc(tel2)}</span>` : ''} ${renderStatusBadge(t, 'teams')} <button class="vis-badge" data-action="toggle-oculto-team" data-id="${t.id}" title="${t.oculto ? 'Oculta do público — clique pra mostrar' : 'Visível ao público — clique pra ocultar'}">${t.oculto ? '🚫' : '👁'}</button> <button data-action="remove-team" data-id="${t.id}" data-nome="${esc(t.name)}">×</button></span>`;
        }).join('')}
      </div>
      ${espera.length ? `
      <div class="hint" style="text-align:left;margin-top:12px;margin-bottom:4px">🕓 Fila de espera — vagas lotadas nessa categoria, clique em "aprovar" pra liberar uma vaga</div>
      <div class="chips chips-lista">
        ${espera.map((t, i) => {
          const tel1 = t.telefone1 || t.telefone || '';
          const tel2 = t.telefone2 || '';
          return `<span class="chip">${i + 1}. ${esc(t.name)}${t.categoria ? ` <em>(${esc(t.categoria)})</em>` : ''}${tel1 ? ` <span class="tel">📞${esc(tel1)}</span>` : ''}${tel2 ? ` <span class="tel">📞${esc(tel2)}</span>` : ''}${renderStatusFilaEspera(t)} <button class="mode-btn" style="padding:3px 8px;font-size:11px" data-action="aprovar-fila-espera" data-list="teams" data-id="${t.id}">✓ aprovar</button> <button data-action="remove-team" data-id="${t.id}" data-nome="${esc(t.name)}">×</button></span>`;
        }).join('')}
      </div>
      ` : ''}
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
      const trocaSelecionada = rodadaSelecionadaParaTroca && rodadaSelecionadaParaTroca.catKey === catKey && rodadaSelecionadaParaTroca.indice === ri;
      return `
      <div class="round-block ${rd.isFinal ? 'is-final' : ''} ${trocaSelecionada ? 'round-selecionada-troca' : ''}">
        <div class="round-title round-title-toggle" data-action="toggle-rodada" data-chave="${chave}" data-recolhida="${recolhida ? '1' : '0'}">
          <span>${rd.isFinal ? '🏆 GRANDE FINAL' : `Rodada ${rd.round}`}${recolhida ? ` <em class="round-resumo">(${jogadasCount}/${rd.matches.length} jogadas)</em>` : ''}</span>
          ${rd.byes && rd.byes.length && !recolhida ? `<span class="bye">folga: ${rd.byes.map(nameOf).map(esc).join(', ')}</span>` : ''}
          <span class="round-toggle-icon">${recolhida ? '▼' : '▲'}</span>
        </div>
        ${isAdmin && !rd.isFinal ? `<div style="margin:4px 0 8px"><button class="mode-btn ${trocaSelecionada ? 'active' : ''}" data-action="marcar-trocar-rodada" data-cat="${esc(catKey)}" data-indice="${ri}">${trocaSelecionada ? '✕ Cancelar troca de rodada' : '🔁 Trocar essa rodada com outra'}</button></div>` : ''}
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
// Mesma janela de "em andamento" do módulo Ao Vivo (statusQuadrasAoVivo: começou e ainda não faz 60min)
// — repetida aqui pra marcar o próprio card na lista de Rodadas, sem precisar trocar de aba pra ver.
function partidaAoVivoAgora(m, ag) {
  if (partidaJogada(m) || !ag.data || !ag.hora) return false;
  if (ag.data !== hojeISO()) return false;
  const [h, mi] = ag.hora.split(':').map(Number);
  const inicioMin = h * 60 + mi;
  const agora = new Date();
  const agoraMin = agora.getHours() * 60 + agora.getMinutes();
  return agoraMin >= inicioMin && agoraMin < inicioMin + 60;
}
function renderMatch(m, ri) {
  const d = drafts[m.id] || { a: m.scoreA ?? '', b: m.scoreB ?? '' };
  const done = partidaJogada(m);
  const editing = editingMatches.has(m.id);
  const showInputs = isAdmin && (!done || editing);
  const ag = state.agendamentos[m.id] || {};
  const selecionado = jogoSelecionadoParaTroca === m.id;
  return `
  <div class="match ${selecionado ? 'match-selecionado-troca' : ''}">
    <div class="match-head"><span class="court-tag">${esc(quadraNome(state, m.court))}</span>${partidaAoVivoAgora(m, ag) ? '<span class="tag-ao-vivo">🟢 ao vivo</span>' : ''}${ag.data ? `<span class="jogo-hora">🕐 ${formatData(ag.data)} ${esc(ag.hora || '')}</span>` : ''}${done && !editing ? '<span class="check">✓</span>' : ''}</div>
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
      <button class="mode-btn ${selecionado ? 'active' : ''}" style="margin-top:6px" data-action="marcar-trocar-jogo" data-match="${m.id}">${selecionado ? '✕ Cancelar troca' : '🔁 Trocar quadra/horário com outro jogo'}</button>
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
  const selecionado = jogoSelecionadoParaTroca === it.id;
  return `
  <div class="match ${selecionado ? 'match-selecionado-troca' : ''}">
    <div class="match-head"><span class="court-tag">${esc(it.fase)}</span>${it.hora ? `<span class="jogo-hora">🕐 ${esc(it.hora)}</span>` : ''}</div>
    <div class="team-row"><span class="team-name">${esc(it.a)}</span><span class="score">${it.scoreA ?? '–'}</span></div>
    <div class="vs">×</div>
    <div class="team-row"><span class="team-name">${esc(it.b)}</span><span class="score">${it.scoreB ?? '–'}</span></div>
    ${isAdmin ? `
      <div class="row" style="margin-top:8px">
        <input type="date" class="agendamento-data" data-match="${it.id}" value="${esc(it.data)}" />
        <input type="time" class="agendamento-hora" data-match="${it.id}" value="${esc(it.hora)}" />
      </div>
      <button class="mode-btn ${selecionado ? 'active' : ''}" style="margin-top:6px" data-action="marcar-trocar-jogo" data-match="${it.id}">${selecionado ? '✕ Cancelar troca' : '🔁 Trocar com outro jogo'}</button>
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
    if (action === 'abrir-reservas') el.addEventListener('click', abrirReservasHandler);
    if (action === 'voltar-lobby-de-reservas') el.addEventListener('click', sairReservasHandler);
    if (action === 'reserva-sel-data') el.addEventListener('click', () => { selectedReservaData = el.dataset.data; reservaFlash = null; render(); });
    if (action === 'reserva-data-livre') el.addEventListener('change', () => { if (el.value) { selectedReservaData = el.value; reservaFlash = null; render(); } });
    if (action === 'reserva-abrir') el.addEventListener('click', () => abrirModalNovaReserva(el.dataset.data, el.dataset.quadra, el.dataset.horario));
    if (action === 'reserva-criar') el.addEventListener('click', criarReservaHandler);
    if (action === 'reserva-fechar-modal') el.addEventListener('click', fecharReservaModal);
    if (action === 'reserva-toggle-status') el.addEventListener('click', () => toggleStatusReservaHandler(el.dataset.data, el.dataset.quadra, el.dataset.horario));
    if (action === 'reserva-cancelar') el.addEventListener('click', () => cancelarReservaHandler(el.dataset.data, el.dataset.quadra, el.dataset.horario, el.dataset.nome));
    if (action === 'reserva-editar') el.addEventListener('click', () => abrirModalEditarReserva(el.dataset.data, el.dataset.quadra, el.dataset.horario));
    if (action === 'reserva-salvar-edicao') el.addEventListener('click', salvarEdicaoReservaHandler);
    if (action === 'reserva-ver-comprovante') el.addEventListener('click', () => verComprovanteHandler('comprovantes/reservas/' + el.dataset.id));
    if (action === 'reserva-enviar-comprovante') el.addEventListener('click', () => {
      const input = document.getElementById('reserva-comprovante-input');
      const file = input && input.files && input.files[0];
      if (!file) { reservaErroMsg = 'Escolha um arquivo primeiro.'; render(); return; }
      enviarComprovanteReservaHandler(file);
    });
    if (action === 'reserva-copiar-pix') el.addEventListener('click', () => copiarPixHandler(el.dataset.texto));
    if (action === 'reserva-add-quadra') el.addEventListener('click', addQuadraReservaHandler);
    if (action === 'reserva-set-quadra-nome') el.addEventListener('change', () => renomearQuadraReservaHandler(el.dataset.id, el.value));
    if (action === 'reserva-remove-quadra') el.addEventListener('click', () => removerQuadraReservaHandler(el.dataset.id, el.dataset.nome));
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
      const valorInscricao = document.getElementById('novo-torneio-valor')?.value;
      criarNovoTorneio(nome, el.dataset.tipo, quadras, valorInscricao);
    });
    if (action === 'pix-salvar') el.addEventListener('click', pixSalvarHandler);
    if (action === 'set-valor-inscricao') el.addEventListener('change', () => persist({ ...state, valorInscricao: Math.max(0, Number(el.value) || 0) }));
    if (action === 'set-limite-categoria') {
      el.addEventListener('change', () => {
        const cat = el.dataset.cat;
        const valor = Math.max(0, Math.floor(Number(el.value) || 0));
        persist({ ...state, limitesPorCategoria: { ...(state.limitesPorCategoria || {}), [cat]: valor } });
      });
      // Atualiza o texto "quantas rodadas seriam necessárias" na hora, enquanto digita — sem salvar
      // no banco nem re-renderizar a tela inteira a cada tecla (isso só acontece no 'change' acima).
      el.addEventListener('input', () => {
        const cat = el.dataset.cat;
        const bloco = el.closest('.limite-cat-block');
        const previewEl = bloco ? bloco.querySelector('.limite-cat-preview') : null;
        if (previewEl) previewEl.textContent = textoLimitePreview(cat, Math.max(0, Math.floor(Number(el.value) || 0)));
      });
    }
    if (action === 'marcar-pago') el.addEventListener('click', () => marcarPagoHandler(el.dataset.list, el.dataset.id));
    if (action === 'desmarcar-pago') el.addEventListener('click', () => desmarcarPagoHandler(el.dataset.list, el.dataset.id));
    if (action === 'pub-declarar-pago') el.addEventListener('click', () => pubDeclararPagoHandler(el.dataset.list, el.dataset.id));
    if (action === 'aprovar-fila-espera') el.addEventListener('click', () => aprovarFilaEsperaHandler(el.dataset.list, el.dataset.id));
    if (action === 'enviar-comprovante') el.addEventListener('click', () => {
      const input = document.getElementById(`comprovante-input-${el.dataset.id}`);
      const file = input?.files?.[0];
      if (!file) { pubComprovanteErroMsg = 'Escolha um arquivo primeiro.'; render(); return; }
      enviarComprovanteHandler(el.dataset.list, el.dataset.id, file);
    });
    if (action === 'ver-comprovante') el.addEventListener('click', () => verComprovanteHandler(el.dataset.caminho));
    if (action === 'pub-ver-pix') el.addEventListener('click', () => {
      const list = el.dataset.list, id = el.dataset.id;
      pubPagamentoAtivo = { list, id };
      render();
    });
    if (action === 'pub-fechar-pagamento') el.addEventListener('click', () => { pubPagamentoAtivo = null; pubPagamentoErroMsg = null; pubComprovanteErroMsg = null; render(); });
    if (action === 'copiar-pix') el.addEventListener('click', () => copiarPixHandler(el.dataset.texto));
    if (action === 'lobby-set-status') el.addEventListener('change', () => { lobbyFiltroStatus = el.value; renderLobby(); });
    if (action === 'lobby-set-tipo') el.addEventListener('change', () => { lobbyFiltroTipo = el.value; renderLobby(); });
    if (action === 'set-tipo') el.addEventListener('click', () => setTipoHandler(el.dataset.tipo));
    if (action === 'toggle-inscricoes') el.addEventListener('click', () => persist({ ...state, inscricoesAbertas: !state.inscricoesAbertas }));
    if (action === 'toggle-visivel') el.addEventListener('click', () => persist({ ...state, visivelPublico: !state.visivelPublico }));
    if (action === 'compartilhar-whatsapp') el.addEventListener('click', () => compartilharTorneioHandler());
    if (action === 'abrir-modo-tv') el.addEventListener('click', () => {
      window.open(`${window.location.origin}${window.location.pathname}?t=${currentTournamentId}&tv=1`, '_blank');
    });
    if (action === 'mostrar-qr') el.addEventListener('click', mostrarQrHandler);
    if (action === 'exportar-pdf') el.addEventListener('click', () => exportarPdfHandler(currentCategoria()));
    if (action === 'toggle-rodada') el.addEventListener('click', () => {
      const chave = el.dataset.chave;
      const atualRecolhida = el.dataset.recolhida === '1';
      rodadasEstadoManual[chave] = !atualRecolhida;
      render();
    });
    if (action === 'toggle-atletas-conhecidos') el.addEventListener('click', () => { mostrarAtletasConhecidos = !mostrarAtletasConhecidos; render(); });
    if (action === 'marcar-trocar-jogo') el.addEventListener('click', () => marcarTrocarJogoHandler(el.dataset.match));
    if (action === 'marcar-trocar-rodada') el.addEventListener('click', () => marcarTrocarRodadaHandler(el.dataset.cat, Number(el.dataset.indice)));
    if (action === 'toggle-inscritos-publico') el.addEventListener('click', () => { inscritosVisiveis = !inscritosVisiveis; render(); });
    if (action === 'atleta-salvar') el.addEventListener('click', () => editarAtletaHandler(el.dataset.chave));
    if (action === 'atleta-remover') el.addEventListener('click', () => removerAtletaHandler(el.dataset.chave, el.dataset.nome));
    if (action === 'toggle-notificacoes') el.addEventListener('click', toggleNotificacoesHandler);
    if (action === 'set-data-inicio') el.addEventListener('change', () => persist({ ...state, dataInicio: el.value }));
    if (action === 'set-data-fim') el.addEventListener('change', () => persist({ ...state, dataFim: el.value }));
    if (action === 'sel-cat') el.addEventListener('click', () => { selectedCategoria = el.dataset.cat; tab = 'rodadas'; syncUrlEstadoView(); render(); });
    if (action === 'jogos-filtro-data') el.addEventListener('click', () => { jogosFiltroData = el.dataset.data; render(); });
    if (action === 'gerar-horarios') el.addEventListener('click', () => gerarHorariosHandler(el.dataset.cat));
    if (action === 'add-cat') el.addEventListener('click', addCategoriaHandler);
    if (action === 'add-cat-sugg') el.addEventListener('click', () => addCategoria(el.dataset.cat));
    if (action === 'remove-cat') el.addEventListener('click', () => removeCategoriaHandler(el.dataset.cat));
    if (action === 'add-camera-ao-vivo') el.addEventListener('click', addCameraAoVivoHandler);
    if (action === 'set-camera-link') el.addEventListener('change', () => setCameraLinkHandler(el.dataset.id, el.value));
    if (action === 'toggle-camera-ativa') el.addEventListener('click', () => toggleCameraAtivaHandler(el.dataset.id));
    if (action === 'remove-camera-ao-vivo') el.addEventListener('click', () => removeCameraAoVivoHandler(el.dataset.id, el.dataset.nome));
    if (action === 'tela-cheia-camera') el.addEventListener('click', () => telaCheiaCameraHandler(el.dataset.id));
    if (action === 'remove-player') el.addEventListener('click', () => {
      const nome = el.dataset.nome || 'esta jogadora';
      if (!confirm(`Remover "${nome}" do torneio? Essa ação não pode ser desfeita.`)) return;
      persist({ ...state, players: state.players.filter((p) => p.id !== el.dataset.id) });
    });
    if (action === 'toggle-confirm-player') el.addEventListener('click', () => toggleConfirmHandler('players', el.dataset.id));
    if (action === 'toggle-confirm-team') el.addEventListener('click', () => toggleConfirmHandler('teams', el.dataset.id));
    if (action === 'confirmar-todas-jogadoras') el.addEventListener('click', () => persist({ ...state, players: state.players.map((p) => p.filaEspera ? p : { ...p, confirmada: true }) }));
    if (action === 'confirmar-todas-duplas') el.addEventListener('click', () => persist({ ...state, teams: state.teams.map((t) => t.filaEspera ? t : { ...t, confirmada: true }) }));
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
    if (action === 'set-rounds') el.addEventListener('change', () => persist({ ...state, numRounds: Math.max(1, Math.min(60, Number(el.value) || 1)) }));
    if (action === 'usar-cobertura-total') el.addEventListener('click', () => {
      const catKey = currentCategoria();
      const numJogadoras = state.players.filter((p) => categoriaOf(p) === catKey).length;
      const minimo = Number(el.dataset.min);
      // Múltiplo de 4: o número exato já vem pronto de gerarRodadasComByesJustos (mesma construção
      // que generateSchedule usa de fato — ver scheduling.js), não passa por proximoRoundsValidoApartirDe,
      // que usa uma fórmula de "jogos iguais" diferente e pode divergir (ex.: 20 jogadoras/2 quadras:
      // a construção real precisa de 49 rodadas, mas essa fórmula "arredondaria" pra 50).
      const rodadas = numJogadoras % 4 === 0
        ? gerarRodadasComByesJustos(Array.from({ length: numJogadoras }, (_, i) => ({ id: 'x' + i })), state.numCourts).length
        : proximoRoundsValidoApartirDe(numJogadoras, state.numCourts, minimo);
      persist({ ...state, numRounds: Math.min(60, rodadas) });
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
      persist({ ...state, numRounds: Math.min(60, rodadas) });
    });
    if (action === 'set-hora-inicio-torneio') el.addEventListener('change', () => persist({ ...state, horaInicioTorneio: el.value }));
    if (action === 'set-duracao-jogo-min') el.addEventListener('change', () => persist({ ...state, duracaoJogoMin: Math.max(1, Number(el.value) || 40) }));
    if (action === 'set-pausa-inicio') el.addEventListener('change', () => persist({ ...state, pausaInicio: el.value }));
    if (action === 'set-pausa-fim') el.addEventListener('change', () => persist({ ...state, pausaFim: el.value }));
    if (action === 'sortear') el.addEventListener('click', sortearHandler);
    if (action === 'gerar-grupos') el.addEventListener('click', gerarGruposHandler);
    if (action === 'gerar-final') el.addEventListener('click', gerarFinalHandler);
    if (action === 'tab') el.addEventListener('click', () => { tab = el.dataset.tab; syncUrlEstadoView(); render(); });
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
  function aplicarFiltroBusca(termo) {
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
  }
  if (buscaInput) {
    aplicarFiltroBusca(buscaInput.value.trim().toLowerCase());
    buscaInput.addEventListener('input', () => {
      const termo = buscaInput.value.trim().toLowerCase();
      // Guarda o termo pra próxima visita (só na visão pública — personaliza o banner "Seu próximo
      // jogo"). Admin usa a mesma busca só como filtro de tela, sem intenção de "esse sou eu".
      if (!isAdmin && currentTournamentId) lembrarBusca(currentTournamentId, termo);
      aplicarFiltroBusca(termo);
    });
  }
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
  [['pub-player-name', 'pub-player-phone'], ['pub-team-j1', 'pub-team-tel1'], ['pub-team-j2', 'pub-team-tel2'], ['new-team-j1', 'new-team-tel1'], ['new-team-j2', 'new-team-tel2'], ['reserva-nome', 'reserva-telefone']].forEach(([nomeId, telId]) => {
    const nomeEl = document.getElementById(nomeId);
    const telEl = document.getElementById(telId);
    if (!nomeEl || !telEl) return;
    nomeEl.addEventListener('change', () => {
      if (telEl.value) return; // não sobrescreve telefone já digitado
      const conhecido = atletasConhecidos[nomeEl.value.trim().toLowerCase()];
      if (conhecido && conhecido.telefone) telEl.value = conhecido.telefone;
    });
  });
  const reservaModalBg = document.querySelector('[data-action="reserva-modal-bg"]');
  if (reservaModalBg) {
    reservaModalBg.addEventListener('click', fecharReservaModal);
    reservaModalBg.querySelector('.modal')?.addEventListener('click', (e) => e.stopPropagation());
    ['reserva-nome', 'reserva-telefone'].forEach((id) => {
      document.getElementById(id)?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (reservaModal && reservaModal.modo === 'editar') salvarEdicaoReservaHandler();
        else criarReservaHandler();
      });
    });
  }
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
// Gera a imagem do QR num serviço externo (api.qrserver.com) — o link em si já é público (mesmo que
// o botão "Compartilhar no WhatsApp" manda pra fora), então não há dado sensível envolvido.
function renderQrModal(link) {
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=${encodeURIComponent(link)}`;
  return `<div class="modal-bg" data-action="close-pin-bg"><div class="modal" data-action="stop-bubble">
    <div class="modal-title">QR Code do torneio</div>
    <img src="${qrSrc}" alt="QR Code do link do torneio" style="display:block;width:100%;max-width:260px;margin:0 auto 12px;border-radius:12px;background:#fff;padding:10px" />
    <div class="hint" style="margin-bottom:10px">Aponte a câmera do celular pra abrir o torneio direto.</div>
    <div class="modal-actions"><button class="btn-primary" data-action="close-pin" style="width:100%">Fechar</button></div>
  </div></div>`;
}
function mostrarQrHandler() {
  if (!currentTournamentId) return;
  if (!state.visivelPublico) {
    if (!confirm('Esse torneio ainda está oculto pro público — quem escanear vai ver "não disponível". Publicar agora?')) return;
    persist({ ...state, visivelPublico: true });
  }
  const link = `${window.location.origin}${window.location.pathname}?t=${currentTournamentId}`;
  document.getElementById('pin-modal-slot').innerHTML = renderQrModal(link);
  document.querySelector('[data-action="close-pin-bg"]')?.addEventListener('click', closePinModal);
  document.querySelector('[data-action="stop-bubble"]')?.addEventListener('click', (e) => e.stopPropagation());
  document.querySelector('[data-action="close-pin"]')?.addEventListener('click', closePinModal);
}
// Exportação em PDF via impressão do navegador (Salvar como PDF) em vez de biblioteca externa —
// sem dependência nova pra manter, funciona offline e o usuário já conhece o fluxo "imprimir".
// Escreve num #print-area fixo (fora do #root) pra não mexer no ciclo normal de render/state.
function renderAgendaImprimivel(catKey) {
  const items = collectJogos(catKey).slice().sort((x, y) => {
    const dx = x.data || '9999-99-99', dy = y.data || '9999-99-99';
    if (dx !== dy) return dx < dy ? -1 : 1;
    const hx = x.hora || '99:99', hy = y.hora || '99:99';
    return hx < hy ? -1 : hx > hy ? 1 : 0;
  });
  const catTxt = catKey === DEFAULT_CAT ? '' : ` — ${catLabel(catKey)}`;
  const linhas = items.map((it) => `
    <tr>
      <td>${esc(it.fase)}</td>
      <td>${it.data ? formatData(it.data) : '—'}</td>
      <td>${it.hora || '—'}</td>
      <td>${esc(it.a)}</td>
      <td>${esc(it.b)}</td>
      <td>${it.scoreA != null && it.scoreB != null ? `${it.scoreA} x ${it.scoreB}` : '—'}</td>
    </tr>`).join('');
  return `
    <h1>${esc(state.name)}${esc(catTxt)}</h1>
    <div class="print-sub">Agenda e resultados — gerado em ${new Date().toLocaleString('pt-BR')}</div>
    <table class="print-table">
      <thead><tr><th>Fase</th><th>Data</th><th>Hora</th><th>Dupla A</th><th>Dupla B</th><th>Placar</th></tr></thead>
      <tbody>${linhas || '<tr><td colspan="6">Nenhum jogo gerado ainda.</td></tr>'}</tbody>
    </table>`;
}
function exportarPdfHandler(catKey) {
  const area = document.getElementById('print-area');
  if (!area) return;
  area.innerHTML = renderAgendaImprimivel(catKey);
  window.print();
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
function addCameraAoVivoHandler() {
  const input = document.getElementById('new-camera-nome');
  const nome = (input.value || '').trim();
  if (!nome) return;
  const nova = { id: uid(), nome, youtubeId: '', ativa: false };
  persist({ ...state, camerasAoVivo: [...(state.camerasAoVivo || []), nova] });
}
function setCameraLinkHandler(id, valor) {
  const youtubeId = extrairYoutubeId(valor);
  if (valor && !youtubeId) { alert('Não reconheci esse link do YouTube. Cole o link completo da transmissão ao vivo (ex: https://youtu.be/xxxxxxxxxxx).'); return; }
  persist({ ...state, camerasAoVivo: (state.camerasAoVivo || []).map((c) => c.id === id ? { ...c, youtubeId, ativa: youtubeId ? c.ativa : false } : c) });
}
function toggleCameraAtivaHandler(id) {
  const cam = (state.camerasAoVivo || []).find((c) => c.id === id);
  if (!cam) return;
  if (!cam.ativa && !cam.youtubeId) { alert('Cole o link da live antes de ativar essa câmera.'); return; }
  persist({ ...state, camerasAoVivo: state.camerasAoVivo.map((c) => c.id === id ? { ...c, ativa: !c.ativa } : c) });
}
function removeCameraAoVivoHandler(id, nome) {
  if (!confirm(`Remover a câmera "${nome || 'esta câmera'}"?`)) return;
  persist({ ...state, camerasAoVivo: (state.camerasAoVivo || []).filter((c) => c.id !== id) });
}
// A qualidade do vídeo é a mesma do YouTube (é o player original deles rodando dentro do app, sem
// nenhuma compressão nossa) — quem controla isso é o próprio YouTube, automaticamente, conforme a
// internet de quem tá assistindo. Aqui só tentamos abrir o player embutido em tela cheia por fora;
// em alguns celulares (principalmente iPhone) o navegador só libera a tela cheia a partir do botão
// que já vem dentro do próprio vídeo — nesse caso, é só tocar no vídeo e depois no ícone ⛶ dele.
function telaCheiaCameraHandler(id) {
  // Coloca em tela cheia o quadro (moldura + logo), não só o vídeo — assim a marquinha da logo
  // continua aparecendo por cima mesmo em tela cheia, quando aberta por esse botão.
  const frame = document.getElementById(`camera-frame-${id}`);
  if (!frame) return;
  const req = frame.requestFullscreen || frame.webkitRequestFullscreen || frame.webkitEnterFullscreen || frame.mozRequestFullScreen;
  if (!req) { alert('Esse navegador não deixa abrir a tela cheia por fora do vídeo. Toque no vídeo e use o ícone de tela cheia dele mesmo (geralmente no canto inferior direito) — nesse caso a logo não aparece, porque aí quem controla é o próprio YouTube.'); return; }
  try { req.call(frame); } catch (e) { console.error('Falha ao abrir tela cheia', e); }
}
// Inscrição feita pelo próprio admin (ex: anotou no balcão) entra do mesmo jeito que uma inscrição
// pública: pendente até alguém (o próprio admin) clicar em "marcar pago" — assim toda cobrança passa
// pela mesma confirmação, sem exceção, e tanto a atleta (se abrir o link) quanto o admin veem "pendente".
function dadosPagamentoNaInscricao() {
  const valor = Number(state.valorInscricao) || 0;
  return valor > 0 ? { valor, statusPagamento: 'pendente' } : {};
}
function addPlayerHandler() {
  const input = document.getElementById('new-player');
  const name = input.value.trim();
  if (!name) return;
  const catSelect = document.getElementById('new-player-cat');
  const categoria = catSelect ? catSelect.value : '';
  const catKey = categoria || DEFAULT_CAT;
  const temValor = Number(state.valorInscricao) > 0;
  // Mesmo cadastrando você mesmo (admin), se a categoria já bateu o limite de vagas, entra na fila de
  // espera igual uma inscrição pública — o limite vale pra todo mundo, sem atalho por ser admin.
  const filaEspera = categoriaLotada('players', catKey);
  const novoJogador = { id: uid(), name, categoria, confirmada: !temValor && !filaEspera, oculto: false, ...dadosPagamentoNaInscricao() };
  if (filaEspera) novoJogador.filaEspera = true;
  persist({ ...state, players: [...state.players, novoJogador] });
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
  const catKey = categoria || DEFAULT_CAT;
  const name = montarNomeDupla(j1, j2, semParceiro);
  const temValor = Number(state.valorInscricao) > 0;
  const filaEspera = categoriaLotada('teams', catKey);
  const novaDupla = { id: uid(), name, jogador1: j1, telefone1: tel1, jogador2: j2, telefone2: tel2, semParceiro, categoria, confirmada: !temValor && !filaEspera, oculto: false, ...dadosPagamentoNaInscricao() };
  if (filaEspera) novaDupla.filaEspera = true;
  persist({ ...state, teams: [...state.teams, novaDupla] });
  lembrarAtleta(j1, tel1);
  if (j2) lembrarAtleta(j2, tel2);
}
// Abre o card de pagamento logo após a inscrição — mostra a chave Pix da conta (config/pix) em
// texto, pro atleta pagar manualmente, e o campo pra anexar o comprovante.
function abrirPagamento(list, id) {
  pubPagamentoAtivo = { list, id };
  pubPagamentoErroMsg = null;
  render();
}
// Redimensiona/comprime uma imagem no navegador antes de subir (economiza dados do celular de quem
// tá se inscrevendo e espaço no Storage). PDF passa direto, sem mexer.
function comprimirImagemSeForImagem(file) {
  if (!file.type.startsWith('image/')) return Promise.resolve(file);
  return new Promise((resolve) => {
    const imgUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxLado = 1400;
      const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * escala);
      canvas.height = Math.round(img.height * escala);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(imgUrl);
      canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(imgUrl); resolve(file); }; // se der ruim, sobe o original
    img.src = imgUrl;
  });
}
// Converte o arquivo (já comprimido, se for imagem) numa data URL base64 — assim dá pra guardar o
// comprovante direto no Realtime Database, sem precisar do Cloud Storage (que exige plano Blaze/cartão).
function arquivoParaDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
// Guarda o comprovante (print/PDF do Pix) como base64 num nó separado do Realtime Database
// (comprovantes/{torneio}/{lista}__{id}) — nunca dentro do próprio registro do atleta/dupla, pra não
// pesar o carregamento normal da tela (que já baixa o torneio inteiro a cada mudança). Marca a
// inscrição como "aguardando confirmação" — o admin confere e confirma manualmente, sem taxa de gateway.
async function enviarComprovanteHandler(list, id, file) {
  if (!file) return;
  const tipoOk = file.type.startsWith('image/') || file.type === 'application/pdf';
  if (!tipoOk) { pubComprovanteErroMsg = 'Envie uma foto/print ou um PDF do comprovante.'; render(); return; }
  if (file.size > 4 * 1024 * 1024) { pubComprovanteErroMsg = 'Arquivo muito grande (máx. 4 MB).'; render(); return; }
  pubComprovanteEnviando = true;
  pubComprovanteErroMsg = null;
  render();
  try {
    const arquivo = await comprimirImagemSeForImagem(file);
    const dataUrl = await arquivoParaDataUrl(arquivo);
    const caminho = `comprovantes/${currentTournamentId}/${list}__${id}`;
    await set(ref(db, caminho), { dataUrl, contentType: arquivo.type || file.type, enviadoEm: Date.now() });
    const registro = (state[list] || []).find((x) => x.id === id);
    const patch = { comprovantePath: caminho, comprovanteEnviadoEm: Date.now() };
    if (registro && registro.statusPagamento !== 'pago') patch.statusPagamento = 'aguardando_confirmacao';
    persist({ ...state, [list]: state[list].map((x) => x.id === id ? { ...x, ...patch } : x) });
  } catch (e) {
    console.error('Falha ao enviar comprovante', e);
    pubComprovanteErroMsg = 'Não foi possível enviar o comprovante agora. Tente de novo em instantes.';
  }
  pubComprovanteEnviando = false;
  render();
}
// Admin: busca o comprovante no Realtime Database só na hora do clique, monta um Blob local e abre
// numa aba nova — nada fica em cache/URL pública, só existe enquanto essa aba estiver aberta.
async function verComprovanteHandler(caminho) {
  try {
    const snap = await get(ref(db, caminho));
    const dados = snap.val();
    if (!dados || !dados.dataUrl) { alert('Comprovante não encontrado (pode ter sido removido).'); return; }
    const resposta = await fetch(dados.dataUrl);
    const blob = await resposta.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    console.error('Falha ao abrir comprovante', e);
    alert('Não foi possível abrir o comprovante agora. Tente de novo.');
  }
}
// Só conta como vaga realmente ocupada quem já está confirmada de verdade: pagou (torneio pago) ou
// foi confirmada pelo admin (torneio grátis). Quem ainda está "pendente"/"aguardando confirmação" não
// trava vaga de ninguém — assim o limite reflete vagas garantidas, não só gente que demonstrou interesse.
function vagaConfirmadaDe(x) {
  return Number(state.valorInscricao) > 0 ? x.statusPagamento === 'pago' : !!x.confirmada;
}
// Quantas vagas já estão ocupadas numa categoria — conta só quem já confirmou de verdade, não está na
// fila de espera, e não foi ocultada/removida.
function vagasOcupadas(listKey, catKey) {
  return state[listKey].filter((x) => categoriaOf(x) === catKey && !x.oculto && !x.filaEspera && vagaConfirmadaDe(x)).length;
}
// Limite configurado pra uma categoria específica. Se o admin nunca configurou nada pra essa
// categoria, cai no antigo campo único (limiteInscritos) como fallback — assim torneios configurados
// antes de existir o limite por categoria continuam funcionando do jeito que estavam.
function limiteDaCategoria(catKey) {
  const porCategoria = state.limitesPorCategoria || {};
  if (Object.prototype.hasOwnProperty.call(porCategoria, catKey)) return Number(porCategoria[catKey]) || 0;
  return Number(state.limiteInscritos) || 0;
}
function categoriaLotada(listKey, catKey) {
  const limite = limiteDaCategoria(catKey);
  return limite > 0 && vagasOcupadas(listKey, catKey) >= limite;
}
function pubAddPlayerHandler() {
  const nameInput = document.getElementById('pub-player-name');
  const phoneInput = document.getElementById('pub-player-phone');
  const name = nameInput.value.trim();
  const telefone = phoneInput.value.trim();
  if (!name || !telefone) { alert('Preencha nome e telefone pra se inscrever.'); return; }
  const catKey = currentCategoria();
  const categoria = catKey === DEFAULT_CAT ? '' : catKey;
  const valor = Number(state.valorInscricao) || 0;
  const novoId = uid();
  const filaEspera = categoriaLotada('players', catKey);
  const novoJogador = { id: novoId, name, telefone, categoria, confirmada: false, oculto: false };
  if (filaEspera) novoJogador.filaEspera = true;
  if (valor > 0) { novoJogador.valor = valor; novoJogador.statusPagamento = 'pendente'; }
  persist({ ...state, players: [...state.players, novoJogador] });
  lembrarAtleta(name, telefone);
  nameInput.value = ''; phoneInput.value = '';
  if (valor > 0) {
    abrirPagamento('players', novoId);
  } else {
    pubSignupFlash = filaEspera ? `"${name}" entrou na fila de espera 🕓 (vagas lotadas — avisamos se abrir uma vaga)` : `"${name}" inscrita(o) ✓ (aguardando confirmação do organizador)`;
    render();
    setTimeout(() => { pubSignupFlash = null; render(); }, 3500);
  }
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
  // Dupla é sempre cobrada pelo valor cheio, mesmo "sem parceiro(a)" — não existe cobrança "meia dupla".
  const valor = Number(state.valorInscricao) || 0;
  const novoId = uid();
  const filaEspera = categoriaLotada('teams', catKey);
  const novaDupla = { id: novoId, name, jogador1: j1, telefone1: tel1, jogador2: j2, telefone2: tel2, semParceiro, categoria, confirmada: false, oculto: false };
  if (filaEspera) novaDupla.filaEspera = true;
  if (valor > 0) { novaDupla.valor = valor; novaDupla.statusPagamento = 'pendente'; }
  persist({ ...state, teams: [...state.teams, novaDupla] });
  lembrarAtleta(j1, tel1);
  if (j2) lembrarAtleta(j2, tel2);
  document.getElementById('pub-team-j1').value = '';
  document.getElementById('pub-team-tel1').value = '';
  document.getElementById('pub-team-j2').value = '';
  document.getElementById('pub-team-tel2').value = '';
  document.getElementById('pub-team-sem-parceiro').checked = false;
  if (valor > 0) {
    abrirPagamento('teams', novoId);
  } else {
    pubSignupFlash = filaEspera ? `"${name}" entrou na fila de espera 🕓 (vagas lotadas — avisamos se abrir uma vaga)` : `"${name}" inscrita ✓ (aguardando confirmação do organizador)`;
    render();
    setTimeout(() => { pubSignupFlash = null; render(); }, 3500);
  }
}
// Admin: tira alguém da fila de espera e libera a vaga normal — a partir daí segue o fluxo comum
// (pagamento/confirmação), como se tivesse se inscrito agora.
function aprovarFilaEsperaHandler(list, id) {
  const key = list === 'players' ? 'players' : 'teams';
  persist({ ...state, [key]: state[key].map((x) => x.id === id ? { ...x, filaEspera: false } : x) });
}
function toggleConfirmHandler(list, id) {
  const key = list === 'players' ? 'players' : 'teams';
  persist({ ...state, [key]: state[key].map((x) => x.id === id ? { ...x, confirmada: !x.confirmada } : x) });
}
function toggleOcultoHandler(list, id) {
  const key = list === 'players' ? 'players' : 'teams';
  persist({ ...state, [key]: state[key].map((x) => x.id === id ? { ...x, oculto: !x.oculto } : x) });
}
// Marcar como pago (admin) — usado tanto pra confirmar manualmente uma inscrição pendente quanto pra
// aprovar uma autodeclaração ("já paguei") do atleta. Também liga "confirmada", que é o campo que o
// resto do app (sorteio, chaveamento) já usa pra saber quem participa de fato.
function marcarPagoHandler(list, id) {
  const key = list === 'players' ? 'players' : 'teams';
  persist({ ...state, [key]: state[key].map((x) => x.id === id ? { ...x, statusPagamento: 'pago', confirmada: true } : x) });
}
// Desfaz um pagamento confirmado, ou rejeita uma autodeclaração que não bateu com o extrato — volta pra pendente.
function desmarcarPagoHandler(list, id) {
  const key = list === 'players' ? 'players' : 'teams';
  persist({ ...state, [key]: state[key].map((x) => x.id === id ? { ...x, statusPagamento: 'pendente', confirmada: false } : x) });
}
// Autodeclaração do próprio atleta/dupla ("já paguei") — fica "aguardando confirmação", NÃO confirma
// sozinha. Só quando o organizador aprova (marcarPagoHandler) é que a inscrição vira confirmada de fato.
function pubDeclararPagoHandler(list, id) {
  const key = list === 'players' ? 'players' : 'teams';
  persist({ ...state, [key]: state[key].map((x) => x.id === id ? { ...x, statusPagamento: 'aguardando_confirmacao' } : x) });
}
function agendamentosAutoParaRounds(roundsPorCategoria, dataInput, horaInput, duracao, agendamentosBase, pausaInicio, pausaFim) {
  const agendamentos = { ...agendamentosBase };
  const pausaInicioMin = pausaInicio ? horaParaMinutos(pausaInicio) : null;
  const pausaFimMin = pausaFim ? horaParaMinutos(pausaFim) : null;
  Object.values(roundsPorCategoria).forEach((catRounds) => {
    let cursorMin = horaParaMinutos(horaInput);
    catRounds.forEach((rd) => {
      cursorMin = ajustarCursorParaPausa(cursorMin, pausaInicioMin, pausaFimMin);
      const horaStr = minutosParaHora(cursorMin);
      rd.matches.forEach((m2) => { agendamentos[m2.id] = { data: dataInput, hora: horaStr }; });
      cursorMin += duracao;
    });
  });
  return agendamentos;
}
function agendamentosAutoParaGrupos(novosGrupos, dataInput, horaInput, duracao, agendamentosBase, pausaInicio, pausaFim) {
  const agendamentos = { ...agendamentosBase };
  const pausaInicioMin = pausaInicio ? horaParaMinutos(pausaInicio) : null;
  const pausaFimMin = pausaFim ? horaParaMinutos(pausaFim) : null;
  const porCategoria = {};
  novosGrupos.forEach((g) => { (porCategoria[g.categoria] ||= []).push(g); });
  Object.values(porCategoria).forEach((grupos) => {
    let cursorMin = horaParaMinutos(horaInput);
    grupos.forEach((g) => {
      cursorMin = ajustarCursorParaPausa(cursorMin, pausaInicioMin, pausaFimMin);
      const horaStr = minutosParaHora(cursorMin);
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
    if (!distribuicaoRodadasEhJusta(catPlayers.length, courtsReais, state.numRounds)) {
      const catLabelTxt = catKey === DEFAULT_CAT ? '' : ` na categoria "${catLabel(catKey)}"`;
      const numeroImpar = catPlayers.length % 2 === 1;
      const sugestao = numeroImpar
        ? 'Com número ímpar de jogadoras, não dá pra sortear direto com esse número de rodadas. Use o campo "quantos jogos cada jogadora deve jogar" (em Quadras e Rodadas) — ele calcula e preenche um número de rodadas que funciona automaticamente.'
        : `Rodadas que resultam em jogos 100% iguais pra todas: ${proximasRodadasJustasReais(catPlayers.length, courtsReais).join(', ')}.\n\nAjuste o número de rodadas e tente sortear de novo.`;
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
    novoState.agendamentos = agendamentosAutoParaRounds(newRounds, state.dataInicio, state.horaInicioTorneio, state.duracaoJogoMin || 40, state.agendamentos, state.pausaInicio, state.pausaFim);
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
    novoState.agendamentos = agendamentosAutoParaGrupos(novosGrupos, state.dataInicio, state.horaInicioTorneio, state.duracaoJogoMin || 40, state.agendamentos, state.pausaInicio, state.pausaFim);
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
  const pausaInicioMin = state.pausaInicio ? horaParaMinutos(state.pausaInicio) : null;
  const pausaFimMin = state.pausaFim ? horaParaMinutos(state.pausaFim) : null;
  let cursorMin = horaParaMinutos(horaInput);
  const agendamentos = { ...state.agendamentos };
  faseOrder.forEach((fase) => {
    cursorMin = ajustarCursorParaPausa(cursorMin, pausaInicioMin, pausaFimMin);
    const horaStr = minutosParaHora(cursorMin);
    byFase[fase].forEach((it) => { agendamentos[it.id] = { data: dataInput, hora: horaStr }; });
    cursorMin += duracao;
  });
  persist({ ...state, agendamentos });
}

// Troca dois jogos de lugar na agenda: primeiro clique marca o jogo, segundo clique (em outro jogo)
// troca quadra (quando existe — só faz sentido no Americano, que tem quadra fixa por partida; no
// Torneio/chaves não existe esse conceito, então só o horário troca) e data/horário entre os dois.
// Clicar de novo no mesmo jogo cancela a seleção.
function marcarTrocarJogoHandler(matchId) {
  if (jogoSelecionadoParaTroca === matchId) { jogoSelecionadoParaTroca = null; render(); return; }
  if (!jogoSelecionadoParaTroca) { jogoSelecionadoParaTroca = matchId; render(); return; }
  trocarJogosHandler(jogoSelecionadoParaTroca, matchId);
  jogoSelecionadoParaTroca = null;
}
function trocarJogosHandler(idA, idB) {
  let courtA, courtB;
  Object.values(state.rounds || {}).forEach((rodadas) => {
    rodadas.forEach((rd) => rd.matches.forEach((m) => {
      if (m.id === idA) courtA = m.court;
      if (m.id === idB) courtB = m.court;
    }));
  });
  let rounds = state.rounds;
  if (courtA !== undefined && courtB !== undefined) {
    rounds = {};
    Object.keys(state.rounds).forEach((catKey) => {
      rounds[catKey] = state.rounds[catKey].map((rd) => ({
        ...rd,
        matches: rd.matches.map((m) => {
          if (m.id === idA) return { ...m, court: courtB };
          if (m.id === idB) return { ...m, court: courtA };
          return m;
        }),
      }));
    });
  }
  const agA = state.agendamentos[idA] || { data: '', hora: '' };
  const agB = state.agendamentos[idB] || { data: '', hora: '' };
  persist({ ...state, rounds, agendamentos: { ...state.agendamentos, [idA]: agB, [idB]: agA } });
}
// Troca os confrontos de duas rodadas do Americano entre si (ex: os jogos que sairiam na rodada 2
// passam a acontecer na 4, e vice-versa) — útil quando o sorteio já saiu mas a ordem de disputa
// precisa mudar. O CONTEÚDO (jogos/duplas/folgas) troca de posição, e o horário/data acompanha a
// POSIÇÃO da rodada (não o jogo) — ou seja, a rodada que era "das 9h" continua sendo a rodada das
// 9h, só que agora com as duplas que antes jogariam na outra. Mesma lógica de trocarJogosHandler,
// só que aplicada a todos os jogos da rodada de uma vez (dentro da mesma rodada, todo mundo já
// compartilha o mesmo horário — ver agendamentosAutoParaRounds).
function trocarRodadasHandler(catKey, indiceA, indiceB) {
  const rodadas = [...(state.rounds[catKey] || [])];
  if (!rodadas[indiceA] || !rodadas[indiceB] || rodadas[indiceA].isFinal || rodadas[indiceB].isFinal) return;
  const { matches: matchesA, byes: byesA } = rodadas[indiceA];
  const { matches: matchesB, byes: byesB } = rodadas[indiceB];
  rodadas[indiceA] = { ...rodadas[indiceA], matches: matchesB, byes: byesB };
  rodadas[indiceB] = { ...rodadas[indiceB], matches: matchesA, byes: byesA };

  const semHorario = { data: '', hora: '' };
  const horaA = matchesA[0] ? (state.agendamentos[matchesA[0].id] || semHorario) : semHorario;
  const horaB = matchesB[0] ? (state.agendamentos[matchesB[0].id] || semHorario) : semHorario;
  const agendamentos = { ...state.agendamentos };
  matchesB.forEach((m) => { agendamentos[m.id] = horaA; });
  matchesA.forEach((m) => { agendamentos[m.id] = horaB; });

  persist({ ...state, rounds: { ...state.rounds, [catKey]: rodadas }, agendamentos });
}
function marcarTrocarRodadaHandler(catKey, indice) {
  if (rodadaSelecionadaParaTroca && rodadaSelecionadaParaTroca.catKey === catKey && rodadaSelecionadaParaTroca.indice === indice) {
    rodadaSelecionadaParaTroca = null; render(); return;
  }
  if (!rodadaSelecionadaParaTroca) { rodadaSelecionadaParaTroca = { catKey, indice }; render(); return; }
  if (rodadaSelecionadaParaTroca.catKey === catKey) trocarRodadasHandler(catKey, rodadaSelecionadaParaTroca.indice, indice);
  rodadaSelecionadaParaTroca = null;
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

// ============================ Reserva de quadra ============================
// Agenda geral do clube pra jogo avulso, sem relação nenhuma com os torneios (torneios/{id} não é
// tocado aqui). Qualquer pessoa com o link (?reservas=1) vê os horários livres/ocupados e pode
// reservar sozinha; o clube confere o Pix e confirma manualmente — mesmo fluxo das inscrições.
// Dados: reservas/{data}/{quadraId}/{horario} = { id, nome, telefone, status, origem, criadoEm };
// lista de quadras em config/quadrasReserva ([{id,nome}]); comprovante em comprovantes/reservas/{id}.
// Escolha de privacidade: o público vê só "Reservado" (sem nome/telefone) — só o admin vê os dados
// de quem reservou.

function entrarReservas() {
  reservasView = true;
  if (!selectedReservaData || selectedReservaData < hojeISO()) selectedReservaData = hojeISO();
  if (!unsubQuadrasReserva) {
    unsubQuadrasReserva = onValue(ref(db, 'config/quadrasReserva'), (snap) => {
      const v = snap.val();
      quadrasReserva = Array.isArray(v) ? v.filter(Boolean) : (v ? Object.values(v) : []);
      render();
    }, (err) => {
      console.error('Falha ao ler quadras de reserva', err);
      if (quadrasReserva === null) quadrasReserva = [];
      render();
    });
  }
  if (!unsubReservas) {
    unsubReservas = onValue(ref(db, 'reservas'), (snap) => {
      reservasData = snap.val() || {};
      render();
    }, (err) => {
      // Ex.: regras do Realtime Database ainda não publicadas (o deploy delas é manual neste projeto)
      // — mostra a agenda vazia em vez de travar no "Carregando", e as escritas seguem tratadas com catch.
      console.error('Falha ao ler reservas', err);
      if (reservasData === null) reservasData = {};
      render();
    });
  }
  render();
}
function sairReservas() {
  reservasView = false;
  reservaModal = null;
  reservaFlash = null;
  if (unsubQuadrasReserva) { unsubQuadrasReserva(); unsubQuadrasReserva = null; }
  if (unsubReservas) { unsubReservas(); unsubReservas = null; }
  quadrasReserva = null;
  reservasData = null;
}
function abrirReservasHandler() {
  const url = new URL(window.location.href);
  url.searchParams.set('reservas', '1');
  url.searchParams.delete('t'); url.searchParams.delete('cat'); url.searchParams.delete('tab');
  window.history.pushState({}, '', url);
  entrarReservas();
}
function sairReservasHandler() {
  const url = new URL(window.location.href);
  url.searchParams.delete('reservas');
  window.history.pushState({}, '', url);
  sairReservas();
  render();
}

function isoComOffset(dias) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function datasReserva() {
  const arr = [];
  for (let i = 0; i <= DIAS_ANTECEDENCIA_RESERVA; i++) arr.push(isoComOffset(i));
  return arr;
}
function rotuloDataReserva(iso) {
  const d = new Date(iso + 'T12:00:00');
  const semana = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][d.getDay()];
  return `${semana} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function fimHorarioReserva(horario) {
  return minutosParaHora(horaParaMinutos(horario) + DURACAO_RESERVA_MIN);
}
function reservaPath(data, quadraId, horario) { return `reservas/${data}/${quadraId}/${horario}`; }
function reservaDe(data, quadraId, horario) {
  const porData = reservasData && reservasData[data];
  const porQuadra = porData && porData[quadraId];
  return (porQuadra && porQuadra[horario]) || null;
}
// Um horário só pode ser reservado se ainda não começou. Dia anterior = tudo no passado; hoje =
// compara o início do slot com o relógio; dias à frente = sempre liberado.
function slotReservaNoPassado(data, horario) {
  const hoje = hojeISO();
  if (data < hoje) return true;
  if (data > hoje) return false;
  const [h, m] = horario.split(':').map(Number);
  const agora = new Date();
  return (h * 60 + m) <= (agora.getHours() * 60 + agora.getMinutes());
}
function quadraReservaNome(quadraId) {
  const q = (quadrasReserva || []).find((x) => x.id === quadraId);
  return q ? q.nome : 'Quadra removida';
}

function renderReservas() {
  const carregando = quadrasReserva === null || reservasData === null;
  const quadras = quadrasReserva || [];
  root.innerHTML = `
    <header class="hp-header">
      <div class="hp-header-inner">
        <div class="hp-brand">
          <img class="hp-logo" src="./logo.png" alt="Hit Padel Tuparendi" />
          <div><div class="hp-name">RESERVAR QUADRA</div><div class="hp-live"><span class="dot"></span> agenda do clube</div></div>
        </div>
        <div class="hp-header-actions">
          <button class="hp-back-btn" data-action="voltar-lobby-de-reservas">◀ Torneios</button>
          <button class="hp-admin-btn ${isAdmin ? 'on' : ''}" data-action="toggle-admin">${isAdmin ? 'Admin' : 'Ver como admin'}</button>
        </div>
      </div>
    </header>
    <main class="hp-main">
      ${reservaFlash ? `<div class="signup-ok" style="margin-top:14px">${esc(reservaFlash)}</div>` : ''}
      ${isAdmin ? renderGestaoQuadrasReserva() : ''}
      ${carregando ? `<div class="hint" style="margin-top:20px">Carregando agenda...</div>` : renderGradeReservas(quadras)}
    </main>
    <datalist id="atletas-datalist">${Object.values(atletasConhecidos).map((a) => `<option value="${esc(a.nome)}"></option>`).join('')}</datalist>
    <div id="pin-modal-slot"></div>
    ${reservaModal ? renderReservaModal() : ''}
    <footer class="hp-footer">atualiza automaticamente</footer>
  `;
  bindEvents();
}

function renderGestaoQuadrasReserva() {
  const quadras = quadrasReserva || [];
  return `
    <section class="card" style="margin-top:16px">
      <div class="card-head-static">🏟️ Quadras disponíveis pra reserva</div>
      <div class="card-body">
        <div class="hint" style="text-align:left;margin-bottom:6px">Lista exclusiva da agenda de reservas avulsas — não tem relação com as quadras dos torneios.</div>
        ${quadras.length ? quadras.map((q) => `
          <div class="reserva-quadra-gestao-item">
            <input value="${esc(q.nome)}" data-action="reserva-set-quadra-nome" data-id="${esc(q.id)}" />
            <button class="mode-btn btn-danger" data-action="reserva-remove-quadra" data-id="${esc(q.id)}" data-nome="${esc(q.nome)}">Remover</button>
          </div>
        `).join('') : `<div class="hint">Nenhuma quadra cadastrada ainda — adicione a primeira abaixo.</div>`}
        <div class="row" style="margin-top:8px">
          <input id="reserva-nova-quadra" placeholder="Nome da quadra (ex: Quadra 01)" />
          <button data-action="reserva-add-quadra">+</button>
        </div>
      </div>
    </section>
  `;
}

function renderGradeReservas(quadras) {
  if (!quadras.length) {
    return `<div class="card" style="margin-top:16px"><div class="card-body"><div class="hint" style="text-align:left">${isAdmin ? 'Cadastre pelo menos uma quadra acima pra abrir a agenda de reservas.' : 'A agenda de reservas ainda não está disponível. Fale com o clube.'}</div></div></div>`;
  }
  const datas = datasReserva();
  const dataAtual = selectedReservaData || hojeISO();
  const ehPassado = dataAtual < hojeISO();
  return `
    <div class="tabs reserva-datas" style="margin-top:16px">
      ${datas.map((d) => `<button class="tab ${d === dataAtual ? 'active' : ''}" data-action="reserva-sel-data" data-data="${d}">${esc(rotuloDataReserva(d))}${d === hojeISO() ? ' · hoje' : ''}</button>`).join('')}
    </div>
    ${isAdmin ? `<div class="reserva-toolbar"><span class="hint">Ver outra data (histórico):</span><input type="date" data-action="reserva-data-livre" value="${esc(dataAtual)}" /></div>` : ''}
    ${ehPassado ? `<div class="hint hint-alerta" style="text-align:left;margin-bottom:8px">Data no passado — não é possível reservar${isAdmin ? '; dá só pra editar/cancelar pra organizar o histórico' : ''}.</div>` : ''}
    <div class="reserva-legenda">
      <span><span class="reserva-dot livre"></span> Livre</span>
      <span><span class="reserva-dot ocupada"></span> Reservado</span>
      <span><span class="reserva-dot pendente"></span> Aguardando pagamento</span>
    </div>
    <div class="table-scroll">
      <table class="reserva-grid">
        <thead>
          <tr><th>Horário</th>${quadras.map((q) => `<th>${esc(q.nome)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${HORARIOS_RESERVA.map((h) => `
            <tr>
              <td class="reserva-hora">${h}<br>–${fimHorarioReserva(h)}</td>
              ${quadras.map((q) => renderCelulaReserva(dataAtual, q, h)).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderCelulaReserva(data, quadra, horario) {
  const r = reservaDe(data, quadra.id, horario);
  const passado = slotReservaNoPassado(data, horario);
  if (!r) {
    if (passado) return `<td class="reserva-cel reserva-cel-passado">—</td>`;
    return `<td class="reserva-cel reserva-cel-livre" data-action="reserva-abrir" data-data="${data}" data-quadra="${esc(quadra.id)}" data-horario="${horario}">Livre</td>`;
  }
  const pend = r.status !== 'confirmada';
  if (!isAdmin) {
    return `<td class="reserva-cel reserva-cel-ocupada ${pend ? 'reserva-cel-pendente' : ''}">${pend ? '⏳ ' : ''}Reservado</td>`;
  }
  return `
    <td class="reserva-cel reserva-cel-ocupada ${pend ? 'reserva-cel-pendente' : ''}">
      <div class="reserva-cel-nome">${esc(r.nome || '—')}</div>
      ${r.telefone ? `<div class="reserva-cel-tel">${esc(r.telefone)}</div>` : ''}
      <div class="reserva-cel-badge">${pend ? '⏳ pendente' : '✓ confirmada'} · ${r.origem === 'admin' ? 'balcão' : 'cliente'}${r.comprovante ? ' · 📎' : ''}</div>
      <div class="reserva-cel-acoes">
        <button data-action="reserva-toggle-status" data-data="${data}" data-quadra="${esc(quadra.id)}" data-horario="${horario}">${pend ? 'Confirmar' : 'Tornar pendente'}</button>
        <button data-action="reserva-editar" data-data="${data}" data-quadra="${esc(quadra.id)}" data-horario="${horario}">Editar</button>
        ${r.comprovante ? `<button data-action="reserva-ver-comprovante" data-id="${esc(r.id)}">Comprovante</button>` : ''}
        <button class="btn-danger" data-action="reserva-cancelar" data-data="${data}" data-quadra="${esc(quadra.id)}" data-horario="${horario}" data-nome="${esc(r.nome || '')}">Cancelar</button>
      </div>
    </td>
  `;
}

function renderReservaModal() {
  const { modo, data, quadraId, horario } = reservaModal;
  const tituloSlot = `${quadraReservaNome(quadraId)} · ${rotuloDataReserva(data)} · ${horario}–${fimHorarioReserva(horario)}`;
  if (modo === 'pagamento') {
    const temChave = !!(pixConfig && pixConfig.chave);
    const r = reservaDe(data, quadraId, horario);
    const jaEnviou = !!(r && r.comprovante);
    return `
    <div class="modal-bg" data-action="reserva-modal-bg"><div class="modal">
      <div class="modal-title">Reserva registrada</div>
      <div class="hint" style="text-align:left;margin-bottom:8px">${esc(tituloSlot)}</div>
      <div class="hint" style="text-align:left;margin-bottom:8px">✅ Sua reserva foi registrada e fica <strong>pendente</strong> até o clube confirmar o pagamento.</div>
      ${temChave ? `
        <label style="font-size:12px;opacity:.6">Chave Pix</label>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
          <input readonly class="pix-copia-cola" style="min-height:auto;padding:9px 12px;font-family:inherit;font-size:14px" value="${esc(pixConfig.chave)}" />
          <button class="mode-btn" data-action="reserva-copiar-pix" data-texto="${esc(pixConfig.chave)}">📋</button>
        </div>
        ${pixConfig.nome ? `<div class="hint" style="text-align:left;margin-bottom:8px">Recebedor: ${esc(pixConfig.nome)}${pixConfig.cidade ? ` — ${esc(pixConfig.cidade)}` : ''}</div>` : ''}
      ` : `<div class="hint hint-alerta" style="text-align:left;margin-bottom:8px">O clube ainda não configurou a chave Pix — combine o pagamento direto com o clube.</div>`}
      <label style="font-size:12px;opacity:.6;margin-top:8px;display:block">📎 Anexar comprovante (foto ou PDF)</label>
      <input type="file" accept="image/*,application/pdf" id="reserva-comprovante-input" style="margin-bottom:8px" />
      <button class="btn-primary" data-action="reserva-enviar-comprovante" ${reservaEnviandoComprovante ? 'disabled' : ''}>${reservaEnviandoComprovante ? 'Enviando...' : 'Enviar comprovante'}</button>
      ${reservaErroMsg ? `<div class="hint hint-alerta" style="text-align:left;margin-top:4px">${esc(reservaErroMsg)}</div>` : ''}
      ${jaEnviou ? `<div class="hint" style="text-align:left;margin-top:6px">✓ Comprovante enviado — aguardando o clube conferir.</div>` : ''}
      <div class="modal-actions" style="margin-top:10px"><button data-action="reserva-fechar-modal">Fechar</button></div>
    </div></div>`;
  }
  if (modo === 'editar') {
    const r = reservaDe(data, quadraId, horario) || {};
    const quadras = quadrasReserva || [];
    return `
    <div class="modal-bg" data-action="reserva-modal-bg"><div class="modal">
      <div class="modal-title">Editar reserva</div>
      <label style="font-size:12px;opacity:.6">Nome</label>
      <input id="reserva-nome" value="${esc(r.nome || '')}" />
      <label style="font-size:12px;opacity:.6">Telefone</label>
      <input id="reserva-telefone" value="${esc(r.telefone || '')}" />
      <label style="font-size:12px;opacity:.6">Status</label>
      <select id="reserva-status">
        <option value="pendente" ${r.status !== 'confirmada' ? 'selected' : ''}>Pendente</option>
        <option value="confirmada" ${r.status === 'confirmada' ? 'selected' : ''}>Confirmada</option>
      </select>
      <label style="font-size:12px;opacity:.6">Quadra</label>
      <select id="reserva-quadra">
        ${quadras.map((q) => `<option value="${esc(q.id)}" ${q.id === quadraId ? 'selected' : ''}>${esc(q.nome)}</option>`).join('')}
      </select>
      <label style="font-size:12px;opacity:.6">Data</label>
      <select id="reserva-data">
        ${datasReserva().map((d) => `<option value="${d}" ${d === data ? 'selected' : ''}>${esc(rotuloDataReserva(d))}</option>`).join('')}
      </select>
      <label style="font-size:12px;opacity:.6">Horário</label>
      <select id="reserva-horario">
        ${HORARIOS_RESERVA.map((h) => `<option value="${h}" ${h === horario ? 'selected' : ''}>${h}–${fimHorarioReserva(h)}</option>`).join('')}
      </select>
      ${reservaErroMsg ? `<div class="hint hint-alerta" style="text-align:left">${esc(reservaErroMsg)}</div>` : ''}
      <div class="modal-actions"><button data-action="reserva-fechar-modal">Cancelar</button><button class="btn-primary" data-action="reserva-salvar-edicao">Salvar</button></div>
    </div></div>`;
  }
  // modo 'novo'
  return `
    <div class="modal-bg" data-action="reserva-modal-bg"><div class="modal">
      <div class="modal-title">Reservar horário</div>
      <div class="hint" style="text-align:left;margin-bottom:8px">${esc(tituloSlot)}</div>
      <label style="font-size:12px;opacity:.6">Nome</label>
      <input id="reserva-nome" list="atletas-datalist" placeholder="Nome de quem reserva" />
      <label style="font-size:12px;opacity:.6">Telefone (whatsapp)</label>
      <input id="reserva-telefone" type="tel" placeholder="Telefone pra contato" />
      ${isAdmin
        ? `<label class="checkbox-row"><input type="checkbox" id="reserva-admin-confirmada" /> Já pago / confirmado (pagamento no balcão)</label>`
        : `<div class="hint" style="text-align:left;margin-top:8px">Depois de reservar aparece a chave Pix pra pagar e anexar o comprovante. A reserva fica pendente até o clube confirmar.</div>`}
      ${reservaErroMsg ? `<div class="hint hint-alerta" style="text-align:left">${esc(reservaErroMsg)}</div>` : ''}
      <div class="modal-actions"><button data-action="reserva-fechar-modal">Cancelar</button><button class="btn-primary" data-action="reserva-criar">Reservar</button></div>
    </div></div>`;
}

function abrirModalNovaReserva(data, quadraId, horario) {
  if (slotReservaNoPassado(data, horario)) { alert('Esse horário já passou.'); return; }
  if (reservaDe(data, quadraId, horario)) { alert('Esse horário acabou de ser reservado.'); render(); return; }
  reservaModal = { modo: 'novo', data, quadraId, horario };
  reservaErroMsg = null;
  reservaFlash = null;
  render();
}
function abrirModalEditarReserva(data, quadraId, horario) {
  if (!reservaDe(data, quadraId, horario)) return;
  reservaModal = { modo: 'editar', data, quadraId, horario };
  reservaErroMsg = null;
  render();
}
function fecharReservaModal() {
  reservaModal = null;
  reservaErroMsg = null;
  reservaEnviandoComprovante = false;
  render();
}
// Cria a reserva. Antes de gravar, checa (com o estado atual em memória, sem transação — mesma
// simplicidade do resto do app) se o slot já não foi tomado. Cliente cai na tela de pagamento Pix;
// admin pode marcar "já pago" e sair direto.
async function criarReservaHandler() {
  if (!reservaModal) return;
  const { data, quadraId, horario } = reservaModal;
  const nome = (document.getElementById('reserva-nome')?.value || '').trim();
  const telefone = (document.getElementById('reserva-telefone')?.value || '').trim();
  if (!nome) { reservaErroMsg = 'Preencha o nome.'; render(); return; }
  if (slotReservaNoPassado(data, horario)) { reservaErroMsg = 'Esse horário já passou.'; render(); return; }
  if (reservaDe(data, quadraId, horario)) { reservaErroMsg = 'Esse horário acabou de ser reservado por outra pessoa.'; render(); return; }
  const confirmadaAdmin = isAdmin && !!document.getElementById('reserva-admin-confirmada')?.checked;
  const reserva = {
    id: uid() + uid(),
    nome,
    telefone,
    status: confirmadaAdmin ? 'confirmada' : 'pendente',
    origem: isAdmin ? 'admin' : 'cliente',
    criadoEm: Date.now(),
  };
  try {
    await set(ref(db, reservaPath(data, quadraId, horario)), reserva);
  } catch (e) {
    console.error('Falha ao criar reserva', e);
    reservaErroMsg = 'Não foi possível reservar agora. Tente de novo.';
    render();
    return;
  }
  lembrarAtleta(nome, telefone);
  if (isAdmin) {
    reservaModal = null;
    reservaFlash = `Reserva de ${nome} criada — ${quadraReservaNome(quadraId)}, ${rotuloDataReserva(data)} ${horario}.`;
    render();
    setTimeout(() => { if (reservasView) { reservaFlash = null; render(); } }, 6000);
  } else {
    reservaModal = { modo: 'pagamento', data, quadraId, horario, id: reserva.id };
    reservaErroMsg = null;
    render();
  }
}
function toggleStatusReservaHandler(data, quadraId, horario) {
  const r = reservaDe(data, quadraId, horario);
  if (!r) return;
  const novo = r.status === 'confirmada' ? 'pendente' : 'confirmada';
  set(ref(db, reservaPath(data, quadraId, horario)), { ...r, status: novo }).catch((e) => console.error('Falha ao mudar status da reserva', e));
}
function cancelarReservaHandler(data, quadraId, horario, nome) {
  if (!confirm(`Cancelar a reserva${nome ? ` de "${nome}"` : ''} em ${quadraReservaNome(quadraId)} (${rotuloDataReserva(data)} ${horario})? O horário volta a ficar livre.`)) return;
  set(ref(db, reservaPath(data, quadraId, horario)), null).catch((e) => console.error('Falha ao cancelar reserva', e));
}
// Admin: edita nome/telefone/status e, se quiser, move a reserva pra outra quadra/data/horário
// (grava no novo slot e apaga o antigo). Bloqueia se o slot de destino já estiver ocupado.
async function salvarEdicaoReservaHandler() {
  if (!reservaModal) return;
  const orig = reservaModal;
  const atual = reservaDe(orig.data, orig.quadraId, orig.horario);
  if (!atual) { fecharReservaModal(); return; }
  const nome = (document.getElementById('reserva-nome')?.value || '').trim();
  const telefone = (document.getElementById('reserva-telefone')?.value || '').trim();
  const status = document.getElementById('reserva-status')?.value === 'confirmada' ? 'confirmada' : 'pendente';
  const novaQuadra = document.getElementById('reserva-quadra')?.value || orig.quadraId;
  const novaData = document.getElementById('reserva-data')?.value || orig.data;
  const novoHorario = document.getElementById('reserva-horario')?.value || orig.horario;
  if (!nome) { reservaErroMsg = 'Preencha o nome.'; render(); return; }
  const mudouSlot = novaQuadra !== orig.quadraId || novaData !== orig.data || novoHorario !== orig.horario;
  if (mudouSlot && reservaDe(novaData, novaQuadra, novoHorario)) {
    reservaErroMsg = 'Já existe uma reserva nesse outro horário/quadra.';
    render();
    return;
  }
  const obj = {
    ...atual,
    nome,
    telefone,
    status,
    id: atual.id || (uid() + uid()),
    origem: atual.origem || 'admin',
    criadoEm: atual.criadoEm || Date.now(),
  };
  try {
    await set(ref(db, reservaPath(novaData, novaQuadra, novoHorario)), obj);
    if (mudouSlot) await set(ref(db, reservaPath(orig.data, orig.quadraId, orig.horario)), null);
  } catch (e) {
    console.error('Falha ao salvar edição da reserva', e);
    reservaErroMsg = 'Não foi possível salvar agora. Tente de novo.';
    render();
    return;
  }
  fecharReservaModal();
}
// Comprovante da reserva: base64 num nó separado (comprovantes/reservas/{id}) — mesmo motivo das
// inscrições, não inflar o listener principal com imagem. Marca a reserva com comprovante:true.
async function enviarComprovanteReservaHandler(file) {
  if (!reservaModal || !file) return;
  const { data, quadraId, horario, id } = reservaModal;
  const tipoOk = file.type.startsWith('image/') || file.type === 'application/pdf';
  if (!tipoOk) { reservaErroMsg = 'Envie uma foto/print ou um PDF do comprovante.'; render(); return; }
  if (file.size > 4 * 1024 * 1024) { reservaErroMsg = 'Arquivo muito grande (máx. 4 MB).'; render(); return; }
  reservaEnviandoComprovante = true;
  reservaErroMsg = null;
  render();
  try {
    const arquivo = await comprimirImagemSeForImagem(file);
    const dataUrl = await arquivoParaDataUrl(arquivo);
    await set(ref(db, 'comprovantes/reservas/' + id), { dataUrl, contentType: arquivo.type || file.type, enviadoEm: Date.now() });
    const r = reservaDe(data, quadraId, horario);
    if (r) await set(ref(db, reservaPath(data, quadraId, horario)), { ...r, comprovante: true, comprovanteEnviadoEm: Date.now() });
  } catch (e) {
    console.error('Falha ao enviar comprovante da reserva', e);
    reservaErroMsg = 'Não foi possível enviar o comprovante agora. Tente de novo.';
  }
  reservaEnviandoComprovante = false;
  render();
}
function addQuadraReservaHandler() {
  const input = document.getElementById('reserva-nova-quadra');
  const nome = (input?.value || '').trim();
  if (!nome) return;
  const nova = [...(quadrasReserva || []), { id: uid(), nome }];
  set(ref(db, 'config/quadrasReserva'), nova).catch((e) => console.error('Falha ao adicionar quadra de reserva', e));
}
function renomearQuadraReservaHandler(id, valor) {
  const nome = (valor || '').trim();
  if (!nome) return;
  const nova = (quadrasReserva || []).map((q) => q.id === id ? { ...q, nome } : q);
  set(ref(db, 'config/quadrasReserva'), nova).catch((e) => console.error('Falha ao renomear quadra de reserva', e));
}
function removerQuadraReservaHandler(id, nome) {
  if (!confirm(`Remover a quadra "${nome || 'esta quadra'}" da agenda de reservas? Reservas já feitas nela deixam de aparecer na grade (continuam no banco). Não afeta nenhum torneio.`)) return;
  const nova = (quadrasReserva || []).filter((q) => q.id !== id);
  set(ref(db, 'config/quadrasReserva'), nova).catch((e) => console.error('Falha ao remover quadra de reserva', e));
}

render();
