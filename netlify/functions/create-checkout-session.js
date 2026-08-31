// netlify/functions/create-checkout-session.js
//
// Starts a Stripe Checkout session for the $3 "premium export" one-off
// purchase (no watermark, story-ratio PNG/PDF of the certificate). Plain
// REST calls to Stripe's API via fetch — same zero-npm-dependency pattern as
// every other function in this project (feed.js/telegram-link.js talk to
// Upstash the same way) — so there's nothing to `npm install` and no
// package.json/build-step change needed for this to deploy.
//
// Needs one new Netlify environment variable:
//   STRIPE_SECRET_KEY   — from the Stripe dashboard (Developers → API keys).
//                         Use the "sk_test_..." key first to try the whole
//                         flow with Stripe's test cards before switching to
//                         the live "sk_live_..." key.
//
// Stripe's API is form-encoded (not JSON) and expects bracketed keys for
// nested/array fields — buildParams() below just mirrors that shape by hand
// instead of pulling in the `stripe` npm package for one endpoint.

const PRICE_USD_CENTS = 300; // $3.00 — matches what's shown on the button text

exports.handler = async (event) => {
  const SECRET_KEY = process.env.STRIPE_SECRET_KEY;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }
  if (!SECRET_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'not_configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bad_json' }) };
  }

  // returnPath is which language version to bounce back to (e.g. "/" or
  // "/ru/") — restricted to a short allowlist-shaped value so this endpoint
  // can't be used to build a Checkout session that redirects somewhere else
  // entirely (open-redirect style abuse).
  const rawPath = String(body.returnPath || '/');
  const returnPath = /^\/(ru\/?|es\/?|pt\/?)?$/.test(rawPath) ? rawPath : '/';

  const origin = `https://${event.headers.host || 'cryptofumble.com'}`;
  const successUrl = `${origin}${returnPath}?premium_unlock=1&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}${returnPath}?premium_cancelled=1`;

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('line_items[0][price_data][currency]', 'usd');
  params.append('line_items[0][price_data][product_data][name]', 'CryptoFumble — Premium Export');
  params.append('line_items[0][price_data][product_data][description]', 'High-res, watermark-free, story-format export of one result');
  params.append('line_items[0][price_data][unit_amount]', String(PRICE_USD_CENTS));
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json?.error?.message || `stripe ${res.status}`);
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ url: json.url }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'stripe_unavailable', detail: String(err.message || err) }),
    };
  }
};
