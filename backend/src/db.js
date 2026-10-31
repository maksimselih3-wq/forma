import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool, types } = pg;

// Тип DATE в Postgres (код 1082) отдаём как есть — строкой 'ГГГГ-ММ-ДД'.
// Без этого pg превращает дату в объект Date с часовым поясом сервера,
// и на фронт приходит что-то вроде '2026-09-21T00:00:00.000Z'.
types.setTypeParser(1082, (val) => val);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : false,
  // Пулер Supabase в режиме сессий пускает всего 15 подключений на всех. При обновлении на Railway старая и новая
  // версии работают вместе — по 10 подключений у каждой не помещались (ошибка EMAXCONNSESSION). Берём меньше.
  max: Number(process.env.PG_POOL_MAX) || 5,
  idleTimeoutMillis: 20000,
});

// Если у Supabase кончились места в пуле (EMAXCONNSESSION — бывает на пару секунд при обновлении сервера, пока
// старая версия ещё не закрыла свои подключения), не падаем сразу, а ждём и пробуем снова.
const isBusy = (e) => /EMAXCONNSESSION|max clients reached|too many clients/i.test(String(e?.message || e));
const origConnect = pool.connect.bind(pool);
pool.connect = async (...args) => {
  if (typeof args[0] === 'function') return origConnect(...args);
  for (let i = 0; ; i++) {
    try { return await origConnect(); }
    catch (e) {
      if (!isBusy(e) || i >= 8) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 + i * 1000));
    }
  }
};

export async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Запись тренировки целиком: сама запись + беговые повторы (sets) + упражнения силовой/ОФП (exercises).
 * Используется везде, где нужно достать тренировки. После него пишем WHERE ... ORDER BY ...
 */
export const WORKOUT_SELECT = `
  SELECT w.*,
    COALESCE((SELECT json_agg(s.* ORDER BY s.order_index) FROM workout_sets s WHERE s.workout_id = w.id), '[]') AS sets,
    COALESCE((SELECT json_agg(e.* ORDER BY e.order_index) FROM workout_exercises e WHERE e.workout_id = w.id), '[]') AS exercises
  FROM workouts w`;

// Автоматическое обновление базы при запуске сервера — ничего не нужно делать руками в Supabase.
// IF NOT EXISTS: если поле/таблица уже есть, команда просто ничего не сделает.
const MIGRATIONS = [
  // пульс
  `ALTER TABLE workouts
     ADD COLUMN IF NOT EXISTS hr_avg INT,
     ADD COLUMN IF NOT EXISTS hr_max INT,
     ADD COLUMN IF NOT EXISTS hr_min INT`,
  // силовая / ОФП: упражнение, подходы, повторы, вес
  `CREATE TABLE IF NOT EXISTS workout_exercises (
     id SERIAL PRIMARY KEY,
     workout_id INT REFERENCES workouts(id) ON DELETE CASCADE,
     order_index INT DEFAULT 0,
     name TEXT,
     sets INT,
     reps TEXT,
     weight TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_exercises_workout ON workout_exercises(workout_id)`,
  // быстрый список записей: к каждой записи подтягиваются отрезки (иначе — перебор всей таблицы)
  `CREATE INDEX IF NOT EXISTS idx_sets_workout ON workout_sets(workout_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date DESC)`,
  // kind = 'tech' — попытки в прыжках и метаниях (техника), остальное — силовая/ОФП
  `ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS kind TEXT`,
  // своё фото профиля (картинка, сжатая на телефоне)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data TEXT`,
  // у дней отдыха оценок нет: убираем «5/10 по умолчанию», которые попадали в записи раньше
  `UPDATE workouts SET feeling = NULL, rpe = NULL WHERE type = 'rest' AND (feeling IS NOT NULL OR rpe IS NOT NULL)`,
  // версия фото считается один раз при записи, а не при каждом чтении списка друзей/ленты (раньше md5 по каждой картинке в каждом запросе)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_ver TEXT GENERATED ALWAYS AS (left(md5(avatar_data), 8)) STORED`,
  // друзья: видят ли они мой календарь целиком и когда я последний раз смотрел активность
  `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS share_calendar BOOLEAN DEFAULT true,
     ADD COLUMN IF NOT EXISTS activity_seen_at TIMESTAMP DEFAULT now()`,
  // реакции на тренировки (одна реакция от человека на запись)
  `CREATE TABLE IF NOT EXISTS workout_reactions (
     id SERIAL PRIMARY KEY,
     workout_id INT REFERENCES workouts(id) ON DELETE CASCADE,
     user_id INT REFERENCES users(id) ON DELETE CASCADE,
     emoji TEXT NOT NULL,
     created_at TIMESTAMP DEFAULT now(),
     UNIQUE (workout_id, user_id)
   )`,
  // комментарии к тренировкам
  `CREATE TABLE IF NOT EXISTS workout_comments (
     id SERIAL PRIMARY KEY,
     workout_id INT REFERENCES workouts(id) ON DELETE CASCADE,
     user_id INT REFERENCES users(id) ON DELETE CASCADE,
     text TEXT NOT NULL,
     created_at TIMESTAMP DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_comments_workout ON workout_comments(workout_id)`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id)`,
  // фамилия из Telegram — чтобы друзья видели имя полностью
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`,
  // вид спорта и дисциплина — отметка в профиле
  `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS sport TEXT,
     ADD COLUMN IF NOT EXISTS discipline TEXT`,
  // Защита базы: включаем RLS на всех таблицах, которыми владеет сервер.
  // Сервер как владелец таблиц работает как раньше, а вот через публичный API Supabase
  // (если ключ когда-нибудь утечёт) прочитать или изменить данные будет нельзя.
  `DO $$
   DECLARE t text;
   BEGIN
     FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user LOOP
       EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
     END LOOP;
   END $$`,
  // жалобы и блокировка пользователей
  `CREATE TABLE IF NOT EXISTS user_blocks (
     blocker INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     blocked INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (blocker, blocked)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked)`,
  `CREATE TABLE IF NOT EXISTS user_reports (
     id SERIAL PRIMARY KEY,
     reporter INT REFERENCES users(id) ON DELETE SET NULL,
     target_user INT REFERENCES users(id) ON DELETE SET NULL,
     kind TEXT NOT NULL,
     target_id INT,
     reason TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

// Если где-то в маршруте случится непредвиденная ошибка (например, мусор вместо id),
// сервер не должен падать целиком — пишем ошибку в лог и работаем дальше.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled error:', err?.message || err);
});

export const dbReady = (async () => {
  for (const sql of MIGRATIONS) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error('DB migration failed:', err.message);
    }
  }
  console.log('DB schema OK (пульс, ОФП, фото, друзья)');
})();
