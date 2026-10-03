import express, { Router } from 'express';
import crypto from 'crypto';
import { query } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { GIVEAWAYS, giveawayStatus, runDraw, startGiveawayScheduler, isAdmin, honestStreak, nextDrawAt } from '../giveaway.js';
import { startReminderScheduler, reminderText, sendWeeklyDigests } from '../reminders.js';
import { rememberReferral } from '../social.js';
import { adminDeleteRun } from './partners.js';

/**
 * Telegram-бот Forma:
 *  - при запуске сервера сам настраивает бота: имя, описание, команды, кнопку «Forma» у поля ввода;
 *  - принимает сообщения (webhook) и отвечает на /start красивым приветствием с кнопкой «Открыть Forma».
 *
 * Нужные переменные в Railway: BOT_TOKEN (уже есть) и BOT_WEBHOOK_SECRET (любая длинная случайная строка).
 */
const router = Router();

const BOT_TOKEN = process.env.BOT_TOKEN;
// Telegram принимает в секрете только латиницу, цифры, _ и -. Чтобы не зависеть от того,
// что именно вписано в Railway (пробелы, переносы, другие символы), превращаем значение
// в надёжный «отпечаток» из букв и цифр — его и отдаём Telegram, и с ним же сверяем.
const RAW_SECRET = (process.env.BOT_WEBHOOK_SECRET || '').trim();
const WEBHOOK_SECRET = RAW_SECRET ? crypto.createHash('sha256').update(RAW_SECRET).digest('hex') : '';
const APP_URL = process.env.APP_URL || 'https://maksimselih3-wq.github.io/forma-2/';
const SERVER_URL = process.env.SERVER_URL || 'https://forma-production-9c7a.up.railway.app';
// Адрес для ссылок, которые открывает человек (картинка для истории, файл выгрузки).
// Если приложение работает через свой домен в России — ссылки ведут туда, иначе на Railway.
const PUBLIC_URL = (process.env.PUBLIC_URL || SERVER_URL).replace(/\/+$/, '');
// Картинка приветствия лежит рядом с приложением на GitHub Pages
const WELCOME_IMAGE = new URL('bot/welcome.png', APP_URL).toString();

const OPEN_BUTTON = { inline_keyboard: [[{ text: '🚀 Открыть Forma', web_app: { url: APP_URL } }]] };

async function tg(method, body) {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (!data.ok) console.error(`Telegram ${method} failed:`, data.description);
    return data;
  } catch (err) {
    console.error(`Telegram ${method} error:`, err.message);
    return null;
  }
}

// ---------- Оформление бота: выполняется при каждом запуске сервера (повторно — безопасно) ----------
async function configureBot() {
  if (!BOT_TOKEN) return;

  // Имя меняем, только если оно другое: Telegram разрешает менять имя редко
  // (иначе в логах «Too Many Requests» при каждом перезапуске)
  const name = await tg('getMyName', {});
  if (name?.ok && name.result?.name !== 'Forma') await tg('setMyName', { name: 'Forma' });

  // Текст в пустом чате до нажатия «Старт» (до 512 символов)
  await tg('setMyDescription', {
    description:
      'Forma — дневник тренировок с помощником Fom.\n\n' +
      '📝 Записывай тренировку за минуту — можно просто своими словами\n' +
      '❤️ Пульс, нагрузка, самочувствие, силовая и ОФП\n' +
      '🤖 Fom считает объём и замечает перегруз\n' +
      '🔥 Серии, календарь, друзья и реакции\n\n' +
      'Жми «Старт» 👇',
  });

  // Короткое описание в профиле бота (до 120 символов)
  await tg('setMyShortDescription', {
    short_description: 'Дневник тренировок с помощником Fom 🔥 Серии, календарь, друзья.',
  });

  // Команды в меню «/»
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Открыть Forma' },
      { command: 'giveaway', description: 'Розыгрыши подарков 🎁' },
      { command: 'help', description: 'Что умеет Forma' },
    ],
  });

  // Кнопка слева от поля ввода — сразу открывает приложение
  await tg('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Forma', web_app: { url: APP_URL } },
  });

  // Подписываемся на сообщения боту
  if (WEBHOOK_SECRET) {
    const hook = await tg('setWebhook', {
      url: `${SERVER_URL}/api/bot/webhook`,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
    if (hook?.ok) console.log('Webhook OK — бот отвечает на /start');
  } else {
    console.log('BOT_WEBHOOK_SECRET не задан — бот не будет отвечать на /start');
  }
  console.log('Bot configured');
}
setTimeout(configureBot, 3000);

// Розыгрыши: сервер сам подводит итоги по расписанию и пишет победителям
const sendText = (chatId, text) => tg('sendMessage', { chat_id: chatId, text, reply_markup: OPEN_BUTTON });
startGiveawayScheduler(sendText);

// Вечернее напоминание: в 21:00 (МСК), если за сегодня ещё нет записи
const sendHtml = (chatId, text) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: OPEN_BUTTON });
startReminderScheduler(sendHtml);

