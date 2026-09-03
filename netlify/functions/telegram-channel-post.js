// netlify/functions/telegram-channel-post.js
//
// Ежедневный автопост в канал @CryptoFumble. Использует ТОЧНО ТОТ ЖЕ список
// сценариев и ту же логику выбора "сценария дня" (день года % длина массива),
// что и блок "РЕГРЕТ ДНЯ / УДАЧА ДНЯ" на самом сайте (см. DAILY_SCENARIOS и
// loadDailyRegret() в ru-index_working.html) — так пост в канале за любой
// день ВСЕГДА совпадает с тем, что в этот же день показывает сайт. Массив
// продублирован здесь (а не запрашивается с сайта), потому что это обычный
// JS-массив внутри HTML-страницы, а не отдельный API — так же, как уже
// задублированы таблицы исторических цен (DATA) между index_final.html,
// ru-index_working.html и generate.py. Если меняешь DAILY_SCENARIOS на
// сайте — продублируй изменение и сюда, иначе пост в канале разъедется с
// сайтом.
//
// Ссылка в посте — на глубокую ссылку ?coin=X&date=YYYY-MM (уже существующая
// фича сайта), так что нажавший сразу попадает на предзаполненный расчёт,
// а не на пустую форму.
//
// Пока тестируем — эту функцию можно вызвать вручную обычным запросом на её
// URL; расписание (netlify.toml, "0 7 * * *" = 10:00 по Москве) добавляем
// отдельным шагом ПОСЛЕ того, как убедимся, что она реально работает —
// Netlify не даёт вручную вызвать функцию, которой уже назначено расписание.

const SITE_URL = process.env.URL || 'https://cryptofumble.com';

// Тот же список и порядок, что и DAILY_SCENARIOS в ru-index_working.html.
const DAILY_SCENARIOS = [
  { symbol: 'BTC', date: '2020-03', blurb: 'Мартовский обвал 2020-го («чёрный четверг») на фоне начала пандемии — один из самых резких однодневных провалов в истории биткоина, и одна из лучших точек входа за весь цикл.' },
  { symbol: 'BTC', date: '2021-11', blurb: 'Исторический максимум цикла — момент, когда казалось, что рост никогда не остановится. Купившие ровно на этом пике потом почти год наблюдали затяжное падение.' },
  { symbol: 'BTC', date: '2022-12', blurb: 'Дно рынка сразу после краха биржи FTX — момент максимального страха, когда мало кто верил, что крипта вообще оправится.' },
  { symbol: 'ETH', date: '2021-11', blurb: 'Тот же пик цикла 2021 года, что и у биткоина выше — Ethereum тогда обновил свой исторический максимум и весь следующий год медленно откатывался вниз.' },
  { symbol: 'ETH', date: '2022-06', blurb: 'Дно затяжного медвежьего рынка 2022 года, сразу после крахов Terra/Luna и Celsius — одна из самых мрачных точек в истории Ethereum, и одна из лучших для покупки.' },
  { symbol: 'DOGE', date: '2021-05', blurb: 'Пик мемной мании вокруг Dogecoin в мае 2021-го, разогретой твитами Илона Маска и выступлением в Saturday Night Live — вскоре после этого цена резко обвалилась.' },
  { symbol: 'DOGE', date: '2020-01', blurb: 'Спокойный январь 2020-го — за полтора года до того, как Dogecoin превратился в главный мем-феномен крипторынка.' },
  { symbol: 'SOL', date: '2022-12', blurb: 'Solana была тесно связана с экосистемой FTX — после её краха монета обвалилась сильнее почти всех остальных крупных монет, но именно это и оказалось дном.' },
  { symbol: 'ADA', date: '2021-09', blurb: 'Пик цикла 2021 года для Cardano — после этого монета так и не вернулась к своему историческому максимуму.' },
  { symbol: 'XRP', date: '2017-12', blurb: 'Пик безумного ралли конца 2017 года — прямо перед началом многолетней судебной тяжбы XRP с американским регулятором SEC.' },
  { symbol: 'BNB', date: '2021-05', blurb: 'Пик цикла 2021 года для BNB — на волне того же общего мемного и альткоин-безумия, что и у Dogecoin в том же месяце.' },
];

const COIN_NAME = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', DOGE: 'Dogecoin', ADA: 'Cardano', XRP: 'XRP', BNB: 'BNB' };
const GECKO_ID = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', DOGE: 'dogecoin', ADA: 'cardano', XRP: 'ripple', BNB: 'binancecoin' };
const MONTH_NAMES_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];

