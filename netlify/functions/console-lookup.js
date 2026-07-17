// =====================================================
// POST /api/console-lookup   { pin, query? , ref? , phone? }
// Console staff : retrouve une réservation (par référence) ou un client
// (par téléphone) + sa fidélité + ses réservations récentes.
// =====================================================

const { airtable, airtableTable, TABLES, jsonResponse, preflight, carteUrl } = require('./_lib');

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
      // Pagination : on récupère TOUTES les résas (comme le dashboard), sinon
      // celles dont la date de session sort de la 1re page de 80 disparaissent
      // de la liste alors qu'elles comptent bien dans les stats.
      const records = [];
      let listOffset = '';
      for (let i = 0; i < 15; i++) { // 15 × 100 = 1500 max
        const url = `${airtableTable(TABLES.RESERVATIONS)}?pageSize=100&sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=desc${listOffset ? `&offset=${listOffset}` : ''}`;
        const page = await airtable(url, { method: 'GET' });
        records.push(...(page.records || []));
        if (!page.offset) break;
        listOffset = page.offset;
      }
      const now = Date.now();
      const visible = [];
      for (const rec of records) {
        const f = rec.fields || {};
        // Nettoyage : une Annulée SANS acompte, 20 min après clôture, = réservation
        // abandonnée (paiement jamais fait) → on la supprime. Tout le reste (dont
        // les Terminée et les Annulée AVEC acompte) reste visible dans la liste,
        // filtrable par statut et supprimable à la main via les cases à cocher.
        const closedAge = closureAgeMs(f['Notes'] || '', now);
        const closedOld = closedAge != null && closedAge > TWENTY_MIN;
        if (closedOld && f['Statut'] === 'Annulée' && !f['Acompte payé']) {
          airtable(`${airtableTable(TABLES.RESERVATIONS)}/${rec.id}`, { method: 'DELETE' }).catch(() => {});
          continue;
        }
        visible.push(mapResa(rec));
      }
      return jsonResponse(200, { ok: true, kind: 'list', reservations: visible });
    }

    // 0bis. Liste des clients (onglet Clients)
    if (p.mode === 'clients') {
      const out = [];
      let offset = '';
      for (let i = 0; i < 10; i++) { // 10 × 100 = 1000 max
        const url = `${airtableTable(TABLES.CLIENTS)}?pageSize=100${offset ? `&offset=${offset}` : ''}`;
        const page = await airtable(url, { method: 'GET' });
        out.push(...(page.records || []));
        if (!page.offset) break;
        offset = page.offset;
      }
      return jsonResponse(200, { ok: true, kind: 'clients', clients: out.map(mapClient) });
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
const TWENTY_MIN = 20 * 60 * 1000;
function isRef(s) { return /^MEL-/i.test(s); }
function esc(s) { return (s || '').replace(/'/g, "\\'"); }

// Âge (ms) depuis le marqueur [CLÔTURE:<ISO>] dans les Notes, sinon null.
function closureAgeMs(notes, now) {
  const m = /\[CLÔTURE:([^\]]+)\]/.exec(notes || '');
  if (!m) return null;
  const t = Date.parse(m[1]);
  return isNaN(t) ? null : (now - t);
}

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
  const phone = f['Téléphone'] || '';
  const digits = phone.replace(/\D/g, '');
  return {
    id: c.id,
    nom: f['Nom complet'] || [f['Prénom'], f['Nom']].filter(Boolean).join(' ') || 'Client',
    phone,
    carteUrl: digits.length >= 8 ? carteUrl(digits) : null,
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
