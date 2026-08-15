# Anexar comprovante de pagamento — passo a passo

Esse recurso é **independente** do Mercado Pago e **não usa o Cloud Storage** — ou seja, não
precisa vincular cartão nem entrar no plano pago do Firebase. O fluxo é: você configura sua chave
Pix uma vez, o atleta vê essa chave em texto na hora de se inscrever, paga, anexa o print/PDF do
comprovante, e você confere e confirma manualmente no painel.

## Como o comprovante é guardado

Em vez de subir o arquivo pro Cloud Storage (que exige plano Blaze), o app comprime a foto no
próprio celular do atleta e guarda ela como texto (base64) dentro do Realtime Database — o mesmo
banco gratuito que o app já usa pra tudo, sem precisar de cartão. Só quem estiver logado como admin
consegue abrir os comprovantes.

## 1. Publique as regras atualizadas do banco de dados

Igual você já fez outras vezes: publique o `database.rules.json` atualizado (agora com um nó novo
`comprovantes`, que só libera leitura pra quem estiver logado).

**Pelo Console (sem precisar instalar nada):**
1. Vá em [console.firebase.google.com](https://console.firebase.google.com) → projeto **app-hit-padel**.
2. No menu lateral, **Realtime Database** → aba **Regras (Rules)**.
3. Apague o conteúdo atual e cole o conteúdo do arquivo `database.rules.json` que te mandei.
4. Clique em **Publicar**.

## 2. Publique o app.js e o index.html atualizados

Troque os dois arquivos no seu repositório do GitHub pelos que te mandei, e publique o hosting como
sempre (commit + push, se o GitHub Actions cuidar disso pra você).

## Como funciona pro atleta e pro organizador

- **Atleta:** ao se inscrever num torneio com valor, aparece a chave Pix (em texto, com botão de
  copiar) + um campo pra anexar foto ou PDF do comprovante (máx. 4 MB). Ao enviar, a inscrição vira
  "🕓 aguardando confirmação".
- **Você (admin):** na lista de Inscrições/Duplas, toda inscrição com comprovante anexado mostra
  um botão "📎 ver comprovante" — clica, abre a imagem/PDF numa aba nova, confere, e clica em
  "confirmar pagamento" pra liberar a vaga.
- Só você (logado como admin) consegue abrir os comprovantes — ninguém mais tem acesso a eles,
  mesmo sabendo o link do torneio.

## Não precisa mais

- Não precisa ativar o Cloud Storage.
- Não precisa entrar no plano Blaze nem cadastrar cartão só por causa desse recurso.
- O arquivo `storage.rules` que te mandei antes não é mais usado — pode ignorar (não precisa
  publicar ele em lugar nenhum).
