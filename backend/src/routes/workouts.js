import { Router } from 'express';
import { query, pool, WORKOUT_SELECT } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { recalcStreak, getClientToday, isValidDate, daysBetween } from '../streak.js';
import { getWorkoutFeedback, parseWorkoutText } from '../ai.js';

const router = Router();

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
async function saveChildren(client, workoutId, sets, exercises) {
  await client.query('DELETE FROM workout_sets WHERE workout_id = $1', [workoutId]);
  if (Array.isArray(sets)) {
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i];
      await client.query(
        `INSERT INTO workout_sets (workout_id, order_index, distance_m, reps, time_or_pace, rest_between)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [workoutId, i, s.distance_m || null, s.reps || null, s.time_or_pace || null, s.rest_between || null]
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

// Число в допустимых пределах, иначе пусто
function num(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
}

// POST /api/workouts/parse { text } — умный ввод: Fom раскладывает текст по полям формы
router.post('/parse', requireTelegramAuth, async (req, res) => {
  const text = (req.body.text || '').toString().trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Напиши, как прошла тренировка' });

  try {
    const p = await parseWorkoutText(text);
    const parsed = {
      type: p.type === 'rest' ? 'rest' : 'training',
      warmup: txt(p.warmup, 500),
      cooldown: txt(p.cooldown, 500),
      notes: txt(p.notes, 1000),
      rpe: num(p.rpe, 1, 10),
      feeling: num(p.feeling, 1, 10),
      hr_avg: hr(p.hr_avg),
      hr_max: hr(p.hr_max),
      hr_min: hr(p.hr_min),
      sets: (Array.isArray(p.sets) ? p.sets : [])
        .map((s) => ({
          distance_m: num(s.distance_m, 1, 100000),
          reps: num(s.reps, 1, 200),
          time_or_pace: txt(s.time_or_pace, 30),
          rest_between: txt(s.rest_between, 30),
        }))
        .filter((s) => s.distance_m || s.reps || s.time_or_pace)
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
// Дата может быть любой прошедшей (календарь) или сегодняшней, но не будущей.
router.post('/', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { date, type, warmup, cooldown, feeling, rpe, notes, visibility } = req.body;
  const isTraining = type === 'training';
  const sets = isTraining && Array.isArray(req.body.sets) ? req.body.sets : [];
  const exercises = isTraining ? cleanExercises(req.body.exercises) : [];
  const hrAvg = isTraining ? hr(req.body.hr_avg) : null;
  const hrMax = isTraining ? hr(req.body.hr_max) : null;
  const hrMin = isTraining ? hr(req.body.hr_min) : null;

  if (!isValidDate(date) || !['training', 'rest'].includes(type)) {
    return res.status(400).json({ error: 'date (ГГГГ-ММ-ДД) и type (training|rest) обязательны' });
  }

  const today = getClientToday(req);
  if (daysBetween(today, date) > 0) {
    return res.status(400).json({ error: 'Нельзя сделать запись на будущую дату' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upserted = await client.query(
      `INSERT INTO workouts (user_id, date, type, warmup, cooldown, feeling, rpe, notes, visibility, hr_avg, hr_max, hr_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (user_id, date) DO UPDATE SET
         type = EXCLUDED.type, warmup = EXCLUDED.warmup, cooldown = EXCLUDED.cooldown,
         feeling = EXCLUDED.feeling, rpe = EXCLUDED.rpe, notes = EXCLUDED.notes,
         visibility = EXCLUDED.visibility,
         hr_avg = EXCLUDED.hr_avg, hr_max = EXCLUDED.hr_max, hr_min = EXCLUDED.hr_min
       RETURNING *`,
      [user.id, date, type, warmup || null, cooldown || null, feeling || null, rpe || null, notes || null, visibility || 'private', hrAvg, hrMax, hrMin]
    );
    const workout = upserted.rows[0];

    await saveChildren(client, workout.id, sets, exercises);

    await client.query('COMMIT');

    // Серию пересчитываем целиком — запись задним числом может «склеить» разорванную серию
    const streak = await recalcStreak(user.id, today);

    // ИИ-фидбек от Fom — только для тренировок, не для дней отдыха
    let aiFeedback = null;
    if (isTraining) {
      // 7 предыдущих записей целиком — чтобы Fom видел реальную картину
      const recentRes = await query(
        `${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.date < $2 ORDER BY w.date DESC LIMIT 7`,
        [user.id, date]
      );
      try {
        aiFeedback = await getWorkoutFeedback(
          { date, type, warmup, cooldown, sets, exercises, rpe, feeling, notes, hr_avg: hrAvg, hr_max: hrMax, hr_min: hrMin, isBackdated: date !== today },
          recentRes.rows
        );
        await query('UPDATE workouts SET ai_feedback = $1 WHERE id = $2', [aiFeedback, workout.id]);
      } catch (err) {
        console.error('AI feedback failed:', err.message);
        // не роняем весь запрос, если ИИ недоступен
      }
    }

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

  const result = await query(`${WORKOUT_SELECT} WHERE w.user_id = $1 ORDER BY w.date DESC`, [user.id]);

  res.json({ workouts: result.rows, streak: { current: user.current_streak, longest: user.longest_streak } });
});

// GET /api/workouts/:id — одна запись с повторами и упражнениями
router.get('/:id', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const result = await query(`${WORKOUT_SELECT} WHERE w.id = $1 AND w.user_id = $2`, [req.params.id, user.id]);

  if (result.rows.length === 0) return res.status(404).json({ error: 'Запись не найдена' });
  res.json({ workout: result.rows[0] });
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updated = await client.query(
      `UPDATE workouts SET type=$1, warmup=$2, cooldown=$3, feeling=$4, rpe=$5, notes=$6, visibility=$7,
         hr_avg=$8, hr_max=$9, hr_min=$10
       WHERE id=$11 AND user_id=$12 RETURNING *`,
      [type, warmup || null, cooldown || null, feeling || null, rpe || null, notes || null, visibility || 'private', hrAvg, hrMax, hrMin, req.params.id, user.id]
    );

    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    await saveChildren(client, req.params.id, sets, exercises);

    await client.query('COMMIT');
    res.json({ workout: { ...updated.rows[0], sets, exercises } });
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
