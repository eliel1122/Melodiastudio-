/* =========================================================
   MELODIA STUDIO — Hero micro animation
   Scroll-driven image sequence (Neumann U87 decomposition)
   ========================================================= */

const FRAME_COUNT = 36;
const FRAME_PATH = (i) => `assets/frames/mic_${String(i).padStart(3, '0')}.webp`;

const canvas = document.getElementById('mic-canvas');
if (!canvas) throw new Error('mic-canvas not found');

const stage = canvas.parentElement;
const ctx = canvas.getContext('2d', { alpha: true });

// =========================================================
// PRELOAD all frames in parallel
// =========================================================
const frames = new Array(FRAME_COUNT);
let loadedCount = 0;

function loadFrame(i) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      frames[i] = img;
      loadedCount++;
      // Once first frame is in, paint immediately (avoid blank canvas)
      if (i === 0) draw(0);
      resolve();
    };
    img.onerror = () => {
      console.warn('[melodia] frame failed:', i);
      resolve();
    };
    img.src = FRAME_PATH(i);
  });
}

const preload = Promise.all(
  Array.from({ length: FRAME_COUNT }, (_, i) => loadFrame(i))
);

// =========================================================
// CANVAS — DPR-aware
// =========================================================
function resizeCanvas() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw(currentFrame);
}
const ro = new ResizeObserver(resizeCanvas);
ro.observe(stage);

// =========================================================
// DRAW one frame, centered and fit-contain
// =========================================================
let currentFrame = 0;

function draw(idx) {
  const i = Math.max(0, Math.min(FRAME_COUNT - 1, Math.round(idx)));
  const img = frames[i];
  if (!img) return;

  const w = stage.clientWidth;
  const h = stage.clientHeight;

  ctx.clearRect(0, 0, w, h);

  // Fit-contain — biased upward so the mic head sits near the H1 baseline
  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight) * 0.95;
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const dx = (w - dw) / 2;
  const dy = (h - dh) * 0.12; // 0 = top, 0.5 = center. Lower = higher.
  ctx.drawImage(img, dx, dy, dw, dh);

  currentFrame = i;
}

// =========================================================
// POINTER PARALLAX + IDLE FLOAT
// Applied via CSS transform on the canvas itself
// =========================================================
const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
window.addEventListener('pointermove', (e) => {
  const rect = stage.getBoundingClientRect();
  if (e.clientY < rect.top - 240 || e.clientY > rect.bottom + 240) return;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  pointer.tx = (e.clientX - cx) / rect.width;
  pointer.ty = (e.clientY - cy) / rect.height;
});

function tickFloat() {
  pointer.x += (pointer.tx - pointer.x) * 0.06;
  pointer.y += (pointer.ty - pointer.y) * 0.06;
  const t = performance.now() * 0.001;
  const floatY = Math.sin(t * 0.8) * 4; // 4px float
  const floatX = Math.cos(t * 0.5) * 2;
  canvas.style.transform = `translate3d(${pointer.x * 18 + floatX}px, ${pointer.y * 10 + floatY}px, 0) rotateZ(${pointer.x * 0.6}deg)`;
  requestAnimationFrame(tickFloat);
}
tickFloat();

// =========================================================
// SCROLL — drive frame index
// =========================================================
const state = { progress: 0 };

function setupScroll() {
  if (!window.gsap || !window.ScrollTrigger) {
    return setTimeout(setupScroll, 80);
  }
  const { gsap, ScrollTrigger } = window;
  gsap.registerPlugin(ScrollTrigger);

  const storyEl = document.getElementById('story');
  if (!storyEl) {
    console.warn('[melodia] #story not found');
    return;
  }

  // Decomposition finishes FAST — within ~50% of one viewport-height of scroll.
  // This means the mic is still well in view when fully decomposed.
  ScrollTrigger.create({
    trigger: 'body',
    start: 0,
    end: () => window.innerHeight * 0.5,
    scrub: 0.4,
    onUpdate: (self) => {
      state.progress = self.progress;
      const idx = state.progress * (FRAME_COUNT - 1);
      draw(idx);
    },
    invalidateOnRefresh: true,
  });

  // Story step activation
  document.querySelectorAll('.story__step').forEach((el) => {
    ScrollTrigger.create({
      trigger: el,
      start: 'top 75%',
      end: 'bottom 25%',
      onToggle: ({ isActive }) => el.classList.toggle('is-active', isActive),
    });
  });

  preload.then(() => {
    resizeCanvas();
    ScrollTrigger.refresh();
  });

  // Refresh on full page load (fonts may shift heights)
  window.addEventListener('load', () => ScrollTrigger.refresh());
}

resizeCanvas();
setupScroll();

window.addEventListener('beforeunload', () => ro.disconnect());
