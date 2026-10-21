import crypto from 'crypto';
import { Router } from 'express';
import { query } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { createSession } from '../webAuth.js';

/**
 * Вход по почте и паролю — для тех, у кого Telegram не работает (например, в России без VPN).
 *
 *  - register: новый человек создаёт аккаунт. Ему выдаётся собственный номер (в базе все аккаунты живут по «telegram_id»,
 *    поэтому для почтовых аккаунтов берём числа из отдельного диапазона, который не пересекается с настоящими id Telegram).
 *  - login: вход по почте и паролю на новом устройстве — выдаётся ключ сессии, как при входе через бота.
 *  - link: тот, кто уже пользуется Forma через Telegram, привязывает к своему аккаунту почту и пароль — и дальше может войти без Telegram.
 *
 * Пароли хранятся только в виде scrypt-отпечатков с солью. Почта пока не подтверждается письмом (почтового сервиса нет),
 * поэтому сбросить забытый пароль можно только из аккаунта, в который человек вошёл раньше.
 */

const router = Router();
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

let ready = (async () => {
  try {
    await query(`CREATE TABLE IF NOT EXISTS email_accounts (
      email TEXT PRIMARY KEY,
      pass_hash TEXT NOT NULL,
      telegram_id BIGINT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // собственные номера для почтовых аккаунтов: 7·10^15 и выше (id Telegram намного меньше)
    await query('CREATE SEQUENCE IF NOT EXISTS email_user_seq START 7000000000000000');
  } catch (e) { console.error('emailAuth tables failed:', e.message); }
})();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [v, saltHex, keyHex] = String(stored).split('$');
  if (v !== 's1' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(keyHex, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
const FAKE_HASH = hashPassword('forma-dummy-password'); // чтобы вход по несуществующей почте занимал столько же времени

// не больше 10 попыток за 15 минут с одного адреса и на одну почту
const hits = new Map();
function limited(key, max = 10, windowMs = 15 * 60_000) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) return true;
  list.push(now);
  if (hits.size > 20000) hits.clear();
  hits.set(key, list);
  return false;
}

function readCreds(body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: 'Проверь адрес почты' };
  if (password.length < 8) return { error: 'Пароль — не короче 8 символов' };
  if (password.length > 100) return { error: 'Пароль слишком длинный' };
  return { email, password };
}

router.post('/register', async (req, res) => {
  await ready;
  if (limited('reg:' + req.ip, 5, 3600_000)) return res.status(429).json({ error: 'Слишком много попыток — попробуй позже' });
  const c = readCreds(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  const name = String(req.body?.name || '').trim().slice(0, 40) || c.email.split('@')[0].slice(0, 30);
  const exists = await query('SELECT 1 FROM email_accounts WHERE email = $1', [c.email]);
  if (exists.rows.length) return res.status(409).json({ error: 'Этот адрес уже зарегистрирован — войди' });
  const id = Number((await query("SELECT nextval('email_user_seq') AS id")).rows[0].id);
  try {
    await query('INSERT INTO email_accounts (email, pass_hash, telegram_id) VALUES ($1, $2, $3)', [c.email, hashPassword(c.password), id]);
  } catch (e) { return res.status(409).json({ error: 'Этот адрес уже зарегистрирован — войди' }); }
  const session = await createSession(id, { id, first_name: name }, req.headers['user-agent']);
  res.json({ session });
});

router.post('/login', async (req, res) => {
  await ready;
  const c = readCreds(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  if (limited('ip:' + req.ip) || limited('em:' + c.email)) return res.status(429).json({ error: 'Слишком много попыток — попробуй через 15 минут' });
  const r = await query('SELECT pass_hash, telegram_id FROM email_accounts WHERE email = $1', [c.email]);
  const row = r.rows[0];
  const ok = checkPassword(c.password, row ? row.pass_hash : FAKE_HASH);
  if (!row || !ok) return res.status(401).json({ error: 'Неверная почта или пароль' });
  const id = Number(row.telegram_id);
  // имя берём из профиля (у привязанных аккаунтов это имя из Telegram)
  const u = await query('SELECT username, first_name, last_name FROM users WHERE telegram_id = $1', [id]);
  const p = u.rows[0] || {};
  const session = await createSession(id, { id, username: p.username || null, first_name: p.first_name || c.email.split('@')[0], last_name: p.last_name || null }, req.headers['user-agent']);
  res.json({ session });
});

// Привязка почты к аккаунту, в который человек уже вошёл
router.post('/link', requireTelegramAuth, async (req, res) => {
  await ready;
  const c = readCreds(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  if (limited('link:' + req.telegramUser.id, 10, 3600_000)) return res.status(429).json({ error: 'Слишком много попыток — попробуй позже' });
  const id = req.telegramUser.id;
  const taken = await query('SELECT telegram_id FROM email_accounts WHERE email = $1', [c.email]);
  if (taken.rows.length && Number(taken.rows[0].telegram_id) !== id) return res.status(409).json({ error: 'Эта почта уже привязана к другому аккаунту' });
  // у аккаунта одна почта: новая заменяет старую
  await query('DELETE FROM email_accounts WHERE telegram_id = $1', [id]);
  await query('INSERT INTO email_accounts (email, pass_hash, telegram_id) VALUES ($1, $2, $3)', [c.email, hashPassword(c.password), id]);
  res.json({ ok: true, email: c.email });
});

router.get('/status', requireTelegramAuth, async (req, res) => {
  await ready;
  const r = await query('SELECT email FROM email_accounts WHERE telegram_id = $1', [req.telegramUser.id]);
  res.json({ email: r.rows[0]?.email || null });
});

router.post('/unlink', requireTelegramAuth, async (req, res) => {
  await ready;
  await query('DELETE FROM email_accounts WHERE telegram_id = $1', [req.telegramUser.id]);
  res.json({ ok: true });
});

export default router;
