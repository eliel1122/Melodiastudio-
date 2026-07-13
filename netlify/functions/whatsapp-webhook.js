// =====================================================
// MELODIA — WhatsApp Cloud API Webhook
// Reçoit les messages des clients, les route vers les handlers
// et appelle l'API Meta pour répondre.
//
// Env vars Netlify requises :
//   - WHATSAPP_VERIFY_TOKEN     (secret aléatoire qu'on partage avec Meta config)
//   - WHATSAPP_ACCESS_TOKEN     (token permanent de l'app Meta)
//   - WHATSAPP_PHONE_ID         (Phone Number ID côté Meta)
//   - WHATSAPP_APP_SECRET       (App Secret pour valider la signature des webhooks)
//   - AIRTABLE_API_KEY + AIRTABLE_BASE_ID (déjà setup)
// =====================================================

const crypto = require('crypto');
const {
  airtable, airtableTable, TABLES, mapService, sendWhatsApp,
} = require('./_lib');

const META_API = 'https://graph.facebook.com/v21.0';

exports.handler = async (event) => {
  // ---------- GET : Verification handshake Meta ----------
  if (event.httpMethod === 'GET') {
    const mode = event.queryStringParameters?.['hub.mode'];
    const token = event.queryStringParameters?.['hub.verify_token'];
    const challenge = event.queryStringParameters?.['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return { statusCode: 200, body: challenge || '' };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  // ---------- POST : Réception des événements ----------
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Validation signature Meta (optionnelle mais reco)
  if (process.env.WHATSAPP_APP_SECRET) {
    const signature = event.headers['x-hub-signature-256'] || event.headers['X-Hub-Signature-256'];
    if (!validSignature(event.body, signature, process.env.WHATSAPP_APP_SECRET)) {
      console.warn('[whatsapp] invalid signature');
      return { statusCode: 401, body: 'Invalid signature' };
    }
  }

  let payload;
  try { payload = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Bad JSON' }; }

  try {
    // ---- YCloud : whatsapp.inbound_message.received ----
    if (payload.type === 'whatsapp.inbound_message.received' && payload.whatsappInboundMessage) {
      await handleYCloudMessage(payload.whatsappInboundMessage);
      return { statusCode: 200, body: 'OK' };
    }

    // ---- Meta Cloud API (format natif / simulations) ----
    // Parcourt les entries (Meta peut envoyer plusieurs events groupés)
    for (const entry of (payload.entry || [])) {
      for (const change of (entry.changes || [])) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        const messages = value.messages || [];
        const contacts = value.contacts || [];
        for (let i = 0; i < messages.length; i++) {
          await handleMessage(messages[i], contacts[i] || {});
        }
      }
    }
  } catch (e) {
    console.error('[whatsapp] handler error:', e);
    // On répond quand même 200 pour ne pas que Meta retry en boucle
  }

  return { statusCode: 200, body: 'OK' };
};

// =====================================================
// YCloud — message entrant (transport de prod)
// =====================================================
async function handleYCloudMessage(m) {
  const from = m.from;                        // ex "2250700000000"
  const name = m.customerProfile?.name || 'là';

  if (m.type === 'text') {
    return await routeText(from, name, (m.text?.body || '').toLowerCase().trim());
  }
  if (m.type === 'interactive') {
    const it = m.interactive || {};
    const reply =
      it.list_reply?.id || it.listReply?.id ||
      it.button_reply?.id || it.buttonReply?.id;
    return await routeAction(from, name, reply);
  }
  if (m.type === 'button') {
    return await routeAction(from, name, m.button?.payload || m.button?.text);
  }
  return await sendText(from, `Salut ${name} ! Tape *menu* pour réserver ta session 🎙️`);
}

// =====================================================
// Routing des messages entrants (Meta / simulations)
// =====================================================
async function handleMessage(msg, contact) {
  const from = msg.from;
  const name = contact.profile?.name || 'là';

  // Type du message
  if (msg.type === 'text') {
    const text = (msg.text?.body || '').toLowerCase().trim();
    return await routeText(from, name, text);
  }
  if (msg.type === 'interactive') {
    const reply = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
    return await routeAction(from, name, reply);
  }
  if (msg.type === 'button') {
    return await routeAction(from, name, msg.button?.payload);
  }
  // Sinon (image, audio, etc.) — réponse générique
  return await sendText(from, `Salut ${name} ! On a bien reçu ton message. Tape *menu* pour voir ce que je peux faire pour toi.`);
}

async function routeText(from, name, text) {
  // Mots-clés naturels → actions
  if (/^(bonjour|salut|hello|hi|hey|coucou|menu|start|commencer)/i.test(text)) {
    return await sendMainMenu(from, name);
  }
  if (/(tarif|prix|combien|cout)/i.test(text)) return await routeAction(from, name, 'TARIFS');
  if (/(reserv|book|booking|seance)/i.test(text)) return await routeAction(from, name, 'RESERVER');
  if (/(adresse|où|ou|map|location|venir)/i.test(text)) return await routeAction(from, name, 'ADRESSE');
  if (/(fidelit|carte|point)/i.test(text)) return await routeAction(from, name, 'FIDELITE');
  if (/(contact|joindre|telephone|email)/i.test(text)) return await routeAction(from, name, 'CONTACT');
  // Default : menu
  return await sendMainMenu(from, name);
}

async function routeAction(from, name, actionId) {
  if (!actionId) return await sendMainMenu(from, name);

  // ---- Tunnel de réservation (contexte encodé dans l'id, pas de session) ----
  // S|<svc>              → choix de la date
  // D|<svc>|<iso>        → choix de la période (ou RDV direct)
  // P|<svc>|<iso>|<per>  → choix du créneau dans la période
  // T|<svc>|<iso>|<h>    → récap + confirmation
  // OK|<svc>|<iso>|<h>   → création de la réservation
  const [op, ...args] = actionId.split('|');
  switch (op) {
    case 'S':  return await sendDates(from, args[0]);
    case 'D':  return await sendPeriods(from, args[0], args[1]);
    case 'P':  return await sendSlots(from, args[0], args[1], args[2]);
    case 'T':  return await sendRecap(from, args[0], args[1], args[2]);
    case 'OK': return await confirmBooking(from, name, args[0], args[1], args[2]);
  }

  switch (actionId) {
    case 'RESERVER':  return await sendReserverFlow(from, name);
    case 'TARIFS':    return await sendTarifs(from);
    case 'ADRESSE':   return await sendAdresse(from);
    case 'FIDELITE':  return await sendFidelite(from);
    case 'CONTACT':   return await sendContact(from);
    case 'MENU':      return await sendMainMenu(from, name);
    default:          return await sendMainMenu(from, name);
  }
}

// =====================================================
// Handlers de réponse
// =====================================================
async function sendMainMenu(from, name) {
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🎙️ Melodia Studio' },
      body: { text: `Salut ${name} ! Bienvenue chez Melodia. Sur quoi je peux t'aider ?` },
      footer: { text: 'Le studio des artistes qui montent · Abidjan' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'RESERVER', title: '🎙️ Réserver' } },
          { type: 'reply', reply: { id: 'TARIFS',   title: '📋 Tarifs' } },
          { type: 'reply', reply: { id: 'ADRESSE',  title: '📍 Adresse' } },
        ],
      },
    },
  });
}

