// =====================================================
// POST /api/create-payment
// Crée une réservation "En attente paiement" (bloque le créneau)
// + initialise un paiement Paystack. Renvoie l'URL de checkout.
//
// Payload :
// {
//   channel: 'site' | 'whatsapp',
//   service: 'rec', date: '2026-07-16', slotTime: '09:00',
//   slotLabel: '09h — 10h', duration: 1,
//   choice: 'acompte' | 'total',
//   price: 25000,               // prix total de la session (optionnel, sinon déduit)
//   details: { name, email, phone, project }
// }
// =====================================================

const {
  airtable, airtableTable, TABLES, mapService,
  jsonResponse, preflight,
  PRICES, TUESDAY_HOUR_PRICE, depositFor, paystackInit,
} = require('./_lib');

const SITE = 'https://melodiastudio.pro';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Body JSON invalide' }); }

  const details = p.details || {};

  // Normalise en une liste d'items (classic = 1 item, cart = N items).
  const items = Array.isArray(p.items) && p.items.length
    ? p.items
    : [{ service: p.service, date: p.date, slotTime: p.slotTime, slotLabel: p.slotLabel, duration: p.duration, price: p.price }];

  if (items.some((it) => !it.service || !it.date || !it.slotTime)) {
    return jsonResponse(400, { error: 'Prestation, date et créneau requis pour chaque service' });
  }

  try {
    // 1. Prix total (somme des services) + acompte (fixe, une fois pour la commande)
    const total = items.reduce((sum, it) => sum + computeTotal(it.service, it.date, it.price), 0);
    const deposit = depositFor(items[0].service);
    const choice = p.choice === 'total' ? 'total' : 'acompte';
    const amountToPay = choice === 'total' ? total : Math.min(deposit, total);
    const solde = Math.max(0, total - amountToPay);

    // 2. Client
    const clientId = await findOrCreateClient(details);

    // 3. Une réservation "En attente paiement" par item (bloque chaque créneau)
    const created = [];
    for (const it of items) {
      const ref = generateRef();
      const rec = await airtable(`${airtableTable(TABLES.RESERVATIONS)}`, {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            'Référence': ref,
            'Date': it.date,
            'Heure début': it.slotTime,
            'Durée (h)': it.duration || 1,
            'Service': mapService(it.service),
            'Statut': 'En attente paiement',
            ...(clientId ? { 'Client': [clientId] } : {}),
            'Acompte payé': false,
            'Notes': [
              details.project || '',
              `💳 En attente ${choice === 'total' ? 'paiement total' : 'acompte'} ${amountToPay} F · total commande ${total} F` +
              (solde ? ` · solde ${solde} F` : ''),
              p.channel === 'whatsapp' && details.phone ? `via WhatsApp bot · ${details.phone}` : '',
            ].filter(Boolean).join(' · '),
          },
          typecast: true,
        }),
      });
      created.push({ id: rec.id, ref, service: mapService(it.service), date: it.date, slotLabel: it.slotLabel || it.slotTime });
    }

    // 4. Init Paystack — 1 paiement pour toute la commande
    const payRef = created[0].ref;
    const metadata = {
      reservationId: created[0].id,             // rétro-compat
      reservationIds: created.map((c) => c.id), // toutes les résas de la commande
      ref: payRef,
      channel: p.channel || 'site',
      choice,
      total,
      amountPaid: amountToPay,
      solde,
      service: created.map((c) => c.service).join(' + '),
      date: created[0].date,
      slotLabel: created.length > 1 ? `${created.length} services` : created[0].slotLabel,
      name: details.name || '',
      phone: details.phone || '',
    };
    const pay = await paystackInit({
      email: details.email,
      amountXof: amountToPay,
      reference: payRef,
      metadata,
      callbackUrl: `${SITE}/pages/paiement-confirme.html`,
    });

    return jsonResponse(200, {
      ok: true,
      ref: payRef,
      reservationIds: created.map((c) => c.id),
      total, deposit: amountToPay, solde, choice,
      authorization_url: pay.authorization_url,
    });
  } catch (e) {
    console.error('[create-payment] error:', e);
    return jsonResponse(500, { error: e.message || 'Internal error' });
  }
};

// ---------- Helpers ----------
function computeTotal(service, dateIso, priceFromClient) {
  if (service === 'rec' && isTuesday(dateIso)) return TUESDAY_HOUR_PRICE;
  if (typeof priceFromClient === 'number' && priceFromClient > 0) return priceFromClient;
  return PRICES[service] || 0;
}

function isTuesday(iso) {
  if (!iso) return false;
  return new Date(iso + 'T00:00:00Z').getUTCDay() === 2;
}

async function findOrCreateClient(details) {
  const name = (details.name || '').trim();
  const phone = (details.phone || '').trim();
  const email = (details.email || '').trim();
  const safe = (s) => (s || '').replace(/'/g, "\\'");
  if (phone || email) {
    try {
      const filter = `OR({Téléphone} = '${safe(phone)}', LOWER({Email}) = LOWER('${safe(email)}'))`;
      const found = await airtable(
        `${airtableTable(TABLES.CLIENTS)}?filterByFormula=${encodeURIComponent(filter)}&maxRecords=1`,
        { method: 'GET' }
      );
      if (found.records?.length) return found.records[0].id;
    } catch (e) { console.log('[create-payment] client search failed:', e.message); }
  }
  try {
    const [prenom, ...rest] = name.split(' ');
    const created = await airtable(`${airtableTable(TABLES.CLIENTS)}`, {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          'Nom complet': name || 'Client',
          'Prénom': prenom || '', 'Nom': rest.join(' ') || '',
          'Téléphone': phone, 'Email': email,
          'Tier': 'Bronze', 'Points actifs': 0, 'Séances totales': 0,
        },
        typecast: true,
      }),
    });
    return created.id;
  } catch (e) { console.log('[create-payment] client create failed:', e.message); return null; }
}

function generateRef() {
  const d = new Date();
  const y = d.getFullYear().toString().slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MEL-${y}${m}${day}-${rand}`;
}
