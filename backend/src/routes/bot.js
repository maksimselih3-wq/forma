import { Router } from 'express';
import crypto from 'crypto';

/**
 * Telegram-бот Forma:
 *  - при запуске сервера сам настраивает бота: имя, описание, команды, кнопку «Forma» у поля ввода;
 *  - принимает сообщения (webhook) и отвечает на /start красивым приветствием с кнопкой «Открыть Forma».
 *
 * Нужные переменные в Railway: BOT_TOKEN (уже есть) и BOT_WEBHOOK_SECRET (любая длинная случайная строка).
 */
const router = Router();

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET;
const APP_URL = process.env.APP_URL || 'https://maksimselih3-wq.github.io/forma-2/';
const SERVER_URL = process.env.SERVER_URL || 'https://forma-production-9c7a.up.railway.app';
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

  await tg('setMyName', { name: 'Forma' });

  // Текст в пустом чате до нажатия «Старт» (до 512 символов)
  await tg('setMyDescription', {
    description:
      'Forma — дневник тренировок с ИИ-помощником Fom.\n\n' +
      '📝 Записывай тренировку за минуту — можно просто своими словами\n' +
      '❤️ Пульс, нагрузка, самочувствие, силовая и ОФП\n' +
      '🤖 Fom считает объём и замечает перегруз\n' +
      '🔥 Серии, календарь, друзья и реакции\n\n' +
      'Жми «Старт» 👇',
  });

  // Короткое описание в профиле бота (до 120 символов)
  await tg('setMyShortDescription', {
    short_description: 'Дневник тренировок с ИИ-помощником Fom 🔥 Серии, календарь, друзья.',
  });

  // Команды в меню «/»
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Открыть Forma' },
      { command: 'help', description: 'Что умеет Forma' },
    ],
  });

  // Кнопка слева от поля ввода — сразу открывает приложение
  await tg('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Forma', web_app: { url: APP_URL } },
  });

  // Подписываемся на сообщения боту
  if (WEBHOOK_SECRET) {
    await tg('setWebhook', {
      url: `${SERVER_URL}/api/bot/webhook`,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
  } else {
    console.log('BOT_WEBHOOK_SECRET не задан — бот не будет отвечать на /start');
  }
  console.log('Bot configured');
}
setTimeout(configureBot, 3000);

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