async function sendTarifs(from) {
  const txt = [
    '*📋 TARIFS MELODIA STUDIO*',
    '',
    '*🎙️ ENREGISTREMENT*',
    '• À l\'heure : 25 000 FCFA',
    '• Pack Silver (2h + pré-mix + photos) : 40 000',
    '• Pack Gold (2h + mix + photos + cover) : 180 000',
    '• Pack Platinium (tout inclus) : 280 000',
    '',
    '*🎚️ MIX & MASTER*',
    '• Mix : 150 000 / titre',
    '• Mix + Master : 200 000 / titre',
    '• Mastering : 75 000 / titre',
    '',
    '*🎹 AUTRES*',
    '• Production beat : dès 100 000',
    '• Voice-over : 40 000 / h',
    '• Direction artistique : dès 30 000',
    '• Location studio : dès 35 000 / h',
    '• Tournage clip : dès 30 000 / h',
    '',
    '🔗 Détails : https://melodiastudio.pro/pages/tarifs.html',
    '',
    'Tape *réserver* pour planifier ta session 🎶',
  ].join('\n');
  return await sendText(from, txt);
}

async function sendAdresse(from) {
  await callMeta(from, {
    type: 'location',
    location: {
      latitude: 5.378015,
      longitude: -3.940415,
      name: 'Melodia Studio',
      address: 'Cocody Riviera 4 M\'pouto - La harpe mélodieuse',
    },
  });
  return await sendText(from,
    '📍 *Melodia Studio*\nCocody Riviera 4 M\'pouto\nLa harpe mélodieuse\nPlus Code : 82HW+W6 Abidjan\n\n' +
    '🗺️ Google Maps : https://www.google.com/maps?q=82HW%2BW6+Abidjan\n\n' +
    '⏰ Lun—Sam : 9h-23h · Dim : sur RDV'
  );
}

