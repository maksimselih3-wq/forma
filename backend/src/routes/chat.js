import { Router } from 'express';
import { query, WORKOUT_SELECT } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { getChatReply, describeWorkout, athleteContext } from '../ai.js';
import { getClientToday } from '../streak.js';

const router = Router();

async function getInternalUser(telegramId) {
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return res.rows[0];
}

// POST /api/chat { message, history }
router.post('/', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Ограничиваем длину: одно сообщение до 2000 символов, в памяти диалога — последние 20 сообщений.
  // Так никто не сможет «накрутить» огромный запрос к ИИ за твой счёт.
  const message = (req.body.message || '').toString().trim().slice(0, 2000);
  const history = (Array.isArray(req.body.history) ? req.body.history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  // ИИ требует, чтобы диалог начинался с сообщения пользователя
  while (history.length && history[0].role !== 'user') history.shift();

  if (!message) return res.status(400).json({ error: 'Пустое сообщение' });

  const today = getClientToday(req);

  try {
    // Берём записи целиком — с разминкой, повторами, силовой/ОФП и заминкой
    const result = await query(
      `${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.date >= $2::date - 30 ORDER BY w.date ASC`,
      [user.id, today]
    );

    const contextSummary = result.rows.map(describeWorkout).join('\n');

    const reply = await getChatReply(contextSummary, history, message, today, await athleteContext(user.id));
    res.json({ reply });
  } catch (err) {
    console.error('Chat failed:', err.message);
    res.status(500).json({ error: 'Не удалось получить ответ от ИИ' });
  }
});

export default router;
