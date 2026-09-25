import { query, dbReady } from './db.js';

/**
 * Группы (команды и тренерские) и приглашения друзей.
 *
 *  Группа-команда: участники видят открытые тренировки друг друга в общей ленте и рейтинг недели.
 *  Тренерская группа: тренер (создатель) дополнительно видит ВСЕ записи участников — и закрытые тоже,
 *  может ставить реакции и комментировать. Об этом спортсмен предупреждён при вступлении и может выйти.
 *
 *  Приглашения: у каждого своя ссылка t.me/<бот>?start=r_<код>. Кто пришёл по ней — сразу в друзьях.
 *  Когда приглашённый запишет 3 тренировки, пригласивший получает +1 билет в недельный розыгрыш (максимум +3).
 */

export const socialReady = (async () => {
  await dbReady;
  try {
    await query(`CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id INT REFERENCES users(id) ON DELETE CASCADE,
      coach_mode BOOLEAN NOT NULL DEFAULT FALSE,
      invite_code TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS group_members (
      group_id INT REFERENCES groups(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (group_id, user_id)
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id)`);
    await query(`CREATE TABLE IF NOT EXISTS referrals (
      invitee_tg BIGINT PRIMARY KEY,
      inviter_id INT REFERENCES users(id) ON DELETE CASCADE,
      invitee_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_referrals_inviter ON referrals(inviter_id)`);
    await query(`DO $$
      DECLARE t text;
      BEGIN
        FOREACH t IN ARRAY ARRAY['groups', 'group_members', 'referrals'] LOOP
          IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = t AND tableowner = current_user) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
          END IF;
        END LOOP;
      END $$`);
  } catch (err) {
    console.error('Social tables failed:', err.message);
  }
})();

// ---------- Коды ----------
// Код приглашения человека: его номер в базе в «коротком» виде (буквы и цифры)
export function refCode(userId) {
  return (Number(userId) * 7 + 1000).toString(36);
}
function refCodeToId(code) {
  const n = parseInt(String(code || ''), 36);
  if (!Number.isFinite(n) || (n - 1000) % 7 !== 0) return null;
  const id = (n - 1000) / 7;
  return id > 0 ? id : null;
}
// Код группы: 6 символов без похожих букв (0/O, 1/l)
export function newGroupCode() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

// ---------- Тренер ----------
// Тренер ли coachId для спортсмена athleteId (есть общая тренерская группа, где coachId — создатель)
export async function isCoachOf(coachId, athleteId) {
  if (!coachId || !athleteId || coachId === athleteId) return false;
  await socialReady;
  const r = await query(
    `SELECT 1 FROM groups g JOIN group_members m ON m.group_id = g.id
     WHERE g.coach_mode AND g.owner_id = $1 AND m.user_id = $2 LIMIT 1`,
    [coachId, athleteId]
  );
  return r.rows.length > 0;
}

// В одной группе ли два человека (тогда открытые тренировки друг друга видны и без дружбы)
export async function shareGroup(a, b) {
  if (!a || !b) return false;
  await socialReady;
  const r = await query(
    `SELECT 1 FROM group_members x JOIN group_members y ON y.group_id = x.group_id
     WHERE x.user_id = $1 AND y.user_id = $2 LIMIT 1`, [a, b]);
  return r.rows.length > 0;
}

// ---------- Приглашения ----------
// Человек открыл бота по ссылке-приглашению (ещё может не быть в базе)
export async function rememberReferral(inviteeTg, payload) {
  const m = /^r_([a-z0-9]+)$/i.exec(String(payload || ''));
  if (!m) return false;
  const inviterId = refCodeToId(m[1].toLowerCase());
  if (!inviterId) return false;
  await socialReady;
  const inviter = await query('SELECT id, telegram_id FROM users WHERE id = $1', [inviterId]);
  if (!inviter.rows[0] || String(inviter.rows[0].telegram_id) === String(inviteeTg)) return false;
  // уже пользуется Forma — это не новый человек
  const existing = await query('SELECT id FROM users WHERE telegram_id = $1', [inviteeTg]);
  if (existing.rows[0]) return false;
  await query(
    `INSERT INTO referrals (invitee_tg, inviter_id) VALUES ($1, $2) ON CONFLICT (invitee_tg) DO NOTHING`,
    [inviteeTg, inviterId]
  );
  return true;
}

// При входе в приложение: если человек пришёл по приглашению — сразу дружим с пригласившим.
// Возвращает пригласившего (чтобы уведомить его), либо null.
export async function settleReferral(user) {
  await socialReady;
  const r = await query(
    `UPDATE referrals SET invitee_id = $1 WHERE invitee_tg = $2 AND invitee_id IS NULL RETURNING inviter_id`,
    [user.id, user.telegram_id]
  );
  const inviterId = r.rows[0]?.inviter_id;
  if (!inviterId || inviterId === user.id) return null;
  const exists = await query(
    `SELECT 1 FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
    [inviterId, user.id]
  );
  if (!exists.rows.length) {
    await query(`INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'accepted')`, [inviterId, user.id]);
  }
  const inv = await query('SELECT id, telegram_id, first_name FROM users WHERE id = $1', [inviterId]);
  return inv.rows[0] || null;
}

export const REF_MIN_WORKOUTS = 3;
export const REF_MAX_BONUS = 3;

// Сколько друзей пришло по приглашению и сколько из них уже «засчитаны» (3+ записи)
export async function referralStats(userId) {
  await socialReady;
  const r = await query(
    `SELECT count(*)::int AS invited,
       count(*) FILTER (WHERE (SELECT count(*) FROM workouts w WHERE w.user_id = r.invitee_id) >= $2)::int AS qualified
     FROM referrals r WHERE r.inviter_id = $1 AND r.invitee_id IS NOT NULL`,
    [userId, REF_MIN_WORKOUTS]
  );
  const { invited, qualified } = r.rows[0] || { invited: 0, qualified: 0 };
  return { invited, qualified, bonus: Math.min(REF_MAX_BONUS, qualified) };
}

// Бонусные билеты всем сразу (для розыгрыша): { userId: bonus }
export async function referralBonuses() {
  await socialReady;
  const r = await query(
    `SELECT r.inviter_id AS id, count(*)::int AS n FROM referrals r
     WHERE r.invitee_id IS NOT NULL
       AND (SELECT count(*) FROM workouts w WHERE w.user_id = r.invitee_id) >= $1
     GROUP BY r.inviter_id`,
    [REF_MIN_WORKOUTS]
  );
  return Object.fromEntries(r.rows.map((x) => [x.id, Math.min(REF_MAX_BONUS, x.n)]));
}
