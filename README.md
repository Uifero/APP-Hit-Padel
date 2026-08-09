# Hit Padel — guia do projeto (app-hit-padel)

Projeto Firebase: **app-hit-padel**
Repositório GitHub (deploy automático): **github.com/Uifero/APP-Hit-Padel**
Login de admin: **Uifero** / **Uifero.,26** (conta criada no Firebase Authentication)

## Como o site funciona agora (múltiplos torneios)
- **`https://app-hit-padel.web.app`** (sem nada depois) → mostra a lista de torneios:
  - Pra você (admin, logado): **"Meus torneios"** — todos os que você criou, publicados ou não, com botão de criar um novo.
  - Pro público (sem login): **"Torneios em andamento"** — só os que você marcou como publicados.
- **`https://app-hit-padel.web.app?t=<id>`** → abre um torneio específico direto. Esse é o link que você compartilha pra cada torneio (aparece sozinho na barra de endereço quando você abre um torneio, é só copiar dali).
- Você pode ter vários torneios rodando ao mesmo tempo, cada um com seus próprios dados, categorias, inscrições etc. — totalmente independentes.

## Painel de gestão (dentro de cada torneio, como admin)
Ao entrar num torneio como admin, aparece um painel com 6 módulos:
- **Configurações** — tipo de torneio, categorias, datas, visibilidade, inscrições abertas/fechadas
- **Quadras e Rodadas** — quantidade e nome das quadras, número de rodadas
- **Inscrições** — cadastrar/remover/confirmar/ocultar jogadoras ou duplas
- **Duplas** — lista das confirmadas (visão rápida)
- **Chaveamento** — botão de sortear rodadas / gerar chaves
- **Jogos** — atalho pra ver e agendar horários (mesma aba "Jogos" que já existia)

## Status atual
- [x] Projeto Firebase criado
- [x] Realtime Database ativado
- [x] Firebase Authentication ativado (login real)
- [x] `firebase-config.js` preenchido com as chaves reais
- [x] Deploy automático via GitHub Actions configurado
- [x] Estrutura de múltiplos torneios implementada

## Arquivos desta pasta
| Arquivo | Para que serve |
|---|---|
| `index.html` | A página do app |
| `app.js` | Toda a lógica (múltiplos torneios, Americano, Mini torneio, Chaves, painel de gestão) |
| `logo.png` | Logo do Hit Padel Tuparendi |
| `firebase-config.js` | Chaves do projeto (já preenchido) |
| `firebase.json` | Configuração de hospedagem |
| `database.rules.json` | Regras do banco (`torneios/` — cada torneio isolado) |

## Atualizar o site
Como o deploy é automático: abre o arquivo no GitHub (`github.com/Uifero/APP-Hit-Padel`) → lápis (editar) → cola o conteúdo novo → "Commit changes". Em ~1 minuto o site atualiza sozinho. Confirma em `github.com/Uifero/APP-Hit-Padel/actions` se quiser ver o progresso.

## Migração automática
Se você tinha um torneio antigo (do formato de "um torneio só"), ele é migrado sozinho pro novo formato na primeira vez que o site carrega — vira o primeiro item da sua lista "Meus torneios", com todos os dados preservados.

## Domínio próprio (ex: hitpadel.com.br) — opcional
Firebase Console → **Hosting** → **Adicionar domínio personalizado** → seguir as instruções de DNS. Grátis, com SSL automático.

## Sobre segurança
O login de admin usa Firebase Authentication de verdade (a senha nunca fica salva em texto no banco de dados). As regras do banco (`torneios/`) continuam abertas pra leitura/escrita — suficiente pra um torneio de amigos/clube, mas tecnicamente alguém muito técnico ainda poderia editar dados sem passar pela tela do site. Travar isso por completo exigiria uma reestruturação maior (Cloud Functions) — avisa se um dia quiser esse reforço.
