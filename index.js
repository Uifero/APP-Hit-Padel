/**
 * Backend do Hit Padel — cobrança Pix automática via Mercado Pago.
 *
 * Duas funções:
 *  - criarCobrancaPix: chamada pelo app quando alguém se inscreve num torneio pago. Cria uma cobrança
 *    Pix de verdade na API do Mercado Pago (QR Code dinâmico, atrelado a essa inscrição específica) e
 *    grava o código no registro da jogadora/dupla.
 *  - webhookMercadoPago: endpoint público que o Mercado Pago chama quando o status de um pagamento muda.
 *    Confere a assinatura (pra garantir que é o Mercado Pago mesmo chamando, e não alguém forjando um
 *    "paguei" falso), confirma o status direto na API (nunca confia só no corpo do webhook) e, se
 *    aprovado, marca a inscrição como paga + confirmada automaticamente — sem ninguém precisar clicar
 *    em nada.
 *
 * Credenciais (nunca ficam no app.js / no navegador — só aqui, como secrets do Cloud Functions):
 *   firebase functions:secrets:set MP_ACCESS_TOKEN
 *   firebase functions:secrets:set MP_WEBHOOK_SECRET
 */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.database();

const MP_ACCESS_TOKEN = defineSecret('MP_ACCESS_TOKEN');
const MP_WEBHOOK_SECRET = defineSecret('MP_WEBHOOK_SECRET');
const MP_API = 'https://api.mercadopago.com';
const REGION = 'southamerica-east1'; // São Paulo — mais perto do clube e dos jogadores

setGlobalOptions({ region: REGION });

// Atualiza um registro dentro do array players/teams do torneio, de forma atômica (evita perder dados
// se duas escritas acontecerem ao mesmo tempo — ex: alguém se inscrevendo enquanto o webhook confirma outra).
async function atualizarRegistro(tournamentId, list, id, patch) {
  const listRef = db.ref(`torneios/${tournamentId}/${list}`);
  const resultado = await listRef.transaction((atual) => {
    if (!Array.isArray(atual)) return atual;
    let achou = false;
    const novo = atual.map((x) => {
      if (x && x.id === id) { achou = true; return { ...x, ...patch }; }
      return x;
    });
    return achou ? novo : atual;
  });
  return resultado.committed;
}

