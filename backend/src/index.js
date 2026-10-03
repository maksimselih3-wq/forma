import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import { requireTelegramAuth } from './telegramAuth.js';
import { rateLimit } from './rateLimit.js';
import { protectAsync } from './asyncSafe.js';

import authRoutes from './routes/auth.js';
import workoutRoutes from './routes/workouts.js';
import friendRoutes from './routes/friends.js';
import insightRoutes from './routes/insights.js';
import chatRoutes from './routes/chat.js';
import botRoutes from './routes/bot.js';
import assetRoutes from './routes/asset.js';
import partnerRoutes from './routes/partners.js';
import coachRoutes from './routes/coach.js';
import geoRoutes from './routes/geo.js';
import healthRoutes from './routes/health.js';

dotenv.config();

const app = express();

// За Railway стоит один прокси: так req.ip — настоящий адрес клиента, а не адрес прокси
// (без этого ограничитель запросов считал бы всех людей как одного).
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(cors());

// Общий потолок запросов: на человека (по подписи Telegram) или, без подписи, на IP.
// Webhook Telegram и проверка здоровья не считаем — они от самого Telegram / Railway.
app.use('/api', rateLimit({
  windowMs: 60_000,
  max: 600, // с запасом: одна загрузка ленты тянет десятки картинок-аватарок
  anonMax: 120,
  skip: (req) => req.path === '/bot/webhook',
}));

// «Здоровье» принимает фото еды и бланков анализов — им нужен запас по размеру.
// Сначала проверяем подпись Telegram и только потом читаем тяжёлое тело запроса:
// раньше 10 МБ разбирались ещё до проверки, и любой аноним мог гонять тяжёлые запросы.
app.use('/api/health', requireTelegramAuth, express.json({ limit: '10mb' }), protectAsync(healthRoutes));
app.use(express.json());

// Ошибка в async-обработчике иначе «подвешивает» запрос до таймаута (Express 4) — protectAsync
// превращает её в нормальный ответ 500. Для роутеров с собственной обёрткой это безвредно.
app.use('/api/auth', protectAsync(authRoutes));
app.use('/api/workouts', protectAsync(workoutRoutes));
app.use('/api/friends', protectAsync(friendRoutes));
app.use('/api/insights', protectAsync(insightRoutes));
app.use('/api/chat', protectAsync(chatRoutes));
app.use('/api/bot', protectAsync(botRoutes)); // Telegram-бот: приветствие на /start и оформление
app.use('/api/partners', protectAsync(partnerRoutes)); // совместные пробежки: поиск напарников в своём городе
app.use('/api/coach', protectAsync(coachRoutes)); // кабинет тренера: команда, спортсмен, сводка недели, задания
app.use('/api/geo', protectAsync(geoRoutes)); // место тренировки: поиск и высота над уровнем моря
app.use('/api/asset', protectAsync(assetRoutes)); // скрипт Telegram, шрифты, картинки подарков — для работы в России без VPN

app.get('/health', (req, res) => res.json({ ok: true }));

// Единый обработчик ошибок: наружу — короткое сообщение, подробности (и стек) только в лог.
// Без него Express при NODE_ENV не равном production показывает человеку стек ошибки.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({ error: 'Слишком большой запрос' });
  }
  if (err?.type === 'entity.parse.failed' || err?.status === 400) {
    return res.status(400).json({ error: 'Неверный запрос' });
  }
  console.error('Request failed:', req.method, req.originalUrl, '-', err?.message || err);
  res.status(500).json({ error: 'Что-то пошло не так — попробуй ещё раз' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
