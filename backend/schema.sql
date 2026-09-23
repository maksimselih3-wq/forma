-- ==============================
-- Тренировочный дневник — схема БД
-- ==============================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  photo_url TEXT,
  current_streak INT DEFAULT 0,
  longest_streak INT DEFAULT 0,
  last_active_date DATE,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS friendships (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  friend_id INT REFERENCES users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending', -- 'pending' | 'accepted'
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS workouts (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('training', 'rest')),
  warmup TEXT,
  cooldown TEXT,
  feeling INT CHECK (feeling BETWEEN 1 AND 10),
  rpe INT CHECK (rpe BETWEEN 1 AND 10),
  notes TEXT,
  visibility TEXT DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  ai_feedback TEXT,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(user_id, date) -- одна запись в день (тренировка или отдых)
);

CREATE TABLE IF NOT EXISTS workout_sets (
  id SERIAL PRIMARY KEY,
  workout_id INT REFERENCES workouts(id) ON DELETE CASCADE,
  order_index INT DEFAULT 0,
  distance_m INT,
  reps INT,
  time_or_pace TEXT,
  rest_between TEXT
);

CREATE TABLE IF NOT EXISTS personal_records (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  distance_m INT NOT NULL,
  result_time TEXT NOT NULL,
  date DATE NOT NULL,
  workout_id INT REFERENCES workouts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date);
CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
