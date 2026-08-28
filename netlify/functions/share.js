// netlify/functions/share.js
//
// This is the URL that gets shared on X/Twitter and Telegram instead of the
// plain homepage. When a link-preview crawler (Twitter's, Telegram's, etc.)
// fetches it, it reads the og:image/twitter:image meta tags below, which
// point at og-image.js with the same query params — so the preview card
// shows the actual result the person calculated, not a generic screenshot.
// A real visitor who clicks the link gets redirected straight to the
// calculator via a JavaScript redirect (NOT a <meta http-equiv="refresh">
// tag — Telegram's crawler, and some others, silently FOLLOW that kind of
// redirect while parsing raw HTML, landing on the plain homepage and
// reading ITS generic og:image/title instead of the personalized ones
// below. A script tag is never executed by these crawlers, only by real
// browsers, so this keeps the "OG-tags-for-bots / redirect-for-humans"
// split actually safe.
//
// Query params: same as og-image.js, plus:
//   lang  "ru" to link back to /ru instead of the English homepage
//   id    a short id from shorten.js — resolved via Redis into the full set
//         of fields above (see resolveParams below); when present, the
//         image/canonical links below stay short too instead of growing
//         back into a long query string

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
async function resolveParams(q) {
  if (!q.id || !REDIS_URL || !REDIS_TOKEN) return q;
  try {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', `share:${q.id}`]),
    });
    const data = await res.json();
    if (data && data.result) return JSON.parse(data.result);
  } catch (err) { /* fall through — worst case: generic title/description */ }
  return q;
}

exports.handler = async (event) => {
  const rawQ = event.queryStringParameters || {};
  const q = await resolveParams(rawQ);
  const isRu = q.lang === 'ru';
  const siteUrl = isRu ? 'https://cryptofumble.com/ru' : 'https://cryptofumble.com';
  // imageUrl/shareUrl are built from the ORIGINAL request params (rawQ), not
  // the resolved ones — that way a short "?id=" link stays short all the way
  // through (og-image.js resolves the id itself too), while an old-style
  // full-query-string link keeps working exactly as before.
  const params = new URLSearchParams(rawQ);
  const imageUrl = `https://cryptofumble.com/.netlify/functions/og-image?${params.toString()}`;
  const shareUrl = rawQ.id
    ? `https://cryptofumble.com/r/${rawQ.id}`
    : `https://cryptofumble.com/.netlify/functions/share?${params.toString()}`;

  const title = q.r
    ? (isRu
        ? `Я бы имел ${q.r}, если бы ${q.m === 'sold' ? 'продал' : q.m === 'dca' ? 'инвестировал в' : 'купил'} ${q.n || q.s || 'крипту'}`
        : `I would've had ${q.r} if I'd ${q.m === 'sold' ? 'sold' : q.m === 'dca' ? 'invested monthly in' : 'bought'} ${q.n || q.s || 'crypto'}`)
    : 'CryptoFumble — What Could You Have Made?';
  const description = isRu
    ? 'Узнай, сколько бы ты заработал (или потерял), если бы купил крипту раньше.'
    : 'Find out what your money would be worth today if you had bought crypto back then.';

  const html = `<!DOCTYPE html>
<html lang="${isRu ? 'ru' : 'en'}">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(imageUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(shareUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(imageUrl)}">
<style>
  body{background:#0A0B10; color:#F3F2EE; font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;}
  a{color:#F0B90B;}
</style>
</head>
<body>
  <p>Redirecting to <a href="${esc(siteUrl)}">CryptoFumble</a>…</p>
  <script>location.replace(${JSON.stringify(siteUrl)});</script>
</body>
</html>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  };
};
