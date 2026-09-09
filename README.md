# TehnoRex → Telegram: автоанонсы новых статей

Публичный репозиторий-воркфлоу: каждые 5 минут проверяет sitemap журнала
https://tehnorex.by и отправляет в Telegram-канал **@tehnorexby** (TehnoRex.by)
анонс каждой новой статьи: обложка + заголовок + описание + ссылка.

Работает на серверах GitHub Actions — не зависит от локального ПК.

## Как это работает

1. `GitHub Actions` по расписанию `*/5 * * * *` (UTC) запускает `node tg_announce.js run`.
2. Скрипт скачивает `https://tehnorex.by/seo/sitemap_journal_1.xml`.
3. Сверяет список статей с логом `telegram_posted.json` (файл состояния в репозитории).
4. Для каждой новой статьи загружает страницу, извлекает заголовок/описание/обложку
   и отправляет пост в канал через Telegram Bot API.
5. Лог дописывается и коммитится обратно в репозиторий — дубли исключены.

## Настройка

1. В репозитории → **Settings → Secrets and variables → Actions → New repository secret**
   добавьте секрет **`TELEGRAM_BOT_TOKEN`** со значением токена бота из @BotFather.
   Токен нужен для публикации в канал (бот должен быть администратором канала).
2. Убедитесь, что workflow `announce.yml` включён (Actions → Announce new articles).
3. Можно запустить вручную: **Actions → Announce new articles → Run workflow**.

## Запуск локально (отладка)

```bash
TELEGRAM_BOT_TOKEN=<токен> node tg_announce.js run      # новые статьи
TELEGRAM_BOT_TOKEN=<токен> node tg_announce.js test <slug>  # тест одной статьи
TELEGRAM_BOT_TOKEN=<токен> node tg_announce.js probe <slug> # посмотреть извлечённые данные
```

## Важные замечания

- Расписание GitHub Actions — **не жёсткий тайминг**: запуск может задерживаться
  на несколько минут при высокой нагрузке.
- Расписания **автоматически отключаются после 60 дней без активности**
  в репозитории (любой коммит/запуск сбрасывает таймер).
- `telegram_posted.json` содержит служебный лог (slug, url, даты отправки) —
  без токенов и секретов.
