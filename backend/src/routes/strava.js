import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';

import { query, dbReady } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { recalcStreak } from '../streak.js';

dotenv.config();

/**
 * Strava ⇄ Forma.
 *
 * Человек нажимает «Подключить Strava» в настройках → Strava спрашивает разрешение → мы получаем токены.
 * Дальше Strava сама присылает вебхук, когда у человека появляется новая тренировка, и мы кладём её в дневник
 * (запись приватная; человек потом дополняет её: самочувствие, заметки, отрезки).
 *
 * Переменные в Railway:
 *   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET — со страницы https://www.strava.com/settings/api
 *   STRAVA_VERIFY_TOKEN — любая строка (нужна один раз для подписки на вебхук; если не задана — берётся из секрета)
 *   PUBLIC_URL (уже есть) — адрес, на который Strava вернёт человека после разрешения.
 *   Необязательно: STRAVA_BACKFILL_DAYS (по умолчанию 7), STRAVA_NOTIFY=0 (не писать в бот), BOT_USERNAME.
 */

const router = express.Router();

const CLIENT_ID = (process.env.STRAVA_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.STRAVA_CLIENT_SECRET || '').trim();
const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL || 'https://maksimselih3-wq.github.io/forma-2/';
const SERVER_URL = (process.env.SERVER_URL || 'https://forma-production-9c7a.up.railway.app').replace(/\/+$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || SERVER_URL).replace(/\/+$/, '');
const BOT_USERNAME = (process.env.BOT_USERNAME || 'forma2ko5_bot').replace(/^@/, '');
const VERIFY_TOKEN = (process.env.STRAVA_VERIFY_TOKEN || '').trim()
  || (CLIENT_SECRET ? crypto.createHash('sha256').update('forma-strava-verify:' + CLIENT_SECRET).digest('hex').slice(0, 32) : '');
const BACKFILL_DAYS = Math.min(Math.max(Number(process.env.STRAVA_BACKFILL_DAYS) || 7, 1), 30);
const NOTIFY = process.env.STRAVA_NOTIFY !== '0';

export const stravaConfigured = () => !!(CLIENT_ID && CLIENT_SECRET);

const REDIRECT_URI = `${PUBLIC_URL}/api/strava/callback`;
const WEBHOOK_URL = `${SERVER_URL}/api/strava/webhook`;

// ---------- таблицы ----------
const stravaReady = (async () => {
  await dbReady;
  try {
    await query(`ALTER TABLE users
      ADD COLUMN IF NOT EXISTS strava_athlete_id BIGINT,
      ADD COLUMN IF NOT EXISTS strava_access_token TEXT,
      ADD COLUMN IF NOT EXISTS strava_refresh_token TEXT,
      ADD COLUMN IF NOT EXISTS strava_expires_at BIGINT,
      ADD COLUMN IF NOT EXISTS strava_connected_at TIMESTAMP`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_strava_athlete ON users(strava_athlete_id) WHERE strava_athlete_id IS NOT NULL`);
    await query(`ALTER TABLE workouts
      ADD COLUMN IF NOT EXISTS source TEXT,
      ADD COLUMN IF NOT EXISTS strava_activity_id BIGINT`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS workouts_strava_activity ON workouts(strava_activity_id) WHERE strava_activity_id IS NOT NULL`);
    console.log('Strava schema OK');
  } catch (err) {
    console.error('Strava schema failed:', err.message);
  }
})();

// ---------- токены хранятся зашифрованными ----------
const KEY = crypto.createHash('sha256').update('forma-strava-tokens:' + (process.env.STRAVA_TOKEN_KEY || CLIENT_SECRET || 'x')).digest();
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join('.');
}
function unseal(blob) {
  try {
    const [iv, tag, enc] = String(blob || '').split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
  } catch { return null; }
}

