import crypto from 'crypto';
import { query, dbReady } from './db.js';

/**
 * Розыгрыши подарков среди тех, кто держит ЧЕСТНУЮ серию.
 *
 *  🔥 Неделя: честная серия от 7 дней → простые подарки, итоги каждое воскресенье в 20:00 (МСК).
 *  💎 Месяц: честная серия от 30 дней → крутые подарки, итоги в последний день месяца в 20:00 (МСК).
 *
 * Честная серия — дни подряд, где запись сделана в тот же день или не позже следующего.
 * Дни, заполненные задним числом, в розыгрыше не считаются (иначе серию легко «нарисовать»).
 *
 * Билеты: чем длиннее серия, тем больше шансов, но без перекоса:
 *   неделя — 1 билет за каждые 7 дней (максимум 5), месяц — 1 билет за каждые 30 дней (максимум 3).
 *
 * Победителей выбирает сервер сам. Подарки отправляет админ со своего аккаунта:
 * бот присылает ему список победителей с @username.
 */

export const GIVEAWAYS = {
  week: {
    title: 'Еженедельный розыгрыш',
    emoji: '🔥',
    minStreak: 7,
    ticketDays: 7,
    maxTickets: 5,
    winners: Number(process.env.GIVEAWAY_WEEK_WINNERS) || 3,
    prize: 'простые прикольные подарки',
  },
  month: {
    title: 'Ежемесячный розыгрыш',
    emoji: '💎',
    minStreak: 30,
    ticketDays: 30,
    maxTickets: 3,
    winners: Number(process.env.GIVEAWAY_MONTH_WINNERS) || 1,
    prize: 'крутые подарки',
  },
};

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DRAW_HOUR = 20; // 20:00 по Москве

// «Сейчас» по Москве как объект с удобными полями
function mskNow(date = new Date()) {
  const d = new Date(date.getTime() + MSK_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(),
    dow: d.getUTCDay(), hour: d.getUTCHours(),
    dateStr: d.toISOString().slice(0, 10),
  };
}

