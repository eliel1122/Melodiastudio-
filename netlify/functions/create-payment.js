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
  const service = p.service;
  if (!service || !p.date || !p.slotTime) {
    return jsonResponse(400, { error: 'Prestation, date et créneau requis' });
  }

  try {
    // 1. Prix total + acompte
    const total = computeTotal(service, p.date, p.price);
    const deposit = depositFor(service);
    const choice = p.choice === 'total' ? 'total' : 'acompte';
    const amountToPay = choice === 'total' ? total : Math.min(deposit, total);
    const solde = choice === 'total' ? 0 : Math.max(0, total - amountToPay);

    // 2. Client (recherche par tél/email, sinon création)
    const clientId = await findOrCreateClient(details);

    // 3. Réservation "En attente paiement" — bloque le créneau le temps du paiement
    const ref = generateRef();
    const record = await airtable(`${airtableTable(TABLES.RESERVATIONS)}`, {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          'Référence': ref,
          'Date': p.date,
          'Heure début': p.slotTime,
          'Durée (h)': p.duration || 1,
          'Service': mapService(service),
          'Statut': 'En attente paiement',
          ...(clientId ? { 'Client': [clientId] } : {}),
          'Acompte payé': false,
          'Notes': [
            details.project || '',
            `💳 En attente ${choice === 'total' ? 'paiement total' : 'acompte'} ${amountToPay} F · total ${total} F` +
            (solde ? ` · solde ${solde} F` : ''),
            p.channel === 'whatsapp' && details.phone ? `via WhatsApp bot · ${details.phone}` : '',
          ].filter(Boolean).join(' · '),
        },
        typecast: true,
      }),
    });

    // 4. Init Paystack — metadata porte tout ce dont le webhook a besoin
    const metadata = {
      reservationId: record.id,
      ref,
      channel: p.channel || 'site',
      choice,
      total,
      amountPaid: amountToPay,
      solde,
      service: mapService(service),
      date: p.date,
      slotLabel: p.slotLabel || p.slotTime,
      name: details.name || '',
      phone: details.phone || '',
    };
    const pay = await paystackInit({
      email: details.email,
      amountXof: amountToPay,
      reference: ref,
      metadata,
      callbackUrl: `${SITE}/pages/paiement-confirme.html`,
    });

    return jsonResponse(200, {
      ok: true,
      ref,
      reservationId: record.id,
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
