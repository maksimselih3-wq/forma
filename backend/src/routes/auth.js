import { Router } from 'express';
import { query } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { recalcStreak, getClientToday } from '../streak.js';

const router = Router();

// POST /api/auth/login — вызывается один раз при открытии Mini App
router.post('/login', requireTelegramAuth, async (req, res) => {
  const tgUser = req.telegramUser;

  const existing = await query('SELECT * FROM users WHERE telegram_id = $1', [tgUser.id]);

  let user = existing.rows[0];
  if (!user) {
    const inserted = await query(
      `INSERT INTO users (telegram_id, username, first_name, photo_url)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [tgUser.id, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null]
    );
    user = inserted.rows[0];
  }

  // При каждом открытии пересчитываем серию: если человек пропустил день,
  // он сразу увидит честную цифру, а не старую.
  try {
    const streak = await recalcStreak(user.id, getClientToday(req));
    user = { ...user, current_streak: streak.current, longest_streak: streak.longest };
  } catch (err) {
    console.error('Streak recalc on login failed:', err.message);
  }

  res.json({ user });
});

export default router;
