import { Router } from 'express';
import { query, WORKOUT_SELECT } from '../db.js';
import { requireTelegramAuth, validateInitData } from '../telegramAuth.js';
import { socialReady, isCoachOf, shareGroup, newGroupCode, refCode, referralStats, REF_MIN_WORKOUTS, REF_MAX_BONUS } from '../social.js';

const router = Router();

// Ошибка в любом маршруте (например, база недоступна) не должна ронять сервер —
// оборачиваем обработчики, чтобы ошибка превращалась в ответ 500.
const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
for (const m of ['get', 'post', 'delete']) {
  const orig = router[m].bind(router);
  router[m] = (path, ...fns) => orig(path, ...fns.map(safe));
}

const BOT_TOKEN = process.env.BOT_TOKEN;
// Ссылка на само приложение — для кнопки «Открыть Forma» в уведомлениях
const APP_URL = process.env.APP_URL || 'https://maksimselih3-wq.github.io/forma-2/';

// Какие реакции можно ставить на тренировку
const REACTIONS = ['🔥', '👏', '💪', '🚀'];

// Публичные поля человека, которые видят друзья (без фото целиком — фото грузится отдельно)
const PUBLIC_USER = `u.id, u.username, u.first_name, u.last_name, u.current_streak, u.longest_streak, u.sport, u.discipline,
  CASE WHEN u.avatar_data IS NOT NULL THEN left(md5(u.avatar_data), 8)
       WHEN u.photo_url IS NOT NULL THEN 'tg' END AS avatar_v`;

async function getInternalUser(telegramId) {
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return res.rows[0];
}

// Все маршруты ниже работают только для зарегистрированного пользователя
async function loadMe(req, res, next) {
  const me = await getInternalUser(req.telegramUser.id);
  if (!me) return res.status(404).json({ error: 'User not found' });
  req.me = me;
  next();
}

function displayName(u) {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return full || (u.username ? '@' + u.username : 'Спортсмен');
}

function dayMonth(date) {
  return new Date(String(date).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

// Друзья ли два человека (заявка принята)
async function areFriends(a, b) {
  a = parseInt(a, 10);
  b = parseInt(b, 10);
  if (!a || !b) return false;
  if (Number(a) === Number(b)) return true; // сам себе «друг» — можно смотреть свой профиль глазами друзей
  const r = await query(
    `SELECT 1 FROM friendships WHERE status = 'accepted'
       AND ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))`,
    [a, b]
  );
  return r.rows.length > 0;
}

// Может ли человек видеть тренировку: своя — всегда, чужая — только открытая и только у друга
async function getVisibleWorkout(meId, workoutId) {
  workoutId = parseInt(workoutId, 10);
  if (!workoutId) return null;
  const r = await query('SELECT id, user_id, visibility, date FROM workouts WHERE id = $1', [workoutId]);
  const w = r.rows[0];
  if (!w) return null;
  if (w.user_id === meId) return w;
  if (await isCoachOf(meId, w.user_id)) return w; // тренер видит все записи своих спортсменов
  if (w.visibility !== 'public') return null;
  return (await areFriends(meId, w.user_id)) || (await shareGroup(meId, w.user_id)) ? w : null;
}

// Уведомление в Telegram от бота (если человек когда-то запускал бота). Ошибки не мешают приложению.
function notify(telegramId, text) {
  if (!BOT_TOKEN || !telegramId) return;
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramId,
      text,
      reply_markup: { inline_keyboard: [[{ text: 'Открыть Forma', web_app: { url: APP_URL } }]] },
    }),
  }).catch((err) => console.error('Notify failed:', err.message));
}

/**
 * К списку тренировок добавляем: автора, реакции (сколько каких + моя) и число комментариев.
 * Отзыв Fom не показываем никому, кроме хозяина — это личное.
 */
