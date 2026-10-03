import { validateInitData } from './telegramAuth.js';

/**
 * Простой ограничитель частоты запросов — без сторонних пакетов.
 *
 *  - Запрос с верной подписью Telegram (заголовок X-Telegram-Init-Data или ?auth= у картинок)
 *    считается на ЧЕЛОВЕКА: много людей за одним мобильным IP друг другу не мешают.
 *  - Без подписи или с неверной — считаем по IP, лимит строже. Мусорные подписи не создают
 *    «новых людей»: они все попадают в одну корзину этого IP.
 *
 * Работает в памяти одного процесса — для одного сервиса на Railway этого достаточно.
 */

const MAX_KEYS = 50000; // защита памяти: если ключей слишком много — начинаем с чистого листа

export function requestKey(req) {
  const raw = req.headers['x-telegram-init-data'] || req.query?.auth;
  const auth = raw ? validateInitData(String(raw)) : null;
  return auth?.user
    ? { key: `u:${auth.user.id}`, authed: true }
    : { key: `ip:${req.ip}`, authed: false };
}

export function rateLimit({ windowMs = 60_000, max = 300, anonMax = 120, skip } = {}) {
  const hits = new Map(); // ключ -> { n, resetAt }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  timer.unref?.(); // таймер не мешает серверу завершиться

  return (req, res, next) => {
    if (skip && skip(req)) return next();
    const { key, authed } = requestKey(req);
    const limit = authed ? max : anonMax;
    const now = Date.now();

    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      if (hits.size >= MAX_KEYS) hits.clear();
      h = { n: 0, resetAt: now + windowMs };
      hits.set(key, h);
    }
    h.n += 1;

    if (h.n > limit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((h.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Слишком много запросов — подожди минуту и попробуй снова' });
    }
    next();
  };
}
