/* =========================================================
   MELODIA STUDIO — Studio Tour (panorama interactif)
   Combines:
     - Scroll-driven scrubbing (frames update on scroll)
     - Manual slider drag (frames update on user input)
   Both controllers stay in sync.

   When real frames are available, drop them in
   /assets/studio-frames/ as studio_001.webp … studio_NNN.webp
   and set FRAME_COUNT accordingly. Until then a stylised
   gradient placeholder reacts to the slider so the user can
   feel the interaction.
   ========================================================= */

(() => {
  const FRAME_COUNT = 72;
  const FRAME_PATH = (i) => `assets/studio-frames/studio_${String(i).padStart(3, '0')}.webp`;

  const stage = document.getElementById('studio-tour');
  if (!stage) return;
  const canvas = document.getElementById('studio-tour-canvas');
  const slider = document.getElementById('studio-tour-slider');
  const placeholder = document.getElementById('studio-tour-placeholder');
  const progressLabel = document.getElementById('studio-tour-progress');
  if (!canvas || !slider) return;

  const ctx = canvas.getContext('2d', { alpha: true });

  // State
  const state = {
    progress: 0,      // 0..1, the truth value
    fromScroll: 0,    // last scroll-derived progress
    fromSlider: 0,    // last slider-derived progress
    lastSource: 'none',
    frames: [],
    loaded: 0,
  };

  // ---------- Preload frames
  let preload = Promise.resolve();
  if (FRAME_COUNT > 0) {
    // Update placeholder text to "Chargement..." while frames stream in
    const phText = placeholder.querySelector('p');
    if (phText) phText.textContent = 'Chargement de la visite…';
    const hintEl = placeholder.querySelector('.studio-tour__placeholder-hint');
    if (hintEl) hintEl.remove();

    state.frames = new Array(FRAME_COUNT);
    const promises = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const img = new Image();
      img.decoding = 'async';
      const p = new Promise((res) => {
        img.onload = () => {
          state.frames[i] = img;
          state.loaded++;
          // Repaint on the first frame so user sees content ASAP
          if (i === 0) draw();
          res();
        };
        img.onerror = res;
      });
      img.src = FRAME_PATH(i);
      promises.push(p);
    }
    preload = Promise.all(promises).then(() => {
      // Fade out placeholder once everything is loaded
      placeholder.style.transition = 'opacity 0.5s ease';
      placeholder.style.opacity = '0';
      setTimeout(() => { placeholder.style.display = 'none'; }, 600);
      draw();
    });
  }

  // ---------- Canvas size
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // ---------- Draw current frame (or placeholder)
  function draw() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    if (state.frames.length > 0) {
      const idx = Math.max(0, Math.min(FRAME_COUNT - 1, Math.round(state.progress * (FRAME_COUNT - 1))));
      const img = state.frames[idx];
      if (img) {
        // cover-fit
        const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
        const dw = img.naturalWidth * scale;
        const dh = img.naturalHeight * scale;
        ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      }
    } else {
      // Stylised placeholder — gradient that "pans" with progress
      drawPlaceholder(w, h, state.progress);
    }
  }

  function drawPlaceholder(w, h, p) {
    // Background gradient that shifts hue/position with progress
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    const blue = 200; // cabine cool blue
    const teal = 180; // control room warmer teal
    const baseHue = blue + (teal - blue) * p;
    gradient.addColorStop(0, `hsl(${baseHue - 10}, 70%, 12%)`);
    gradient.addColorStop(0.5, `hsl(${baseHue}, 60%, 18%)`);
    gradient.addColorStop(1, `hsl(${baseHue + 10}, 70%, 12%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    // A second radial highlight that pans horizontally with progress
    const cx = w * (0.15 + p * 0.7);
    const cy = h * 0.45;
    const radius = Math.max(w, h) * 0.5;
    const radial = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    radial.addColorStop(0, 'rgba(30, 144, 255, 0.30)');
    radial.addColorStop(0.5, 'rgba(30, 144, 255, 0.08)');
    radial.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, w, h);

    // Subtle scan lines for a "studio video" feel
    ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
    for (let y = 0; y < h; y += 3) {
      ctx.fillRect(0, y, w, 1);
    }
  }

  // ---------- Update truth + UI
  function setProgress(p, source) {
    p = Math.max(0, Math.min(1, p));
    state.progress = p;
    state.lastSource = source;
    if (source !== 'slider') {
      slider.value = Math.round(p * 100);
    }
    if (progressLabel) progressLabel.textContent = Math.round(p * 100);
    draw();
  }

  // ---------- Slider input (manual control)
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value) / 100;
    state.fromSlider = v;
    setProgress(v, 'slider');
  });

  // Scroll-driven animation removed — only the slider controls the panorama now.

  // ---------- First paint
  resize();
  preload.then(resize);
})();
