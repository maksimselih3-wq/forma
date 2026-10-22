import { Router } from 'express';
import { query, dbReady } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';

/**
 * Жалобы и блокировка пользователей.
 *  POST /api/safety/block   { user_id }  — заблокировать: связь дружбы стирается, контент друг друга больше не виден
 *  POST /api/safety/unblock { user_id }
 *  GET  /api/safety/blocks               — список заблокированных мной
 *  POST /api/safety/report  { kind, target_id, user_id, reason } — жалоба; админу приходит сообщение в бота
 */
const router = Router();
const BOT_TOKEN = process.env.BOT_TOKEN;
const KINDS = ['user', 'comment', 'workout', 'message', 'run', 'group'];

async function loadMe(req, res, next) {
  await dbReady;
  const r = await query('SELECT * FROM users WHERE telegram_id = $1', [req.telegramUser.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
  req.me = r.rows[0];
  next();
}
router.use(requireTelegramAuth, loadMe);

const nameOf = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u?.username ? '@' + u.username : 'Спортсмен');

router.post('/block', async (req, res) => {
  const id = parseInt(req.body?.user_id, 10);
  if (!id) return res.status(400).json({ error: 'Не указан пользователь' });
  if (id === req.me.id) return res.status(400).json({ error: 'Нельзя заблокировать себя' });
  const u = await query('SELECT id FROM users WHERE id = $1', [id]);
  if (!u.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
  await query('INSERT INTO user_blocks (blocker, blocked) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.me.id, id]);
  // дружба в любую сторону (и заявки) — стираем
  await query('DELETE FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)', [req.me.id, id]);
  res.json({ ok: true });
});

router.post('/unblock', async (req, res) => {
  const id = parseInt(req.body?.user_id, 10);
  if (!id) return res.status(400).json({ error: 'Не указан пользователь' });
  await query('DELETE FROM user_blocks WHERE blocker = $1 AND blocked = $2', [req.me.id, id]);
  res.json({ ok: true });
});

router.get('/blocks', async (req, res) => {
  const r = await query(
    `SELECT u.id, u.username, u.first_name, u.last_name FROM user_blocks b JOIN users u ON u.id = b.blocked
     WHERE b.blocker = $1 ORDER BY b.created_at DESC`, [req.me.id]);
  res.json({ blocks: r.rows });
});

const recent = new Map();
router.post('/report', async (req, res) => {
  const kind = KINDS.includes(req.body?.kind) ? req.body.kind : null;
  if (!kind) return res.status(400).json({ error: 'Неверный тип жалобы' });
  const targetId = parseInt(req.body?.target_id, 10) || null;
  const userId = parseInt(req.body?.user_id, 10) || null;
  const reason = String(req.body?.reason || '').trim().slice(0, 300) || 'без пояснения';
  // одну и ту же жалобу повторно не шлём
  const key = `${req.me.id}:${kind}:${targetId || userId}`;
  if (recent.has(key)) return res.json({ ok: true });
  if (recent.size > 5000) recent.clear();
  recent.set(key, Date.now());

  await query('INSERT INTO user_reports (reporter, target_user, kind, target_id, reason) VALUES ($1, $2, $3, $4, $5)',
    [req.me.id, userId, kind, targetId, reason]);

  let admin = process.env.ADMIN_TELEGRAM_ID;
  if (!admin) {
    const a = await query(`SELECT telegram_id FROM users WHERE LOWER(username) = 'maksimshelikh'`);
    admin = a.rows[0]?.telegram_id;
  }
  if (BOT_TOKEN && admin) {
    let target = null;
    if (userId) target = (await query('SELECT first_name, last_name, username FROM users WHERE id = $1', [userId])).rows[0];
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: admin,
        text: `⚠️ Жалоба (${kind}${targetId ? ' #' + targetId : ''})\nОт: ${nameOf(req.me)}${req.me.username ? ' @' + req.me.username : ''}\n` +
          (target ? `На: ${nameOf(target)}${target.username ? ' @' + target.username : ''} (id ${userId})\n` : '') + `Причина: ${reason}`,
      }),
    }).catch(() => {});
  }
  res.json({ ok: true });
});

export default router;