// ---------- подпись параметра state (чтобы чужой человек не мог «подключить» чужой аккаунт) ----------
const STATE_KEY = crypto.createHash('sha256').update('forma-strava-state:' + (BOT_TOKEN || '') + CLIENT_SECRET).digest();
function makeState(userId) {
  const body = `${userId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', STATE_KEY).update(body).digest('hex').slice(0, 32);
  return `${body}.${sig}`;
}
function readState(state) {
  const [uid, ts, sig] = String(state || '').split('.');
  if (!uid || !ts || !sig) return null;
  const good = crypto.createHmac('sha256', STATE_KEY).update(`${uid}.${ts}`).digest('hex').slice(0, 32);
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null; } catch { return null; }
  if (Date.now() - Number(ts) > 30 * 60_000) return null; // ссылка живёт 30 минут
  return Number(uid) || null;
}

// ---------- запросы к Strava ----------
async function stravaFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
  return { ok: res.ok, status: res.status, data, text };
}

async function exchangeToken(params) {
  return stravaFetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
}

async function clearConnection(userId) {
  await query(`UPDATE users SET strava_athlete_id = NULL, strava_access_token = NULL, strava_refresh_token = NULL,
    strava_expires_at = NULL, strava_connected_at = NULL WHERE id = $1`, [userId]);
}

// Свежий access-токен человека (обновляем, если истёк). null — связь потеряна.
async function accessTokenFor(user) {
  const refresh = unseal(user.strava_refresh_token);
  if (!refresh) return null;
  const now = Math.floor(Date.now() / 1000);
  if (user.strava_access_token && Number(user.strava_expires_at) - 120 > now) {
    const t = unseal(user.strava_access_token);
    if (t) return t;
  }
  const r = await exchangeToken({ grant_type: 'refresh_token', refresh_token: refresh });
  if (!r.ok || !r.data?.access_token) {
    if (r.status === 400 || r.status === 401) await clearConnection(user.id); // человек отозвал доступ
    return null;
  }
  await query('UPDATE users SET strava_access_token=$1, strava_refresh_token=$2, strava_expires_at=$3 WHERE id=$4',
    [seal(r.data.access_token), seal(r.data.refresh_token || refresh), r.data.expires_at, user.id]);
  user.strava_access_token = seal(r.data.access_token);
  user.strava_expires_at = r.data.expires_at;
  return r.data.access_token;
}

// ---------- перевод тренировки Strava в запись Forma ----------
const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
const SPORT_RU = {
  Run: 'Бег', TrailRun: 'Трейл', VirtualRun: 'Бег (тренажёр)', Ride: 'Велосипед', MountainBikeRide: 'Горный велосипед',
  GravelRide: 'Гревел', EBikeRide: 'Электровелосипед', VirtualRide: 'Велотренажёр', Swim: 'Плавание', Walk: 'Ходьба',
  Hike: 'Поход', WeightTraining: 'Силовая', Workout: 'Тренировка', Crossfit: 'Кроссфит', Yoga: 'Йога', Pilates: 'Пилатес',
  NordicSki: 'Лыжи', BackcountrySki: 'Лыжи (вне трасс)', AlpineSki: 'Горные лыжи', RollerSki: 'Лыжероллеры',
  Rowing: 'Гребля', Elliptical: 'Эллипс', StairStepper: 'Степпер', HighIntensityIntervalTraining: 'ВИИТ',
  Snowboard: 'Сноуборд', IceSkate: 'Коньки', InlineSkate: 'Ролики', Soccer: 'Футбол', Tennis: 'Теннис', Badminton: 'Бадминтон',
  Kayaking: 'Каякинг', Canoeing: 'Каноэ', StandUpPaddling: 'SUP', Surfing: 'Сёрфинг', Skateboard: 'Скейт', Golf: 'Гольф',
};

const pad = (n) => String(n).padStart(2, '0');
function hms(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
const kmText = (m) => `${(Math.round(m / 10) / 100).toString().replace('.', ',')} км`;

// Начало и конец: Strava отдаёт местное время старта («2026-10-16T07:05:00Z» — это уже местное, без пересчёта)
function times(a) {
  const local = String(a.start_date_local || '');
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const startMs = Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10), +m[2], +m[3]);
  const end = new Date(startMs + Math.max(Number(a.elapsed_time) || 0, 0) * 1000);
  return { date: m[1], start: `${m[2]}:${m[3]}`, end: `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}` };
}

function describe(a) {
  const sport = a.sport_type || a.type || '';
  const label = SPORT_RU[sport] || sport || 'Тренировка';
  const name = String(a.name || '').trim().slice(0, 120);
  const parts = [];
  if (!RUN_TYPES.has(sport)) {
    if (a.distance > 0) parts.push(sport === 'Swim' ? `${Math.round(a.distance)} м` : kmText(a.distance));
    if (a.moving_time > 0) parts.push(hms(a.moving_time));
  }
  const extra = parts.length ? ` (${parts.join(', ')})` : '';
  return `Strava · ${label}${name ? ` — ${name}` : ''}${extra}`.slice(0, 600);
}

// Очередь по человеку: две тренировки одновременно не должны занять один номер за день
const queues = new Map();
function serial(userId, fn) {
  const prev = queues.get(userId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(userId, next);
  next.finally(() => { if (queues.get(userId) === next) queues.delete(userId); });
  return next;
}

async function notifyUser(user, text) {
  if (!NOTIFY || !BOT_TOKEN || !user.telegram_id) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: user.telegram_id, text,
        reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть Forma', web_app: { url: APP_URL } }]] },
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* уведомление не критично */ }
}

/**
 * Кладёт одну тренировку Strava в дневник. Возвращает 'created' | 'linked' | 'updated' | 'skipped'.
 * quiet — не писать человеку в бот (при первом подключении, чтобы не засыпать сообщениями).
 */
export async function importActivity(user, a, { quiet = false } = {}) {
  await stravaReady;
  if (!a?.id || !a.start_date_local) return 'skipped';
  const sport = a.sport_type || a.type || '';
  const isRun = RUN_TYPES.has(sport);
  const t = times(a);
  if (!t) return 'skipped';
  // совсем короткие записи (случайно включённые часы) не нужны
  if (isRun ? !(a.distance >= 100) : !((a.moving_time || a.elapsed_time) >= 120)) return 'skipped';
  // и записи «из будущего» (часы с неверной датой)
  if (t.date > new Date(Date.now() + 36 * 3600_000).toISOString().slice(0, 10)) return 'skipped';

  const km = isRun && a.distance >= 100 ? Math.min(Math.round((a.distance / 1000) * 100) / 100, 200) : null;
  const hrAvg = a.average_heartrate >= 30 && a.average_heartrate <= 250 ? Math.round(a.average_heartrate) : null;
  const hrMax = a.max_heartrate >= 30 && a.max_heartrate <= 250 ? Math.round(a.max_heartrate) : null;

  return serial(user.id, async () => {
    // уже импортировали — обновляем только то, чем «владеет» Strava (пульс, время, объём)
    const same = await query('SELECT id FROM workouts WHERE strava_activity_id = $1', [a.id]);
    if (same.rows.length) {
      await query(`UPDATE workouts SET hr_avg = COALESCE($1, hr_avg), hr_max = COALESCE($2, hr_max),
        start_time = COALESCE($3, start_time), end_time = COALESCE($4, end_time), total_km = COALESCE($5, total_km)
        WHERE id = $6 AND source = 'strava'`, [hrAvg, hrMax, t.start, t.end, km, same.rows[0].id]);
      return 'updated';
    }

    const day = await query(
      `SELECT w.id, w.session, w.type, w.total_km, w.strava_activity_id, w.hr_avg, w.start_time,
         (SELECT COALESCE(SUM(s.distance_m * GREATEST(COALESCE(s.reps, 1), 1)), 0) FROM workout_sets s WHERE s.workout_id = w.id) AS sets_m
       FROM workouts w WHERE w.user_id = $1 AND w.date = $2 ORDER BY w.session`, [user.id, t.date]);

    // человек уже записал эту тренировку вручную — не делаем дубль, а привязываем и дополняем пустое
    if (km) {
      for (const w of day.rows) {
        if (w.type !== 'training' || w.strava_activity_id) continue;
        const have = Number(w.total_km) || Number(w.sets_m) / 1000;
        if (have > 0 && Math.abs(have - km) <= Math.max(0.5, km * 0.15)) {
          // только отмечаем, что эта тренировка уже есть: данные Strava в ручную запись не копируем
          await query(`UPDATE workouts SET strava_activity_id = $1, source = COALESCE(source, 'manual+strava') WHERE id = $2`, [a.id, w.id]);
          return 'linked';
        }
      }
    }

    // номер за день: 1, а если первая тренировка уже есть — 2
    const first = day.rows.find((w) => w.session === 1);
    let session = 1;
    if (first) {
      if (first.type !== 'training' || day.rows.some((w) => w.session === 2)) return 'skipped'; // день отдыха или два слота заняты
      session = 2;
    }

    const ins = await query(
      `INSERT INTO workouts (user_id, date, session, type, notes, visibility, hr_avg, hr_max, total_km, start_time, end_time, source, strava_activity_id)
       VALUES ($1,$2,$3,'training',$4,'private',$5,$6,$7,$8,$9,'strava',$10)
       ON CONFLICT DO NOTHING RETURNING id`,
      [user.id, t.date, session, describe(a), hrAvg, hrMax, km, t.start, t.end, a.id]);
    if (!ins.rows.length) return 'skipped'; // параллельный вебхук уже занял место
    const wid = ins.rows[0].id;

    if (isRun) {
      await query(`INSERT INTO workout_sets (workout_id, order_index, distance_m, reps, time_or_pace) VALUES ($1, 0, $2, 1, $3)`,
        [wid, Math.round(a.distance), hms(a.moving_time || a.elapsed_time)]);
    }

    try { await recalcStreak(user.id); } catch (e) { console.error('Strava: streak failed', e.message); }

    if (!quiet) {
      const label = SPORT_RU[sport] || 'Тренировка';
      const what = isRun ? `${label} ${kmText(a.distance)} за ${hms(a.moving_time || a.elapsed_time)}` : label;
      await notifyUser(user, `🟠 Забрал из Strava: ${what}.\nЗагляни в дневник и дополни запись — самочувствие, заметки, отрезки.`);
    }
    return 'created';
  });
}

// Последние дни из Strava (при подключении и по кнопке «Обновить»)
async function syncRecent(userId, { quiet = false } = {}) {
  await stravaReady;
  const u = await query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = u.rows[0];
  if (!user?.strava_athlete_id) return { ok: false, error: 'not_connected' };
  const token = await accessTokenFor(user);
  if (!token) return { ok: false, error: 'no_token' };
  const after = Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 86400;
  const r = await stravaFetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok || !Array.isArray(r.data)) return { ok: false, error: `strava_${r.status}` };
  const counts = { created: 0, linked: 0, updated: 0, skipped: 0 };
  for (const a of r.data.sort((x, y) => String(x.start_date).localeCompare(String(y.start_date)))) {
    try { counts[await importActivity(user, a, { quiet })]++; } catch (e) { console.error('Strava import failed:', e.message); }
  }
  return { ok: true, ...counts };
}

// ---------- вебхук Strava ----------
// Проверка при подписке: Strava присылает GET с hub.challenge — отвечаем тем же
router.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && VERIFY_TOKEN && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.json({ 'hub.challenge': req.query['hub.challenge'] });
  }
  res.sendStatus(403);
});

// Событие: Strava просит ответить 200 за 2 секунды, разбираем уже после ответа
router.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const ev = req.body || {};
  (async () => {
    await stravaReady;
    const owner = Number(ev.owner_id);
    if (!owner) return;
    const u = await query('SELECT * FROM users WHERE strava_athlete_id = $1', [owner]);
    const user = u.rows[0];
    if (!user) return;

    // человек отключил Forma в самой Strava — стираем токены
    if (ev.object_type === 'athlete' && ev.updates?.authorized === 'false') { await clearConnection(user.id); return; }

    if (ev.object_type !== 'activity' || !['create', 'update'].includes(ev.aspect_type)) return; // удаление игнорируем: дневник остаётся
    const token = await accessTokenFor(user);
    if (!token) return;
    const r = await stravaFetch(`https://www.strava.com/api/v3/activities/${Number(ev.object_id)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok || !r.data) return; // приватная/удалённая или лимит — пропускаем
    await importActivity(user, r.data);
  })().catch((e) => console.error('Strava webhook failed:', e.message));
});

