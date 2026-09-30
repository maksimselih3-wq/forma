import { Router } from 'express';
import { query, pool, WORKOUT_SELECT, dbReady } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { recalcStreak, getClientToday, isValidDate, daysBetween } from '../streak.js';
import { getWorkoutFeedback, parseWorkoutText, athleteContext, workSignature } from '../ai.js';
import { socialReady } from '../social.js';

const router = Router();

// Новые записи можно добавлять только за сегодня и вчера — так серия остаётся честной.
// (Уже существующие записи за любые дни можно спокойно редактировать.)
const MAX_BACKFILL_DAYS = 1;

// Вторая тренировка за день: у записи появляется номер (session = 1 или 2).
// Раньше в базе было правило «одна запись в день» — меняем его на «одна запись на номер в день».
const schemaReady = (async () => {
  await dbReady;
  try {
    await query(`ALTER TABLE workouts ADD COLUMN IF NOT EXISTS session INT NOT NULL DEFAULT 1`);
    await query(`DO $$
      DECLARE c text;
      BEGIN
        FOR c IN
          SELECT con.conname FROM pg_constraint con
          JOIN pg_class t ON t.oid = con.conrelid
          WHERE t.relname = 'workouts' AND con.contype = 'u'
            AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                 WHERE a.attrelid = t.oid AND a.attnum = ANY(con.conkey)) = ARRAY['date','user_id']
        LOOP
          EXECUTE format('ALTER TABLE workouts DROP CONSTRAINT %I', c);
        END LOOP;
      END $$`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS workouts_user_date_session ON workouts(user_id, date, session)`);
    // старт (соревнование): название, дисциплина, результат, место — хранится прямо в записи
    await query(`ALTER TABLE workouts ADD COLUMN IF NOT EXISTS competition JSONB`);
    // отрезок по времени (фартлек, вставки): длительность в секундах вместо метров
    await query(`ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS duration_s INT`);
    // время тренировки: с какого по какое («18:00»–«19:30»)
    await query(`ALTER TABLE workouts ADD COLUMN IF NOT EXISTS start_time TEXT`);
    await query(`ALTER TABLE workouts ADD COLUMN IF NOT EXISTS end_time TEXT`);
    console.log('Workouts schema OK (вторая тренировка)');
  } catch (err) {
    console.error('Workouts migration failed:', err.message);
  }
})();

async function getInternalUser(telegramId) {
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return res.rows[0];
}

// Пульс: целое число от 30 до 250, иначе пусто (защита от опечаток вроде «1500»)
function hr(v) {
  const n = parseInt(v, 10);
  return n >= 30 && n <= 250 ? n : null;
}

// Короткий текст: обрезаем пробелы и слишком длинные значения
function txt(v, max = 60) {
  const s = (v ?? '').toString().trim();
  return s ? s.slice(0, max) : null;
}

// Дистанция в метрах: «400» → 400, «10 км» → 10000, «1,5 км» → 1500, «10k» → 10000, «800м» → 800
function parseDistance(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 0 && v <= 1000000 ? Math.round(v) : null;
  const t = String(v).toLowerCase().replace(',', '.').replace(/\s+/g, '');
  const n = parseFloat(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  const m = /км|km|k$/.test(t) ? n * 1000 : n;
  return m <= 1000000 ? Math.round(m) : null;
}

// Похоже на время, а не на метры: «1'», «30"», «1'30"», «1:30», «1 мин», «30 сек»
function looksLikeDuration(v) {
  return typeof v === 'string' && /['"′″’”]|мин|сек|:/i.test(v);
}
// Время отрезка в секундах: «1'» → 60, «30"» → 30, «1'30"» → 90, «1:30» → 90, «2 мин» → 120
function parseDuration(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 0 && v <= 36000 ? Math.round(v) : null;
  const t = String(v).toLowerCase().replace(',', '.').replace(/[′’]/g, "'").replace(/[″”]/g, '"').replace(/\s+/g, '');
  let sec = 0;
  const hms = t.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) sec = hms[3] != null ? (+hms[1]) * 3600 + (+hms[2]) * 60 + (+hms[3]) : (+hms[1]) * 60 + (+hms[2]);
  else {
    const m = t.match(/(\d+(?:\.\d+)?)(?:'|мин)/);
    const s2 = t.match(/(\d+(?:\.\d+)?)(?:"|сек|с$)/) || (m && t.match(/(?:'|мин)(\d{1,2})$/));
    sec = (m ? parseFloat(m[1]) * 60 : 0) + (s2 ? parseFloat(s2[1]) : 0);
  }
  return sec > 0 && sec <= 36000 ? Math.round(sec) : null;
}

// Упражнения силовой/ОФП: оставляем только строки, где указано название
function cleanExercises(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => ({
      name: txt(e.name, 80),
      sets: parseInt(e.sets, 10) > 0 ? Math.min(parseInt(e.sets, 10), 100) : null,
      reps: txt(e.reps, 30),
      weight: txt(e.weight, 30),
    }))
    .filter((e) => e.name);
}

// Сохранить беговые повторы и упражнения записи (старые удаляем, новые вставляем)
// «7:05», «19:30» → «07:05»; всё прочее — null
function cleanTime(v) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null;
}

// Всё, от чего зависит отзыв Fom: если это поменялось при редактировании — отзыв пишем заново
function contentKey(w) {
  if (!w) return '';
  const comp = typeof w.competition === 'string' ? w.competition : JSON.stringify(w.competition || null);
  return JSON.stringify([
    w.type, w.warmup, w.cooldown, w.feeling, w.rpe, w.notes, w.hr_avg, w.hr_max, w.hr_min, comp, w.start_time, w.end_time,
    (w.sets || []).map((x) => [x.distance_m, x.duration_s, x.reps, x.time_or_pace, x.rest_between]),
    (w.exercises || []).map((x) => [x.name, x.sets, x.reps, x.weight]),
  ]);
}
async function loadWorkout(id) {
  const r = await query(`${WORKOUT_SELECT} WHERE w.id = $1`, [id]);
  return r.rows[0] || null;
}

// Отзыв Fom по сохранённой записи: 7 предыдущих записей, похожая тренировка за 4 месяца, анкета.
// Пишет отзыв в базу и возвращает его (или null, если Fom недоступен).
async function buildFeedback(userId, workoutId, today) {
  const w = await loadWorkout(workoutId);
  if (!w || w.type !== 'training') return null;
  const date = String(w.date).slice(0, 10);
  const recentRes = await query(
    `${WORKOUT_SELECT} WHERE w.user_id = $1 AND (w.date < $2 OR (w.date = $2 AND w.session < $3))
     ORDER BY w.date DESC, w.session DESC LIMIT 7`,
    [userId, date, w.session || 1]
  );
  let similar = null;
  const sig = workSignature(w.sets);
  if (sig) {
    try {
      const prev = await query(
        `${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.id <> $2 AND w.type = 'training' AND w.date >= $3::date - 120
         AND w.date <= $3::date ORDER BY w.date DESC LIMIT 60`,
        [userId, w.id, date]
      );
      similar = prev.rows.find((x) => workSignature(x.sets) === sig) || null;
    } catch (e) { /* не страшно */ }
  }
  try {
    const text = await getWorkoutFeedback(
      { ...w, date, isBackdated: date !== today },
      recentRes.rows,
      await athleteContext(userId),
      similar
    );
    await query('UPDATE workouts SET ai_feedback = $1 WHERE id = $2', [text, w.id]);
    return text;
  } catch (err) {
    console.error('AI feedback failed:', err.message);
    return null;
  }
}

// Кому видна запись: 'private' — только мне, 'public' — всем друзьям, 'custom' — выбранным друзьям
function cleanVisibility(v) {
  return v === 'public' || v === 'custom' ? v : 'private';
}
// Список выбранных друзей для 'custom' (берём только настоящих друзей, до 200 человек)
async function saveVisibleTo(client, workoutId, ownerId, visibility, list) {
  await socialReady;
  await client.query('DELETE FROM workout_visible_to WHERE workout_id = $1', [workoutId]);
  if (visibility !== 'custom') return [];
  const ids = [...new Set((Array.isArray(list) ? list : []).map((x) => parseInt(x, 10)).filter((x) => x > 0))].slice(0, 200);
  if (!ids.length) return [];
  const ok = await client.query(
    `SELECT CASE WHEN user_id = $1 THEN friend_id ELSE user_id END AS id FROM friendships
     WHERE status = 'accepted' AND (user_id = $1 OR friend_id = $1)
       AND (CASE WHEN user_id = $1 THEN friend_id ELSE user_id END) = ANY($2::int[])`, [ownerId, ids]);
  const good = ok.rows.map((r) => r.id);
  for (const id of good) {
    await client.query('INSERT INTO workout_visible_to (workout_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [workoutId, id]);
  }
  return good;
}
// Для своих записей: кому из друзей открыта каждая 'custom'-запись
async function attachVisibleTo(rows) {
  const ids = rows.filter((w) => w.visibility === 'custom').map((w) => w.id);
  if (!ids.length) return rows;
  await socialReady;
  const r = await query('SELECT workout_id, user_id FROM workout_visible_to WHERE workout_id = ANY($1::int[])', [ids]);
  const by = {};
  r.rows.forEach((x) => { (by[x.workout_id] ||= []).push(x.user_id); });
  return rows.map((w) => (w.visibility === 'custom' ? { ...w, visible_to: by[w.id] || [] } : w));
}

async function saveChildren(client, workoutId, sets, exercises) {
  await client.query('DELETE FROM workout_sets WHERE workout_id = $1', [workoutId]);
  if (Array.isArray(sets)) {
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i];
      // в поле «метры» можно написать время («1'», «30"») — тогда это отрезок по времени
      const dur = parseDuration(s.duration_s) || (looksLikeDuration(s.distance_m) ? parseDuration(s.distance_m) : null);
      const dist = dur ? null : parseDistance(s.distance_m);
      await client.query(
        `INSERT INTO workout_sets (workout_id, order_index, distance_m, duration_s, reps, time_or_pace, rest_between)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [workoutId, i, dist, dur, parseInt(s.reps, 10) > 0 ? Math.min(parseInt(s.reps, 10), 500) : null, s.time_or_pace || null, s.rest_between || null]
      );
    }
  }

  await client.query('DELETE FROM workout_exercises WHERE workout_id = $1', [workoutId]);
  for (let i = 0; i < exercises.length; i++) {
    const e = exercises[i];
    await client.query(
      `INSERT INTO workout_exercises (workout_id, order_index, name, sets, reps, weight)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [workoutId, i, e.name, e.sets, e.reps, e.weight]
    );
  }
}

// Старт: { name, discipline, result, place } — или null, если это обычная тренировка
function cleanCompetition(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {
    name: txt(c.name, 80),
    discipline: txt(c.discipline, 40),
    result: txt(c.result, 20),
    place: parseInt(c.place, 10) >= 1 && parseInt(c.place, 10) <= 9999 ? parseInt(c.place, 10) : null,
  };
  return out.discipline || out.result || out.name ? out : null;
}

// Число в допустимых пределах, иначе пусто
function num(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
}

// POST /api/workouts/parse { text } — умный ввод: Fom раскладывает текст по полям формы
router.post('/parse', requireTelegramAuth, async (req, res) => {
  // файл с часов даёт длинный список кругов — ему можно чуть больше текста
  const text = (req.body.text || '').toString().trim().slice(0, req.body.source === 'watch' ? 5000 : 2000);
  if (!text) return res.status(400).json({ error: 'Напиши, как прошла тренировка' });

  try {
    const p = await parseWorkoutText(text);
    const parsed = {
      type: p.type === 'rest' ? 'rest' : 'training',
      warmup: txt(p.warmup, 500),
      cooldown: txt(p.cooldown, 500),
      notes: txt(p.notes, 1000),
      start_time: cleanTime(p.start_time),
      end_time: cleanTime(p.end_time),
      rpe: num(p.rpe, 1, 10),
      feeling: num(p.feeling, 1, 10),
      hr_avg: hr(p.hr_avg),
      hr_max: hr(p.hr_max),
      hr_min: hr(p.hr_min),
      sets: (Array.isArray(p.sets) ? p.sets : [])
        .map((s) => ({
          distance_m: s.duration_s ? null : num(s.distance_m, 1, 100000),
          duration_s: num(s.duration_s, 1, 36000),
          reps: num(s.reps, 1, 200),
          time_or_pace: txt(s.time_or_pace, 30),
          rest_between: txt(s.rest_between, 30),
        }))
        .filter((s) => s.distance_m || s.duration_s || s.reps || s.time_or_pace)
        .slice(0, 50),
      exercises: cleanExercises(p.exercises).slice(0, 50),
    };
    res.json({ parsed });
  } catch (err) {
    console.error('Smart input failed:', err.message);
    res.status(500).json({ error: 'Fom не смог разобрать текст. Попробуй написать чуть иначе.' });
  }
});

// POST /api/workouts — создать/обновить запись за дату (тренировка или отдых).
// session: 1 — основная запись дня, 2 — вторая тренировка.
// Новую запись можно создать только за сегодня или вчера; существующую — обновить за любой день.
router.post('/', requireTelegramAuth, async (req, res) => {
  await schemaReady;
  await socialReady;
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { date, type, warmup, cooldown, feeling, rpe, notes, visibility } = req.body;
  const isTraining = type === 'training';
  const sets = isTraining && Array.isArray(req.body.sets) ? req.body.sets : [];
  const exercises = isTraining ? cleanExercises(req.body.exercises) : [];
  const hrAvg = isTraining ? hr(req.body.hr_avg) : null;
  const hrMax = isTraining ? hr(req.body.hr_max) : null;
  const hrMin = isTraining ? hr(req.body.hr_min) : null;

  const session = parseInt(req.body.session, 10) === 2 ? 2 : 1;
  const competition = isTraining ? cleanCompetition(req.body.competition) : null;
  const competitionJson = competition ? JSON.stringify(competition) : null; // в базу — строкой JSON

  if (!isValidDate(date) || !['training', 'rest'].includes(type)) {
    return res.status(400).json({ error: 'date (ГГГГ-ММ-ДД) и type (training|rest) обязательны' });
  }
  if (session === 2 && !isTraining) {
    return res.status(400).json({ error: 'Вторая запись за день — только тренировка' });
  }

  const today = getClientToday(req);
  if (daysBetween(today, date) > 0) {
    return res.status(400).json({ error: 'Нельзя сделать запись на будущую дату' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const values = [warmup || null, cooldown || null, feeling || null, rpe || null, notes || null, cleanVisibility(visibility), hrAvg, hrMax, hrMin];
    const found = await client.query(
      'SELECT id FROM workouts WHERE user_id = $1 AND date = $2 AND session = $3',
      [user.id, date, session]
    );

    let workout;
    if (found.rows.length) {
      // запись уже есть — обновляем
      const upd = await client.query(
        `UPDATE workouts SET type=$1, warmup=$2, cooldown=$3, feeling=$4, rpe=$5, notes=$6, visibility=$7,
           hr_avg=$8, hr_max=$9, hr_min=$10, competition=$11
         WHERE id=$12 RETURNING *`,
        [type, ...values, competitionJson, found.rows[0].id]
      );
      workout = upd.rows[0];
    } else {
      // новая запись — только за сегодня или вчера
      if (daysBetween(date, today) > MAX_BACKFILL_DAYS) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Новые записи можно добавлять только за сегодня и вчера 🙂' });
      }
      if (session === 2) {
        const first = await client.query(
          `SELECT type FROM workouts WHERE user_id = $1 AND date = $2 AND session = 1`, [user.id, date]
        );
        if (!first.rows.length || first.rows[0].type !== 'training') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Сначала запиши первую тренировку за этот день' });
        }
      }
      const ins = await client.query(
        `INSERT INTO workouts (user_id, date, session, type, warmup, cooldown, feeling, rpe, notes, visibility, hr_avg, hr_max, hr_min, competition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [user.id, date, session, type, ...values, competitionJson]
      );
      workout = ins.rows[0];
    }

    await saveChildren(client, workout.id, sets, exercises);
    const visibleTo = await saveVisibleTo(client, workout.id, user.id, workout.visibility, req.body.visible_to);
    const startTime = isTraining ? cleanTime(req.body.start_time) : null;
    const endTime = isTraining ? cleanTime(req.body.end_time) : null;
    await client.query('UPDATE workouts SET start_time = $1, end_time = $2 WHERE id = $3', [startTime, endTime, workout.id]);
    workout.start_time = startTime; workout.end_time = endTime;

    await client.query('COMMIT');
    if (workout.visibility === 'custom') workout.visible_to = visibleTo;

    // Серию пересчитываем целиком — запись задним числом может «склеить» разорванную серию
    const streak = await recalcStreak(user.id, today);

    // ИИ-фидбек от Fom — только для тренировок, не для дней отдыха
    const aiFeedback = isTraining ? await buildFeedback(user.id, workout.id, today) : null;

    res.json({ workout: { ...workout, sets, exercises, ai_feedback: aiFeedback }, streak });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to save workout' });
  } finally {
    client.release();
  }
});

