// netlify/functions/feed.js
//
// Живая лента анонимных результатов расчёта. Хранилище — Upstash Redis
// (бесплатный тариф, доступ по обычному REST API через fetch — без npm,
// без package.json, без шага сборки, тот же паттерн, что price.js/search.js).
//
// GET  -> вернуть последние ~20 записей
// POST -> добавить новую запись (вызывается после каждого успешного расчёта)
//
// Переменные окружения (задаются в Netlify так же, как COINGECKO_API_KEY):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//
// Приватность: сохраняем только монету, режим, множитель, тир и итоговую
// сумму в округлённом виде — НИКАКИХ IP, User-Agent или другой личной
// информации. Вся запись — то же самое, что человек и так показал бы
// на публичной шеринг-карточке.

const FEED_KEY = 'feed';
const MAX_ENTRIES = 50; // сколько храним всего (лента показывает меньше)

function upstashHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

exports.handler = async (event) => {
  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!REST_URL || !REST_TOKEN) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'feed_not_configured' }),
    };
  }

  const headers = upstashHeaders(REST_TOKEN);

  if (event.httpMethod === 'GET') {
    try {
      const res = await fetch(`${REST_URL}/lrange/${FEED_KEY}/0/19`, { headers });
      if (!res.ok) throw new Error(`upstash lrange ${res.status}`);
      const json = await res.json();
      const entries = (json.result || [])
        .map((s) => {
          try { return JSON.parse(s); } catch { return null; }
        })
        .filter(Boolean);

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          // короткий edge-кэш — лента не обязана быть идеально свежей поминутно
          'Cache-Control': 'public, max-age=10, s-maxage=15, stale-while-revalidate=60',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ entries }),
      };
    } catch (err) {
      return {
        statusCode: 502,
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
      };
    }
  }

  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');

      // жёсткая нормализация — сохраняем только ожидаемые поля с обрезкой
      // длины, чтобы никто не мог протащить произвольный мусор в хранилище
      const entry = {
        coin: String(body.coin || '?').slice(0, 10),
        mode: body.mode === 'sold' ? 'sold' : 'bought',
        mult: Number.isFinite(body.mult) ? Math.round(body.mult * 10) / 10 : 0,
        tierEmoji: String(body.tierEmoji || '').slice(0, 4),
        tierLabel: String(body.tierLabel || '').slice(0, 40),
        resultFmt: String(body.resultFmt || '').slice(0, 20),
        ts: Date.now(),
      };

      await fetch(`${REST_URL}/lpush/${FEED_KEY}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(entry),
      });
      // не даём списку расти бесконечно
      await fetch(`${REST_URL}/ltrim/${FEED_KEY}/0/${MAX_ENTRIES - 1}`, { headers });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: true }),
      };
    } catch (err) {
      return {
        statusCode: 502,
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
      };
    }
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
};
