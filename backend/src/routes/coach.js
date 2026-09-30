import { Router } from 'express';
import { query, dbReady, WORKOUT_SELECT } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { getClientToday } from '../streak.js';
import { volumeKm, shortWorkout, altitudeFacts, athleteContext, getCoachAthleteSummary, getCoachTeamDigest } from '../ai.js';
import { socialReady } from '../social.js';

/**
 * Кабинет тренера — надстройка над тренерской группой (groups.coach_mode = true).
 * Видит его только создатель группы; спортсмены при вступлении соглашаются, что тренер видит их записи.
 *
 *  GET  /api/coach/groups/:id                      — команда: сводные цифры, спортсмены с пометками
 *  GET  /api/coach/groups/:id/members/:uid         — спортсмен: неделя по дням, цифры, вывод Fom (если уже был)
 *  POST /api/coach/groups/:id/members/:uid/fom     — попросить Fom написать вывод для тренера
 *  POST /api/coach/groups/:id/members/:uid/message — написать спортсмену (придёт от бота)
 *  GET  /api/coach/groups/:id/digest               — сводка недели от Fom по группе
 *  POST /api/coach/groups/:id/task                 — задание всей группе (бот + карточка в группе)
 *  GET  /api/coach/groups/:id/task                 — последнее задание (видят все участники)
 */
