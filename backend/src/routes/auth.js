import { Router } from 'express';
import { query, dbReady, pool } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { recalcStreak, getClientToday } from '../streak.js';
import { remindersReady, setReminderEnabled, setNotifyPrefs } from '../reminders.js';
import { rememberReferral, settleReferral, socialReady, pioneerNo } from '../social.js';

const router = Router();

// POST /api/auth/login — вызывается один раз при открытии Mini App
router.post('/login', requireTelegramAuth, async (req, res) => {
  const tgUser = req.telegramUser;
  await remindersReady; // чтобы в ответе уже была настройка напоминаний

  const existing = await query('SELECT * FROM users WHERE telegram_id = $1', [tgUser.id]);

  let user = existing.rows[0];
  if (!user) {
    const inserted = await query(
      `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tgUser.id, tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, tgUser.photo_url || null]
    );
    user = inserted.rows[0];
  } else {
    // Имя, username и фото в Telegram могут поменяться — обновляем, чтобы друзья находили и видели актуальное
    const updated = await query(
      `UPDATE users SET username = $2, first_name = $3, last_name = $4, photo_url = COALESCE($5, photo_url)
       WHERE id = $1 RETURNING *`,
      [user.id, tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, tgUser.photo_url || null]
    );
    user = updated.rows[0] || user;
  }

  // Пришёл по ссылке-приглашению? Сразу дружим с пригласившим и радуем его сообщением.
  try {
    const sp = String(req.body?.start_param || '');
    if (/^r_/.test(sp)) await rememberReferral(tgUser.id, sp).catch(() => {});
    if (!existing.rows[0] || /^r_/.test(sp)) {
      const inviter = await settleReferral(user);
      if (inviter && process.env.BOT_TOKEN) {
        const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Твой друг';
        fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: inviter.telegram_id, text: `🎉 ${name} пришёл в Forma по твоему приглашению — вы теперь друзья! Когда он запишет 3 тренировки, тебе +1 билет в недельный розыгрыш 🎟` }),
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Referral failed:', err.message);
  }

  // При каждом открытии пересчитываем серию: если человек пропустил день,
  // он сразу увидит честную цифру, а не старую.
  try {
    const streak = await recalcStreak(user.id, getClientToday(req));
    user = { ...user, current_streak: streak.current, longest_streak: streak.longest };
  } catch (err) {
    console.error('Streak recalc on login failed:', err.message);
  }
  try { user = { ...user, pioneer_no: await pioneerNo(user.id) }; } catch (e) { /* не страшно */ }
  // настройки уведомлений для экрана «Настройки»
  user = { ...user, digest_on_pref: user.digest_enabled ?? user.remind_enabled ?? true, partners_notify: user.partners_notify !== false };

  res.json({ user });
});

// POST /api/auth/avatar { image } — своё фото профиля.
// Фото сжимается прямо на телефоне до маленькой картинки JPEG и хранится в базе.
// { image: null } — удалить своё фото и вернуться к фото из Telegram.
router.post('/avatar', requireTelegramAuth, async (req, res) => {
  const image = req.body.image;

  if (image !== null) {
    const ok = typeof image === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(image);
    if (!ok) return res.status(400).json({ error: 'Нужна картинка' });
    if (image.length > 95000) return res.status(400).json({ error: 'Фото слишком большое' });
  }

  const result = await query(
    'UPDATE users SET avatar_data = $1 WHERE telegram_id = $2 RETURNING avatar_data',
    [image, req.telegramUser.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

  res.json({ ok: true, avatar_data: result.rows[0].avatar_data });
});

// POST /api/auth/reminder { enabled } — вечернее напоминание от бота вкл/выкл
router.post('/reminder', requireTelegramAuth, async (req, res) => {
  try {
    const row = await setReminderEnabled(req.telegramUser.id, req.body?.enabled !== false);
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, remind_enabled: row.remind_enabled });
  } catch (err) {
    console.error('Reminder toggle failed:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить настройку' });
  }
});

// POST /api/auth/notify { digest?, partners? } — итоги недели и сообщения о совместных пробежках
router.post('/notify', requireTelegramAuth, async (req, res) => {
  try {
    const row = await setNotifyPrefs(req.telegramUser.id, { digest: req.body?.digest, partners: req.body?.partners });
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, ...row });
  } catch (err) {
    console.error('Notify prefs failed:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить настройку' });
  }
});

// Какие виды спорта можно выбрать (названия и значки — на стороне приложения)
const SPORTS = ['athletics', 'running', 'football', 'basketball', 'volleyball', 'hockey', 'swimming',
  'cycling', 'triathlon', 'combat', 'tennis', 'fitness', 'other'];

// POST /api/auth/sport { sport, discipline } — вид спорта и дисциплина в профиле ({ sport: null } — убрать)
router.post('/sport', requireTelegramAuth, async (req, res) => {
  const sport = req.body.sport === null ? null : String(req.body.sport || '');
  if (sport !== null && !SPORTS.includes(sport)) return res.status(400).json({ error: 'Такого вида спорта нет' });
  const discipline = sport ? (req.body.discipline || '').toString().trim().slice(0, 40) || null : null;

  const result = await query(
    'UPDATE users SET sport = $1, discipline = $2 WHERE telegram_id = $3 RETURNING sport, discipline',
    [sport, discipline, req.telegramUser.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, ...result.rows[0] });
});

// ===================================================================
//  АНКЕТА СПОРТСМЕНА (личное — видит только сам человек и Fom, друзьям не показывается)
// ===================================================================
const LEVELS = ['beginner', 'amateur', 'ranked', 'kms', 'ms'];

const athleteReady = (async () => {
  await dbReady;
  try {
    await query(`CREATE TABLE IF NOT EXISTS athlete_profiles (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      sex TEXT,
      birth_year INT,
      height_cm INT,
      weight_kg NUMERIC(5,1),
      rest_hr INT,
      experience_years INT,
      level TEXT,
      records TEXT,
      goal TEXT,
      injuries TEXT,
      updated_at TIMESTAMP DEFAULT now()
    )`);
    await query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'athlete_profiles' AND tableowner = current_user) THEN
        ALTER TABLE athlete_profiles ENABLE ROW LEVEL SECURITY;
      END IF; END $$`);
  } catch (err) {
    console.error('Athlete profile table failed:', err.message);
  }
})();

