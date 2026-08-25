// Testes do motor de rodadas/chaveamento (scheduling.js).
// Roda com o test runner nativo do Node (sem dependências): `node --test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ativosPorRodadaReal, partidaJogada, gerarParceriasRoundRobin, generateSchedule,
  gerarRodadasComByesJustos, computeStats, minRoundsForFullCoverage, minRoundsForGamesPerPlayer,
  distribuicaoEhJusta, proximosRoundsValidos, proximoRoundsValidoApartirDe, generateGroups,
  computeGroupStandings, nextPow2, roundName, seedOrder, repairSameGroupClashes,
  generateEliminationFromGroups, allGroupMatchesScored,
} from '../scheduling.js';

const players = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Jogadora ${i + 1}` }));

describe('ativosPorRodadaReal', () => {
  it('limita pela capacidade das quadras e arredonda pra baixo até múltiplo de 4', () => {
    assert.equal(ativosPorRodadaReal(10, 2), 8); // cap = min(10,8) = 8, já múltiplo de 4
    assert.equal(ativosPorRodadaReal(9, 3), 8);  // cap = min(9,12) = 9 -> desce pra 8
    assert.equal(ativosPorRodadaReal(3, 2), 0);  // cap = 3, não fecha nem um jogo
    assert.equal(ativosPorRodadaReal(16, 4), 16);
  });
});

describe('partidaJogada', () => {
  it('placar nulo ou 0x0 conta como pendente, não como jogada', () => {
    assert.equal(partidaJogada({ scoreA: null, scoreB: null }), false);
    assert.equal(partidaJogada({ scoreA: 0, scoreB: 0 }), false);
  });
  it('qualquer placar com um lado > 0 conta como jogada', () => {
    assert.equal(partidaJogada({ scoreA: 6, scoreB: 0 }), true);
    assert.equal(partidaJogada({ scoreA: 0, scoreB: 6 }), true);
    assert.equal(partidaJogada({ scoreA: 6, scoreB: 4 }), true);
  });
});

describe('gerarParceriasRoundRobin', () => {
  it('cobre cada parceria possível exatamente uma vez, em n-1 rodadas (método do círculo)', () => {
    for (const n of [4, 6, 8]) {
      const ids = players(n).map((p) => p.id);
      const rodadas = gerarParceriasRoundRobin(ids);
      assert.equal(rodadas.length, n - 1);

      const seen = new Set();
      rodadas.forEach((pares) => {
        assert.equal(pares.length, n / 2);
        const usados = new Set();
        pares.forEach(([a, b]) => {
          // cada jogadora aparece só uma vez dentro da mesma rodada
          assert.equal(usados.has(a), false);
          assert.equal(usados.has(b), false);
          usados.add(a); usados.add(b);
          const key = [a, b].sort().join('~');
          assert.equal(seen.has(key), false, `parceria ${key} repetida entre rodadas`);
          seen.add(key);
        });
      });
      // todas as C(n,2) parcerias possíveis foram usadas
      assert.equal(seen.size, (n * (n - 1)) / 2);
    }
  });
});

describe('generateSchedule', () => {
  it('com 8 jogadoras / 2 quadras / 7 rodadas (n-1), nunca repete parceria de dupla', () => {
    const rounds = generateSchedule(players(8), 2, 7);
    assert.equal(rounds.length, 7);
    const parcerias = new Set();
    rounds.forEach((rd) => {
      assert.equal(rd.byes.length, 0); // 8 jogadoras, capacidade 8 -> ninguém de fora
      assert.equal(rd.matches.length, 2);
      rd.matches.forEach((m) => {
        const todos = [...m.teamA, ...m.teamB];
        assert.equal(new Set(todos).size, 4); // 4 jogadoras distintas por partida
        [m.teamA, m.teamB].forEach((team) => {
          const key = [...team].sort().join('~');
          assert.equal(parcerias.has(key), false, `dupla ${key} jogou junta mais de uma vez`);
          parcerias.add(key);
        });
      });
    });
  });

  it('com jogadoras sobrando pra fechar múltiplo de 4, cada rodada tem o número certo de folgas', () => {
    const rounds = generateSchedule(players(5), 1, 3); // 1 quadra = só 4 ativas por vez, 1 de folga
    assert.equal(rounds.length, 3);
    rounds.forEach((rd) => {
      assert.equal(rd.byes.length, 1);
      assert.equal(rd.matches.length, 1);
      const emQuadra = [...rd.matches[0].teamA, ...rd.matches[0].teamB];
      assert.equal(new Set(emQuadra).size, 4);
      assert.equal(emQuadra.includes(rd.byes[0]), false);
    });
  });

  it('com quadras insuficientes pra caber todo mundo, ainda garante zero repetição de dupla e jogos iguais (via generateSchedule, não só a construção isolada)', () => {
    // 12 jogadoras / 2 quadras: só 8 cabem por rodada, então tem folga toda rodada -- é exatamente
    // o cenário que motivou essa função (generateSchedule tem que escolher o ramo certo sozinho).
    // 17 é o mínimo matemático absoluto (ceil(66 pares / 4 pares por rodada)) -- a construção acha
    // o casamento ótimo das sobras entre megarodadas, então bate certinho, sem rodada de sobra.
    const rounds = generateSchedule(players(12), 2, 17);
    assert.equal(rounds.length, 17);
    const parceriaCount = {};
    const jogos = {};
    players(12).forEach((p) => { jogos[p.id] = 0; });
    rounds.forEach((rd) => {
      const jogadorasNaRodada = new Set();
      rd.matches.forEach((m) => {
        [m.teamA, m.teamB].forEach((team) => {
          const key = [...team].sort().join('~');
          parceriaCount[key] = (parceriaCount[key] || 0) + 1;
          team.forEach((id) => {
            jogos[id]++;
            assert.equal(jogadorasNaRodada.has(id), false, `jogadora ${id} escalada em 2 partidas na mesma rodada`);
            jogadorasNaRodada.add(id);
          });
        });
      });
    });
    assert.equal(Object.keys(parceriaCount).length, (12 * 11) / 2); // todas as 66 duplas aconteceram
    Object.values(parceriaCount).forEach((c) => assert.equal(c, 1, 'nenhuma dupla pode repetir'));
    const valoresJogos = Object.values(jogos);
    assert.equal(new Set(valoresJogos).size, 1, 'todas as jogadoras devem ter a mesma quantidade de jogos');
    assert.equal(valoresJogos[0], 11); // n-1 jogos cada, uma vez com cada uma das outras 11
  });
});

describe('gerarRodadasComByesJustos', () => {
  it('pra 4, 8, 12, 16 e 20 jogadoras / 2 quadras, cobre cada dupla exatamente 1 vez, com jogos e folgas iguais pra todas, no mínimo exato de rodadas', () => {
    // mínimo teórico absoluto = ceil(C(n,2) / (numCourts*2)) -- confirma que a construção não
    // desperdiça rodada nenhuma além do estritamente necessário.
    const minimoTeorico = { 4: 2, 8: 7, 12: 17, 16: 30, 20: 48 };
    for (const n of [4, 8, 12, 16, 20]) {
      const rounds = gerarRodadasComByesJustos(players(n), 2);
      assert.equal(rounds.length, minimoTeorico[n], `n=${n}: deveria bater o mínimo teórico de rodadas`);
      const parceriaCount = {};
      const jogos = {}; const byes = {};
      players(n).forEach((p) => { jogos[p.id] = 0; byes[p.id] = 0; });
      rounds.forEach((rd) => {
        rd.byes.forEach((id) => { byes[id]++; });
        const jogadorasNaRodada = new Set();
        rd.matches.forEach((m) => {
          [m.teamA, m.teamB].forEach((team) => {
            const key = [...team].sort().join('~');
            parceriaCount[key] = (parceriaCount[key] || 0) + 1;
            team.forEach((id) => {
              jogos[id]++;
              // Regressão: uma versão anterior chegou a escalar a mesma jogadora em 2 partidas
              // simultâneas na mesma rodada quando combinava sobras de megarodadas diferentes.
              assert.equal(jogadorasNaRodada.has(id), false, `n=${n}: jogadora ${id} escalada em 2 partidas na mesma rodada`);
              jogadorasNaRodada.add(id);
            });
          });
        });
      });
      assert.equal(Object.keys(parceriaCount).length, (n * (n - 1)) / 2, `n=${n}: todas as duplas deveriam ter acontecido`);
      Object.values(parceriaCount).forEach((c) => assert.equal(c, 1, `n=${n}: nenhuma dupla pode repetir`));
      assert.equal(new Set(Object.values(jogos)).size, 1, `n=${n}: jogos deveriam ser iguais pra todas`);
      assert.equal(new Set(Object.values(byes)).size, 1, `n=${n}: folgas deveriam ser iguais pra todas`);
      assert.equal(Object.values(jogos)[0], n - 1, `n=${n}: cada jogadora deveria jogar exatamente n-1 partidas`);
    }
  });

  it('quando as quadras já cabem todo mundo (sem folga), ainda cobre tudo em n-1 rodadas, sem sobra', () => {
    const rounds = gerarRodadasComByesJustos(players(8), 2); // 2 quadras cabem exatamente 8 jogadoras
    assert.equal(rounds.length, 7);
    rounds.forEach((rd) => assert.equal(rd.byes.length, 0));
  });

  it('é determinística: mesma entrada, sempre o mesmo número de rodadas', () => {
    // Regressão: uma versão anterior usava Math.random() no casamento das sobras, então o número
    // de rodadas variava de chamada pra chamada -- o que quebrava a premissa de que o número
    // mostrado na tela sempre bate com o que a geração de verdade produz.
    for (const n of [12, 20]) {
      const comprimentos = Array.from({ length: 8 }, () => gerarRodadasComByesJustos(players(n), 2).length);
      assert.equal(new Set(comprimentos).size, 1, `n=${n}: o número de rodadas não deveria variar entre chamadas`);
    }
  });
});

describe('computeStats', () => {
  it('ordena por pontos (games) e depois vitórias, com desempate por confronto direto', () => {
    const ps = players(4); // p1,p2,p3,p4
    const rounds = [
      { round: 1, byes: [], matches: [{ id: 'm1', teamA: ['p1'], teamB: ['p2'], scoreA: 6, scoreB: 2 }] },
      { round: 2, byes: [], matches: [{ id: 'm2', teamA: ['p3'], teamB: ['p1'], scoreA: 6, scoreB: 4 }] },
      { round: 3, byes: [], matches: [{ id: 'm3', teamA: ['p2'], teamB: ['p3'], scoreA: 6, scoreB: 5 }] },
    ];
    // pontos (soma de games a favor): p1=6+4=10, p2=2+6=8, p3=6+5=11
    const stats = computeStats(ps.filter((p) => p.id !== 'p4'), rounds);
    assert.deepEqual(stats.map((s) => s.id), ['p3', 'p1', 'p2']);
    const p1 = stats.find((s) => s.id === 'p1');
    assert.equal(p1.vitorias, 1);
    assert.equal(p1.derrotas, 1);
    assert.equal(p1.pontos, 10);
  });

  it('jogadora sem nenhuma partida jogada fica com zero em tudo', () => {
    const stats = computeStats(players(2), []);
    stats.forEach((s) => { assert.equal(s.partidas, 0); assert.equal(s.pontos, 0); });
  });
});

describe('regras de cobertura / distribuição justa', () => {
  it('minRoundsForFullCoverage calcula o teto de rodadas pra cobrir todos os confrontos possíveis', () => {
    // 8 jogadoras = 28 pares possíveis; 2 quadras = 4 confrontos/rodada -> ceil(28/4) = 7
    assert.equal(minRoundsForFullCoverage(8, 2), 7);
    assert.equal(minRoundsForFullCoverage(3, 2), 0); // menos de 4 jogadoras
  });

  it('minRoundsForGamesPerPlayer calcula rodadas pra garantir X jogos por jogadora', () => {
    // 8 jogadoras, 2 quadras (8 ativas/rodada), querendo 3 jogos cada -> ceil(3*8/8) = 3
    assert.equal(minRoundsForGamesPerPlayer(8, 2, 3), 3);
  });

  it('distribuicaoEhJusta só é true quando dá pra dividir os jogos igualmente entre todas', () => {
    assert.equal(distribuicaoEhJusta(8, 2, 3), true);   // 3*8 % 8 === 0
    assert.equal(distribuicaoEhJusta(5, 1, 1), false);  // 1*4 % 5 !== 0
  });

  it('proximosRoundsValidos e proximoRoundsValidoApartirDe só devolvem valores justos', () => {
    const validos = proximosRoundsValidos(5, 1, 3);
    validos.forEach((n) => assert.equal(distribuicaoEhJusta(5, 1, n), true));
    const proximo = proximoRoundsValidoApartirDe(5, 1, 1);
    assert.equal(distribuicaoEhJusta(5, 1, proximo), true);
    assert.ok(proximo >= 1);
  });
});

describe('generateGroups', () => {
  it('distribui todas as duplas em chaves de até 3, com todos os confrontos internos', () => {
    const teams = players(7).map((p) => ({ id: p.id, name: p.name }));
    const groups = generateGroups(teams, '_default');
    const totalTeamsInGroups = groups.reduce((acc, g) => acc + g.teamIds.length, 0);
    assert.equal(totalTeamsInGroups, 7);
    groups.forEach((g) => {
      const k = g.teamIds.length;
      assert.equal(g.matches.length, (k * (k - 1)) / 2); // todo mundo joga contra todo mundo na chave
    });
  });
});

describe('computeGroupStandings', () => {
  it('desempata por vitórias, depois saldo, depois confronto direto', () => {
    // ciclo t1 bate t2, t2 bate t3, t3 bate t1: todas com 1 vitória / 1 derrota
    const group = {
      id: 'g1', nome: 'Chave A', categoria: '_default', teamIds: ['t1', 't2', 't3'],
      matches: [
        { id: 'm1', teamA: 't1', teamB: 't2', scoreA: 6, scoreB: 2 },
        { id: 'm2', teamA: 't1', teamB: 't3', scoreA: 3, scoreB: 6 },
        { id: 'm3', teamA: 't2', teamB: 't3', scoreA: 6, scoreB: 4 },
      ],
    };
    const standings = computeGroupStandings(group);
    // t1 e t3 empatam em vitórias(1) e saldo(+1); t3 venceu o confronto direto (m2) -> vem antes
    assert.deepEqual(standings.map((s) => s.id), ['t3', 't1', 't2']);
  });

  it('sem partidas jogadas, todo mundo fica zerado (sem exceção)', () => {
    const group = { id: 'g1', teamIds: ['t1', 't2'], matches: [{ id: 'm1', teamA: 't1', teamB: 't2', scoreA: null, scoreB: null }] };
    const standings = computeGroupStandings(group);
    standings.forEach((s) => { assert.equal(s.vitorias, 0); assert.equal(s.derrotas, 0); assert.equal(s.saldo, 0); });
  });
});

describe('allGroupMatchesScored', () => {
  it('só é true quando toda partida de todo grupo já tem placar válido', () => {
    const scored = { id: 'g1', teamIds: ['t1', 't2'], matches: [{ id: 'm1', teamA: 't1', teamB: 't2', scoreA: 6, scoreB: 2 }] };
    const pending = { id: 'g2', teamIds: ['t3', 't4'], matches: [{ id: 'm2', teamA: 't3', teamB: 't4', scoreA: null, scoreB: null }] };
    assert.equal(allGroupMatchesScored([scored]), true);
    assert.equal(allGroupMatchesScored([scored, pending]), false);
  });
});

describe('nextPow2 / roundName / seedOrder', () => {
  it('nextPow2 arredonda pra cima até a próxima potência de 2', () => {
    assert.equal(nextPow2(1), 1);
    assert.equal(nextPow2(4), 4);
    assert.equal(nextPow2(5), 8);
    assert.equal(nextPow2(6), 8);
  });

  it('roundName nomeia as fases conhecidas e cai num nome genérico pras demais', () => {
    assert.equal(roundName(1), 'Final');
    assert.equal(roundName(2), 'Semifinal');
    assert.equal(roundName(4), 'Quartas de final');
    assert.equal(roundName(3), 'Rodada (6 duplas)');
  });

  it('seedOrder segue o padrão clássico de chaveamento (evita 1º x 2º na primeira rodada)', () => {
    assert.deepEqual(seedOrder(2), [1, 2]);
    assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
    assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  });
});

describe('repairSameGroupClashes', () => {
  it('troca adversários entre partidas pra evitar confronto entre duplas da mesma chave, quando dá', () => {
    const round1 = [
      { teamA: 'x1', teamB: 'x2' }, // mesma chave (G1) -- clash
      { teamA: 'y1', teamB: 'y2' }, // mesma chave (G2) -- clash
    ];
    const groupOf = { x1: 'G1', x2: 'G1', y1: 'G2', y2: 'G2' };
    repairSameGroupClashes(round1, groupOf);
    round1.forEach((m) => assert.notEqual(groupOf[m.teamA], groupOf[m.teamB]));
  });
});

describe('generateEliminationFromGroups', () => {
  it('monta a primeira rodada por semeadura e propaga byes automaticamente', () => {
    // grupo A: 1 dupla só (sem 2º colocado); grupo B: 2 duplas, a1 bate a2
    const groups = [
      { id: 'gA', teamIds: ['a1', 'a2'], matches: [{ id: 'm1', teamA: 'a1', teamB: 'a2', scoreA: 6, scoreB: 2 }] },
      { id: 'gB', teamIds: ['b1'], matches: [] },
    ];
    const bracket = generateEliminationFromGroups(groups);
    // 3 classificadas (a1, b1, a2) -> chave de 4 com 1 bye
    assert.equal(bracket.length, 2); // rodada 1 (2 confrontos) + final (1 confronto)
    assert.equal(bracket[0].length, 2);
    const bye = bracket[0].find((m) => m.isBye);
    const real = bracket[0].find((m) => !m.isBye);
    assert.ok(bye, 'deveria existir um confronto de bye');
    assert.equal(bye.teamA, 'a1');
    assert.equal(bye.winner, 'a1');
    assert.equal(real.teamA, 'b1');
    assert.equal(real.teamB, 'a2');
    // vitória do bye já propagada pra final
    assert.equal(bracket[1].length, 1);
    assert.equal(bracket[1][0].teamA, 'a1');
    assert.equal(bracket[1][0].teamB, null);
  });

  it('sem sobra (número de classificadas já é potência de 2), não gera nenhum bye', () => {
    const groups = [
      { id: 'gA', teamIds: ['a1', 'a2'], matches: [{ id: 'm1', teamA: 'a1', teamB: 'a2', scoreA: 6, scoreB: 2 }] },
      { id: 'gB', teamIds: ['b1', 'b2'], matches: [{ id: 'm2', teamA: 'b1', teamB: 'b2', scoreA: 6, scoreB: 2 }] },
    ];
    const bracket = generateEliminationFromGroups(groups);
    assert.equal(bracket[0].length, 2);
    bracket[0].forEach((m) => assert.equal(m.isBye, false));
    const todos = bracket[0].flatMap((m) => [m.teamA, m.teamB]);
    assert.equal(new Set(todos).size, 4);
  });
});
