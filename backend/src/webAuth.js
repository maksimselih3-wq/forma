import crypto from 'crypto';
import { Router } from 'express';
import { query } from './db.js';

/**
 * Вход в Forma вне Telegram (сайт на главном экране телефона, будущие приложения).
 *
 * Как это работает:
 *  1. Приложение просит у сервера «код входа» и открывает бота по ссылке t.me/<бот>?start=wl_<код>.
 *  2. Бот присылает человеку сообщение «Войти в Forma на новом устройстве?» с кнопкой «Да, это я».
 *  3. Пока человек не нажал — приложение раз в пару секунд спрашивает сервер. После нажатия сервер
 *     отдаёт приложению длинный личный ключ (сессию), и дальше запросы идут с ним, как с подписью Telegram.
 *
 * В базе лежат только отпечатки (sha256) кодов и ключей: утечка базы не даёт войти в чужой аккаунт.
 */

const BOT_USERNAME = (process.env.BOT_USERNAME || 'forma2ko5_bot').replace(/^@/, '');
const LOGIN_TTL_MS = 10 * 60 * 1000;            // код входа живёт 10 минут
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;   // ключ живёт 90 дней с последнего использования
export const SESSION_PREFIX = 'fs_';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export const webAuthReady = (async () => {
  try {
    await query(`CREATE TABLE IF NOT EXISTS web_logins (
      code_hash TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      telegram_id BIGINT,
      tg_user JSONB,
      ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      tg_user JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used TIMESTAMPTZ NOT NULL DEFAULT now(),
      ua TEXT
    )`);
    await query('CREATE INDEX IF NOT EXISTS web_sessions_tg_idx ON web_sessions (telegram_id)');
  } catch (e) {
    console.error('webAuth tables failed:', e.message);
  }
})();

// ---------- сессии ----------
const cache = new Map(); // отпечаток -> { user, until }: чтобы не ходить в базу на каждый запрос
const CACHE_MS = 60_000;

/** Только из памяти (для ограничителя запросов, он не умеет ждать базу). */
export function peekSession(token) {
  if (!token || !String(token).startsWith(SESSION_PREFIX)) return null;
  const c = cache.get(sha(token));
  return c && c.until > Date.now() ? c.user : null;
}

/** Пользователь по ключу сессии или null. */
export async function sessionUser(token) {
  token = String(token || '');
  if (!token.startsWith(SESSION_PREFIX) || token.length < 30 || token.length > 120) return null;
  const h = sha(token);
  const c = cache.get(h);
  if (c && c.until > Date.now()) return c.user;
  await webAuthReady;
  const r = await query(
    `SELECT telegram_id, tg_user, last_used FROM web_sessions WHERE token_hash = $1 AND last_used > now() - ($2 || ' milliseconds')::interval`,
    [h, String(SESSION_TTL_MS)]);
  const row = r.rows[0];
  if (!row) { cache.delete(h); return null; }
  let base = row.tg_user;
  if (typeof base === 'string') { try { base = JSON.parse(base); } catch (e) { base = {}; } }
  if (!base || typeof base !== 'object') base = {};
  const user = { ...base, id: Number(row.telegram_id) };
  if (cache.size > 20000) cache.clear();
  cache.set(h, { user, until: Date.now() + CACHE_MS });
  // «последний вход» обновляем не чаще раза в час
  if (Date.now() - new Date(row.last_used).getTime() > 3600_000) {
    query('UPDATE web_sessions SET last_used = now() WHERE token_hash = $1', [h]).catch(() => {});
  }
  return user;
}

export async function revokeSession(token) {
  const h = sha(token);
  cache.delete(h);
  await webAuthReady;
  await query('DELETE FROM web_sessions WHERE token_hash = $1', [h]);
}

/** Выйти со всех устройств (при удалении аккаунта). */
export async function revokeAllSessions(telegramId) {
  await webAuthReady;
  const r = await query('DELETE FROM web_sessions WHERE telegram_id = $1 RETURNING token_hash', [telegramId]);
  for (const row of r.rows) cache.delete(row.token_hash);
}

// ---------- вход через бота ----------
export async function startLogin(ip) {
  await webAuthReady;
  const code = crypto.randomBytes(12).toString('hex'); // 24 символа
  await query('DELETE FROM web_logins WHERE created_at < now() - interval \'1 hour\'');
  await query('INSERT INTO web_logins (code_hash, ip) VALUES ($1, $2)', [sha(code), ip || null]);
  return { code, link: `https://t.me/${BOT_USERNAME}?start=wl_${code}`, expires_in: LOGIN_TTL_MS / 1000 };
}