// Проверка полей анкеты: пустое — можно, заполненное — только в разумных пределах.
// Если что-то не так, возвращаем понятное сообщение, а не тихо стираем значение.
function numIn(v, min, max, label, decimals = 0) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}: от ${min} до ${max}`);
  const k = 10 ** decimals;
  return Math.round(n * k) / k;
}
function textIn(v, max = 300) {
  const s = (v ?? '').toString().trim();
  return s ? s.slice(0, max) : null;
}

// GET /api/auth/athlete — своя анкета
router.get('/athlete', requireTelegramAuth, async (req, res) => {
  try {
    await athleteReady;
    const r = await query(
      `SELECT p.* FROM athlete_profiles p JOIN users u ON u.id = p.user_id WHERE u.telegram_id = $1`,
      [req.telegramUser.id]
    );
    const { user_id, updated_at, ...profile } = r.rows[0] || {};
    res.json({ profile });
  } catch (err) {
    console.error('Athlete get failed:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить анкету' });
  }
});

// POST /api/auth/athlete — сохранить анкету
router.post('/athlete', requireTelegramAuth, async (req, res) => {
  const b = req.body || {};
  const year = new Date().getFullYear();
  let profile;
  try {
    profile = {
      sex: ['m', 'f'].includes(b.sex) ? b.sex : null,
      birth_year: numIn(b.birth_year, 1930, year - 5, 'Год рождения'),
      height_cm: numIn(b.height_cm, 100, 250, 'Рост, см'),
      weight_kg: numIn(b.weight_kg, 25, 250, 'Вес, кг', 1),
      rest_hr: numIn(b.rest_hr, 25, 120, 'Пульс покоя'),
      experience_years: numIn(b.experience_years, 0, 80, 'Стаж, лет'),
      level: LEVELS.includes(b.level) ? b.level : null,
      records: textIn(b.records),
      goal: textIn(b.goal),
      injuries: textIn(b.injuries),
    };
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    await athleteReady;
    const u = await query('SELECT id FROM users WHERE telegram_id = $1', [req.telegramUser.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });
    await query(
      `INSERT INTO athlete_profiles (user_id, sex, birth_year, height_cm, weight_kg, rest_hr, experience_years, level, records, goal, injuries, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (user_id) DO UPDATE SET
         sex = EXCLUDED.sex, birth_year = EXCLUDED.birth_year, height_cm = EXCLUDED.height_cm,
         weight_kg = EXCLUDED.weight_kg, rest_hr = EXCLUDED.rest_hr, experience_years = EXCLUDED.experience_years,
         level = EXCLUDED.level, records = EXCLUDED.records, goal = EXCLUDED.goal, injuries = EXCLUDED.injuries,
         updated_at = now()`,
      [u.rows[0].id, profile.sex, profile.birth_year, profile.height_cm, profile.weight_kg, profile.rest_hr,
        profile.experience_years, profile.level, profile.records, profile.goal, profile.injuries]
    );
    res.json({ ok: true, profile });
  } catch (err) {
    console.error('Athlete save failed:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить анкету' });
  }
});


// ===================================================================
//  КАЛЕНДАРЬ СТАРТОВ и УТРЕННЯЯ ОТМЕТКА (видит только сам человек и Fom)
// ===================================================================
const extrasReady = (async () => {
  await dbReady;
  try {
    await query(`CREATE TABLE IF NOT EXISTS planned_starts (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      name TEXT NOT NULL,
      discipline TEXT,
      goal TEXT,
      created_at TIMESTAMP DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_planned_starts_user ON planned_starts(user_id, date)`);
    await query(`CREATE TABLE IF NOT EXISTS morning_checks (
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      sleep_h NUMERIC(3,1),
      rest_hr INT,
      mood INT,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (user_id, date)
    )`);
    await query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'planned_starts' AND tableowner = current_user) THEN
        ALTER TABLE planned_starts ENABLE ROW LEVEL SECURITY;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'morning_checks' AND tableowner = current_user) THEN
        ALTER TABLE morning_checks ENABLE ROW LEVEL SECURITY;
      END IF; END $$`);
  } catch (err) {
    console.error('Extras tables failed:', err.message);
  }
})();

