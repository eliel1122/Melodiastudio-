// =====================================================
// POST /api/paystack-webhook
// Reçoit les événements Paystack. Sur `charge.success` :
//   - confirme la réservation (Confirmée si acompte, Soldée si total)
//   - marque l'acompte payé + calcule le solde
//   - notifie le Boss + confirme au client (WhatsApp si canal bot)
// =====================================================

const {
  airtable, airtableTable, TABLES,
  paystackValidSignature, sendWhatsApp,
} = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  // 1. Signature (HMAC SHA512)
  const sig = event.headers['x-paystack-signature'] || event.headers['X-Paystack-Signature'];
  if (!paystackValidSignature(event.body, sig)) {
    console.warn('[paystack] invalid signature');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try { payload = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Bad JSON' }; }

  // On répond 200 vite ; on ne traite que charge.success
  if (payload.event !== 'charge.success') {
    return { statusCode: 200, body: 'ignored' };
  }

  try {
    const data = payload.data || {};
    const meta = data.metadata || {};
    const ids = Array.isArray(meta.reservationIds) && meta.reservationIds.length
      ? meta.reservationIds
      : (meta.reservationId ? [meta.reservationId] : []);
    if (!ids.length) {
      console.warn('[paystack] no reservationId(s) in metadata');
      return { statusCode: 200, body: 'no-reservation' };
    }

    const choice = meta.choice === 'total' ? 'total' : 'acompte';
    const total = Number(meta.total) || 0;
    const paid = Number(meta.amountPaid) || 0;
    const solde = choice === 'total' ? 0 : Math.max(0, total - paid);
    const statut = choice === 'total' ? 'Soldée' : 'Confirmée';
    const payNote = `✅ ${choice === 'total' ? 'Payé en totalité' : 'Acompte payé'} ${paid} F (Paystack ${data.reference})`
      + (solde ? ` · solde ${solde} F à régler au studio` : ' · SOLDÉE');

    let alreadyDone = false;
    for (const rid of ids) {
      const existing = await airtable(
        `${airtableTable(TABLES.RESERVATIONS)}/${rid}`, { method: 'GET' }
      ).catch(() => null);
      const cur = existing?.fields?.['Statut'];
      if (cur === 'Confirmée' || cur === 'Soldée') { alreadyDone = true; continue; }
      const prevNotes = existing?.fields?.['Notes'] || '';
      await airtable(`${airtableTable(TABLES.RESERVATIONS)}/${rid}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fields: {
            'Statut': statut,
            'Acompte payé': true,
            'Mode paiement': `Paystack (${choice})`,
            'Notes': prevNotes.split('\n')[0].split(' · 💳')[0] + `\n${payNote}`,
          },
          typecast: true,
        }),
      });
    }
    // Idempotence : si toutes étaient déjà traitées, on ne re-notifie pas
    if (alreadyDone && ids.length === 1) return { statusCode: 200, body: 'already-processed' };

    // Notif Boss
    const summary =
      `💳 PAIEMENT REÇU — MELODIA\n` +
      `${meta.name || 'Client'} (${meta.phone || '—'})\n` +
      `${meta.service} · ${meta.date} ${meta.slotLabel || ''}\n` +
      `${choice === 'total' ? `Payé TOTAL ${paid} F` : `Acompte ${paid} F · solde ${solde} F au studio`}\n` +
      `Réf ${meta.ref || data.reference}`;
    await sendWhatsApp(summary).catch(() => {});

    // Confirmation automatique au client sur WhatsApp (site ET bot),
    // dès qu'on a un numéro exploitable.
    const wa = normalizePhone(meta.phone);
    if (wa) {
      const msg =
        `✅ *C'est confirmé !*\n\n` +
        `🎙️ ${meta.service}\n📅 ${meta.date} · ${meta.slotLabel || ''}\n` +
        `💳 ${choice === 'total' ? `Payé en totalité (${paid} F)` : `Acompte reçu : ${paid} F`}\n` +
        (solde ? `💰 Solde à régler au studio : *${solde} F*\n` : '') +
        `🔖 Réf : *${meta.ref || data.reference}*\n\n` +
        `Ton créneau est bloqué 👌 À très vite chez Melodia !\n\n` +
        `📱 Suis-nous :\n` +
        `📷 https://instagram.com/melodia.studi0\n` +
        `🎵 https://tiktok.com/@melodia.studi0\n` +
        `👍 https://www.facebook.com/904016509455383`;
      await sendYCloudText(wa, msg).catch(() => {});

      // QR "pass studio" (même cible que le reçu du site : Console Studio).
      // Uniquement pour les réfs Melodia (le endpoint /api/qr les valide).
      const ref = meta.ref || '';
      if (/^MEL-/i.test(ref)) {
        await sendYCloudImage(
          wa,
          `https://melodiastudio.pro/api/qr?ref=${encodeURIComponent(ref)}`,
          `🎫 Ton pass studio — présente ce QR à l'accueil (réf ${ref})`
        ).catch(() => {});
      }
    }

    return { statusCode: 200, body: 'OK' };
  } catch (e) {
    console.error('[paystack] handler error:', e);
    return { statusCode: 200, body: 'error-logged' };
  }
};

// Normalise un numéro ivoirien en format international sans "+".
// "+225 07 18 41 51 31" / "0718415131" / "2250718415131" → "2250718415131".
function normalizePhone(raw) {
  const d = (raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('225')) return d;               // déjà international
  if (d.length === 10 && d.startsWith('0')) return '225' + d; // local CI 10 chiffres
  if (d.length >= 8) return '225' + d;             // fallback
  return null;
}

// Envoi texte via YCloud (même transport que le bot)
async function sendYCloudText(to, body) {
  const apiKey = process.env.YCLOUD_API_KEY;
  const from = process.env.YCLOUD_FROM || '2250703387738';
  if (!apiKey) return null;
  try {
    await fetch('https://api.ycloud.com/v2/whatsapp/messages', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, type: 'text', text: { body } }),
    });
  } catch (e) { console.error('[paystack] ycloud send failed:', e.message); }
}

// Envoi image via YCloud (QR pass studio)
async function sendYCloudImage(to, link, caption) {
  const apiKey = process.env.YCLOUD_API_KEY;
  const from = process.env.YCLOUD_FROM || '2250703387738';
  if (!apiKey) return null;
  try {
    await fetch('https://api.ycloud.com/v2/whatsapp/messages', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, type: 'image', image: { link, caption } }),
    });
  } catch (e) { console.error('[paystack] ycloud image failed:', e.message); }
}