exports.criarCobrancaPix = onCall({ secrets: [MP_ACCESS_TOKEN] }, async (request) => {
  const { tournamentId, list, id, valor, descricao, emailPagador } = request.data || {};
  if (!tournamentId || !['players', 'teams'].includes(list) || !id) {
    throw new HttpsError('invalid-argument', 'Dados de inscrição inválidos.');
  }
  const valorNum = Number(valor);
  if (!(valorNum > 0)) throw new HttpsError('invalid-argument', 'Valor de inscrição inválido.');

  const snap = await db.ref(`torneios/${tournamentId}/${list}`).get();
  const lista = snap.val() || [];
  const registro = lista.find((x) => x && x.id === id);
  if (!registro) throw new HttpsError('not-found', 'Inscrição não encontrada — pode ter sido removida.');
  if (registro.statusPagamento === 'pago') return { qrCode: registro.pixQrCode || null, paymentId: registro.mpPaymentId || null, jaPago: true };

  // Já existe uma cobrança em aberto pra essa inscrição? Reaproveita em vez de criar outra no Mercado
  // Pago toda vez que a pessoa reabre a tela de pagamento (evita gerar cobrança duplicada à toa).
  if (registro.mpPaymentId && registro.pixQrCode) {
    return { qrCode: registro.pixQrCode, paymentId: registro.mpPaymentId };
  }

  const externalReference = `${tournamentId}__${list}__${id}`;
  const expiracao = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // cobrança válida por 24h

  let resp, data;
  try {
    resp = await fetch(`${MP_API}/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}`,
        'X-Idempotency-Key': `${externalReference}__${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        transaction_amount: valorNum,
        description: (descricao || 'Inscrição de torneio — Hit Padel').slice(0, 250),
        payment_method_id: 'pix',
        external_reference: externalReference,
        date_of_expiration: expiracao,
        payer: { email: emailPagador || 'inscricoes@hitpadel.app' },
      }),
    });
    data = await resp.json();
  } catch (e) {
    console.error('Falha de rede ao chamar o Mercado Pago', e);
    throw new HttpsError('unavailable', 'Não foi possível falar com o Mercado Pago agora.');
  }
  if (!resp.ok) {
    console.error('Mercado Pago recusou a criação da cobrança', data);
    throw new HttpsError('internal', data?.message || 'Mercado Pago recusou a cobrança.');
  }
  const qrCode = data?.point_of_interaction?.transaction_data?.qr_code;
  const paymentId = data?.id;
  if (!qrCode || !paymentId) {
    console.error('Resposta inesperada do Mercado Pago', data);
    throw new HttpsError('internal', 'Resposta inesperada do Mercado Pago.');
  }

  await atualizarRegistro(tournamentId, list, id, { mpPaymentId: paymentId, pixQrCode: qrCode });
  return { qrCode, paymentId };
});

exports.webhookMercadoPago = onRequest({ secrets: [MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET] }, async (req, res) => {
  try {
    // 1) Confere a assinatura do Mercado Pago — sem isso, qualquer um poderia forjar um POST dizendo
    // "esse pagamento foi aprovado" e confirmar a própria inscrição de graça.
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];
    const dataId = String(req.query['data.id'] || req.body?.data?.id || '').toLowerCase();
    if (!xSignature || !dataId) { res.status(400).send('faltando assinatura ou data.id'); return; }

    let ts, hash;
    String(xSignature).split(',').forEach((part) => {
      const [k, v] = part.split('=');
      if (k && k.trim() === 'ts') ts = (v || '').trim();
      if (k && k.trim() === 'v1') hash = (v || '').trim();
    });
    if (!ts || !hash) { res.status(400).send('assinatura malformada'); return; }

    const partesManifest = [];
    if (dataId) partesManifest.push(`id:${dataId}`);
    if (xRequestId) partesManifest.push(`request-id:${xRequestId}`);
    partesManifest.push(`ts:${ts}`);
    const manifest = partesManifest.join(';') + ';';
    const computado = crypto.createHmac('sha256', MP_WEBHOOK_SECRET.value()).update(manifest).digest('hex');
    const assinaturaValida = computado.length === hash.length && crypto.timingSafeEqual(Buffer.from(computado), Buffer.from(hash));
    if (!assinaturaValida) { console.error('Webhook com assinatura inválida — ignorado'); res.status(401).send('assinatura inválida'); return; }

    // 2) Nunca confia no status que vier no corpo do webhook — busca o pagamento de verdade na API.
    const paymentId = req.body?.data?.id || req.query['data.id'];
    if (!paymentId) { res.status(200).send('ok (sem payment id)'); return; }

    const pResp = await fetch(`${MP_API}/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}` },
    });
    const pagamento = await pResp.json();
    if (!pResp.ok) { console.error('Falha ao consultar pagamento no Mercado Pago', pagamento); res.status(200).send('ok (falha ao consultar)'); return; }
    if (pagamento.status !== 'approved') { res.status(200).send(`ok (status: ${pagamento.status})`); return; }

    const [tournamentId, list, id] = String(pagamento.external_reference || '').split('__');
    if (!tournamentId || !list || !id) { console.error('external_reference inesperada', pagamento.external_reference); res.status(200).send('ok (referência inválida)'); return; }

    const atualizou = await atualizarRegistro(tournamentId, list, id, { statusPagamento: 'pago', confirmada: true, mpPaymentId: pagamento.id });
    if (!atualizou) console.error(`Inscrição ${tournamentId}/${list}/${id} não encontrada pra confirmar (pode ter sido removida)`);

    res.status(200).send('ok');
  } catch (e) {
    console.error('Erro inesperado no webhook do Mercado Pago', e);
    res.status(500).send('erro interno');
  }
});
