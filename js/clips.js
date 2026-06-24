/* =====================================================
   MELODIA — Clips portfolio (vidéos lazy load)
   - Charge la vidéo seulement quand elle entre dans le viewport
   - Pause hors viewport pour économiser CPU / batterie / data mobile
   - Si vidéo absente : reste en mode fallback "Clip à venir"
   ===================================================== */

(function () {
  'use strict';

  function init() {
    const videos = document.querySelectorAll('.clip-card__video[data-src]');
    if (!videos.length) return;

    // Fallback si IntersectionObserver pas dispo : charge tout direct
    if (!('IntersectionObserver' in window)) {
      videos.forEach(loadVideo);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const video = entry.target;
        if (entry.isIntersecting) {
          if (!video.src) loadVideo(video);
          if (video.readyState >= 2) video.play().catch(() => {});
        } else if (!video.paused) {
          video.pause();
        }
      });
    }, { threshold: 0.25, rootMargin: '50px' });

    videos.forEach((v) => observer.observe(v));
  }

  function loadVideo(video) {
    const src = video.dataset.src;
    if (!src) return;
    const card = video.closest('.clip-card');

    // Tester l'existence du fichier via HEAD
    fetch(src, { method: 'HEAD' })
      .then((res) => {
        if (!res.ok) {
          // Fichier vidéo pas encore présent → garde le fallback "Clip à venir"
          if (card) card.classList.add('clip-card--pending');
          return;
        }
        video.src = src;
        video.load();
        video.addEventListener('loadeddata', () => {
          if (card) card.classList.add('clip-card--ready');
          video.play().catch(() => {});
        }, { once: true });
        video.addEventListener('error', () => {
          if (card) card.classList.add('clip-card--pending');
        }, { once: true });
      })
      .catch(() => {
        if (card) card.classList.add('clip-card--pending');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
