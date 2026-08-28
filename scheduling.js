// Motor de geração de rodadas, sorteio de duplas, grupos e chaveamento eliminatório.
// Módulo puro: sem DOM, sem Firebase, sem estado global — só recebe dados e devolve dados.
// Extraído de app.js pra poder ser testado isoladamente (ver tests/scheduling.test.mjs).

export const uid = () => Math.random().toString(36).slice(2, 9);
export const pairKey = (a, b) => [a, b].sort().join('~');
export const DEFAULT_CAT = '_default';
export const CATEGORIA_SUGESTOES = ['Cat Iniciante', '7ª Cat', '6ª Cat', '5ª Cat', '4ª Cat', 'Soma 9', 'Soma 11', 'Soma 13', 'Masculina', 'Feminina', 'Mista'];
// Quantas jogadoras realmente entram em quadra numa rodada: limitado pela capacidade das quadras
// (4 por quadra) E arredondado pra baixo até múltiplo de 4, porque não dá pra formar um jogo com
// menos de 4 pessoas — a sobra vira folga também, mesmo quando "cabe" fisicamente na quadra.
export function ativosPorRodadaReal(numPlayers, numCourts) {
  const cap = Math.min(numPlayers, numCourts * 4);
  return cap - (cap % 4);
}
// Uma partida só conta como "jogada" quando os dois placares existem e pelo menos um é maior que 0.
// 0x0 ou campos vazios ficam como pendente (permite salvar um "reset" do placar sem contar como resultado real).
export function partidaJogada(m) {
  return m.scoreA != null && m.scoreB != null && (m.scoreA > 0 || m.scoreB > 0);
}

export function defaultState() {
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
    pausaInicio: '',    // horário em que os jogos param (ex: almoço) — vazio = sem pausa
    pausaFim: '',        // horário em que os jogos retomam depois da pausa
    encerrado: false,
    agendamentos: {},   // { [matchId]: { data, hora } }
    valorInscricao: 0,  // R$ — 0/vazio = torneio gratuito. No tipo 'chaves' é sempre por dupla; nos demais, por atleta.
    limiteInscritos: 0, // legado (limite único pra todas as categorias) — mantido só como fallback pra torneios configurados antes de existir o limite por categoria.
    limitesPorCategoria: {}, // { [categoria]: limite } — 0/vazio = sem limite naquela categoria. Ao bater o limite, novas inscrições entram na fila de espera.
    // [{ id, nome, youtubeId, ativa }] — transmissão ao vivo via YouTube Live, exibida na aba "Ao Vivo".
    // Já nasce com uma câmera por quadra (mesmo padrão de nomesQuadras) pra não precisar cadastrar na mão.
    camerasAoVivo: [{ id: uid(), nome: 'Quadra 01', youtubeId: '', ativa: false }, { id: uid(), nome: 'Quadra 02', youtubeId: '', ativa: false }],
  };
}

export function categoriaOf(entity) { return entity.categoria || DEFAULT_CAT; }
export function categoriaKeys(state) { return state.categorias.length ? state.categorias : [DEFAULT_CAT]; }

