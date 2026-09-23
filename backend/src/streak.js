import { query } from './db.js';

/**
 * Пересчитывает streak пользователя после того, как он сохранил
 * запись (тренировку ИЛИ осознанный отдых) за какую-то дату.
 * Streak = число дней подряд с записью, включая сегодня.
 */
export async function recalcStreak(userId, workoutDate) {
  const userRes = await query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = userRes.rows[0];
  if (!user) return;

  const newDate = new Date(workoutDate);
  const lastDate = user.last_active_date ? new Date(user.last_active_date) : null;

  let newStreak = user.current_streak;

  if (!lastDate) {
    newStreak = 1;
  } else {
    const diffDays = Math.round((newDate - lastDate) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      // запись за уже отмеченный день — стрик не меняется
    } else if (diffDays === 1) {
      newStreak = user.current_streak + 1;
    } else if (diffDays > 1) {
      // пропуск дня(ей) без записи — серия обнуляется и начинается заново
      newStreak = 1;
    }
    // diffDays < 0 (запись задним числом раньше last_active_date) — стрик не трогаем
  }

  const longest = Math.max(newStreak, user.longest_streak);
  const newLastActive = !lastDate || newDate > lastDate ? workoutDate : user.last_active_date;

  await query(
    `UPDATE users SET current_streak = $1, longest_streak = $2, last_active_date = $3 WHERE id = $4`,
    [newStreak, longest, newLastActive, userId]
  );
}
