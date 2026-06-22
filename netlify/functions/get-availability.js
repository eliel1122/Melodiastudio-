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
    // 1. Réservations actives ce jour (statut En attente OU Confirmée)
    // On formate explicitement {Date} en YYYY-MM-DD pour comparer string à string (plus robuste qu'IS_SAME)
    const reservationsFilter = `AND(DATETIME_FORMAT({Date}, 'YYYY-MM-DD') = '${date}', OR({Statut} = 'En attente', {Statut} = 'Confirmée'))`;
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
      const startStr = r.fields['Heure début'];
      const dur = parseInt(r.fields['Durée (h)'] || 1, 10);
      const startMin = parseTimeToMinutes(startStr);
      if (startMin == null) continue;
      occupied.push({ start: startMin, end: startMin + dur * 60, source: 'reservation', service: r.fields['Service'] });
    }
    for (const b of (bloques.records || [])) {
      const startStr = b.fields['Heure début'];
      const endStr = b.fields['Heure fin'];
      const startMin = parseTimeToMinutes(startStr);
      const endMin = parseTimeToMinutes(endStr);
      if (startMin == null || endMin == null) continue;
      occupied.push({ start: startMin, end: endMin, source: 'blocage', reason: b.fields['Raison'] });
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

function parseTimeToMinutes(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/^(\d{1,2}):?(\d{2})?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2] || '0', 10);
  if (isNaN(h) || isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
