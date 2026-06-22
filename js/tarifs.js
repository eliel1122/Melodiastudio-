/* =========================================================
   MELODIA STUDIO — Tarifs page
   Pack "Réserver" buttons add the pack to the cart and
   redirect to booking.
   ========================================================= */
(() => {
  const PACKS = {
    silver: {
      id: 'pack-silver',
      service: 'Pack Silver',
      option: '2h studio + pré-mix + photos',
      price: 50000,
      duration: 2,
    },
    gold: {
      id: 'pack-gold',
      service: 'Pack Gold',
      option: '2h studio + mix + photos + cover',
      price: 180000,
      duration: 2,
    },
    platinium: {
      id: 'pack-platinium',
      service: 'Pack Platinium',
      option: '2h + mix + master + cover + visualizer',
      price: 280000,
      duration: 2,
    },
  };

  document.querySelectorAll('[data-book-pack]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const packId = btn.dataset.bookPack;
      const pack = PACKS[packId];
      if (!pack || !window.MelodiaCart) return;
      window.MelodiaCart.add(pack);
      window.MelodiaCart.toast(`${pack.service} ajouté · redirection...`);

      // Animate badge
      document.querySelectorAll('.cart-badge').forEach((b) => {
        b.classList.add('is-pop');
        setTimeout(() => b.classList.remove('is-pop'), 500);
      });

      // Redirect after a short delay so the user sees the confirmation
      setTimeout(() => {
        window.location.href = 'booking.html';
      }, 650);
    });
  });
})();
