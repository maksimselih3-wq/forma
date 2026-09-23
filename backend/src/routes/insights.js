import { Router } from 'express';
import { query } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { getPeriodInsight } from '../ai.js';

const router = Router();

async function getInternalUser(telegramId) {
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return res.rows[0];
}

// GET /api/insights?period=week|month
router.get('/', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const period = req.query.period === 'month' ? 'month' : 'week';
  const days = period === 'month' ? 30 : 7;

  try {
    const result = await query(
      `SELECT w.*, COALESCE(json_agg(s.*) FILTER (WHERE s.id IS NOT NULL), '[]') AS sets
       FROM workouts w LEFT JOIN workout_sets s ON s.workout_id = w.id
       WHERE w.user_id = $1 AND w.date >= CURRENT_DATE - $2::int
       GROUP BY w.id ORDER BY w.date ASC`,
      [user.id, days]
    );

    if (result.rows.length === 0) {
      return res.json({ insight: null, workoutsCount: 0, period });
    }

    const insight = await getPeriodInsight(result.rows, period);
    res.json({ insight, workoutsCount: result.rows.length, period });
  } catch (err) {
    console.error('Insight generation failed:', err.message);
    res.status(500).json({ error: 'Не удалось получить разбор от ИИ' });
  }
});

export default router;
