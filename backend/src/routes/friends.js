import { Router } from 'express';
import { query } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';

const router = Router();

async function getInternalUser(telegramId) {
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return res.rows[0];
}

// POST /api/friends/request { username } — найти по Telegram username (без @) и отправить заявку
router.post('/request', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  const username = (req.body.username || '').replace(/^@/, '').trim();
  if (!username) return res.status(400).json({ error: 'Укажи username' });

  const friendRes = await query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  const friend = friendRes.rows[0];
  if (!friend) {
    return res.status(404).json({ error: 'Пользователь не найден. Он должен хотя бы раз открыть приложение.' });
  }
  if (friend.id === user.id) {
    return res.status(400).json({ error: 'Нельзя добавить самого себя' });
  }

  // проверяем, нет ли уже связи в любую сторону
  const existing = await query(
    `SELECT * FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
    [user.id, friend.id]
  );
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: 'Заявка уже отправлена или вы уже друзья' });
  }

  await query(
    `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1,$2,'pending')`,
    [user.id, friend.id]
  );
  res.json({ ok: true });
});

// GET /api/friends/requests — входящие заявки (кто-то добавил меня)
router.get('/requests', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);

  const result = await query(
    `SELECT f.id AS friendship_id, u.username, u.first_name
     FROM friendships f JOIN users u ON u.id = f.user_id
     WHERE f.friend_id = $1 AND f.status = 'pending'`,
    [user.id]
  );

  res.json({ requests: result.rows });
});

// POST /api/friends/accept { friendshipId }
router.post('/accept', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  await query(
    `UPDATE friendships SET status = 'accepted' WHERE id = $1 AND friend_id = $2`,
    [req.body.friendshipId, user.id]
  );
  res.json({ ok: true });
});

// POST /api/friends/decline { friendshipId } — отклонить входящую заявку
router.post('/decline', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  await query(
    `DELETE FROM friendships WHERE id = $1 AND friend_id = $2 AND status = 'pending'`,
    [req.body.friendshipId, user.id]
  );
  res.json({ ok: true });
});

// GET /api/friends — список друзей + их серии
router.get('/', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);

  const result = await query(
    `SELECT u.id, u.username, u.first_name, u.current_streak, u.longest_streak, f.status
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
     WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'`,
    [user.id]
  );

  res.json({ friends: result.rows });
});

// GET /api/friends/:friendId/workouts — только публичные записи друга
router.get('/:friendId/workouts', requireTelegramAuth, async (req, res) => {
  const result = await query(
    `SELECT w.*, COALESCE(json_agg(s.*) FILTER (WHERE s.id IS NOT NULL), '[]') AS sets
     FROM workouts w LEFT JOIN workout_sets s ON s.workout_id = w.id
     WHERE w.user_id = $1 AND w.visibility = 'public'
     GROUP BY w.id ORDER BY w.date DESC LIMIT 30`,
    [req.params.friendId]
  );
  res.json({ workouts: result.rows });
});

export default router;
