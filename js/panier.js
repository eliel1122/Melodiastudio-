/* =========================================================
   MELODIA STUDIO — Panier page
   Renders the cart from localStorage and binds qty/remove/clear actions.
   ========================================================= */
(() => {
  function render() {
    const items = window.MelodiaCart.getAll();
    const section = document.getElementById('cart-section');
    if (!section) return;

    if (items.length === 0) {
      section.innerHTML = `
        <div class="cart-empty glass">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3h2l2 12h12l2-9H6"/><circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/>
          </svg>
          <h2>Ton panier est vide.</h2>
          <p>Découvre nos services et ajoute ce qui correspond à ton projet. On t'aide à monter ta session de A à Z.</p>
          <div class="cta-final__buttons" style="margin-top: 1rem;">
            <a href="services.html" class="btn btn--primary btn--lg">Découvrir les services</a>
            <a href="booking.html" class="btn btn--ghost btn--lg">Réserver direct</a>
          </div>
        </div>
      `;
      return;
    }

    section.innerHTML = `
      <div class="cart-layout">
        <div class="cart-items" id="cart-items"></div>
        <aside class="cart-summary glass">
          <h3>Récapitulatif</h3>
          <div class="row"><span class="label">Articles</span><span class="value" id="cart-count">0</span></div>
          <div class="row"><span class="label">Sous-total</span><span class="value" id="cart-subtotal">0 FCFA</span></div>
          <div class="total">
            <span class="label">Total</span>
            <span class="num" id="cart-total">0 FCFA</span>
          </div>
          <a href="booking.html" class="btn btn--primary btn--lg" style="width: 100%; justify-content: center;">
            <span>Finaliser la réservation</span>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </a>
          <a href="services.html" class="btn btn--ghost btn--lg" style="width: 100%; justify-content: center;">Continuer mes achats</a>
          <button class="cart-clear" id="cart-clear">Vider le panier</button>
        </aside>
      </div>
    `;

    const itemsEl = document.getElementById('cart-items');
    itemsEl.innerHTML = items.map((it) => `
      <article class="cart-item" data-id="${it.id}">
        <div>
          <div class="cart-item__name">${it.service}</div>
          <div class="cart-item__option">${it.option}</div>
        </div>
        <div class="cart-item__qty">
          <button data-act="dec" aria-label="Diminuer">−</button>
          <span>${it.qty}</span>
          <button data-act="inc" aria-label="Augmenter">+</button>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <span class="cart-item__price">${window.MelodiaCart.format(it.price * it.qty)}</span>
          <button class="cart-item__remove" data-act="rm" aria-label="Retirer">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
          </button>
        </div>
      </article>
    `).join('');

    // Bind actions
    itemsEl.querySelectorAll('.cart-item').forEach((node) => {
      const id = node.dataset.id;
      node.querySelector('[data-act="inc"]').addEventListener('click', () => {
        const item = window.MelodiaCart.getAll().find((i) => i.id === id);
        window.MelodiaCart.setQty(id, (item?.qty || 1) + 1);
      });
      node.querySelector('[data-act="dec"]').addEventListener('click', () => {
        const item = window.MelodiaCart.getAll().find((i) => i.id === id);
        const newQty = (item?.qty || 1) - 1;
        if (newQty <= 0) window.MelodiaCart.remove(id);
        else window.MelodiaCart.setQty(id, newQty);
      });
      node.querySelector('[data-act="rm"]').addEventListener('click', () => {
        window.MelodiaCart.remove(id);
      });
    });

    document.getElementById('cart-clear')?.addEventListener('click', () => {
      if (confirm('Vider tout le panier ?')) window.MelodiaCart.clear();
    });

    // Totals
    const subtotal = window.MelodiaCart.getTotal();
    document.getElementById('cart-count').textContent = window.MelodiaCart.getCount();
    document.getElementById('cart-subtotal').textContent = window.MelodiaCart.format(subtotal);
    document.getElementById('cart-total').textContent = window.MelodiaCart.format(subtotal);
  }

  render();
  window.addEventListener('melodia:cart:change', render);
})();
