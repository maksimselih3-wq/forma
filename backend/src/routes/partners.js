import { Router } from 'express';
import { query, dbReady } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';

/**
 * Совместные пробежки: поиск напарников в своём городе.
 *
 *  - Человек создаёт приглашение: город, дата и время, место, что бежим («10 км по 4:30»).
 *  - Все бегуны этого города видят его в разделе «Пробежки», жмут «Иду».
 *  - У каждой пробежки свой чат, чтобы договориться (писать может любой, кто её открыл).
 *  - Автор может отменить пробежку; на неприличное можно пожаловаться — жалоба придёт админу в бота.
 *  - Бот сообщает автору, что кто-то идёт, и участникам — о новых сообщениях (не чаще раза в 10 минут
 *    на одну пробежку) и об отмене. Всё это выключается в «Настройках».
 */

const router = Router();
const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL || 'https://maksimselih3-wq.github.io/forma-2/';

const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
for (const m of ['get', 'post', 'delete', 'put']) {
  const orig = router[m].bind(router);
  router[m] = (path, ...fns) => orig(path, ...fns.map(safe));
}

// ---------- Таблицы ----------
export const partnersReady = (async () => {
  await dbReady;
  try {
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT');
    await query(`CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      author_id INT REFERENCES users(id) ON DELETE CASCADE,
      city TEXT NOT NULL,
      date DATE NOT NULL,
      time TEXT NOT NULL,
      place TEXT NOT NULL,
      description TEXT,
      max_people INT,
      created_at TIMESTAMP DEFAULT now()
    )`);
    await query('CREATE INDEX IF NOT EXISTS idx_runs_city_date ON runs(lower(city), date)');
    await query(`CREATE TABLE IF NOT EXISTS run_members (
      run_id INT REFERENCES runs(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (run_id, user_id)
    )`);
    await query(`CREATE TABLE IF NOT EXISTS run_messages (
      id SERIAL PRIMARY KEY,
      run_id INT REFERENCES runs(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    )`);
    await query('CREATE INDEX IF NOT EXISTS idx_run_messages_run ON run_messages(run_id, id)');
    await query(`DO $$
      DECLARE t text;
      BEGIN
        FOREACH t IN ARRAY ARRAY['runs', 'run_members', 'run_messages'] LOOP
          IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = t AND tableowner = current_user) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
          END IF;
        END LOOP;
      END $$`);
  } catch (err) {
    console.error('Partners tables failed:', err.message);
  }
})();

// ---------- Помощники ----------
const PUBLIC_USER = `u.id, u.username, u.first_name, u.last_name, u.current_streak, u.sport, u.discipline,
  CASE WHEN u.avatar_data IS NOT NULL THEN left(md5(u.avatar_data), 8)
       WHEN u.photo_url IS NOT NULL THEN 'tg' END AS avatar_v`;

function mskToday() {
  return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
}
function addDays(str, n) {
  const d = new Date(str + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function text(v, max) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}
// «москва», «  Москва » → «Москва»
function cleanCity(v) {
  const t = text(v, 40);
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function fullName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : 'Бегун');
}
function whenLabel(date, time) {
  const d = String(date).slice(0, 10);
  const today = mskToday();
  const [, m, day] = d.split('-').map(Number);
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const dayWord = d === today ? 'сегодня' : d === addDays(today, 1) ? 'завтра' : `${day} ${months[m - 1]}`;
  return `${dayWord} в ${time}`;
}