// Подписка на вебхук: один раз на приложение. Делаем при каждом запуске сервера — если она уже есть, ничего не меняется.
export async function ensureStravaWebhook() {
  if (!stravaConfigured()) return;
  try {
    const auth = `client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}`;
    const list = await stravaFetch(`https://www.strava.com/api/v3/push_subscriptions?${auth}`);
    if (list.ok && Array.isArray(list.data) && list.data.length) {
      if (list.data[0].callback_url === WEBHOOK_URL) { console.log('Strava webhook OK'); return; }
      await stravaFetch(`https://www.strava.com/api/v3/push_subscriptions/${list.data[0].id}?${auth}`, { method: 'DELETE' });
    }
    const r = await stravaFetch('https://www.strava.com/api/v3/push_subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `${auth}&callback_url=${encodeURIComponent(WEBHOOK_URL)}&verify_token=${encodeURIComponent(VERIFY_TOKEN)}`,
    });
    console.log(r.ok ? 'Strava webhook subscribed' : `Strava webhook failed: ${r.status} ${r.text.slice(0, 200)}`);
  } catch (e) {
    console.error('Strava webhook setup failed:', e.message);
  }
}

// ---------- подключение ----------
async function me(req) {
  await stravaReady;
  const r = await query('SELECT * FROM users WHERE telegram_id = $1', [req.telegramUser.id]);
  return r.rows[0];
}

