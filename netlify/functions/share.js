// netlify/functions/share.js
//
// This is the URL that gets shared on X/Twitter and Telegram instead of the
// plain homepage. When a link-preview crawler (Twitter's, Telegram's, etc.)
// fetches it, it reads the og:image/twitter:image meta tags below, which
// point at og-image.js with the same query params — so the preview card
// shows the actual result the person calculated, not a generic screenshot.
// A real visitor who clicks the link gets redirected straight to the
// calculator (crawlers don't execute the meta-refresh/JS redirect, so this
// is a safe, standard "OG-tags-for-bots / redirect-for-humans" split).
//
// Query params: same as og-image.js, plus:
//   lang  "ru" to link back to /ru instead of the English homepage

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const isRu = q.lang === 'ru';
  const siteUrl = isRu ? 'https://cryptofumble.com/ru' : 'https://cryptofumble.com';
  const params = new URLSearchParams(q);
  const imageUrl = `https://cryptofumble.com/.netlify/functions/og-image?${params.toString()}`;
  const shareUrl = `https://cryptofumble.com/.netlify/functions/share?${params.toString()}`;

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
<meta http-equiv="refresh" content="0; url=${esc(siteUrl)}">
<style>
  body{background:#0A0B10; color:#F3F2EE; font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;}
  a{color:#F0B90B;}
</style>
</head>
<body>
  <p>Redirecting to <a href="${esc(siteUrl)}">CryptoFumble</a>…</p>
</body>
</html>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  };
};