// GET /api/workouts — список тренировок текущего пользователя
router.get('/', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  await schemaReady;
  const result = await query(`${WORKOUT_SELECT} WHERE w.user_id = $1 ORDER BY w.date DESC, w.session`, [user.id]);

  res.json({ workouts: await attachVisibleTo(result.rows), streak: { current: user.current_streak, longest: user.longest_streak } });
});

// GET /api/workouts/:id — одна запись с повторами и упражнениями
router.get('/:id', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const result = await query(`${WORKOUT_SELECT} WHERE w.id = $1 AND w.user_id = $2`, [req.params.id, user.id]);

  if (result.rows.length === 0) return res.status(404).json({ error: 'Запись не найдена' });
  res.json({ workout: (await attachVisibleTo(result.rows))[0] });
});

// PUT /api/workouts/:id — обновить существующую запись
router.put('/:id', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { type, warmup, cooldown, feeling, rpe, notes, visibility } = req.body;
  const isTraining = type === 'training';
  const sets = isTraining && Array.isArray(req.body.sets) ? req.body.sets : [];
  const exercises = isTraining ? cleanExercises(req.body.exercises) : [];
  const hrAvg = isTraining ? hr(req.body.hr_avg) : null;
  const hrMax = isTraining ? hr(req.body.hr_max) : null;
  const hrMin = isTraining ? hr(req.body.hr_min) : null;
  const competition = isTraining ? cleanCompetition(req.body.competition) : null;
  const competitionJson = competition ? JSON.stringify(competition) : null; // в базу — строкой JSON

  await schemaReady;
  await socialReady;
  const before = await query(`${WORKOUT_SELECT} WHERE w.id = $1 AND w.user_id = $2`, [req.params.id, user.id]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updated = await client.query(
      `UPDATE workouts SET type=$1, warmup=$2, cooldown=$3, feeling=$4, rpe=$5, notes=$6, visibility=$7,
         hr_avg=$8, hr_max=$9, hr_min=$10, competition=$11
       WHERE id=$12 AND user_id=$13 RETURNING *`,
      [type, warmup || null, cooldown || null, feeling || null, rpe || null, notes || null, cleanVisibility(visibility), hrAvg, hrMax, hrMin, competitionJson, req.params.id, user.id]
    );

    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    await saveChildren(client, req.params.id, sets, exercises);
    const visibleTo = await saveVisibleTo(client, updated.rows[0].id, user.id, updated.rows[0].visibility, req.body.visible_to);
    const startTime = isTraining ? cleanTime(req.body.start_time) : null;
    const endTime = isTraining ? cleanTime(req.body.end_time) : null;
    await client.query('UPDATE workouts SET start_time = $1, end_time = $2 WHERE id = $3', [startTime, endTime, updated.rows[0].id]);

    await client.query('COMMIT');

    // Запись изменили (добавили отрезки, поправили пульс…) — Fom пишет отзыв заново
    const after = await loadWorkout(updated.rows[0].id);
    let aiFeedback = after?.ai_feedback ?? null;
    if (isTraining && contentKey(before.rows[0]) !== contentKey(after)) {
      aiFeedback = (await buildFeedback(user.id, updated.rows[0].id, getClientToday(req))) ?? aiFeedback;
    }
    res.json({ workout: { ...(after || updated.rows[0]), ai_feedback: aiFeedback, ...(updated.rows[0].visibility === 'custom' ? { visible_to: visibleTo } : {}) } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Не удалось обновить запись' });
  } finally {
    client.release();
  }
});

// DELETE /api/workouts/:id — после удаления серия пересчитывается
router.delete('/:id', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const result = await query('DELETE FROM workouts WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, user.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Запись не найдена' });

  let streak = null;
  try {
    streak = await recalcStreak(user.id, getClientToday(req));
  } catch (err) {
    console.error('Streak recalc after delete failed:', err.message);
  }
  res.json({ ok: true, streak });
});

export default router;
