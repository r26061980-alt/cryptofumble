// netlify/functions/create-crypto-invoice.js
//
// Starts a Trybit (formerly CryptoCloud) crypto invoice for the same $3
// "premium export" one-off purchase that create-checkout-session.js sells
// via Stripe — this is the USDT alternative, for cardholders Stripe simply
// can't serve (Stripe does not support Russia/Ukraine/Belarus at all, not
// just certain card networks). Plain REST call to Trybit's API via fetch,
// same zero-npm-dependency pattern as every other function in this project.
//
// Needs two new Netlify environment variables, both from inside the
// project's own settings on the Trybit dashboard (NOT the general
// "Интеграция" overview page):
//   TRYBIT_API_KEY   — the project's "API KEY" field, sent as
//                       `Authorization: Token <key>`
//   TRYBIT_SHOP_ID    — the project's "SHOP ID" field, sent in the body
//
// Unlike Stripe Checkout, Trybit's invoice/create endpoint does not accept
// a per-request success/cancel URL — those are fixed once, at the project
// level, in the Trybit dashboard. So the client never relies on being
// redirected back to this site automatically: it opens the returned
// payment link in a new tab and polls verify-crypto-invoice.js for the
// invoice's status instead (see the client-side code for why).

const PRICE_USD = 3; // $3.00 — matches the Stripe price and the button text

exports.handler = async (event) => {
  const API_KEY = process.env.TRYBIT_API_KEY;
  const SHOP_ID = process.env.TRYBIT_SHOP_ID;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }
  if (!API_KEY || !SHOP_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'not_configured' }) };
  }

  // order_id is just a free-form label Trybit echoes back — not
  // security-sensitive, so a timestamp + random suffix is enough to keep
  // purchases distinct from one another.
  const orderId = `CF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const res = await fetch('https://api.trybit.com/v2/invoice/create', {
      method: 'POST',
      headers: {
        Authorization: `Token ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        shop_id: SHOP_ID,
        amount: PRICE_USD,
        currency: 'USD',
        order_id: orderId,
        add_fields: {
          // Pins the invoice to USDT on TRON (TRC20) — the cheapest, most
          // common network for this kind of payment — so the payer lands
          // straight on a pre-filled address/amount instead of a currency
          // picker.
          cryptocurrency: 'USDT_TRC20',
        },
      }),
    });
    const json = await res.json();
    if (!res.ok || json.status !== 'success') {
      const detail = json && json.result && typeof json.result === 'object'
        ? Object.values(json.result)[0]
        : null;
      throw new Error(detail || `trybit ${res.status}`);
    }
    const result = json.result;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ uuid: result.uuid, link: result.link }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'trybit_unavailable', detail: String(err.message || err) }),
    };
  }
};
