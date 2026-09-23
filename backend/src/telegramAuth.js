import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;

/**
 * Проверяет initData, которую присылает Telegram Mini App,
 * и возвращает распарсенные данные пользователя, если подпись верна.
 * Документация: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');

  const dataCheckArr = [];
  for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) {
    return null; // подпись не сошлась — запрос не от Telegram
  }

  const userJson = params.get('user');
  const user = userJson ? JSON.parse(userJson) : null;

  return { user, authDate: params.get('auth_date') };
}

/**
 * Express-мидлвар: проверяет заголовок X-Telegram-Init-Data,
 * кладёт req.telegramUser при успехе, иначе 401.
 */
export function requireTelegramAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const result = validateInitData(initData);

  if (!result || !result.user) {
    return res.status(401).json({ error: 'Invalid Telegram auth' });
  }

  req.telegramUser = result.user;
  next();
}
