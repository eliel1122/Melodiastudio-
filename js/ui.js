/* =========================================================
   MELODIA STUDIO — UI interactions (nav, reveals, carousel)
   ========================================================= */
(() => {
  // ---- Mini artists carousel
  const track = document.getElementById('artists-mini-track');
  if (track) {
    document.querySelectorAll('.artists-mini__nav').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = track.querySelector('.portfolio-item');
        if (!card) return;
        const step = card.offsetWidth + 16; // gap
        const dir = btn.dataset.dir === 'next' ? 1 : -1;
        track.scrollBy({ left: step * dir, behavior: 'smooth' });
      });
    });
  }

  const nav = document.getElementById('nav');

  let lastY = 0;
  function onScroll() {
    const y = window.scrollY;
    if (y > 24) {
      nav.style.padding = '0 10px 0 18px';
      nav.style.top = '12px';
    } else {
      nav.style.padding = '0 12px 0 20px';
      nav.style.top = '16px';
    }
    lastY = y;
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- Burger menu toggle (mobile)
  const burger = document.getElementById('nav-burger');
  const mobileNav = document.getElementById('nav-mobile');
  if (burger && mobileNav) {
    const closeMobile = () => {
      burger.setAttribute('aria-expanded', 'false');
      mobileNav.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('nav-mobile-open');
    };
    burger.addEventListener('click', () => {
      const open = burger.getAttribute('aria-expanded') === 'true';
      if (open) closeMobile();
      else {
        burger.setAttribute('aria-expanded', 'true');
        mobileNav.setAttribute('aria-hidden', 'false');
        document.body.classList.add('nav-mobile-open');
      }
    });
    mobileNav.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMobile));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMobile(); });
  }

  // Intersection-based reveal for section headers / cards
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });

  document.querySelectorAll('.section-header, .card, .cta-final__inner').forEach((el) => {
    el.classList.add('reveal');
    io.observe(el);
  });
})();
