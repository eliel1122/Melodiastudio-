// =====================================================
// GET /api/get-availability?date=YYYY-MM-DD
// Renvoie les créneaux occupés sur cette date
// (le frontend déduit les créneaux libres selon la durée)
// =====================================================

const { airtable, airtableTable, TABLES, jsonResponse, preflight } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });

  const date = event.queryStringParameters?.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse(400, { error: 'Param `date` requis au format YYYY-MM-DD' });
  }

  try {
    // 1. Réservations actives ce jour. Comptent comme occupées :
    //    - En attente / Confirmée / Soldée (fermes)
    //    - En attente paiement UNIQUEMENT si créée il y a < 5 min (hold Paystack) ;
    //      passé ce délai, un paiement non abouti libère le créneau.
    const holdMinutes = 5;
    const reservationsFilter =
      `AND(DATETIME_FORMAT({Date}, 'YYYY-MM-DD') = '${date}', OR(` +
        `{Statut} = 'En attente', {Statut} = 'Confirmée', {Statut} = 'Soldée', ` +
        `AND({Statut} = 'En attente paiement', DATETIME_DIFF(NOW(), {Créée le}, 'minutes') < ${holdMinutes})` +
      `))`;
    const reservations = await airtable(
      `${airtableTable(TABLES.RESERVATIONS)}?filterByFormula=${encodeURIComponent(reservationsFilter)}`,
      { method: 'GET' }
    );

    // 2. Créneaux bloqués ce jour
    const bloquesFilter = `DATETIME_FORMAT({Date}, 'YYYY-MM-DD') = '${date}'`;
    let bloques = { records: [] };
    try {
      bloques = await airtable(
        `${airtableTable(TABLES.BLOQUES)}?filterByFormula=${encodeURIComponent(bloquesFilter)}`,
        { method: 'GET' }
      );
    } catch (e) {
      // Si la table n'existe pas encore, on continue sans bloquer
      console.log('[availability] table bloqués absente, skip');
    }

    // 3. Normaliser les créneaux occupés en intervalles [start, end] minutes from midnight
    const occupied = [];

    for (const r of (reservations.records || [])) {
      const range = parseTimeRange(r.fields['Heure début']);
      if (!range) continue;
      // Priorité au champ Durée (h) ; sinon la fin du label ("10h — 11h") ; sinon 1h
      const durField = parseInt(r.fields['Durée (h)'], 10);
      const end = (!isNaN(durField) && durField > 0)
        ? range.start + durField * 60
        : (range.end != null && range.end > range.start) ? range.end : range.start + 60;
      occupied.push({ start: range.start, end, source: 'reservation', service: r.fields['Service'] });
    }
    for (const b of (bloques.records || [])) {
      const startRange = parseTimeRange(b.fields['Heure début']);
      const endRange = parseTimeRange(b.fields['Heure fin']);
      if (!startRange) continue;
      const end = endRange ? endRange.start
        : (startRange.end != null && startRange.end > startRange.start) ? startRange.end : null;
      if (end == null) continue;
      occupied.push({ start: startRange.start, end, source: 'blocage', reason: b.fields['Raison'] });
    }

    return jsonResponse(200, {
      ok: true,
      date,
      occupied,
      studioOpen: { startHour: 9, endHour: 21 },  // 9h-21h selon mémoire
    });
  } catch (e) {
    console.error('[availability] error:', e);
    return jsonResponse(e.status || 500, { error: e.message || 'Internal error' });
  }
};

// Accepte tous les formats rencontrés dans la base :
//   "10:00" · "10h" · "10h30" · "10h — 11h" · "09h — 10h30" · "10"
// Renvoie { start, end|null } en minutes depuis minuit.
function parseTimeRange(str) {
  if (!str || typeof str !== 'string') return null;
  const tokens = [...str.matchAll(/(\d{1,2})\s*(?:[h:](\d{2})?)?/g)]
    .map((m) => {
      const h = parseInt(m[1], 10);
      const min = parseInt(m[2] || '0', 10);
      if (isNaN(h) || h < 0 || h > 23 || isNaN(min) || min < 0 || min > 59) return null;
      return h * 60 + min;
    })
    .filter((v) => v != null);
  if (!tokens.length) return null;
  return { start: tokens[0], end: tokens.length > 1 ? tokens[1] : null };
}
