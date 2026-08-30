// netlify/functions/telegram-webhook.js
//
// Принимает вебхуки от Telegram для бота @CryptoFumble_bot.
// V1: только текстовый калькулятор регрета прямо в чате, без привязки
// портфеля — это будет отдельной фазой поверх Upstash Redis (у нас уже
// подключён для feed.js), плюс еженедельный дайджест по подписке.
//
// Токен бота лежит только в переменной окружения Netlify TELEGRAM_BOT_TOKEN
// (Site settings → Environment variables) — в коде и в чате его нет.

const SYMBOL_TO_GECKO = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', DOGE: 'dogecoin',
  ADA: 'cardano', XRP: 'ripple', BNB: 'binancecoin',
};
const COIN_LIST = Object.keys(SYMBOL_TO_GECKO).join(', ');

// process.env.URL — это URL продакшн-сайта, который Netlify сама подставляет
// в рантайме функций; запасной вариант на случай локального запуска.
const SITE_URL = process.env.URL || 'https://cryptofumble.com';

// Тот же Upstash Redis, что уже используется в feed.js и telegram-link.js —
// сюда сайт кладёт временный код + снимок портфеля (см. telegram-link.js),
// а здесь бот его читает по команде /connect и привязывает к chat_id.
function upstashHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function isRu(languageCode) {
  return typeof languageCode === 'string' && languageCode.toLowerCase().startsWith('ru');
}

function fmtMoney(n) {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 });
}

const TEXT = {
  start: {
    ru: `👋 Привет! Я бот CryptoFumble.\n\nСчитаю, сколько бы у тебя было денег, если бы ты купил крипту раньше 😅\n\nКоманда:\n/calc <монета> <сумма> <год-месяц>\n\nПример:\n/calc btc 100 2020-01\n\nДоступные монеты: ${COIN_LIST}\n\nЕсть портфель на сайте? Подключи его командой /connect <код> (код показывает вкладка «Портфель») — раз в неделю пришлю апдейт по прибыли/убытку.\n\nПолный калькулятор и портфель — на cryptofumble.com`,
    en: `👋 Hey! I'm the CryptoFumble bot.\n\nI calculate how much money you'd have now if you'd bought crypto earlier 😅\n\nCommand:\n/calc <coin> <amount> <year-month>\n\nExample:\n/calc btc 100 2020-01\n\nAvailable coins: ${COIN_LIST}\n\nGot a portfolio on the site? Connect it with /connect <code> (the code shows up in the Portfolio tab) — I'll send you a weekly profit/loss update.\n\nFull calculator & portfolio tracker: cryptofumble.com`,
  },
  usage: {
    ru: `Формат: /calc <монета> <сумма> <год-месяц>\nПример: /calc eth 500 2021-06`,
    en: `Format: /calc <coin> <amount> <year-month>\nExample: /calc eth 500 2021-06`,
  },
  unknownCoin: {
    ru: `Не знаю такую монету 🤔 Доступны: ${COIN_LIST}`,
    en: `Don't know that coin 🤔 Available: ${COIN_LIST}`,
  },
  badAmount: {
    ru: `Сумма должна быть положительным числом. Пример: /calc btc 100 2020-01`,
    en: `Amount must be a positive number. Example: /calc btc 100 2020-01`,
  },
  badDate: {
    ru: `Дата должна быть в формате год-месяц, например 2020-01.`,
    en: `Date must be in year-month format, e.g. 2020-01.`,
  },
  futureDate: {
    ru: `Пока не умею смотреть в будущее 🔮 Укажи месяц не позже текущего.`,
    en: `Can't see the future yet 🔮 Pick a month up to the current one.`,
  },
  priceError: {
    ru: `Не получилось узнать цену 😕 Попробуй ещё раз через минуту.`,
    en: `Couldn't fetch the price 😕 Try again in a minute.`,
  },
  unknown: {
    ru: `Не понял 🙃 Напиши /start чтобы увидеть команды.`,
    en: `Didn't get that 🙃 Type /start to see commands.`,
  },
  connectUsage: {
    ru: `Формат: /connect <код>\nКод показывает сайт на вкладке «Портфель» после нажатия «Подключить уведомления в Telegram».`,
    en: `Format: /connect <code>\nGet the code from the site's Portfolio tab after clicking "Connect Telegram notifications".`,
  },
  connectBadCode: {
    ru: `Похоже, код неверный. Проверь и попробуй снова.`,
    en: `That code doesn't look right. Double-check and try again.`,
  },
  connectNotFound: {
    ru: `Код не найден или уже истёк (действует 15 минут). Сгенерируй новый на сайте.`,
    en: `Code not found or expired (codes last 15 minutes). Generate a new one on the site.`,
  },
  connectError: {
    ru: `Не получилось подключить портфель 😕 Попробуй ещё раз через минуту.`,
    en: `Couldn't connect the portfolio 😕 Try again in a minute.`,
  },
  connectNotConfigured: {
    ru: `Привязка портфеля пока не настроена на сервере. Попробуй позже.`,
    en: `Portfolio linking isn't configured on the server yet. Try again later.`,
  },
};