// ---------- algoritmo americano (sorteio de duplas rotativas) ----------
export function scoreGroup(g, history) {
  const pA = pairKey(g.teamA[0], g.teamA[1]);
  const pB = pairKey(g.teamB[0], g.teamB[1]);
  let s = (history.partner[pA] || 0) * 3 + (history.partner[pB] || 0) * 3;
  g.teamA.forEach((x) => g.teamB.forEach((y) => { s += history.opponent[pairKey(x, y)] || 0; }));
  return s;
}
export function bestPairing(four, history) {
  const [a, b, c, d] = four;
  const options = [{ teamA: [a, b], teamB: [c, d] }, { teamA: [a, c], teamB: [b, d] }, { teamA: [a, d], teamB: [b, c] }];
  let best = options[0], bestScore = Infinity;
  options.forEach((o) => { const s = scoreGroup(o, history); if (s < bestScore) { bestScore = s; best = o; } });
  return best;
}
// ---------- construção garantida (múltiplos de 4, com quadras suficientes pra ninguém sentar) ----------
// "Método do círculo": um algoritmo clássico de agenda round-robin. Fixa uma jogadora e gira as
// demais numa roda; a cada rodada, forma as parcerias lendo pares opostos na roda. É matematicamente
// comprovado que isso cobre TODAS as parcerias possíveis, exatamente 1 vez cada, em (n-1) rodadas —
// não depende de sorteio, então zero dupla repetida é garantido, não só "bem provável".
export function gerarParceriasRoundRobin(playerIds) {
  const n = playerIds.length;
  const fixo = playerIds[n - 1];
  let girando = playerIds.slice(0, n - 1);
  const rodadas = [];
  for (let r = 0; r < n - 1; r++) {
    const arranjo = [fixo, ...girando];
    const pares = [];
    for (let i = 0; i < n / 2; i++) pares.push([arranjo[i], arranjo[n - 1 - i]]);
    rodadas.push(pares);
    girando = [girando[girando.length - 1], ...girando.slice(0, girando.length - 1)];
  }
  return rodadas;
}
// Todas as formas de dividir uma lista (tamanho par) em pares — usado pra listar toda opção possível
// de "quem enfrenta quem" numa rodada, dado o conjunto de parcerias já fixado nela.
export function particoesEmPares(items) {
  if (items.length === 0) return [[]];
  const [first, ...rest] = items;
  const resultado = [];
  for (let i = 0; i < rest.length; i++) {
    const parceiro = rest[i];
    const restante = rest.slice(0, i).concat(rest.slice(i + 1));
    for (const sub of particoesEmPares(restante)) resultado.push([[first, parceiro], ...sub]);
  }
  return resultado;
}
export function coberturaDeConfrontos(confrontos) {
  const s = new Set();
  confrontos.forEach(([pA, pB]) => pA.forEach((x) => pB.forEach((y) => s.add(pairKey(x, y)))));
  return s;
}
// Busca de verdade (com backtracking), não só tentativa gulosa: pra cada rodada existem poucas formas
// de agrupar as parcerias em confrontos (3 formas pra 4 parcerias, 15 pra 6, 105 pra 8...), e testamos
// as combinações entre rodadas até achar uma que cubra literalmente TODAS as duplas de adversárias —
// se uma escolha travar mais adiante, ela desiste e tenta outra, em vez de só aceitar o melhor palpite
// de cada rodada isolada (que pode nunca fechar cobertura total, mesmo quando ela existe).
export function buscarConfrontosCobrindoTudo(rodadasParcerias, playerIds, nodeLimit) {
  const opcoesPerRound = rodadasParcerias.map((pares) => particoesEmPares(pares).sort(() => Math.random() - 0.5));
  const allPairs = new Set();
  for (let i = 0; i < playerIds.length; i++) for (let j = i + 1; j < playerIds.length; j++) allPairs.add(pairKey(playerIds[i], playerIds[j]));
  const escolha = new Array(opcoesPerRound.length).fill(null);
  const covered = new Set();
  let nodes = 0;
  function backtrack(idx) {
    nodes++;
    if (nodes > nodeLimit) return false;
    if (idx === opcoesPerRound.length) return covered.size === allPairs.size;
    const opts = opcoesPerRound[idx].map((opt) => {
      const cov = coberturaDeConfrontos(opt);
      let novos = 0;
      cov.forEach((p) => { if (!covered.has(p)) novos++; });
      return { opt, cov, novos };
    }).sort((a, b) => b.novos - a.novos);
    for (const { opt, cov } of opts) {
      const added = [];
      cov.forEach((p) => { if (!covered.has(p)) { covered.add(p); added.push(p); } });
      escolha[idx] = opt;
      if (backtrack(idx + 1)) return true;
      added.forEach((p) => covered.delete(p));
      escolha[idx] = null;
    }
    return false;
  }
  return backtrack(0) ? escolha : null;
}
// Gera as rodadas da construção garantida (até n-1 rodadas). Quando dá pra rodar o desenho completo
// (numRounds >= n-1), busca com backtracking até fechar cobertura total de verdade — pra 4/8/12/16
// jogadoras isso é rápido (poucos milissegundos) porque o espaço de busca por rodada é pequeno.
export function gerarRodadasGarantidas(players, numRounds) {
  const playerIds = players.map((p) => p.id);
  const n = playerIds.length;
  const parceriasCompletas = gerarParceriasRoundRobin(playerIds);
  const rodadasUsadas = parceriasCompletas.slice(0, Math.min(numRounds, n - 1));
  const cobrirTudo = numRounds >= n - 1;
  let escolha = null;
  if (cobrirTudo) {
    for (let tentativa = 0; tentativa < 5 && !escolha; tentativa++) {
      escolha = buscarConfrontosCobrindoTudo(rodadasUsadas, playerIds, 400000);
    }
  }
  const rounds = [];
  rodadasUsadas.forEach((pares, idx) => {
    // Sem cobertura total pedida (numRounds < n-1) ou busca não fechou (não deveria acontecer nesses
    // tamanhos): usa o melhor palpite guloso pra essa rodada, só evitando repetir adversárias já vistas.
    let grupos = escolha ? escolha[idx] : null;
    if (!grupos) {
      const opcoes = particoesEmPares(pares);
      let melhorScore = Infinity;
      opcoes.forEach((opt) => {
        let score = 0;
        opt.forEach(([pA, pB]) => { pA.forEach((x) => pB.forEach((y) => { score += rounds.some((rd) => rd.matches.some((m) => (m.teamA.includes(x) && m.teamB.includes(y)) || (m.teamA.includes(y) && m.teamB.includes(x)))) ? 1 : 0; })); });
        if (score < melhorScore) { melhorScore = score; grupos = opt; }
      });
    }
    rounds.push({ round: rounds.length + 1, byes: [], matches: grupos.map((g, i) => ({ id: uid(), court: i + 1, teamA: g[0], teamB: g[1], scoreA: null, scoreB: null })) });
  });
  return rounds;
}
// Constrói o cronograma completo pra quando as quadras NÃO cabem todo mundo ao mesmo tempo
// (numJogadoras % 4 === 0, mas a capacidade real das quadras é menor que numJogadoras): reaproveita
// o método do círculo (gerarParceriasRoundRobin) pra fatiar cada "megarodada" — onde todo mundo
// joga ao mesmo tempo, sem quadra limitando nada — em rodadas do tamanho real das quadras, e
// recombina as sobras de megarodadas diferentes entre si (quando não compartilham jogadora) pra
// desperdiçar o mínimo de rodadas possível. Resultado: cada uma das C(n,2) parcerias acontece
// exatamente 1 vez — nem mais, nem menos — e jogos/folgas ficam idênticos pra todo mundo. Às vezes
// fica 1 rodada acima do mínimo teórico absoluto (o casamento das sobras é determinístico, sem
// sorteio nenhum — ver tentarCasamento — então não garante o máximo absoluto num grafo geral, mas
// SEMPRE dá o mesmo resultado pro mesmo (numJogadoras, numCourts). Isso é de propósito: precisa ser
// estável pra o número mostrado na tela nunca desalinhar do que a geração de verdade produz.
export function gerarRodadasComByesJustos(players, numCourts) {
  const playerIds = players.map((p) => p.id);
  const maxParPorRodada = numCourts * 2;
  const megarodadas = gerarParceriasRoundRobin(playerIds);

  const gruposCheios = [];
  const sobras = []; // { pares: [[a,b],...], jogadores: Set }
  megarodadas.forEach((pares) => {
    for (let i = 0; i < pares.length; i += maxParPorRodada) {
      const grupo = pares.slice(i, i + maxParPorRodada);
      if (grupo.length === maxParPorRodada) gruposCheios.push(grupo);
      else sobras.push({ pares: grupo, jogadores: new Set(grupo.flat()) });
    }
  });

  // Casamento MÁXIMO de verdade (backtracking com poda), não só uma heurística de 1 passada tipo
  // Kuhn — pra combinar o máximo possível de sobras entre si e não desperdiçar rodada nenhuma além
  // do estritamente necessário. Determinístico (ordem fixa, sem Math.random()): o número de rodadas
  // dessa função precisa ser sempre o mesmo pra um dado (numJogadoras, numCourts), senão o número
  // mostrado na tela e o que a geração de verdade produz podem divergir (foi esse bug que motivou
  // trocar a primeira versão, embaralhada, por uma determinística — e essa aqui, testada até 150
  // jogadoras, sempre encontra o casamento perfeito/quase-perfeito em bem menos de 1ms, porque para
  // assim que atinge floor(N/2) — o teto matemático — sem precisar provar que não existe melhor.
  // O nodeLimit é só uma rede de segurança pra nunca travar, mesmo numa estrutura atípica.
  function casamentoMaximo(sobrasList, nodeLimit) {
    const N = sobrasList.length;
    const teto = Math.floor(N / 2);
    const compat = Array.from({ length: N }, () => []);
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      let conflita = false;
      sobrasList[i].jogadores.forEach((x) => { if (sobrasList[j].jogadores.has(x)) conflita = true; });
      if (!conflita) { compat[i].push(j); compat[j].push(i); }
    }
    let melhorCount = 0, melhorMatch = Array(N).fill(-1);
    const matchTo = Array(N).fill(-1);
    let nodes = 0, parar = false;
    function backtrack(idx, count) {
      if (parar) return;
      nodes++;
      if (nodes > nodeLimit) { parar = true; return; }
      if (count + Math.floor((N - idx) / 2) <= melhorCount) return; // poda: não dá pra superar o melhor já achado
      if (idx === N) {
        if (count > melhorCount) { melhorCount = count; melhorMatch = [...matchTo]; }
        if (melhorCount >= teto) parar = true; // já é o máximo matematicamente possível
        return;
      }
      if (matchTo[idx] !== -1) { backtrack(idx + 1, count); return; }
      for (const j of compat[idx]) {
        if (parar) return;
        if (j <= idx || matchTo[j] !== -1) continue;
        matchTo[idx] = j; matchTo[j] = idx;
        backtrack(idx + 1, count + 1);
        matchTo[idx] = -1; matchTo[j] = -1;
      }
      if (!parar) backtrack(idx + 1, count);
    }
    backtrack(0, 0);
    return melhorMatch;
  }

  const matchTo = casamentoMaximo(sobras, 200000);
  const gruposSobra = [];
  const usadoSobra = Array(sobras.length).fill(false);
  for (let i = 0; i < sobras.length; i++) {
    if (usadoSobra[i]) continue;
    const par = matchTo[i];
    if (par !== -1 && !usadoSobra[par]) {
      gruposSobra.push([...sobras[i].pares, ...sobras[par].pares]);
      usadoSobra[i] = true; usadoSobra[par] = true;
    } else {
      gruposSobra.push([...sobras[i].pares]);
      usadoSobra[i] = true;
    }
  }

  const todosGrupos = [...gruposCheios, ...gruposSobra];

  // Dentro de cada rodada as parcerias já estão fixas (garantidas); só falta decidir quem enfrenta
  // quem, minimizando repetição de ADVERSÁRIA como melhoria best-effort (sem garantia — só a
  // parceria em si é garantida matematicamente pelo método do círculo).
  const history = { partner: {}, opponent: {} };
  return todosGrupos.map((equipes, idx) => {
    const jogadoresNaRodada = new Set(equipes.flat());
    const byes = playerIds.filter((id) => !jogadoresNaRodada.has(id));
    const opcoes = particoesEmPares(equipes);
    let melhorOpt = opcoes[0], melhorScore = Infinity;
    opcoes.forEach((opt) => {
      const score = opt.reduce((acc, [teamA, teamB]) => acc + scoreGroup({ teamA, teamB }, history), 0);
      if (score < melhorScore) { melhorScore = score; melhorOpt = opt; }
    });
    (melhorOpt || []).forEach(([teamA, teamB]) => {
      const pA = pairKey(teamA[0], teamA[1]), pB = pairKey(teamB[0], teamB[1]);
      history.partner[pA] = (history.partner[pA] || 0) + 1;
      history.partner[pB] = (history.partner[pB] || 0) + 1;
      teamA.forEach((x) => teamB.forEach((y) => { const k = pairKey(x, y); history.opponent[k] = (history.opponent[k] || 0) + 1; }));
    });
    return {
      round: idx + 1,
      byes,
      matches: (melhorOpt || []).map(([teamA, teamB], i) => ({ id: uid(), court: i + 1, teamA, teamB, scoreA: null, scoreB: null })),
    };
  });
}
export function generateSchedule(players, numCourts, numRounds) {
  const history = { partner: {}, opponent: {} };
  const n = players.length;
  const ativosPorRodada = ativosPorRodadaReal(n, numCourts);
  const rounds = [];
  let cursor = 0;
  // Quando dá pra usar a construção garantida (múltiplo de 4, ninguém fica de fora), usa ela pra
  // gerar o máximo de rodadas possível sem repetir dupla nunca — só o excedente (além de n-1 rodadas,
  // que já é o máximo matematicamente livre de repetição) continua pelo sorteio de sempre.
  // Limitado a até 16 jogadoras: acima disso a quantidade de jeitos de agrupar parcerias em confrontos
  // cresce rápido demais (fatorial) pra buscar com backtracking em tempo razoável no navegador — nesse
  // caso cai pro sorteio de sempre, que já era o comportamento antes dessa melhoria.
  if (n % 4 === 0 && n >= 4 && n <= 16 && ativosPorRodada === n) {
    const garantidas = gerarRodadasGarantidas(players, numRounds);
    if (garantidas && garantidas.length) {
      garantidas.forEach((rd) => {
        rd.matches.forEach((m) => {
          const pA = pairKey(m.teamA[0], m.teamA[1]), pB = pairKey(m.teamB[0], m.teamB[1]);
          history.partner[pA] = (history.partner[pA] || 0) + 1;
          history.partner[pB] = (history.partner[pB] || 0) + 1;
          m.teamA.forEach((x) => m.teamB.forEach((y) => { const k = pairKey(x, y); history.opponent[k] = (history.opponent[k] || 0) + 1; }));
        });
        rounds.push(rd);
      });
    }
  }
  // Cobre o que sobrou pro ramo acima: qualquer múltiplo de 4 que o ramo garantido não pegou —
  // seja porque as quadras não cabem todo mundo (sobra folga toda rodada), seja porque n > 16 (onde
  // a busca de cobertura de adversárias do ramo acima fica cara demais, mas essa construção aqui
  // não faz aquela busca, então continua rápida). `rounds.length === 0` evita rodar de novo quando
  // o ramo acima já resolveu. Só quando o número de rodadas pedido já é suficiente pra ela inteira;
  // senão cai no sorteio de sempre, sem regressão pro caso de um número escolhido manualmente e menor.
  if (rounds.length === 0 && n % 4 === 0 && n >= 4) {
    const justas = gerarRodadasComByesJustos(players, numCourts);
    if (justas.length && justas.length <= numRounds) {
      justas.forEach((rd) => {
        rd.matches.forEach((m) => {
          const pA = pairKey(m.teamA[0], m.teamA[1]), pB = pairKey(m.teamB[0], m.teamB[1]);
          history.partner[pA] = (history.partner[pA] || 0) + 1;
          history.partner[pB] = (history.partner[pB] || 0) + 1;
          m.teamA.forEach((x) => m.teamB.forEach((y) => { const k = pairKey(x, y); history.opponent[k] = (history.opponent[k] || 0) + 1; }));
        });
        rounds.push(rd);
      });
    }
  }
  for (let r = rounds.length; r < numRounds; r++) {
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

// ---------- agenda automática de horários (com pausa opcional) ----------
export function horaParaMinutos(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}
export function minutosParaHora(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
// Se o horário calculado cair dentro da janela de pausa configurada (ex: almoço), empurra pro
// horário de volta — assim os jogos seguintes retomam só depois do intervalo, sem precisar reajustar
// cada horário manualmente. pausaFim <= pausaInicio (ou qualquer um deles ausente) desativa a pausa.
export function ajustarCursorParaPausa(cursorMin, pausaInicioMin, pausaFimMin) {
  if (pausaInicioMin == null || pausaFimMin == null || pausaFimMin <= pausaInicioMin) return cursorMin;
  if (cursorMin >= pausaInicioMin && cursorMin < pausaFimMin) return pausaFimMin;
  return cursorMin;
}

// Desempate Americano: pontos (sets) -> vitórias -> confronto direto
export function computeStats(players, rounds) {
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
export function minRoundsForFullCoverage(numPlayers, numCourts) {
  if (numPlayers < 4) return 0;
  const totalPairs = (numPlayers * (numPlayers - 1)) / 2;
  return Math.ceil(totalPairs / (numCourts * 2));
}
export function minRoundsForGamesPerPlayer(numPlayers, numCourts, jogosDesejados) {
  if (numPlayers < 4 || jogosDesejados < 1) return 0;
  const ativosPorRodada = ativosPorRodadaReal(numPlayers, numCourts);
  if (ativosPorRodada === 0) return 0;
  return Math.ceil((jogosDesejados * numPlayers) / ativosPorRodada);
}
// Verdadeiro só quando dá pra distribuir os jogos exatamente igual entre todas as jogadoras
// (ninguém joga a mais, ninguém joga a menos, ninguém fica de fora).
export function distribuicaoEhJusta(numPlayers, numCourts, numRounds) {
  if (numPlayers < 4 || numRounds < 1) return false;
  const ativosPorRodada = ativosPorRodadaReal(numPlayers, numCourts);
  if (ativosPorRodada === 0) return false;
  return (numRounds * ativosPorRodada) % numPlayers === 0;
}
export function proximosRoundsValidos(numPlayers, numCourts, quantidade = 6, maxRounds = 60) {
  const validos = [];
  for (let n = 1; n <= maxRounds && validos.length < quantidade; n++) {
    if (distribuicaoEhJusta(numPlayers, numCourts, n)) validos.push(n);
  }
  return validos;
}
export function proximoRoundsValidoApartirDe(numPlayers, numCourts, minimo, maxRounds = 60) {
  for (let n = Math.max(1, minimo); n <= maxRounds; n++) {
    if (distribuicaoEhJusta(numPlayers, numCourts, n)) return n;
  }
  return minimo;
}
export function roundsWithoutScores(rounds) { return rounds.some((rd) => rd.matches.some((m) => !partidaJogada(m))); }
export function generateFinalRound(players, rounds) {
  const stats = computeStats(players, rounds);
  const top4 = stats.slice(0, 4);
  return { round: rounds.length + 1, isFinal: true, byes: [], matches: [{ id: uid(), court: 1, teamA: [top4[0].id, top4[3].id], teamB: [top4[1].id, top4[2].id], scoreA: null, scoreB: null }] };
}

// ---------- fase de grupos (chaves de 2 ou 3 duplas) + eliminatória ----------
export function shuffleArr(arr) { return [...arr].sort(() => Math.random() - 0.5); }
export function generateGroups(teams, categoria) {
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
export function computeGroupStandings(group) {
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
export function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }
export function roundName(matchCount) {
  const map = { 1: 'Final', 2: 'Semifinal', 4: 'Quartas de final', 8: 'Oitavas de final', 16: '16-avos de final', 32: '32-avos de final' };
  return map[matchCount] || `Rodada (${matchCount * 2} duplas)`;
}
export function seedOrder(size) {
  if (size === 1) return [1];
  const prev = seedOrder(size / 2);
  const result = [];
  prev.forEach((s) => { result.push(s); result.push(size + 1 - s); });
  return result;
}
export function repairSameGroupClashes(round1, groupOf) {
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
export function propagateWinner(bracket, roundIdx, matchIdx, winnerId) {
  if (roundIdx + 1 < bracket.length) {
    const next = bracket[roundIdx + 1][Math.floor(matchIdx / 2)];
    if (matchIdx % 2 === 0) next.teamA = winnerId; else next.teamB = winnerId;
  }
}
export function generateEliminationFromGroups(groups) {
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
export function allGroupMatchesScored(groups) { return groups.every((g) => g.matches.every((m) => partidaJogada(m))); }
