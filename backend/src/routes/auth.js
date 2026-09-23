import { Router } from 'express';
import { query } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';

const router = Router();

// POST /api/auth/login — вызывается один раз при открытии Mini App
router.post('/login', requireTelegramAuth, async (req, res) => {
  const tgUser = req.telegramUser;

  const existing = await query('SELECT * FROM users WHERE telegram_id = $1', [tgUser.id]);

  if (existing.rows.length > 0) {
    return res.json({ user: existing.rows[0] });
  }

  const inserted = await query(
    `INSERT INTO users (telegram_id, username, first_name, photo_url)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tgUser.id, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null]
  );

  res.json({ user: inserted.rows[0] });
});

export default router;
