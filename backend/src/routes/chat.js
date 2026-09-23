import { Router } from 'express';
import { query } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { getChatReply } from '../ai.js';

const router = Router();

async function getInternalUser(telegramId) {
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return res.rows[0];
}

// POST /api/chat { message, history }
router.post('/', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const message = (req.body.message || '').trim();
  const history = Array.isArray(req.body.history) ? req.body.history : [];

  if (!message) return res.status(400).json({ error: 'Пустое сообщение' });

  try {
    const result = await query(
      `SELECT date, type, rpe, feeling, notes FROM workouts
       WHERE user_id = $1 AND date >= CURRENT_DATE - 30
       ORDER BY date ASC`,
      [user.id]
    );

    const contextSummary = result.rows
      .map((w) => `${w.date}: ${w.type === 'rest' ? 'отдых' : `тренировка, RPE=${w.rpe ?? '-'}, самочувствие=${w.feeling ?? '-'}${w.notes ? `, заметка: ${w.notes}` : ''}`}`)
      .join('\n');

    const reply = await getChatReply(contextSummary, history, message);
    res.json({ reply });
  } catch (err) {
    console.error('Chat failed:', err.message);
    res.status(500).json({ error: 'Не удалось получить ответ от ИИ' });
  }
});

export default router;
