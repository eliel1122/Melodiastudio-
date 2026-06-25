/* =========================================================
   MELODIA STUDIO — Booking flow
   Two modes:
     - CLASSIC: no cart items → user picks service / date / slot / details
     - CART:    cart has items → user plans EACH item (date + slot), then details
   Data hardcoded for the static mockup. To swap with Airtable later:
     replace DATA.* with a fetch.
   ========================================================= */

const DATA = {
  services: [
    { id: 'rec',    name: 'Enregistrement',       sub: 'Session voix / instrument',         base: 25000,  unit: '/ heure',    duration: 1 },
    { id: 'mix',    name: 'Mix',                  sub: 'Mixage stems multitrack',           base: 150000, unit: '/ titre',    duration: 0 },
    { id: 'master', name: 'Mastering',            sub: 'Master radio-ready',                base: 75000,  unit: '/ titre',    duration: 0 },
    { id: 'prod',   name: 'Production beat',      sub: 'Beat sur mesure, propriété cédée',  base: 100000, unit: '/ beat',     duration: 0 },
    { id: 'vo',     name: 'Voice-over / Podcast', sub: 'Enregistrement & édition voix',     base: 40000,  unit: '/ heure',    duration: 1 },
    { id: 'pack',   name: 'Package Gold',         sub: '2h studio + mix + photos + cover',  base: 180000, unit: '/ projet',   duration: 2, featured: true },
  ],

  unavailable: {
    '2026-05-22': ['all'],
    '2026-06-03': ['all'],
    '2026-06-15': ['all'],
  },
};

// Generate available time-slots depending on the duration (hours).
//   - duration === 0  → 3 short 30min rendez-vous (services non-studio : Mix, Master, DA, Prod beat)
//   - duration  >  0  → sliding-window 1h-step slots within the 9h–21h opening hours
function generateSlots(duration) {
  if (!duration || duration === 0) {
    return [
      { id: 'rdv-10', time: '10h — 10h30', label: 'Rendez-vous · 30min' },
      { id: 'rdv-14', time: '14h — 14h30', label: 'Rendez-vous · 30min' },
      { id: 'rdv-17', time: '17h — 17h30', label: 'Rendez-vous · 30min' },
    ];
  }
  // Sliding window: a slot can start every hour from OPEN to (CLOSE - duration)
  const OPEN = 9;
  const CLOSE = 21;
  const slots = [];
  for (let start = OPEN; start + duration <= CLOSE; start++) {
    const end = start + duration;
    let period;
    if (start < 12) period = 'Matin';
    else if (start < 17) period = 'Après-midi';
    else period = 'Soirée';
    slots.push({
      id: `s-${start}-${end}`,
      time: `${pad(start)}h — ${pad(end)}h`,
      label: `${period} · ${duration}h`,
    });
  }
  return slots;
}

const MONTHS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

const state = {
  mode: 'classic',     // 'classic' or 'cart'
  step: 0,             // step index
  // classic mode
  service: null,
  date: null,
  slot: null,
  // cart mode — array of items with their plan
  items: [],
  activeItemId: null,  // id of the item whose accordion is open
  // shared
  details: { name: '', email: '', phone: '', project: '' },
  // calendar UI state (per item in cart mode)
  calCursor: {},       // itemId -> { year, month }
  // Disponibilités (par date) — cache live depuis /api/get-availability
  availability: {},    // { 'YYYY-MM-DD': { loading, occupied, blockedAll, fetchedAt, error } }
  // Jours bloqués (par mois) — cache live depuis /api/get-blocked-days
  blockedDays: {},     // { 'YYYY-MM': { loading, dates: Set, fetchedAt, error } }
};