async function internalId(telegramId) {
  const u = await query('SELECT id FROM users WHERE telegram_id = $1', [telegramId]);
  return u.rows[0]?.id || null;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/auth/starts — будущие старты (и прошедшие за последнюю неделю)
router.get('/starts', requireTelegramAuth, async (req, res) => {
  try {
    await extrasReady;
    const uid = await internalId(req.telegramUser.id);
    if (!uid) return res.status(404).json({ error: 'User not found' });
    const r = await query(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, name, discipline, goal FROM planned_starts
       WHERE user_id = $1 AND date >= CURRENT_DATE - 7 ORDER BY date LIMIT 30`, [uid]);
    res.json({ starts: r.rows });
  } catch (err) {
    console.error('Starts get failed:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить старты' });
  }
});

// POST /api/auth/starts { date, name, discipline, goal } — добавить старт в планы
router.post('/starts', requireTelegramAuth, async (req, res) => {
  const b = req.body || {};
  const date = String(b.date || '');
  const name = textIn(b.name, 80);
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) return res.status(400).json({ error: 'Укажи дату старта' });
  if (!name) return res.status(400).json({ error: 'Напиши, что за старт' });
  try {
    await extrasReady;
    const uid = await internalId(req.telegramUser.id);
    if (!uid) return res.status(404).json({ error: 'User not found' });
    const cnt = await query('SELECT count(*)::int AS n FROM planned_starts WHERE user_id = $1 AND date >= CURRENT_DATE', [uid]);
    if (cnt.rows[0].n >= 30) return res.status(400).json({ error: 'Слишком много стартов в планах' });
    const r = await query(
      `INSERT INTO planned_starts (user_id, date, name, discipline, goal) VALUES ($1, $2::date, $3, $4, $5)
       RETURNING id, to_char(date, 'YYYY-MM-DD') AS date, name, discipline, goal`,
      [uid, date, name, textIn(b.discipline, 40), textIn(b.goal, 40)]);
    res.json({ start: r.rows[0] });
  } catch (err) {
    console.error('Start save failed:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить старт' });
  }
});

// DELETE /api/auth/starts/:id
router.delete('/starts/:id', requireTelegramAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(id > 0)) return res.status(400).json({ error: 'Неверный старт' });
  try {
    await extrasReady;
    const uid = await internalId(req.telegramUser.id);
    await query('DELETE FROM planned_starts WHERE id = $1 AND user_id = $2', [id, uid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Start delete failed:', err.message);
    res.status(500).json({ error: 'Не удалось удалить старт' });
  }
});

// ---------- Личные рекорды вручную (без записи старта) ----------
// GET /api/auth/records
router.get('/records', requireTelegramAuth, async (req, res) => {
  try {
    await socialReady;
    const uid = await internalId(req.telegramUser.id);
    if (!uid) return res.status(404).json({ error: 'User not found' });
    const r = await query(
      `SELECT id, discipline, result, note, to_char(date, 'YYYY-MM-DD') AS date FROM manual_records
       WHERE user_id = $1 ORDER BY created_at`, [uid]);
    res.json({ records: r.rows });
  } catch (err) {
    console.error('Records get failed:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить рекорды' });
  }
});

// POST /api/auth/records { discipline, result, date?, note? }
router.post('/records', requireTelegramAuth, async (req, res) => {
  const b = req.body || {};
  const discipline = textIn(b.discipline, 40);
  const result = textIn(b.result, 20);
  const date = DATE_RE.test(String(b.date || '')) && !Number.isNaN(Date.parse(b.date)) ? b.date : null;
  if (!discipline) return res.status(400).json({ error: 'Укажи дисциплину' });
  if (!result || !/\d/.test(result)) return res.status(400).json({ error: 'Укажи результат, например 4:05,1 или 6,45 м' });
  if (date && date > new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'Дата рекорда не может быть в будущем' });
  }
  try {
    await socialReady;
    const uid = await internalId(req.telegramUser.id);
    if (!uid) return res.status(404).json({ error: 'User not found' });
    const cnt = await query('SELECT count(*)::int AS n FROM manual_records WHERE user_id = $1', [uid]);
    if (cnt.rows[0].n >= 50) return res.status(400).json({ error: 'Слишком много рекордов' });
    const r = await query(
      `INSERT INTO manual_records (user_id, discipline, result, date, note) VALUES ($1, $2, $3, $4::date, $5)
       RETURNING id, discipline, result, note, to_char(date, 'YYYY-MM-DD') AS date`,
      [uid, discipline, result, date, textIn(b.note, 60)]);
    res.json({ record: r.rows[0] });
  } catch (err) {
    console.error('Record save failed:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить рекорд' });
  }
});

// DELETE /api/auth/records/:id
router.delete('/records/:id', requireTelegramAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(id > 0)) return res.status(400).json({ error: 'Неверный рекорд' });
  try {
    await socialReady;
    const uid = await internalId(req.telegramUser.id);
    await query('DELETE FROM manual_records WHERE id = $1 AND user_id = $2', [id, uid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Record delete failed:', err.message);
    res.status(500).json({ error: 'Не удалось удалить рекорд' });
  }
});

// ---------- Цели на месяц ----------
const GOAL_KINDS = ['volume', 'count', 'pb', 'weight', 'custom'];
function mskMonth() { return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 7); }
function numSoft(v, min, max) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 10) / 10 : null;
}
async function currentWeight(uid) {
  const w = await query(`SELECT kg FROM weight_log WHERE user_id = $1 ORDER BY date DESC LIMIT 1`, [uid]);
  if (w.rows[0]) return Number(w.rows[0].kg);
  const p = await query('SELECT weight_kg FROM athlete_profiles WHERE user_id = $1', [uid]).catch(() => ({ rows: [] }));
  return p.rows[0]?.weight_kg != null ? Number(p.rows[0].weight_kg) : null;
}

// GET /api/auth/goals — цели текущего месяца + вес за 90 дней
router.get('/goals', requireTelegramAuth, async (req, res) => {
  try {
    await socialReady;
    const uid = await internalId(req.telegramUser.id);
    if (!uid) return res.status(404).json({ error: 'User not found' });
    const [g, w] = await Promise.all([
      query(`SELECT id, month, kind, title, discipline, target, target_num, start_num, done FROM goals
             WHERE user_id = $1 AND month = $2 ORDER BY id`, [uid, mskMonth()]),
      query(`SELECT to_char(date, 'YYYY-MM-DD') AS date, kg FROM weight_log WHERE user_id = $1 AND date > CURRENT_DATE - 90 ORDER BY date`, [uid]),
    ]);
    const num = (x) => (x == null ? null : Number(x));
    res.json({
      month: mskMonth(),
      goals: g.rows.map((x) => ({ ...x, target_num: num(x.target_num), start_num: num(x.start_num) })),
      weights: w.rows.map((x) => ({ date: x.date, kg: Number(x.kg) })),
      weight: await currentWeight(uid),
    });
  } catch (err) {
    console.error('Goals get failed:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить цели' });
  }
});

// POST /api/auth/goals { kind, title?, discipline?, target?, target_num? }
router.post('/goals', requireTelegramAuth, async (req, res) => {
  const b = req.body || {};
  const kind = GOAL_KINDS.includes(b.kind) ? b.kind : null;
  if (!kind) return res.status(400).json({ error: 'Выбери, какая цель' });
  try {
    await socialReady;
    const uid = await internalId(req.telegramUser.id);
    if (!uid) return res.status(404).json({ error: 'User not found' });
    const cnt = await query('SELECT count(*)::int AS n FROM goals WHERE user_id = $1 AND month = $2', [uid, mskMonth()]);
    if (cnt.rows[0].n >= 6) return res.status(400).json({ error: 'На месяц — до 6 целей' });
    let title = textIn(b.title, 80), discipline = null, target = null, targetNum = null, startNum = null;
    if (kind === 'volume') { targetNum = numSoft(b.target_num, 1, 2000); if (!targetNum) return res.status(400).json({ error: 'Сколько км за месяц?' }); }
    if (kind === 'count') { targetNum = numSoft(b.target_num, 1, 90); if (!targetNum) return res.status(400).json({ error: 'Сколько тренировок за месяц?' }); }
    if (kind === 'pb') {
      discipline = textIn(b.discipline, 40); target = textIn(b.target, 20);
      if (!discipline || !target || !/\d/.test(target)) return res.status(400).json({ error: 'Укажи дисциплину и целевой результат' });
    }
    if (kind === 'weight') {
      targetNum = numSoft(b.target_num, 30, 250);
      if (!targetNum) return res.status(400).json({ error: 'Укажи целевой вес, кг' });
      const now = numSoft(b.current_num, 30, 250);
      if (now) {
        await query(`INSERT INTO weight_log (user_id, date, kg) VALUES ($1, CURRENT_DATE, $2)
                     ON CONFLICT (user_id, date) DO UPDATE SET kg = EXCLUDED.kg`, [uid, now]);
      }
      startNum = now || (await currentWeight(uid));
    }
    if (kind === 'custom' && !title) return res.status(400).json({ error: 'Напиши цель' });
    const r = await query(
      `INSERT INTO goals (user_id, month, kind, title, discipline, target, target_num, start_num)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, month, kind, title, discipline, target, target_num, start_num, done`,
      [uid, mskMonth(), kind, title, discipline, target, targetNum, startNum]);
    const g = r.rows[0];
    res.json({ goal: { ...g, target_num: g.target_num == null ? null : Number(g.target_num), start_num: g.start_num == null ? null : Number(g.start_num) } });
  } catch (err) {
    console.error('Goal save failed:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить цель' });
  }
});

// POST /api/auth/goals/:id/done { done } — отметить свою цель выполненной
router.post('/goals/:id/done', requireTelegramAuth, async (req, res) => {
  try {
    await socialReady;
    const uid = await internalId(req.telegramUser.id);
    await query('UPDATE goals SET done = $1 WHERE id = $2 AND user_id = $3', [req.body?.done !== false, parseInt(req.params.id, 10) || 0, uid]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось сохранить' });
  }
});

// DELETE /api/auth/goals/:id
router.delete('/goals/:id', requireTelegramAuth, async (req, res) => {
  try {
    await socialReady;
    const uid = await internalId(req.telegramUser.id);
    await query('DELETE FROM goals WHERE id = $1 AND user_id = $2', [parseInt(req.params.id, 10) || 0, uid]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось удалить цель' });
  }
});

// POST /api/auth/weight { kg } — записать вес на сегодня (для цели по весу)
router.post('/weight', requireTelegramAuth, async (req, res) => {
  const kg = numSoft(req.body?.kg, 30, 250);
  if (!kg) return res.status(400).json({ error: 'Укажи вес в кг' });
  try {
    await socialReady;
    const uid = await internalId(req.telegramUser.id);
    await query(`INSERT INTO weight_log (user_id, date, kg) VALUES ($1, CURRENT_DATE, $2)
                 ON CONFLICT (user_id, date) DO UPDATE SET kg = EXCLUDED.kg`, [uid, kg]);
    await query('UPDATE athlete_profiles SET weight_kg = $1 WHERE user_id = $2', [kg, uid]).catch(() => {});
    res.json({ ok: true, kg });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось сохранить вес' });
  }
});

// GET /api/auth/morning — утренние отметки за 14 дней
router.get('/morning', requireTelegramAuth, async (req, res) => {
  try {
    await extrasReady;
    const uid = await internalId(req.telegramUser.id);
    if (!uid) return res.status(404).json({ error: 'User not found' });
    const r = await query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, sleep_h, rest_hr, mood FROM morning_checks
       WHERE user_id = $1 AND date >= CURRENT_DATE - 14 ORDER BY date DESC`, [uid]);
    res.json({ checks: r.rows.map((c) => ({ ...c, sleep_h: c.sleep_h == null ? null : Number(c.sleep_h) })) });
  } catch (err) {
    console.error('Morning get failed:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить отметки' });
  }
});

