import { query } from './db.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Приводим дату из базы к строке 'ГГГГ-ММ-ДД' (на случай, если придёт объект Date)
function toDateStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// Сколько дней от даты a до даты b (обе в формате 'ГГГГ-ММ-ДД')
export function daysBetween(a, b) {
  const ms = Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z');
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

// Проверка, что строка — настоящая дата (отсекает '2026-02-30' и мусор)
export function isValidDate(str) {
  if (typeof str !== 'string' || !DATE_RE.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === str;
}

function serverToday() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * «Сегодня» по часам пользователя. Фронт присылает свою дату в заголовке X-Client-Date,
 * чтобы у спортсмена из Москвы в 01:00 «сегодня» не считалось вчерашним днём (сервер живёт по UTC).
 * Если заголовка нет или дата странная — берём дату сервера.
 */
export function getClientToday(req) {
  const d = req.headers['x-client-date'];
  if (isValidDate(d) && Math.abs(daysBetween(serverToday(), d)) <= 2) return d;
  return serverToday();
}

/**
 * Полностью пересчитывает серию по всем записям пользователя.
 * Раньше серия считалась «по шагам» и не умела учитывать записи задним числом —
 * теперь, когда есть календарь, считаем честно с нуля:
 *  - лучшая серия = самый длинный отрезок дней подряд с записью (тренировка или отдых);
 *  - текущая серия = отрезок, который заканчивается сегодня или вчера
 *    (если вчера была запись, а сегодня ещё нет — серия пока жива).
 */
export async function recalcStreak(userId, today = serverToday()) {
  const res = await query(
    'SELECT DISTINCT date FROM workouts WHERE user_id = $1 ORDER BY date ASC',
    [userId]
  );
  const dates = res.rows.map((r) => toDateStr(r.date));

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of dates) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }

  const last = dates[dates.length - 1] || null;
  const current = last && daysBetween(last, today) <= 1 ? run : 0;

  await query(
    `UPDATE users SET current_streak = $1, longest_streak = $2, last_active_date = $3 WHERE id = $4`,
    [current, longest, last, userId]
  );

  return { current, longest };
}