// =========================================================
// AVAILABILITY — fetch les créneaux occupés depuis le backend
// =========================================================
async function fetchAvailability(dateIso) {
  if (!dateIso) return;
  const cache = state.availability[dateIso];
  // Cache 5 min, sauf si erreur précédente → on retry
  if (cache && !cache.error && Date.now() - cache.fetchedAt < 5 * 60 * 1000) return;

  state.availability[dateIso] = { loading: true, occupied: [], blockedAll: false, fetchedAt: 0 };
  renderActiveStep();

  try {
    const res = await fetch(`/api/get-availability?date=${encodeURIComponent(dateIso)}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const occupied = data.occupied || [];
    // Journée entière bloquée : un blocage qui couvre 9h-21h
    const open = (data.studioOpen?.startHour ?? 9) * 60;
    const close = (data.studioOpen?.endHour ?? 21) * 60;
    const blockedAll = occupied.some(o =>
      o.source === 'blocage' && o.start <= open && o.end >= close
    );

    state.availability[dateIso] = {
      loading: false,
      occupied,
      blockedAll,
      fetchedAt: Date.now(),
    };
  } catch (e) {
    console.error('[availability] fetch failed:', e);
    state.availability[dateIso] = {
      loading: false,
      occupied: [],
      blockedAll: false,
      fetchedAt: Date.now(),
      error: e.message,
    };
  }
  renderActiveStep();
}

// Fetch les jours full-bloqués pour un mois donné (year, month 0-indexed JS)
async function fetchBlockedDays(year, month) {
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const cache = state.blockedDays[monthKey];
  if (cache && !cache.error && Date.now() - cache.fetchedAt < 10 * 60 * 1000) return;

  state.blockedDays[monthKey] = { loading: true, dates: new Set(), fetchedAt: 0 };
  try {
    const res = await fetch(`/api/get-blocked-days?year=${year}&month=${month + 1}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.blockedDays[monthKey] = {
      loading: false,
      dates: new Set(data.blockedDays || []),
      fetchedAt: Date.now(),
    };
    renderActiveStep();
  } catch (e) {
    console.warn('[blocked-days] fetch failed:', e.message);
    state.blockedDays[monthKey] = {
      loading: false,
      dates: new Set(),
      fetchedAt: Date.now(),
      error: e.message,
    };
  }
}

// Détecte si un slot UI chevauche un créneau occupé
function isSlotOccupied(slotId, occupied) {
  if (!occupied || !occupied.length) return false;
  // Format "s-14-16" → start=14, end=16 (heures)
  let startMin, endMin;
  const m = slotId.match(/^s-(\d+)-(\d+)$/);
  if (m) {
    startMin = parseInt(m[1], 10) * 60;
    endMin = parseInt(m[2], 10) * 60;
  } else if (slotId.startsWith('rdv-')) {
    const hour = parseInt(slotId.replace('rdv-', ''), 10);
    if (isNaN(hour)) return false;
    startMin = hour * 60;
    endMin = startMin + 30;
  } else {
    return false;
  }
  return occupied.some(o => startMin < o.end && endMin > o.start);
}

// =========================================================
// INIT
// =========================================================
function init() {
  try {
    console.log('[booking] init starting. MelodiaCart:', !!window.MelodiaCart);
    const cart = window.MelodiaCart?.getAll?.() || [];
    console.log('[booking] cart items:', cart.length, cart);

    if (cart.length > 0) {
      state.mode = 'cart';
      state.items = cart.map((it) => ({
        ...it,
        planDate: null,
        planSlot: null,
      }));
      if (state.items.length) state.activeItemId = state.items[0].id;
      // Initialize calendar cursors for each item
      const today = new Date();
      state.items.forEach((it) => {
        state.calCursor[it.id] = { year: today.getFullYear(), month: today.getMonth() };
      });
      setHeroCopy(`${cart.length} service${cart.length > 1 ? 's' : ''} à planifier`, 'Choisis une date et un créneau pour chaque service de ton panier, puis renseigne tes coordonnées.');
    } else {
      state.mode = 'classic';
      const today = new Date();
      state.calCursor.__classic = { year: today.getFullYear(), month: today.getMonth() };
    }

    console.log('[booking] mode:', state.mode, 'step:', state.step);
    renderSteps();
    renderActiveStep();
    renderSummary();
    console.log('[booking] init done');
  } catch (err) {
    console.error('[booking] init failed:', err);
    const root = document.getElementById('booking-steps-content');
    if (root) {
      root.innerHTML = `
        <div style="padding: 2rem; color: var(--danger); font-family: var(--font-mono); font-size: 13px;">
          <p style="margin-bottom: 1rem;">⚠ Erreur de chargement du booking :</p>
          <pre style="white-space: pre-wrap; color: var(--fg-dim);">${err.message}\n\n${err.stack || ''}</pre>
        </div>
      `;
    }
    throw err;
  }

  // Listen to cart changes (rare, but if user opens drawer and removes during booking)
  window.addEventListener('melodia:cart:change', () => {
    // Refresh in cart mode if items changed externally
    if (state.mode === 'cart') {
      const fresh = window.MelodiaCart.getAll();
      if (fresh.length === 0) {
        // Switched to empty → go to classic mode
        state.mode = 'classic';
        state.step = 0;
        const today = new Date();
        state.calCursor.__classic = { year: today.getFullYear(), month: today.getMonth() };
        setHeroCopy('Quatre étapes, sous 2 minutes', 'Choisis ta prestation, ta date, ton créneau, laisse-nous tes infos.');
      } else {
        // Reconcile: keep plan info for items still present
        const prevMap = new Map(state.items.map((i) => [i.id, i]));
        state.items = fresh.map((it) => {
          const prev = prevMap.get(it.id);
          return {
            ...it,
            planDate: prev?.planDate || null,
            planSlot: prev?.planSlot || null,
            planSlotTime: prev?.planSlotTime || null,
            planSlotLabel: prev?.planSlotLabel || null,
          };
        });
        if (!state.items.find((i) => i.id === state.activeItemId)) {
          state.activeItemId = state.items[0]?.id || null;
        }
      }
      renderSteps();
      renderActiveStep();
      renderSummary();
    }
  });
}

function setHeroCopy(eyebrow, lead) {
  const e = document.getElementById('hero-eyebrow');
  const l = document.getElementById('hero-lead');
  if (e) e.textContent = eyebrow;
  if (l) l.textContent = lead;
}

// =========================================================
// STEPS
// =========================================================
function getStepLabels() {
  return state.mode === 'cart'
    ? ['Planifier', 'Coordonnées']
    : ['Prestation', 'Date', 'Créneau', 'Coordonnées'];
}

function renderSteps() {
  const labels = getStepLabels();
  const stepsEl = document.getElementById('booking-steps');
  stepsEl.innerHTML = labels.map((label, i) => {
    const cls = ['booking-step__chip'];
    if (i === state.step) cls.push('is-active');
    if (i < state.step && isStepValid(i)) cls.push('is-done');
    return `<button class="${cls.join(' ')}" data-step="${i}"><span class="num">${i + 1}</span> ${label}</button>`;
  }).join('');
}

function goTo(s) {
  const max = getStepLabels().length - 1;
  s = Math.max(0, Math.min(max, s));
  if (s > state.step && !isStepValid(state.step)) return;
  state.step = s;
  renderSteps();
  renderActiveStep();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function isStepValid(step) {
  if (state.mode === 'cart') {
    if (step === 0) return state.items.every((it) => it.planDate && it.planSlot);
    if (step === 1) return state.details.name && state.details.email && state.details.phone;
  } else {
    switch (step) {
      case 0: return !!state.service;
      case 1: return !!state.date;
      case 2: return !!state.slot;
      case 3: return state.details.name && state.details.email && state.details.phone;
    }
  }
  return false;
}

// =========================================================
// RENDER ACTIVE STEP
// =========================================================
function renderActiveStep() {
  const root = document.getElementById('booking-steps-content');
  if (state.mode === 'cart') {
    if (state.step === 0) renderCartPlanningStep(root);
    else renderDetailsStep(root);
  } else {
    if (state.step === 0) renderClassicServiceStep(root);
    else if (state.step === 1) renderClassicDateStep(root);
    else if (state.step === 2) renderClassicSlotStep(root);
    else renderDetailsStep(root);
  }
  bindStepButtons();
}

function bindStepButtons() {
  document.querySelectorAll('[data-step-next]').forEach((b) => {
    const valid = isStepValid(state.step);
    b.disabled = !valid;
    b.style.opacity = valid ? '1' : '0.5';
    b.style.pointerEvents = valid ? 'auto' : 'none';
    b.addEventListener('click', () => goTo(state.step + 1), { once: true });
  });
  document.querySelectorAll('[data-step-prev]').forEach((b) => {
    b.addEventListener('click', () => goTo(state.step - 1), { once: true });
  });
}

// =========================================================
// CLASSIC MODE STEPS
// =========================================================
function renderClassicServiceStep(root) {
  root.innerHTML = `
    <div class="booking-step is-visible">
      <h2>Choisis ta prestation</h2>
      <p class="booking-step__hint">Tu pourras ajuster avec l'ingé son lors de la confirmation.</p>
      <div class="service-options">
        ${DATA.services.map((s) => `
          <button class="service-option ${state.service === s.id ? 'is-selected' : ''}" data-id="${s.id}">
            <div class="service-option__name">${s.name}</div>
            <div class="service-option__sub">${s.sub}</div>
            <div class="service-option__price">${MelodiaCart.format(s.base)} ${s.unit}</div>
          </button>
        `).join('')}
      </div>
      <div class="booking-actions">
        <div></div>
        <button class="btn btn--primary btn--lg" data-step-next>
          <span>Suivant</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
  `;
  root.querySelectorAll('.service-option').forEach((node) => {
    node.addEventListener('click', () => {
      state.service = node.dataset.id;
      renderActiveStep(); renderSteps(); renderSummary();
    });
  });
}

function renderClassicDateStep(root) {
  const cursor = state.calCursor.__classic;
  root.innerHTML = `
    <div class="booking-step is-visible">
      <h2>Choisis ta date</h2>
      <p class="booking-step__hint">Les points bleus indiquent les jours disponibles.</p>
      ${renderCalendarHTML('__classic', cursor.year, cursor.month, state.date)}
      <div class="booking-actions">
        <button class="btn btn--ghost btn--lg" data-step-prev>← Retour</button>
        <button class="btn btn--primary btn--lg" data-step-next>
          <span>Suivant</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
  `;
  bindCalendar('__classic', (iso) => {
    state.date = iso;
    state.slot = null;
    renderActiveStep(); renderSteps(); renderSummary();
    fetchAvailability(iso);  // déclenche le check des dispos backend
  });
}

function renderClassicSlotStep(root) {
  const service = DATA.services.find((s) => s.id === state.service);
  const duration = service?.duration || 0;
  root.innerHTML = `
    <div class="booking-step is-visible">
      <h2>Choisis ton créneau</h2>
      <p class="booking-step__hint">${duration > 0 ? `Créneaux adaptés à la durée de ta session (${duration}h).` : 'Rendez-vous court pour la remise/discussion.'} Tu peux étendre sur place si besoin.</p>
      <div class="slots">
        ${renderSlotsHTML(state.date, state.slot, duration)}
      </div>
      <div class="booking-actions">
        <button class="btn btn--ghost btn--lg" data-step-prev>← Retour</button>
        <button class="btn btn--primary btn--lg" data-step-next>
          <span>Suivant</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
  `;
  root.querySelectorAll('.slot:not(.is-unavailable)').forEach((node) => {
    node.addEventListener('click', () => {
      state.slot = node.dataset.id;
      state.slotTime = node.dataset.time;
      state.slotLabel = node.dataset.label;
      renderActiveStep(); renderSteps(); renderSummary();
    });
  });
}

// =========================================================
// CART MODE — Planning step (one calendar per item)
// =========================================================
function renderCartPlanningStep(root) {
  const allPlanned = state.items.every((it) => it.planDate && it.planSlot);
  root.innerHTML = `
    <div class="booking-step is-visible">
      <h2>Planifie tes services</h2>
      <p class="booking-step__hint">Tu as ${state.items.length} service${state.items.length > 1 ? 's' : ''} dans ton panier. Définis une date et un créneau pour chacun.</p>
      <div class="planning-list">
        ${state.items.map((it) => renderPlanningItemHTML(it)).join('')}
      </div>
      <div class="booking-actions">
        <a class="btn btn--ghost btn--lg" href="services.html">+ Ajouter un service</a>
        <button class="btn btn--primary btn--lg" data-step-next>
          <span>${allPlanned ? 'Continuer' : 'Planifie tous les services'}</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
  `;

  // Bind item headers (toggle accordion)
  root.querySelectorAll('.planning-item__head').forEach((h) => {
    h.addEventListener('click', () => {
      const id = h.closest('.planning-item').dataset.id;
      state.activeItemId = state.activeItemId === id ? null : id;
      renderActiveStep();
    });
  });

  // Bind remove buttons
  root.querySelectorAll('.planning-item__remove').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.closest('.planning-item').dataset.id;
      window.MelodiaCart.remove(id);
    });
  });

  // Bind calendars for active item
  if (state.activeItemId) {
    const cursor = state.calCursor[state.activeItemId];
    if (cursor) {
      bindCalendar(state.activeItemId, (iso) => {
        const item = state.items.find((i) => i.id === state.activeItemId);
        if (item) {
          item.planDate = iso;
          item.planSlot = null;
        }
        renderActiveStep(); renderSummary(); renderSteps();
        fetchAvailability(iso);  // déclenche le check des dispos backend
      });

      // Bind slot selection
      const item = state.items.find((i) => i.id === state.activeItemId);
      document.querySelectorAll(`#slots-${CSS.escape(state.activeItemId)} .slot:not(.is-unavailable)`).forEach((s) => {
        s.addEventListener('click', () => {
          item.planSlot = s.dataset.id;
          item.planSlotTime = s.dataset.time;
          item.planSlotLabel = s.dataset.label;
          // Auto-collapse and open next unplanned item
          const idx = state.items.findIndex((i) => i.id === state.activeItemId);
          const nextUnplanned = state.items.find((i, j) => j > idx && (!i.planDate || !i.planSlot));
          state.activeItemId = nextUnplanned ? nextUnplanned.id : null;
          renderActiveStep(); renderSummary(); renderSteps();
        });
      });
    }
  }
}