// POST /api/auth/morning { date, sleep_h, rest_hr, mood } — отметка за сегодня (или вчера)
router.post('/morning', requireTelegramAuth, async (req, res) => {
  const b = req.body || {};
  const today = getClientToday(req);
  const date = DATE_RE.test(String(b.date || '')) ? String(b.date) : today;
  if (date > today) return res.status(400).json({ error: 'Нельзя отметить будущий день' });
  let sleep, hr, mood;
  try {
    sleep = numIn(b.sleep_h, 0, 16, 'Сон, часов', 1);
    hr = numIn(b.rest_hr, 25, 130, 'Пульс покоя');
    mood = numIn(b.mood, 1, 5, 'Самочувствие');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (sleep == null && hr == null && mood == null) return res.status(400).json({ error: 'Заполни хотя бы одно поле' });
  try {
    await extrasReady;
    const uid = await internalId(req.telegramUser.id);
    if (!uid) return res.status(404).json({ error: 'User not found' });
    await query(
      `INSERT INTO morning_checks (user_id, date, sleep_h, rest_hr, mood) VALUES ($1, $2::date, $3, $4, $5)
       ON CONFLICT (user_id, date) DO UPDATE SET sleep_h = EXCLUDED.sleep_h, rest_hr = EXCLUDED.rest_hr, mood = EXCLUDED.mood`,
      [uid, date, sleep, hr, mood]);
    res.json({ check: { date, sleep_h: sleep, rest_hr: hr, mood } });
  } catch (err) {
    console.error('Morning save failed:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить отметку' });
  }
});

