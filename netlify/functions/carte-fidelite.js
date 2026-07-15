// =====================================================
// GET /api/carte-fidelite?phone=225XXXXXXXXXX&t=<jeton>
// → la carte fidélité du client en PNG (envoyée sur WhatsApp en image).
// Jeton signé obligatoire (voir carteToken dans _lib) : on ne peut pas
// consulter la carte d'un autre numéro sans le secret.
// =====================================================

const { airtable, airtableTable, TABLES, carteToken } = require('./_lib');
const { renderCarteFidelite } = require('./_carte');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const q = event.queryStringParameters || {};
  const phone = (q.phone || '').replace(/\D/g, '');
  if (!phone || !/^\d{8,15}$/.test(phone)) return { statusCode: 400, body: 'Bad request' };
  if ((q.t || '') !== carteToken(phone)) return { statusCode: 403, body: 'Forbidden' };

  // Client Airtable (même lookup que le bot : 8 derniers chiffres)
  const last8 = phone.slice(-8);
  const filter = `OR(FIND('${last8}', {Téléphone}), {Téléphone} = '+${phone}')`;
  const found = await airtable(
    `${airtableTable(TABLES.CLIENTS)}?filterByFormula=${encodeURIComponent(filter)}&maxRecords=1`,
    { method: 'GET' }
  ).catch(() => ({ records: [] }));
  const client = found.records?.[0];
  if (!client) return { statusCode: 404, body: 'Client inconnu' };

  const f = client.fields || {};
  const tier = f['Tier'] || 'Bronze';
  const png = await renderCarteFidelite({
    nom: f['Nom complet'] || 'Melodia Family',
    tier,
    points: f['Points actifs'] || 0,
    seances: f['Séances totales'] || 0,
    offertes: Math.max(0, (f['Sessions offertes gagnées'] || 0) - (f['Sessions offertes utilisées'] || 0)),
    remise: { Argent: 5, Gold: 10, Platinum: 15 }[tier] || 0,
    phone,
  });

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'image/png',
      // les points évoluent → pas de cache long
      'Cache-Control': 'no-cache, max-age=0',
    },
    body: png.toString('base64'),
    isBase64Encoded: true,
  };
};