function renderPlanningItemHTML(item) {
  const isActive = state.activeItemId === item.id;
  const isPlanned = item.planDate && item.planSlot;

  let cursor = state.calCursor[item.id];
  if (!cursor) {
    const t = new Date();
    cursor = { year: t.getFullYear(), month: t.getMonth() };
    state.calCursor[item.id] = cursor;
  }

  const statusHTML = isPlanned
    ? `<span class="planning-item__status is-done">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5 9-11"/></svg>
         ${formatDateLabel(item.planDate)} · ${item.planSlotTime || ''}
       </span>`
    : `<span class="planning-item__status">À planifier</span>`;

  return `
    <article class="planning-item ${isActive ? 'is-open' : ''} ${isPlanned ? 'is-planned' : ''}" data-id="${item.id}">
      <header class="planning-item__head">
        <div class="planning-item__title">
          <div class="planning-item__name">${item.service}</div>
          <div class="planning-item__option">${item.option}${item.qty > 1 ? ` × ${item.qty}` : ''}</div>
        </div>
        ${statusHTML}
        <div class="planning-item__actions">
          <button class="planning-item__remove" aria-label="Retirer du panier" title="Retirer du panier">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
          </button>
          <span class="planning-item__chevron">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 5l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </div>
      </header>
      ${isActive ? `
        <div class="planning-item__body">
          ${renderCalendarHTML(item.id, cursor.year, cursor.month, item.planDate)}
          <div class="planning-item__slots">
            <p class="mono" style="font-size: 10px; color: var(--fg-low); margin-bottom: 12px;">${(item.duration || 0) > 0 ? `Créneau pour cette session (${item.duration}h)` : 'Rendez-vous pour cette prestation'}</p>
            <div class="slots" id="slots-${item.id}">
              ${renderSlotsHTML(item.planDate, item.planSlot, item.duration || 0)}
            </div>
          </div>
        </div>
      ` : ''}
    </article>
  `;
}

