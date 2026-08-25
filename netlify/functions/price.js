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

  if (!coin || (type !== 'current' && type !== 'history')) {
    // ВРЕМЕННАЯ ДИАГНОСТИКА: показываем, что реально пришло на вход функции,
    // чтобы понять, теряются ли query-параметры на пути через /api/price редирект.
    // Уберём этот блок, как только разберёмся с причиной.
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'нужны параметры: type=current|history, coin=<id>, date=YYYY-MM (для history)',
        debug_queryStringParameters: event.queryStringParameters || null,
        debug_rawQuery: event.rawQuery || null,
        debug_path: event.path || null,
        debug_rawUrl: event.rawUrl || null,
      }),
    };
  }

  try {
    let price, cacheControl;

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

      price = await dedupedFetch(key, async () => {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=usd`,
          { headers: apiKeyHeaders() }
        );
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          throw new Error(`coingecko simple/price ${res.status}: ${bodyText.slice(0, 300)}`);
        }
        const json = await res.json();
        const p = json?.[coin]?.usd;
        if (!p) throw new Error('нет цены в ответе coingecko');
        return p;
      });

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
      body: JSON.stringify({ coin, price, type, date: date || null }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
    };
  }
};