/** Бот: человек увидел запрос. true — код действительный. */
export async function loginPending(code) {
  if (!/^[a-f0-9]{24}$/.test(String(code))) return false;
  await webAuthReady;
  const r = await query(
    `SELECT 1 FROM web_logins WHERE code_hash = $1 AND status = 'pending' AND created_at > now() - ($2 || ' milliseconds')::interval`,
    [sha(code), String(LOGIN_TTL_MS)]);
  return r.rows.length > 0;
}

/** Бот: человек нажал «Да, это я». */
export async function confirmLogin(code, from) {
  if (!/^[a-f0-9]{24}$/.test(String(code)) || !from?.id) return false;
  await webAuthReady;
  const tgUser = { id: from.id, first_name: from.first_name || null, last_name: from.last_name || null, username: from.username || null };
  const r = await query(
    `UPDATE web_logins SET status = 'ok', telegram_id = $2, tg_user = $3
     WHERE code_hash = $1 AND status = 'pending' AND created_at > now() - ($4 || ' milliseconds')::interval RETURNING 1`,
    [sha(code), from.id, JSON.stringify(tgUser), String(LOGIN_TTL_MS)]);
  return r.rows.length > 0;
}

/** Бот: «Нет, это не я». */
export async function denyLogin(code) {
  if (!/^[a-f0-9]{24}$/.test(String(code))) return;
  await webAuthReady;
  await query(`UPDATE web_logins SET status = 'denied' WHERE code_hash = $1 AND status = 'pending'`, [sha(code)]);
}

async function pollLogin(code, ua) {
  if (!/^[a-f0-9]{24}$/.test(String(code))) return { status: 'expired' };
  await webAuthReady;
  const h = sha(code);
  const r = await query('SELECT status, telegram_id, tg_user, created_at FROM web_logins WHERE code_hash = $1', [h]);
  const row = r.rows[0];
  if (!row || Date.now() - new Date(row.created_at).getTime() > LOGIN_TTL_MS) return { status: 'expired' };
  if (row.status === 'denied') { await query('DELETE FROM web_logins WHERE code_hash = $1', [h]); return { status: 'denied' }; }
  if (row.status !== 'ok') return { status: 'pending' };
  // забираем ровно один раз: следующий запрос с тем же кодом ничего не получит
  const del = await query(`DELETE FROM web_logins WHERE code_hash = $1 AND status = 'ok' RETURNING 1`, [h]);
  if (!del.rows.length) return { status: 'expired' };
  const token = SESSION_PREFIX + crypto.randomBytes(32).toString('hex');
  await query('INSERT INTO web_sessions (token_hash, telegram_id, tg_user, ua) VALUES ($1, $2, $3, $4)',
    [sha(token), row.telegram_id, row.tg_user ? (typeof row.tg_user === 'string' ? row.tg_user : JSON.stringify(row.tg_user)) : null, String(ua || '').slice(0, 200)]);
  return { status: 'ok', session: token };
}

/** Выдать ключ сессии (для входа по почте и других способов входа, кроме бота). */
export async function createSession(telegramId, tgUser, ua) {
  await webAuthReady;
  const token = SESSION_PREFIX + crypto.randomBytes(32).toString('hex');
  await query('INSERT INTO web_sessions (token_hash, telegram_id, tg_user, ua) VALUES ($1, $2, $3, $4)',
    [sha(token), telegramId, tgUser ? JSON.stringify(tgUser) : null, String(ua || '').slice(0, 200)]);
  return token;
}

// ---------- маршруты (без проверки Telegram: человек как раз входит) ----------
const router = Router();
const startHits = new Map(); // ip -> [времена]: не больше 15 новых кодов в час с одного адреса

router.post('/start', async (req, res) => {
  const now = Date.now();
  const list = (startHits.get(req.ip) || []).filter((t) => now - t < 3600_000);
  if (list.length >= 15) return res.status(429).json({ error: 'Слишком много попыток входа — попробуй через час' });
  list.push(now);
  if (startHits.size > 20000) startHits.clear();
  startHits.set(req.ip, list);
  res.json(await startLogin(req.ip));
});

router.get('/poll', async (req, res) => {
  res.json(await pollLogin(req.query.code, req.headers['user-agent']));
});

router.post('/logout', async (req, res) => {
  const token = req.headers['x-forma-session'];
  if (token) await revokeSession(String(token)).catch(() => {});
  res.json({ ok: true });
});

export default router;