// =========================================================
// DETAILS STEP (shared)
// =========================================================
function renderDetailsStep(root) {
  root.innerHTML = `
    <div class="booking-step is-visible">
      <h2>Tes coordonnées</h2>
      <p class="booking-step__hint">On t'envoie la confirmation par email + WhatsApp.</p>

      <div class="field-row">
        <div class="field">
          <label for="field-name">Nom complet</label>
          <input id="field-name" type="text" required placeholder="Ton nom" value="${state.details.name}" />
        </div>
        <div class="field">
          <label for="field-phone">WhatsApp</label>
          <input id="field-phone" type="tel" required placeholder="+225 ..." value="${state.details.phone}" />
        </div>
      </div>

      <div class="field">
        <label for="field-email">Email</label>
        <input id="field-email" type="email" required placeholder="ton@email.com" value="${state.details.email}" />
      </div>

      <div class="field">
        <label for="field-project">À propos du projet (optionnel)</label>
        <textarea id="field-project" placeholder="Style, deadline, références sonores, ce que tu veux qu'on sache...">${state.details.project}</textarea>
      </div>

      <div class="booking-actions">
        <button class="btn btn--ghost btn--lg" data-step-prev>← Retour</button>
        <button class="btn btn--primary btn--lg" id="booking-submit">
          <span>Envoyer la demande</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
  `;
  ['name', 'email', 'phone', 'project'].forEach((k) => {
    const input = document.getElementById(`field-${k}`);
    if (!input) return;
    input.addEventListener('input', () => {
      state.details[k] = input.value;
      renderSummary(); bindStepButtons();
    });
  });
  document.getElementById('booking-submit')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (!isStepValid(state.step)) return;
    handleSubmit();
  });
}