async function sendFidelite(from) {
  return await sendText(from,
    '*🎁 CARTE FIDÉLITÉ MELODIA FAMILY*\n\n' +
    'Gratuite, à vie. Inscription en 30 secondes.\n\n' +
    '🥉 1 point offert à l\'inscription\n' +
    '🎖️ 1 séance offerte toutes les 5 réservations\n' +
    '🆙 Tier auto : Bronze → Argent (-5%) → Gold (-10%) → Platinum (-15%)\n\n' +
    '👉 Active ta carte : https://melodiastudio.pro/pages/fidelite.html'
  );
}

async function sendContact(from) {
  return await sendText(from,
    '*📞 NOUS CONTACTER*\n\n' +
    '📱 WhatsApp 1 : +225 07 03 38 77 38\n' +
    '📱 WhatsApp 2 : +225 07 18 41 51 31\n' +
    '✉️ Email : contact.melodiastud@gmail.com\n' +
    '📷 Instagram : @melodia.studi0\n' +
    '🎵 TikTok : @melodia.studi0\n' +
    '🌐 Site : https://melodiastudio.pro'
  );
}

// =====================================================
// TUNNEL DE RÉSERVATION — même parcours que le site
// Catalogue : id → { label court (≤24c), durée h (0 = RDV 30min),
//                    prix (description ≤72c), service id Airtable }
// =====================================================
const CATALOG = {
  rec:       { title: 'Enregistrement (heure)', dur: 1, desc: '25 000 F / h · 15 000 F le mardi', svc: 'rec' },
  silver:    { title: 'Pack Silver',            dur: 2, desc: '40 000 F · 2h + pré-mix + photos', svc: 'pack-silver' },
  gold:      { title: 'Pack Gold',              dur: 2, desc: '180 000 F · 2h + mix + photos + cover', svc: 'pack-gold' },
  platinium: { title: 'Pack Platinium',         dur: 2, desc: '280 000 F · tout inclus', svc: 'pack-platinium' },
  jam:       { title: 'Répétitions / jam',      dur: 2, desc: 'Session live · tarif confirmé par le studio', svc: 'Répétitions / jam session' },
  vo:        { title: 'Voice-over',             dur: 1, desc: '40 000 F / h', svc: 'vo' },
  mix:       { title: 'Mix',                    dur: 0, desc: '150 000 F / titre · RDV 30min', svc: 'mix' },
  master:    { title: 'Mastering',              dur: 0, desc: '75 000 F / titre · RDV 30min', svc: 'master' },
  prod:      { title: 'Production beat',        dur: 0, desc: 'Dès 100 000 F · RDV 30min', svc: 'prod' },
  da:        { title: 'Direction artistique',   dur: 0, desc: 'Dès 30 000 F · RDV 30min', svc: 'da' },
};
const RDV_HOURS = [10, 14, 17]; // RDV 30min pour mix/master/prod/da
const JOURS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const MOIS = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];

