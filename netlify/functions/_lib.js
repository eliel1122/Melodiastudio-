// =====================================================
// MELODIA — Lib commune Netlify Functions
// Wrapper Airtable + mapping services + helpers
// =====================================================

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

// Noms des tables (côté Airtable)
const TABLES = {
  RESERVATIONS: 'Réservations',
  CLIENTS: 'Clients',
  BLOQUES: 'Créneaux bloqués',
};

// Mapping service ID (site) → label exact Single Select (Airtable)
// Synced avec js/booking.js (DATA.services) + js/tarifs.js (packs) + service detail pages.
const SERVICE_LABELS = {
  // booking.js services
  'rec':            "Studio à l'heure",
  'mix':            'Mix',
  'master':         'Mastering',
  'prod':           'Production beat',
  'vo':             'Voice-over',
  'pack':           'Pack Gold',
  // tarifs.js packs
  'pack-silver':    'Pack Silver',
  'pack-gold':      'Pack Gold',
  'pack-platinium': 'Pack Platinium',
  // service detail pages
  'da':             'Direction artistique',
  'clip':           'Tournage clip',
  'loc-studio':     'Location studio',
  'loc-sono':       'Location sono',
};

function mapService(id) {
  if (!id) return null;
  return SERVICE_LABELS[id] || id;
}

// ---------- Airtable HTTP wrapper ----------
async function airtable(path, opts = {}) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    throw new Error('Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID env vars');
  }
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error?.type || `Airtable HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function airtableTable(tableName) {
  return `/${encodeURIComponent(tableName)}`;
}

// ---------- CORS + JSON response helpers ----------
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

function preflight() {
  return { statusCode: 204, headers: corsHeaders(), body: '' };
}

// ---------- CallMeBot WhatsApp notification ----------
// Supporte 1 ou plusieurs destinataires :
//   CALLMEBOT_PHONE   = "2250700000000" ou "2250700000000,2250712345678"
//   CALLMEBOT_APIKEY  = "1111111"       ou "1111111,2222222"
// L'index N de la clé doit correspondre à l'index N du numéro.
async function sendWhatsApp(message) {
  const phones = (process.env.CALLMEBOT_PHONE || '').split(',').map(s => s.trim()).filter(Boolean);
  const apikeys = (process.env.CALLMEBOT_APIKEY || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!phones.length || !apikeys.length) {
    console.log('[callmebot] skipped (env not set)');
    return { ok: false, skipped: true };
  }
  if (phones.length !== apikeys.length) {
    console.warn(`[callmebot] mismatch: ${phones.length} phones vs ${apikeys.length} apikeys — using min count`);
  }

  const n = Math.min(phones.length, apikeys.length);
  const results = [];
  for (let i = 0; i < n; i++) {
    try {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phones[i])}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apikeys[i])}`;
      const res = await fetch(url, { method: 'GET' });
      results.push({ phone: phones[i], ok: res.ok, status: res.status });
    } catch (e) {
      console.error(`[callmebot] error for ${phones[i]}:`, e.message);
      results.push({ phone: phones[i], ok: false, error: e.message });
    }
  }
  return { ok: results.every(r => r.ok), recipients: results };
}

// ---------- Paiement (Paystack) ----------
// Acompte fixe (déduit du prix de la session). Modifiable ici, ou par service
// via DEPOSIT_BY_SERVICE ci-dessous. Override possible par env DEPOSIT_XOF.
const DEPOSIT_XOF = parseInt(process.env.DEPOSIT_XOF || '2500', 10);
const DEPOSIT_BY_SERVICE = {
  // 'pack-platinium': 10000,   // exemple : acompte spécifique par service
};

// Prix de référence par service (F CFA). Source de vérité côté serveur,
// alignée sur js/booking.js (DATA.services) + tarifs.
const PRICES = {
  'rec': 25000, 'mix': 150000, 'master': 75000, 'prod': 100000, 'vo': 40000,
  'pack': 180000, 'pack-silver': 40000, 'pack-gold': 180000, 'pack-platinium': 280000,
  'da': 30000, 'clip': 30000, 'loc-studio': 35000, 'loc-sono': 0,
  'jam': 0, 'rec-hour': 25000,
};
const TUESDAY_HOUR_PRICE = 15000;

function depositFor(serviceId) {
  return DEPOSIT_BY_SERVICE[serviceId] || DEPOSIT_XOF;
}

// Paystack attend le montant dans la sous-unité. Pour XOF on vérifie en test
// que 2500 F s'affiche bien "2 500" (sinon basculer PAYSTACK_SUBUNIT à 1).
const PAYSTACK_SUBUNIT = parseInt(process.env.PAYSTACK_SUBUNIT || '100', 10);
const PAYSTACK_SUBACCOUNT = process.env.PAYSTACK_SUBACCOUNT || null; // ACCT_xxx (optionnel)

// Initialise une transaction Paystack. Renvoie { authorization_url, reference, access_code }.
async function paystackInit({ email, amountXof, reference, metadata, callbackUrl }) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error('Missing PAYSTACK_SECRET_KEY');
  const body = {
    email: email || 'client@melodiastudio.pro',
    amount: Math.round(amountXof * PAYSTACK_SUBUNIT),
    currency: 'XOF',
    reference,
    metadata,
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    ...(PAYSTACK_SUBACCOUNT ? { subaccount: PAYSTACK_SUBACCOUNT } : {}),
  };
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data.message || `Paystack init HTTP ${res.status}`);
  }
  return data.data; // { authorization_url, access_code, reference }
}

// Vérifie la signature d'un webhook Paystack (HMAC SHA512 avec la clé secrète).
function paystackValidSignature(rawBody, signature) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key || !signature) return false;
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

// ---------- Date helpers ----------
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  TABLES,
  SERVICE_LABELS,
  mapService,
  airtable,
  airtableTable,
  jsonResponse,
  preflight,
  corsHeaders,
  sendWhatsApp,
  todayISO,
  PRICES,
  TUESDAY_HOUR_PRICE,
  depositFor,
  paystackInit,
  paystackValidSignature,
};
