// =====================================================
// GET /api/get-blocked-days?year=2026&month=6
// Retourne la liste des jours full-bloqués (vacances Boss
// OU déjà 100% occupés par réservations) pour ce mois.
// Le frontend grise ces jours dans le calendrier.
// =====================================================

const { airtable, airtableTable, TABLES, jsonResponse, preflight } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });

  const year = parseInt(event.queryStringParameters?.year, 10);
  const month = parseInt(event.queryStringParameters?.month, 10); // 1-12
  if (!year || !month || month < 1 || month > 12) {
    return jsonResponse(400, { error: 'Params year + month (1-12) requis' });
  }

  const monthStart = `${year}-${pad(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate(); // 28/29/30/31
  const monthEnd = `${year}-${pad(month)}-${pad(lastDay)}`;

  try {
    // Récupère tous les blocages du mois
    let bloques = { records: [] };
    try {
      // Format YYYY-MM-DD pour comparaison string à string, robuste à tous les formats Airtable
      const filter = `AND(DATETIME_FORMAT({Date}, 'YYYY-MM-DD') >= '${monthStart}', DATETIME_FORMAT({Date}, 'YYYY-MM-DD') <= '${monthEnd}')`;
      bloques = await airtable(
        `${airtableTable(TABLES.BLOQUES)}?filterByFormula=${encodeURIComponent(filter)}`,
        { method: 'GET' }
      );
    } catch (e) {
      console.log('[blocked-days] table bloqués absente, skip:', e.message);
    }

    const open = 10 * 60;   // 10h
    const close = 24 * 60;  // 00h (minuit)
    const blockedSet = new Set();

    for (const b of (bloques.records || [])) {
      const dateField = b.fields['Date'];
      if (!dateField) continue;
      const dateIso = String(dateField).slice(0, 10); // garder YYYY-MM-DD
      const startMin = parseTimeToMinutes(b.fields['Heure début']);
      let endMin = parseTimeToMinutes(b.fields['Heure fin']);
      if (endMin === 0) endMin = 24 * 60; // fin "00:00" = minuit = fin de journée
      // Si la plage couvre 10h-00h → full day blocked
      if (startMin != null && endMin != null && startMin <= open && endMin >= close) {
        blockedSet.add(dateIso);
      }
      // Pas de plage spécifiée → on considère full day blocked
      if (startMin == null && endMin == null) {
        blockedSet.add(dateIso);
      }
    }

    return jsonResponse(200, {
      ok: true,
      year,
      month,
      blockedDays: Array.from(blockedSet).sort(),
    });
  } catch (e) {
    console.error('[blocked-days] error:', e);
    return jsonResponse(e.status || 500, { error: e.message || 'Internal error' });
  }
};

function pad(n) { return String(n).padStart(2, '0'); }

function parseTimeToMinutes(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/^(\d{1,2}):?(\d{2})?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2] || '0', 10);
  if (isNaN(h) || isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
