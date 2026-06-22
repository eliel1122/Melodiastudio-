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
};