async function withSocial(workouts, meId) {
  if (workouts.length === 0) return [];
  const ids = workouts.map((w) => w.id);
  const userIds = [...new Set(workouts.map((w) => w.user_id))];

  const [reactions, comments, users] = await Promise.all([
    query(
      `SELECT workout_id, emoji, count(*)::int AS n, bool_or(user_id = $2) AS mine
       FROM workout_reactions WHERE workout_id = ANY($1::int[]) GROUP BY workout_id, emoji`,
      [ids, meId]
    ),
    query(
      `SELECT workout_id, count(*)::int AS n FROM workout_comments
       WHERE workout_id = ANY($1::int[]) GROUP BY workout_id`,
      [ids]
    ),
    query(`SELECT ${PUBLIC_USER} FROM users u WHERE u.id = ANY($1::int[])`, [userIds]),
  ]);

  const usersById = Object.fromEntries(users.rows.map((u) => [u.id, u]));
  return workouts.map((w) => {
    const rs = reactions.rows.filter((r) => r.workout_id === w.id);
    const counts = {};
    rs.forEach((r) => { counts[r.emoji] = r.n; });
    const { ai_feedback, ...rest } = w;
    return {
      ...rest,
      ai_feedback: w.user_id === meId ? ai_feedback : null,
      author: usersById[w.user_id] || null,
      reactions: counts,
      my_reaction: rs.find((r) => r.mine)?.emoji || null,
      comments_count: comments.rows.find((c) => c.workout_id === w.id)?.n || 0,
    };
  });
}

// ===================================================================
//  ФОТО ПРОФИЛЯ ДРУГА
//  GET /api/friends/avatar/:userId?auth=... — картинка для <img>.
//  Картинка не умеет слать заголовки, поэтому подпись Telegram передаём в адресе.
// ===================================================================
router.get('/avatar/:userId', async (req, res) => {
  const auth = validateInitData(req.query.auth);
  if (!auth?.user) return res.status(401).end();
  const me = await getInternalUser(auth.user.id);
  if (!me || !(await areFriends(me.id, req.params.userId))) return res.status(403).end();

  const r = await query('SELECT avatar_data, photo_url FROM users WHERE id = $1', [parseInt(req.params.userId, 10)]);
  const u = r.rows[0];
  if (!u) return res.status(404).end();

  if (u.avatar_data) {
    const m = u.avatar_data.match(/^data:(image\/[a-z]+);base64,(.*)$/);
    if (!m) return res.status(404).end();
    res.set('Content-Type', m[1]);
    res.set('Cache-Control', 'private, max-age=86400');
    return res.send(Buffer.from(m[2], 'base64'));
  }
  if (u.photo_url) return res.redirect(u.photo_url);
  res.status(404).end();
});

// Всё остальное — только с проверкой Telegram
router.use(requireTelegramAuth, safe(loadMe));

// ===================================================================
//  ЗАЯВКИ И СПИСОК ДРУЗЕЙ
// ===================================================================

