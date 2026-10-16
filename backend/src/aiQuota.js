import { query, dbReady } from './db.js';
import { isAdmin } from './giveaway.js';

/**
 * Дневные лимиты на вызовы ИИ — чтобы один человек не мог «сжечь» ваш бюджет на API.
 *
 * Считаем в базе (таблица ai_usage), поэтому перезапуск сервера счётчик не обнуляет.
 * День — по Москве. Админ (ADMIN_TELEGRAM_ID) — без лимитов. Если ИИ не ответил (ошибка 5xx),
 * попытка возвращается: человек не платит лимитом за чужой сбой.
 *
 * Лимиты можно менять переменными окружения Railway, например AI_LIMIT_PARSE=30.
 * Чат с Fom (7 в день) считается отдельно, в chat.js, — его не трогаем.
 */
const num = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 0 ? n : def; };

export const AI_LIMITS = {
  parse: num('AI_LIMIT_PARSE', 20),          // умный ввод: Fom раскладывает текст по полям
  feedback: num('AI_LIMIT_FEEDBACK', 30),    // отзыв Fom о тренировке (при сохранении, правке и по кнопке «Обновить»)
  insights: num('AI_LIMIT_INSIGHTS', 5),     // разбор нагрузки за неделю/месяц
  health: num('AI_LIMIT_HEALTH', 10),        // комментарий Fom к анализу крови и к питанию за день
  coach: num('AI_LIMIT_COACH', 40),          // кабинет тренера: вывод по спортсмену и сводка группы
  scan_blood: num('AI_LIMIT_SCAN_BLOOD', 6), // распознавание бланка анализа
  scan_food: num('AI_LIMIT_SCAN_FOOD', 25),  // распознавание еды по фото
};

export const QUOTA_MESSAGES = {
  parse: 'На сегодня умный ввод закончился — заполни запись вручную или попробуй завтра 🙂',
  feedback: 'На сегодня отзывы Fom закончились — завтра он напишет снова 🙂',
  insights: 'На сегодня разборов нагрузки хватит — загляни завтра 🙂',
  health: 'На сегодня комментарии Fom к анализам и питанию закончились — попробуй завтра 🙂',
  coach: 'На сегодня запросы Fom для тренера закончились — попробуй завтра 🙂',
  scan_blood: 'На сегодня распознаваний бланков хватит — внеси показатели вручную',
  scan_food: 'На сегодня распознаваний хватит — впиши цифры вручную',
};

const ready = (async () => {
  await dbReady;
  try {
    await query(`CREATE TABLE IF NOT EXISTS ai_usage (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      kind TEXT NOT NULL,
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, kind)
    )`);
    await query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'ai_usage' AND tableowner = current_user) THEN
        ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
      END IF; END $$`);
    await query(`DELETE FROM ai_usage WHERE day < CURRENT_DATE - 30`); // старые счётчики не копим
  } catch (err) {
    console.error('AI usage table failed:', err.message);
  }
})();

// День лимита — по Москве (подкрутить дату в телефоне нельзя)
function mskToday() {
  return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
}

async function isAdminUser(userId) {
  const r = await query('SELECT telegram_id FROM users WHERE id = $1', [userId]);
  return r.rows[0] ? !!(await isAdmin(r.rows[0].telegram_id)) : false;
}

/**
 * «Занять» одну попытку. Возвращает { ok, used, limit }.
 * Атомарно: сколько бы запросов ни пришло одновременно, больше лимита не пройдёт.
 */
export async function takeQuota(userId, kind) {
  const limit = AI_LIMITS[kind];
  if (limit === undefined) throw new Error(`Неизвестный лимит ИИ: ${kind}`);
  await ready;
  if (await isAdminUser(userId)) return { ok: true, used: 0, limit: null };
  if (limit <= 0) return { ok: false, used: 0, limit };
  const r = await query(
    `INSERT INTO ai_usage (user_id, day, kind, count) VALUES ($1, $2::date, $3, 1)
     ON CONFLICT (user_id, day, kind) DO UPDATE SET count = ai_usage.count + 1
     WHERE ai_usage.count < $4
     RETURNING count`,
    [userId, mskToday(), kind, limit]
  );
  return r.rows.length ? { ok: true, used: r.rows[0].count, limit } : { ok: false, used: limit, limit };
}

// Вернуть попытку (ИИ не ответил по нашей/чужой вине — человек не должен за это платить лимитом)
export async function refundQuota(userId, kind) {
  await ready;
  await query(
    `UPDATE ai_usage SET count = GREATEST(0, count - 1) WHERE user_id = $1 AND day = $2::date AND kind = $3`,
    [userId, mskToday(), kind]
  );
}

// Сколько уже потрачено сегодня (без списания)
export async function usedToday(userId, kind) {
  await ready;
  const r = await query('SELECT count FROM ai_usage WHERE user_id = $1 AND day = $2::date AND kind = $3', [userId, mskToday(), kind]);
  return r.rows[0]?.count || 0;
}

/**
 * Express-middleware: ставится ПЕРЕД обработчиком, после requireTelegramAuth.
 * Если лимит исчерпан — ответ 429 с понятным текстом (приложение показывает его как есть).
 * consume: false — только проверить, не списывая (для маршрутов, где списание идёт внутри).
 * Если обработчик ответил ошибкой 5xx, попытка возвращается.
 */
export function aiQuota(kind, { consume = true } = {}) {
  return async (req, res, next) => {
    try {
      const u = await query('SELECT id FROM users WHERE telegram_id = $1', [req.telegramUser.id]);
      const uid = u.rows[0]?.id;
      if (!uid) return next(); // обработчик сам ответит «User not found»
      if (consume) {
        const q = await takeQuota(uid, kind);
        if (!q.ok) return res.status(429).json({ error: QUOTA_MESSAGES[kind], left: 0 });
        if (q.limit !== null) res.on('finish', () => { if (res.statusCode >= 500) refundQuota(uid, kind).catch(() => {}); });
      } else if (!(await isAdminUser(uid)) && (await usedToday(uid, kind)) >= AI_LIMITS[kind]) {
        return res.status(429).json({ error: QUOTA_MESSAGES[kind], left: 0 });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