// Стереть человека и всё, что с ним связано. Большинство таблиц удаляется каскадом само;
// таблицы, созданные вручную в Supabase (друзья и т.п.), могли остаться без каскада — их чистим здесь,
// находя такие связи в самой базе, чтобы удаление не упало на «забытой» таблице.
async function eraseUser(client, userId) {
  const refs = async (table) => (await client.query(
    `SELECT c.conrelid::regclass::text AS tbl, quote_ident(a.attname) AS col, c.conrelid = 'users'::regclass AS self
     FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.contype = 'f' AND c.confrelid = $1::regclass AND c.confdeltype IN ('a', 'r')`, [table])).rows;
  for (const f of await refs('workouts')) {
    await client.query(`DELETE FROM ${f.tbl} WHERE ${f.col} IN (SELECT id FROM workouts WHERE user_id = $1)`, [userId]);
  }
  for (const f of await refs('users')) {
    if (f.self) await client.query(`UPDATE ${f.tbl} SET ${f.col} = NULL WHERE ${f.col} = $1`, [userId]); // ссылка на другого человека внутри users
    else await client.query(`DELETE FROM ${f.tbl} WHERE ${f.col} = $1`, [userId]);
  }
  return client.query('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);
}

// DELETE /api/auth/me { confirm: true } — стереть все мои данные (записи, анализы, друзья, чаты, пробежки, лимиты ИИ…)
router.delete('/me', requireTelegramAuth, async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Нужно подтверждение' });
  let client;
  try {
    await dbReady;
    const u = await query('SELECT id FROM users WHERE telegram_id = $1', [req.telegramUser.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });
    client = await pool.connect();
    await client.query('BEGIN');
    await eraseUser(client, u.rows[0].id);
    await client.query('COMMIT');
    console.log('Account deleted by user:', u.rows[0].id);
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Account delete failed:', err.message);
    res.status(500).json({ error: 'Не получилось удалить данные — попробуй ещё раз' });
  } finally {
    client?.release();
  }
});

export default router;
