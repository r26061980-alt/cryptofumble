// netlify/functions/telegram-digest.js
//
// Еженедельная рассылка по прибыли/убытку всем, кто подключил портфель через
// /connect в @CryptoFumble_bot (см. telegram-webhook.js). Пока тестируем —
// эту функцию можно вызвать вручную обычным запросом на её URL; расписание
// (netlify.toml, schedule = "0 9 * * 1" — понедельник 9:00 UTC) добавляем
// отдельным шагом ПОСЛЕ того, как убедимся, что она реально работает —
// потому что Netlify не даёт вызвать вручную функцию, которой уже назначено
// расписание (см. netlify.toml, схема добавляется отдельно).
//
// Тот же Upstash Redis, что и в feed.js / telegram-link.js / telegram-webhook.js:
//   tg:subscribers      — множество chat_id всех, кто подключил портфель
//   portfolio:<chatId>  — снимок портфеля (тот же формат, что в localStorage сайта)
//   lang:<chatId>       — 'ru' | 'en' — язык ответа бота при подключении

const SITE_URL = process.env.URL || 'https://cryptofumble.com';

function upstashHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function fmtMoney(n) {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2 });
}

async function sendMessage(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('digest sendMessage failed', chatId, res.status, body);
  }
}

async function fetchCurrentPrice(geckoId) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/price?type=current&coin=${geckoId}`);
  if (!res.ok) throw new Error(`price fetch failed for ${geckoId}: ${res.status}`);
  const json = await res.json();
  if (!json.price) throw new Error(`no price for ${geckoId}`);
  return json.price;
}

// Строит текст сообщения — та же логика группировки/усреднения, что и в
// pfRender() на сайте (группируем по geckoId, считаем среднюю цену и P/L).
function buildDigestText(entries, priceMap, ru) {
  const groups = {};
  entries.forEach((e) => {
    if (!groups[e.geckoId]) groups[e.geckoId] = { symbol: e.symbol, entries: [] };
    groups[e.geckoId].entries.push(e);
  });

  let totalSpent = 0;
  let totalValue = 0;
  let anyMissing = false;
  const lines = Object.keys(groups).map((geckoId) => {
    const g = groups[geckoId];
    const qty = g.entries.reduce((s, e) => s + e.qty, 0);
    const spent = g.entries.reduce((s, e) => s + e.spent, 0);
    totalSpent += spent;
    const price = priceMap[geckoId];
    if (!price) {
      anyMissing = true;
      return ru ? `• ${g.symbol}: цена сейчас недоступна` : `• ${g.symbol}: price unavailable right now`;
    }
    const value = qty * price;
    totalValue += value;
    const pnl = value - spent;
    const pct = spent > 0 ? (value / spent - 1) * 100 : 0;
    const arrow = pnl >= 0 ? '📈' : '📉';
    return `${arrow} ${g.symbol}: ${fmtMoney(value)} (${pnl >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
  });

  let header;
  if (anyMissing) {
    // не показываем "итого сейчас"/P&L, если хотя бы одна цена не получена —
    // иначе это выглядело бы как реальный убыток (например "-100%"), хотя
    // на деле мы просто не смогли узнать текущую цену одной из монет
    header = ru
      ? `📊 Еженедельный апдейт по портфелю\n\nВложено: ${fmtMoney(totalSpent)}\n(не все текущие цены удалось получить — общий итог сейчас не показываю, но вот что есть)`
      : `📊 Weekly portfolio update\n\nInvested: ${fmtMoney(totalSpent)}\n(couldn't get all current prices — skipping the overall total for now, here's what's available)`;
  } else {
    const overallPnl = totalValue - totalSpent;
    const overallPct = totalSpent > 0 ? (totalValue / totalSpent - 1) * 100 : 0;
    header = ru
      ? `📊 Еженедельный апдейт по портфелю\n\nВложено: ${fmtMoney(totalSpent)}\nСейчас: ${fmtMoney(totalValue)}\nP/L: ${overallPnl >= 0 ? '+' : ''}${overallPct.toFixed(1)}%`
      : `📊 Weekly portfolio update\n\nInvested: ${fmtMoney(totalSpent)}\nWorth now: ${fmtMoney(totalValue)}\nP/L: ${overallPnl >= 0 ? '+' : ''}${overallPct.toFixed(1)}%`;
  }
  const footer = ru
    ? `\n\nПодробности и обновление портфеля: cryptofumble.com`
    : `\n\nDetails & update your portfolio: cryptofumble.com`;

  return header + '\n\n' + lines.join('\n') + footer;
}

exports.handler = async (event) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!token || !REST_URL || !REST_TOKEN) {
    console.error('telegram-digest: missing config', { hasToken: !!token, hasRedis: !!(REST_URL && REST_TOKEN) });
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'not_configured' }) };
  }

  const headers = upstashHeaders(REST_TOKEN);

  let chatIds = [];
  try {
    const res = await fetch(`${REST_URL}/smembers/tg:subscribers`, { headers });
    if (!res.ok) throw new Error(`smembers ${res.status}`);
    const json = await res.json();
    chatIds = json.result || [];
  } catch (err) {
    console.error('telegram-digest: failed to list subscribers', String(err && err.message || err));
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'subscribers_list_failed' }) };
  }

  if (chatIds.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, subscribers: 0, sent: 0 }) };
  }

  // тянем портфель + язык для каждого подписчика параллельно
  const subs = await Promise.all(chatIds.map(async (chatId) => {
    try {
      const [pfRes, langRes] = await Promise.all([
        fetch(`${REST_URL}/get/portfolio:${chatId}`, { headers }),
        fetch(`${REST_URL}/get/lang:${chatId}`, { headers }),
      ]);
      const pfJson = await pfRes.json();
      const langJson = await langRes.json();
      if (!pfJson.result) return null;
      const entries = JSON.parse(pfJson.result);
      if (!Array.isArray(entries) || entries.length === 0) return null;
      return { chatId, entries, ru: langJson.result === 'ru' };
    } catch (err) {
      console.error('telegram-digest: failed to load subscriber', chatId, String(err && err.message || err));
      return null;
    }
  }));
  const validSubs = subs.filter(Boolean);

  // один живой запрос цены на уникальную монету на всю рассылку — не по разу
  // на каждого подписчика, кто её держит
  const uniqueGeckoIds = [...new Set(validSubs.flatMap((s) => s.entries.map((e) => e.geckoId)))];
  const priceMap = {};
  await Promise.all(uniqueGeckoIds.map(async (id) => {
    try {
      priceMap[id] = await fetchCurrentPrice(id);
    } catch (err) {
      console.error('telegram-digest: price fetch failed', id, String(err && err.message || err));
    }
  }));

  let sent = 0;
  await Promise.all(validSubs.map(async (sub) => {
    try {
      const text = buildDigestText(sub.entries, priceMap, sub.ru);
      await sendMessage(token, sub.chatId, text);
      sent++;
    } catch (err) {
      console.error('telegram-digest: failed to send to', sub.chatId, String(err && err.message || err));
    }
  }));

  return { statusCode: 200, body: JSON.stringify({ ok: true, subscribers: chatIds.length, sent }) };
};
