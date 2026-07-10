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
  airtable, airtableTable, TABLES, mapService,
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
// Routing des messages entrants
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

async function sendReserverFlow(from, name) {
  // Phase initiale : on dirige vers le site (le WhatsApp Flow sera ajouté ensuite)
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: `🎙️ *RÉSERVER UNE SESSION*\n\nTu peux soit réserver direct sur le site (créneaux dispos en temps réel), soit nous dire ici quel service / date / heure tu veux et on te confirme sous 24h.`,
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'TARIFS',  title: '📋 Voir les tarifs' } },
          { type: 'reply', reply: { id: 'MENU',    title: '⬅️ Retour' } },
        ],
      },
    },
  });
}

// =====================================================
// Wrappers API Meta
// =====================================================
async function sendText(to, body) {
  return await callMeta(to, { type: 'text', text: { body, preview_url: true } });
}

async function callMeta(to, payload) {
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
