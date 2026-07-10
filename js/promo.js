/* =========================================================
   MELODIA STUDIO — PROMOTIONS
   Config centralisée + bannière home + cohérence prix + express booking.
   Pour changer/ajouter une promo : édite le tableau PROMOS ci-dessous.
   Une promo est visible/active si la date du jour est dans [start, end].
   Preview forcé (hors dates) : ajoute ?promo=preview à l'URL.
   ========================================================= */
(function () {
  'use strict';

  const PROMOS = [
    {
      id: 'ete-heure-2026',
      start: '2026-07-15',
      end: '2026-08-15',
      // cible
      serviceId: 'rec',
      serviceName: 'Enregistrement',
      optionId: 'hour',
      option: "À l'heure",
      duration: 1,
      itemId: 'rec-hour',            // = `${serviceId}-${optionId}` (id panier)
      oldPrice: 25000,
      newPrice: 15000,
      percent: 40,
      // habillage bannière
      eyebrow: 'Offre été',
      headline: "Session à l'heure à 15 000 F",
      sub: 'jusqu’au 15 août',
      cta: "J'en profite",
    },
  ];

  const DAY = 86400000;
  const parse = (s) => new Date(s + 'T00:00:00');
  const params = () => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(); } };
  // Preview forcé : ?promo=preview OU localStorage.melodia_promo_preview='1' (aperçu hors dates).
  const forced = () => {
    try { if (localStorage.getItem('melodia_promo_preview') === '1') return true; } catch (e) {}
    return params().get('promo') === 'preview';
  };

  function isActive(p, d) {
    d = d || new Date();
    return d >= parse(p.start) && d <= new Date(parse(p.end).getTime() + DAY - 1);
  }
  function current() {
    const f = forced();
    return PROMOS.find((p) => f || isActive(p)) || null;
  }
  function fmt(n) { return Number(n).toLocaleString('fr-FR').replace(/[  ]/g, ' '); }

  window.MelodiaPromo = {
    all: PROMOS,
    current,
    isActive,
    fmt,
    // prix effectif d'une option (renvoie le prix promo si applicable, sinon fallback)
    priceFor(serviceId, optionId, fallback) {
      const p = current();
      return p && p.serviceId === serviceId && p.optionId === optionId ? p.newPrice : fallback;
    },
  };

  // ---- Bannière (page d'accueil) : injectée en bas du hero (= au-dessus du micro en mobile) ----
  function injectBanner() {
    const p = current();
    if (!p) return;
    const content = document.querySelector('.hero__content');
    if (!content || document.querySelector('.promo-banner')) return;
    const base = window.MELODIA_BASE || './';
    const a = document.createElement('a');
    a.className = 'promo-banner';
    a.href = `${base}pages/booking.html?express=${p.id}`;
    a.setAttribute('aria-label', `${p.headline} — ${p.cta}`);
    a.innerHTML =
      `<span class="promo-banner__badge">−${p.percent}%</span>` +
      `<span class="promo-banner__body">` +
        `<span class="promo-banner__eyebrow">🔥 ${p.eyebrow}</span>` +
        `<span class="promo-banner__headline">${p.headline}</span>` +
        `<span class="promo-banner__sub"><s>${fmt(p.oldPrice)} F</s> · ${p.sub}</span>` +
      `</span>` +
      `<span class="promo-banner__cta">${p.cta} <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
    content.appendChild(a);
  }

  // ---- Cohérence prix : éléments tagués data-promo-target="<itemId>" ----
  function applyPrices() {
    const p = current();
    if (!p) return;
    document.querySelectorAll(`[data-promo-target="${p.itemId}"]`).forEach((el) => {
      // met à jour le data-price pour que le panier prenne le prix promo
      if (el.dataset && el.dataset.price) el.dataset.price = String(p.newPrice);
      // remplace l'affichage du prix (barré + nouveau + tag)
      const priceEl =
        el.querySelector('.price-option__price') ||
        el.querySelector('.price') ||
        (el.classList.contains('price') ? el : null);
      if (priceEl && !priceEl.dataset.promoApplied) {
        priceEl.dataset.promoApplied = '1';
        priceEl.innerHTML = `<s class="promo-old">${fmt(p.oldPrice)}</s> <span class="promo-new">${fmt(p.newPrice)} FCFA</span> <span class="promo-tag">−${p.percent}%</span>`;
      }
      el.classList.add('is-promo');
    });
  }

  function run() { injectBanner(); applyPrices(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