// POST /api/friends/request { username } — найти по Telegram username (без @) и отправить заявку
router.post('/request', async (req, res) => {
  const me = req.me;
  const username = (req.body.username || '').replace(/^@/, '').trim();
  if (!username) return res.status(400).json({ error: 'Укажи username' });

  const friendRes = await query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  const friend = friendRes.rows[0];
  if (!friend) {
    return res.status(404).json({ error: 'Пользователь не найден. Он должен хотя бы раз открыть приложение.' });
  }
  if (friend.id === me.id) {
    return res.status(400).json({ error: 'Нельзя добавить самого себя' });
  }

  // проверяем, нет ли уже связи в любую сторону
  const existing = await query(
    `SELECT * FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
    [me.id, friend.id]
  );
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: 'Заявка уже отправлена или вы уже друзья' });
  }

  await query(`INSERT INTO friendships (user_id, friend_id, status) VALUES ($1,$2,'pending')`, [me.id, friend.id]);
  notify(friend.telegram_id, `👋 ${displayName(me)} хочет добавить тебя в друзья в Forma`);
  res.json({ ok: true });
});

// GET /api/friends/requests — входящие заявки (кто-то добавил меня)
router.get('/requests', async (req, res) => {
  const result = await query(
    `SELECT f.id AS friendship_id, ${PUBLIC_USER}
     FROM friendships f JOIN users u ON u.id = f.user_id
     WHERE f.friend_id = $1 AND f.status = 'pending'
     ORDER BY f.created_at DESC`,
    [req.me.id]
  );
  res.json({ requests: result.rows });
});

// POST /api/friends/accept { friendshipId }
router.post('/accept', async (req, res) => {
  const result = await query(
    `UPDATE friendships SET status = 'accepted' WHERE id = $1 AND friend_id = $2 AND status = 'pending'
     RETURNING user_id`,
    [req.body.friendshipId, req.me.id]
  );
  const requester = result.rows[0];
  if (requester) {
    const u = await query('SELECT telegram_id FROM users WHERE id = $1', [requester.user_id]);
    notify(u.rows[0]?.telegram_id, `🤝 Теперь вы с ${displayName(req.me)} друзья в Forma`);
  }
  res.json({ ok: true });
});

// POST /api/friends/decline { friendshipId } — отклонить входящую заявку
router.post('/decline', async (req, res) => {
  await query(
    `DELETE FROM friendships WHERE id = $1 AND friend_id = $2 AND status = 'pending'`,
    [req.body.friendshipId, req.me.id]
  );
  res.json({ ok: true });
});

// GET /api/friends — список друзей: серия и когда последний раз тренировался
router.get('/', async (req, res) => {
  const result = await query(
    `SELECT ${PUBLIC_USER},
       (SELECT max(w.date) FROM workouts w WHERE w.user_id = u.id AND w.type = 'training') AS last_training
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
     WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
     ORDER BY u.current_streak DESC, u.first_name`,
    [req.me.id]
  );
  res.json({ friends: result.rows });
});

// ===================================================================
//  ЛЕНТА: открытые тренировки друзей и мои, самые свежие сверху
//  GET /api/friends/feed?before_date=ГГГГ-ММ-ДД&before_id=N — следующая порция
// ===================================================================
router.get('/feed', async (req, res) => {
  const beforeDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.before_date || '') ? req.query.before_date : null;
  const beforeId = parseInt(req.query.before_id, 10) || null;

  const result = await query(
    `WITH people AS (
       SELECT CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END AS id
       FROM friendships f WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted'
       UNION SELECT $1
     )
     ${WORKOUT_SELECT}
     WHERE w.user_id IN (SELECT id FROM people) AND w.visibility = 'public'
       AND ($2::date IS NULL OR (w.date, w.id) < ($2::date, $3::int))
     ORDER BY w.date DESC, w.id DESC
     LIMIT 15`,
    [req.me.id, beforeDate, beforeId || 0]
  );

  res.json({ workouts: await withSocial(result.rows, req.me.id) });
});

// ===================================================================
//  АКТИВНОСТЬ: кто отреагировал и что написали под моими тренировками
// ===================================================================
const ACTIVITY_SQL = `
  SELECT * FROM (
    SELECT 'reaction' AS kind, r.emoji, NULL AS text, r.created_at, w.id AS workout_id, w.date, ${PUBLIC_USER}
    FROM workout_reactions r JOIN workouts w ON w.id = r.workout_id JOIN users u ON u.id = r.user_id
    WHERE w.user_id = $1 AND r.user_id <> $1
    UNION ALL
    SELECT 'comment' AS kind, NULL AS emoji, c.text, c.created_at, w.id AS workout_id, w.date, ${PUBLIC_USER}
    FROM workout_comments c JOIN workouts w ON w.id = c.workout_id JOIN users u ON u.id = c.user_id
    WHERE w.user_id = $1 AND c.user_id <> $1
  ) a`;

// GET /api/friends/activity/count — число новых событий и заявок (для значка на кнопке «Друзья»)
router.get('/activity/count', async (req, res) => {
  const [unread, requests] = await Promise.all([
    query(`SELECT count(*)::int AS n FROM (${ACTIVITY_SQL}) x WHERE x.created_at > $2`, [
      req.me.id, req.me.activity_seen_at || new Date(0),
    ]),
    query(`SELECT count(*)::int AS n FROM friendships WHERE friend_id = $1 AND status = 'pending'`, [req.me.id]),
  ]);
  res.json({ unread: unread.rows[0].n, requests: requests.rows[0].n });
});

// GET /api/friends/activity — последние 30 событий; после просмотра они считаются прочитанными
router.get('/activity', async (req, res) => {
  const seenAt = req.me.activity_seen_at || new Date(0);
  const result = await query(`${ACTIVITY_SQL} ORDER BY a.created_at DESC LIMIT 30`, [req.me.id]);
  await query('UPDATE users SET activity_seen_at = now() WHERE id = $1', [req.me.id]);
  res.json({
    items: result.rows.map((r) => ({ ...r, unread: new Date(r.created_at) > new Date(seenAt) })),
  });
});

// ===================================================================
//  НАСТРОЙКИ ПРИВАТНОСТИ
//  POST /api/friends/settings { share_calendar } — видят ли друзья все мои дни в календаре
// ===================================================================
router.post('/settings', async (req, res) => {
  const share = req.body.share_calendar !== false;
  await query('UPDATE users SET share_calendar = $1 WHERE id = $2', [share, req.me.id]);
  res.json({ ok: true, share_calendar: share });
});

// ===================================================================
//  РЕАКЦИИ И КОММЕНТАРИИ
// ===================================================================

// GET /api/friends/workouts/:id/social — кто как отреагировал + все комментарии
router.get('/workouts/:id/social', async (req, res) => {
  const w = await getVisibleWorkout(req.me.id, req.params.id);
  if (!w) return res.status(404).json({ error: 'Запись недоступна' });

  const [reactions, comments] = await Promise.all([
    query(
      `SELECT r.emoji, ${PUBLIC_USER} FROM workout_reactions r JOIN users u ON u.id = r.user_id
       WHERE r.workout_id = $1 ORDER BY r.created_at`,
      [w.id]
    ),
    query(
      `SELECT c.id AS comment_id, c.text, c.created_at, ${PUBLIC_USER}
       FROM workout_comments c JOIN users u ON u.id = c.user_id
       WHERE c.workout_id = $1 ORDER BY c.created_at`,
      [w.id]
    ),
  ]);

  res.json({
    reactions: reactions.rows,
    comments: comments.rows.map((c) => ({
      ...c,
      can_delete: c.id === req.me.id || w.user_id === req.me.id, // автор комментария или хозяин тренировки
    })),
  });
});

// POST /api/friends/workouts/:id/react { emoji } — поставить реакцию; та же ещё раз — убрать
router.post('/workouts/:id/react', async (req, res) => {
  const emoji = req.body.emoji;
  if (!REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Такой реакции нет' });

  const w = await getVisibleWorkout(req.me.id, req.params.id);
  if (!w) return res.status(404).json({ error: 'Запись недоступна' });

  const existing = await query('SELECT emoji FROM workout_reactions WHERE workout_id = $1 AND user_id = $2', [
    w.id, req.me.id,
  ]);
  const prev = existing.rows[0]?.emoji;

  if (prev === emoji) {
    await query('DELETE FROM workout_reactions WHERE workout_id = $1 AND user_id = $2', [w.id, req.me.id]);
  } else {
    await query(
      `INSERT INTO workout_reactions (workout_id, user_id, emoji) VALUES ($1,$2,$3)
       ON CONFLICT (workout_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
      [w.id, req.me.id, emoji]
    );
    // уведомляем хозяина только о первой реакции человека, чтобы не спамить при переключении
    if (!prev && w.user_id !== req.me.id) {
      const owner = await query('SELECT telegram_id FROM users WHERE id = $1', [w.user_id]);
      notify(owner.rows[0]?.telegram_id, `${emoji} ${displayName(req.me)} оценил(а) твою тренировку за ${dayMonth(w.date)}`);
    }
  }

  const [item] = await withSocial([{ id: w.id, user_id: w.user_id }], req.me.id);
  res.json({ reactions: item.reactions, my_reaction: item.my_reaction });
});

