// =====================================================
// GET /api/qr?ref=MEL-XXXXXX-XXXX          → QR "pass studio" (PNG)
// GET /api/qr?type=fidelity&phone=225XXXXX → QR carte fidélité (PNG)
// Même cible que les QR du site : la Console Studio (scan staff).
// =====================================================

const QRCode = require('qrcode');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const q = event.queryStringParameters || {};

  let target = null;
  if (q.ref && /^MEL-[A-Z0-9-]{4,30}$/i.test(q.ref)) {
    target = `https://melodiastudio.pro/pages/console.html?type=booking&ref=${encodeURIComponent(q.ref)}`;
  } else if (q.type === 'fidelity' && q.phone && /^\d{8,15}$/.test(q.phone)) {
    target = `https://melodiastudio.pro/pages/console.html?type=fidelity&phone=${q.phone}`;
  }
  if (!target) return { statusCode: 400, body: 'Bad request' };

  const png = await QRCode.toBuffer(target, {
    type: 'png',
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'image/png',
      // le contenu d'un QR pour une réf donnée ne change jamais
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: png.toString('base64'),
    isBase64Encoded: true,
  };
};
