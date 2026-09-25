import { Router } from 'express';
import { query, WORKOUT_SELECT } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { getPeriodInsight, athleteContext } from '../ai.js';
import { getClientToday } from '../streak.js';

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

  // Считаем от начала календарной недели (понедельник) или календарного месяца —
  // по «сегодня» пользователя, а не по часам сервера
  const today = getClientToday(req);
  const now = new Date(today + 'T00:00:00Z');
  let startDate;
  if (period === 'month') {
    startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else {
    const day = now.getUTCDay(); // 0=вс, 1=пн, ...
    const diffToMonday = day === 0 ? 6 : day - 1;
    startDate = new Date(now);
    startDate.setUTCDate(now.getUTCDate() - diffToMonday);
  }
  const startDateStr = startDate.toISOString().slice(0, 10);

  try {
    const result = await query(
      `${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.date >= $2::date AND w.date <= $3::date ORDER BY w.date ASC`,
      [user.id, startDateStr, today]
    );

    if (result.rows.length === 0) {
      return res.json({ insight: null, workoutsCount: 0, period });
    }

    const insight = await getPeriodInsight(result.rows, period, await athleteContext(user.id));
    res.json({ insight, workoutsCount: result.rows.length, period });
  } catch (err) {
    console.error('Insight generation failed:', err.message);
    res.status(500).json({ error: 'Не удалось получить разбор от ИИ' });
  }
});

export default router;
