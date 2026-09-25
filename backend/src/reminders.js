import { query, dbReady, WORKOUT_SELECT } from './db.js';
import { getWeeklyDigest, athleteContext } from './ai.js';

/**
 * Вечернее напоминание от бота.
 *
 * Каждый вечер в 21:00 по Москве бот пишет тем, у кого за сегодня ещё нет записи
 * (ни тренировки, ни дня отдыха). Если запись есть — молчит.
 *
 *  - Отключается в профиле приложения (переключатель «Напоминать вечером»).
 *  - Одному человеку — не больше одного напоминания в день.
 *  - Не пишем тем, кто давно забросил дневник (больше 14 дней без записей),
 *    чтобы бот не превращался в спам. Новичкам пишем первую неделю после регистрации.
 *  - Если человек заблокировал бота — выключаем ему напоминания.
 */

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
export const REMINDER_HOUR = Number(process.env.REMINDER_HOUR) || 21; // 21:00 по Москве
const LAST_HOUR = 23; // позже 23:00 уже не пишем (например, если сервер перезапускался)

function mskNow() {
  const d = new Date(Date.now() + MSK_OFFSET_MS);
  return { hour: d.getUTCHours(), dateStr: d.toISOString().slice(0, 10) };
}

function addDaysStr(str, n) {
  const d = new Date(str + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// «1 день», «3 дня», «12 дней»
function daysWord(n) {
  const a = n % 100, b = n % 10;
  return a > 10 && a < 20 ? 'дней' : b === 1 ? 'день' : b >= 2 && b <= 4 ? 'дня' : 'дней';
}

// ---------- База: две колонки в users ----------
export const remindersReady = (async () => {
  await dbReady;
  try {
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS remind_enabled BOOLEAN DEFAULT TRUE');
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reminded_on DATE');
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_on DATE');
  } catch (err) {
    console.error('Reminder columns failed:', err.message);
  }
})();

export async function setReminderEnabled(telegramId, enabled) {
  await remindersReady;
  const r = await query(
    'UPDATE users SET remind_enabled = $1 WHERE telegram_id = $2 RETURNING remind_enabled',
    [!!enabled, telegramId]
  );
  return r.rows[0] || null;
}

// Текст напоминания
export function reminderText(u, today) {
  const name = u.first_name ? `, ${u.first_name}` : '';
  const last = u.last_date ? String(u.last_date).slice(0, 10) : null;
  const streak = Number(u.current_streak) || 0;
  const tail = '\n\n<i>Отключить напоминания можно в профиле приложения.</i>';

  // вчера запись была — серия жива, но сегодня ещё пусто
  if (last === addDaysStr(today, -1) && streak > 0) {
    return `🔥 Серия ${streak} ${daysWord(streak)} — не дай ей прерваться!\n\n` +
      'За сегодня ещё нет записи. Запиши тренировку или день отдыха — это минута.' + tail;
  }
  return `Как прошёл день${name}? 💪\n\n` +
    'Запиши тренировку или день отдыха — это займёт минуту, а Fom посмотрит, как ты восстанавливаешься.' + tail;
}

/**
 * Разослать напоминания за сегодня. send(chatId, html) должна вернуть ответ Telegram ({ ok, description }).
 * force — для проверки админом: не смотрит на время.
 */
export async function sendReminders(send, { force = false } = {}) {
  await remindersReady;
  const t = mskNow();
  if (!force && (t.hour < REMINDER_HOUR || t.hour >= LAST_HOUR)) return 0;
  const today = t.dateStr;

  const r = await query(
    `SELECT u.id, u.telegram_id, u.first_name, u.current_streak,
            (SELECT MAX(w.date) FROM workouts w WHERE w.user_id = u.id) AS last_date
     FROM users u
     WHERE COALESCE(u.remind_enabled, TRUE)
       AND (u.reminded_on IS NULL OR u.reminded_on < $1::date)
       AND NOT EXISTS (SELECT 1 FROM workouts w WHERE w.user_id = u.id AND w.date = $1::date)`,
    [today]
  );

  let sent = 0;
  for (const u of r.rows) {
    const last = u.last_date ? String(u.last_date).slice(0, 10) : null;
    // давно забросил дневник — не беспокоим
    if (last && last < addDaysStr(today, -14)) continue;

    // «занимаем» человека на сегодня, чтобы при двух запусках не написать дважды
    const claim = await query(
      `UPDATE users SET reminded_on = $1::date
       WHERE id = $2 AND (reminded_on IS NULL OR reminded_on < $1::date)
         AND (created_at IS NULL OR created_at > now() - interval '7 days' OR $3::boolean)
       RETURNING id`,
      [today, u.id, !!last]
    );
    if (!claim.rows.length) continue;

    const res = await send(u.telegram_id, reminderText(u, today));
    if (res?.ok) sent++;
    else if (/blocked|deactivated|not found|initiate/i.test(res?.description || '')) {
      // бот заблокирован или человек не открывал чат с ботом — больше не пытаемся
      await query('UPDATE users SET remind_enabled = FALSE WHERE id = $1', [u.id]);
    }
    await new Promise((ok) => setTimeout(ok, 60)); // Telegram не любит больше ~30 сообщений в секунду
  }
  if (sent) console.log(`Reminders: отправлено ${sent}`);
  return sent;
}

// ---------- Итоги недели от Fom: воскресенье, 19:00 по Москве ----------
const DIGEST_HOUR = 19;
function escHtml(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function mskDow() { return new Date(Date.now() + MSK_OFFSET_MS).getUTCDay(); }

export async function sendWeeklyDigests(send, { force = false, onlyTelegramId = null } = {}) {
  await remindersReady;
  const t = mskNow();
  if (!force && (mskDow() !== 0 || t.hour < DIGEST_HOUR || t.hour >= LAST_HOUR)) return 0;
  const sunday = t.dateStr;
  const monday = addDaysStr(sunday, -((mskDow() + 6) % 7));
  const users = await query(
    `SELECT u.id, u.telegram_id, u.first_name FROM users u
     WHERE COALESCE(u.remind_enabled, TRUE)
       ${onlyTelegramId ? 'AND u.telegram_id = $3' : 'AND (u.digest_on IS NULL OR u.digest_on < $2::date)'}
       AND EXISTS (SELECT 1 FROM workouts w WHERE w.user_id = u.id AND w.date BETWEEN $1::date AND $2::date)`,
    onlyTelegramId ? [monday, sunday, onlyTelegramId] : [monday, sunday]
  );
  let sent = 0;
  for (const u of users.rows) {
    if (!onlyTelegramId) {
      const claim = await query(
        `UPDATE users SET digest_on = $1::date WHERE id = $2 AND (digest_on IS NULL OR digest_on < $1::date) RETURNING id`,
        [sunday, u.id]);
      if (!claim.rows.length) continue;
    }
    try {
      const w = await query(`${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.date BETWEEN $2::date AND $3::date ORDER BY w.date, w.session`, [u.id, monday, sunday]);
      const text = await getWeeklyDigest(w.rows, await athleteContext(u.id), u.first_name || '');
      const res = await send(u.telegram_id, `📊 <b>Итоги недели от Fom</b>\n\n${escHtml(text)}`);
      if (res?.ok) sent++;
    } catch (err) {
      console.error('Digest failed for user', u.id, err.message);
    }
    await new Promise((ok) => setTimeout(ok, 300));
  }
  if (sent) console.log(`Weekly digest: отправлено ${sent}`);
  return sent;
}

export function startReminderScheduler(send) {
  const check = () => {
    sendReminders(send).catch((err) => console.error('Reminders failed:', err.message));
    sendWeeklyDigests(send).catch((err) => console.error('Digest failed:', err.message));
  };
  setTimeout(check, 20000);
  setInterval(check, 5 * 60 * 1000); // раз в 5 минут проверяем, не пора ли
}
