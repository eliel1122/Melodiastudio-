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
      case 'set_status':     return await setStatus(p.reservationId, p.statut);
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

// PATCH résilient : si Airtable renvoie "Unknown field name", on retire ce
// champ et on réessaie (permet de fonctionner même si un champ optionnel
// comme "Sessions offertes gagnées" n'existe pas encore dans la base).
async function patchResilient(path, fields) {
  const body = { ...fields };
  for (let i = 0; i < 6; i++) {
    try {
      return await airtable(path, { method: 'PATCH', body: JSON.stringify({ fields: body, typecast: true }) });
    } catch (e) {
      const m = /Unknown field name:\s*"([^"]+)"/.exec(e.message || '');
      if (m && m[1] in body) { delete body[m[1]]; continue; }
      throw e;
    }
  }
}

// Changement de statut « à la Airtable » : édition simple du champ Statut,
// sans effet de bord fidélité (le crédit de points reste sur le bouton
// "Session terminée" du détail réservation, pour éviter tout double comptage).
const STATUSES = ['En attente', 'En attente paiement', 'Confirmée', 'Soldée', 'Terminée', 'Annulée'];
// Marqueur horodaté de clôture (Terminée/Annulée) → sert au masquage console
// après 20 min et à la suppression des annulées sans acompte.
const CLOSE_RE = /\[CLÔTURE:[^\]]+\]/g;
function closeNote(statut, prev) {
  let notes = (prev || '').replace(CLOSE_RE, '').trimEnd();
  notes += `\n✏️ Statut → ${statut} (console)`;
  if (statut === 'Terminée' || statut === 'Annulée') {
    notes += `\n[CLÔTURE:${new Date().toISOString()}]`;
  }
  return notes;
}

async function setStatus(id, statut) {
  if (!id) return jsonResponse(400, { error: 'reservationId requis' });
  if (!STATUSES.includes(statut)) return jsonResponse(400, { error: 'Statut invalide' });
  const r = await getResa(id);
  const prev = r.fields?.['Notes'] || '';
  await patchResilient(`${airtableTable(TABLES.RESERVATIONS)}/${id}`, {
    'Statut': statut,
    'Notes': closeNote(statut, prev),
  });
  return jsonResponse(200, { ok: true, statut });
}

// Encaisse le solde → Soldée
async function markPaid(id) {
  if (!id) return jsonResponse(400, { error: 'reservationId requis' });
  const r = await getResa(id);
  const prev = r.fields?.['Notes'] || '';
  await patchResilient(`${airtableTable(TABLES.RESERVATIONS)}/${id}`, {
    'Statut': 'Soldée',
    'Acompte payé': true,
    'Notes': prev + `\n✅ Solde encaissé au studio (console)`,
  });
  return jsonResponse(200, { ok: true, statut: 'Soldée' });
}

// Clôture la session + crédite la fidélité du client (+1 séance, +1 point)
async function markDone(id) {
  if (!id) return jsonResponse(400, { error: 'reservationId requis' });
  const r = await getResa(id);
  const prev = r.fields?.['Notes'] || '';
  await patchResilient(`${airtableTable(TABLES.RESERVATIONS)}/${id}`, {
    'Statut': 'Terminée',
    'Notes': closeNote('Terminée', prev).replace('✏️ Statut → Terminée (console)', '🎬 Session terminée (console)'),
  });

  // Fidélité : +1 séance / +1 point (reset à 5 → 1 séance offerte)
  // SAUF si la résa a déjà été créditée à la validation du paiement
  // (marqueur posé par paystack-webhook — évite le double comptage)
  let fidelite = null;
  const alreadyCredited = prev.includes('Fidélité créditée à la résa');
  const clientIds = r.fields?.['Client'];
  if (!alreadyCredited && Array.isArray(clientIds) && clientIds.length) {
    fidelite = await bumpFidelity(clientIds[0], +1);
  }
  return jsonResponse(200, { ok: true, statut: 'Terminée', fidelite, dejaCreditee: alreadyCredited });
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
  await patchResilient(`${airtableTable(TABLES.CLIENTS)}/${clientId}`, { 'Sessions offertes utilisées': utilisees + 1 });
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
  await patchResilient(`${airtableTable(TABLES.CLIENTS)}/${clientId}`, {
    'Tier': tier,
    'Points actifs': points,
    'Séances totales': seances,
    'Sessions offertes gagnées': offertes,
  });
  return { tier, points, seances, offertesGagnees: offertes, sessionUnlocked: unlocked };
}

function computeTier(s) {
  if (s >= 30) return 'Platinum';
  if (s >= 15) return 'Gold';
  if (s >= 5) return 'Argent';
  return 'Bronze';
}
