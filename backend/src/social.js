import crypto from 'crypto';
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
    // «Выбрать друзей»: кому открыта конкретная тренировка (visibility = 'custom')
    await query(`CREATE TABLE IF NOT EXISTS workout_visible_to (
      workout_id INT REFERENCES workouts(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (workout_id, user_id)
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_visible_to_user ON workout_visible_to(user_id)`);
    // Личные рекорды, внесённые вручную (без записи старта в дневнике)
    await query(`CREATE TABLE IF NOT EXISTS manual_records (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      discipline TEXT NOT NULL,
      result TEXT NOT NULL,
      date DATE,
      note TEXT,
      created_at TIMESTAMP DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_manual_records_user ON manual_records(user_id)`);
    // Цели на месяц: объём, число тренировок, рекорд, вес, своя
    await query(`CREATE TABLE IF NOT EXISTS goals (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      discipline TEXT,
      target TEXT,
      target_num NUMERIC,
      start_num NUMERIC,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_goals_user_month ON goals(user_id, month)`);
    // Вес по датам — чтобы видеть, как идёт цель «похудеть / набрать массу»
    await query(`CREATE TABLE IF NOT EXISTS weight_log (
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      kg NUMERIC NOT NULL,
      PRIMARY KEY (user_id, date)
    )`);
    // видят ли друзья блок «Личные рекорды» в профиле (по умолчанию — да, выключается в «Приватности»)
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS show_records BOOLEAN DEFAULT TRUE`);
    // случайный код приглашения человека (раньше код считался из номера в базе и легко угадывался)
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_token TEXT`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_ref_token_uq ON users(ref_token)`);
    await query(`DO $$
      DECLARE t text;
      BEGIN
        FOREACH t IN ARRAY ARRAY['groups', 'group_members', 'referrals', 'workout_visible_to', 'manual_records', 'goals', 'weight_log'] LOOP
          IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = t AND tableowner = current_user) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
          END IF;
        END LOOP;
      END $$`);
  } catch (err) {
    console.error('Social tables failed:', err.message);
  }
  // Видимость записи теперь бывает ещё и 'custom' (выбранные друзья) — расширяем проверку в базе
  try {
    await query(`DO $$ BEGIN
      ALTER TABLE workouts DROP CONSTRAINT IF EXISTS workouts_visibility_check;
      ALTER TABLE workouts ADD CONSTRAINT workouts_visibility_check CHECK (visibility IN ('private', 'public', 'custom'));
    END $$`);
  } catch (err) {
    console.error('Visibility check update failed:', err.message);
  }
})();

// ---------- Коды ----------
// Код приглашения человека: случайные 16 символов (0-9, a-f), хранятся в users.ref_token.
// Раньше код считался по формуле из номера в базе — по любой ссылке можно было вычислить
// код любого человека и «подружиться» с ним без подтверждения.
// Старые ссылки-приглашения перестают работать (ищем только по новому коду).
export async function getRefCode(userId) {
  await socialReady;
  const cur = await query('SELECT ref_token FROM users WHERE id = $1', [userId]);
  if (cur.rows[0]?.ref_token) return cur.rows[0].ref_token;
  for (let i = 0; i < 5; i++) {
    const token = crypto.randomBytes(8).toString('hex');
    try {
      const r = await query(
        'UPDATE users SET ref_token = $1 WHERE id = $2 AND ref_token IS NULL RETURNING ref_token', [token, userId]);
      if (r.rows[0]) return r.rows[0].ref_token;
      // кто-то успел раньше (два запроса одновременно) — берём уже записанный
      const again = await query('SELECT ref_token FROM users WHERE id = $1', [userId]);
      if (again.rows[0]?.ref_token) return again.rows[0].ref_token;
    } catch (err) {
      if (err.code !== '23505') throw err; // 23505 — такой код уже занят, пробуем другой
    }
  }
  throw new Error('Не удалось создать код приглашения');
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
  const m = /^r_([a-f0-9]{16})$/i.exec(String(payload || ''));
  if (!m) return false;
  await socialReady;
  const inviter = await query('SELECT id, telegram_id FROM users WHERE ref_token = $1', [m[1].toLowerCase()]);
  if (!inviter.rows[0] || String(inviter.rows[0].telegram_id) === String(inviteeTg)) return false;
  const inviterId = inviter.rows[0].id;
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

// ---------- Кому видна тренировка ----------
// SQL-условие «человек с id из параметра meParam может видеть эту чужую тренировку w»:
// открыта всем друзьям, или открыта именно ему через «Выбрать друзей».
export function visibleToSql(meParam) {
  return `(w.visibility = 'public' OR (w.visibility = 'custom' AND EXISTS (
    SELECT 1 FROM workout_visible_to vt WHERE vt.workout_id = w.id AND vt.user_id = ${meParam})))`;
}
export async function canSeeCustom(meId, workoutId) {
  await socialReady;
  const r = await query('SELECT 1 FROM workout_visible_to WHERE workout_id = $1 AND user_id = $2', [workoutId, meId]);
  return r.rows.length > 0;
}

// ---------- Рекорды, внесённые вручную ----------
// Возвращаем их в том же виде, что и записи-старты, — чтобы считать лучший результат одной функцией.
// Рекорд без даты считаем «давним» (1900-01-01): он был до всех стартов в дневнике.
export async function manualRecordsAsStarts(userIds) {
  if (!userIds.length) return {};
  await socialReady;
  const r = await query(
    `SELECT id, user_id, discipline, result, note, to_char(date, 'YYYY-MM-DD') AS date FROM manual_records
     WHERE user_id = ANY($1::int[])`, [userIds]);
  const by = {};
  r.rows.forEach((x) => {
    (by[x.user_id] ||= []).push({
      id: `m${x.id}`, manual_id: x.id, date: x.date || '1900-01-01', manual: true,
      competition: { discipline: x.discipline, result: x.result, name: x.note || null },
    });
  });
  return by;
}

// ---------- Первопроходцы: первые 10 пользователей Forma ----------
export const PIONEERS = 10;
// Номер человека среди первых десяти (1–10) или null
export async function pioneerNo(userId) {
  if (!userId) return null;
  const r = await query('SELECT count(*)::int AS n FROM users WHERE id <= $1', [userId]);
  const n = r.rows[0]?.n || 0;
  return n > 0 && n <= PIONEERS ? n : null;
}