// Тот же анкорный набор цен, что и DATA.<coin>.points на сайте — используется
// только если живой API недоступен (тот же fallback-принцип, что везде на
// сайте: тихо переключаемся на приблизительные данные, а не падаем с ошибкой).
const DEMO_POINTS = {
  BTC: [['2013-01',13],['2013-04',100],['2013-11',350],['2013-12',750],['2014-01',800],['2014-06',600],['2014-12',320],['2015-06',230],['2015-12',430],['2016-06',670],['2016-12',960],['2017-06',2500],['2017-09',4000],['2017-12',13800],['2018-01',10000],['2018-06',6300],['2018-12',3800],['2019-06',10800],['2019-12',7200],['2020-01',9350],['2020-03',5900],['2020-06',9100],['2020-12',29000],['2021-01',33000],['2021-04',57800],['2021-07',33000],['2021-11',64000],['2021-12',46000],['2022-01',38000],['2022-06',20000],['2022-11',16500],['2022-12',16500],['2023-01',23000],['2023-06',30500],['2023-10',34000],['2023-12',42000],['2024-01',43000],['2024-03',70000],['2024-06',64000],['2024-12',95000],['2025-03',100000],['2025-06',105000],['2025-12',112000],['2026-01',118000],['2026-04',122000],['2026-08',128000]],
  ETH: [['2016-01',1],['2017-06',200],['2017-12',750],['2018-01',1200],['2018-06',460],['2018-12',130],['2019-06',280],['2019-12',130],['2020-01',130],['2020-03',110],['2020-06',225],['2020-12',730],['2021-01',1000],['2021-05',2700],['2021-07',1900],['2021-11',4800],['2021-12',3700],['2022-01',3300],['2022-06',1100],['2022-11',1200],['2022-12',1200],['2023-01',1550],['2023-06',1900],['2023-12',2300],['2024-01',2300],['2024-03',3900],['2024-06',3400],['2024-12',3400],['2025-06',3600],['2026-01',3900],['2026-08',4200]],
  SOL: [['2020-05',0.5],['2020-12',1.5],['2021-01',1.8],['2021-05',35],['2021-09',140],['2021-11',260],['2021-12',170],['2022-01',150],['2022-06',38],['2022-11',13],['2022-12',10],['2023-01',11],['2023-06',18],['2023-12',100],['2024-01',100],['2024-03',200],['2024-06',150],['2024-12',190],['2025-06',210],['2026-01',235],['2026-08',255]],
  DOGE: [['2017-12',0.0095],['2020-01',0.0023],['2020-12',0.0047],['2021-01',0.0086],['2021-04',0.34],['2021-05',0.65],['2021-07',0.21],['2021-11',0.23],['2021-12',0.17],['2022-01',0.14],['2022-06',0.06],['2022-11',0.09],['2022-12',0.07],['2023-01',0.075],['2023-06',0.065],['2023-12',0.09],['2024-01',0.085],['2024-03',0.16],['2024-06',0.13],['2024-12',0.32],['2025-06',0.28],['2026-01',0.26],['2026-08',0.24]],
  ADA: [['2017-12',0.7],['2020-01',0.033],['2020-12',0.18],['2021-01',0.17],['2021-05',1.9],['2021-09',2.9],['2021-11',1.8],['2021-12',1.3],['2022-01',1.2],['2022-06',0.43],['2022-11',0.3],['2022-12',0.25],['2023-01',0.32],['2023-06',0.28],['2023-12',0.5],['2024-01',0.55],['2024-03',0.65],['2024-06',0.45],['2024-12',0.9],['2025-06',0.75],['2026-01',0.7],['2026-08',0.68]],
  XRP: [['2017-12',2.8],['2018-01',3.84],['2018-06',0.45],['2018-12',0.25],['2020-01',0.19],['2020-12',0.22],['2021-01',0.23],['2021-04',1.8],['2021-07',0.6],['2021-11',1.1],['2021-12',0.83],['2022-01',0.6],['2022-06',0.34],['2022-11',0.4],['2022-12',0.34],['2023-01',0.34],['2023-06',0.47],['2023-12',0.6],['2024-01',0.6],['2024-03',0.63],['2024-06',0.47],['2024-12',2.2],['2025-06',2.6],['2026-01',2.9],['2026-08',3.1]],
  BNB: [['2019-01',6],['2020-01',14],['2020-12',37],['2021-01',38],['2021-05',600],['2021-07',290],['2021-11',580],['2021-12',520],['2022-01',400],['2022-06',220],['2022-11',280],['2022-12',250],['2023-01',245],['2023-06',240],['2023-12',310],['2024-01',310],['2024-03',410],['2024-06',580],['2024-12',700],['2025-06',780],['2026-01',850],['2026-08',920]],
};

