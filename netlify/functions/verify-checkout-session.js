// netlify/functions/verify-checkout-session.js
//
// Called when the browser comes back from Stripe Checkout (success_url
// includes ?session_id=...). Confirms with Stripe itself that the session
// actually reached "paid" before the client unlocks anything — the query
// param alone proves nothing (anyone could type it into the URL bar), so
// this is the one server-side check the whole premium-export feature relies
// on. Same plain-fetch-to-Stripe's-REST-API approach as create-checkout-session.js,
// no npm dependency.

exports.handler = async (event) => {
  const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const sessionId = event.queryStringParameters && event.queryStringParameters.session_id;

  if (!sessionId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing_session_id' }) };
  }
  if (!SECRET_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'not_configured' }) };
  }
  // Stripe Checkout session IDs are always "cs_..." — reject anything else
  // outright instead of forwarding arbitrary input to the Stripe API.
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bad_session_id' }) };
  }

  try {
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${SECRET_KEY}` },
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json?.error?.message || `stripe ${res.status}`);
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ paid: json.payment_status === 'paid' }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'stripe_unavailable', detail: String(err.message || err) }),
    };
  }
};
