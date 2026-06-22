/* =========================================================
   MELODIA STUDIO — Service detail page logic
   Reads data attributes on the .price-card and binds:
     - option selection
     - reveal button
     - add-to-cart with badge animation + toast
   ========================================================= */
(() => {
  const priceCard = document.querySelector('[data-service-id]');
  if (!priceCard) return;

  const serviceId = priceCard.dataset.serviceId;
  const serviceName = priceCard.dataset.serviceName;

  let selected = null;
  const options = Array.from(priceCard.querySelectorAll('.price-option'));
  const amountEl = priceCard.querySelector('.price-amount');
  const numEl = amountEl?.querySelector('.num');
  const unitEl = amountEl?.querySelector('.unit');
  const revealBtn = priceCard.querySelector('.btn--reveal');
  const addBtn = priceCard.querySelector('.btn--add');

  function updateAmountFromSelection() {
    if (!selected || !numEl) return;
    if (selected.price === 0) {
      numEl.textContent = 'Sur devis';
      numEl.style.fontSize = '32px';
      if (unitEl) unitEl.style.display = 'none';
    } else {
      const formatted = window.MelodiaCart.format(selected.price);
      // Split at " FCFA"
      const [num, unit] = formatted.split(' ');
      numEl.textContent = num;
      numEl.style.fontSize = '';
      if (unitEl) { unitEl.style.display = ''; unitEl.textContent = 'FCFA ' + (selected.unit || ''); }
    }
  }

  function selectOption(opt) {
    options.forEach((o) => o.classList.remove('is-selected'));
    opt.classList.add('is-selected');
    selected = {
      id: opt.dataset.priceId,
      name: opt.dataset.option,
      unit: opt.dataset.unit || '',
      price: parseInt(opt.dataset.price, 10),
      duration: parseInt(opt.dataset.duration || '0', 10),
    };
    updateAmountFromSelection();
  }

  options.forEach((opt) => opt.addEventListener('click', () => selectOption(opt)));
  if (options.length) selectOption(options[0]);

  // ---- Add to cart
  addBtn?.addEventListener('click', () => {
    if (!selected) return;
    if (selected.price === 0) {
      window.MelodiaCart.toast('Cette option est sur devis — passe par le formulaire contact.');
      return;
    }
    window.MelodiaCart.add({
      id: `${serviceId}-${selected.id}`,
      service: serviceName,
      option: selected.name,
      price: selected.price,
      duration: selected.duration,
    });
    window.MelodiaCart.toast(`${serviceName} ajouté au panier`);
    document.querySelectorAll('.cart-badge').forEach((b) => {
      b.classList.add('is-pop');
      setTimeout(() => b.classList.remove('is-pop'), 500);
    });
    const original = addBtn.innerHTML;
    addBtn.innerHTML = '<span>Ajouté ✓</span>';
    setTimeout(() => { addBtn.innerHTML = original; }, 1600);
  });
})();
