# CryptoFumble — деплой на Netlify

Только английская версия. Ru-версию подключим позже отдельным шагом —
просто повторим тот же процесс с другим репо/сайтом и вторым доменом,
когда будет готов .ru (или другой) домен под русскую аудиторию.

## Структура
```
index.html              — сам сайт
netlify/functions/price.js   — прокси+кэш цен CoinGecko
netlify/functions/search.js  — прокси+кэш поиска монет
netlify.toml             — маршруты /api/*
```

## Деплой (репозиторий = сайт, без вложенных папок)

1. GitHub → New repository → назвать `cryptofumble` → создать
2. Загрузить ВСЕ файлы из этого архива в корень репозитория
   (Add file → Upload files, или git push, кто как привык)
3. Netlify → Add new site → Import an existing project → выбрать репозиторий
4. Base directory / Publish directory — оставить как есть (по умолчанию,
   ничего не менять) — сайт соберётся из корня репозитория
5. Deploy → получаешь временный адрес *.netlify.app, уже рабочий
6. Site settings → Domain management → Add custom domain → cryptofumble.com
7. Netlify покажет 4 nameserver-записи — скопировать
8. В Porkbun: твой домен → Nameservers → вставить эти 4 записи → сохранить
9. Подождать DNS (10 мин — 2 часа) → Netlify сам выпустит SSL
10. Открыть https://cryptofumble.com → посчитать любую монету → на чеке
    должен появиться бейдж "● live-данные coingecko" вместо "офлайн демо"