function mskDateLabel(d) {
  return new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

// ---------- Статистика для админа: /stats и отчёт по понедельникам ----------
async function safeQ(sql, params = []) {
  try { return (await query(sql, params)).rows[0] || {}; } catch (e) { return {}; }
}
function pct(a, b) { return b ? `${Math.round((a / b) * 100)}%` : '—'; }

export async function buildStats() {
  // «сегодня» по Москве
  const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  const u = await safeQ(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE created_at >= $1::date - 6)::int AS new7,
       count(*) FILTER (WHERE created_at >= $1::date)::int AS new_today
     FROM users`, [today]);
  const a = await safeQ(
    `SELECT count(DISTINCT user_id) FILTER (WHERE date = $1::date)::int AS dau,
       count(DISTINCT user_id) FILTER (WHERE date >= $1::date - 6)::int AS wau,
       count(DISTINCT user_id) FILTER (WHERE date >= $1::date - 29)::int AS mau,
       count(*) FILTER (WHERE date >= $1::date - 6)::int AS entries7,
       count(*) FILTER (WHERE date >= $1::date - 6 AND type = 'training')::int AS trainings7,
       count(*) FILTER (WHERE date >= $1::date - 6 AND competition IS NOT NULL)::int AS comps7,
       count(*)::int AS entries_total
     FROM workouts`, [today]);
  // Удержание: кто пришёл 7–13 дней назад — сколько из них записывали что-то за последние 7 дней
  const r1 = await safeQ(
    `SELECT count(*)::int AS cohort,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM workouts w WHERE w.user_id = u.id AND w.date >= $1::date - 6))::int AS back
     FROM users u WHERE u.created_at >= $1::date - 13 AND u.created_at < $1::date - 6`, [today]);
  // Кто с нами 2+ недели — сколько активны на этой неделе
  const r2 = await safeQ(
    `SELECT count(*)::int AS cohort,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM workouts w WHERE w.user_id = u.id AND w.date >= $1::date - 6))::int AS back
     FROM users u WHERE u.created_at < $1::date - 13`, [today]);
  // Зарегистрировались, но ни разу ничего не записали
  const zero = await safeQ(
    `SELECT count(*)::int AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM workouts w WHERE w.user_id = u.id)`);
  const fom = await safeQ(
    `SELECT COALESCE(sum(count) FILTER (WHERE day = $1::date), 0)::int AS today,
       COALESCE(sum(count) FILTER (WHERE day >= $1::date - 6), 0)::int AS week,
       count(*) FILTER (WHERE day >= $1::date - 6 AND count >= 7)::int AS hit_limit
     FROM chat_usage`, [today]);
  const fb = await safeQ(`SELECT count(*)::int AS n FROM workouts WHERE ai_feedback IS NOT NULL AND date >= $1::date - 6`, [today]);
  const g = await safeQ(`SELECT count(*)::int AS groups, count(*) FILTER (WHERE coach_mode)::int AS coach FROM groups`);
  const gm = await safeQ(`SELECT count(DISTINCT user_id)::int AS n FROM group_members`);
  const ref = await safeQ(`SELECT count(*) FILTER (WHERE invitee_id IS NOT NULL)::int AS n FROM referrals`);
  const rem = await safeQ(`SELECT count(*) FILTER (WHERE COALESCE(remind_enabled, TRUE))::int AS on FROM users`);
  let top = [];
  try {
    top = (await query(
      `SELECT first_name, last_name, username, current_streak FROM users
       WHERE current_streak > 0 ORDER BY current_streak DESC LIMIT 5`)).rows;
  } catch (e) {}

  const name = (x) => escapeHtml([x.first_name, x.last_name].filter(Boolean).join(' ') || (x.username ? '@' + x.username : '—'));
  const lines = [
    `📊 <b>Статистика Forma</b> · ${today}`,
    '',
    `👥 <b>Пользователи:</b> ${u.total ?? 0} (новых за неделю: ${u.new7 ?? 0}, сегодня: ${u.new_today ?? 0})`,
    `😴 Ни разу ничего не записали: ${zero.n ?? 0}`,
    '',
    `📝 <b>Активность</b> (хоть одна запись):`,
    `• сегодня: ${a.dau ?? 0} · за 7 дней: ${a.wau ?? 0} · за 30 дней: ${a.mau ?? 0}`,
    `• записей за неделю: ${a.entries7 ?? 0} (тренировок ${a.trainings7 ?? 0}, стартов ${a.comps7 ?? 0}) · всего: ${a.entries_total ?? 0}`,
    '',
    `🔁 <b>Возвращаются:</b>`,
    `• пришли 1–2 недели назад: ${r1.back ?? 0} из ${r1.cohort ?? 0} активны на этой неделе (${pct(r1.back, r1.cohort)})`,
    `• с нами 2+ недели: ${r2.back ?? 0} из ${r2.cohort ?? 0} активны (${pct(r2.back, r2.cohort)})`,
    '',
    `🤖 <b>Fom:</b> сообщений в чат сегодня ${fom.today ?? 0}, за неделю ${fom.week ?? 0}` +
      (fom.hit_limit ? ` · упирались в лимит: ${fom.hit_limit} раз` : ''),
    `• отзывов о тренировках за неделю: ${fb.n ?? 0}`,
    '',
    `👥 Групп: ${g.groups ?? 0} (тренерских ${g.coach ?? 0}), в группах ${gm.n ?? 0} чел. · пришли по приглашению: ${ref.n ?? 0}`,
    `🔔 Напоминания включены у ${rem.on ?? 0}`,
  ];
  if (top.length) lines.push('', '🔥 <b>Самые длинные серии:</b>', ...top.map((x, i) => `${i + 1}. ${name(x)} — ${x.current_streak} дн.`));
  return lines.join('\n');
}

// Отчёт тебе каждый понедельник в 9:00 (МСК) — один раз за неделю
async function weeklyAdminReport() {
  const now = new Date(Date.now() + 3 * 3600000);
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 9 || now.getUTCHours() >= 12) return;
  const key = `admin-report-${now.toISOString().slice(0, 10)}`;
  try {
    const claim = await query(
      `INSERT INTO giveaway_draws (period_key, kind) VALUES ($1, 'report') ON CONFLICT (period_key) DO NOTHING RETURNING id`, [key]);
    if (!claim.rows.length) return;
    const admin = await query(`SELECT telegram_id FROM users WHERE LOWER(username) = 'maksimshelikh'`);
    const chat = process.env.ADMIN_TELEGRAM_ID || admin.rows[0]?.telegram_id;
    if (chat) await tg('sendMessage', { chat_id: chat, text: `🗓 Недельный отчёт\n\n${await buildStats()}`, parse_mode: 'HTML' });
  } catch (err) {
    console.error('Admin report failed:', err.message);
  }
}
setTimeout(weeklyAdminReport, 30000);
setInterval(weeklyAdminReport, 10 * 60 * 1000);

// ---------- Ответы на сообщения ----------
function welcomeText(name) {
  return (
    `Привет${name ? ', ' + name : ''}! 👋\n\n` +
    '<b>Forma</b> — твой дневник тренировок.\n\n' +
    '📝 Записывай тренировку за минуту — даже своими словами, Fom сам разложит по полям\n' +
    '🤖 Fom считает объём, следит за пульсом и восстановлением\n' +
    '🔥 Держи серию, смотри календарь, добавляй друзей\n\n' +
    'Жми кнопку ниже 👇'
  );
}

const HELP_TEXT =
  '<b>Что умеет Forma</b>\n\n' +
  '• Дневник: разминка, отрезки, силовая, пульс, RPE, самочувствие\n' +
  '• Умный ввод: опиши тренировку своими словами\n' +
  '• Fom: отзыв после тренировки, разбор недели и месяца, чат\n' +
  '• Друзья: лента, реакции, комментарии\n\n' +
  'Всё внутри приложения — открывай кнопкой ниже или кнопкой «Forma» слева от поля ввода.';

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  if (!chatId || msg.chat.type !== 'private') return;
  const text = (msg.text || '').trim();
  const name = escapeHtml(msg.from?.first_name);

  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || '';
    // приглашение в группу: кнопка открывает приложение сразу на вступлении
    const g = /^g_([a-z0-9]{4,12})$/i.exec(payload);
    if (g) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `👥 Тебя пригласили в группу в Forma!\n\nЖми кнопку — откроется приложение и предложит вступить.`,
        reply_markup: { inline_keyboard: [[{ text: '👥 Вступить в группу', web_app: { url: `${APP_URL}?join=${g[1].toLowerCase()}` } }]] },
      });
      return;
    }
    // приглашение от друга: запоминаем, кто позвал
    if (/^r_/i.test(payload)) await rememberReferral(msg.from.id, payload).catch(() => {});
    const sent = await tg('sendPhoto', {
      chat_id: chatId,
      photo: WELCOME_IMAGE,
      caption: welcomeText(name),
      parse_mode: 'HTML',
      reply_markup: OPEN_BUTTON,
    });
    // если картинка недоступна — отправляем просто текст
    if (!sent?.ok) {
      await tg('sendMessage', { chat_id: chatId, text: welcomeText(name), parse_mode: 'HTML', reply_markup: OPEN_BUTTON });
    }
    return;
  }

  if (text.startsWith('/giveaway')) {
    const u = await query('SELECT id FROM users WHERE telegram_id = $1', [msg.from.id]);
    const streak = u.rows[0] ? await honestStreak(u.rows[0].id) : 0;
    const lines = Object.entries(GIVEAWAYS).map(([kind, g]) => {
      const ok = streak >= g.minStreak;
      return `${g.emoji} <b>${g.title}</b> — ${g.prize}\n` +
        `Нужна честная серия от ${g.minStreak} дн. · итоги ${mskDateLabel(nextDrawAt(kind))} (МСК)\n` +
        (ok ? '✅ Ты участвуешь!' : `Ещё ${g.minStreak - streak} дн. до участия`);
    });
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      reply_markup: OPEN_BUTTON,
      text: `🎁 <b>Розыгрыши Forma</b>\n\nТвоя честная серия: <b>${streak} дн.</b> 🔥\n\n${lines.join('\n\n')}\n\n` +
        '<i>Честная серия — дни подряд, где запись сделана в тот же день или не позже следующего. Чем длиннее серия, тем больше билетов.</i>',
    });
    return;
  }

  // Удалить пробежку по жалобе — только для админа: /delrun 12
  const delRun = /^\/delrun\s+(\d+)$/.exec(text);
  if (delRun) {
    if (!(await isAdmin(msg.from.id))) return;
    const ok = await adminDeleteRun(parseInt(delRun[1], 10));
    await sendText(msg.chat.id, ok ? `Пробежка #${delRun[1]} удалена.` : 'Такой пробежки нет.');
    return;
  }

  // Тестовый розыгрыш — только для админа: /draw_week или /draw_month
  if (text === '/draw_week' || text === '/draw_month') {
    if (!(await isAdmin(msg.from.id))) return;
    await runDraw(text === '/draw_week' ? 'week' : 'month', sendText, { force: true });
    return;
  }

  // Посмотреть, как выглядит напоминание — только для админа
  if (text === '/remind_test') {
    if (!(await isAdmin(msg.from.id))) return;
    const u = await query(
      `SELECT u.first_name, u.current_streak, (SELECT MAX(date) FROM workouts w WHERE w.user_id = u.id) AS last_date
       FROM users u WHERE telegram_id = $1`, [msg.from.id]);
    const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
    await sendHtml(chatId, reminderText(u.rows[0] || {}, today));
    return;
  }

  // Статистика приложения — только для админа
  if (text === '/stats') {
    if (!(await isAdmin(msg.from.id))) return;
    await tg('sendMessage', { chat_id: chatId, text: await buildStats(), parse_mode: 'HTML' });
    return;
  }

  // Итоги недели прямо сейчас — только для админа, только себе
  if (text === '/digest_test') {
    if (!(await isAdmin(msg.from.id))) return;
    const n = await sendWeeklyDigests(sendHtml, { force: true, onlyTelegramId: msg.from.id });
    if (!n) await sendHtml(chatId, 'За эту неделю пока нет записей — итоги не из чего собрать.');
    return;
  }

  if (text.startsWith('/help')) {
    await tg('sendMessage', { chat_id: chatId, text: HELP_TEXT, parse_mode: 'HTML', reply_markup: OPEN_BUTTON });
    return;
  }

  // любое другое сообщение — мягко отправляем в приложение
  await tg('sendMessage', {
    chat_id: chatId,
    text: 'Все тренировки и Fom живут в приложении 👇',
    reply_markup: OPEN_BUTTON,
  });
}

