// =====================================================
// POST /api/create-booking
// Crée 1+ réservations dans Airtable + notif WhatsApp Boss
// Payload accepté (2 modes) :
//
// Mode classic :
// {
//   mode: 'classic',
//   service: 'pack-gold',
//   date: '2026-06-25',
//   slotTime: '14:00',
//   slotLabel: '14h — 16h',
//   details: { name, email, phone, project }
// }
//
// Mode cart :
// {
//   mode: 'cart',
//   items: [{ service, option, qty, price, duration, planDate, planSlotTime, ... }, ...],
//   details: { name, email, phone, project }
// }
// =====================================================

const {
  airtable, airtableTable, TABLES, mapService,
  jsonResponse, preflight, sendWhatsApp,
} = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Body JSON invalide' }); }

  const details = payload.details || {};
  if (!details.name || !details.phone || !details.email) {
    return jsonResponse(400, { error: 'Coordonnées manquantes (name, phone, email requis)' });
  }

  try {
    // 1. Trouver ou créer le client
    const client = await findOrCreateClient(details);

    // 2. Construire la/les réservation(s)
    const items = normalizeItems(payload);
    if (!items.length) return jsonResponse(400, { error: 'Aucune prestation à réserver' });

    const created = [];
    for (const it of items) {
      const ref = generateRef();
      const record = await airtable(`${airtableTable(TABLES.RESERVATIONS)}`, {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            'Référence': ref,
            'Date': it.date,
            'Heure début': it.slotTime || '',
            'Durée (h)': it.duration || 1,
            'Service': mapService(it.service),
            'Statut': 'En attente',
            'Client': client?.id ? [client.id] : undefined,
            'Acompte payé': false,
            'Notes': details.project || '',
          },
          typecast: true,
        }),
      });
      created.push({ id: record.id, ref });
    }

    // 3. Notif WhatsApp au Boss
    const summary = formatSummary(details, items, created);
    await sendWhatsApp(summary).catch(() => {});

    return jsonResponse(200, {
      ok: true,
      created,
      message: 'Demande enregistrée. On revient vers toi sous 24h.',
    });

  } catch (e) {
    console.error('[booking] error:', e);
    return jsonResponse(e.status || 500, { error: e.message || 'Internal error', details: e.body });
  }
};

// =========================================================
// Helpers
// =========================================================

function normalizeItems(payload) {
  if (payload.mode === 'cart') {
    return (payload.items || [])
      .filter(it => it.planDate || it.date)
      .map(it => ({
        service: it.service,
        date: it.planDate || it.date,
        slotTime: it.planSlotTime || it.slotTime || '',
        duration: it.duration || 1,
        qty: it.qty || 1,
        price: it.price,
      }));
  }
  // mode classic
  return [{
    service: payload.service,
    date: payload.date,
    slotTime: payload.slotTime || '',
    duration: payload.duration || 1,
    qty: 1,
  }];
}

async function findOrCreateClient(details) {
  const fullName = details.name.trim();
  const phone = (details.phone || '').trim();
  const email = (details.email || '').trim();

  // Cherche par téléphone OU email
  const safe = s => (s || '').replace(/'/g, "\\'");
  const filter = `OR({Téléphone} = '${safe(phone)}', LOWER({Email}) = LOWER('${safe(email)}'))`;
  try {
    const found = await airtable(
      `${airtableTable(TABLES.CLIENTS)}?filterByFormula=${encodeURIComponent(filter)}&maxRecords=1`,
      { method: 'GET' }
    );
    if (found.records?.length) return found.records[0];
  } catch (e) {
    console.log('[client] search failed, will create:', e.message);
  }

  // Crée le client
  const [prenom, ...rest] = fullName.split(' ');
  const nom = rest.join(' ') || '';
  const created = await airtable(`${airtableTable(TABLES.CLIENTS)}`, {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        'Nom complet': fullName,
        'Prénom': prenom,
        'Nom': nom,
        'Téléphone': phone,
        'Email': email,
        'Tier': 'Bronze',
        'Points actifs': 1,
        'Séances totales': 1,
      },
      typecast: true,
    }),
  });
  return created;
}

function generateRef() {
  const d = new Date();
  const y = d.getFullYear().toString().slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MEL-${y}${m}${day}-${rand}`;
}

function formatSummary(details, items, created) {
  const lines = [
    `🎙️ NOUVELLE RÉSERVATION MELODIA`,
    ``,
    `Client : ${details.name}`,
    `Tél : ${details.phone}`,
    `Email : ${details.email}`,
    ``,
    `Prestations :`,
  ];
  items.forEach((it, i) => {
    lines.push(`• ${mapService(it.service)} — ${it.date} ${it.slotTime || ''} (${it.duration}h) [${created[i]?.ref || '?'}]`);
  });
  if (details.project) {
    lines.push(``);
    lines.push(`Projet : ${details.project.slice(0, 200)}`);
  }
  return lines.join('\n');
}
