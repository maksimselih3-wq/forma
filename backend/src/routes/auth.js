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
  } else {
    // Имя, username и фото в Telegram могут поменяться — обновляем, чтобы друзья находили и видели актуальное
    const updated = await query(
      `UPDATE users SET username = $2, first_name = $3, photo_url = COALESCE($4, photo_url)
       WHERE id = $1 RETURNING *`,
      [user.id, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null]
    );
    user = updated.rows[0] || user;
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

// POST /api/auth/avatar { image } — своё фото профиля.
// Фото сжимается прямо на телефоне до маленькой картинки JPEG и хранится в базе.
// { image: null } — удалить своё фото и вернуться к фото из Telegram.
router.post('/avatar', requireTelegramAuth, async (req, res) => {
  const image = req.body.image;

  if (image !== null) {
    const ok = typeof image === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(image);
    if (!ok) return res.status(400).json({ error: 'Нужна картинка' });
    if (image.length > 95000) return res.status(400).json({ error: 'Фото слишком большое' });
  }

  const result = await query(
    'UPDATE users SET avatar_data = $1 WHERE telegram_id = $2 RETURNING avatar_data',
    [image, req.telegramUser.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

  res.json({ ok: true, avatar_data: result.rows[0].avatar_data });
});

export default router;