async function loadMe(req, res, next) {
  const r = await query('SELECT * FROM users WHERE telegram_id = $1', [req.telegramUser.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
  req.me = r.rows[0];
  await partnersReady;
  next();
}
router.use(requireTelegramAuth, safe(loadMe));

// Сообщение от бота (кнопка ведёт прямо на пробежку). Молча, если выключено в настройках.
async function botSend(userIds, textMsg, runId) {
  if (!BOT_TOKEN || !userIds.length) return;
  const r = await query(
    'SELECT telegram_id FROM users WHERE id = ANY($1::int[]) AND COALESCE(partners_notify, TRUE)', [userIds]
  ).catch(() => query('SELECT telegram_id FROM users WHERE id = ANY($1::int[])', [userIds]));
  const url = `${APP_URL}${APP_URL.includes('?') ? '&' : '?'}run=${runId}`;
  for (const u of r.rows) {
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: u.telegram_id, text: textMsg,
        reply_markup: { inline_keyboard: [[{ text: '🏃 Открыть пробежку', web_app: { url } }]] },
      }),
    }).catch((err) => console.error('Run notify failed:', err.message));
  }
}
// чтобы чат не превращался в спам уведомлений: одно уведомление на пробежку раз в 10 минут
const lastChatPing = new Map();

async function getRun(id) {
  const r = await query(
    `SELECT r.*, to_char(r.date, 'YYYY-MM-DD') AS date,
       (SELECT count(*)::int FROM run_members m WHERE m.run_id = r.id) AS going
     FROM runs r WHERE r.id = $1`, [id]);
  return r.rows[0] || null;
}

// ===================================================================
//  GET /api/partners?city=Москва — ближайшие пробежки в городе (и мой город)
// ===================================================================
router.get('/', async (req, res) => {
  const city = cleanCity(req.query.city) || req.me.city || null;
  const today = mskToday();
  const [runs, cities] = await Promise.all([
    city
      ? query(
        `SELECT r.id, r.city, to_char(r.date, 'YYYY-MM-DD') AS date, r.time, r.place, r.description, r.max_people,
           r.author_id,
           (SELECT count(*)::int FROM run_members m WHERE m.run_id = r.id) AS going,
           EXISTS (SELECT 1 FROM run_members m WHERE m.run_id = r.id AND m.user_id = $3) AS joined,
           (SELECT count(*)::int FROM run_messages x WHERE x.run_id = r.id) AS messages,
           (SELECT json_agg(t) FROM (SELECT ${PUBLIC_USER} FROM run_members m JOIN users u ON u.id = m.user_id
              WHERE m.run_id = r.id ORDER BY m.joined_at LIMIT 5) t) AS people
         FROM runs r
         WHERE lower(r.city) = lower($1) AND r.date >= $2::date
         ORDER BY r.date, r.time
         LIMIT 50`, [city, today, req.me.id])
      : { rows: [] },
    // города, где сейчас есть пробежки, — подсказки для выбора
    query(
      `SELECT min(city) AS city, count(*)::int AS n FROM runs WHERE date >= $1::date
       GROUP BY lower(city) ORDER BY n DESC LIMIT 12`, [today]),
  ]);
  const authorIds = [...new Set(runs.rows.map((r) => r.author_id))];
  const authors = authorIds.length
    ? await query(`SELECT ${PUBLIC_USER} FROM users u WHERE u.id = ANY($1::int[])`, [authorIds])
    : { rows: [] };
  const byId = Object.fromEntries(authors.rows.map((u) => [u.id, u]));
  res.json({
    city,
    my_city: req.me.city || null,
    cities: cities.rows,
    runs: runs.rows.map((r) => ({ ...r, people: r.people || [], author: byId[r.author_id] || null, mine: r.author_id === req.me.id })),
  });
});

// PUT /api/partners/city { city } — мой город
router.put('/city', async (req, res) => {
  const city = cleanCity(req.body.city);
  if (!city) return res.status(400).json({ error: 'Напиши свой город' });
  await query('UPDATE users SET city = $1 WHERE id = $2', [city, req.me.id]);
  res.json({ ok: true, city });
});

