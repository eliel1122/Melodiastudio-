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
  PRICES, depositFor, carteUrl,
  todayISO, promoHourActive, hourPrice,
} = require('./_lib');

const META_API = 'https://graph.facebook.com/v21.0';
const SITE = 'https://melodiastudio.pro';

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
  // NB : les clics de menu (listes/boutons) passent par routeAction. Ici = TEXTE tapé.
  // On ne répond automatiquement QUE pour : salutation/menu, tarifs, localisation, contact.
  // Tout le reste → pas de spam : on invite à laisser une note vocale (+ bouton menu).

  // Salutation / menu → affiche le menu (point d'entrée)
  if (/(^|\s)(menu|bonjour|bonsoir|salut|coucou|hello|hi|hey|start|commencer|d[ée]but)/i.test(text)) {
    return await sendMainMenu(from, name);
  }
  // Réservation -> relance le tunnel (fonction coeur du bot)
  if (/(r[ée]serv|rendez|rdv|cr[ée]neau|booking|s[ée]ance)/i.test(text)) {
    return await sendReserverFlow(from);
  }
  // Tarifs
  if (/(tarif|prix|combien|cout|coût|coute|coûte|prestation)/i.test(text)) {
    return await sendTarifs(from);
  }
  // Localisation
  if (/(adresse|localis|itin[ée]raire|google ?map|( |^)maps?( |$)|situ[ée]|comment (venir|y aller|aller)|c'?est o[uù]|o[uù] est|o[uù] [êe]tes|vous [êe]tes o[uù]|vous situez|venir au studio)/i.test(text)) {
    return await sendAdresse(from);
  }
  // Contact
  if (/(contact|joindre|num[ée]ro|t[ée]l[ée]phone|vous appeler|appeler|parler (a|à|avec)|un agent|agent|quelqu'?un|humain)/i.test(text)) {
    return await sendContact(from);
  }
  // Tout le reste → PAS de spam : note vocale + bouton menu, et on notifie le Boss du message.
  await sendWhatsApp(`💬 MESSAGE CLIENT (WhatsApp)\n${name} (+${from}) :\n${String(text).slice(0, 400)}`).catch(() => {});
  return await promptVoiceNote(from);
}

// Réponse quand l'intention n'est pas tarifs/localisation/contact : on n'envoie plus
// les infos au hasard, on invite à une note vocale (qu'un humain traitera) + bouton menu.
async function promptVoiceNote(from) {
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text:
        `🤖 Ici c'est le *bot de réservation* Melodia.\n\n` +
        `Pour une question ou une demande particulière, laisse-nous une *note vocale* 🎤 — un humain te répond vite.\n\n` +
        `Sinon, tout est dans le menu 👇` },
      action: { buttons: [
        { type: 'reply', reply: { id: 'MENU', title: '📋 Voir le menu' } },
      ]},
    },
  });
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
    case 'S':  return await sendDates(from, args[0], args[1]);
    case 'D':  return await sendPeriods(from, args[0], args[1]);
    case 'P':  return await sendSlots(from, args[0], args[1], args[2]);
    case 'T':  return await sendRecap(from, args[0], args[1], args[2]);
    case 'OK': return await confirmBooking(from, name, args[0], args[1], args[2]);
    // Paiement : PAYA = acompte, PAYT = total
    case 'PAYA': return await startPayment(from, name, args[0], args[1], args[2], 'acompte');
    case 'PAYT': return await startPayment(from, name, args[0], args[1], args[2], 'total');
  }

  switch (actionId) {
    case 'RESERVER':  return await sendReserverFlow(from, name);
    case 'TARIFS':    return await sendTarifs(from);
    case 'ADRESSE':   return await sendAdresse(from);
    case 'FIDELITE':  return await sendFidelite(from);
    case 'FID_CARTE': return await sendMaCarte(from, name);
    case 'FID_CREER': return await creerCarte(from, name);
    case 'VISITE':    return await sendVisiteMenu(from);
    case 'VVIRT':     return await sendVisiteVirtuelle(from);
    case 'VPHYS':     return await sendVisitePhysique(from);
    case 'DEVIS':     return await sendDevis(from, name);
    case 'RESEAUX':   return await sendReseaux(from);
    case 'CONTACT':   return await sendContact(from);
    case 'MENU':      return await sendMainMenu(from, name);
    case 'RECDUR':    return await sendDurationChoice(from);
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
      type: 'list',
      header: { type: 'text', text: '🎙️ Melodia Studio' },
      body: { text: `Salut ${name} ! Bienvenue chez Melodia. Qu'est-ce qui t'amène ?\n\nClique sur le bouton "Voir le menu" pour continuer 👇🏾\n\nSi vous voulez discuter avec un agent, veuillez laisser une note vocale, nous vous reviendrons sous peu` },
      footer: { text: 'Le studio des artistes qui montent · Abidjan' },
      action: {
        button: 'Voir le menu',
        sections: [
          { title: 'Réserver & tarifs', rows: [
            { id: 'RESERVER', title: '🎙️ Réserver une session', description: 'Bloque ton créneau en ligne' },
            { id: 'TARIFS',   title: '📋 Tarifs', description: 'Enregistrement, mix, master…' },
            { id: 'DEVIS',    title: '✍️ Devis / demande', description: 'Devis ou demande particulière' },
          ]},
          { title: 'Le studio', rows: [
            { id: 'FID_CARTE', title: '🎁 Ma carte fidélité', description: 'Points, statut, avantages' },
            { id: 'VISITE',    title: '👀 Visiter le studio', description: 'Virtuel ou sur place' },
            { id: 'ADRESSE',   title: '📍 Adresse & horaires', description: 'Cocody Riviera 4' },
          ]},
          { title: 'Rester connecté', rows: [
            { id: 'RESEAUX', title: '📱 Nous suivre', description: 'Instagram, TikTok, Facebook' },
            { id: 'CONTACT', title: '☎️ Contact', description: 'Téléphone, email' },
          ]},
        ],
      },
    },
  });
}

