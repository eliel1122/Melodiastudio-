// =====================================================
// POST /api/console-action   { pin, action, ... }
// Actions staff : encaisser le solde, clôturer une session (+ fidélité),
// ajuster les points, utiliser une séance offerte.
// =====================================================

const {
  airtable, airtableTable, TABLES, jsonResponse, preflight,
  mapService, SERVICE_LABELS, PRICES, hourPrice, depositFor,
  carteUrl, ycloudImage, resolveRole, ENGINEERS, COMMISSION_DEFAULT,
} = require('./_lib');

// label service (Airtable) → id (pour retrouver le prix lors d'une modif)
const LABEL_TO_ID = {};
for (const [id, label] of Object.entries(SERVICE_LABELS)) {
  if (!(label in LABEL_TO_ID)) LABEL_TO_ID[label] = id;
}
function extractSolde(notes) {
  const m = (notes || '').match(/solde\s+([\d\s]+)\s*F/i);
  return m ? parseInt(m[1].replace(/\s/g, ''), 10) : 0;
}

// Actions autorisées à un ingénieur (vue restreinte). Tout le reste (argent,
// création/suppression de résa, blocage de créneaux, assignation) est admin.
const ENGINEER_ACTIONS = ['fidelity_delta', 'use_free', 'send_card'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return jsonResponse(400, { error: 'Body invalide' }); }
  const auth = resolveRole(p.pin);
  if (!auth.ok) return jsonResponse(401, { error: 'Code incorrect' });
  if (auth.role === 'engineer' && !ENGINEER_ACTIONS.includes(p.action)) {
    return jsonResponse(403, { error: 'Action réservée à l\'admin' });
  }

  try {
    switch (p.action) {
      case 'create_resa':    return await createResa(p);
      case 'send_card':      return await sendCard(p.phone);
      case 'mark_paid':      return await markPaid(p.reservationId);
      case 'mark_done':      return await markDone(p.reservationId);
      case 'set_status':     return await setStatus(p.reservationId, p.statut);
      case 'delete_resa':    return await deleteResas(p);
      case 'edit_client':    return await editClient(p);
      case 'edit_resa':      return await editResa(p);
      case 'assign_inge':    return await assignInge(p);
      case 'fidelity_delta': return await fidelityDelta(p.clientId, parseInt(p.delta, 10) || 0);
      case 'use_free':       return await useFreeSession(p.clientId);
      case 'block_slot':     return await blockSlot(p);
      case 'list_blocks':    return await listBlocks();
      case 'delete_block':   return await deleteBlock(p.id);
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

// Ajout d'une réservation « client direct » (walk-in) depuis la console :
// génère une réf MEL-, statut Confirmée (acompte) ou Soldée (payé total),
// crédite +1 point fidélité (comme le flux en ligne) → compte dans le CA.
function generateRef() {
  const d = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MEL-${d}-${r}`;
}
function fullPriceFor(id, date, duree) {
  if (id === 'rec' || id === 'rec-hour') {
    // hourPrice = promo été + tarif mardi (source de vérité _lib, alignée site/bot)
    return hourPrice(date) * (Number(duree) || 1);
  }
  return PRICES[id] || 0;
}
async function findOrCreateClientConsole(nom, phone) {
  const safe = (s) => (s || '').replace(/'/g, "\\'");
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length >= 8) {
    const filter = `OR(FIND('${safe(digits.slice(-8))}', {Téléphone}), {Téléphone} = '+${digits}')`;
    const found = await airtable(
      `${airtableTable(TABLES.CLIENTS)}?filterByFormula=${encodeURIComponent(filter)}&maxRecords=1`,
      { method: 'GET' }
    ).catch(() => ({ records: [] }));
    if (found.records?.length) return found.records[0].id;
  }
  const [prenom, ...rest] = (nom || '').trim().split(' ');
  const created = await airtable(`${airtableTable(TABLES.CLIENTS)}`, {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        'Nom complet': nom || 'Client', 'Prénom': prenom || '', 'Nom': rest.join(' ') || '',
        ...(digits ? { 'Téléphone': '+' + digits } : {}),
        'Tier': 'Bronze', 'Points actifs': 0, 'Séances totales': 0,
      },
      typecast: true,
    }),
  }).catch(() => null);
  return created?.id || null;
}

async function createResa(p) {
  const serviceId = p.serviceId;
  const date = p.date, heure = p.heure;
  if (!serviceId || !date || !heure) return jsonResponse(400, { error: 'Service, date et heure requis' });
  const label = mapService(serviceId);
  if (!label) return jsonResponse(400, { error: 'Service inconnu' });

  const price = fullPriceFor(serviceId, date, p.duree);
  const defaultAcompte = Math.min(depositFor(serviceId), price || depositFor(serviceId));
  const customAcompte = parseInt(p.montantAcompte, 10);
  const acompte = (customAcompte > 0) ? Math.min(customAcompte, price || customAcompte) : defaultAcompte;
  const choice = p.paiement === 'total' ? 'total' : 'acompte';
  const statut = choice === 'total' ? 'Soldée' : 'Confirmée';
  const paid = choice === 'total' ? price : acompte;
  const solde = choice === 'total' ? 0 : Math.max(0, price - paid);
  const ref = generateRef();

  const clientId = await findOrCreateClientConsole(p.nom, p.phone);

  const notes = [
    `🎫 Résa ajoutée en console (client direct)`,
    `💳 ${choice === 'total' ? `Payé en totalité ${paid} F` : `Acompte ${paid} F`}${solde ? ` · solde ${solde} F` : ''}`,
    `🎁 Fidélité créditée à la résa`,
  ].join('\n');

  const rec = await airtable(`${airtableTable(TABLES.RESERVATIONS)}`, {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        'Référence': ref, 'Date': date, 'Heure début': heure, 'Durée (h)': Number(p.duree) || 1,
        'Service': label, 'Statut': statut, 'Acompte payé': true, 'Notes': notes,
        ...(clientId ? { 'Client': [clientId] } : {}),
      },
      typecast: true,
    }),
  });

  let fidelite = null;
  if (clientId) fidelite = await bumpFidelity(clientId, +1);
  const digits = (p.phone || '').replace(/\D/g, '');
  return jsonResponse(200, {
    ok: true, ref, statut, prix: price, fidelite,
    phone: digits || null,
    carteUrl: digits ? carteUrl(digits) : null,
  });
}

// Envoie la carte de fidélité PNG au client sur WhatsApp (transport YCloud).
async function sendCard(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length < 8) return jsonResponse(400, { error: 'Numéro invalide' });
  const r = await ycloudImage(digits, carteUrl(digits), '🎁 Ta carte fidélité Melodia — présente-la à l\'accueil. Ta carte en ligne : https://melodiastudio.pro/pages/ma-carte.html');
  if (!r.ok) return jsonResponse(200, { ok: false, error: r.error || 'Envoi impossible' });
  return jsonResponse(200, { ok: true });
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

// Suppression définitive d'une ou plusieurs réservations (console → Airtable).
// Permet de nettoyer les résas de test sans passer par Airtable.
async function deleteResas(p) {
  const ids = Array.isArray(p.reservationIds) ? p.reservationIds
    : (p.reservationId ? [p.reservationId] : []);
  if (!ids.length) return jsonResponse(400, { error: 'Aucune réservation sélectionnée' });
  let deleted = 0; const errors = [];
  for (const id of ids) {
    try { await airtable(`${airtableTable(TABLES.RESERVATIONS)}/${id}`, { method: 'DELETE' }); deleted++; }
    catch (e) { errors.push(id); }
  }
  return jsonResponse(200, { ok: true, deleted, errors });
}

// Édition des infos d'un client (nom, téléphone, email) depuis la console.
async function editClient(p) {
  if (!p.clientId) return jsonResponse(400, { error: 'clientId requis' });
  const nom = (p.nom || '').trim();
  const digits = (p.phone || '').replace(/\D/g, '');
  const fields = {};
  if (nom) {
    const [prenom, ...rest] = nom.split(' ');
    fields['Nom complet'] = nom;
    fields['Prénom'] = prenom || '';
    fields['Nom'] = rest.join(' ') || '';
  }
  // téléphone : '+225…' si fourni, sinon on vide le champ
  fields['Téléphone'] = digits ? '+' + digits : '';
  if (p.email !== undefined) fields['Email'] = (p.email || '').trim();
  await patchResilient(`${airtableTable(TABLES.CLIENTS)}/${p.clientId}`, fields);
  return jsonResponse(200, { ok: true, phone: digits || null, carteUrl: digits.length >= 8 ? carteUrl(digits) : null });
}

// Modifie une session existante (service, date, heure, durée) — ex : le client
// veut finalement 2h au lieu d'1h, ou être reprogrammé. Recalcule le solde en
// préservant le montant déjà payé, uniquement si la résa a un marqueur "solde".
async function editResa(p) {
  if (!p.reservationId) return jsonResponse(400, { error: 'reservationId requis' });
  const r = await getResa(p.reservationId);
  const f = r.fields || {};
  const oldLabel = f['Service'];
  const oldId = LABEL_TO_ID[oldLabel] || 'rec';
  const oldDate = f['Date'];
  const oldDuree = Number(f['Durée (h)']) || 1;

  const serviceId = p.serviceId || oldId;
  const label = mapService(serviceId) || oldLabel;
  const date = p.date || oldDate;
  const heure = (p.heure != null && String(p.heure).trim() !== '') ? p.heure : f['Heure début'];
  const duree = (p.duree != null && String(p.duree).trim() !== '') ? Number(p.duree) : oldDuree;
  if (!label) return jsonResponse(400, { error: 'Service inconnu' });

  const fields = {
    'Service': label,
    ...(date ? { 'Date': date } : {}),
    'Heure début': heure,
    'Durée (h)': duree,
  };

  // Recalcul du solde en préservant le déjà-payé (ancien prix − ancien solde),
  // seulement si un marqueur "solde X F" existe (résas créées en console).
  const notes = f['Notes'] || '';
  if (/solde\s+[\d\s]+\s*F/i.test(notes)) {
    const oldPrice = fullPriceFor(oldId, oldDate, oldDuree);
    const paid = Math.max(0, oldPrice - extractSolde(notes));
    const newPrice = fullPriceFor(serviceId, date, duree);
    const newSolde = Math.max(0, newPrice - paid);
    fields['Notes'] = notes.replace(/solde\s+[\d\s]+\s*F/i, 'solde ' + newSolde + ' F') + '\n✏️ Session modifiée (console)';
  } else {
    fields['Notes'] = notes + '\n✏️ Session modifiée (console)';
  }

  await patchResilient(`${airtableTable(TABLES.RESERVATIONS)}/${p.reservationId}`, fields);
  return jsonResponse(200, { ok: true });
}

// Assigne un ingénieur à une session + son % de commission (défaut 20 %).
// Écrit les champs Airtable « Ingé assigné » (single-select) et « Commission % ».
// `saved` = false si les champs n'existent pas encore dans Airtable (setup à faire).
async function assignInge(p) {
  if (!p.reservationId) return jsonResponse(400, { error: 'reservationId requis' });
  const inge = p.inge;
  if (!ENGINEERS.includes(inge)) return jsonResponse(400, { error: 'Ingé invalide' });
  let comm = parseInt(p.commission, 10);
  if (isNaN(comm) || comm < 0) comm = COMMISSION_DEFAULT;
  if (comm > 100) comm = 100;
  const res = await patchResilient(`${airtableTable(TABLES.RESERVATIONS)}/${p.reservationId}`, {
    'Ingé assigné': inge,
    'Commission %': comm,
  });
  const saved = res?.fields?.['Ingé assigné'] === inge;
  return jsonResponse(200, { ok: true, inge, commission: comm, saved });
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

// ---- Créneaux bloqués (indisponibilités manuelles : repos, maintenance…) ----
// Écrit dans la table Airtable 'Créneaux bloqués' que get-availability lit déjà.
async function blockSlot(p) {
  const date = p.date, debut = p.heureDebut, fin = p.heureFin;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return jsonResponse(400, { error: 'Date invalide (YYYY-MM-DD)' });
  if (!/^\d{1,2}:\d{2}$/.test(debut || '') || !/^\d{1,2}:\d{2}$/.test(fin || '')) return jsonResponse(400, { error: 'Heures invalides (HH:MM)' });
  if (fin <= debut) return jsonResponse(400, { error: "L'heure de fin doit être après le début" });
  const rec = await airtable(`${airtableTable(TABLES.BLOQUES)}`, {
    method: 'POST',
    body: JSON.stringify({ fields: { 'Date': date, 'Heure début': debut, 'Heure fin': fin, 'Raison': (p.raison || 'Bloqué').slice(0, 120) }, typecast: true }),
  });
  return jsonResponse(200, { ok: true, id: rec.id });
}

async function listBlocks() {
  const today = new Date().toISOString().slice(0, 10);
  const res = await airtable(`${airtableTable(TABLES.BLOQUES)}?pageSize=100`, { method: 'GET' }).catch(() => ({ records: [] }));
  const blocks = (res.records || [])
    .map((r) => ({
      id: r.id,
      date: String(r.fields['Date'] || '').slice(0, 10),
      debut: r.fields['Heure début'] || '',
      fin: r.fields['Heure fin'] || '',
      raison: r.fields['Raison'] || '',
    }))
    .filter((b) => b.date && b.date >= today)
    .sort((a, b) => (a.date + a.debut).localeCompare(b.date + b.debut));
  return jsonResponse(200, { ok: true, blocks });
}

async function deleteBlock(id) {
  if (!id) return jsonResponse(400, { error: 'id requis' });
  await airtable(`${airtableTable(TABLES.BLOQUES)}/${id}`, { method: 'DELETE' });
  return jsonResponse(200, { ok: true });
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
  if (s >= 20) return 'Platinum';
  if (s >= 10) return 'Gold';
  if (s >= 5) return 'Argent';
  return 'Bronze';
}