// POST /api/partners { city, date, time, place, description, max_people } — позвать на пробежку
router.post('/', async (req, res) => {
  const b = req.body || {};
  const city = cleanCity(b.city) || req.me.city;
  const date = String(b.date || '');
  const time = String(b.time || '');
  const place = text(b.place, 80);
  const description = text(b.description, 200);
  const maxPeople = parseInt(b.max_people, 10);
  const today = mskToday();
  if (!city) return res.status(400).json({ error: 'Укажи город' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > addDays(today, 30)) {
    return res.status(400).json({ error: 'Выбери дату: от сегодня до месяца вперёд' });
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: 'Укажи время, например 07:30' });
  if (!place) return res.status(400).json({ error: 'Напиши, где встречаемся' });
  const active = await query('SELECT count(*)::int AS n FROM runs WHERE author_id = $1 AND date >= $2::date', [req.me.id, today]);
  if (active.rows[0].n >= 5) return res.status(400).json({ error: 'У тебя уже 5 запланированных пробежек — это максимум' });

  const r = await query(
    `INSERT INTO runs (author_id, city, date, time, place, description, max_people)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7) RETURNING id`,
    [req.me.id, city, date, time, place, description, maxPeople >= 2 && maxPeople <= 100 ? maxPeople : null]);
  const id = r.rows[0].id;
  await query('INSERT INTO run_members (run_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, req.me.id]);
  if (!req.me.city) await query('UPDATE users SET city = $1 WHERE id = $2', [city, req.me.id]);
  res.json({ ok: true, id });
});

// GET /api/partners/:id — пробежка целиком: участники и чат
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const run = id && (await getRun(id));
  if (!run) return res.status(404).json({ error: 'Пробежка не найдена или отменена' });
  const [author, members, messages] = await Promise.all([
    query(`SELECT ${PUBLIC_USER} FROM users u WHERE u.id = $1`, [run.author_id]),
    query(`SELECT ${PUBLIC_USER} FROM run_members m JOIN users u ON u.id = m.user_id WHERE m.run_id = $1 ORDER BY m.joined_at`, [id]),
    query(
      `SELECT x.id, x.text, x.created_at, x.user_id FROM run_messages x WHERE x.run_id = $1 ORDER BY x.id DESC LIMIT 100`, [id]),
  ]);
  const writerIds = [...new Set(messages.rows.map((m) => m.user_id))];
  const writers = writerIds.length ? await query(`SELECT ${PUBLIC_USER} FROM users u WHERE u.id = ANY($1::int[])`, [writerIds]) : { rows: [] };
  const wById = Object.fromEntries(writers.rows.map((u) => [u.id, u]));
  res.json({
    run: {
      ...run,
      author: author.rows[0] || null,
      mine: run.author_id === req.me.id,
      joined: members.rows.some((m) => m.id === req.me.id),
    },
    members: members.rows,
    messages: messages.rows.reverse().map((m) => ({ ...m, author: wById[m.user_id] || null, mine: m.user_id === req.me.id })),
  });
});

// POST /api/partners/:id/join — «Иду»
router.post('/:id/join', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const run = id && (await getRun(id));
  if (!run) return res.status(404).json({ error: 'Пробежка не найдена или отменена' });
  if (run.max_people && run.going >= run.max_people) return res.status(400).json({ error: 'Все места уже заняты' });
  const ins = await query(
    'INSERT INTO run_members (run_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING user_id', [id, req.me.id]);
  if (ins.rows.length && run.author_id !== req.me.id) {
    botSend([run.author_id], `🏃 ${fullName(req.me)} идёт на твою пробежку ${whenLabel(run.date, run.time)} — ${run.place}`, id);
  }
  res.json({ ok: true });
});

// POST /api/partners/:id/leave — «Не пойду»
router.post('/:id/leave', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const run = id && (await getRun(id));
  if (!run) return res.status(404).json({ error: 'Пробежка не найдена' });
  if (run.author_id === req.me.id) return res.status(400).json({ error: 'Ты автор — пробежку можно только отменить' });
  await query('DELETE FROM run_members WHERE run_id = $1 AND user_id = $2', [id, req.me.id]);
  res.json({ ok: true });
});

