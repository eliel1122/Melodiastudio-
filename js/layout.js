/* =========================================================
   MELODIA STUDIO — Shared nav + footer injector
   Each inner page has <div id="nav-mount"></div> + <div id="footer-mount"></div>
   ========================================================= */
(() => {
  const HERE = (window.MELODIA_PAGE || '').toLowerCase();
  const BASE = window.MELODIA_BASE || '../';

  const NAV_ITEMS = [
    { href: `${BASE}pages/studio.html`,    label: 'Le Studio', id: 'studio' },
    { href: `${BASE}pages/services.html`,  label: 'Services',  id: 'services' },
    { href: `${BASE}pages/tarifs.html`,    label: 'Tarifs',    id: 'tarifs' },
    { href: `${BASE}pages/portfolio.html`, label: 'Portfolio', id: 'portfolio' },
    { href: `${BASE}pages/fidelite.html`,  label: 'Fidélité',  id: 'fidelite' },
    { href: `${BASE}pages/contact.html`,   label: 'Contact',   id: 'contact' },
  ];

  const navHTML = `
    <header class="nav glass" id="nav">
      <a href="${BASE}index.html" class="nav__logo" aria-label="Accueil Melodia Studio">
        <img src="${BASE}assets/images/melodia-logo.png" alt="Melodia Studio" />
      </a>
      <nav class="nav__links" aria-label="Navigation principale">
        ${NAV_ITEMS.map(item =>
          `<a href="${item.href}" class="${item.id === HERE ? 'is-active' : ''}">${item.label}</a>`
        ).join('')}
      </nav>
      <div class="nav__right">
        <a href="${BASE}pages/panier.html" class="nav__cart" aria-label="Voir le panier">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h2l2 12h12l2-9H6"/><circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/></svg>
          <span class="cart-badge is-empty">0</span>
        </a>
        <a href="${BASE}pages/services.html" class="btn btn--primary nav__cta">
          <span>Réserver</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>
        <button class="nav__burger" id="nav-burger" aria-label="Menu" aria-expanded="false">
          <span></span><span></span><span></span>
        </button>
      </div>
    </header>
    <nav class="nav-mobile" id="nav-mobile" aria-hidden="true">
      <div class="nav-mobile__inner">
        <div class="nav-mobile__links">
          ${NAV_ITEMS.map(item =>
            `<a href="${item.href}" class="${item.id === HERE ? 'is-active' : ''}">${item.label}</a>`
          ).join('')}
          <a href="${BASE}pages/panier.html" class="nav-mobile__cart">Panier <span class="cart-badge is-empty">0</span></a>
        </div>
        <a href="${BASE}pages/services.html" class="btn btn--primary btn--lg nav-mobile__cta">
          <span>Réserver une session</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>
      </div>
    </nav>
  `;

  const footerHTML = `
    <footer class="footer">
      <div class="footer__top">
        <div class="footer__brand">
          <a href="${BASE}index.html" class="nav__logo">
            <img src="${BASE}assets/images/melodia-logo.png" alt="Melodia Studio" />
          </a>
          <p class="footer__tag">Le cocon créatif des artistes qui montent.</p>
        </div>
        <div class="footer__cols">
          <div class="footer__col">
            <h4>Studio</h4>
            <a href="${BASE}pages/studio.html">La Cabine</a>
            <a href="${BASE}pages/studio.html">Control Room</a>
            <a href="${BASE}pages/services.html">Équipement</a>
          </div>
          <div class="footer__col">
            <h4>Services</h4>
            <a href="${BASE}pages/services.html">Enregistrement</a>
            <a href="${BASE}pages/services.html">Mix &amp; Master</a>
            <a href="${BASE}pages/tarifs.html">Tarifs</a>
            <a href="${BASE}pages/booking.html">Réserver</a>
          </div>
          <div class="footer__col">
            <h4>Contact</h4>
            <a href="https://www.google.com/maps?q=82HW%2BW6+Abidjan" target="_blank" rel="noopener">Cocody Riviera 4 M'pouto<br>La harpe mélodieuse</a>
            <a href="https://wa.me/2250703387738?text=Salut%20Melodia%20%F0%9F%91%8B%20J%27aimerais%20en%20savoir%20plus." target="_blank" rel="noopener">WhatsApp · +225 07 03 38 77 38</a>
            <a href="mailto:contact.melodiastud@gmail.com">contact.melodiastud@gmail.com</a>
            <a href="https://www.instagram.com/melodia.studi0" target="_blank" rel="noopener">Instagram · @melodia.studi0</a>
            <a href="https://www.tiktok.com/@melodia.studi0" target="_blank" rel="noopener">TikTok · @melodia.studi0</a>
          </div>
        </div>
      </div>
      <div class="footer__bottom mono">
        <span>© 2026 MELODIA STUDIO</span>
        <span>Abidjan · Côte d'Ivoire</span>
      </div>
    </footer>
  `;

  const navMount = document.getElementById('nav-mount');
  const footerMount = document.getElementById('footer-mount');
  if (navMount) navMount.outerHTML = navHTML;
  if (footerMount) footerMount.outerHTML = footerHTML;

  // ---- Nav scroll shrink (same as home)
  function onScroll() {
    const nav = document.getElementById('nav');
    if (!nav) return;
    const y = window.scrollY;
    if (y > 24) { nav.style.padding = '0 10px 0 18px'; nav.style.top = '12px'; }
    else { nav.style.padding = '0 12px 0 20px'; nav.style.top = '16px'; }
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
      if (open) { closeMobile(); }
      else {
        burger.setAttribute('aria-expanded', 'true');
        mobileNav.setAttribute('aria-hidden', 'false');
        document.body.classList.add('nav-mobile-open');
      }
    });
    mobileNav.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMobile));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMobile(); });
  }

  // ---- Reveal on scroll
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('.section-header, .card, .cta-final__inner, .pricing__card, .service-card, .portfolio-item, .blog-card, .blog-featured, .split, .contact-form, .contact-info').forEach((el) => {
    el.classList.add('reveal');
    io.observe(el);
  });

  // ---- Pause section videos when scrolled out, play when visible
  const sectionVideos = document.querySelectorAll('video[data-section-video]');
  if (sectionVideos.length) {
    const vidObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const v = entry.target;
        if (entry.isIntersecting) {
          v.play().catch(() => { /* autoplay can fail silently if user hasn't interacted */ });
        } else {
          v.pause();
        }
      });
    }, { threshold: 0.25 });
    sectionVideos.forEach((v) => vidObserver.observe(v));
  }
})();