function addDaysStr(str, n) {
  const d = new Date(str + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Момент ближайших итогов (в UTC) для недели/месяца
export function nextDrawAt(kind, now = new Date()) {
  const t = mskNow(now);
  let y = t.y, m = t.m, day = t.day;
  if (kind === 'week') {
    day += (7 - t.dow) % 7; // ближайшее воскресенье (сегодня, если сегодня воскресенье)
  } else {
    day = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // последний день месяца
  }
  let at = new Date(Date.UTC(y, m, day, DRAW_HOUR) - MSK_OFFSET_MS);
  if (at <= now) {
    // сегодняшние итоги уже прошли — следующий раз
    if (kind === 'week') at = new Date(at.getTime() + 7 * 86400000);
    else at = new Date(Date.UTC(y, m + 2, 0, DRAW_HOUR) - MSK_OFFSET_MS);
  }
  return at;
}

// Ключ периода, чтобы один и тот же розыгрыш не прошёл дважды
function periodKey(kind, now = new Date()) {
  const t = mskNow(now);
  if (kind === 'month') return `month-${t.y}-${String(t.m + 1).padStart(2, '0')}`;
  return `week-${t.dateStr}`; // в воскресенье — дата этого воскресенья
}

// ---------- База ----------
const ready = (async () => {
  await dbReady;
  try {
    await query(`CREATE TABLE IF NOT EXISTS giveaway_draws (
      id SERIAL PRIMARY KEY,
      period_key TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL,
      participants INT DEFAULT 0,
      winners JSONB DEFAULT '[]',
      created_at TIMESTAMP DEFAULT now()
    )`);
    await query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'giveaway_draws' AND tableowner = current_user) THEN
        ALTER TABLE giveaway_draws ENABLE ROW LEVEL SECURITY;
      END IF; END $$`);
  } catch (err) {
    console.error('Giveaway table failed:', err.message);
  }
})();

// ---------- Честная серия ----------
// Даты, записанные вовремя: запись создана не позже конца следующего дня
const HONEST_DAYS_SQL = `
  SELECT user_id, date FROM workouts
  WHERE date > CURRENT_DATE - 400
    AND created_at <= (date + 2)::timestamp`;

// Серия дней подряд, которая заканчивается сегодня или вчера (по Москве)
function streakFromDates(dates, today) {
  const set = new Set(dates);
  let start = set.has(today) ? today : addDaysStr(today, -1);
  let n = 0;
  while (set.has(start)) {
    n++;
    start = addDaysStr(start, -1);
  }
  return n;
}

export async function honestStreak(userId) {
  await ready;
  const r = await query(`${HONEST_DAYS_SQL} AND user_id = $1`, [userId]);
  return streakFromDates(r.rows.map((x) => String(x.date).slice(0, 10)), mskNow().dateStr);
}

function tickets(kind, streak) {
  const g = GIVEAWAYS[kind];
  if (streak < g.minStreak) return 0;
  return Math.min(g.maxTickets, Math.floor(streak / g.ticketDays));
}

// ---------- Статус для приложения ----------
export async function giveawayStatus(userId) {
  await ready;
  const streak = await honestStreak(userId);
  const last = await query(
    `SELECT DISTINCT ON (kind) kind, winners, created_at FROM giveaway_draws
     WHERE period_key NOT LIKE 'test-%'
     ORDER BY kind, created_at DESC`
  );
  const lastByKind = Object.fromEntries(last.rows.map((r) => [r.kind, r]));

  const out = { honest_streak: streak };
  for (const kind of Object.keys(GIVEAWAYS)) {
    const g = GIVEAWAYS[kind];
    const t = tickets(kind, streak);
    out[kind] = {
      title: g.title,
      emoji: g.emoji,
      prize: g.prize,
      min_streak: g.minStreak,
      winners_count: g.winners,
      draw_at: nextDrawAt(kind).toISOString(),
      eligible: t > 0,
      tickets: t,
      need_days: Math.max(0, g.minStreak - streak),
      last_winners: (lastByKind[kind]?.winners || []).map((w) => ({
        first_name: w.first_name, last_name: w.last_name, username: w.username, streak: w.streak,
      })),
      last_draw_at: lastByKind[kind]?.created_at || null,
    };
  }
  return out;
}

// ---------- Сам розыгрыш ----------
// Честный случайный выбор с весами (билетами), без повторов
function pickWinners(entries, count) {
  const pool = [...entries];
  const winners = [];
  while (winners.length < count && pool.length) {
    const total = pool.reduce((s, e) => s + e.tickets, 0);
    let r = crypto.randomInt(total);
    const idx = pool.findIndex((e) => (r -= e.tickets) < 0);
    winners.push(pool.splice(idx, 1)[0]);
  }
  return winners;
}

async function adminTelegramId() {
  if (process.env.ADMIN_TELEGRAM_ID) return process.env.ADMIN_TELEGRAM_ID;
  const r = await query(`SELECT telegram_id FROM users WHERE LOWER(username) = 'maksimshelikh'`);
  return r.rows[0]?.telegram_id || null;
}

function fullName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : 'Спортсмен');
}

/**
 * Провести розыгрыш. force — для тестового запуска админом (не мешает настоящему розыгрышу периода).
 * send(chatId, text) — функция отправки сообщения ботом.
 */
export async function runDraw(kind, send, { force = false } = {}) {
  await ready;
  const g = GIVEAWAYS[kind];
  const key = force ? `test-${kind}-${Date.now()}` : periodKey(kind);

  // занимаем период сразу, чтобы два запуска не провели розыгрыш дважды
  const claim = await query(
    `INSERT INTO giveaway_draws (period_key, kind) VALUES ($1, $2) ON CONFLICT (period_key) DO NOTHING RETURNING id`,
    [key, kind]
  );
  if (!claim.rows.length) return null; // уже проводили
  const drawId = claim.rows[0].id;

  // все честные серии
  const today = mskNow().dateStr;
  const days = await query(HONEST_DAYS_SQL);
  const byUser = {};
  days.rows.forEach((r) => { (byUser[r.user_id] ||= []).push(String(r.date).slice(0, 10)); });

  // организатор в своём розыгрыше не участвует
  const admin = await adminTelegramId();
  const adminRow = admin ? await query('SELECT id FROM users WHERE telegram_id = $1', [admin]) : { rows: [] };
  const adminUserId = adminRow.rows[0]?.id;

  const entries = [];
  for (const [userId, dates] of Object.entries(byUser)) {
    if (Number(userId) === adminUserId) continue;
    const streak = streakFromDates(dates, today);
    const t = tickets(kind, streak);
    if (t > 0) entries.push({ user_id: Number(userId), streak, tickets: t });
  }

  const picked = pickWinners(entries, g.winners);
  let winners = [];
  if (picked.length) {
    const users = await query(
      `SELECT id, telegram_id, username, first_name, last_name FROM users WHERE id = ANY($1::int[])`,
      [picked.map((p) => p.user_id)]
    );
    const byId = Object.fromEntries(users.rows.map((u) => [u.id, u]));
    winners = picked.map((p) => ({ ...p, ...byId[p.user_id] }));
  }

  await query(
    `UPDATE giveaway_draws SET participants = $1, winners = $2 WHERE id = $3`,
    [entries.length, JSON.stringify(winners.map(({ telegram_id, ...w }) => w)), drawId]
  );

  // поздравляем победителей (в тестовом запуске — никому не пишем, только админу)
  for (const w of force ? [] : winners) {
    await send(w.telegram_id,
      `🎉 Поздравляем! Ты выиграл в розыгрыше Forma — «${g.title}» ${g.emoji}\n\n` +
      `Твоя честная серия: ${w.streak} дн. 🔥\nПодарок скоро придёт тебе в Telegram. Так держать! 💪`);
  }

  // список для админа — чтобы отправить подарки
  if (admin) {
    const list = winners.length
      ? winners.map((w, i) => `${i + 1}. ${fullName(w)}${w.username ? ' @' + w.username : ''} — серия ${w.streak} дн., билетов ${w.tickets}`).join('\n')
      : 'Участников пока нет — никто не набрал нужную серию.';
    await send(admin,
      `${g.emoji} Итоги: ${g.title}${force ? ' (тестовый запуск)' : ''}\n` +
      `Участников: ${entries.length}\n\n${list}\n\n` +
      (force ? 'Это тест: победителям ничего не отправлено, в приложении итоги не показываются.' : (winners.length ? 'Отправь им подарки в Telegram 🎁' : '')));
  }

  console.log(`Giveaway ${key}: ${entries.length} участников, победителей ${winners.length}`);
  return { participants: entries.length, winners };
}

// ---------- Автоматический запуск по расписанию ----------
export function startGiveawayScheduler(send) {
  const check = async () => {
    try {
      const t = mskNow();
      if (t.hour < DRAW_HOUR) return;
      if (t.dow === 0) await runDraw('week', send);
      const lastDay = new Date(Date.UTC(t.y, t.m + 1, 0)).getUTCDate();
      if (t.day === lastDay) await runDraw('month', send);
    } catch (err) {
      console.error('Giveaway scheduler failed:', err.message);
    }
  };
  setTimeout(check, 15000);
  setInterval(check, 5 * 60 * 1000); // раз в 5 минут проверяем, не пора ли
}

export async function isAdmin(telegramId) {
  const admin = await adminTelegramId();
  return admin && String(admin) === String(telegramId);
}
