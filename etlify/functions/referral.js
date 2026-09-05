// netlify/functions/referral.js
//
// Referral-link attribution (Фаза 49) — no accounts. Each browser gets a
// short random code client-side (see the referral widget's script, right
// after the donate-widget script in index.html/ru/index.html), stored once
// in localStorage. Sharing /?ref=<code> and someone else opening it counts
// one visit toward that code. Same Upstash Redis + plain-REST-fetch style
// as feed.js/push-subscribe.js/check-ath.js — no @upstash/redis package.
//
// POST { code } -> increments ref:<code>
// GET  ?code=X  -> returns { code, count } for that code
//
// Deliberately unauthenticated — same trust level as the live feed and the
// all-time counter (a vanity "N people came via your link" number, not a
// verified leaderboard or a rewarded referral program, same reasoning as
// the declined "hall of fame" idea in the growth ledger). Nothing stops
// someone from inflating their own count by calling this endpoint directly;
// acceptable tradeoff for "no accounts, no auth" rather than a real problem
// to solve right now — there's no reward tied to the number.
//
// Env vars (same names/values as feed.js): UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

function upstashHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

// Matches the 6-char [a-z0-9] codes the client generates, a little more
// permissive on length so a hand-typed/shortened code doesn't 400 for no reason.
function isValidCode(code) {
  return typeof code === 'string' && /^[a-z0-9]{3,20}$/.test(code);
}

exports.handler = async (event) => {
  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!REST_URL || !REST_TOKEN) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'referral_not_configured' }),
    };
  }

  const headers = upstashHeaders(REST_TOKEN);
  const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'GET') {
    const code = (event.queryStringParameters || {}).code;
    if (!isValidCode(code)) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'invalid_code' }) };
    }
    try {
      const res = await fetch(`${REST_URL}/get/ref:${code}`, { headers });
      const json = res.ok ? await res.json() : { result: null };
      const count = json.result ? parseInt(json.result, 10) || 0 : 0;
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          // short edge cache — this is a "check back later" number, not
          // something that needs to update within the same page view
          'Cache-Control': 'public, max-age=15, s-maxage=30, stale-while-revalidate=120',
        },
        body: JSON.stringify({ code, count }),
      };
    } catch (err) {
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
      };
    }
  }

  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      if (!isValidCode(body.code)) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'invalid_code' }) };
      }
      await fetch(`${REST_URL}/incr/ref:${body.code}`, { method: 'POST', headers });
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
      };
    }
  }

  return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'method_not_allowed' }) };
};