// ---- Fidélité ----
async function sendMaCarte(from, name) {
  const client = await findClientByPhone(from);
  if (!client) {
    return await callMeta(from, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: `🎁 *Carte fidélité Melodia*\n\nTu n'as pas encore de carte, ${name}. Crée-la gratuitement : 1 point offert, puis 1 séance offerte toutes les 5 réservations, et des remises qui montent (jusqu'à −15%).` },
        action: { buttons: [
          { type: 'reply', reply: { id: 'FID_CREER', title: '✅ Créer ma carte' } },
          { type: 'reply', reply: { id: 'MENU', title: '⬅️ Menu' } },
        ]},
      },
    });
  }
  const f = client.fields || {};
  const pts = f['Points actifs'] || 0;
  const offertes = (f['Sessions offertes gagnées'] || 0) - (f['Sessions offertes utilisées'] || 0);
  // Carte en PNG (rendue par /api/carte-fidelite), le détail est dessus
  return await callMeta(from, {
    type: 'image',
    image: {
      link: carteUrl(from),
      caption:
        `🎁 Ta carte fidélité Melodia\n` +
        (offertes > 0
          ? `🎉 ${offertes} séance${offertes > 1 ? 's' : ''} offerte${offertes > 1 ? 's' : ''} à utiliser — présente ta carte à l'accueil !`
          : `💪 Encore ${Math.max(0, 5 - pts)} point(s) et ta prochaine séance est OFFERTE.`) +
        `\n\n💳 Ta carte en ligne : https://melodiastudio.pro/pages/ma-carte.html`,
    },
  });
}

async function creerCarte(from, name) {
  const existing = await findClientByPhone(from);
  if (existing) return await sendMaCarte(from, name);
  try {
    await airtable(`${airtableTable(TABLES.CLIENTS)}`, {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          'Nom complet': name, 'Téléphone': `+${from}`,
          'Tier': 'Bronze', 'Points actifs': 1, 'Séances totales': 0,
        },
        typecast: true,
      }),
    });
  } catch (e) { console.error('[creerCarte]', e.message); }
  return await sendText(from,
    `🎉 *Bienvenue dans la Melodia Family, ${name} !*\n\n` +
    `Ta carte *Bronze* est créée avec *1 point offert* ⭐\n` +
    `Chaque réservation = +1 point. À 5 points, une séance offerte 🎁\n\n` +
    `Ta carte : https://melodiastudio.pro/pages/ma-carte.html`
  );
}

