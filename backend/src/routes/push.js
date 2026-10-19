import { Router } from 'express';
import { requireTelegramAuth } from '../telegramAuth.js';
import { registerPushToken, removePushToken } from '../push.js';

const router = Router();

// POST /api/push/register { token, platform } — приложение сообщает адрес устройства для уведомлений
router.post('/register', requireTelegramAuth, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token.length < 20 || token.length > 4096) return res.status(400).json({ error: 'Неверный токен' });
  const platform = ['android', 'ios'].includes(req.body?.platform) ? req.body.platform : null;
  await registerPushToken(req.telegramUser.id, token, platform);
  res.json({ ok: true });
});

// POST /api/push/unregister { token } — при выходе из аккаунта
router.post('/unregister', requireTelegramAuth, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token) await removePushToken(req.telegramUser.id, token);
  res.json({ ok: true });
});

export default router;
