// netlify/functions/search.js
// Прокси перед CoinGecko /search. Короткий edge-кэш на запрос — если несколько
// юзеров подряд ищут "sol", CDN отдаёт готовый ответ вместо повторного похода
// в CoinGecko. Плюс защищает от злоупотребления: без ключа CoinGecko триггерит
// 429 быстрее всего именно на search при вводе по буквам без debounce на фронте.

// CoinGecko теперь требует Demo API Key даже для бесплатного тарифа —
// ключ хранится в переменной окружения Netlify, не в коде.
function apiKeyHeaders() {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { 'x-cg-demo-api-key': key } : {};
}

exports.handler = async (event) => {
  const query = (event.queryStringParameters || {}).query;

  if (!query || query.trim().length < 2) {
    return { statusCode: 400, body: JSON.stringify({ error: 'нужен query, минимум 2 символа' }) };
  }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query.trim())}`,
      { headers: apiKeyHeaders() }
    );
    if (!res.ok) throw new Error(`coingecko search ${res.status}`);
    const json = await res.json();
    const coins = (json.coins || []).slice(0, 8).map((c) => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      thumb: c.thumb,
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // короткий кэш — поисковые подсказки не обязаны быть идеально свежими
        'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ coins }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
    };
  }
};