// ---- Visite ----
async function sendVisiteMenu(from) {
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '👀 Visiter Melodia' },
      body: { text: 'Tu veux découvrir le studio comment ?' },
      action: { buttons: [
        { type: 'reply', reply: { id: 'VVIRT', title: '🎬 Visite virtuelle' } },
        { type: 'reply', reply: { id: 'VPHYS', title: '🚶 Sur place' } },
        { type: 'reply', reply: { id: 'MENU', title: '⬅️ Menu' } },
      ]},
    },
  });
}
async function sendVisiteVirtuelle(from) {
  return await sendText(from,
    `🎬 *Visite virtuelle du studio*\n\n` +
    `Découvre la control room et la cabine en vidéo, plus tout notre matos :\n` +
    `👉 https://melodiastudio.pro/pages/studio.html\n\n` +
    `Quand tu veux le voir en vrai, tape *visiter* → sur place 🙌`
  );
}
async function sendVisitePhysique(from) {
  await sendAdresse(from);
  return await sendText(from,
    `🚶 *Passer au studio*\n\nOn te fait visiter avec plaisir ! Dis-nous quand tu veux passer (jour + heure) et on te confirme. Ou réserve direct ta session : tape *réserver* 🎙️`
  );
}

// ---- Devis ----
async function sendDevis(from, name) {
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text:
        `✍️ *Devis ou demande particulière*\n\n` +
        `Pour un projet spécifique (single, EP, album, clip, pub…) ou toute autre demande, laisse-nous une *note vocale* 🎤 avec les détails (type, nombre de titres, deadline, budget, références).\n\n` +
        `On t'envoie une proposition sous 24h 🤝` },
      action: { buttons: [
        { type: 'reply', reply: { id: 'RESERVER', title: '🎙️ Réserver' } },
        { type: 'reply', reply: { id: 'MENU', title: '⬅️ Menu' } },
      ]},
    },
  });
}

// ---- Réseaux ----
async function sendReseaux(from) {
  return await sendText(from,
    `📱 *Suis Melodia Studio*\n\n` +
    `📷 Instagram : https://instagram.com/melodia.studi0\n` +
    `🎵 TikTok : https://tiktok.com/@melodia.studi0\n` +
    `👍 Facebook : https://www.facebook.com/904016509455383\n\n` +
    `Sessions, coulisses, artistes qui montent 🔥`
  );
}

// Recherche un client Airtable par son numéro WhatsApp (from = wa_id sans +).
async function findClientByPhone(from) {
  const last8 = from.replace(/\D/g, '').slice(-8);
  const filter = `OR(FIND('${last8}', {Téléphone}), {Téléphone} = '+${from}')`;
  const found = await airtable(
    `${airtableTable(TABLES.CLIENTS)}?filterByFormula=${encodeURIComponent(filter)}&maxRecords=1`,
    { method: 'GET' }
  ).catch(() => ({ records: [] }));
  return found.records?.[0] || null;
}

async function sendTarifs(from) {
  const promo = promoHourActive(todayISO());
  const txt = [
    '*📋 TARIFS MELODIA STUDIO*',
    '',
    ...(promo ? ['🔥 *PROMO ÉTÉ* — l\'heure de studio à 15 000 F jusqu\'au 15 août !', ''] : []),
    '*🎙️ ENREGISTREMENT*',
    '',
    '*À l\'heure — prise de voix / maquette*',
    promo ? '15 000 FCFA 🔥 (au lieu de 25 000)' : '25 000 FCFA',
    '',
    '*Pack Silver — prise de voix*',
    '2h + pré-mix + photos · 40 000 FCFA',
    '',
    '*Pack Gold — semi-fini*',
    '2h + mix + photos + cover · 180 000 FCFA',
    '',
    '*Pack Platinium — produit fini*',
    'tout inclus · 280 000 FCFA',
    '',
    '*🎚️ MIX & MASTER*',
    '',
    '*Mix*',
    '150 000 FCFA / titre',
    '',
    '*Mastering*',
    '75 000 FCFA / titre',
    '',
    '*Mix + Master*',
    '200 000 FCFA / titre',
    '',
    '*🎹 AUTRES*',
    '',
    '*Production beat*',
    'dès 100 000 FCFA',
    '',
    '*Voice-over*',
    '40 000 FCFA / h',
    '',
    '*Location studio* _(tu ramènes ton ingé)_',
    'dès 35 000 FCFA / h',
    '',
    '*Tournage clip / Podcast*',
    'dès 30 000 FCFA / h',
    '',
    '*Direction artistique*',
    'sur devis',
    '',
    '🔗 Détails : https://melodiastudio.pro/pages/tarifs.html',
  ].join('\n');
  await sendText(from, txt);
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Prêt à bloquer ta session ? 🎙️' },
      action: { buttons: [
        { type: 'reply', reply: { id: 'RESERVER', title: '🎙️ Réserver' } },
        { type: 'reply', reply: { id: 'MENU', title: '⬅️ Menu' } },
      ]},
    },
  });
}

