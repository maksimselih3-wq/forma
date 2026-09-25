import { Router } from 'express';
import { query, WORKOUT_SELECT, dbReady } from '../db.js';
import { isAdmin } from '../giveaway.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { getChatReply, describeWorkout, athleteContext } from '../ai.js';
import { getClientToday } from '../streak.js';

const router = Router();

// ---------- Лимит сообщений Fom: 7 в день на человека (админу — без лимита) ----------
export const CHAT_DAILY_LIMIT = Number(process.env.CHAT_DAILY_LIMIT) || 7;
const usageReady = (async () => {
  await dbReady;
  try {
    await query(`CREATE TABLE IF NOT EXISTS chat_usage (
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    )`);
    await query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'chat_usage' AND tableowner = current_user) THEN
        ALTER TABLE chat_usage ENABLE ROW LEVEL SECURITY;
      END IF; END $$`);
  } catch (err) {
    console.error('Chat usage table failed:', err.message);
  }
})();

// День лимита — по Москве (чтобы нельзя было «сбросить» лимит, подкрутив дату в телефоне)
function mskToday() {
  return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
}
async function usedToday(userId) {
  await usageReady;
  const r = await query('SELECT count FROM chat_usage WHERE user_id = $1 AND day = $2::date', [userId, mskToday()]);
  return r.rows[0]?.count || 0;
}

// GET /api/chat/limit — сколько сообщений осталось сегодня
router.get('/limit', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (await isAdmin(req.telegramUser.id)) return res.json({ limit: null, left: null });
  const used = await usedToday(user.id);
  res.json({ limit: CHAT_DAILY_LIMIT, left: Math.max(0, CHAT_DAILY_LIMIT - used) });
});

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

  // лимит: сначала «занимаем» сообщение, если ИИ не ответит — вернём его обратно
  const admin = await isAdmin(req.telegramUser.id);
  let left = null;
  if (!admin) {
    await usageReady;
    const r = await query(
      `INSERT INTO chat_usage (user_id, day, count) VALUES ($1, $2::date, 1)
       ON CONFLICT (user_id, day) DO UPDATE SET count = chat_usage.count + 1
       WHERE chat_usage.count < $3
       RETURNING count`,
      [user.id, mskToday(), CHAT_DAILY_LIMIT]
    );
    if (!r.rows.length) {
      return res.status(429).json({ error: `На сегодня ${CHAT_DAILY_LIMIT} сообщений Fom закончились — он снова ответит завтра 🙂`, left: 0 });
    }
    left = CHAT_DAILY_LIMIT - r.rows[0].count;
  }

  try {
    // Берём записи целиком — с разминкой, повторами, силовой/ОФП и заминкой
    const result = await query(
      `${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.date >= $2::date - 30 ORDER BY w.date ASC`,
      [user.id, today]
    );

    const contextSummary = result.rows.map(describeWorkout).join('\n');

    const reply = await getChatReply(contextSummary, history, message, today, await athleteContext(user.id));
    res.json({ reply, left });
  } catch (err) {
    if (!admin) {
      await query('UPDATE chat_usage SET count = GREATEST(0, count - 1) WHERE user_id = $1 AND day = $2::date', [user.id, mskToday()]).catch(() => {});
    }
    console.error('Chat failed:', err.message);
    res.status(500).json({ error: 'Не удалось получить ответ от ИИ' });
  }
});

export default router;