// GET /api/bot/giveaway — статус розыгрышей для приложения
router.get('/giveaway', requireTelegramAuth, async (req, res) => {
  try {
    const u = await query('SELECT id FROM users WHERE telegram_id = $1', [req.telegramUser.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(await giveawayStatus(u.rows[0].id));
  } catch (err) {
    console.error('Giveaway status failed:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить розыгрыши' });
  }
});

// ---------- Картинки для сторис ----------
// Telegram публикует сторис только по ссылке на картинку, поэтому приложение присылает готовую
// картинку сюда, а мы отдаём её по короткой ссылке примерно час (в памяти сервера, без базы).
const stories = new Map(); // id -> { buf, at }
const STORY_TTL = 60 * 60 * 1000;
const STORY_MAX = 100;
const STORY_PER_USER = 5; // чтобы один человек не забил память сервера

function cleanStories() {
  const now = Date.now();
  for (const [id, s] of stories) if (now - s.at > STORY_TTL) stories.delete(id);
  while (stories.size > STORY_MAX) stories.delete(stories.keys().next().value); // самые старые
}

function storyQuotaOk(owner) {
  let n = 0;
  for (const s of stories.values()) if (s.owner === owner) n++;
  return n < STORY_PER_USER;
}

// POST /api/bot/story — тело запроса: JPEG-картинка (image/jpeg), до 1.5 МБ
router.post('/story', requireTelegramAuth, express.raw({ type: 'image/jpeg', limit: '1500kb' }), (req, res) => {
  const buf = req.body;
  const isJpeg = Buffer.isBuffer(buf) && buf.length > 1000 && buf[0] === 0xff && buf[1] === 0xd8;
  if (!isJpeg) return res.status(400).json({ error: 'Нужна картинка JPEG' });
  cleanStories();
  if (!storyQuotaOk(req.telegramUser.id)) return res.status(429).json({ error: 'Слишком много картинок подряд — подожди немного' });
  const id = crypto.randomBytes(12).toString('hex');
  stories.set(id, { buf, at: Date.now(), owner: req.telegramUser.id });
  res.json({ url: `${PUBLIC_URL}/api/bot/story/${id}.jpg` });
});

// POST /api/bot/export — выгрузка дневника (CSV-файл), отдаём по короткой ссылке, чтобы Telegram скачал
router.post('/export', requireTelegramAuth, express.raw({ type: 'text/csv', limit: '3mb' }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Пустой файл' });
  cleanStories();
  if (!storyQuotaOk(req.telegramUser.id)) return res.status(429).json({ error: 'Слишком много файлов подряд — подожди немного' });
  const id = crypto.randomBytes(12).toString('hex');
  stories.set(id, { buf, at: Date.now(), type: 'text/csv; charset=utf-8', owner: req.telegramUser.id });
  res.json({ url: `${PUBLIC_URL}/api/bot/story/${id}.csv` });
});

// GET /api/bot/story/:id.jpg — сама картинка (её забирает Telegram)
router.get('/story/:file', (req, res) => {
  const id = String(req.params.file || '').replace(/\.(jpg|csv)$/, '');
  const s = /^[a-f0-9]{24}$/.test(id) && stories.get(id);
  if (!s || Date.now() - s.at > STORY_TTL) return res.status(404).json({ error: 'Картинка устарела' });
  res.set('Content-Type', s.type || 'image/jpeg');
  if (s.type) res.set('Content-Disposition', 'attachment; filename="forma-diary.csv"');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(s.buf);
});

// POST /api/bot/webhook — сюда Telegram присылает сообщения боту
router.post('/webhook', (req, res) => {
  // проверяем, что запрос действительно от Telegram (секрет знает только Telegram и наш сервер)
  const got = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  const ok = WEBHOOK_SECRET && got.length === WEBHOOK_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(WEBHOOK_SECRET));
  if (!ok) return res.status(401).end();

  res.json({ ok: true }); // отвечаем Telegram сразу, а сообщение обрабатываем следом
  if (req.body?.message) handleMessage(req.body.message).catch((err) => console.error('Bot message failed:', err.message));
});

export default router;