function monthToTs(m) {
  const [y, mo] = m.split('-').map(Number);
  return y * 12 + mo;
}
function interpPrice(points, dateStr) {
  const t = monthToTs(dateStr);
  const pts = points.map(([d, p]) => [monthToTs(d), p]);
  if (t <= pts[0][0]) return pts[0][1];
  if (t >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [t0, p0] = pts[i], [t1, p1] = pts[i + 1];
    if (t0 <= t && t <= t1) {
      const frac = (t - t0) / (t1 - t0);
      return Math.exp(Math.log(p0) + frac * (Math.log(p1) - Math.log(p0)));
    }
  }
  return pts[pts.length - 1][1];
}

function fmt(n) {
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function getTier(mult) {
  if (mult < 0.3) return { label: 'ПОЛНЫЙ РЕКТ', emoji: '💀' };
  if (mult < 0.7) return { label: 'СЕРТИФИЦИРОВАННЫЙ БЭГХОЛДЕР', emoji: '🧻' };
  if (mult < 1) return { label: 'ЛЁГКИЙ ПРОМАХ', emoji: '😬' };
  if (mult < 3) return { label: 'НЕПЛОХОЙ ХОД', emoji: '👍' };
  if (mult < 10) return { label: 'ХОРОШИЙ УЛОВ', emoji: '🎣' };
  if (mult < 50) return { label: 'ЛЕГЕНДАРНЫЙ ТАЙМИНГ', emoji: '🏆' };
  return { label: 'АЛМАЗНЫЕ РУКИ ОКУПИЛИСЬ', emoji: '💎' };
}

async function fetchPrice(type, geckoId, dateStr) {
  const qs = type === 'current'
    ? `type=current&coin=${geckoId}`
    : `type=history&coin=${geckoId}&date=${dateStr}`;
  const res = await fetch(`${SITE_URL}/.netlify/functions/price?${qs}`);
  if (!res.ok) throw new Error(`price proxy failed: ${res.status}`);
  const json = await res.json();
  if (!json.price) throw new Error('no price from proxy');
  return json.price;
}

async function sendChannelPost(token, chatId, text, buttonUrl, buttonLabel) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: buttonLabel, url: buttonUrl }]] },
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error('telegram-channel-post: sendMessage failed', res.status, body);
    throw new Error(`sendMessage failed: ${res.status} ${body}`);
  }
  return JSON.parse(body);
}

exports.handler = async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '@CryptoFumble';

  if (!token) {
    console.error('telegram-channel-post: missing TELEGRAM_BOT_TOKEN');
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'not_configured' }) };
  }

  // Тот же день-года индекс, что использует loadDailyRegret() на сайте —
  // см. комментарий в шапке файла про синхронизацию с DAILY_SCENARIOS.
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const scenario = DAILY_SCENARIOS[dayOfYear % DAILY_SCENARIOS.length];
  const geckoId = GECKO_ID[scenario.symbol];
  const coinName = COIN_NAME[scenario.symbol];
  const amount = 1000;

  let buyPrice, nowPrice, source = 'live';
  try {
    [buyPrice, nowPrice] = await Promise.all([
      fetchPrice('history', geckoId, scenario.date),
      fetchPrice('current', geckoId),
    ]);
  } catch (err) {
    console.error('telegram-channel-post: live price failed, falling back to demo data', String(err && err.message || err));
    const points = DEMO_POINTS[scenario.symbol];
    buyPrice = interpPrice(points, scenario.date);
    nowPrice = interpPrice(points, '2026-08');
    source = 'demo';
  }

  const coins = amount / buyPrice;
  const result = coins * nowPrice;
  const mult = result / amount;
  const tier = getTier(mult);
  const isGood = mult >= 1;
  const [y, m] = scenario.date.split('-');
  const monthPrep = MONTH_NAMES_PREP[parseInt(m, 10) - 1];

  const label = isGood ? '🚀 <b>УДАЧА ДНЯ</b>' : '📅 <b>РЕГРЕТ ДНЯ</b>';
  const mainLine = `Если бы ты вложил $1,000 в <b>${coinName}</b> в ${monthPrep} ${y}, сегодня у тебя было бы <b>${fmt(result)}</b>. ${tier.emoji} ${tier.label}`;
  const demoNote = source === 'demo' ? '\n\n<i>(цены — из резервного набора, живой источник был временно недоступен)</i>' : '';
  const text = `${label}\n\n${mainLine}\n\n${scenario.blurb}${demoNote}`;

  const deepLink = `${SITE_URL}/ru/?coin=${scenario.symbol}&date=${scenario.date}`;

  try {
    await sendChannelPost(token, CHANNEL_ID, text, deepLink, 'Проверить свою дату →');
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(err && err.message || err) }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, scenario, mult, source }) };
};
