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
});

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
  // своё фото профиля (картинка, сжатая на телефоне)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data TEXT`,
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
