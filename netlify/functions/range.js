// netlify/functions/range.js
//
// Прокси для "кривой стоимости позиции" — набор точек цены между датой
// покупки и сегодня, для графика на чеке.
//
// НЕ используем /market_chart/range у CoinGecko — на demo-тарифе он режет
// историю до последних 365 дней, а у нас даты покупки бывают из 2013 года.
// Вместо этого дёргаем тот же /coins/{id}/history, что и price.js
// (type=history), по нескольким сэмплированным датам — работает для любой
// глубины истории и переиспользует тот же паттерн кэша/ключа.
//
// Сэмплинг ограничен ~12 точками за запрос, чтобы не упереться в рейт-лимит
// CoinGecko при холодном кэше.

const inflight = new Map();

function apiKeyHeaders() {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { 'x-cg-demo-api-key': key } : {};
}

async function dedupedFetch(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function fetchPriceAt(coin, dateStr) {
  const [y, m] = dateStr.split('-');
  const apiDate = `01-${m}-${y}`;
  const key = `history:${coin}:${dateStr}`;
  return dedupedFetch(key, async () => {
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
}

// строит до maxPoints дат (YYYY-MM), равномерно между from и to включительно
function sampleMonths(fromStr, toStr, maxPoints) {
  const [fy, fm] = fromStr.split('-').map(Number);
  const [ty, tm] = toStr.split('-').map(Number);
  const fromIdx = fy * 12 + (fm - 1);
  const toIdx = ty * 12 + (tm - 1);
  const totalMonths = toIdx - fromIdx;
  if (totalMonths <= 0) return [fromStr];
  const count = Math.min(maxPoints, totalMonths + 1);
  const step = totalMonths / (count - 1);
  const months = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.round(fromIdx + i * step);
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return [...new Set(months)];
}

exports.handler = async (event) => {
  const { coin, from } = event.queryStringParameters || {};

  if (!coin || !from) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'нужны параметры: coin=<id>, from=YYYY-MM' }),
    };
  }

  const now = new Date();
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  try {
    const months = sampleMonths(from, to, 12);
    const points = await Promise.all(
      months.map(async (dateStr) => ({
        date: dateStr,
        price: await fetchPriceAt(coin, dateStr),
      }))
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ coin, from, to, points }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
    };
  }
};
