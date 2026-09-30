import { Router } from 'express';
import { requireTelegramAuth } from '../telegramAuth.js';

/**
 * Место тренировки: поиск города/места и высоты над уровнем моря.
 *
 *  GET /api/geo/search?q=Кисловодск   — до 6 вариантов { name, region, lat, lon, elevation }
 *  GET /api/geo/reverse?lat=..&lon=.. — «где я сейчас»: название места и высота
 *
 * Данные: Open-Meteo (поиск и высота, без ключа) и OpenStreetMap Nominatim (название по координатам).
 * Ответы кэшируем в памяти, чтобы не дёргать сервисы по одному и тому же запросу.
 */
const router = Router();
const cache = new Map();
const CACHE_MAX = 500;
const UA = 'Forma training diary (Telegram Mini App)';

function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function round(n, k = 4) { const m = 10 ** k; return Math.round(n * m) / m; }

router.get('/search', requireTelegramAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return res.json({ places: [] });
  const key = 's:' + q.toLowerCase();
  if (cache.has(key)) return res.json({ places: cache.get(key) });
  try {
    const d = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=ru&format=json`);
    const places = (d.results || []).map((x) => ({
      name: x.name,
      region: [x.admin1, x.country].filter(Boolean).join(', '),
      lat: round(x.latitude), lon: round(x.longitude),
      elevation: Number.isFinite(x.elevation) ? Math.round(x.elevation) : null,
    }));
    res.json({ places: remember(key, places) });
  } catch (err) {
    console.error('Geo search failed:', err.message);
    res.status(502).json({ error: 'Поиск места сейчас недоступен — впиши высоту сам' });
  }
});

router.get('/reverse', requireTelegramAuth, async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'Нет координат' });
  }
  const la = round(lat, 3), lo = round(lon, 3); // ~100 м — для кэша и приватности достаточно
  const key = `r:${la},${lo}`;
  if (cache.has(key)) return res.json({ place: cache.get(key) });
  const [elev, rev] = await Promise.allSettled([
    getJson(`https://api.open-meteo.com/v1/elevation?latitude=${la}&longitude=${lo}`),
    getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${la}&lon=${lo}&zoom=14&accept-language=ru`),
  ]);
  const elevation = elev.status === 'fulfilled' && Number.isFinite(elev.value?.elevation?.[0]) ? Math.round(elev.value.elevation[0]) : null;
  let name = null;
  if (rev.status === 'fulfilled') {
    const a = rev.value?.address || {};
    name = a.city || a.town || a.village || a.municipality || a.county || a.state || null;
    const spot = a.stadium || a.leisure || a.park || a.suburb || null;
    if (spot && name && spot !== name) name = `${name}, ${spot}`;
  }
  if (elevation == null && !name) return res.status(502).json({ error: 'Не удалось определить место' });
  res.json({ place: remember(key, { name: name || 'Моё место', lat: la, lon: lo, elevation }) });
});

export default router;
