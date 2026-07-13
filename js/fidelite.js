/* =====================================================
   MELODIA FIDÉLITÉ — Core logic
   - Storage : localStorage (MVP, à migrer vers backend)
   - Tiers   : Bronze → Argent → Gold → Platinum
   - Points  : 1 séance offerte toutes les 5 réservations
   ===================================================== */

(function (window) {
  'use strict';

  const STORAGE_KEY = 'melodia_client';
  const STORAGE_VISITS = 'melodia_visits';
  const STORAGE_POPUP_SHOWN = 'melodia_popup_shown';
  const STORAGE_ADMIN_PIN = 'melodia_admin_pin';
  const DEFAULT_ADMIN_PIN = '2024'; // À changer par le Boss

  // ============ TIERS DEFINITION ============
  const TIERS = {
    bronze: {
      key: 'bronze',
      name: 'Bronze',
      color: '#CD7F32',
      min: 0,
      max: 4,
      remise: 0,
      tagline: 'Bienvenue dans la family',
      benefits: [
        { icon: '01', html: '<b>1 séance offerte</b> toutes les 5 réservations' },
        { icon: '02', html: '<b>1 point offert</b> à l\'inscription' },
        { icon: '03', html: 'Accès à la <b>newsletter Melodia</b>' },
        { icon: '04', html: 'Carte digitale <b>QR</b> scannable au studio' }
      ]
    },
    argent: {
      key: 'argent',
      name: 'Argent',
      color: '#B8C5D6',
      min: 5,
      max: 14,
      remise: 5,
      tagline: 'Tu fais partie des réguliers',
      benefits: [
        { icon: '01', html: '<b>−5%</b> sur tous les services à la carte' },
        { icon: '02', html: '<b>1 séance offerte</b> toutes les 5' },
        { icon: '03', html: 'Accès <b>playlist privée Spotify "Made at Melodia"</b>' },
        { icon: '04', html: '<b>Réservation prioritaire</b> créneaux week-end (annonce 48h avant)' },
        { icon: '05', html: 'Invitation aux <b>écoutes privées</b> mensuelles' }
      ]
    },
    gold: {
      key: 'gold',
      name: 'Gold',
      color: '#E5B544',
      min: 15,
      max: 29,
      remise: 10,
      tagline: 'Tu as le son de la maison',
      benefits: [
        { icon: '01', html: '<b>−10%</b> sur tous les services et packs' },
        { icon: '02', html: '<b>1 cover art offert par an</b> (valeur 30 000 FCFA)' },
        { icon: '03', html: '<b>Mastering livré en 24h</b> max' },
        { icon: '04', html: 'Invitation à la <b>soirée studio annuelle</b> Melodia (+1 invité)' },
        { icon: '05', html: 'Apparition possible sur la <b>playlist hero "Made at Melodia"</b>' },
        { icon: '06', html: 'Tous les avantages <b>Argent</b> inclus' }
      ]
    },
    platinum: {
      key: 'platinum',
      name: 'Platinum',
      color: '#E5E4E2',
      min: 30,
      max: Infinity,
      remise: 15,
      tagline: 'Tu fais l\'histoire avec nous',
      benefits: [
        { icon: '01', html: '<b>−15%</b> sur tous les services et packs' },
        { icon: '02', html: '<b>1 session studio entière offerte chaque année</b> (jusqu\'à 200 000 FCFA)' },
        { icon: '03', html: '<b>Cover art + visualizer AI offerts</b> à chaque album sorti' },
        { icon: '04', html: 'Possibilité de <b>featuring sur compilation Melodia</b> annuelle' },
        { icon: '05', html: '<b>Contact direct fondateur</b> (WhatsApp privé, hors horaires)' },
        { icon: '06', html: 'Invitations <b>VIP événements Melodia</b> + accès backstage' },
        { icon: '07', html: 'Tous les avantages <b>Gold</b> inclus' }
      ]
    }
  };

  function getTier(seancesTotales) {
    if (seancesTotales >= 30) return TIERS.platinum;
    if (seancesTotales >= 15) return TIERS.gold;
    if (seancesTotales >= 5)  return TIERS.argent;
    return TIERS.bronze;
  }

  function getNextTier(currentTier) {
    if (currentTier.key === 'bronze') return TIERS.argent;
    if (currentTier.key === 'argent') return TIERS.gold;
    if (currentTier.key === 'gold')   return TIERS.platinum;
    return null;
  }

  // ============ UUID GENERATION ============
  function generateUUID() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function shortId(uuid) {
    return 'MEL-' + uuid.replace(/-/g, '').substring(0, 8).toUpperCase();
  }

  // ============ CLIENT STORAGE ============
  function getClient() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveClient(client) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(client));
    return client;
  }

  function createClient(data) {
    const uuid = generateUUID();
    const now = new Date().toISOString();
    const client = {
      id: uuid,
      shortId: shortId(uuid),
      firstName: data.firstName.trim(),
      lastName: data.lastName.trim(),
      phone: (data.phone || '').trim(),
      email: (data.email || '').trim(),
      instagram: (data.instagram || '').trim(),
      pointsActifs: 1,           // 1 point offert à l'inscription
      seancesTotales: 1,         // Compté dans le tier (passage automatique)
      sessionsOffertesGagnees: 0,
      sessionsOffertesUtilisees: 0,
      history: [{
        date: now,
        type: 'INSCRIPTION',
        delta: +1,
        note: 'Point offert à l\'inscription en ligne'
      }],
      createdAt: now,
      updatedAt: now,
      version: 1
    };
    saveClient(client);
    return client;
  }

  // ============ POINTS LOGIC ============
  function addPoint(client, note) {
    client.pointsActifs += 1;
    client.seancesTotales += 1;
    // Toutes les 5 séances → 1 offerte débloquée + reset compteur actif
    if (client.pointsActifs >= 5) {
      client.pointsActifs = 0;
      client.sessionsOffertesGagnees += 1;
    }
    client.history.unshift({
      date: new Date().toISOString(),
      type: 'POINT_ADD',
      delta: +1,
      note: note || 'Séance enregistrée'
    });
    client.updatedAt = new Date().toISOString();
    saveClient(client);
    return client;
  }

  function removePoint(client, note) {
    if (client.pointsActifs > 0) {
      client.pointsActifs -= 1;
      client.seancesTotales = Math.max(0, client.seancesTotales - 1);
    } else if (client.sessionsOffertesGagnees > 0) {
      // Annule la dernière séance offerte gagnée
      client.sessionsOffertesGagnees -= 1;
      client.pointsActifs = 4;
      client.seancesTotales = Math.max(0, client.seancesTotales - 1);
    }
    client.history.unshift({
      date: new Date().toISOString(),
      type: 'POINT_REMOVE',
      delta: -1,
      note: note || 'Annulation séance'
    });
    client.updatedAt = new Date().toISOString();
    saveClient(client);
    return client;
  }

  function useFreeSession(client, note) {
    if (client.sessionsOffertesGagnees > client.sessionsOffertesUtilisees) {
      client.sessionsOffertesUtilisees += 1;
      client.history.unshift({
        date: new Date().toISOString(),
        type: 'FREE_SESSION_USED',
        delta: -0,
        note: note || 'Séance offerte utilisée'
      });
      client.updatedAt = new Date().toISOString();
      saveClient(client);
    }
    return client;
  }

  function freeSessionsAvailable(client) {
    return client.sessionsOffertesGagnees - client.sessionsOffertesUtilisees;
  }

  // ============ VISITS / POPUP ============
  function incrementVisits() {
    const count = parseInt(localStorage.getItem(STORAGE_VISITS) || '0', 10);
    const next = count + 1;
    localStorage.setItem(STORAGE_VISITS, String(next));
    return next;
  }

  function shouldShowFirstVisitPopup() {
    if (getClient()) return false; // déjà membre
    if (localStorage.getItem(STORAGE_POPUP_SHOWN) === '1') return false;
    return true;
  }

  function markPopupShown() {
    localStorage.setItem(STORAGE_POPUP_SHOWN, '1');
  }

  // ============ ADMIN ============
  function getAdminPin() {
    return localStorage.getItem(STORAGE_ADMIN_PIN) || DEFAULT_ADMIN_PIN;
  }
  function setAdminPin(pin) {
    localStorage.setItem(STORAGE_ADMIN_PIN, pin);
  }
  function checkAdminPin(pin) {
    return pin === getAdminPin();
  }

  // ============ QR CODE URL ============
  function getCardUrl(client) {
    // Le QR ouvre la Console Studio sur la fiche fidélité du client (par téléphone).
    const phone = encodeURIComponent(client.phone || '');
    return `https://melodiastudio.pro/pages/console.html?type=fidelity&phone=${phone}`;
  }

  // ============ RENDER HELPERS ============
  function renderCardHTML(client, opts) {
    opts = opts || {};
    const tier = getTier(client.seancesTotales);
    const fullName = `${client.firstName} ${client.lastName}`;
    const memberSince = formatMonthYear(client.createdAt);

    const dots = [];
    for (let i = 1; i <= 4; i++) {
      const filled = i <= client.pointsActifs;
      dots.push(`<div class="mlc-dot ${filled ? 'filled' : ''}">${i}</div>`);
    }
    dots.push('<div class="mlc-dot reward">★</div>');

    return `
      <div class="mlc-card ${tier.key}">
        <span class="tier-bar"></span>
        <div class="mlc-header">
          <div class="mlc-brand">
            <img src="${opts.logoPath || '../assets/images/melodia-logo-trim.png'}" alt="Melodia">
            <span class="program">// MELODIA FIDÉLITÉ</span>
          </div>
          <div class="mlc-tier">
            <div class="lbl">// NIVEAU</div>
            <div class="name">${tier.name}</div>
          </div>
        </div>
        <div class="mlc-middle">
          <div class="mlc-name">${fullName}</div>
          <div class="mlc-id">ID · <b>${client.shortId}</b> · MEMBRE DEPUIS ${memberSince}</div>
        </div>
        <div class="mlc-qr">
          <div class="mlc-qr-frame" id="${opts.qrTargetId || 'mlc-qr-target'}"></div>
          <div class="mlc-qr-label">RÉSERVÉ<br>AU STAFF</div>
        </div>
        <div class="mlc-points">
          <div class="mlc-points-meta">
            <span class="lbl">// POINTS</span>
            <span class="val">${client.pointsActifs} / 5 SÉANCES</span>
          </div>
          <div class="mlc-points-dots">${dots.join('')}</div>
        </div>
      </div>
    `;
  }

  function renderQRInto(elementId, url) {
    const el = document.getElementById(elementId);
    if (!el || !window.QRCode) return;
    el.innerHTML = '';
    new QRCode(el, {
      text: url,
      width: 100,
      height: 100,
      colorDark: '#08080C',
      colorLight: '#FFFFFF',
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  function formatMonthYear(iso) {
    const d = new Date(iso);
    return ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear();
  }

  function formatDateTime(iso) {
    const d = new Date(iso);
    const pad = n => ('0' + n).slice(-2);
    return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ============ EXPORT ============
  window.MelodiaFidelite = {
    TIERS,
    getTier,
    getNextTier,
    generateUUID,
    shortId,
    getClient,
    saveClient,
    createClient,
    addPoint,
    removePoint,
    useFreeSession,
    freeSessionsAvailable,
    incrementVisits,
    shouldShowFirstVisitPopup,
    markPopupShown,
    getAdminPin,
    setAdminPin,
    checkAdminPin,
    getCardUrl,
    renderCardHTML,
    renderQRInto,
    formatMonthYear,
    formatDateTime,
    // Storage keys exposés pour debug
    _keys: { STORAGE_KEY, STORAGE_VISITS, STORAGE_POPUP_SHOWN, STORAGE_ADMIN_PIN }
  };
})(window);
