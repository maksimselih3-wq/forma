import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;

// Сколько живёт подпись Telegram. Старую (например, подсмотренную или утёкшую) принимать нельзя.
const MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7 дней

/**
 * Проверяет initData, которую присылает Telegram Mini App,
 * и возвращает распарсенные данные пользователя, если подпись верна.
 * Документация: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData) {
  if (!initData || typeof initData !== 'string' || !BOT_TOKEN) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;

    params.delete('hash');

    const dataCheckArr = [];
    for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      dataCheckArr.push(`${key}=${value}`);
    }
    const dataCheckString = dataCheckArr.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    // сравнение «за одинаковое время», чтобы подпись нельзя было подобрать по скорости ответа
    if (!crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(hash, 'hex'))) {
      return null; // подпись не сошлась — запрос не от Telegram
    }

    // подпись слишком старая — просим открыть приложение заново
    const authDate = Number(params.get('auth_date'));
    if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) return null;

    const userJson = params.get('user');
    const user = userJson ? JSON.parse(userJson) : null;
    if (!user || !Number.isInteger(user.id)) return null;

    return { user, authDate };
  } catch (err) {
    return null;
  }
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