function t(key, ru) {
  return TEXT[key][ru ? 'ru' : 'en'];
}

async function fetchPrice(type, geckoId, date) {
  const params = new URLSearchParams({ type, coin: geckoId });
  if (date) params.set('date', date);
  const res = await fetch(`${SITE_URL}/.netlify/functions/price?${params.toString()}`);
  if (!res.ok) throw new Error(`price ${type} fetch failed: ${res.status}`);
  const json = await res.json();
  if (!json.price) throw new Error(`no price in response for ${type}`);
  return json.price;
}

async function sendMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set — cannot reply to Telegram');
    return; // токен ещё не настроен — молча выходим, не роняем функцию
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    // не палим сам токен в логах — только код ошибки и ответ Telegram
    const body = await res.text().catch(() => '');
    console.error('telegram sendMessage failed', res.status, body);
  }
}

async function handleCalc(args, ru) {
  if (args.length !== 3) return t('usage', ru);

  const symbol = args[0].toUpperCase();
  const geckoId = SYMBOL_TO_GECKO[symbol];
  if (!geckoId) return t('unknownCoin', ru);

  const amount = parseFloat(String(args[1]).replace(',', '.'));
  if (!isFinite(amount) || amount <= 0) return t('badAmount', ru);

  const dateMatch = args[2].match(/^(\d{4})-(\d{1,2})$/);
  if (!dateMatch) return t('badDate', ru);
  const year = parseInt(dateMatch[1], 10);
  const month = parseInt(dateMatch[2], 10);
  if (month < 1 || month > 12) return t('badDate', ru);
  const dateStr = `${year}-${String(month).padStart(2, '0')}`;

  const now = new Date();
  const maxYear = now.getUTCFullYear();
  const maxMonth = now.getUTCMonth() + 1;
  if (year > maxYear || (year === maxYear && month > maxMonth)) return t('futureDate', ru);

  try {
    const [pastPrice, currentPrice] = await Promise.all([
      fetchPrice('history', geckoId, dateStr),
      fetchPrice('current', geckoId),
    ]);
    const qty = amount / pastPrice;
    const nowValue = qty * currentPrice;
    const multiplier = nowValue / amount;
    const arrow = multiplier >= 1 ? '📈' : '📉';
    const moneyLine = ru
      ? `${arrow} ${fmtMoney(amount)} в ${symbol} в ${dateStr} → сейчас ${fmtMoney(nowValue)} (×${multiplier.toFixed(1)})`
      : `${arrow} ${fmtMoney(amount)} in ${symbol} in ${dateStr} → now ${fmtMoney(nowValue)} (×${multiplier.toFixed(1)})`;
    const linkLine = ru
      ? `\n\nПодробный разбор и портфель: cryptofumble.com`
      : `\n\nFull breakdown & portfolio: cryptofumble.com`;
    return moneyLine + linkLine;
  } catch (err) {
    console.error('handleCalc price fetch failed', String(err && err.message || err));
    return t('priceError', ru);
  }
}

