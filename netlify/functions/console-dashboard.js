// =====================================================
// POST /api/console-dashboard   { pin }
// Agrège l'activité du studio pour le tableau de bord de la Console.
// CA = encaissé réel (cash) : acompte pour Confirmée, prix plein pour
// Soldée/Terminée, acompte conservé pour une Annulée qui avait payé
// (acompte non remboursable). Bucketé par DATE de session (Abidjan = UTC).
// =====================================================

const {
  airtable, airtableTable, TABLES, jsonResponse, preflight,
  SERVICE_LABELS, PRICES, TUESDAY_HOUR_PRICE, depositFor,
} = require('./_lib');

const PIN = process.env.CONSOLE_PIN || '2024';

// label affiché → id service (pour retrouver le prix)
const LABEL_TO_ID = {};
for (const [id, label] of Object.entries(SERVICE_LABELS)) {
  if (!(label in LABEL_TO_ID)) LABEL_TO_ID[label] = id;
}
const JOURS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return jsonResponse(400, { error: 'Body invalide' }); }
  if (String(p.pin || '') !== String(PIN)) return jsonResponse(401, { error: 'Code incorrect' });

  try {
    const recs = await fetchAllReservations();
    return jsonResponse(200, { ok: true, ...aggregate(recs) });
  } catch (e) {
    console.error('[console-dashboard] error:', e);
    return jsonResponse(500, { error: e.message || 'Erreur' });
  }
};

// ---- Récupère toutes les résas (pagination Airtable, plafonné) ----
async function fetchAllReservations() {
  const out = [];
  let offset = '';
  for (let i = 0; i < 15; i++) { // 15 × 100 = 1500 max
    const url = `${airtableTable(TABLES.RESERVATIONS)}?pageSize=100&sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=desc${offset ? `&offset=${offset}` : ''}`;
    const page = await airtable(url, { method: 'GET' });
    out.push(...(page.records || []));
    if (!page.offset) break;
    offset = page.offset;
  }
  return out;
}

function one(v) { return Array.isArray(v) ? v[0] : v; }
function isTuesday(iso) { const d = new Date(iso + 'T00:00:00Z'); return d.getUTCDay() === 2; }

// Prix plein d'une session (selon service + durée + tarif mardi)
function fullPrice(f) {
  const label = f['Service'];
  const id = LABEL_TO_ID[label] || null;
  const isHourly = id === 'rec' || id === 'rec-hour' || label === "Studio à l'heure";
  if (isHourly) {
    const base = isTuesday(f['Date']) ? TUESDAY_HOUR_PRICE : 25000;
    return base * (Number(f['Durée (h)']) || 1);
  }
  return PRICES[id] || 0;
}

// Encaissé réel (cash) pour une résa
function collected(f) {
  const statut = f['Statut'];
  const price = fullPrice(f);
  const id = LABEL_TO_ID[f['Service']] || 'rec';
  const acompte = Math.min(depositFor(id), price);
  if (statut === 'Soldée' || statut === 'Terminée') return price;
  if (statut === 'Confirmée') return acompte;                       // acompte en ligne
  if (statut === 'Annulée') return f['Acompte payé'] ? acompte : 0; // acompte non remboursable
  return 0; // En attente / En attente paiement
}

function aggregate(recs) {
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const monthKey = todayISO.slice(0, 7);
  // début de semaine (lundi) en UTC
  const dow = (now.getUTCDay() + 6) % 7; // 0 = lundi
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow));
  const mondayISO = monday.toISOString().slice(0, 10);

  let caToday = 0, caWeek = 0, caMonth = 0, caTotal = 0;
  let resaMonth = 0, aVenir = 0, paidCount = 0;
  const byService = {}; // label → {count, ca}
  const byClient = {};   // nom → {count, ca}
  const byWeekday = [0, 0, 0, 0, 0, 0, 0]; // Lun..Dim (count)
  const dailyMap = {};   // date → ca (30 derniers jours)

  // 30 derniers jours (init à 0 pour une courbe continue)
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    dailyMap[d.toISOString().slice(0, 10)] = 0;
  }

  for (const rec of recs) {
    const f = rec.fields || {};
    const date = f['Date'];
    if (!date) continue;
    const ca = collected(f);
    const statut = f['Statut'];
    const counts = ['Confirmée', 'Soldée', 'Terminée'].includes(statut);

    caTotal += ca;
    if (date === todayISO) caToday += ca;
    if (date >= mondayISO) caWeek += ca;
    if (date.slice(0, 7) === monthKey) { caMonth += ca; if (counts) resaMonth++; }
    if (counts && date >= todayISO && statut === 'Confirmée') aVenir++;
    if (ca > 0) paidCount++;

    if (counts) {
      const label = f['Service'] || 'Autre';
      (byService[label] = byService[label] || { count: 0, ca: 0 });
      byService[label].count++; byService[label].ca += ca;

      const nom = one(f['Nom complet client']) || 'Client';
      (byClient[nom] = byClient[nom] || { count: 0, ca: 0 });
      byClient[nom].count++; byClient[nom].ca += ca;

      const wd = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7; // 0=Lun
      byWeekday[wd]++;
    }
    if (date in dailyMap) dailyMap[date] += ca;
  }

  const services = Object.entries(byService)
    .map(([label, v]) => ({ label, ...v })).sort((a, b) => b.ca - a.ca);
  const topClients = Object.entries(byClient)
    .map(([nom, v]) => ({ nom, ...v })).sort((a, b) => b.ca - a.ca).slice(0, 6);
  const weekday = byWeekday.map((count, i) => ({ jour: ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'][i], count }));
  const daily = Object.entries(dailyMap).map(([date, ca]) => ({ date, ca }));

  return {
    kpis: {
      caToday, caWeek, caMonth, caTotal,
      resaMonth, aVenir,
      panierMoyen: paidCount ? Math.round(caTotal / paidCount) : 0,
      totalResas: recs.length,
    },
    services, topClients, weekday, daily,
  };
}
