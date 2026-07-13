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
            ...(it.date ? { 'Date': it.date } : {}),
            'Heure début': normalizeStartTime(it.slotTime),
            'Durée (h)': it.duration || 1,
            'Service': mapService(it.service),
            'Statut': 'En attente',
            'Client': client?.id ? [client.id] : undefined,
            'Acompte payé': false,
            'Notes': [details.project || '', it.express ? '⏳ Créneau à confirmer (offre promo à l’heure)' : ''].filter(Boolean).join(' · '),
          },
          typecast: true,
        }),
      });
      created.push({ id: record.id, ref });
    }

    // 3. Notif WhatsApp au Boss
    const fid = client._fidelite || {};
    const summary = formatSummary(details, items, created, fid);
    await sendWhatsApp(summary).catch(() => {});

    // Format un récap WhatsApp pour le client (à envoyer par lui via wa.me)
    const recapClient = formatRecapClient(details, items, created, fid);
    const studioPhone = (process.env.STUDIO_WHATSAPP || '2250703387738').replace(/\D/g, '');

    return jsonResponse(200, {
      ok: true,
      created,
      message: 'Demande enregistrée. On revient vers toi sous 24h.',
      fidelite: {
        tier: fid.tier || 'Bronze',
        tierBefore: fid.tierBefore,
        tierUpgraded: fid.tierBefore && fid.tier !== fid.tierBefore,
        pointsActifs: fid.pointsActifs || 0,
        seancesTotales: fid.seancesTotales || 0,
        sessionsOffertesDispo: fid.sessionsOffertesGagnees || 0,
        sessionUnlocked: !!fid.sessionUnlocked,
        remise: remiseForTier(fid.tier || 'Bronze'),
        progression: fid.progression || null,
        isNew: !!fid.isNew,
      },
      whatsapp: {
        url: `https://wa.me/${studioPhone}?text=${encodeURIComponent(recapClient)}`,
        recap: recapClient,
        studioPhone,
      },
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
      .filter(it => payload.express || it.planDate || it.date)
      .map(it => ({
        service: it.service,
        date: it.planDate || it.date || null,
        slotTime: it.planSlotTime || it.slotTime || '',
        duration: it.duration || 1,
        qty: it.qty || 1,
        price: it.price,
        express: !!payload.express && !(it.planDate || it.date),
      }));
  }
  // mode classic
  return [{
    service: payload.service,
    date: payload.date,
    slotTime: payload.slotTime || '',
    duration: payload.duration || 1,
    qty: 1,
    price: payload.price ?? undefined,
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
    if (found.records?.length) {
      // Client existant → MAJ fidélité (+1 point + recalcul tier)
      return await updateClientFidelite(found.records[0]);
    }
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
        'Tier': computeTier(1),
        'Points actifs': 1,
        'Séances totales': 1,
      },
      typecast: true,
    }),
  });
  // Attache une info fidélité au record retourné pour usage downstream
  created._fidelite = {
    tier: computeTier(1),
    pointsActifs: 1,
    seancesTotales: 1,
    isNew: true,
    sessionsOffertesDispo: 0,
    progression: progressionToNextTier(1),
  };
  return created;
}

