// netlify/functions/og-image.js
//
// Renders a personalized "Receipt of Regret" PNG for use as the og:image /
// twitter:image of a share link (see share.js). Takes the already-computed
// result as query params (the same fields the frontend keeps in `lastResult`)
// rather than recomputing prices server-side — simpler, faster, no network
// calls needed inside the function, and the image always matches exactly
// what the user saw on screen when they hit "Share".
//
// Query params (all plain strings, already formatted for display):
//   s   coin symbol, e.g. "BTC"
//   n   coin name, e.g. "Bitcoin"
//   m   mode: "bought" | "sold" | "dca"
//   d   date string, e.g. "2020-03"
//   r   result, formatted, e.g. "$21,695"
//   mu  multiplier, numeric, e.g. "21.7"
//   tl  tier label, e.g. "LEGENDARY TIMING" (tier emoji is intentionally left
//       out of the rendered image — color-emoji fonts aren't reliably
//       available in Netlify's function runtime, so it's kept in the tweet/
//       message text instead, where the client's own font renders it)
//   g   "1" if a good outcome (green), "0" if bad (red)
//   sp  optional: S&P 500 comparison, formatted, e.g. "$2,063"
//
// Requires the "sharp" package (npm install sharp) available to this
// function — add it to the project's package.json so Netlify bundles it.

const sharp = require('sharp');

// Resolves a short "?id=" link (created by shorten.js) back into the full
// set of query params, by looking it up in the same Upstash Redis instance
// feed.js already uses. Links using the old full-query-string format keep
// working unchanged — this only kicks in when an "id" param is present.
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
  } catch (err) { /* fall through — worst case: image renders with no data */ }
  return q;
}

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

function subtitleFor(mode, name, date) {
  if (mode === 'dca') return `${name} · monthly since ${date}`;
  const verb = mode === 'sold' ? 'sold' : 'bought';
  return `${name} · ${verb} ${date}`;
}

function buildSvg(q) {
  const W = 1200, H = 630;
  const cardX = 60, cardY = 55, cardW = W - cardX * 2, cardH = H - cardY * 2;
  const cx = W / 2;
  const isGood = q.g !== '0';
  const resultColor = isGood ? '#0F7A50' : '#A82A30';
  const badgeBg = isGood ? 'rgba(15,122,80,0.14)' : 'rgba(168,42,48,0.14)';
  const ink = '#2A2418';
  const inkSoft = 'rgba(42,36,24,0.55)';
  const inkFooter = 'rgba(42,36,24,0.4)';
  const subtitle = subtitleFor(q.m, q.n || q.s || 'Crypto', q.d || '');
  const badgeText = `x${q.mu || '1.0'}`;
  // rough width estimate for the badge pill so it stays centered
  const badgeW = Math.max(90, badgeText.length * 17 + 40);
  const spLine = q.sp ? `Same amount in the S&amp;P 500 would be worth ${esc(q.sp)}` : '';

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bgGrad" cx="50%" cy="8%" r="85%">
      <stop offset="0%" stop-color="#171C24"/>
      <stop offset="100%" stop-color="#0A0B10"/>
    </radialGradient>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bgGrad)"/>
  <g filter="url(#cardShadow)">
    <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="22" fill="#F7F1E3"/>
  </g>
  <text x="${cx}" y="${cardY + 54}" text-anchor="middle" font-family="monospace" font-size="15" font-weight="600" letter-spacing="4" fill="${inkSoft}">— RECEIPT OF REGRET —</text>
  <text x="${cx}" y="${cardY + 90}" text-anchor="middle" font-family="monospace" font-size="18" fill="${inkSoft}">${esc(subtitle)}</text>
  <line x1="${cardX + 50}" y1="${cardY + 112}" x2="${cardX + cardW - 50}" y2="${cardY + 112}" stroke="rgba(42,36,24,0.3)" stroke-width="2" stroke-dasharray="6,6"/>
  <text x="${cx}" y="${cardY + 160}" text-anchor="middle" font-family="monospace" font-size="15" font-weight="600" letter-spacing="3" fill="${inkSoft}">WOULD BE WORTH NOW</text>
  <text x="${cx}" y="${cardY + 235}" text-anchor="middle" font-family="monospace" font-size="72" font-weight="700" fill="${resultColor}">${esc(q.r || '$0')}</text>
  <rect x="${cx - badgeW / 2}" y="${cardY + 262}" width="${badgeW}" height="46" rx="23" fill="${badgeBg}"/>
  <text x="${cx}" y="${cardY + 292}" text-anchor="middle" font-family="monospace" font-size="21" font-weight="700" fill="${resultColor}">${esc(badgeText)}</text>
  <text x="${cx}" y="${cardY + 345}" text-anchor="middle" font-family="monospace" font-size="20" font-weight="700" letter-spacing="1" fill="#B8860B">${esc(q.tl || '')}</text>
  ${spLine ? `<text x="${cx}" y="${cardY + 385}" text-anchor="middle" font-family="monospace" font-size="16" fill="rgba(42,36,24,0.6)">${spLine}</text>` : ''}
  <line x1="${cardX + 50}" y1="${cardY + cardH - 60}" x2="${cardX + cardW - 50}" y2="${cardY + cardH - 60}" stroke="rgba(42,36,24,0.3)" stroke-width="2" stroke-dasharray="6,6"/>
  <text x="${cx}" y="${cardY + cardH - 28}" text-anchor="middle" font-family="monospace" font-size="14" font-weight="600" letter-spacing="3" fill="${inkFooter}">CRYPTOFUMBLE.COM · MAKE YOUR OWN</text>
</svg>`;
}

exports.handler = async (event) => {
  try {
    const q = await resolveParams(event.queryStringParameters || {});
    const svg = buildSvg(q);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/png',
        // link-preview crawlers cache aggressively; a short cache still lets
        // a fixed link's image update if the underlying share data changes,
        // while avoiding re-rendering on every single crawl
        'Cache-Control': 'public, max-age=3600',
      },
      body: png.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    // fall back to a tiny transparent pixel rather than a broken image /
    // Netlify error page, so a malformed share link never shows an ugly 500
    const fallback = await sharp({
      create: { width: 1200, height: 630, channels: 4, background: { r: 10, g: 11, b: 16, alpha: 1 } },
    }).png().toBuffer();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'image/png' },
      body: fallback.toString('base64'),
      isBase64Encoded: true,
    };
  }
};
