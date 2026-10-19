import crypto from 'node:crypto';
import { query } from './db.js';

/**
 * Push-уведомления в мобильное приложение (Android / iOS) через Firebase Cloud Messaging (HTTP v1).
 * Без внешних библиотек: ключ сервис-аккаунта подписывает короткий JWT, Google выдаёт access-токен.
 *
 * Нужна переменная FIREBASE_SERVICE_ACCOUNT — содержимое JSON-ключа сервис-аккаунта Firebase
 * (можно целиком JSON или в base64). Без неё push тихо выключен, всё остальное работает.
 */

const OAUTH_URL = process.env.FCM_OAUTH_URL || 'https://oauth2.googleapis.com/token';
const FCM_BASE = process.env.FCM_BASE_URL || 'https://fcm.googleapis.com';

function loadAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const acc = JSON.parse(text);
    if (!acc.client_email || !acc.private_key || !acc.project_id) return null;
    acc.private_key = String(acc.private_key).replace(/\\n/g, '\n');
    return acc;
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT: не удалось разобрать ключ');
    return null;
  }
}

let account; // undefined — ещё не читали
const getAccount = () => (account === undefined ? (account = loadAccount()) : account);
export const pushEnabled = () => !!getAccount();

export const pushReady = (async () => {
  try {
    await query(`CREATE TABLE IF NOT EXISTS push_tokens (
      token TEXT PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      platform TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`);
    await query('CREATE INDEX IF NOT EXISTS push_tokens_tg ON push_tokens (telegram_id)');
  } catch (e) {
    console.error('push_tokens setup failed:', e.message);
  }
})();

const b64u = (b) => Buffer.from(b).toString('base64url');

let cached = { token: '', exp: 0 };
async function accessToken() {
  const acc = getAccount();
  if (!acc) return null;
  if (cached.token && cached.exp > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: acc.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: OAUTH_URL,
    iat: now,
    exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(acc.private_key).toString('base64url');
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`oauth ${res.status} ${data.error || ''}`);
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cached.token;
}

// Telegram-текст (HTML, эмодзи, подпись про отключение) → короткий текст для уведомления
export function plainPush(html) {
  return String(html || '')
    .replace(/<i>[^<]*<\/i>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 220);
}

/**
 * Отправить push человеку на все его устройства.
 * Возвращает число устройств, на которые доставка принята (0 — push не вышел, можно слать в Telegram).
 */
export async function sendPush(telegramId, body, { title = '', data = {} } = {}) {
  const acc = getAccount();
  if (!acc || !telegramId || !body) return 0;
  await pushReady;
  let tokens;
  try {
    tokens = (await query('SELECT token FROM push_tokens WHERE telegram_id = $1', [telegramId])).rows.map((r) => r.token);
  } catch (e) { return 0; }
  if (!tokens.length) return 0;
  let at;
  try { at = await accessToken(); } catch (e) { console.error('Push auth failed:', e.message); return 0; }
  if (!at) return 0;

  let ok = 0;
  for (const token of tokens) {
    try {
      const res = await fetch(`${FCM_BASE}/v1/projects/${acc.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            // без заголовка: система сама подписывает уведомление названием приложения, и «Forma» дважды не появляется
            notification: title ? { title, body } : { body },
            data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
            android: { priority: 'HIGH' },
            apns: { payload: { aps: { sound: 'default' } } },
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) { ok++; continue; }
      const err = await res.json().catch(() => ({}));
      const status = err?.error?.status || '';
      if (res.status === 404 || status === 'NOT_FOUND' || status === 'UNREGISTERED' || status === 'INVALID_ARGUMENT') {
        // приложение удалено или ключ устарел — забываем это устройство
        await query('DELETE FROM push_tokens WHERE token = $1', [token]).catch(() => {});
      } else {
        console.error('Push failed:', res.status, status);
      }
    } catch (e) {
      console.error('Push error:', e.message);
    }
  }
  return ok;
}

export async function registerPushToken(telegramId, token, platform) {
  await pushReady;
  await query(
    `INSERT INTO push_tokens (token, telegram_id, platform) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET telegram_id = EXCLUDED.telegram_id, platform = EXCLUDED.platform, updated_at = now()`,
    [token, telegramId, platform || null]
  );
}

export async function removePushToken(telegramId, token) {
  await pushReady;
  await query('DELETE FROM push_tokens WHERE token = $1 AND telegram_id = $2', [token, telegramId]);
}
