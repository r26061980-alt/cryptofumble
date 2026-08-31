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

// CoinGecko's free/demo API key stopped allowing historical lookups older
// than ~365 days (error_code 10012, "Upgrade to a paid plan"). That broke the
// core "what if you'd bought in 2013/2017/2020" feature for anything before
// last year. Fix: fall back to the site's own rough anchor-point table with
// log-interpolation between points — the exact same method already used on
// the homepage for the gold/S&P500 "boring alternative" comparisons. Less
// precise than a live historical price, but keeps the whole product working
// instead of failing outright for most of its own date range.
function monthToTs(m) {
  const [y, mo] = m.split('-').map(Number);
  return y * 12 + mo;
}
function interpPrice(points, dateStr) {
  const t = monthToTs(dateStr);
  const pts = points.map((p) => [monthToTs(p[0]), p[1]]);
  if (t <= pts[0][0]) return pts[0][1];
  if (t >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [t0, p0] = pts[i];
    const [t1, p1] = pts[i + 1];
    if (t >= t0 && t <= t1) {
      const frac = (t - t0) / (t1 - t0);
      return Math.exp(Math.log(p0) + frac * (Math.log(p1) - Math.log(p0)));
    }
  }
  return pts[pts.length - 1][1];
}
// Тот же набор якорных точек, что и в DATA на главной странице (index_final.html /
// ru-index_working.html), только ключи — geckoId вместо тикера, чтобы можно было
// сразу использовать значение параметра coin=... без обратного маппинга.
const HISTORICAL_POINTS = {
  bitcoin: [
    ['2013-01', 13], ['2013-04', 100], ['2013-11', 350], ['2013-12', 750],
    ['2014-01', 800], ['2014-06', 600], ['2014-12', 320],
    ['2015-06', 230], ['2015-12', 430],
    ['2016-06', 670], ['2016-12', 960],
    ['2017-06', 2500], ['2017-09', 4000], ['2017-12', 13800],
    ['2018-01', 10000], ['2018-06', 6300], ['2018-12', 3800],
    ['2019-06', 10800], ['2019-12', 7200],
    ['2020-01', 9350], ['2020-03', 5900], ['2020-06', 9100], ['2020-12', 29000],
    ['2021-01', 33000], ['2021-04', 57800], ['2021-07', 33000], ['2021-11', 64000], ['2021-12', 46000],
    ['2022-01', 38000], ['2022-06', 20000], ['2022-11', 16500], ['2022-12', 16500],
    ['2023-01', 23000], ['2023-06', 30500], ['2023-10', 34000], ['2023-12', 42000],
    ['2024-01', 43000], ['2024-03', 70000], ['2024-06', 64000], ['2024-12', 95000],
    ['2025-03', 100000], ['2025-06', 105000], ['2025-12', 112000],
    ['2026-01', 118000], ['2026-04', 122000], ['2026-08', 128000],
  ],
  ethereum: [
    ['2016-01', 1], ['2017-06', 200], ['2017-12', 750],
    ['2018-01', 1200], ['2018-06', 460], ['2018-12', 130],
    ['2019-06', 280], ['2019-12', 130],
    ['2020-01', 130], ['2020-03', 110], ['2020-06', 225], ['2020-12', 730],
    ['2021-01', 1000], ['2021-05', 2700], ['2021-07', 1900], ['2021-11', 4800], ['2021-12', 3700],
    ['2022-01', 3300], ['2022-06', 1100], ['2022-11', 1200], ['2022-12', 1200],
    ['2023-01', 1550], ['2023-06', 1900], ['2023-12', 2300],
    ['2024-01', 2300], ['2024-03', 3900], ['2024-06', 3400], ['2024-12', 3400],
    ['2025-06', 3600], ['2026-01', 3900], ['2026-08', 4200],
  ],
  solana: [
    ['2020-05', 0.5], ['2020-12', 1.5],
    ['2021-01', 1.8], ['2021-05', 35], ['2021-09', 140], ['2021-11', 260], ['2021-12', 170],
    ['2022-01', 150], ['2022-06', 38], ['2022-11', 13], ['2022-12', 10],
    ['2023-01', 11], ['2023-06', 18], ['2023-12', 100],
    ['2024-01', 100], ['2024-03', 200], ['2024-06', 150], ['2024-12', 190],
    ['2025-06', 210], ['2026-01', 235], ['2026-08', 255],
  ],
  dogecoin: [
    ['2017-12', 0.0095],
    ['2020-01', 0.0023], ['2020-12', 0.0047],
    ['2021-01', 0.0086], ['2021-04', 0.34], ['2021-05', 0.65], ['2021-07', 0.21], ['2021-11', 0.23], ['2021-12', 0.17],
    ['2022-01', 0.14], ['2022-06', 0.06], ['2022-11', 0.09], ['2022-12', 0.07],
    ['2023-01', 0.075], ['2023-06', 0.065], ['2023-12', 0.09],
    ['2024-01', 0.085], ['2024-03', 0.16], ['2024-06', 0.13], ['2024-12', 0.32],
    ['2025-06', 0.28], ['2026-01', 0.26], ['2026-08', 0.24],
  ],
  cardano: [
    ['2017-12', 0.7],
    ['2020-01', 0.033], ['2020-12', 0.18],
    ['2021-01', 0.17], ['2021-05', 1.9], ['2021-09', 2.9], ['2021-11', 1.8], ['2021-12', 1.3],
    ['2022-01', 1.2], ['2022-06', 0.43], ['2022-11', 0.3], ['2022-12', 0.25],
    ['2023-01', 0.32], ['2023-06', 0.28], ['2023-12', 0.5],
    ['2024-01', 0.55], ['2024-03', 0.65], ['2024-06', 0.45], ['2024-12', 0.9],
    ['2025-06', 0.75], ['2026-01', 0.7], ['2026-08', 0.68],
  ],
  ripple: [
    ['2017-12', 2.8],
    ['2020-01', 0.19], ['2020-12', 0.22],
    ['2021-01', 0.23], ['2021-04', 1.8], ['2021-07', 0.6], ['2021-11', 1.1], ['2021-12', 0.83],
    ['2022-01', 0.6], ['2022-06', 0.34], ['2022-11', 0.4], ['2022-12', 0.34],
    ['2023-01', 0.34], ['2023-06', 0.47], ['2023-12', 0.6],
    ['2024-01', 0.6], ['2024-03', 0.63], ['2024-06', 0.47], ['2024-12', 2.2],
    ['2025-06', 2.6], ['2026-01', 2.9], ['2026-08', 3.1],
  ],
  binancecoin: [
    ['2019-01', 6],
    ['2020-01', 14], ['2020-12', 37],
    ['2021-01', 38], ['2021-05', 600], ['2021-07', 290], ['2021-11', 580], ['2021-12', 520],
    ['2022-01', 400], ['2022-06', 220], ['2022-11', 280], ['2022-12', 250],
    ['2023-01', 245], ['2023-06', 240], ['2023-12', 310],
    ['2024-01', 310], ['2024-03', 410], ['2024-06', 580], ['2024-12', 700],
    ['2025-06', 780], ['2026-01', 850], ['2026-08', 920],
  ],
};

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
    //
    // CoinGecko иногда включает в market_cap_desc токены с завышенной или
    // непоказательной капитализацией — например, токенизированные
    // финансовые продукты с почти нулевым реальным объёмом торгов
    // (обнаружено пользователем: FIGR_HELOC оказался в нашем топ-10, хотя
    // на CoinMarketCap его нет даже в топ-13 — там применяется более строгая
    // фильтрация данных). Берём с запасом 30 монет вместо 10 и отбрасываем
    // те, где объём торгов за 24ч подозрительно мал относительно капитализации
    // (порог 0.1% — с большим запасом ниже того, что показывают все настоящие
    // топ-10-монеты, но достаточно, чтобы отсечь малоликвидные аномалии),
    // затем берём первые 10 из того, что осталось.
    try {
      const key = 'top10';
      const coins = await dedupedFetch(key, async () => {
        const res = await fetch(
          'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&page=1&price_change_percentage=24h',
          { headers: apiKeyHeaders() }
        );
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          throw new Error(`coingecko markets ${res.status}: ${bodyText.slice(0, 300)}`);
        }
        const json = await res.json();
        const MIN_VOLUME_RATIO = 0.001; // объём/капитализация — минимум для "настоящей" ликвидной монеты
        const liquid = json.filter((c) => {
          const mcap = c.market_cap;
          const vol = c.total_volume;
          if (!mcap || mcap <= 0) return false;
          if (typeof vol !== 'number') return false;
          return vol / mcap >= MIN_VOLUME_RATIO;
        });
        return liquid.slice(0, 10).map((c) => ({
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

    let estimated = false; // true когда цена не живая с CoinGecko, а интерполирована по якорным точкам

    if (type === 'history') {
      if (!date) {
        return { statusCode: 400, body: JSON.stringify({ error: 'для type=history нужен date=YYYY-MM' }) };
      }
      const [y, m] = date.split('-');
      const apiDate = `01-${m}-${y}`;
      const key = cacheKey('history', coin, date);

      try {
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
      } catch (liveErr) {
        const points = HISTORICAL_POINTS[coin];
        if (!points) throw liveErr; // для монеты без своей таблицы якорных точек — настоящая ошибка
        price = interpPrice(points, date);
        estimated = true;
      }

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
      body: JSON.stringify({ coin, price, change24h, type, date: date || null, estimated }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
    };
  }
};
