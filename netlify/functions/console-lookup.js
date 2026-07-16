// =====================================================
// POST /api/console-lookup   { pin, query? , ref? , phone? }
// Console staff : retrouve une réservation (par référence) ou un client
// (par téléphone) + sa fidélité + ses réservations récentes.
// =====================================================

const { airtable, airtableTable, TABLES, jsonResponse, preflight } = require('./_lib');

const PIN = process.env.CONSOLE_PIN || '2024';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return jsonResponse(400, { error: 'Body invalide' }); }
  if (String(p.pin || '') !== String(PIN)) return jsonResponse(401, { error: 'Code incorrect' });

  const q = (p.query || '').trim();
  const ref = (p.ref || (isRef(q) ? q : '')).trim();
  const phone = (p.phone || (!isRef(q) ? q : '')).trim();

  try {
    // 0. Liste des réservations (gestion des statuts façon Airtable, en + simple)
    if (p.mode === 'list') {
      const found = await airtable(
        `${airtableTable(TABLES.RESERVATIONS)}?pageSize=80&sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=desc`,
        { method: 'GET' }
      );
      return jsonResponse(200, { ok: true, kind: 'list', reservations: (found.records || []).map(mapResa) });
    }

    // 1. Réservation par référence
    if (ref) {
      const found = await airtable(
        `${airtableTable(TABLES.RESERVATIONS)}?filterByFormula=${encodeURIComponent(`{Référence} = '${esc(ref)}'`)}&maxRecords=1`,
        { method: 'GET' }
      );
      if (found.records?.length) {
        const resa = found.records[0];
        const client = await clientFromReservation(resa);
        return jsonResponse(200, { ok: true, kind: 'booking', reservation: mapResa(resa), client });
      }
      return jsonResponse(404, { error: 'Réservation introuvable' });
    }

    // 2. Client par téléphone
    if (phone) {
      const digits = phone.replace(/\D/g, '');
      const filter = `OR(FIND('${esc(digits.slice(-8))}', {Téléphone}), {Téléphone} = '${esc(phone)}')`;
      const found = await airtable(
        `${airtableTable(TABLES.CLIENTS)}?filterByFormula=${encodeURIComponent(filter)}&maxRecords=1`,
        { method: 'GET' }
      );
      if (!found.records?.length) return jsonResponse(404, { error: 'Client introuvable' });
      const client = mapClient(found.records[0]);
      const resas = await reservationsForClient(found.records[0].id);
      return jsonResponse(200, { ok: true, kind: 'client', client, reservations: resas });
    }

    return jsonResponse(400, { error: 'Référence ou téléphone requis' });
  } catch (e) {
    console.error('[console-lookup] error:', e);
    return jsonResponse(500, { error: e.message || 'Erreur' });
  }
};

// ---------- Helpers ----------
function isRef(s) { return /^MEL-/i.test(s); }
function esc(s) { return (s || '').replace(/'/g, "\\'"); }

function one(v) { return Array.isArray(v) ? v[0] : v; } // lookups Airtable = tableaux

function mapResa(r) {
  const f = r.fields || {};
  return {
    id: r.id,
    ref: f['Référence'],
    date: f['Date'],
    heure: f['Heure début'],
    duree: f['Durée (h)'],
    service: f['Service'],
    statut: f['Statut'],
    acomptePaye: !!f['Acompte payé'],
    modePaiement: f['Mode paiement'] || '',
    notes: f['Notes'] || '',
    solde: extractSolde(f['Notes'] || ''),
    clientNom: one(f['Nom complet client']) || 'Client',
    clientPhone: one(f['Téléphone client']) || '',
  };
}

function mapClient(c) {
  const f = c.fields || {};
  return {
    id: c.id,
    nom: f['Nom complet'] || [f['Prénom'], f['Nom']].filter(Boolean).join(' ') || 'Client',
    phone: f['Téléphone'] || '',
    email: f['Email'] || '',
    tier: f['Tier'] || 'Bronze',
    points: f['Points actifs'] || 0,
    seances: f['Séances totales'] || 0,
    offertesGagnees: f['Sessions offertes gagnées'] || 0,
    offertesUtilisees: f['Sessions offertes utilisées'] || 0,
  };
}

function extractSolde(notes) {
  const m = notes.match(/solde\s+([\d\s]+)\s*F/i);
  return m ? parseInt(m[1].replace(/\s/g, ''), 10) : 0;
}

async function clientFromReservation(resa) {
  const ids = resa.fields?.['Client'];
  if (Array.isArray(ids) && ids.length) {
    const c = await airtable(`${airtableTable(TABLES.CLIENTS)}/${ids[0]}`, { method: 'GET' }).catch(() => null);
    if (c) return mapClient(c);
  }
  // fallback : champs client dénormalisés sur la résa
  const f = resa.fields || {};
  return {
    id: null,
    nom: f['Nom complet client'] || 'Client',
    phone: f['Téléphone client'] || '',
    email: f['Email du client'] || '',
    tier: null, points: null, seances: null,
  };
}

async function reservationsForClient(clientId) {
  const filter = `FIND('${clientId}', ARRAYJOIN({Client}))`;
  const found = await airtable(
    `${airtableTable(TABLES.RESERVATIONS)}?filterByFormula=${encodeURIComponent(filter)}&maxRecords=8&sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=desc`,
    { method: 'GET' }
  ).catch(() => ({ records: [] }));
  return (found.records || []).map(mapResa);
}
