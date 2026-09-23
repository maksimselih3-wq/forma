import { Router } from 'express';
import { query } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';

const router = Router();

async function getInternalUser(telegramId) {
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return res.rows[0];
}

// POST /api/friends/request { friendTelegramId }
router.post('/request', requireTelegramAuth, async (req, res) => {
  const user = await getInternalUser(req.telegramUser.id);
  const friendRes = await query('SELECT * FROM users WHERE telegram_id = $1', [req.body.friendTelegramId]);
  const friend = friendRes.rows[0];
  if (!friend) return res.status(404).json({ error: 'Пользователь не найден' });

  await query(
    `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1,$2,'pending')
     ON CONFLICT (user_id, friend_id) DO NOTHING`,
    [user.id, friend.id]
  );
  res.json({ ok: true });
});

// POST /api/friends/accept { friendshipId }
router.post('/accept', requireTelegramAuth, async (req, res) => {
  await query(`UPDATE friendships SET status = 'accepted' WHERE id = $1`, [req.body.friendshipId]);
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
