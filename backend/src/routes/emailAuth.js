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
 * а забытый пароль сбрасывается кодом, присланным на почту (/forgot и /reset, письма через Resend).
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
    await query(`CREATE TABLE IF NOT EXISTS email_resets (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INT NOT NULL DEFAULT 0
    )`);
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

// ---------- Забыл пароль: код на почту ----------
// Письма уходят через Resend (https://resend.com): нужны переменные RESEND_API_KEY и MAIL_FROM (адрес на подтверждённом домене).
const codeHash = (email, code) => crypto.createHash('sha256').update(`${email}|${code}|${process.env.SESSION_SECRET || 'forma'}`).digest('hex');
async function sendMail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'Forma <no-reply@forma2ko5.online>', to: [to], subject, text }),
  });
  if (!r.ok) console.error('Mail failed:', r.status, (await r.text().catch(() => '')).slice(0, 200));
  return r.ok;
}

router.post('/forgot', async (req, res) => {
  await ready;
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Проверь адрес почты' });
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Отправка писем пока не настроена. Напиши в поддержку — поможем вернуть доступ.' });
  if (limited('fp-ip:' + req.ip, 8, 3600_000) || limited('fp:' + email, 3, 3600_000)) return res.status(429).json({ error: 'Слишком много запросов — попробуй через час' });
  const acc = await query('SELECT 1 FROM email_accounts WHERE email = $1', [email]);
  if (acc.rows.length) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await query(
      `INSERT INTO email_resets (email, code_hash, expires_at, attempts) VALUES ($1, $2, now() + interval '15 minutes', 0)
       ON CONFLICT (email) DO UPDATE SET code_hash = $2, expires_at = now() + interval '15 minutes', attempts = 0`,
      [email, codeHash(email, code)]
    );
    await sendMail(email, 'Код для входа в Forma', `Твой код: ${code}\n\nОн действует 15 минут. Если это был не ты — просто проигнорируй письмо, пароль не изменится.`).catch((e) => console.error('Mail error:', e.message));
  }
  // одинаковый ответ, есть такая почта или нет
  res.json({ ok: true });
});

router.post('/reset', async (req, res) => {
  await ready;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').replace(/\D/g, '');
  const password = String(req.body?.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Проверь адрес почты' });
  if (password.length < 8) return res.status(400).json({ error: 'Пароль — не короче 8 символов' });
  if (password.length > 100) return res.status(400).json({ error: 'Пароль слишком длинный' });
  if (limited('rs-ip:' + req.ip, 20, 3600_000)) return res.status(429).json({ error: 'Слишком много попыток — попробуй позже' });
  const r = await query('SELECT code_hash, attempts, expires_at > now() AS fresh FROM email_resets WHERE email = $1', [email]);
  const row = r.rows[0];
  if (!row || !row.fresh || row.attempts >= 5) return res.status(400).json({ error: 'Код не подходит или устарел — запроси новый' });
  const good = code.length === 6 && crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(codeHash(email, code)));
  if (!good) {
    await query('UPDATE email_resets SET attempts = attempts + 1 WHERE email = $1', [email]);
    return res.status(400).json({ error: 'Неверный код' });
  }
  const acc = await query('SELECT telegram_id FROM email_accounts WHERE email = $1', [email]);
  if (!acc.rows.length) return res.status(400).json({ error: 'Аккаунт не найден' });
  await query('UPDATE email_accounts SET pass_hash = $2 WHERE email = $1', [email, hashPassword(password)]);
  await query('DELETE FROM email_resets WHERE email = $1', [email]);
  const id = Number(acc.rows[0].telegram_id);
  const u = await query('SELECT username, first_name, last_name FROM users WHERE telegram_id = $1', [id]);
  const pr = u.rows[0] || {};
  const session = await createSession(id, { id, username: pr.username || null, first_name: pr.first_name || email.split('@')[0], last_name: pr.last_name || null }, req.headers['user-agent']);
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