// =========================================================
// CALENDAR (shared rendering)
// =========================================================
function renderCalendarHTML(scope, year, month, selectedIso) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = lastDay.getDate();
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // Lookup cache jours bloqués pour ce mois
  const monthKey = `${year}-${pad(month + 1)}`;
  const blockedCache = state.blockedDays[monthKey];
  const blockedDates = blockedCache?.dates || new Set();

  let cells = '';
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startOffset + 1;
    if (dayNum < 1 || dayNum > daysInMonth) {
      cells += `<button class="calendar__day is-outside" disabled></button>`;
      continue;
    }
    const iso = `${year}-${pad(month + 1)}-${pad(dayNum)}`;
    const d = new Date(year, month, dayNum);
    const classes = ['calendar__day'];
    if (d < today) { classes.push('is-past'); cells += `<button class="${classes.join(' ')}" disabled>${dayNum}</button>`; continue; }
    const unavail = DATA.unavailable[iso];
    if ((unavail && unavail.includes('all')) || blockedDates.has(iso)) {
      classes.push('is-unavailable');
      cells += `<button class="${classes.join(' ')}" disabled title="Jour bloqué">${dayNum}</button>`;
      continue;
    }
    classes.push('is-available');
    if (selectedIso === iso) classes.push('is-selected');
    cells += `<button class="${classes.join(' ')}" data-iso="${iso}" data-scope="${scope}">${dayNum}</button>`;
  }

  return `
    <div class="calendar">
      <div class="calendar__header">
        <div class="calendar__title">${MONTHS[month]} ${year}</div>
        <div class="calendar__nav">
          <button data-cal-prev="${scope}" aria-label="Mois précédent">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 1L3 7l6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button data-cal-next="${scope}" aria-label="Mois suivant">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="calendar__weekdays">
        <span>Lun</span><span>Mar</span><span>Mer</span><span>Jeu</span><span>Ven</span><span>Sam</span><span>Dim</span>
      </div>
      <div class="calendar__days">${cells}</div>
      <div class="calendar__legend">
        <span><span class="dot dot--available"></span>Dispo</span>
        <span><span class="dot dot--unavailable"></span>Indispo</span>
      </div>
    </div>
  `;
}

function bindCalendar(scope, onPick) {
  document.querySelectorAll(`[data-cal-prev="${scope}"]`).forEach((b) =>
    b.addEventListener('click', () => navCal(scope, -1)));
  document.querySelectorAll(`[data-cal-next="${scope}"]`).forEach((b) =>
    b.addEventListener('click', () => navCal(scope, +1)));
  document.querySelectorAll(`.calendar__day[data-scope="${scope}"]`).forEach((d) => {
    d.addEventListener('click', () => onPick(d.dataset.iso));
  });
  // Déclenche le fetch des jours bloqués pour le mois affiché
  const cursor = scope === '__classic' ? state.calCursor.__classic : state.calCursor[scope];
  if (cursor) fetchBlockedDays(cursor.year, cursor.month);
}