async function updateClientFidelite(existingClient) {
  const current = existingClient.fields || {};
  const seancesTotales = (current['Séances totales'] || 0) + 1;
  const pointsActifs = ((current['Points actifs'] || 0) + 1);

  // Toutes les 5 séances → reset pointsActifs + débloque 1 séance offerte
  let pointsActifsFinal = pointsActifs;
  let sessionsOffertesGagnees = current['Sessions offertes gagnées'] || 0;
  if (pointsActifs >= 5) {
    pointsActifsFinal = 0;
    sessionsOffertesGagnees += 1;
  }

  const tier = computeTier(seancesTotales);

  const updated = await airtable(`${airtableTable(TABLES.CLIENTS)}/${existingClient.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fields: {
        'Tier': tier,
        'Points actifs': pointsActifsFinal,
        'Séances totales': seancesTotales,
      },
      typecast: true,
    }),
  });

  updated._fidelite = {
    tier,
    tierBefore: current['Tier'] || 'Bronze',
    pointsActifs: pointsActifsFinal,
    seancesTotales,
    sessionsOffertesGagnees,
    sessionUnlocked: pointsActifs >= 5,
    isNew: false,
    progression: progressionToNextTier(seancesTotales),
  };
  return updated;
}

function computeTier(seancesTotales) {
  if (seancesTotales >= 30) return 'Platinum';
  if (seancesTotales >= 15) return 'Gold';
  if (seancesTotales >= 5)  return 'Argent';
  return 'Bronze';
}

function progressionToNextTier(seancesTotales) {
  const thresholds = [
    { tier: 'Argent',   min: 5  },
    { tier: 'Gold',     min: 15 },
    { tier: 'Platinum', min: 30 },
  ];
  const next = thresholds.find(t => seancesTotales < t.min);
  if (!next) return { isMax: true };
  return {
    isMax: false,
    nextTier: next.tier,
    needed: next.min - seancesTotales,
  };
}

function remiseForTier(tier) {
  switch (tier) {
    case 'Argent':   return 5;
    case 'Gold':     return 10;
    case 'Platinum': return 15;
    default:         return 0;
  }
}

// Le front envoie le label du slot ("10h — 11h", "14h — 14h30"…) :
// on stocke une heure de début propre "HH:MM" pour que get-availability
// (et un humain dans Airtable) la lise sans ambiguïté.
function normalizeStartTime(str) {
  if (!str || typeof str !== 'string') return '';
  const m = str.match(/(\d{1,2})\s*(?:[h:](\d{2})?)?/);
  if (!m) return str;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2] || '0', 10);
  if (isNaN(h) || h < 0 || h > 23) return str;
  return `${String(h).padStart(2, '0')}:${String(isNaN(min) ? 0 : min).padStart(2, '0')}`;
}

function generateRef() {
  const d = new Date();
  const y = d.getFullYear().toString().slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MEL-${y}${m}${day}-${rand}`;
}

function formatRecapClient(details, items, created, fid) {
  const lines = [
    `🎙️ Salut Melodia, je viens de réserver en ligne :`,
    ``,
    `Nom : ${details.name}`,
    `Tél : ${details.phone}`,
  ];
  items.forEach((it, i) => {
    const refLine = created[i]?.ref ? ` [Réf: ${created[i].ref}]` : '';
    lines.push(`• ${mapService(it.service)} ${it.date ? 'le ' + it.date : '(créneau à confirmer)'}${it.slotTime ? ' à ' + it.slotTime : ''} (${it.duration}h)${refLine}`);
  });
  if (details.project) {
    lines.push(``);
    lines.push(`Mon projet : ${details.project.slice(0, 200)}`);
  }
  if (fid?.tier) {
    lines.push(``);
    if (fid.isNew) {
      lines.push(`🎉 J'ai aussi récupéré ma carte fidélité Bronze !`);
    } else if (fid.sessionUnlocked) {
      lines.push(`⭐ Je viens de débloquer une séance offerte ! Ma carte : ${fid.tier}.`);
    } else if (fid.tierUpgraded) {
      lines.push(`🎉 Je passe ${fid.tier} sur ma carte fidélité !`);
    }
  }
  lines.push(``);
  lines.push(`Merci de confirmer 🙏`);
  return lines.join('\n');
}

function formatSummary(details, items, created, fid) {
  const lines = [
    `🎙️ NOUVELLE RÉSERVATION MELODIA`,
    ``,
    `Client : ${details.name}`,
    `Tél : ${details.phone}`,
    `Email : ${details.email}`,
  ];
  if (fid) {
    if (fid.isNew) {
      lines.push(`✨ NOUVEAU CLIENT (carte Bronze créée, 1 point offert)`);
    } else {
      let line = `🎖️ Fidélité : ${fid.tier} · ${fid.seancesTotales} séances totales · ${fid.pointsActifs}/5 points actifs`;
      if (fid.sessionUnlocked) line += ` · ⭐ 1 SÉANCE OFFERTE DÉBLOQUÉE`;
      if (fid.tierBefore && fid.tier !== fid.tierBefore) line += ` · 🆙 PROMOTION ${fid.tierBefore} → ${fid.tier}`;
      lines.push(line);
    }
  }
  lines.push(``);
  lines.push(`Prestations :`);
  items.forEach((it, i) => {
    lines.push(`• ${mapService(it.service)} — ${it.date ? it.date + ' ' + (it.slotTime || '') : 'créneau à confirmer'} (${it.duration}h) [${created[i]?.ref || '?'}]`);
  });
  if (details.project) {
    lines.push(``);
    lines.push(`Projet : ${details.project.slice(0, 200)}`);
  }
  return lines.join('\n');
}
