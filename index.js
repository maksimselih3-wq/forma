import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import workoutRoutes from './routes/workouts.js';
import friendRoutes from './routes/friends.js';
import insightRoutes from './routes/insights.js';
import chatRoutes from './routes/chat.js';
import botRoutes from './routes/bot.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/workouts', workoutRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/insights', insightRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/bot', botRoutes); // Telegram-бот: приветствие на /start и оформление

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
