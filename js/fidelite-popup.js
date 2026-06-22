/* =====================================================
   POPUP PREMIÈRE VISITE — Récupère ta carte fidélité
   ===================================================== */

(function () {
  'use strict';

  // Inject HTML
  function injectPopup() {
    const base = window.MELODIA_BASE || './';
    const targetPage = (base === './' ? 'pages/fidelite.html' : 'fidelite.html');

    const html = `
      <div id="mlc-popup" role="dialog" aria-modal="true" aria-labelledby="mlc-popup-title">
        <div class="mlc-popup-content">
          <button class="mlc-popup-close" aria-label="Fermer">×</button>
          <div class="mlc-popup-eyebrow">// MELODIA FAMILY · NOUVEAU PROGRAMME</div>
          <h2 id="mlc-popup-title">RÉCUPÈRE TA <span class="accent">CARTE FIDÉLITÉ.</span></h2>
          <p>Inscription gratuite en 30 secondes. Tu repars avec ta carte digitale et <b style="color:var(--accent);">1 point déjà offert</b>. Toutes les 5 séances = 1 offerte.</p>
          <div class="mlc-popup-gift">🎁 +1 POINT OFFERT À L'INSCRIPTION</div>
          <div class="mlc-popup-actions">
            <a href="${targetPage}" class="mlc-popup-btn primary">Activer ma carte →</a>
            <button class="mlc-popup-btn ghost" id="mlc-popup-later">Plus tard</button>
          </div>
        </div>
      </div>
    `;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);

    function close() {
      const el = document.getElementById('mlc-popup');
      if (el) el.classList.remove('show');
      if (window.MelodiaFidelite) window.MelodiaFidelite.markPopupShown();
    }

    document.querySelector('.mlc-popup-close').addEventListener('click', close);
    document.getElementById('mlc-popup-later').addEventListener('click', close);
    // Click outside content to close
    document.getElementById('mlc-popup').addEventListener('click', function(e){
      if (e.target.id === 'mlc-popup') close();
    });
    // Escape key
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape') close();
    });
  }

  function showPopup() {
    const el = document.getElementById('mlc-popup');
    if (el) el.classList.add('show');
  }

  function init() {
    if (!window.MelodiaFidelite) return; // fidelite.js doit être chargé
    if (!window.MelodiaFidelite.shouldShowFirstVisitPopup()) return;

    window.MelodiaFidelite.incrementVisits();
    injectPopup();
    // Petit délai pour ne pas être agressif
    setTimeout(showPopup, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
