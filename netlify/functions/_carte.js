// =====================================================
// Rendu de la carte fidélité Melodia en PNG (1200×720)
// satori (JSX-like → SVG) + resvg (SVG → PNG), zéro navigateur.
// Utilisée par /api/carte-fidelite (envoi WhatsApp en image).
// =====================================================

const satori = require('satori').default;
const { Resvg } = require('@resvg/resvg-js');
const QRCode = require('qrcode');
const { ANTON_B64, MONO_B64, LOGO_B64 } = require('./_cardassets');

const BG = '#08080C';
const FG = '#F5F5F7';
const DIM = '#A8A8B5';
const ACCENT = '#1E90FF';
const DANGER = '#FF4D5E';
const TIER_COLORS = { Bronze: '#CD8A5C', Argent: '#C7C9D1', Gold: '#F5C043', Platinum: '#7FD4FF' };

const el = (type, props, ...children) => ({
  type,
  props: { ...props, children: children.length <= 1 ? children[0] : children },
});

/**
 * data = { nom, tier, points (0-4), seances, offertes (dispo), remise, phone }
 * Retourne un Buffer PNG.
 */
async function renderCarteFidelite(data) {
  const { nom, tier, points, seances, offertes, remise, phone } = data;
  const tierColor = TIER_COLORS[tier] || TIER_COLORS.Bronze;
  const qrDataUri = await QRCode.toDataURL(
    `https://melodiastudio.pro/pages/console.html?type=fidelity&phone=${phone}`,
    { width: 300, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#08080C', light: '#FFFFFF' } }
  );

  // pastilles de points (5)
  const dots = Array.from({ length: 5 }, (_, i) =>
    el('div', {
      style: {
        width: 46, height: 46, borderRadius: 23, display: 'flex',
        backgroundColor: i < points ? ACCENT : 'transparent',
        border: `3px solid ${i < points ? ACCENT : '#3A3D4D'}`,
        boxShadow: i < points ? `0 0 18px ${ACCENT}` : 'none',
      },
    })
  );

  const offerteLine = offertes > 0
    ? el('div', { style: { display: 'flex', alignItems: 'center' } },
        el('div', { style: { display: 'flex', width: 22, height: 22, borderRadius: 11, backgroundColor: DANGER, boxShadow: `0 0 14px ${DANGER}`, marginRight: 16 } }),
        el('div', { style: { display: 'flex', color: DANGER, fontFamily: 'Mono', fontSize: 30 } },
          `${offertes} SÉANCE${offertes > 1 ? 'S' : ''} OFFERTE${offertes > 1 ? 'S' : ''} À UTILISER`))
    : el('div', { style: { display: 'flex', color: DIM, fontFamily: 'Mono', fontSize: 28 } },
        `ENCORE ${5 - points} POINT${5 - points > 1 ? 'S' : ''} → 1 SÉANCE OFFERTE`);

  const tree = el('div', {
    style: {
      width: 1200, height: 720, display: 'flex', flexDirection: 'column',
      backgroundColor: BG, color: FG, padding: 56, position: 'relative',
      backgroundImage: `radial-gradient(circle at 8% 0%, rgba(30,144,255,.22), transparent 55%), radial-gradient(circle at 100% 110%, rgba(255,77,94,.16), transparent 45%)`,
    },
  },
    // header : logo + label
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      el('img', { src: `data:image/png;base64,${LOGO_B64}`, width: 236, height: 123 }),
      el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' } },
        el('div', { style: { display: 'flex', fontFamily: 'Mono', fontSize: 27, letterSpacing: 8, color: ACCENT } }, '// CARTE FIDÉLITÉ'),
        el('div', { style: { display: 'flex', fontFamily: 'Mono', fontSize: 21, letterSpacing: 5, color: DIM, marginTop: 10 } }, 'MELODIA FAMILY'),
      ),
    ),
    // corps : infos + QR
    el('div', { style: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'space-between', marginTop: 8 } },
      el('div', { style: { display: 'flex', flexDirection: 'column' } },
        el('div', { style: { display: 'flex', fontFamily: 'Anton', fontSize: 78, textTransform: 'uppercase', maxWidth: 760 } }, nom),
        el('div', { style: { display: 'flex', alignItems: 'center', marginTop: 22 } },
          el('div', {
            style: {
              display: 'flex', fontFamily: 'Mono', fontSize: 30, letterSpacing: 4, color: BG,
              backgroundColor: tierColor, borderRadius: 999, padding: '10px 30px',
            },
          }, tier.toUpperCase()),
          remise
            ? el('div', { style: { display: 'flex', fontFamily: 'Mono', fontSize: 28, color: tierColor, marginLeft: 22 } }, `−${remise}% SUR TES SÉANCES`)
            : null,
        ),
        el('div', { style: { display: 'flex', alignItems: 'center', marginTop: 44 } }, ...dots,
          el('div', { style: { display: 'flex', fontFamily: 'Mono', fontSize: 34, color: FG, marginLeft: 24 } }, `${points}/5`),
        ),
        el('div', { style: { display: 'flex', marginTop: 24 } }, offerteLine),
        el('div', { style: { display: 'flex', fontFamily: 'Mono', fontSize: 24, color: DIM, marginTop: 18 } }, `${seances} SÉANCE${seances > 1 ? 'S' : ''} AU COMPTEUR`),
      ),
      // QR fidélité (scan staff à l'accueil)
      el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center' } },
        el('div', { style: { display: 'flex', backgroundColor: '#FFFFFF', borderRadius: 18, padding: 14 } },
          el('img', { src: qrDataUri, width: 218, height: 218 }),
        ),
        el('div', { style: { display: 'flex', fontFamily: 'Mono', fontSize: 19, letterSpacing: 3, color: DIM, marginTop: 14 } }, 'SCAN À L’ACCUEIL'),
      ),
    ),
    // footer
    el('div', { style: { display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #23263A', paddingTop: 24 } },
      el('div', { style: { display: 'flex', fontFamily: 'Mono', fontSize: 23, letterSpacing: 3, color: DIM } }, 'MELODIASTUDIO.PRO'),
      el('div', { style: { display: 'flex', fontFamily: 'Mono', fontSize: 23, letterSpacing: 3, color: ACCENT } }, '+225 07 03 38 77 38'),
    ),
  );

  const svg = await satori(tree, {
    width: 1200,
    height: 720,
    fonts: [
      { name: 'Anton', data: Buffer.from(ANTON_B64, 'base64'), weight: 400, style: 'normal' },
      { name: 'Mono', data: Buffer.from(MONO_B64, 'base64'), weight: 400, style: 'normal' },
    ],
  });

  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
  return resvg.render().asPng();
}

module.exports = { renderCarteFidelite };
