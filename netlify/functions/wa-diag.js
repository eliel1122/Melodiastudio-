// Diagnostic temporaire WhatsApp Cloud API — À SUPPRIMER après debug.
// GET /api/wa-diag?key=<clé> : interroge Graph API avec les env vars
// pour vérifier ce que le token voit (WABA, numéros, phone_id).

const DIAG_KEY = 'diag-6cc234f65c157508';

exports.handler = async (event) => {
  if (event.queryStringParameters?.key !== DIAG_KEY) {
    return { statusCode: 403, body: 'Forbidden' };
  }
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const wabaId = '974976515589962';

  const call = async (path) => {
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: await res.json() };
    } catch (e) { return { error: e.message }; }
  };

  const out = {
    env: { hasToken: !!token, tokenPrefix: token ? token.slice(0, 12) : null, phoneId },
    me: await call('me'),
    phone: await call(`${phoneId}?fields=display_phone_number,verified_name,platform_type,status`),
    wabaPhones: await call(`${wabaId}/phone_numbers?fields=id,display_phone_number,status,platform_type`),
    debugToken: await call(`debug_token?input_token=${encodeURIComponent(token || '')}`),
  };
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(out, null, 2),
  };
};
