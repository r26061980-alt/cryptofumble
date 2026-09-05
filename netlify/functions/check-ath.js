// netlify/functions/check-ath.js
//
// Scheduled function (see netlify.toml: schedule = "*/15 * * * *", always
// UTC — same convention as telegram-digest.js/telegram-channel-post.js).
// Polls the current price of all 9 supported coins, compares each against
// the last known all-time high stored in Redis, and — on a genuine new
// high — pushes a notification to everyone subscribed (see
// push-subscribe.js). Reuses the site's own price.js endpoint (its
// CoinGecko caching + anchor-point fallback) instead of calling CoinGecko
// directly, same pattern as telegram-digest.js's fetchCurrentPrice.
//
// Storage (same Upstash Redis as feed.js/push-subscribe.js):
//   ath:<SYMBOL>      — string, last known all-time-high USD price
//   push:sub:<hash>   — JSON string {endpoint, keys, lang} (push-subscribe.js)
//   push:subs:index   — Set of all <hash> values
//
// First run for a coin (no ath:<SYMBOL> key yet) just seeds the current
// price silently — otherwise the day this ships would fire 9 "new high"
// notifications that are really just the first-ever reading.
//
// A subscription the push service reports as gone (404/410 — uninstalled,
// cleared site data, notifications revoked at the OS level, etc.) is
// removed from Redis right away so the list doesn't fill up with dead
// entries that just fail every single run.

const webpush = require('web-push');

const SITE_URL = process.env.URL || 'https://cryptofumble.com';

const COINS = [
  { symbol: 'BTC', geckoId: 'bitcoin', nameEn: 'Bitcoin', nameRu: 'Bitcoin' },
  { symbol: 'ETH', geckoId: 'ethereum', nameEn: 'Ethereum', nameRu: 'Ethereum' },
  { symbol: 'SOL', geckoId: 'solana', nameEn: 'Solana', nameRu: 'Solana' },
  { symbol: 'DOGE', geckoId: 'dogecoin', nameEn: 'Dogecoin', nameRu: 'Dogecoin' },
  { symbol: 'ADA', geckoId: 'cardano', nameEn: 'Cardano', nameRu: 'Cardano' },
  { symbol: 'XRP', geckoId: 'ripple', nameEn: 'XRP', nameRu: 'XRP' },
  { symbol: 'BNB', geckoId: 'binancecoin', nameEn: 'BNB', nameRu: 'BNB' },
  { symbol: 'HYPE', geckoId: 'hyperliquid', nameEn: 'Hyperliquid', nameRu: 'Hyperliquid' },
  { symbol: 'ZEC', geckoId: 'zcash', nameEn: 'Zcash', nameRu: 'Zcash' },
];

// Minimum relative gain over the stored ATH before it counts as a genuine
// new high — guards against re-firing on float/rounding noise between polls.
const MIN_GAIN_RATIO = 1.001; // 0.1%

function upstashHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function fmtMoney(n) {
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

async function fetchCurrentPrice(geckoId) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/price?type=current&coin=${geckoId}`);
  if (!res.ok) throw new Error(`price fetch failed for ${geckoId}: ${res.status}`);
  const json = await res.json();
  if (!json.price) throw new Error(`no price in response for ${geckoId}`);
  return json.price;
}

exports.handler = async () => {
  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://cryptofumble.com';

  if (!REST_URL || !REST_TOKEN) {
    console.error('check-ath: Redis not configured');
    return { statusCode: 500, body: JSON.stringify({ error: 'redis_not_configured' }) };
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error('check-ath: VAPID keys not configured');
    return { statusCode: 500, body: JSON.stringify({ error: 'vapid_not_configured' }) };
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const headers = upstashHeaders(REST_TOKEN);

  // 1) figure out which coins hit a genuine new ATH this run
  const newHighs = [];
  for (const coin of COINS) {
    try {
      const price = await fetchCurrentPrice(coin.geckoId);
      const athRes = await fetch(`${REST_URL}/get/ath:${coin.symbol}`, { headers });
      const athJson = athRes.ok ? await athRes.json() : { result: null };
      const storedAth = athJson.result ? parseFloat(athJson.result) : null;

      if (storedAth === null) {
        // first run for this coin — seed silently, no notification
        await fetch(`${REST_URL}/set/ath:${coin.symbol}`, { method: 'POST', headers, body: String(price) });
        continue;
      }

      if (price > storedAth * MIN_GAIN_RATIO) {
        await fetch(`${REST_URL}/set/ath:${coin.symbol}`, { method: 'POST', headers, body: String(price) });
        newHighs.push({ ...coin, price });
      }
    } catch (err) {
      console.error(`check-ath: failed for ${coin.symbol}`, err.message || err);
      // one coin's failure (price fetch or Redis hiccup) never blocks the rest
    }
  }

  if (newHighs.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, newHighs: 0 }) };
  }

  // 2) load all subscribers once, send every new-high notification to each
  let subs = [];
  try {
    const idxRes = await fetch(`${REST_URL}/smembers/push:subs:index`, { headers });
    const idxJson = await idxRes.json();
    const hashes = idxJson.result || [];
    const records = await Promise.all(
      hashes.map(async (hash) => {
        try {
          const r = await fetch(`${REST_URL}/get/push:sub:${hash}`, { headers });
          const j = await r.json();
          if (!j.result) return null;
          return { hash, ...JSON.parse(j.result) };
        } catch {
          return null;
        }
      })
    );
    subs = records.filter(Boolean);
  } catch (err) {
    console.error('check-ath: failed to load subscribers', err.message || err);
    return { statusCode: 502, body: JSON.stringify({ error: 'subscribers_unavailable' }) };
  }

  let sent = 0;
  let removed = 0;
  for (const high of newHighs) {
    const titleEn = `🚀 New ${high.nameEn} all-time high`;
    const titleRu = `🚀 Новый исторический максимум: ${high.nameRu}`;
    const bodyEn = `${high.symbol} just hit ${fmtMoney(high.price)} — a new record. See what your own crypto moment would look like →`;
    const bodyRu = `${high.symbol} обновил рекорд — сейчас ${fmtMoney(high.price)}. Посмотри, каким был бы твой крипто-момент →`;

    for (const sub of subs) {
      const isRu = sub.lang === 'ru';
      const payload = JSON.stringify({
        title: isRu ? titleRu : titleEn,
        body: isRu ? bodyRu : bodyEn,
        url: isRu ? `/ru/?coin=${high.symbol}` : `/?coin=${high.symbol}`,
        tag: `ath-${high.symbol}`,
      });
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
        sent++;
      } catch (err) {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) {
          // subscription is dead — clean it up so it stops being tried every run
          try {
            await fetch(`${REST_URL}/del/push:sub:${sub.hash}`, { method: 'POST', headers });
            await fetch(`${REST_URL}/srem/push:subs:index/${sub.hash}`, { method: 'POST', headers });
            removed++;
          } catch {
            // best effort — a stale entry sticking around one more cycle is fine
          }
        } else {
          console.error('check-ath: push send failed', sub.hash, code || err.message || err);
        }
      }
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      newHighs: newHighs.map((h) => h.symbol),
      subscribers: subs.length,
      sent,
      removed,
    }),
  };
};
