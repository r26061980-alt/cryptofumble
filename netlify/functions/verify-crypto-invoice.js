// netlify/functions/verify-crypto-invoice.js
//
// Polled by the client after it opens a Trybit payment link in a new tab
// (see create-crypto-invoice.js for why: Trybit's invoice API has no
// per-request redirect, so the client can't rely on being bounced back
// here automatically — it just asks "is this invoice paid yet?" every few
// seconds instead). Confirms the invoice's real status with Trybit itself
// before the client unlocks anything — the uuid alone proves nothing, so
// this is the one server-side check the crypto premium-export path relies
// on, exactly like verify-checkout-session.js does for the Stripe path.

exports.handler = async (event) => {
  const API_KEY = process.env.TRYBIT_API_KEY;
  const uuid = event.queryStringParameters && event.queryStringParameters.uuid;

  if (!uuid) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing_uuid' }) };
  }
  if (!API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'not_configured' }) };
  }
  // Trybit invoice ids always look like INV-XXXXXXXX (or the bare
  // XXXXXXXX suffix) — reject anything else outright instead of
  // forwarding arbitrary input to the Trybit API.
  if (!/^(INV-)?[A-Za-z0-9]+$/.test(uuid)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bad_uuid' }) };
  }

  try {
    const res = await fetch('https://api.trybit.com/v2/invoice/merchant/info', {
      method: 'POST',
      headers: {
        Authorization: `Token ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uuids: [uuid] }),
    });
    const json = await res.json();
    if (!res.ok || json.status !== 'success') {
      throw new Error(`trybit ${res.status}`);
    }
    const invoice = Array.isArray(json.result) ? json.result[0] : null;
    // "paid" / "overpaid" both mean the buyer's money has actually arrived;
    // "partial" means underpaid (don't unlock), "created"/"canceled" mean
    // not paid at all.
    const paid = !!invoice && (invoice.status === 'paid' || invoice.status === 'overpaid');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ paid, status: invoice ? invoice.status : 'not_found' }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'trybit_unavailable', detail: String(err.message || err) }),
    };
  }
};