function navCal(scope, delta) {
  if (scope === '__classic') {
    state.calCursor.__classic.month += delta;
    if (state.calCursor.__classic.month < 0) { state.calCursor.__classic.month = 11; state.calCursor.__classic.year--; }
    if (state.calCursor.__classic.month > 11) { state.calCursor.__classic.month = 0; state.calCursor.__classic.year++; }
  } else {
    const c = state.calCursor[scope];
    c.month += delta;
    if (c.month < 0) { c.month = 11; c.year--; }
    if (c.month > 11) { c.month = 0; c.year++; }
  }
  renderActiveStep();
}

function renderSlotsHTML(dateIso, selectedSlot, duration) {
  const slots = generateSlots(duration || 0);

  // Si pas de date → tous les slots disabled (état initial)
  if (!dateIso) {
    return slots.map((s) => `
      <button class="slot is-unavailable" disabled>
        <div class="slot__time">${s.time}</div>
        <div class="slot__label">${s.label}</div>
      </button>
    `).join('');
  }

  // Lookup cache dispos backend
  const avail = state.availability[dateIso];

  // Loading state
  if (avail?.loading) {
    return `
      <div class="slots-state slots-state--loading" style="grid-column:1/-1;display:flex;align-items:center;justify-content:center;gap:12px;padding:32px;color:var(--fg-dim);">
        <div style="width:18px;height:18px;border:2px solid rgba(30,144,255,0.25);border-top-color:#1E90FF;border-radius:50%;animation:mlcspin 0.8s linear infinite;"></div>
        <span>Vérification des créneaux disponibles…</span>
        <style>@keyframes mlcspin{to{transform:rotate(360deg)}}</style>
      </div>
    `;
  }

  // Error state
  if (avail?.error) {
    return `
      <div class="slots-state slots-state--error" style="grid-column:1/-1;padding:24px;color:var(--danger,#FF4D5E);text-align:center;border:1px solid rgba(255,77,94,0.3);border-radius:12px;background:rgba(255,77,94,0.06);">
        <p style="margin-bottom:8px;">Impossible de récupérer les disponibilités.</p>
        <button class="btn btn--ghost" onclick="window.__mlcRetryAvail && window.__mlcRetryAvail('${dateIso}')">Réessayer</button>
      </div>
    `;
  }

  // Jour totalement bloqué (vacances)
  if (avail?.blockedAll) {
    return `
      <div class="slots-state slots-state--blocked" style="grid-column:1/-1;padding:32px;color:var(--fg-dim);text-align:center;border:1px solid var(--glass-border,rgba(255,255,255,0.12));border-radius:12px;background:rgba(255,255,255,0.03);">
        <p style="font-family:'Anton',sans-serif;font-size:22px;text-transform:uppercase;letter-spacing:0.3px;color:var(--fg);margin-bottom:6px;">Studio fermé ce jour</p>
        <p style="font-size:13px;">Le studio est complet ou en pause cette date. Choisis un autre jour dans le calendrier.</p>
      </div>
    `;
  }

  const occupied = avail?.occupied || [];
  // Compat legacy : DATA.unavailable hardcodé
  const legacyUnavail = DATA.unavailable[dateIso] || [];
  const dayBlocked = legacyUnavail.includes('all');

  return slots.map((s) => {
    const isOccupied = isSlotOccupied(s.id, occupied);
    const isUnav = dayBlocked || isOccupied;
    const isSel = !isUnav && selectedSlot === s.id;
    return `
      <button class="slot ${isUnav ? 'is-unavailable' : ''} ${isSel ? 'is-selected' : ''}" data-id="${s.id}" data-time="${s.time}" data-label="${s.label}" ${isUnav ? 'disabled' : ''}>
        <div class="slot__time">${s.time}</div>
        <div class="slot__label">${s.label}${isOccupied ? ' · Déjà pris' : isUnav ? ' · Indisponible' : ''}</div>
      </button>
    `;
  }).join('');
}

// Helper exposé pour le bouton "Réessayer"
window.__mlcRetryAvail = function(dateIso) {
  if (state.availability[dateIso]) delete state.availability[dateIso];
  fetchAvailability(dateIso);
};

