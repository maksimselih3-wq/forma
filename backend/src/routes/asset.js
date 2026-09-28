import { Router } from 'express';

/**
 * Пересылка внешних файлов через наш сервер.
 *
 * В России часть адресов (telegram.org, шрифты Google, картинки подарков с fragment.com)
 * у многих не открывается без VPN. Когда приложение работает через свой домен,
 * оно берёт эти файлы отсюда: сервер Railway скачивает их сам и отдаёт как свои.
 *
 *  /api/asset/tg.js            — скрипт Telegram для мини-приложений
 *  /api/asset/fonts.css        — шрифты Manrope и Unbounded (ссылки внутри ведут сюда же)
 *  /api/asset/gs/<путь>        — сами файлы шрифтов (в пути вместо «/» стоит «~»)
 *  /api/asset/gift/<имя>.webp  — картинка подарка для барабана
 *
 * Скачанное держим в памяти, чтобы не ходить за одним и тем же по сто раз.
 */

const router = Router();

const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Unbounded:wght@500;600;700&display=swap';
// с таким «браузером» Google отдаёт современные сжатые шрифты (woff2)
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const cache = new Map(); // ключ → { body, type, until }
const MAX_ITEMS = 300;

async function grab(key, urls, { ttlMs, ua, transform } = {}) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: ua ? { 'User-Agent': ua } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      let body = Buffer.from(await r.arrayBuffer());
      if (transform) body = Buffer.from(transform(body.toString('utf8')));
      const item = { body, type: r.headers.get('content-type') || 'application/octet-stream', until: Date.now() + ttlMs };
      if (cache.size >= MAX_ITEMS) cache.delete(cache.keys().next().value);
      cache.set(key, item);
      return item;
    } catch {
      /* пробуем следующий адрес */
    }
  }
  return hit || null; // если источник недоступен — хотя бы старая копия
}

function send(res, item, maxAgeSec) {
  if (!item) return res.status(404).end();
  res.set('Content-Type', item.type);
  res.set('Cache-Control', `public, max-age=${maxAgeSec}`);
  res.set('Access-Control-Allow-Origin', '*');
  res.send(item.body);
}

const HOUR = 3600 * 1000;

router.get('/tg.js', async (req, res) => {
  const item = await grab('tg', ['https://telegram.org/js/telegram-web-app.js'], { ttlMs: 6 * HOUR });
  send(res, item, 3600);
});

router.get('/fonts.css', async (req, res) => {
  const item = await grab('fonts', [FONTS_CSS], {
    ttlMs: 24 * HOUR,
    ua: CHROME_UA,
    transform: (css) => css.replace(/https:\/\/fonts\.gstatic\.com\/([^)\s'"]+)/g,
      (_, path) => `/api/asset/gs/${path.replace(/\//g, '~')}`),
  });
  send(res, item, 86400);
});

router.get('/gs/:file', async (req, res) => {
  const file = String(req.params.file || '');
  if (!/^[a-z0-9~_.-]{1,200}$/i.test(file) || file.includes('..')) return res.status(400).end();
  const path = file.replace(/~/g, '/');
  const item = await grab(`gs:${path}`, [`https://fonts.gstatic.com/${path}`], { ttlMs: 30 * 24 * HOUR });
  send(res, item, 30 * 86400);
});

router.get('/gift/:file', async (req, res) => {
  const m = /^([a-z0-9]{1,40})\.webp$/.exec(req.params.file || '');
  if (!m) return res.status(400).end();
  const slug = m[1];
  const item = await grab(`gift:${slug}`, [
    `https://fragment.com/file/gifts/${slug}/thumb.webp`,
    `https://nft.fragment.com/gift/${slug}-1.webp`,
  ], { ttlMs: 7 * 24 * HOUR });
  send(res, item, 7 * 86400);
});

export default router;
