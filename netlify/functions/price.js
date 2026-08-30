// netlify/functions/price.js
//
// Прокси перед CoinGecko API с двумя уровнями защиты от нагрузки:
//
// 1. EDGE-КЭШ (Cache-Control) — Netlify's CDN сам отдаёт закэшированный ответ
//    всем пользователям, которые спрашивают ту же монету+дату, БЕЗ вызова
//    этой функции вообще. Это главная защита: 10 000 юзеров, спросивших
//    "BTC в марте 2020" за один день, при удачном кэше = 1 реальный запрос к CoinGecko.
//
// 2. IN-MEMORY REQUEST COALESCING — пока "тёплый" инстанс функции жив,
//    параллельные запросы на один и тот же ключ схлопываются в один
//    исходящий вызов к CoinGecko вместо N.
//
// Исторические цены (history) кэшируются надолго — они физически не меняются
// задним числом. Текущая цена (current) кэшируется на короткий TTL.

const inflight = new Map(); // request coalescing на тёплом инстансе

// CoinGecko теперь требует Demo API Key даже для бесплатного тарифа на
// часть эндпоинтов (например /coins/{id}/history возвращает 401 без ключа).
// Ключ хранится в переменной окружения Netlify (Site settings → Environment
// variables → COINGECKO_API_KEY), а не в коде — так он не светится в репозитории.
function apiKeyHeaders() {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { 'x-cg-demo-api-key': key } : {};
}

function cacheKey(type, coin, date) {
  return `${type}:${coin}:${date || ''}`;
}

async function dedupedFetch(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

exports.handler = async (event) => {
  const { type, coin, date } = event.queryStringParameters || {};

  if (type === 'top10') {
    // Топ-10 монет по капитализации для живого тикера в сайдбаре — не
    // привязан к конкретному списку монет, сайт сам подтягивает актуальный
    // топ у CoinGecko (та же аналитика, что стоит за рейтингом CoinMarketCap,
    // без интеграции ещё одного стороннего API с отдельным ключом).
    try {
      const key = 'top10';
      const coins = await dedupedFetch(key, async () => {
        const res = await fetch(
          'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&price_change_percentage=24h',
          { headers: apiKeyHeaders() }
        );
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          throw new Error(`coingecko markets ${res.status}: ${bodyText.slice(0, 300)}`);
        }
        const json = await res.json();
        return json.map((c) => ({
          id: c.id,
          symbol: String(c.symbol || '').toUpperCase(),
          name: c.name,
          image: c.image || null,
          price: c.current_price,
          change24h: typeof c.price_change_percentage_24h === 'number' ? c.price_change_percentage_24h : null,
          rank: c.market_cap_rank,
        }));
      });
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          // короткий TTL — как и обычная текущая цена, но список из 10 монет
          // за один запрос вместо семи отдельных, так что нагрузка даже ниже
          'Cache-Control': 'public, max-age=45, s-maxage=60, stale-while-revalidate=180',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ type: 'top10', coins }),
      };
    } catch (err) {
      return {
        statusCode: 502,
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
      };
    }
  }

  if (!coin || (type !== 'current' && type !== 'history')) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'нужны параметры: type=current|history|top10, coin=<id>, date=YYYY-MM (для history)' }),
    };
  }

  try {
    let price, cacheControl;
    let change24h = null; // только для type=current — используется старым способом получения цены одной монеты

    if (type === 'history') {
      if (!date) {
        return { statusCode: 400, body: JSON.stringify({ error: 'для type=history нужен date=YYYY-MM' }) };
      }
      const [y, m] = date.split('-');
      const apiDate = `01-${m}-${y}`;
      const key = cacheKey('history', coin, date);

      price = await dedupedFetch(key, async () => {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/coins/${coin}/history?date=${apiDate}&localization=false`,
          { headers: apiKeyHeaders() }
        );
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          throw new Error(`coingecko history ${res.status}: ${bodyText.slice(0, 300)}`);
        }
        const json = await res.json();
        const p = json?.market_data?.current_price?.usd;
        if (!p) throw new Error('нет цены в ответе coingecko');
        return p;
      });

      // исторические цены не меняются — кэшируем на CDN очень надолго
      cacheControl = 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800';
    } else {
      const key = cacheKey('current', coin);

      const result = await dedupedFetch(key, async () => {
        // include_24hr_change даёт % изменения за сутки почти бесплатно —
        // используется только живым тикером цен, но запрашиваем всегда,
        // чтобы не плодить второй набор кэш-ключей на тот же coin
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=usd&include_24hr_change=true`,
          { headers: apiKeyHeaders() }
        );
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          throw new Error(`coingecko simple/price ${res.status}: ${bodyText.slice(0, 300)}`);
        }
        const json = await res.json();
        const p = json?.[coin]?.usd;
        if (!p) throw new Error('нет цены в ответе coingecko');
        const chg = json?.[coin]?.usd_24h_change;
        return { price: p, change24h: typeof chg === 'number' ? chg : null };
      });
      price = result.price;
      change24h = result.change24h;

      // текущая цена — короткий TTL на edge, чтобы не показывать совсем старьё,
      // но всё равно гасит основной шквал одновременных запросов
      cacheControl = 'public, max-age=30, s-maxage=45, stale-while-revalidate=120';
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': cacheControl,
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ coin, price, change24h, type, date: date || null }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
    };
  }
};