async function sendAdresse(from) {
  await callMeta(from, {
    type: 'location',
    location: {
      latitude: 5.3294,
      longitude: -3.9531,
      name: 'Melodia Studio',
      address: 'Cocody Riviera 4 M\'pouto - La harpe mélodieuse',
    },
  });
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text:
        '📍 *Melodia Studio*\nCocody Riviera 4 M\'pouto\nLa harpe mélodieuse\nPlus Code : 82HW+W6 Abidjan\n\n' +
        '🗺️ Google Maps : https://www.google.com/maps?q=82HW%2BW6+Abidjan\n\n' +
        '⏰ Lun—Sam : 10h-00h · Dim : sur RDV' },
      action: { buttons: [
        { type: 'reply', reply: { id: 'RESERVER', title: '🎙️ Réserver' } },
        { type: 'reply', reply: { id: 'MENU', title: '⬅️ Menu' } },
      ]},
    },
  });
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
    // Numéro du studio uniquement — JAMAIS le numéro perso du Boss
    '📱 WhatsApp / Téléphone : +225 07 03 38 77 38\n' +
    '📞 Tu peux nous *appeler directement* (appel classique ou appel WhatsApp)\n' +
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
  rec:       { title: 'Enregistrement — 1h',    dur: 1, desc: '25 000 F/h · 15 000 F le mardi', svc: 'rec' },
  rec2:      { title: 'Enregistrement — 2h',    dur: 2, desc: '2h de studio', svc: 'rec' },
  rec3:      { title: 'Enregistrement — 3h',    dur: 3, desc: '3h de studio', svc: 'rec' },
  silver:    { title: 'Pack Silver',            dur: 2, desc: '40 000 F · 2h + pré-mix + photos', svc: 'pack-silver' },
  gold:      { title: 'Pack Gold',              dur: 2, desc: '180 000 F · 2h + mix + photos + cover', svc: 'pack-gold' },
  platinium: { title: 'Pack Platinium',         dur: 2, desc: '280 000 F · tout inclus', svc: 'pack-platinium' },
  jam:       { title: 'Répétitions / jam',      dur: 2, desc: 'Session live · tarif confirmé par le studio', svc: 'Répétitions / jam session' },
  vo:        { title: 'Voice-over',             dur: 1, desc: '40 000 F / h', svc: 'vo' },
  mix:       { title: 'Mix',                    dur: 0, desc: '150 000 F / titre · RDV 30min', svc: 'mix' },
  master:    { title: 'Mastering',              dur: 0, desc: '75 000 F / titre · RDV 30min', svc: 'master' },
  prod:      { title: 'Production beat',        dur: 0, desc: 'Dès 100 000 F · RDV 30min', svc: 'prod' },
  da:        { title: 'Direction artistique',   dur: 0, desc: 'Sur devis · RDV 30min', svc: 'da' },
};
const RDV_HOURS = [10, 14, 17]; // RDV 30min pour mix/master/prod/da
const JOURS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const MOIS = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];

async function sendReserverFlow(from) {
  const promo = promoHourActive(todayISO());
  const row = (id) => ({
    id: `S|${id}`,
    title: CATALOG[id].title,
    description: CATALOG[id].desc,
  });
  // Enregistrement à l'heure : une seule ligne, puis choix de la durée (1h/2h/3h).
  const recRow = {
    id: 'RECDUR',
    title: 'Enregistrement (heure)',
    description: promo ? '🔥 15 000 F/h · 1h, 2h ou 3h' : '25 000 F/h · 1h, 2h ou 3h',
  };
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
          { title: '🎙️ Studio', rows: [recRow, row('silver'), row('gold'), row('platinium'), row('jam'), row('vo')] },
          { title: '🎚️ Prod & post-prod', rows: ['mix', 'master', 'prod', 'da'].map(row) },
        ],
      },
    },
  });
}

