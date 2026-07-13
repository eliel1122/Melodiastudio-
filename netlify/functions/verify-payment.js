// =====================================================
// GET /api/verify-payment?reference=MEL-xxx
// Vérifie l'état d'une transaction Paystack (pour la page de retour).
// =====================================================

const { jsonResponse, preflight } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  const ref = event.queryStringParameters?.reference || event.queryStringParameters?.trxref;
  if (!ref) return jsonResponse(400, { error: 'reference requise' });

  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) return jsonResponse(500, { error: 'Paiement non configuré' });

  try {
    const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await res.json();
    const d = data.data || {};
    const meta = d.metadata || {};
    return jsonResponse(200, {
      ok: true,
      status: d.status,                 // 'success' | 'failed' | 'abandoned'
      reference: d.reference,
      amount: (d.amount || 0) / 100,
      choice: meta.choice || null,
      total: meta.total || null,
      solde: meta.solde || null,
      service: meta.service || null,
      date: meta.date || null,
      slotLabel: meta.slotLabel || null,
    });
  } catch (e) {
    console.error('[verify-payment] error:', e);
    return jsonResponse(500, { error: 'Vérification impossible' });
  }
};
