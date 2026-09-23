# Athlete Diary — Backend

## Запуск
1. `npm install`
2. Скопируй `.env.example` в `.env` и заполни:
   - `BOT_TOKEN` — токен бота от @BotFather
   - `DATABASE_URL` — строка подключения к Postgres (например, из Supabase)
   - `ANTHROPIC_API_KEY` — ключ Claude API (console.anthropic.com)
3. Накати схему: `psql $DATABASE_URL -f schema.sql`
4. `npm run dev` — сервер поднимется на порту из `.env` (по умолчанию 3000)

## Эндпоинты
- `POST /api/auth/login` — логин через Telegram initData (заголовок `X-Telegram-Init-Data`)
- `POST /api/workouts` — создать/обновить запись за дату (тренировка или отдых)
- `GET /api/workouts` — список тренировок + текущий/лучший streak
- `POST /api/friends/request` — отправить заявку в друзья по telegram_id
- `POST /api/friends/accept` — принять заявку
- `GET /api/friends` — список друзей с их streak
- `GET /api/friends/:friendId/workouts` — публичные тренировки друга

## Что дальше
- Фронтенд (Telegram Mini App) — следующий шаг
- Регистрация бота через @BotFather и подключение Menu Button на URL фронта