router.get('/status', requireTelegramAuth, async (req, res) => {
  const user = await me(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    configured: stravaConfigured(),
    connected: !!user.strava_athlete_id,
    since: user.strava_connected_at || null,
    days: BACKFILL_DAYS,
  });
});

router.post('/connect', requireTelegramAuth, async (req, res) => {
  if (!stravaConfigured()) return res.status(503).json({ error: 'Strava пока не настроена — загляни чуть позже 🙂' });
  const user = await me(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const url = 'https://www.strava.com/oauth/authorize?' + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state: makeState(user.id),
  }).toString();
  res.json({ url });
});

function page(title, text, ok) {
  const color = ok ? '#B4F53C' : '#FF6B6B';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forma · Strava</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0C11;color:#F3F5F8;font-family:-apple-system,Segoe UI,Roboto,Manrope,sans-serif;text-align:center;padding:24px;box-sizing:border-box}
.c{max-width:360px}.i{font-size:56px;color:${color};margin-bottom:12px}h1{font-size:22px;margin:0 0 10px}p{color:#8B93A7;line-height:1.5;margin:0 0 22px}
a{display:inline-block;background:#B4F53C;color:#0A0C11;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:14px}</style></head>
<body><div class="c"><div class="i">${ok ? '✓' : '!'}</div><h1>${title}</h1><p>${text}</p>
<a href="https://t.me/${BOT_USERNAME}">Вернуться в Forma</a></div></body></html>`;
}

router.get('/callback', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  try {
    await stravaReady;
    const { code, state, error, scope } = req.query;
    if (error) return res.send(page('Доступ не дан', 'Ты отказался от доступа — Forma ничего не подключила. Можно попробовать ещё раз в настройках.', false));
    const userId = readState(state);
    if (!userId || !code) return res.status(400).send(page('Ссылка устарела', 'Открой Forma → Настройки → Strava и нажми «Подключить» ещё раз.', false));
    if (scope && !String(scope).includes('activity:read')) {
      return res.send(page('Нужен доступ к тренировкам', 'Strava подключается только вместе с доступом к тренировкам. Попробуй ещё раз и оставь галочку включённой.', false));
    }
    const r = await exchangeToken({ grant_type: 'authorization_code', code: String(code) });
    if (!r.ok || !r.data?.access_token || !r.data?.athlete?.id) {
      console.error('Strava token exchange failed:', r.status, r.text.slice(0, 200));
      return res.status(502).send(page('Не получилось', 'Strava не подтвердила подключение. Попробуй ещё раз чуть позже.', false));
    }
    // один аккаунт Strava — один человек в Forma
    await query('UPDATE users SET strava_athlete_id = NULL, strava_access_token = NULL, strava_refresh_token = NULL, strava_expires_at = NULL, strava_connected_at = NULL WHERE strava_athlete_id = $1 AND id <> $2',
      [r.data.athlete.id, userId]);
    await query(`UPDATE users SET strava_athlete_id = $1, strava_access_token = $2, strava_refresh_token = $3, strava_expires_at = $4, strava_connected_at = now() WHERE id = $5`,
      [r.data.athlete.id, seal(r.data.access_token), seal(r.data.refresh_token), r.data.expires_at, userId]);
    // подтягиваем последние дни, но человеку не пишем по каждой тренировке
    syncRecent(userId, { quiet: true }).then(async (s) => {
      if (s?.ok && s.created) {
        const u = await query('SELECT * FROM users WHERE id = $1', [userId]);
        if (u.rows[0]) await notifyUser(u.rows[0], `🟠 Strava подключена. Забрал тренировок за последние дни: ${s.created}. Загляни в дневник и дополни их.`);
      }
    }).catch((e) => console.error('Strava first sync failed:', e.message));
    res.send(page('Strava подключена', `Теперь новые тренировки из Strava сами попадут в дневник Forma. Вернись в приложение.`, true));
  } catch (e) {
    console.error('Strava callback failed:', e.message);
    res.status(500).send(page('Что-то пошло не так', 'Попробуй подключить Strava ещё раз чуть позже.', false));
  }
});

// Кнопка «Обновить сейчас» — не чаще раза в минуту
const lastSync = new Map();
router.post('/sync', requireTelegramAuth, async (req, res) => {
  const user = await me(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.strava_athlete_id) return res.status(400).json({ error: 'Strava не подключена' });
  if (Date.now() - (lastSync.get(user.id) || 0) < 60_000) return res.status(429).json({ error: 'Подожди минуту и попробуй снова 🙂' });
  lastSync.set(user.id, Date.now());
  const s = await syncRecent(user.id, { quiet: true });
  if (!s.ok) return res.status(502).json({ error: s.error === 'no_token' ? 'Доступ к Strava потерян — подключи её заново.' : 'Strava сейчас не отвечает, попробуй позже.' });
  res.json(s);
});

router.post('/disconnect', requireTelegramAuth, async (req, res) => {
  const user = await me(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const access = user.strava_athlete_id ? await accessTokenFor(user).catch(() => null) : null;
  if (access) {
    try { await stravaFetch('https://www.strava.com/oauth/deauthorize', { method: 'POST', headers: { Authorization: `Bearer ${access}` } }); } catch { /* всё равно отключаем у себя */ }
  }
  await clearConnection(user.id); // тренировки, которые уже в дневнике, остаются
  res.json({ ok: true });
});

export default router;
