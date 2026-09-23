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

// Автоматическое обновление базы при запуске сервера — ничего не нужно делать руками в Supabase.
// IF NOT EXISTS: если поле уже есть, команда просто ничего не сделает.
pool
  .query(
    `ALTER TABLE workouts
       ADD COLUMN IF NOT EXISTS hr_avg INT,
       ADD COLUMN IF NOT EXISTS hr_max INT,
       ADD COLUMN IF NOT EXISTS hr_min INT`
  )
  .then(() => console.log('DB schema OK (пульс)'))
  .catch((err) => console.error('DB migration failed:', err.message));
