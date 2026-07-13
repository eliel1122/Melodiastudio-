// =====================================================
// POST /api/console-action   { pin, action, ... }
// Actions staff : encaisser le solde, clôturer une session (+ fidélité),
// ajuster les points, utiliser une séance offerte.
// =====================================================

const { airtable, airtableTable, TABLES, jsonResponse, preflight } = require('./_lib');

const PIN = process.env.CONSOLE_PIN || '2024';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return jsonResponse(400, { error: 'Body invalide' }); }
  if (String(p.pin || '') !== String(PIN)) return jsonResponse(401, { error: 'Code incorrect' });

  try {
    switch (p.action) {
      case 'mark_paid':      return await markPaid(p.reservationId);
      case 'mark_done':      return await markDone(p.reservationId);
      case 'fidelity_delta': return await fidelityDelta(p.clientId, parseInt(p.delta, 10) || 0);
      case 'use_free':       return await useFreeSession(p.clientId);
      default:               return jsonResponse(400, { error: 'Action inconnue' });
    }
  } catch (e) {
    console.error('[console-action] error:', e);
    return jsonResponse(500, { error: e.message || 'Erreur' });
  }
};

async function getResa(id) {
  return await airtable(`${airtableTable(TABLES.RESERVATIONS)}/${id}`, { method: 'GET' });
}
async function getClient(id) {
  return await airtable(`${airtableTable(TABLES.CLIENTS)}/${id}`, { method: 'GET' });
}

// Encaisse le solde → Soldée
async function markPaid(id) {
  if (!id) return jsonResponse(400, { error: 'reservationId requis' });
  const r = await getResa(id);
  const prev = r.fields?.['Notes'] || '';
  await airtable(`${airtableTable(TABLES.RESERVATIONS)}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fields: {
        'Statut': 'Soldée',
        'Acompte payé': true,
        'Notes': prev + `\n✅ Solde encaissé au studio (console)`,
      },
      typecast: true,
    }),
  });
  return jsonResponse(200, { ok: true, statut: 'Soldée' });
}

// Clôture la session + crédite la fidélité du client (+1 séance, +1 point)
async function markDone(id) {
  if (!id) return jsonResponse(400, { error: 'reservationId requis' });
  const r = await getResa(id);
  const prev = r.fields?.['Notes'] || '';
  await airtable(`${airtableTable(TABLES.RESERVATIONS)}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fields: { 'Statut': 'Terminée', 'Notes': prev + `\n🎬 Session terminée (console)` },
      typecast: true,
    }),
  });

  // Fidélité : +1 séance / +1 point (reset à 5 → 1 séance offerte)
  let fidelite = null;
  const clientIds = r.fields?.['Client'];
  if (Array.isArray(clientIds) && clientIds.length) {
    fidelite = await bumpFidelity(clientIds[0], +1);
  }
  return jsonResponse(200, { ok: true, statut: 'Terminée', fidelite });
}

async function fidelityDelta(clientId, delta) {
  if (!clientId) return jsonResponse(400, { error: 'clientId requis' });
  const fidelite = await bumpFidelity(clientId, delta);
  return jsonResponse(200, { ok: true, fidelite });
}

async function useFreeSession(clientId) {
  if (!clientId) return jsonResponse(400, { error: 'clientId requis' });
  const c = await getClient(clientId);
  const f = c.fields || {};
  const gagnees = f['Sessions offertes gagnées'] || 0;
  const utilisees = f['Sessions offertes utilisées'] || 0;
  if (gagnees - utilisees <= 0) return jsonResponse(400, { error: 'Aucune séance offerte disponible' });
  await airtable(`${airtableTable(TABLES.CLIENTS)}/${clientId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: { 'Sessions offertes utilisées': utilisees + 1 }, typecast: true }),
  });
  return jsonResponse(200, { ok: true, offertesDispo: gagnees - utilisees - 1 });
}

// Cœur fidélité : applique un delta de points, gère le passage de tier + séance offerte
async function bumpFidelity(clientId, delta) {
  const c = await getClient(clientId);
  const f = c.fields || {};
  let seances = (f['Séances totales'] || 0) + (delta > 0 ? delta : 0);
  let points = (f['Points actifs'] || 0) + delta;
  let offertes = f['Sessions offertes gagnées'] || 0;
  let unlocked = false;

  if (points < 0) points = 0;
  while (points >= 5) { points -= 5; offertes += 1; unlocked = true; }
  if (seances < 0) seances = 0;

  const tier = computeTier(seances);
  await airtable(`${airtableTable(TABLES.CLIENTS)}/${clientId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fields: {
        'Tier': tier,
        'Points actifs': points,
        'Séances totales': seances,
        'Sessions offertes gagnées': offertes,
      },
      typecast: true,
    }),
  });
  return { tier, points, seances, offertesGagnees: offertes, sessionUnlocked: unlocked };
}

function computeTier(s) {
  if (s >= 30) return 'Platinum';
  if (s >= 15) return 'Gold';
  if (s >= 5) return 'Argent';
  return 'Bronze';
}