// POST /api/friends/workouts/:id/comments { text } — написать комментарий
router.post('/workouts/:id/comments', async (req, res) => {
  const text = (req.body.text || '').toString().trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Пустой комментарий' });

  const w = await getVisibleWorkout(req.me.id, req.params.id);
  if (!w) return res.status(404).json({ error: 'Запись недоступна' });

  await query('INSERT INTO workout_comments (workout_id, user_id, text) VALUES ($1,$2,$3)', [w.id, req.me.id, text]);

  if (w.user_id !== req.me.id) {
    const owner = await query('SELECT telegram_id FROM users WHERE id = $1', [w.user_id]);
    const short = text.length > 120 ? text.slice(0, 120) + '…' : text;
    notify(owner.rows[0]?.telegram_id, `💬 ${displayName(req.me)} о твоей тренировке за ${dayMonth(w.date)}:\n«${short}»`);
  }
  res.json({ ok: true });
});

// DELETE /api/friends/comments/:id — удалить свой комментарий (или любой под своей тренировкой)
router.delete('/comments/:id', async (req, res) => {
  if (!parseInt(req.params.id, 10)) return res.status(400).json({ error: 'Неверный id' });
  const result = await query(
    `DELETE FROM workout_comments c USING workouts w
     WHERE c.id = $1 AND w.id = c.workout_id AND (c.user_id = $2 OR w.user_id = $2)
     RETURNING c.id`,
    [req.params.id, req.me.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Комментарий не найден' });
  res.json({ ok: true });
});

// ===================================================================
//  ГРУППЫ: команды и тренерские группы
// ===================================================================
const BOT_USERNAME = process.env.BOT_USERNAME || 'forma2ko5_bot';
const MAX_GROUPS = 10;       // в скольких группах может состоять человек
const MAX_MEMBERS = 150;     // сколько людей в одной группе

function groupLink(code) { return `https://t.me/${BOT_USERNAME}?start=g_${code}`; }

async function myMembership(groupId, meId) {
  const r = await query(
    `SELECT g.*, m.role FROM groups g JOIN group_members m ON m.group_id = g.id
     WHERE g.id = $1 AND m.user_id = $2`, [groupId, meId]);
  return r.rows[0] || null;
}

// Начало текущей недели (понедельник) по дате клиента
function weekStart(req) {
  const raw = String(req.headers['x-client-date'] || '');
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(raw + 'T00:00:00Z') : new Date();
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// GET /api/friends/invite — моя ссылка-приглашение и сколько друзей пришло
router.get('/invite', async (req, res) => {
  const stats = await referralStats(req.me.id);
  res.json({
    link: `https://t.me/${BOT_USERNAME}?start=r_${refCode(req.me.id)}`,
    ...stats, min_workouts: REF_MIN_WORKOUTS, max_bonus: REF_MAX_BONUS,
  });
});

// GET /api/friends/groups — мои группы
router.get('/groups', async (req, res) => {
  await socialReady;
  const r = await query(
    `SELECT g.id, g.name, g.coach_mode, g.invite_code, g.owner_id = $1 AS is_owner, m.role,
       (SELECT count(*)::int FROM group_members x WHERE x.group_id = g.id) AS members
     FROM groups g JOIN group_members m ON m.group_id = g.id AND m.user_id = $1
     ORDER BY m.joined_at`, [req.me.id]);
  res.json({ groups: r.rows.map((g) => ({ ...g, link: groupLink(g.invite_code) })) });
});

// POST /api/friends/groups { name, coach_mode } — создать группу
router.post('/groups', async (req, res) => {
  await socialReady;
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (name.length < 2) return res.status(400).json({ error: 'Придумай название группы' });
  const cnt = await query('SELECT count(*)::int AS n FROM group_members WHERE user_id = $1', [req.me.id]);
  if (cnt.rows[0].n >= MAX_GROUPS) return res.status(400).json({ error: `Можно состоять максимум в ${MAX_GROUPS} группах` });
  let g = null;
  for (let i = 0; i < 5 && !g; i++) {
    const r = await query(
      `INSERT INTO groups (name, owner_id, coach_mode, invite_code) VALUES ($1, $2, $3, $4)
       ON CONFLICT (invite_code) DO NOTHING RETURNING *`,
      [name, req.me.id, !!req.body.coach_mode, newGroupCode()]);
    g = r.rows[0];
  }
  if (!g) return res.status(500).json({ error: 'Не удалось создать группу' });
  await query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)`,
    [g.id, req.me.id, g.coach_mode ? 'coach' : 'owner']);
  res.json({ group: { id: g.id, name: g.name, coach_mode: g.coach_mode, invite_code: g.invite_code, link: groupLink(g.invite_code) } });
});

// GET /api/friends/groups/preview/:code — что за группа (перед вступлением)
router.get('/groups/preview/:code', async (req, res) => {
  await socialReady;
  const code = String(req.params.code || '').toLowerCase();
  const r = await query(
    `SELECT g.id, g.name, g.coach_mode, u.first_name AS owner_first_name, u.last_name AS owner_last_name, u.username AS owner_username,
       (SELECT count(*)::int FROM group_members x WHERE x.group_id = g.id) AS members,
       EXISTS (SELECT 1 FROM group_members x WHERE x.group_id = g.id AND x.user_id = $2) AS joined
     FROM groups g JOIN users u ON u.id = g.owner_id WHERE g.invite_code = $1`, [code, req.me.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Группа не найдена — проверь код' });
  res.json({ group: r.rows[0] });
});

// POST /api/friends/groups/join { code }
router.post('/groups/join', async (req, res) => {
  await socialReady;
  const code = String(req.body.code || '').trim().toLowerCase();
  const g = (await query('SELECT * FROM groups WHERE invite_code = $1', [code])).rows[0];
  if (!g) return res.status(404).json({ error: 'Группа не найдена — проверь код' });
  const cnt = await query(
    `SELECT (SELECT count(*)::int FROM group_members WHERE group_id = $1) AS members,
            (SELECT count(*)::int FROM group_members WHERE user_id = $2) AS mine`, [g.id, req.me.id]);
  if (cnt.rows[0].members >= MAX_MEMBERS) return res.status(400).json({ error: 'В группе уже максимум участников' });
  if (cnt.rows[0].mine >= MAX_GROUPS) return res.status(400).json({ error: `Можно состоять максимум в ${MAX_GROUPS} группах` });
  const ins = await query(
    `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')
     ON CONFLICT (group_id, user_id) DO NOTHING RETURNING user_id`, [g.id, req.me.id]);
  if (ins.rows.length) {
    const owner = await query('SELECT telegram_id FROM users WHERE id = $1', [g.owner_id]);
    notify(owner.rows[0]?.telegram_id, `👥 ${displayName(req.me)} вступил в группу «${g.name}»`);
  }
  res.json({ group: { id: g.id, name: g.name, coach_mode: g.coach_mode } });
});

// GET /api/friends/groups/:id — участники, рейтинг недели
router.get('/groups/:id', async (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const g = gid && (await myMembership(gid, req.me.id));
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  const monday = weekStart(req);
  const members = await query(
    `SELECT ${PUBLIC_USER}, m.role,
       (SELECT count(*)::int FROM workouts w WHERE w.user_id = u.id AND w.type = 'training' AND w.date >= $2::date) AS week_trainings,
       (SELECT COALESCE(round(sum(COALESCE(s.distance_m, 0) * COALESCE(s.reps, 1)) / 1000.0, 1), 0)::float
          FROM workout_sets s JOIN workouts w ON w.id = s.workout_id
          WHERE w.user_id = u.id AND w.date >= $2::date) AS week_km,
       (SELECT to_char(max(w.date), 'YYYY-MM-DD') FROM workouts w WHERE w.user_id = u.id) AS last_entry
     FROM group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1
     ORDER BY week_trainings DESC, week_km DESC, u.current_streak DESC`, [gid, monday]);
  const isCoach = g.coach_mode && g.owner_id === req.me.id;
  res.json({
    group: {
      id: g.id, name: g.name, coach_mode: g.coach_mode, is_owner: g.owner_id === req.me.id, is_coach: isCoach,
      invite_code: g.invite_code, link: groupLink(g.invite_code),
    },
    members: members.rows,
  });
});

// GET /api/friends/groups/:id/feed — лента группы: открытые тренировки участников (тренеру — все)
router.get('/groups/:id/feed', async (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const g = gid && (await myMembership(gid, req.me.id));
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  const isCoach = g.coach_mode && g.owner_id === req.me.id;
  const r = await query(
    `${WORKOUT_SELECT}
     WHERE w.user_id IN (SELECT user_id FROM group_members WHERE group_id = $1)
       AND (w.visibility = 'public' OR w.user_id = $2 OR $3)
       AND w.date > CURRENT_DATE - 30
     ORDER BY w.date DESC, w.id DESC LIMIT 40`, [gid, req.me.id, isCoach]);
  res.json({ workouts: await withSocial(r.rows, req.me.id) });
});

// GET /api/friends/groups/:id/members/:uid — тренер смотрит дневник спортсмена целиком
router.get('/groups/:id/members/:uid', async (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const uid = parseInt(req.params.uid, 10);
  const g = gid && (await myMembership(gid, req.me.id));
  if (!g || !g.coach_mode || g.owner_id !== req.me.id) return res.status(403).json({ error: 'Только для тренера группы' });
  const inGroup = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [gid, uid]);
  if (!inGroup.rows.length) return res.status(404).json({ error: 'Спортсмен не в группе' });
  const [user, workouts, checks] = await Promise.all([
    query(`SELECT ${PUBLIC_USER} FROM users u WHERE u.id = $1`, [uid]),
    query(`${WORKOUT_SELECT} WHERE w.user_id = $1 ORDER BY w.date DESC, w.session LIMIT 40`, [uid]),
    query(`SELECT to_char(date, 'YYYY-MM-DD') AS date, sleep_h, rest_hr, mood FROM morning_checks
           WHERE user_id = $1 AND date > CURRENT_DATE - 7 ORDER BY date DESC`, [uid]).catch(() => ({ rows: [] })),
  ]);
  res.json({
    user: user.rows[0],
    workouts: await withSocial(workouts.rows, req.me.id),
    checks: checks.rows.map((c) => ({ ...c, sleep_h: c.sleep_h == null ? null : Number(c.sleep_h) })),
  });
});

// POST /api/friends/groups/:id/leave — выйти из группы (создатель удаляет группу целиком)
router.post('/groups/:id/leave', async (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const g = gid && (await myMembership(gid, req.me.id));
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  if (g.owner_id === req.me.id) {
    await query('DELETE FROM groups WHERE id = $1 AND owner_id = $2', [gid, req.me.id]);
    return res.json({ ok: true, deleted: true });
  }
  await query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [gid, req.me.id]);
  res.json({ ok: true });
});

// POST /api/friends/groups/:id/remove { userId } — создатель убирает участника
router.post('/groups/:id/remove', async (req, res) => {
  const gid = parseInt(req.params.id, 10);
  const uid = parseInt(req.body.userId, 10);
  const g = gid && (await myMembership(gid, req.me.id));
  if (!g || g.owner_id !== req.me.id) return res.status(403).json({ error: 'Только создатель группы' });
  if (uid === req.me.id) return res.status(400).json({ error: 'Себя убрать нельзя' });
  await query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [gid, uid]);
  res.json({ ok: true });
});

// ===================================================================
//  ПРОФИЛЬ ДРУГА
//  GET /api/friends/:friendId/profile — фото, серия, календарь и открытые тренировки
// ===================================================================
router.get('/:friendId/profile', async (req, res) => {
  const friendId = parseInt(req.params.friendId, 10);
  if (!friendId) return res.status(400).json({ error: 'Неверный id' });
  if (!(await areFriends(req.me.id, friendId))) return res.status(403).json({ error: 'Вы пока не друзья' });

  const userRes = await query(`SELECT ${PUBLIC_USER}, u.share_calendar FROM users u WHERE u.id = $1`, [friendId]);
  const user = userRes.rows[0];
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const [stats, days, workouts] = await Promise.all([
    query(
      `SELECT count(*) FILTER (WHERE type = 'training')::int AS total,
              count(*) FILTER (WHERE type = 'training' AND date > CURRENT_DATE - 30)::int AS last30,
              (SELECT count(*)::int FROM friendships
                WHERE status = 'accepted' AND (user_id = $1 OR friend_id = $1)) AS friends
       FROM workouts WHERE user_id = $1`,
      [friendId]
    ),
    // Календарь: если человек разрешил — все его дни (без подробностей закрытых), иначе только открытые
    query(
      `SELECT date, type, visibility = 'public' AS public, id FROM workouts
       WHERE user_id = $1 AND date > CURRENT_DATE - 400 AND ($2 OR visibility = 'public')
       ORDER BY date`,
      [friendId, user.share_calendar !== false || friendId === req.me.id]
    ),
    query(`${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.visibility = 'public' ORDER BY w.date DESC LIMIT 30`, [
      friendId,
    ]),
  ]);

  res.json({
    user,
    stats: stats.rows[0],
    days: days.rows.map((d) => ({ date: d.date, type: d.type, public: d.public, id: d.public ? d.id : null })),
    workouts: await withSocial(workouts.rows, req.me.id),
  });
});

// GET /api/friends/:friendId/workouts — только открытые записи друга (оставлено для совместимости)
router.get('/:friendId/workouts', async (req, res) => {
  if (!(await areFriends(req.me.id, req.params.friendId))) return res.status(403).json({ error: 'Вы пока не друзья' });
  const result = await query(
    `${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.visibility = 'public' ORDER BY w.date DESC LIMIT 30`,
    [parseInt(req.params.friendId, 10)]
  );
  res.json({ workouts: await withSocial(result.rows, req.me.id) });
});

// DELETE /api/friends/:friendId — удалить из друзей
router.delete('/:friendId', async (req, res) => {
  if (!parseInt(req.params.friendId, 10)) return res.status(400).json({ error: 'Неверный id' });
  await query(
    `DELETE FROM friendships WHERE status = 'accepted'
       AND ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))`,
    [req.me.id, req.params.friendId]
  );
  res.json({ ok: true });
});

export default router;