async function handleConnect(rawCode, chatId, ru) {
  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REST_URL || !REST_TOKEN) return t('connectNotConfigured', ru);

  const code = String(rawCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return t('connectBadCode', ru);

  try {
    const headers = upstashHeaders(REST_TOKEN);
    const getRes = await fetch(`${REST_URL}/get/tglink:${code}`, { headers });
    if (!getRes.ok) throw new Error(`upstash get ${getRes.status}`);
    const getJson = await getRes.json();
    if (!getJson || !getJson.result) return t('connectNotFound', ru);

    let entries;
    try {
      entries = JSON.parse(getJson.result);
    } catch (parseErr) {
      return t('connectNotFound', ru);
    }
    if (!Array.isArray(entries) || entries.length === 0) return t('connectNotFound', ru);

    // привязываем снимок портфеля к chat_id постоянно, регистрируем chat_id
    // в множестве подписчиков (для будущей еженедельной рассылки), запоминаем
    // язык, и удаляем одноразовый код — использованный код больше не годится
    await Promise.all([
      fetch(`${REST_URL}/set/portfolio:${chatId}`, { method: 'POST', headers, body: JSON.stringify(entries) }),
      fetch(`${REST_URL}/sadd/tg:subscribers/${chatId}`, { headers }),
      fetch(`${REST_URL}/set/lang:${chatId}/${ru ? 'ru' : 'en'}`, { headers }),
    ]);
    await fetch(`${REST_URL}/del/tglink:${code}`, { headers });

    const coinCount = new Set(entries.map((e) => e.geckoId)).size;
    return ru
      ? `✅ Портфель подключен (монет: ${coinCount})! Раз в неделю пришлю апдейт по прибыли/убытку. Чтобы обновить портфель — сгенерируй новый код на сайте и пришли его снова через /connect.`
      : `✅ Portfolio connected (${coinCount} coin${coinCount === 1 ? '' : 's'})! I'll send you a weekly profit/loss update. To refresh it later, generate a new code on the site and send it again via /connect.`;
  } catch (err) {
    console.error('handleConnect failed', String(err && err.message || err));
    return t('connectError', ru);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    // Диагностика без утечки самого токена: только факт, что переменная
    // окружения дошла до функции, и её длина (чтобы заметить случайный
    // пробел/обрезанное значение). Открывается в браузере как обычная
    // страница — просто GET-запрос, без побочных эффектов.
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    let priceCheck;
    try {
      const testUrl = `${SITE_URL}/.netlify/functions/price?type=current&coin=bitcoin`;
      const testRes = await fetch(testUrl);
      const testBody = await testRes.text();
      priceCheck = `url=${testUrl} status=${testRes.status} body=${testBody.slice(0, 200)}`;
    } catch (err) {
      priceCheck = `threw: ${String(err && err.message || err)}`;
    }
    return {
      statusCode: 200,
      body: `CryptoFumble Telegram webhook is alive. token_set=${!!token} token_length=${token.length} SITE_URL=${SITE_URL} price_check: ${priceCheck}`,
    };
  }

  let update;
  try {
    update = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 200, body: 'ok' }; // всегда 200 — иначе Telegram будет долбить ретраями
  }

  const message = update.message;
  if (!message || typeof message.text !== 'string') {
    return { statusCode: 200, body: 'ok' };
  }

  const chatId = message.chat.id;
  const text = message.text.trim();
  const ru = isRu(message.from && message.from.language_code);

  try {
    if (text === '/start' || text.startsWith('/start ')) {
      await sendMessage(chatId, t('start', ru));
    } else if (text === '/calc' || text.startsWith('/calc ')) {
      const args = text.split(/\s+/).slice(1);
      const reply = await handleCalc(args, ru);
      await sendMessage(chatId, reply);
    } else if (text === '/connect' || text.startsWith('/connect ')) {
      const args = text.split(/\s+/).slice(1);
      if (args.length !== 1) {
        await sendMessage(chatId, t('connectUsage', ru));
      } else {
        const reply = await handleConnect(args[0], chatId, ru);
        await sendMessage(chatId, reply);
      }
    } else {
      await sendMessage(chatId, t('unknown', ru));
    }
  } catch (err) {
    // не роняем функцию из-за сбоя отправки — Telegram всё равно получит 200
  }

  return { statusCode: 200, body: 'ok' };
};
