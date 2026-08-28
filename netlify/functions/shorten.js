// netlify/functions/shorten.js
//
// Creates a short id for a share-result payload and stores it in the same
// Upstash Redis instance already used by feed.js. The frontend calls this
// right after a calculation finishes (same background-precache pattern as
// the share-card PNG), caching the returned id so that by the time the
// user clicks "Share" it's already available — no visible delay, and the
// resulting link is a short "/r/<id>" instead of a long query string full
// of encoded characters.
//
// POST body: JSON object with the same fields og-image.js/share.js expect
// as query params (s, n, m, d, r, mu, tl, g, sp, lang — whatever is set).
// Response: { id } on success.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days — plenty of time for a link to circulate

function randomId(len = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!REDIS_URL || !REDIS_TOKEN) {
    // Redis isn't configured — caller falls back to the long-form share
    // link, so this is a soft failure, not a broken feature.
    return { statusCode: 500, body: JSON.stringify({ error: 'Redis not configured' }) };
  }
  try {
    const payload = JSON.parse(event.body || '{}');
    const id = randomId();
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', `share:${id}`, JSON.stringify(payload), 'EX', String(TTL_SECONDS)]),
    });
    if (!res.ok) throw new Error(`Redis SET failed: ${res.status}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