// Choix de la durée pour l'enregistrement à l'heure (même acompte 2 500 F).
async function sendDurationChoice(from) {
  const promo = promoHourActive(todayISO());
  return await callMeta(from, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text:
        `🎙️ *Enregistrement à l'heure*\n\n` +
        `Tu veux réserver combien de temps ?${promo ? '\n🔥 Promo été : 15 000 F / h' : ''}\n\n` +
        `_Acompte de 2 500 F quelle que soit la durée._` },
      action: { buttons: [
        { type: 'reply', reply: { id: 'S|rec', title: '1 heure' } },
        { type: 'reply', reply: { id: 'S|rec2', title: '2 heures' } },
        { type: 'reply', reply: { id: 'S|rec3', title: '3 heures' } },
      ]},
    },
  });
}

async function sendDates(from, svcId, pageArg) {
  const c = CATALOG[svcId];
  if (!c) return await sendMainMenu(from, 'là');
  // 30 jours proposés (~1 mois). WhatsApp limite une liste à 10 lignes,
  // donc pagination : 9 dates en page 0 (+ "Jours suivants"), 8 dates sur les
  // pages du milieu (+ "Précédents"/"Suivants"), le reste sur la dernière.
  const TOTAL_DAYS = 30;
  const allRows = [];
  const now = new Date();
  // Aujourd'hui inclus seulement avant 18h ; sinon on démarre demain
  const startOffset = now.getUTCHours() < 18 ? 0 : 1;
  for (let i = startOffset; allRows.length < TOTAL_DAYS; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    const label = `${JOURS[dow]} ${d.getUTCDate()} ${MOIS[d.getUTCMonth()]}`;
    const isToday = i === 0;
    // rec : 15 000 F / h si promo été (toutes dates ≤ 15 août) ou mardi.
    const promo15 = svcId === 'rec' && (promoHourActive(iso) || dow === 2);
    allRows.push({
      id: `D|${svcId}|${iso}`,
      title: isToday ? 'Aujourd\'hui' : label,
      description: promo15
        ? (isToday ? `${label} · 🔥 15 000 F/h` : '🔥 15 000 F / h')
        : (isToday ? label : undefined),
    });
  }
  let page = Math.max(0, parseInt(pageArg, 10) || 0);
  let first = page === 0 ? 0 : 9 + (page - 1) * 8;
  if (first >= allRows.length) { page = 0; first = 0; } // page hors limites → retour au début
  const slice = allRows.slice(first, first + (page === 0 ? 9 : 8));
  const rows = [...slice];
  if (page > 0) {
    rows.unshift({ id: `S|${svcId}|${page - 1}`, title: '⬅️ Jours précédents', description: 'Revenir en arrière' });
  }
  if (first + slice.length < allRows.length) {
    const nextTitle = allRows[first + slice.length].title;
    rows.push({ id: `S|${svcId}|${page + 1}`, title: '➡️ Jours suivants', description: `À partir de ${nextTitle}` });
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
    title: `${pad2(h)}h — ${h + c.dur === 24 ? '00' : pad2(h + c.dur)}h`,
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

// Prix total d'un service du catalogue (F CFA). Pour l'heure de studio (rec),
// hourPrice() applique la promo été (15 000 F jusqu'au 15 août) et le tarif mardi.
function totalForCatalog(svcId, dateIso) {
  const c = CATALOG[svcId];
  if (!c) return 0;
  if (c.svc === 'rec') return hourPrice(dateIso) * (c.dur || 1);
  return PRICES[c.svc] || 0;
}

async function sendRecap(from, svcId, dateIso, hStr) {
  const c = CATALOG[svcId];
  if (!c) return await sendMainMenu(from, 'là');
  const h = parseInt(hStr, 10);
  const fin = c.dur === 0 ? `${pad2(h)}h30` : `${pad2(h + c.dur)}h`;
  const total = totalForCatalog(svcId, dateIso);
  const dep = Math.min(depositFor(c.svc), total || depositFor(c.svc));
  const solde = Math.max(0, total - dep);
  const promoTag = (c.svc === 'rec' && promoHourActive(dateIso)) ? ' 🔥 _promo été_' : '';
  const prixTxt = total ? `${total.toLocaleString('fr-FR').replace(/,/g, ' ')} F${promoTag}` : 'sur devis';

  // Prix connu → paiement en ligne (acompte / total). Sinon confirmation simple.
  const buttons = total > 0
    ? [
        { type: 'reply', reply: { id: `PAYA|${svcId}|${dateIso}|${h}`, title: `💳 Acompte ${dep} F` } },
        { type: 'reply', reply: { id: `PAYT|${svcId}|${dateIso}|${h}`, title: `💳 Payer ${total} F` } },
        { type: 'reply', reply: { id: 'MENU', title: '❌ Annuler' } },
      ]
    : [
        { type: 'reply', reply: { id: `OK|${svcId}|${dateIso}|${h}`, title: '✅ Je confirme' } },
        { type: 'reply', reply: { id: `S|${svcId}`, title: '📅 Autre date' } },
        { type: 'reply', reply: { id: 'MENU', title: '❌ Annuler' } },
      ];

  const bodyTxt =
    `📝 *RÉCAP DE TA RÉSA*\n\n🎙️ ${c.title}\n📅 ${frDate(dateIso)}\n⏰ ${pad2(h)}h — ${fin}\n💰 ${prixTxt}\n\n` +
    (total > 0
      ? `Bloque ton créneau :\n• *Acompte ${dep} F* _(non remboursable)_ — solde ${solde} F au studio\n• ou *paie tout* maintenant\n\n⚠️ L'acompte confirme ta venue : il n'est pas remboursé en cas d'absence.\n\n🔒 Paiement 100% sécurisé. Un doute ? Appelle le studio au 07 03 38 77 38 avant de payer — on répond.`
      : `On valide ?`);

  return await callMeta(from, {
    type: 'interactive',
    interactive: { type: 'button', body: { text: bodyTxt }, action: { buttons } },
  });
}

// Lance le paiement Paystack et envoie le lien au client.
async function startPayment(from, name, svcId, dateIso, hStr, choice) {
  const c = CATALOG[svcId];
  if (!c) return await sendMainMenu(from, name);
  const h = parseInt(hStr, 10);
  const total = totalForCatalog(svcId, dateIso);
  if (total <= 0) return await confirmBooking(from, name, svcId, dateIso, hStr);

  // Anti-collision juste avant de bloquer
  if (c.dur > 0) {
    const free = await freeStarts(svcId, dateIso);
    if (!free.includes(h)) {
      await sendText(from, '😕 Ce créneau vient d\'être pris. Voici les créneaux restants :');
      return await sendPeriods(from, svcId, dateIso);
    }
  }

  try {
    const res = await fetch(`${SITE}/api/create-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'whatsapp',
        service: c.svc,
        date: dateIso,
        slotTime: `${pad2(h)}:00`,
        slotLabel: `${pad2(h)}h — ${c.dur === 0 ? pad2(h) + 'h30' : (h + c.dur === 24 ? '00' : pad2(h + c.dur)) + 'h'}`,
        duration: c.dur || 1,
        choice,
        price: total,
        details: { name, phone: `+${from}` },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok || !data.authorization_url) throw new Error(data.error || 'init paiement');

    const montant = choice === 'total' ? data.total : data.deposit;
    return await sendText(from,
      `💳 *Paiement pour bloquer ta session*\n\n` +
      `${c.title} · ${frDate(dateIso)} à ${pad2(h)}h\n` +
      `Montant : *${montant.toLocaleString('fr-FR').replace(/,/g, ' ')} F*` +
      (choice === 'acompte' && data.solde ? ` (acompte non remboursable · solde ${data.solde} F au studio)` : '') +
      `\n\n👉 Paie ici (carte, Orange Money, Wave, MTN) :\n${data.authorization_url}\n\n` +
      `Dès que c'est payé, tu reçois ta confirmation ici. Le créneau est gardé 5 min ⏳\n\n` +
      `🔒 *Paiement 100% sécurisé* (Paystack). Le moindre doute ? Tu peux exiger de parler à un agent du studio au *+225 07 03 38 77 38* — même en visio — *avant* de payer 1 franc. On préfère ça à un client qui hésite.`
    );
  } catch (e) {
    console.error('[wa-payment] error:', e.message);
    return await sendText(from, '😕 Souci technique pour le paiement. Écris-nous : +225 07 03 38 77 38');
  }
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
  const OPEN = 10, CLOSE = 24; // studio 10h–00h (minuit)
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
