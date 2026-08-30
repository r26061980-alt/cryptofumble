// netlify/functions/telegram-link.js
//
// Принимает временный код + снимок портфеля с сайта (POST из вкладки
// «Портфель», кнопка «Подключить уведомления в Telegram»), кладёт его в
// Upstash Redis на 15 минут. Пользователь затем вводит этот код в самом
// Telegram-боте командой /connect <код> — там (telegram-webhook.js) снимок
// прочитывается, привязывается к chat_id и удаляется отсюда.
//
// Тот же паттерн Upstash REST API, что уже используется в feed.js — без
// npm, без сборки, обычный fetch. Переменные окружения те же самые:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

const LINK_TTL_SECONDS = 900; // 15 минут — достаточно, чтобы переключиться в Telegram и ввести код
const MAX_ENTRIES = 300; // защита от неадекватно большого пейлоада через публичный эндпоинт

function upstashHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

exports.handler = async (event) => {
  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }
  if (!REST_URL || !REST_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: 'not_configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bad_json' }) };
  }

  const code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bad_code' }) };
  }

  const rawPortfolio = Array.isArray(body.portfolio) ? body.portfolio : [];
  // жёсткая нормализация каждой записи — сохраняем только ожидаемые поля,
  // с обрезкой длины/приведением типов, чтобы никто не мог протащить
  // произвольный мусор в хранилище через этот публичный эндпоинт
  const entries = rawPortfolio
    .slice(0, MAX_ENTRIES)
    .map((e) => ({
      symbol: String((e && e.symbol) || '?').slice(0, 12),
      name: String((e && e.name) || '').slice(0, 60),
      geckoId: String((e && e.geckoId) || '').slice(0, 60),
      dateStr: String((e && e.dateStr) || '').slice(0, 20),
      qty: Number.isFinite(e && e.qty) ? e.qty : 0,
      spent: Number.isFinite(e && e.spent) ? e.spent : 0,
    }))
    .filter((e) => e.geckoId && e.qty > 0 && e.spent > 0);

  if (entries.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'empty_portfolio' }) };
  }

  try {
    const key = `tglink:${code}`;
    const headers = upstashHeaders(REST_TOKEN);
    const setRes = await fetch(`${REST_URL}/set/${key}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(entries),
    });
    if (!setRes.ok) throw new Error(`upstash set ${setRes.status}`);
    await fetch(`${REST_URL}/expire/${key}/${LINK_TTL_SECONDS}`, { headers });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, expiresIn: LINK_TTL_SECONDS }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'upstream_unavailable', detail: String(err.message || err) }),
    };
  }
};
