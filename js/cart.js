/* =========================================================
   MELODIA STUDIO — Cart (localStorage based)
   API:
     MelodiaCart.add(item), MelodiaCart.remove(id), MelodiaCart.clear()
     MelodiaCart.setQty(id, qty), MelodiaCart.getAll(), MelodiaCart.getCount()
     MelodiaCart.getTotal()
   Event:
     window dispatches "melodia:cart:change" on every mutation.
   ========================================================= */
(() => {
  const KEY = 'melodia_cart_v1';
  const FR = new Intl.NumberFormat('fr-FR');
  const fmt = (n) => `${FR.format(n)} FCFA`;

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function write(items) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch (e) { /* quota */ }
    window.dispatchEvent(new CustomEvent('melodia:cart:change', { detail: items }));
  }

  const api = {
    add(item) {
      const items = read();
      const existing = items.find((i) => i.id === item.id);
      if (existing) existing.qty += (item.qty || 1);
      else items.push({ ...item, qty: item.qty || 1 });
      write(items);
      return items;
    },
    remove(id) {
      write(read().filter((i) => i.id !== id));
    },
    setQty(id, qty) {
      const items = read();
      const it = items.find((i) => i.id === id);
      if (it) it.qty = Math.max(1, qty | 0);
      write(items);
    },
    clear() { write([]); },
    getAll() { return read(); },
    getCount() { return read().reduce((s, i) => s + i.qty, 0); },
    getTotal() { return read().reduce((s, i) => s + i.price * i.qty, 0); },
    format: fmt,
  };

  window.MelodiaCart = api;

  // Cross-tab sync
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) window.dispatchEvent(new CustomEvent('melodia:cart:change', { detail: read() }));
  });

  // ---- Badge updater (any .cart-badge in the DOM)
  function updateBadge() {
    const count = api.getCount();
    document.querySelectorAll('.cart-badge').forEach((el) => {
      el.textContent = count;
      el.classList.toggle('is-empty', count === 0);
    });
  }
  window.addEventListener('melodia:cart:change', updateBadge);
  document.addEventListener('DOMContentLoaded', updateBadge);
  setTimeout(updateBadge, 50);

  // ---- Toast (small floating confirmation after add)
  function toast(msg) {
    let el = document.getElementById('cart-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cart-toast';
      el.className = 'cart-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('is-visible');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('is-visible'), 2200);
  }
  api.toast = toast;

  // =========================================================
  // FLOATING CART (bottom-right) + DRAWER PEEK
  // =========================================================
  const BASE = window.MELODIA_BASE || '';

  function createFab() {
    if (document.getElementById('cart-fab')) return;
    const root = document.createElement('div');
    root.id = 'cart-fab-root';
    root.innerHTML = `
      <button id="cart-fab" class="cart-fab" aria-label="Ouvrir le panier" aria-expanded="false">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h2l2 12h12l2-9H6"/><circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/></svg>
        <span class="cart-badge is-empty">0</span>
      </button>
      <div id="cart-drawer" class="cart-drawer" role="dialog" aria-label="Aperçu du panier" aria-hidden="true">
        <header class="cart-drawer__head">
          <h3>Ton panier</h3>
          <button class="cart-drawer__close" aria-label="Fermer">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M6 18L18 6"/></svg>
          </button>
        </header>
        <div class="cart-drawer__body" id="cart-drawer-body"></div>
        <footer class="cart-drawer__foot">
          <div class="cart-drawer__total">
            <span>Total</span>
            <span class="num" id="cart-drawer-total">0 FCFA</span>
          </div>
          <a href="${BASE}pages/booking.html" class="btn btn--primary" style="width: 100%; justify-content: center;">
            <span>Finaliser la réservation</span>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </a>
          <a href="${BASE}pages/panier.html" class="cart-drawer__see-all">Voir le panier complet →</a>
        </footer>
      </div>
      <div id="cart-drawer-backdrop" class="cart-drawer-backdrop"></div>
    `;
    document.body.appendChild(root);

    const fab = document.getElementById('cart-fab');
    const drawer = document.getElementById('cart-drawer');
    const backdrop = document.getElementById('cart-drawer-backdrop');
    const closeBtn = drawer.querySelector('.cart-drawer__close');

    function open() {
      fab.setAttribute('aria-expanded', 'true');
      drawer.setAttribute('aria-hidden', 'false');
      drawer.classList.add('is-open');
      backdrop.classList.add('is-visible');
      renderDrawer();
    }
    function close() {
      fab.setAttribute('aria-expanded', 'false');
      drawer.setAttribute('aria-hidden', 'true');
      drawer.classList.remove('is-open');
      backdrop.classList.remove('is-visible');
    }
    fab.addEventListener('click', () => (drawer.classList.contains('is-open') ? close() : open()));
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    api._closeDrawer = close;
  }

  function renderDrawer() {
    const body = document.getElementById('cart-drawer-body');
    const totalEl = document.getElementById('cart-drawer-total');
    if (!body || !totalEl) return;

    const items = api.getAll();
    if (items.length === 0) {
      body.innerHTML = `
        <div class="cart-drawer__empty">
          <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 3h2l2 12h12l2-9H6"/><circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/></svg>
          <p>Ton panier est vide.</p>
          <a href="${BASE}pages/services.html" class="btn btn--ghost">Découvrir les services</a>
        </div>
      `;
    } else {
      body.innerHTML = items.map((it) => `
        <article class="cart-drawer__item" data-id="${it.id}">
          <div class="cart-drawer__item-info">
            <div class="cart-drawer__item-name">${it.service}</div>
            <div class="cart-drawer__item-option">${it.option}${it.qty > 1 ? ` × ${it.qty}` : ''}</div>
          </div>
          <div class="cart-drawer__item-price">${fmt(it.price * it.qty)}</div>
          <button class="cart-drawer__item-remove" data-id="${it.id}" aria-label="Retirer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M6 18L18 6"/></svg>
          </button>
        </article>
      `).join('');

      body.querySelectorAll('.cart-drawer__item-remove').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          api.remove(btn.dataset.id);
        });
      });
    }

    totalEl.textContent = fmt(api.getTotal());
  }

  function updateFabVisibility() {
    const fab = document.getElementById('cart-fab');
    if (!fab) return;
    const count = api.getCount();
    fab.classList.toggle('is-empty', count === 0);
  }

  // Initialize FAB once DOM is ready
  function init() {
    createFab();
    renderDrawer();
    updateFabVisibility();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-render drawer + visibility on every change
  window.addEventListener('melodia:cart:change', () => {
    renderDrawer();
    updateFabVisibility();
  });
})();
