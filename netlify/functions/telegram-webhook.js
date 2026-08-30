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

function isRu(languageCode) {
  return typeof languageCode === 'string' && languageCode.toLowerCase().startsWith('ru');
}

function fmtMoney(n) {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 });
}

const TEXT = {
  start: {
    ru: `👋 Привет! Я бот CryptoFumble.\n\nСчитаю, сколько бы у тебя было денег, если бы ты купил крипту раньше 😅\n\nКоманда:\n/calc <монета> <сумма> <год-месяц>\n\nПример:\n/calc btc 100 2020-01\n\nДоступные монеты: ${COIN_LIST}\n\nПолный калькулятор и портфель — на cryptofumble.com`,
    en: `👋 Hey! I'm the CryptoFumble bot.\n\nI calculate how much money you'd have now if you'd bought crypto earlier 😅\n\nCommand:\n/calc <coin> <amount> <year-month>\n\nExample:\n/calc btc 100 2020-01\n\nAvailable coins: ${COIN_LIST}\n\nFull calculator & portfolio tracker: cryptofumble.com`,
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
    return t('priceError', ru);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    // Диагностика без утечки самого токена: только факт, что переменная
    // окружения дошла до функции, и её длина (чтобы заметить случайный
    // пробел/обрезанное значение). Открывается в браузере как обычная
    // страница — просто GET-запрос, без побочных эффектов.
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    return {
      statusCode: 200,
      body: `CryptoFumble Telegram webhook is alive. token_set=${!!token} token_length=${token.length}`,
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
    } else {
      await sendMessage(chatId, t('unknown', ru));
    }
  } catch (err) {
    // не роняем функцию из-за сбоя отправки — Telegram всё равно получит 200
  }

  return { statusCode: 200, body: 'ok' };
};