async function sendReserverFlow(from) {
  const row = (id) => ({ id: `S|${id}`, title: CATALOG[id].title, description: CATALOG[id].desc });
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '🎙️ Réserver une session' },
      body: { text: 'Choisis ta prestation — je te montre ensuite les créneaux réellement disponibles.' },
      footer: { text: 'Melodia Studio · Cocody Riviera 4' },
      action: {
        button: 'Voir les services',
        sections: [
          { title: '🎙️ Studio', rows: ['rec', 'silver', 'gold', 'platinium', 'jam', 'vo'].map(row) },
          { title: '🎚️ Prod & post-prod', rows: ['mix', 'master', 'prod', 'da'].map(row) },
        ],
      },
    },
  });
}

async function sendDates(from, svcId) {
  const c = CATALOG[svcId];
  if (!c) return await sendMainMenu(from, 'là');
  const rows = [];
  const now = new Date();
  // Aujourd'hui inclus seulement avant 18h ; sinon on démarre demain
  const startOffset = now.getUTCHours() < 18 ? 0 : 1;
  for (let i = startOffset; rows.length < 8; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    const label = `${JOURS[dow]} ${d.getUTCDate()} ${MOIS[d.getUTCMonth()]}`;
    const isToday = i === 0;
    const mardi = dow === 2 && svcId === 'rec';
    rows.push({
      id: `D|${svcId}|${iso}`,
      title: isToday ? 'Aujourd\'hui' : label,
      description: mardi ? '🔥 Tarif mardi : 15 000 F / h' : (isToday ? label : undefined),
    });
  }
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: c.title },
      body: { text: 'Quel jour t\'arrange ?' },
      action: { button: 'Choisir le jour', sections: [{ title: 'Prochains jours', rows }] },
    },
  });
}

async function sendPeriods(from, svcId, dateIso) {
  const c = CATALOG[svcId];
  if (!c) return await sendMainMenu(from, 'là');

  // Services RDV : 3 créneaux fixes de 30min, direct
  if (c.dur === 0) {
    const occupied = await fetchOccupied(dateIso);
    const rows = RDV_HOURS
      .filter((h) => !overlaps(h * 60, h * 60 + 30, occupied))
      .map((h) => ({ id: `T|${svcId}|${dateIso}|${h}`, title: `${pad2(h)}h — ${pad2(h)}h30`, description: 'Rendez-vous · 30min' }));
    if (!rows.length) return await noSlots(from, svcId, dateIso);
    return await callMeta(from, {
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: c.title },
        body: { text: `📅 ${frDate(dateIso)}\nChoisis ton rendez-vous :` },
        action: { button: 'Voir les RDV', sections: [{ title: 'Rendez-vous 30min', rows }] },
      },
    });
  }

  // Services studio : périodes selon les créneaux réellement libres
  const free = await freeStarts(svcId, dateIso);
  if (!free.length) return await noSlots(from, svcId, dateIso);
  const buttons = [];
  if (free.some((h) => h < 12)) buttons.push({ type: 'reply', reply: { id: `P|${svcId}|${dateIso}|M`, title: '🌅 Matin' } });
  if (free.some((h) => h >= 12 && h < 17)) buttons.push({ type: 'reply', reply: { id: `P|${svcId}|${dateIso}|A`, title: '☀️ Après-midi' } });
  if (free.some((h) => h >= 17)) buttons.push({ type: 'reply', reply: { id: `P|${svcId}|${dateIso}|S`, title: '🌙 Soirée' } });
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `🎙️ *${c.title}*\n📅 ${frDate(dateIso)}\n\nTu préfères quel moment ? (créneaux vérifiés en temps réel)` },
      action: { buttons },
    },
  });
}

