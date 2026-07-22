/* =========================================================
   MELODIA STUDIO — Meta Pixel (base + helper Achat)
   Pixel ID : 2061006034501705  (dataset « Melodia Studio Pixel »)
   Chargé une seule fois sur toutes les pages via layout.js / ui.js,
   et directement en <head> sur la page de confirmation de paiement.
   ========================================================= */
(function () {
  if (window.__melodiaPixel) return;      // garde : init une seule fois
  window.__melodiaPixel = true;

  var PIXEL_ID = '2061006034501705';

  // Snippet standard Meta Pixel (fbevents.js + file d'attente)
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0';
    n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
    s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  fbq('init', PIXEL_ID);
  fbq('track', 'PageView');
})();

/* Déclenche un évènement Achat (valeur en F CFA / XOF).
   `eventId` DOIT être identique à l'event_id envoyé côté serveur (CAPI)
   pour que Meta déduplique le doublon navigateur + serveur.
   Utilisé sur pages/paiement-confirme.html quand un paiement est confirmé. */
window.melodiaTrackPurchase = function (value, eventId) {
  if (typeof window.fbq !== 'function') return;
  var data = { currency: 'XOF' };
  var v = Number(value);
  if (!isNaN(v) && v > 0) data.value = v;
  window.fbq('track', 'Purchase', data, eventId ? { eventID: String(eventId) } : undefined);
};