// =========================================================
// SUMMARY
// =========================================================
function renderSummary() {
  const root = document.getElementById('booking-summary');

  if (state.mode === 'cart') {
    const total = state.items.reduce((s, i) => s + i.price * i.qty, 0);
    root.innerHTML = `
      <h3>Récapitulatif</h3>
      <div class="summary-items">
        ${state.items.map((it) => {
          const planned = it.planDate && it.planSlot;
          return `
            <div class="summary-item ${planned ? 'is-planned' : ''}">
              <div class="summary-item__head">
                <div class="summary-item__name">${it.service}</div>
                <div class="summary-item__price">${MelodiaCart.format(it.price * it.qty)}</div>
              </div>
              <div class="summary-item__option">${it.option}${it.qty > 1 ? ` × ${it.qty}` : ''}</div>
              <div class="summary-item__plan">
                ${planned
                  ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5 9-11"/></svg> ${formatDateLabel(it.planDate)} · ${it.planSlotTime || ''}`
                  : '<span style="color: var(--fg-low);">— à planifier</span>'}
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="summary-total">
        <span class="label">Total estimé</span>
        <span class="num">${MelodiaCart.format(total)}</span>
      </div>
      <p class="mono" style="font-size: 10px; color: var(--fg-low); line-height: 1.5;">Tarif estimé. Le montant final sera confirmé après validation par notre équipe.</p>
    `;
  } else {
    const service = DATA.services.find((s) => s.id === state.service);
    const dateLabel = state.date ? formatDateLabel(state.date) : null;
    const total = service ? service.base : 0;

    root.innerHTML = `
      <h3>Récapitulatif</h3>
      <div class="summary-row">
        <span class="label">Prestation</span>
        <span class="value ${service ? '' : 'empty'}">${service ? service.name : 'À choisir'}</span>
      </div>
      <div class="summary-row">
        <span class="label">Date</span>
        <span class="value ${dateLabel ? '' : 'empty'}">${dateLabel || 'À choisir'}</span>
      </div>
      <div class="summary-row">
        <span class="label">Créneau</span>
        <span class="value ${state.slotTime ? '' : 'empty'}">${state.slotTime || 'À choisir'}</span>
      </div>
      <div class="summary-total">
        <span class="label">Total estimé</span>
        <span class="num">${MelodiaCart.format(total)}</span>
      </div>
      <p class="mono" style="font-size: 10px; color: var(--fg-low); line-height: 1.5;">Tarif estimé. Le montant final sera confirmé selon la prestation exacte et la durée réelle.</p>
    `;
  }
}

// =========================================================
// HELPERS
// =========================================================
function pad(n) { return String(n).padStart(2, '0'); }
function formatDateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

// =========================================================
// SUBMIT
// =========================================================
async function handleSubmit() {
  const payload = state.mode === 'cart'
    ? {
        mode: 'cart',
        items: state.items.map((it) => {
          const svc = DATA.services.find(s => s.id === it.service);
          return {
            service: it.service, option: it.option, qty: it.qty, price: it.price,
            duration: svc?.duration || it.duration || 1,
            date: it.planDate, planDate: it.planDate,
            slot: it.planSlot, slotTime: it.planSlotTime, planSlotTime: it.planSlotTime,
            slotLabel: it.planSlotLabel,
          };
        }),
        details: state.details,
        createdAt: new Date().toISOString(),
      }
    : {
        mode: 'classic',
        service: state.service,
        date: state.date,
        slot: state.slot, slotTime: state.slotTime, slotLabel: state.slotLabel,
        duration: DATA.services.find(s => s.id === state.service)?.duration || 1,
        details: state.details,
        createdAt: new Date().toISOString(),
      };

  // UI : passage en mode "envoi en cours"
  const main = document.getElementById('booking-main');
  main.innerHTML = `
    <div style="text-align:center;padding:4rem 2rem;display:flex;flex-direction:column;gap:1.5rem;align-items:center;">
      <div class="mlc-spinner" style="width:48px;height:48px;border:3px solid rgba(30,144,255,0.25);border-top-color:#1E90FF;border-radius:50%;animation:mlcspin 0.8s linear infinite;"></div>
      <p style="color:var(--fg-dim);">Envoi de ta demande...</p>
      <style>@keyframes mlcspin{to{transform:rotate(360deg)}}</style>
    </div>
  `;

  try {
    const res = await fetch('/api/create-booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    // SUCCESS — clear cart si mode cart
    if (state.mode === 'cart') window.MelodiaCart.clear();

    const summaryText = state.mode === 'cart'
      ? `${state.items.length} service${state.items.length > 1 ? 's' : ''} planifié${state.items.length > 1 ? 's' : ''}`
      : `ta session ${DATA.services.find(s => s.id === state.service)?.name.toLowerCase() || 'studio'} du ${formatDateLabel(state.date)}`;

    const refsText = (data.created || []).map(c => c.ref).filter(Boolean).join(' · ');
    const fid = data.fidelite || {};

    // Bloc fidélité custom selon le contexte
    let fidBlock = '';
    if (fid.tier) {
      const tierColors = { Bronze: '#CD7F32', Argent: '#B8C5D6', Gold: '#E5B544', Platinum: '#E5E4E2' };
      const tierColor = tierColors[fid.tier] || '#1E90FF';
      let fidTitle = '';
      let fidMsg = '';
      if (fid.isNew) {
        fidTitle = '✨ Bienvenue dans la family Melodia';
        fidMsg = `Ta carte fidélité <b style="color:${tierColor}">${fid.tier}</b> est créée. 1 point offert à l'inscription, 4 séances de plus pour passer Argent et débloquer −5%.`;
      } else if (fid.tierUpgraded) {
        fidTitle = `🎉 Promotion ${fid.tierBefore} → ${fid.tier} !`;
        fidMsg = `Bravo, tu débloques le statut <b style="color:${tierColor}">${fid.tier}</b> et la remise <b>−${fid.remise}%</b> sur tes prochaines réservations.`;
      } else if (fid.sessionUnlocked) {
        fidTitle = '⭐ Séance offerte débloquée !';
        fidMsg = `Tu as atteint 5 points actifs. Ta prochaine séance est <b>offerte</b> ! On te confirme par message.`;
      } else if (fid.progression && !fid.progression.isMax) {
        fidTitle = `🎖️ Niveau ${fid.tier}`;
        fidMsg = `${fid.pointsActifs}/5 points actifs · ${fid.progression.needed} séance${fid.progression.needed > 1 ? 's' : ''} de plus pour passer <b style="color:${tierColor}">${fid.progression.nextTier}</b>.`;
      } else {
        fidTitle = `💎 Niveau ${fid.tier} (max)`;
        fidMsg = `Statut maximum atteint. Remise <b>−${fid.remise}%</b> appliquée sur cette réservation et les suivantes.`;
      }
      fidBlock = `
        <div style="margin-top:8px;padding:18px 24px;border:1px solid ${tierColor};border-radius:14px;background:linear-gradient(135deg,rgba(30,144,255,0.06),transparent);max-width:520px;">
          <p style="font-family:'Anton',sans-serif;font-size:18px;text-transform:uppercase;letter-spacing:0.4px;color:${tierColor};margin:0 0 6px;">${fidTitle}</p>
          <p style="font-size:13px;color:var(--fg-dim);line-height:1.55;margin:0;">${fidMsg}</p>
        </div>
      `;
    }

    const waUrl = data.whatsapp?.url;
    const waButton = waUrl ? `
      <a href="${waUrl}" target="_blank" rel="noopener" class="btn btn--lg" style="background:#25D366;color:#fff;border:none;display:inline-flex;align-items:center;gap:10px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
        <span>Reçois ton récap sur WhatsApp</span>
      </a>
    ` : '';

    main.innerHTML = `
      <div style="text-align:center;padding:4rem 2rem;display:flex;flex-direction:column;gap:1.5rem;align-items:center;">
        <div style="width:72px;height:72px;border-radius:50%;background:rgba(30,144,255,0.15);display:flex;align-items:center;justify-content:center;border:1px solid rgba(30,144,255,0.4);">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5 9-11" stroke="#1E90FF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <h2 class="h-display" style="margin:0;">Demande envoyée.</h2>
        <p style="max-width:480px;color:var(--fg-dim);line-height:1.6;">Merci ${state.details.name}, on revient vers toi sous 24h pour confirmer ${summaryText}.</p>
        ${refsText ? `<p style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.15em;color:var(--fg-low);text-transform:uppercase;">Référence : ${refsText}</p>` : ''}
        ${fidBlock}
        <div style="margin-top:8px;padding:14px 20px;border:1px solid rgba(255,193,7,0.3);background:rgba(255,193,7,0.06);border-radius:12px;max-width:520px;display:flex;gap:10px;align-items:flex-start;text-align:left;">
          <span style="font-size:18px;flex-shrink:0;">📧</span>
          <p style="font-size:12.5px;color:var(--fg-dim);line-height:1.55;margin:0;">
            Un email de confirmation arrive d'ici quelques minutes.
            <b style="color:var(--fg);">Pense à vérifier tes spams</b> si tu ne le vois pas (et marque-nous comme "non spam" pour les prochains 🙏).
          </p>
        </div>
        ${waButton ? `<div style="margin-top:8px;">${waButton}<p style="font-size:11px;color:var(--fg-low);margin-top:8px;">Plus rapide : ton récap arrive sur WhatsApp Melodia en 1 clic.</p></div>` : ''}
        <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-top:8px;">
          <a href="../index.html" class="btn btn--primary btn--lg">Retour à l'accueil</a>
          <a href="fidelite.html" class="btn btn--ghost btn--lg">Voir ma fidélité</a>
        </div>
      </div>
    `;
  } catch (e) {
    console.error('[booking] submit failed:', e);
    main.innerHTML = `
      <div style="text-align:center;padding:4rem 2rem;display:flex;flex-direction:column;gap:1.5rem;align-items:center;">
        <div style="width:72px;height:72px;border-radius:50%;background:rgba(255,77,94,0.15);display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,77,94,0.4);">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M12 8v5M12 17.01v-.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke="#FF4D5E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <h2 class="h-display" style="margin:0;">Un souci est survenu.</h2>
        <p style="max-width:520px;color:var(--fg-dim);line-height:1.6;">${e.message || 'Réessaie dans un instant. Si le problème persiste, écris-nous directement sur WhatsApp.'}</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;">
          <button class="btn btn--primary btn--lg" onclick="location.reload()">Réessayer</button>
          <a href="https://wa.me/2250703387738" class="btn btn--ghost btn--lg" target="_blank">Continuer sur WhatsApp</a>
        </div>
      </div>
    `;
  }
}

// Re-bind chip clicks to allow navigating to past steps
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.booking-step__chip');
  if (!chip) return;
  const target = parseInt(chip.dataset.step, 10);
  if (!Number.isNaN(target) && target < state.step) goTo(target);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