const router = Router();
const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
for (const m of ['get', 'post']) {
  const orig = router[m].bind(router);
  router[m] = (path, ...fns) => orig(path, ...fns.map(safe));
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL || 'https://maksimselih3-wq.github.io/forma-2/';
const HIGH_M = 1000; // с какой высоты считаем «сбор в горах»

export const coachReady = (async () => {
  await dbReady;
  await socialReady;
  try {
    await query(`CREATE TABLE IF NOT EXISTS coach_messages (
      id SERIAL PRIMARY KEY,
      group_id INT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      coach_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      athlete_id INT REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS coach_messages_group ON coach_messages(group_id, created_at DESC)`);
    await query(`CREATE TABLE IF NOT EXISTS coach_notes (
      coach_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      athlete_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (coach_id, athlete_id, day)
    )`);
    await query(`CREATE TABLE IF NOT EXISTS coach_digests (
      group_id INT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (group_id, day)
    )`);
    await query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS coach_digest_on DATE`);
    await query(`DO $$
      DECLARE t text;
      BEGIN
        FOREACH t IN ARRAY ARRAY['coach_messages', 'coach_notes', 'coach_digests'] LOOP
          IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = t AND tableowner = current_user) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
          END IF;
        END LOOP;
      END $$`);
    console.log('Coach tables OK');
  } catch (err) {
    console.error('Coach tables failed:', err.message);
  }
})();

// ---------- помощники ----------
function addDays(str, n) {
  const d = new Date(str + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(str) {
  const d = new Date(str + 'T00:00:00Z');
  return addDays(str, -((d.getUTCDay() + 6) % 7));
}
function diffDays(a, b) { return Math.round((Date.parse(a) - Date.parse(b)) / 86400000); }
const day = (w) => String(w.date).slice(0, 10);
const r1 = (n) => Math.round(n * 10) / 10;
const avg = (arr) => { const v = arr.filter((x) => Number.isFinite(x) && x > 0); return v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null; };
const fmt = (n) => (n == null ? '—' : String(n).replace('.', ','));
const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function displayName(u) {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return full || (u.username ? '@' + u.username : 'Спортсмен');
}

function tgSend(chatId, text) {
  if (!BOT_TOKEN || !chatId) return Promise.resolve(null);
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId, text,
      reply_markup: { inline_keyboard: [[{ text: 'Открыть Forma', web_app: { url: APP_URL } }]] },
    }),
  }).then((r) => r.json()).catch((err) => { console.error('Coach notify failed:', err.message); return null; });
}

async function loadMe(req, res, next) {
  const r = await query('SELECT * FROM users WHERE telegram_id = $1', [req.telegramUser.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
  req.me = r.rows[0];
  next();
}
router.use(requireTelegramAuth, safe(loadMe));

// Группа, где я тренер (создатель тренерской группы) — иначе null
async function coachGroup(gid, meId) {
  await coachReady;
  gid = parseInt(gid, 10);
  if (!gid) return null;
  const r = await query('SELECT * FROM groups WHERE id = $1 AND coach_mode AND owner_id = $2', [gid, meId]);
  return r.rows[0] || null;
}

/**
 * Цифры по спортсменам группы за текущую неделю (пн — сегодня) и пометки для тренера.
 * Одна выборка на всех: записи за 3 недели, последняя запись, утренние отметки за 7 дней.
 */
async function teamStats(ids, today) {
  const monday = mondayOf(today);
  const prevMonday = addDays(monday, -7);
  const span = diffDays(today, monday); // сколько дней недели прошло (0 = понедельник)
  const from = addDays(today, -21) < prevMonday ? addDays(today, -21) : prevMonday;
  if (!ids.length) return { monday, byId: {} };
  const [ws, lasts, checks] = await Promise.all([
    query(`${WORKOUT_SELECT} WHERE w.user_id = ANY($1::int[]) AND w.date >= $2::date AND w.date <= $3::date
           ORDER BY w.date DESC, w.session DESC`, [ids, from, today]),
    query(`SELECT DISTINCT ON (user_id) user_id, to_char(date, 'YYYY-MM-DD') AS date FROM workouts
           WHERE user_id = ANY($1::int[]) AND date <= $2::date ORDER BY user_id, date DESC, session DESC`, [ids, today]),
    query(`SELECT user_id, sleep_h, mood FROM morning_checks WHERE user_id = ANY($1::int[]) AND date > $2::date - 7 AND date <= $2::date`, [ids, today])
      .catch(() => ({ rows: [] })),
  ]);
  const byId = {};
  for (const id of ids) {
    const all = ws.rows.filter((w) => w.user_id === id);
    const tr = all.filter((w) => w.type === 'training');
    const cur = tr.filter((w) => day(w) >= monday);
    const prev = tr.filter((w) => day(w) >= prevMonday && day(w) < monday);
    const prevSame = prev.filter((w) => diffDays(day(w), prevMonday) <= span);
    const last7 = tr.filter((w) => diffDays(today, day(w)) < 7);
    const km = (list) => r1(list.reduce((a, w) => a + volumeKm(w), 0));
    const myChecks = checks.rows.filter((c) => c.user_id === id);
    const lastDate = lasts.rows.find((x) => x.user_id === id)?.date || null;
    const s = {
      week_km: km(cur), prev_km: km(prevSame), prev_full_km: km(prev),
      trainings: cur.length, prev_trainings: prev.length,
      rpe_avg: avg(cur.map((w) => Number(w.rpe))),
      feel_avg: avg(cur.map((w) => Number(w.feeling))),
      prev_feel_avg: avg(prev.map((w) => Number(w.feeling))),
      heavy7: last7.filter((w) => Number(w.rpe) >= 8).length,
      sleep_avg: myChecks.length >= 2 ? avg(myChecks.map((c) => Number(c.sleep_h))) : null,
      checks: myChecks.length,
      last_date: lastDate,
      days_since: lastDate ? diffDays(today, lastDate) : null,
      last: null, camp: null, flags: [],
    };
    const lw = all[0];
    if (lw) s.last = { date: day(lw), text: shortWorkout(lw), rpe: lw.rpe, start_time: lw.start_time, place: lw.place, altitude_m: lw.altitude_m };
    // сбор: последняя тренировка не старше 3 дней — на высоте от 1000 м (или отмечена «сбор»)
    const lt = tr[0];
    if (lt && diffDays(today, day(lt)) <= 3 && (Number(lt.altitude_m) >= HIGH_M || lt.camp)) {
      let first = day(lt);
      for (const w of tr.slice(1)) {
        if (!(Number(w.altitude_m) >= HIGH_M || w.camp) || diffDays(first, day(w)) > 3) break;
        first = day(w);
      }
      s.camp = { place: lt.place, altitude_m: lt.altitude_m, day: diffDays(today, first) + 1 };
    }
    // пометки: сначала то, что требует внимания
    const f = s.flags;
    if (s.days_since == null) f.push({ kind: 'miss', label: 'Нет записей' });
    else if (s.days_since >= 4) f.push({ kind: 'miss', label: `Нет записей ${s.days_since} дн.` });
    if (s.prev_km >= 10 && s.week_km >= s.prev_km * 1.3) f.push({ kind: 'over', label: `Объём +${Math.round((s.week_km / s.prev_km - 1) * 100)}%` });
    if (s.heavy7 >= 3) f.push({ kind: 'over', label: `Тяжёлых за 7 дн.: ${s.heavy7}` });
    if (s.feel_avg != null && cur.length >= 2 && s.feel_avg <= 4.5) f.push({ kind: 'down', label: `Самочувствие ${fmt(s.feel_avg)}/10` });
    else if (s.feel_avg != null && s.prev_feel_avg != null && s.prev_feel_avg - s.feel_avg >= 2) f.push({ kind: 'down', label: 'Самочувствие ↓' });
    if (s.sleep_avg != null && s.checks >= 3 && s.sleep_avg < 6.5) f.push({ kind: 'sleep', label: `Сон ${fmt(s.sleep_avg)} ч` });
    s.attention = f.length > 0;
    if (s.camp) f.push({ kind: 'camp', label: `Сбор${s.camp.altitude_m ? ` · ${s.camp.altitude_m} м` : ''}` });
    if (!f.length) f.push({ kind: 'ok', label: 'В норме' });
    byId[id] = s;
  }
  return { monday, byId };
}

async function groupAthletes(g) {
  const r = await query(
    `SELECT u.id, u.telegram_id, u.username, u.first_name, u.last_name, u.discipline,
       CASE WHEN u.avatar_data IS NOT NULL THEN left(md5(u.avatar_data), 8) WHEN u.photo_url IS NOT NULL THEN 'tg' END AS avatar_v
     FROM group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND u.id <> $2`, [g.id, g.owner_id]);
  return r.rows;
}

// Строка фактов по спортсмену — для Fom
function factsLine(name, s) {
  const bits = [
    `${s.trainings} трен., ${fmt(s.week_km)} км (прошлая неделя за те же дни ${fmt(s.prev_km)} км, вся прошлая ${fmt(s.prev_full_km)} км)`,
    s.rpe_avg != null && `RPE ср. ${fmt(s.rpe_avg)}`,
    s.feel_avg != null && `самочувствие ср. ${fmt(s.feel_avg)}/10${s.prev_feel_avg != null ? ` (прошлая неделя ${fmt(s.prev_feel_avg)})` : ''}`,
    s.heavy7 && `тяжёлых (RPE 8+) за 7 дней: ${s.heavy7}`,
    s.sleep_avg != null && `сон ср. ${fmt(s.sleep_avg)} ч`,
    s.days_since != null ? `последняя запись ${s.days_since === 0 ? 'сегодня' : s.days_since + ' дн. назад'}` : 'записей нет',
    s.camp && `на сборе${s.camp.place ? ' — ' + s.camp.place : ''}${s.camp.altitude_m ? `, ≈${s.camp.altitude_m} м` : ''}, ${s.camp.day}-й день`,
  ].filter(Boolean);
  const flags = s.flags.filter((x) => x.kind !== 'ok').map((x) => x.label);
  return `${name}: ${bits.join('; ')}${flags.length ? `. Флаги: ${flags.join(', ')}` : ''}`;
}

// ---------- Команда ----------
router.get('/groups/:id', async (req, res) => {
  const g = await coachGroup(req.params.id, req.me.id);
  if (!g) return res.status(403).json({ error: 'Кабинет — только для тренера группы' });
  const today = getClientToday(req);
  const athletes = await groupAthletes(g);
  const { monday, byId } = await teamStats(athletes.map((a) => a.id), today);
  const list = athletes.map((a) => {
    const { telegram_id, ...pub } = a;
    return { ...pub, ...byId[a.id] };
  });
  // сначала те, кому нужно внимание, потом по километрам
  list.sort((a, b) => (b.attention - a.attention) || (b.week_km - a.week_km));
  res.json({
    group: { id: g.id, name: g.name },
    monday, today,
    totals: {
      km: r1(list.reduce((a, x) => a + (x.week_km || 0), 0)),
      trainings: list.reduce((a, x) => a + (x.trainings || 0), 0),
      attention: list.filter((x) => x.attention).length,
      camp: list.filter((x) => x.camp).length,
      athletes: list.length,
    },
    athletes: list,
  });
});

// ---------- Спортсмен ----------
async function athleteInGroup(g, uid) {
  uid = parseInt(uid, 10);
  if (!uid || uid === g.owner_id) return null;
  const r = await query(
    `SELECT u.id, u.telegram_id, u.first_name, u.last_name, u.username FROM group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND m.user_id = $2`, [g.id, uid]);
  return r.rows[0] || null;
}

router.get('/groups/:id/members/:uid', async (req, res) => {
  const g = await coachGroup(req.params.id, req.me.id);
  if (!g) return res.status(403).json({ error: 'Только для тренера группы' });
  const a = await athleteInGroup(g, req.params.uid);
  if (!a) return res.status(404).json({ error: 'Спортсмен не в группе' });
  const today = getClientToday(req);
  const { monday, byId } = await teamStats([a.id], today);
  const w = await query(`${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.date >= $2::date AND w.date <= $3::date`, [a.id, monday, addDays(monday, 6)]);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    const list = w.rows.filter((x) => day(x) === d);
    const tr = list.filter((x) => x.type === 'training');
    days.push({
      date: d, wd: WD[new Date(d + 'T00:00:00Z').getUTCDay()],
      km: r1(tr.reduce((s, x) => s + volumeKm(x), 0)),
      rpe: tr.length ? Math.max(...tr.map((x) => Number(x.rpe) || 0)) : null,
      rest: list.some((x) => x.type === 'rest'), future: d > today,
    });
  }
  const note = await query('SELECT text FROM coach_notes WHERE coach_id = $1 AND athlete_id = $2 AND day = $3', [req.me.id, a.id, today]);
  const msgs = await query(
    `SELECT text, to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS at FROM coach_messages
     WHERE group_id = $1 AND athlete_id = $2 ORDER BY created_at DESC LIMIT 5`, [g.id, a.id]);
  res.json({ stats: byId[a.id], days, fom: note.rows[0]?.text || null, messages: msgs.rows });
});

router.post('/groups/:id/members/:uid/fom', async (req, res) => {
  const g = await coachGroup(req.params.id, req.me.id);
  if (!g) return res.status(403).json({ error: 'Только для тренера группы' });
  const a = await athleteInGroup(g, req.params.uid);
  if (!a) return res.status(404).json({ error: 'Спортсмен не в группе' });
  const today = getClientToday(req);
  const { byId } = await teamStats([a.id], today);
  const ws = await query(`${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.date > $2::date - 14 AND w.date <= $2::date ORDER BY w.date DESC, w.session DESC`, [a.id, today]);
  const trainings = ws.rows.filter((x) => x.type === 'training');
  const alt = trainings.length ? altitudeFacts(trainings[0], trainings.slice(1)) : '';
  try {
    const text = await getCoachAthleteSummary(displayName(a), factsLine(displayName(a), byId[a.id]) + (alt ? '\n' + alt : ''), ws.rows, await athleteContext(a.id));
    if (!text) throw new Error('пустой ответ');
    await query(
      `INSERT INTO coach_notes (coach_id, athlete_id, day, text) VALUES ($1, $2, $3, $4)
       ON CONFLICT (coach_id, athlete_id, day) DO UPDATE SET text = EXCLUDED.text`, [req.me.id, a.id, today, text]);
    res.json({ fom: text });
  } catch (err) {
    console.error('Coach summary failed:', err.message);
    res.status(502).json({ error: 'Fom сейчас не ответил — попробуй через минуту' });
  }
});

router.post('/groups/:id/members/:uid/message', async (req, res) => {
  const g = await coachGroup(req.params.id, req.me.id);
  if (!g) return res.status(403).json({ error: 'Только для тренера группы' });
  const a = await athleteInGroup(g, req.params.uid);
  if (!a) return res.status(404).json({ error: 'Спортсмен не в группе' });
  const text = String(req.body.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Напиши сообщение' });
  await query('INSERT INTO coach_messages (group_id, coach_id, athlete_id, text) VALUES ($1, $2, $3, $4)', [g.id, req.me.id, a.id, text]);
  const r = await tgSend(a.telegram_id, `💬 Тренер ${displayName(req.me)} (${g.name}):\n\n${text}`);
  res.json({ ok: true, delivered: !!r?.ok });
});

// ---------- Сводка недели по группе ----------
async function buildDigest(g, today) {
  const athletes = await groupAthletes(g);
  const { monday, byId } = await teamStats(athletes.map((a) => a.id), today);
  const lines = athletes.map((a) => factsLine(displayName(a), byId[a.id]));
  const list = Object.values(byId);
  const totals = `${athletes.length} спортсменов, ${fmt(r1(list.reduce((s, x) => s + x.week_km, 0)))} км, ${list.reduce((s, x) => s + x.trainings, 0)} тренировок; прошлая неделя за те же дни — ${fmt(r1(list.reduce((s, x) => s + x.prev_km, 0)))} км`;
  const weekLabel = `неделю ${monday.slice(8, 10)}.${monday.slice(5, 7)} – ${today.slice(8, 10)}.${today.slice(5, 7)}`;
  return getCoachTeamDigest(g.name, weekLabel, lines, totals);
}

router.get('/groups/:id/digest', async (req, res) => {
  const g = await coachGroup(req.params.id, req.me.id);
  if (!g) return res.status(403).json({ error: 'Только для тренера группы' });
  const today = getClientToday(req);
  const fresh = req.query.fresh === '1';
  if (!fresh) {
    const c = await query('SELECT text FROM coach_digests WHERE group_id = $1 AND day = $2', [g.id, today]);
    if (c.rows[0]) return res.json({ text: c.rows[0].text, cached: true });
  }
  try {
    const text = await buildDigest(g, today);
    if (!text) throw new Error('пустой ответ');
    await query(`INSERT INTO coach_digests (group_id, day, text) VALUES ($1, $2, $3)
                 ON CONFLICT (group_id, day) DO UPDATE SET text = EXCLUDED.text`, [g.id, today, text]);
    res.json({ text });
  } catch (err) {
    console.error('Coach digest failed:', err.message);
    res.status(502).json({ error: 'Fom сейчас не ответил — попробуй через минуту' });
  }
});

// ---------- Задание группе ----------
router.post('/groups/:id/task', async (req, res) => {
  const g = await coachGroup(req.params.id, req.me.id);
  if (!g) return res.status(403).json({ error: 'Только для тренера группы' });
  const text = String(req.body.text || '').trim().slice(0, 1500);
  if (!text) return res.status(400).json({ error: 'Напиши задание' });
  // не чаще раза в минуту — чтобы случайно не разослать дважды
  const recent = await query(`SELECT 1 FROM coach_messages WHERE group_id = $1 AND athlete_id IS NULL AND created_at > now() - interval '1 minute'`, [g.id]);
  if (recent.rows.length) return res.status(429).json({ error: 'Задание только что отправлено — подожди минуту' });
  await query('INSERT INTO coach_messages (group_id, coach_id, athlete_id, text) VALUES ($1, $2, NULL, $3)', [g.id, req.me.id, text]);
  const athletes = await groupAthletes(g);
  let delivered = 0;
  for (const a of athletes) {
    const r = await tgSend(a.telegram_id, `📋 Задание от тренера — ${g.name}:\n\n${text}`);
    if (r?.ok) delivered++;
    await new Promise((ok) => setTimeout(ok, 60));
  }
  res.json({ ok: true, delivered, total: athletes.length });
});

// Последнее задание за 7 дней — видят все участники группы
router.get('/groups/:id/task', async (req, res) => {
  await coachReady;
  const gid = parseInt(req.params.id, 10);
  const mem = gid && (await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [gid, req.me.id]));
  if (!mem?.rows?.length) return res.status(404).json({ error: 'Группа не найдена' });
  const r = await query(
    `SELECT text, to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS at FROM coach_messages
     WHERE group_id = $1 AND athlete_id IS NULL AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 1`, [gid]);
  res.json({ task: r.rows[0] || null });
});

// ---------- Сводка тренеру в бота: воскресенье, 19:00 по Москве ----------
function escHtml(t) { return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
export async function sendCoachDigests(send, { force = false } = {}) {
  await coachReady;
  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  const today = msk.toISOString().slice(0, 10);
  if (!force && (msk.getUTCDay() !== 0 || msk.getUTCHours() < 19 || msk.getUTCHours() >= 23)) return 0;
  const gs = await query(
    `SELECT g.*, u.telegram_id AS coach_tg FROM groups g JOIN users u ON u.id = g.owner_id
     WHERE g.coach_mode AND (g.coach_digest_on IS NULL OR g.coach_digest_on < $1::date)
       AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND m.user_id <> g.owner_id)`, [today]);
  let sent = 0;
  for (const g of gs.rows) {
    const claim = await query(`UPDATE groups SET coach_digest_on = $1::date WHERE id = $2 AND (coach_digest_on IS NULL OR coach_digest_on < $1::date) RETURNING id`, [today, g.id]);
    if (!claim.rows.length) continue;
    try {
      const text = await buildDigest(g, today);
      if (!text) continue;
      await query(`INSERT INTO coach_digests (group_id, day, text) VALUES ($1, $2, $3) ON CONFLICT (group_id, day) DO UPDATE SET text = EXCLUDED.text`, [g.id, today, text]);
      const r = await send(g.coach_tg, `📋 <b>Сводка недели — ${escHtml(g.name)}</b>\n\n${escHtml(text)}`);
      if (r?.ok) sent++;
    } catch (err) {
      console.error('Coach digest failed for group', g.id, err.message);
    }
    await new Promise((ok) => setTimeout(ok, 300));
  }
  if (sent) console.log(`Coach digest: отправлено ${sent}`);
  return sent;
}

export default router;