async function sendSlots(from, svcId, dateIso, period) {
  const c = CATALOG[svcId];
  if (!c) return await sendMainMenu(from, 'là');
  const free = await freeStarts(svcId, dateIso);
  const inPeriod = free.filter((h) =>
    period === 'M' ? h < 12 : period === 'A' ? h >= 12 && h < 17 : h >= 17
  ).slice(0, 10);
  if (!inPeriod.length) return await noSlots(from, svcId, dateIso);
  const rows = inPeriod.map((h) => ({
    id: `T|${svcId}|${dateIso}|${h}`,
    title: `${pad2(h)}h — ${pad2(h + c.dur)}h`,
    description: `${c.dur}h de session`,
  }));
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: c.title },
      body: { text: `📅 ${frDate(dateIso)}\nChoisis ton créneau :` },
      action: { button: 'Voir les créneaux', sections: [{ title: 'Créneaux libres', rows }] },
    },
  });
}

async function sendRecap(from, svcId, dateIso, hStr) {
  const c = CATALOG[svcId];
  if (!c) return await sendMainMenu(from, 'là');
  const h = parseInt(hStr, 10);
  const fin = c.dur === 0 ? `${pad2(h)}h30` : `${pad2(h + c.dur)}h`;
  const mardi = new Date(dateIso + 'T00:00:00Z').getUTCDay() === 2 && svcId === 'rec';
  const prix = mardi ? '15 000 F / h (tarif mardi 🔥)' : c.desc.split('·')[0].trim();
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: `📝 *RÉCAP DE TA RÉSA*\n\n🎙️ ${c.title}\n📅 ${frDate(dateIso)}\n⏰ ${pad2(h)}h — ${fin}\n💰 ${prix}\n\nOn valide ?`,
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `OK|${svcId}|${dateIso}|${h}`, title: '✅ Je confirme' } },
          { type: 'reply', reply: { id: `S|${svcId}`, title: '📅 Autre date' } },
          { type: 'reply', reply: { id: 'MENU', title: '❌ Annuler' } },
        ],
      },
    },
  });
}

async function confirmBooking(from, name, svcId, dateIso, hStr) {
  const c = CATALOG[svcId];
  if (!c) return await sendMainMenu(from, name);
  const h = parseInt(hStr, 10);

  // Re-check anti-collision juste avant d'écrire
  if (c.dur > 0) {
    const free = await freeStarts(svcId, dateIso);
    if (!free.includes(h)) {
      await sendText(from, '😕 Oups — ce créneau vient d\'être pris. Regarde les créneaux restants :');
      return await sendPeriods(from, svcId, dateIso);
    }
  }

  // Client : recherche par téléphone, sinon création avec le nom WhatsApp
  let clientId = null;
  try {
    const found = await airtable(
      `${airtableTable(TABLES.CLIENTS)}?filterByFormula=${encodeURIComponent(`{Téléphone} = '+${from}'`)}&maxRecords=1`,
      { method: 'GET' }
    );
    if (found.records?.length) clientId = found.records[0].id;
    else {
      const created = await airtable(`${airtableTable(TABLES.CLIENTS)}`, {
        method: 'POST',
        body: JSON.stringify({
          fields: { 'Nom complet': name, 'Téléphone': `+${from}`, 'Tier': 'Bronze', 'Points actifs': 1, 'Séances totales': 1 },
          typecast: true,
        }),
      });
      clientId = created.id;
    }
  } catch (e) { console.error('[wa-booking] client error:', e.message); }

  const ref = `MEL-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  try {
    await airtable(`${airtableTable(TABLES.RESERVATIONS)}`, {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          'Référence': ref,
          'Date': dateIso,
          'Heure début': `${pad2(h)}:00`,
          'Durée (h)': c.dur || 1,
          'Service': mapService(c.svc),
          'Statut': 'En attente',
          ...(clientId ? { 'Client': [clientId] } : {}),
          'Notes': `Réservé via WhatsApp bot · ${name} · +${from}`,
        },
        typecast: true,
      }),
    });
  } catch (e) {
    console.error('[wa-booking] reservation error:', e.message);
    return await sendText(from, '😕 Petit souci technique de notre côté. Écris-nous directement, on te cale ça : +225 07 03 38 77 38');
  }

  await sendWhatsApp(
    `🎙️ RÉSA WHATSAPP BOT\n${name} (+${from})\n${c.title} — ${frDate(dateIso)} à ${pad2(h)}h (${c.dur || '0.5'}h)\n[${ref}]`
  ).catch(() => {});

  return await sendText(from,
    `✅ *C'est noté ${name} !*\n\n` +
    `🎙️ ${c.title}\n📅 ${frDate(dateIso)} à ${pad2(h)}h\n🔖 Réf : *${ref}*\n\n` +
    `On te confirme sous 24h. Ton créneau est bloqué en attendant 👌\n\n` +
    `🎁 Pense à ta carte fidélité (1 séance offerte toutes les 5 résas) :\nhttps://melodiastudio.pro/pages/fidelite.html`
  );
}

