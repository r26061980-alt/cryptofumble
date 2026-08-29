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
//   lang  "ru" | "es" | "pt" to link back to that language's homepage
//         instead of the English one (Phase 4: added es/pt alongside the
//         existing ru support)
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
// Two quick retries absorb the rare case where this read races just behind
// shorten.js's write finishing on Upstash's side — worst case without them:
// a generic title/description shows instead of the personalized one.
async function resolveParams(q) {
  if (!q.id || !REDIS_URL || !REDIS_TOKEN) return q;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['GET', `share:${q.id}`]),
      });
      const data = await res.json();
      if (data && data.result) return JSON.parse(data.result);
    } catch (err) { /* retry below */ }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 200));
  }
  return q;
}

// Per-language site root and share-page copy. Adding a language here is the
// only change needed to support it in this function — buildTitle/buildDescription
// below just look it up by q.lang, falling back to English for an unknown/
// missing lang (covers the plain "/" homepage and any old share links).
const SITES = {
  en:  { url: 'https://cryptofumble.com',     htmlLang: 'en' },
  ru:  { url: 'https://cryptofumble.com/ru',  htmlLang: 'ru' },
  es:  { url: 'https://cryptofumble.com/es',  htmlLang: 'es' },
  pt:  { url: 'https://cryptofumble.com/pt',  htmlLang: 'pt' },
};

function verbFor(lang, mode) {
  const verbs = {
    en: { sold: 'sold', dca: 'invested monthly in', bought: 'bought' },
    ru: { sold: 'продал', dca: 'инвестировал в', bought: 'купил' },
    es: { sold: 'vendí', dca: 'invertí cada mes en', bought: 'compré' },
    pt: { sold: 'vendi', dca: 'investi todo mês em', bought: 'comprei' },
  };
  const set = verbs[lang] || verbs.en;
  return mode === 'sold' ? set.sold : mode === 'dca' ? set.dca : set.bought;
}

function buildTitle(lang, q) {
  if (!q.r) {
    const brand = {
      en: 'CryptoFumble — What Could You Have Made?',
      ru: 'CryptoFumble — Сколько бы ты заработал?',
      es: 'CryptoFumble — ¿Cuánto habrías ganado?',
      pt: 'CryptoFumble — Quanto você teria ganhado?',
    };
    return brand[lang] || brand.en;
  }
  const coin = q.n || q.s || (lang === 'ru' ? 'крипту' : lang === 'es' ? 'cripto' : lang === 'pt' ? 'cripto' : 'crypto');
  const verb = verbFor(lang, q.m);
  const templates = {
    en: `I would've had ${q.r} if I'd ${verb} ${coin}`,
    ru: `Я бы имел ${q.r}, если бы ${verb} ${coin}`,
    es: `Habría tenido ${q.r} si hubiera ${verb} ${coin}`,
    pt: `Eu teria ${q.r} se tivesse ${verb} ${coin}`,
  };
  return templates[lang] || templates.en;
}

function buildDescription(lang) {
  const d = {
    en: 'Find out what your money would be worth today if you had bought crypto back then.',
    ru: 'Узнай, сколько бы ты заработал (или потерял), если бы купил крипту раньше.',
    es: 'Descubre cuánto valdría hoy tu dinero si hubieras comprado cripto en aquel entonces.',
    pt: 'Descubra quanto valeria hoje o seu dinheiro se você tivesse comprado cripto naquela época.',
  };
  return d[lang] || d.en;
}

exports.handler = async (event) => {
  const rawQ = event.queryStringParameters || {};
  // When reached through the "/r/<id>" short-link redirect, Netlify does NOT
  // actually inject the ":id"/":splat" placeholder into this function's query
  // string in production — that's a confirmed, documented Netlify platform
  // limitation for rewrites to functions, not a bug in our config (see
  // https://answers.netlify.com/t/redirect-rewrite-to-function-seems-broken/18595).
  // This is the real reason the picture always came out blank: the id never
  // arrived here at all. The fix is to read it straight off the untouched
  // incoming request path instead, which Netlify does preserve as event.path.
  if (!rawQ.id) {
    const m = (event.path || '').match(/\/r\/([^/?]+)/);
    if (m) rawQ.id = m[1];
  }
  const q = await resolveParams(rawQ);
  const lang = SITES[q.lang] ? q.lang : 'en';
  const site = SITES[lang];
  // imageUrl/shareUrl are built from the ORIGINAL request params (rawQ), not
  // the resolved ones — that way a short "?id=" link stays short all the way
  // through (og-image.js resolves the id itself too), while an old-style
  // full-query-string link keeps working exactly as before.
  const params = new URLSearchParams(rawQ);
  const imageUrl = `https://cryptofumble.com/.netlify/functions/og-image?${params.toString()}`;
  const shareUrl = rawQ.id
    ? `https://cryptofumble.com/r/${rawQ.id}`
    : `https://cryptofumble.com/.netlify/functions/share?${params.toString()}`;

  const title = buildTitle(lang, q);
  const description = buildDescription(lang);

  const html = `<!DOCTYPE html>
<html lang="${site.htmlLang}">
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
  <p>Redirecting to <a href="${esc(site.url)}">CryptoFumble</a>…</p>
  <script>location.replace(${JSON.stringify(site.url)});</script>
</body>
</html>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  };
};
