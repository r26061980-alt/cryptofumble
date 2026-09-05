// netlify/functions/push-subscribe.js
//
// Stores/removes Web Push subscriptions for the "new all-time high" alert
// (Фаза 48). Same Upstash Redis instance and plain-REST-fetch style as
// feed.js/telegram-digest.js — no @upstash/redis package, no build step
// for THIS function (the sender, check-ath.js, does use the "web-push" npm
// package, since correctly signing/encrypting a push message by hand is a
// lot more failure-prone than storing a JSON blob).
//
// POST   { subscription: PushSubscriptionJSON, lang: 'en'|'ru' } -> save/refresh
// DELETE { endpoint: string }                                    -> remove
//
// Storage:
//   push:sub:<hash>   — JSON string {endpoint, keys, lang}, hash = sha256(endpoint).slice(0,16)
//   push:subs:index   — Set of all <hash> values, so check-ath.js can enumerate everyone
//
// Env vars (same names/values as feed.js): UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

const crypto = require('crypto');

function upstashHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

// Short, stable, URL-safe id for a subscription — re-subscribing the same
// browser just overwrites the same key instead of piling up duplicates.
function hashEndpoint(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 16);
}

exports.handler = async (event) => {
  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!REST_URL || !REST_TOKEN) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'push_not_configured' }),
    };
  }

  const headers = upstashHeaders(REST_TOKEN);
  const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }

  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const sub = body.subscription;
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'invalid_subscription' }) };
      }
      const lang = body.lang === 'ru' ? 'ru' : 'en';
      const hash = hashEndpoint(sub.endpoint);
      const record = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        lang,
      };

      await fetch(`${REST_URL}/set/push:sub:${hash}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(record),
      });
      await fetch(`${REST_URL}/sadd/push:subs:index/${hash}`, { method: 'POST', headers });

      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
      };
    }
  }

  if (event.httpMethod === 'DELETE') {
    try {
      const body = JSON.parse(event.body || '{}');
      if (!body.endpoint) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'missing_endpoint' }) };
      }
      const hash = hashEndpoint(body.endpoint);
      await fetch(`${REST_URL}/del/push:sub:${hash}`, { method: 'POST', headers });
      await fetch(`${REST_URL}/srem/push:subs:index/${hash}`, { method: 'POST', headers });
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