// POST /api/partners/:id/messages { text } — написать в чат пробежки
const lastMsgAt = new Map();
router.post('/:id/messages', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const msg = String(req.body.text ?? '').trim().slice(0, 500);
  if (!msg) return res.status(400).json({ error: 'Пустое сообщение' });
  const now = Date.now();
  if (now - (lastMsgAt.get(req.me.id) || 0) < 1500) return res.status(429).json({ error: 'Слишком быстро — подожди секунду' });
  lastMsgAt.set(req.me.id, now);
  const run = id && (await getRun(id));
  if (!run) return res.status(404).json({ error: 'Пробежка не найдена или отменена' });
  const r = await query(
    'INSERT INTO run_messages (run_id, user_id, text) VALUES ($1, $2, $3) RETURNING id, text, created_at, user_id', [id, req.me.id, msg]);

  // участникам (кроме автора сообщения) — не чаще раза в 10 минут на пробежку
  if (now - (lastChatPing.get(id) || 0) > 10 * 60 * 1000) {
    lastChatPing.set(id, now);
    const members = await query('SELECT user_id FROM run_members WHERE run_id = $1 AND user_id <> $2', [id, req.me.id]);
    const short = msg.length > 80 ? msg.slice(0, 80) + '…' : msg;
    botSend(members.rows.map((m) => m.user_id), `💬 ${fullName(req.me)} в чате пробежки ${whenLabel(run.date, run.time)}: «${short}»`, id);
  }
  res.json({ message: { ...r.rows[0], mine: true, author: null } });
});

// DELETE /api/partners/:id — автор отменяет пробежку
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const run = id && (await getRun(id));
  if (!run || run.author_id !== req.me.id) return res.status(404).json({ error: 'Пробежка не найдена' });
  const members = await query('SELECT user_id FROM run_members WHERE run_id = $1 AND user_id <> $2', [id, req.me.id]);
  await query('DELETE FROM runs WHERE id = $1 AND author_id = $2', [id, req.me.id]);
  botSend(members.rows.map((m) => m.user_id), `❌ Пробежка ${whenLabel(run.date, run.time)} (${run.place}) отменена автором.`, id);
  res.json({ ok: true });
});

// POST /api/partners/:id/report { reason } — пожаловаться (придёт админу в бота)
const lastReport = new Map();
router.post('/:id/report', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const run = id && (await getRun(id));
  if (!run) return res.status(404).json({ error: 'Пробежка не найдена' });
  const key = `${req.me.id}:${id}`;
  if (lastReport.has(key)) return res.json({ ok: true });
  lastReport.set(key, Date.now());
  const reason = text(req.body.reason, 300) || 'без пояснения';
  let admin = process.env.ADMIN_TELEGRAM_ID;
  if (!admin) {
    const a = await query(`SELECT telegram_id FROM users WHERE LOWER(username) = 'maksimshelikh'`);
    admin = a.rows[0]?.telegram_id;
  }
  const author = await query('SELECT first_name, last_name, username FROM users WHERE id = $1', [run.author_id]);
  if (BOT_TOKEN && admin) {
    const au = author.rows[0] || {};
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: admin,
        text: `⚠️ Жалоба на пробежку #${id}\nОт: ${fullName(req.me)}${req.me.username ? ' @' + req.me.username : ''}\n` +
          `Автор: ${fullName(au)}${au.username ? ' @' + au.username : ''}\n${run.city}, ${whenLabel(run.date, run.time)}, ${run.place}\n` +
          `Описание: ${run.description || '—'}\nПричина: ${reason}\n\nУдалить: /delrun ${id}`,
      }),
    }).catch(() => {});
  }
  res.json({ ok: true });
});

// Админ удаляет пробежку командой /delrun N в боте
export async function adminDeleteRun(id) {
  await partnersReady;
  const r = await query('DELETE FROM runs WHERE id = $1 RETURNING id', [id]);
  return r.rows.length > 0;
}

export default router;
