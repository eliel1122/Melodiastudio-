// =====================================================
// POST /api/release-hold  { reference }
// Libère les créneaux d'une commande NON payée (paiement échoué/abandonné).
// Vérifie d'abord auprès de Paystack : si la transaction a réussi, on ne
// touche à rien (sécurité anti-abus).
// =====================================================

const { airtable, airtableTable, TABLES, jsonResponse, preflight } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  let ref;
  try { ref = (JSON.parse(event.body || '{}').reference || '').trim(); }
  catch { return jsonResponse(400, { error: 'Body JSON invalide' }); }
  if (!ref) return jsonResponse(400, { error: 'reference requise' });

  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) return jsonResponse(500, { error: 'Paiement non configuré' });

  try {
    // 1. Vérifie l'état réel de la transaction
    const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await res.json();
    const d = data.data || {};
    if (d.status === 'success') {
      return jsonResponse(200, { ok: true, released: 0, note: 'transaction payée, rien à libérer' });
    }

    // 2. Récupère les réservations de la commande
    const meta = d.metadata || {};
    const ids = Array.isArray(meta.reservationIds) && meta.reservationIds.length
      ? meta.reservationIds
      : (meta.reservationId ? [meta.reservationId] : []);

    let released = 0;
    for (const rid of ids) {
      const rec = await airtable(`${airtableTable(TABLES.RESERVATIONS)}/${rid}`, { method: 'GET' })
        .catch(() => null);
      // On ne libère que ce qui est encore en attente de paiement
      if (rec?.fields?.['Statut'] === 'En attente paiement') {
        await airtable(`${airtableTable(TABLES.RESERVATIONS)}/${rid}`, {
          method: 'PATCH',
          body: JSON.stringify({ fields: { 'Statut': 'Annulée' }, typecast: true }),
        }).catch(() => {});
        released++;
      }
    }
    return jsonResponse(200, { ok: true, released });
  } catch (e) {
    console.error('[release-hold] error:', e);
    return jsonResponse(500, { error: 'Libération impossible' });
  }
};
