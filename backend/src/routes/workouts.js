import { Router } from 'express';
import { query, pool } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { recalcStreak } from '../streak.js';
import { getWorkoutFeedback } from '../ai.js';

const router = Router();

async function getInternalUser(telegramId) {
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return res.rows[0];
}

// POST /api/workouts — создать/обновить запись за дату (тренировка или отдых)
router.post('/', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { date, type, warmup, cooldown, feeling, rpe, notes, visibility, sets } = req.body;

  if (!date || !['training', 'rest'].includes(type)) {
    return res.status(400).json({ error: 'date и type (training|rest) обязательны' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upserted = await client.query(
      `INSERT INTO workouts (user_id, date, type, warmup, cooldown, feeling, rpe, notes, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, date) DO UPDATE SET
         type = EXCLUDED.type, warmup = EXCLUDED.warmup, cooldown = EXCLUDED.cooldown,
         feeling = EXCLUDED.feeling, rpe = EXCLUDED.rpe, notes = EXCLUDED.notes,
         visibility = EXCLUDED.visibility
       RETURNING *`,
      [user.id, date, type, warmup || null, cooldown || null, feeling || null, rpe || null, notes || null, visibility || 'private']
    );
    const workout = upserted.rows[0];

    await client.query('DELETE FROM workout_sets WHERE workout_id = $1', [workout.id]);
    if (Array.isArray(sets)) {
      for (let i = 0; i < sets.length; i++) {
        const s = sets[i];
        await client.query(
          `INSERT INTO workout_sets (workout_id, order_index, distance_m, reps, time_or_pace, rest_between)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [workout.id, i, s.distance_m || null, s.reps || null, s.time_or_pace || null, s.rest_between || null]
        );
      }
    }

    await client.query('COMMIT');

    await recalcStreak(user.id, date);

    // ИИ-фидбек — только для тренировок, не для дней отдыха
    let aiFeedback = null;
    if (type === 'training') {
      const recentRes = await query(
        `SELECT date, type, rpe, feeling FROM workouts
         WHERE user_id = $1 AND date < $2 ORDER BY date DESC LIMIT 7`,
        [user.id, date]
      );
      try {
        aiFeedback = await getWorkoutFeedback({ date, warmup, sets, rpe, feeling, notes }, recentRes.rows);
        await query('UPDATE workouts SET ai_feedback = $1 WHERE id = $2', [aiFeedback, workout.id]);
      } catch (err) {
        console.error('AI feedback failed:', err.message);
        // не роняем весь запрос, если ИИ недоступен
      }
    }

    res.json({ workout: { ...workout, ai_feedback: aiFeedback }, sets: sets || [] });
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

  const result = await query(
    `SELECT w.*, COALESCE(json_agg(s.*) FILTER (WHERE s.id IS NOT NULL), '[]') AS sets
     FROM workouts w LEFT JOIN workout_sets s ON s.workout_id = w.id
     WHERE w.user_id = $1 GROUP BY w.id ORDER BY w.date DESC`,
    [user.id]
  );

  res.json({ workouts: result.rows, streak: { current: user.current_streak, longest: user.longest_streak } });
});

// GET /api/workouts/:id — одна запись с повторами
router.get('/:id', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const result = await query(
    `SELECT w.*, COALESCE(json_agg(s.* ORDER BY s.order_index) FILTER (WHERE s.id IS NOT NULL), '[]') AS sets
     FROM workouts w LEFT JOIN workout_sets s ON s.workout_id = w.id
     WHERE w.id = $1 AND w.user_id = $2
     GROUP BY w.id`,
    [req.params.id, user.id]
  );

  if (result.rows.length === 0) return res.status(404).json({ error: 'Запись не найдена' });
  res.json({ workout: result.rows[0] });
});

// PUT /api/workouts/:id — обновить существующую запись
router.put('/:id', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { type, warmup, cooldown, feeling, rpe, notes, visibility, sets } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updated = await client.query(
      `UPDATE workouts SET type=$1, warmup=$2, cooldown=$3, feeling=$4, rpe=$5, notes=$6, visibility=$7
       WHERE id=$8 AND user_id=$9 RETURNING *`,
      [type, warmup || null, cooldown || null, feeling || null, rpe || null, notes || null, visibility || 'private', req.params.id, user.id]
    );

    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    await client.query('DELETE FROM workout_sets WHERE workout_id = $1', [req.params.id]);
    if (Array.isArray(sets)) {
      for (let i = 0; i < sets.length; i++) {
        const s = sets[i];
        await client.query(
          `INSERT INTO workout_sets (workout_id, order_index, distance_m, reps, time_or_pace, rest_between)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id, i, s.distance_m || null, s.reps || null, s.time_or_pace || null, s.rest_between || null]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ workout: updated.rows[0], sets: sets || [] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Не удалось обновить запись' });
  } finally {
    client.release();
  }
});

// DELETE /api/workouts/:id
router.delete('/:id', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const result = await query('DELETE FROM workouts WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, user.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Запись не найдена' });
  res.json({ ok: true });
});

export default router;