// ---------- Helpers réservation ----------
async function fetchOccupied(dateIso) {
  try {
    const res = await fetch(`https://melodiastudio.pro/api/get-availability?date=${dateIso}`);
    const data = await res.json();
    return data.occupied || [];
  } catch { return []; }
}

async function freeStarts(svcId, dateIso) {
  const c = CATALOG[svcId];
  const occupied = await fetchOccupied(dateIso);
  const OPEN = 9, CLOSE = 21;
  const out = [];
  for (let start = OPEN; start + c.dur <= CLOSE; start++) {
    if (!overlaps(start * 60, (start + c.dur) * 60, occupied)) out.push(start);
  }
  return out;
}

function overlaps(startMin, endMin, occupied) {
  return (occupied || []).some((o) => startMin < o.end && endMin > o.start);
}

async function noSlots(from, svcId, dateIso) {
  await sendText(from, `😕 Plus aucun créneau libre le ${frDate(dateIso)}. Essaie un autre jour :`);
  return await sendDates(from, svcId);
}

function frDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return `${JOURS[d.getUTCDay()]} ${d.getUTCDate()} ${MOIS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// =====================================================
// Wrappers API Meta
// =====================================================
async function sendText(to, body) {
  return await callMeta(to, { type: 'text', text: { body, preview_url: true } });
}

async function callMeta(to, payload) {
  // Si YCloud est configuré → on envoie via YCloud (transport de prod).
  if (process.env.YCLOUD_API_KEY) return await callYCloud(to, payload);

  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token) {
    console.error('[whatsapp] missing PHONE_ID or ACCESS_TOKEN');
    return null;
  }
  try {
    const res = await fetch(`${META_API}/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        ...payload,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error('[whatsapp] meta error:', res.status, data);
    return data;
  } catch (e) {
    console.error('[whatsapp] callMeta failed:', e.message);
    return null;
  }
}

// Envoi via YCloud — POST /v2/whatsapp/messages.
// Le contenu (type/text/interactive/location) est identique à Meta ;
// YCloud attend juste `from` (numéro studio E.164) + `to` + `X-API-Key`.
async function callYCloud(to, payload) {
  const apiKey = process.env.YCLOUD_API_KEY;
  const from = process.env.YCLOUD_FROM || '2250703387738';
  if (!apiKey) {
    console.error('[ycloud] missing YCLOUD_API_KEY');
    return null;
  }
  try {
    const res = await fetch('https://api.ycloud.com/v2/whatsapp/messages', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error('[ycloud] error:', res.status, JSON.stringify(data));
    return data;
  } catch (e) {
    console.error('[ycloud] callYCloud failed:', e.message);
    return null;
  }
}

// =====================================================
// Helpers
// =====================================================
function validSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}
