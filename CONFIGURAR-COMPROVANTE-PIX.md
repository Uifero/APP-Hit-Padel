# Anexar comprovante de pagamento — passo a passo

Esse recurso é **independente** do Mercado Pago — funciona mesmo que você nunca configure a
cobrança automática. O fluxo agora é: o atleta paga o Pix com sua chave (config/pix), anexa o
print/PDF do comprovante na hora de se inscrever, e você confere e confirma manualmente no
painel — sem pagar nenhuma taxa de gateway de pagamento.

## 1. Ative o Cloud Storage no Firebase

1. Vá em [console.firebase.google.com](https://console.firebase.google.com) → projeto **app-hit-padel**.
2. No menu lateral, clique em **Storage** (Armazenamento).
3. Clique em **Vamos começar / Get started**. Ele vai te guiar pra criar o bucket padrão.
4. Assim como o Cloud Functions, o Storage exige o plano **Blaze** (mas continua sem custo dentro
   da cota gratuita — pra fotos de comprovante de um clube, o uso é bem pequeno). Se você já
   upou pro Blaze pra usar o Mercado Pago, não precisa fazer de novo.

## 2. Publique as regras do Storage

Igual você fez com as regras do banco de dados (Realtime Database), agora é a vez das regras do
Storage — pode ser pelo Console (mais simples) ou pelo terminal:

**Pelo Console (sem precisar instalar nada):**
1. Em Storage, vá na aba **Regras (Rules)**.
2. Cole exatamente isto:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /comprovantes/{tournamentId}/{fileName} {
      allow read: if request.auth != null;
      allow write: if request.resource.size < 8 * 1024 * 1024
                   && request.resource.contentType.matches('image/.*|application/pdf');
    }
  }
}
```

3. Clique em **Publicar**.

**Pelo terminal (se preferir, com Firebase CLI já configurado):**
```bash
firebase deploy --only storage
```

## 3. Publique o app.js atualizado

Troque o `app.js` no seu repositório pelo que te mandei, e publique o hosting como sempre
(commit + push, se o GitHub Actions cuidar disso pra você).

## Como funciona pro atleta e pro organizador

- **Atleta:** ao se inscrever num torneio com valor, aparece o QR Pix de sempre + um campo pra
  anexar foto ou PDF do comprovante. Ao enviar, a inscrição vira "🕓 aguardando confirmação".
- **Você (admin):** na lista de Inscrições/Duplas, toda inscrição com comprovante anexado mostra
  um botão "📎 ver comprovante" — clica, abre a imagem/PDF numa aba nova, confere, e clica em
  "confirmar pagamento" pra liberar a vaga.
- Só você (logado como admin) consegue abrir os comprovantes — ninguém mais tem acesso a eles,
  mesmo sabendo o link do torneio.
