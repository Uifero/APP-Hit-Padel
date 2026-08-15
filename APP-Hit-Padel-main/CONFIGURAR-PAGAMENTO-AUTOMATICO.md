# Confirmação automática de pagamento (Mercado Pago) — passo a passo

Esse recurso faz o app confirmar sozinho a inscrição assim que o Pix cai, sem o atleta precisar
clicar em nada. Ele roda num backend novo (`functions/`) que precisa ser configurado e implantado.

**Importante:** enquanto você não terminar esses passos, o app continua funcionando normalmente
no modo manual/anterior (QR Code com sua chave Pix, confirmação por você ou autodeclaração do
atleta). Nada quebra — o automático é só um upgrade por cima do que já existia.

## 1. Crie/configure sua aplicação no Mercado Pago

1. Entre em [mercadopago.com.br/developers/panel](https://www.mercadopago.com.br/developers/panel)
   com a conta Mercado Pago que vai **receber** o dinheiro das inscrições.
2. Crie uma aplicação (qualquer nome, ex: "Hit Padel").
3. Na aba **Credenciais de produção**, copie o **Access Token** de produção. Guarde num lugar
   seguro — é a chave que dá acesso à sua conta, não compartilhe.

## 2. Coloque o projeto Firebase no plano Blaze

O backend (Cloud Functions) só funciona no plano pago do Firebase — mas ele tem uma cota gratuita
generosa, então pra um app de clube provavelmente você não paga nada além da taxa do próprio
Mercado Pago por Pix recebido.

1. Vá em [console.firebase.google.com](https://console.firebase.google.com) → projeto **app-hit-padel**.
2. No canto inferior esquerdo, clique em "Fazer upgrade" (ou Configurações → Uso e faturamento) e
   selecione o plano **Blaze**. Vai pedir um cartão de crédito.

## 3. Instale as ferramentas e faça login

No seu computador (com [Node.js](https://nodejs.org) instalado):

```bash
npm install -g firebase-tools
firebase login
```

## 4. Guarde o Access Token como segredo do backend

Na pasta raiz do projeto (onde está o `firebase.json`):

```bash
firebase functions:secrets:set MP_ACCESS_TOKEN
```

Cole o Access Token do passo 1 quando pedir. **Nunca** coloque esse token no `app.js` ou em
qualquer arquivo público — ele só deve existir aqui, como secret do Cloud Functions.

## 5. Instale as dependências do backend e implante

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

Ao final, o terminal mostra a URL pública da função `webhookMercadoPago`, algo como:

```
https://webhookmercadopago-xxxxxxxxxx-rj.a.run.app
```
(ou no formato `https://southamerica-east1-app-hit-padel.cloudfunctions.net/webhookMercadoPago`,
dependendo da versão do Firebase CLI — use exatamente a URL que apareceu no seu terminal).

**Copie essa URL.**

## 6. Configure o Webhook no Mercado Pago

1. Volte no [painel de desenvolvedores](https://www.mercadopago.com.br/developers/panel), na sua
   aplicação → aba **Webhooks** → "Configurar notificações".
2. Cole a URL do passo 5 como URL de notificação.
3. Marque o tópico **Pagamentos**.
4. Salve. O Mercado Pago vai te mostrar uma **Chave secreta / Assinatura secreta** — copie ela.

## 7. Guarde a chave secreta do webhook

```bash
firebase functions:secrets:set MP_WEBHOOK_SECRET
```

Cole a chave secreta do passo 6.

## 8. Implante de novo (pra pegar o novo secret) e publique o resto

```bash
firebase deploy
```

Esse comando implanta tudo junto: hosting (app.js/index.html), regras do banco e as functions.

## Pronto — como testar

1. Configure um valor de inscrição num torneio de teste.
2. Se inscreva pelo link público, escaneando o QR Code com o app do seu banco (ou usando o modo
   sandbox/teste do Mercado Pago, se preferir não usar dinheiro de verdade).
3. Assim que o pagamento for aprovado, a inscrição deve virar "✓ pago" sozinha, sem ninguém
   clicar em nada — normalmente em poucos segundos.

## Se algo der errado

- **QR aparece mas nunca confirma sozinho:** confira se a URL do webhook (passo 6) bate certinho
  com a URL que o deploy imprimiu (passo 5), e se o tópico "Pagamentos" está marcado.
- **Erro ao criar a cobrança:** veja os logs com `firebase functions:log` — geralmente é Access
  Token errado/expirado, ou o plano Blaze ainda não está ativo.
- Em qualquer erro, o app cai automaticamente pro modo manual (QR com sua chave Pix pessoal) —
  então as inscrições nunca ficam travadas, mesmo se o Mercado Pago estiver fora do ar.
