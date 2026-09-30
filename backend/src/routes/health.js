import { Router } from 'express';
import { query, dbReady, WORKOUT_SELECT } from '../db.js';
import { requireTelegramAuth } from '../telegramAuth.js';
import { getClientToday, isValidDate } from '../streak.js';
import {
  volumeKm, athleteContext, markerStatus, scanBloodImage, scanFood, getBloodComment, getFoodDayComment,
} from '../ai.js';

/**
 * Раздел «Здоровье»: анализы крови, питание по фото, БАДы.
 * Все данные видит только сам спортсмен (и Fom в его ответах). Тренеру и друзьям — не показываются.
 *
 *  Анализы:  GET /blood · POST /blood/scan {image} · POST /blood · POST /blood/:id/fom · DELETE /blood/:id
 *  Питание:  GET /food?date= · POST /food/scan {image?, text?} · POST /food · DELETE /food/:id · POST /food/fom {date}
 *  БАДы:     GET /supps · POST /supps · DELETE /supps/:id
 */
const router = Router();
const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
for (const m of ['get', 'post', 'delete']) {
  const orig = router[m].bind(router);
  router[m] = (path, ...fns) => orig(path, ...fns.map(safe));
}

export const healthReady = (async () => {
  await dbReady;
  try {
    await query(`CREATE TABLE IF NOT EXISTS blood_tests (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      lab TEXT,
      markers JSONB NOT NULL DEFAULT '[]',
      notes TEXT,
      fom TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS blood_tests_user ON blood_tests(user_id, date DESC)`);
    await query(`CREATE TABLE IF NOT EXISTS meals (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      time TEXT,
      title TEXT,
      kcal INT, protein NUMERIC, fat NUMERIC, carbs NUMERIC,
      items JSONB NOT NULL DEFAULT '[]',
      thumb TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS meals_user_date ON meals(user_id, date)`);
    await query(`CREATE TABLE IF NOT EXISTS supplements (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      dose TEXT,
      note TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS food_notes (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (user_id, date)
    )`);
    await query(`DO $$
      DECLARE t text;
      BEGIN
        FOREACH t IN ARRAY ARRAY['blood_tests', 'meals', 'supplements', 'food_notes'] LOOP
          IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = t AND tableowner = current_user) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
          END IF;
        END LOOP;
      END $$`);
    console.log('Health tables OK');
  } catch (err) {
    console.error('Health tables failed:', err.message);
  }
})();

async function loadMe(req, res, next) {
  await healthReady;
  const r = await query('SELECT * FROM users WHERE telegram_id = $1', [req.telegramUser.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
  req.me = r.rows[0];
  next();
}
router.use(requireTelegramAuth, safe(loadMe));

// ---------- помощники ----------
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const txt = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const num = (v, min, max) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : null;
};
const r0 = (n) => Math.round(Number(n) || 0);
const f1 = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
function addDays(str, n) { const d = new Date(str + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const day = (w) => String(w.date).slice(0, 10);

// Сколько раз в день можно «сканировать» фото (распознавание стоит денег) — считаем в памяти
const scans = new Map();
function scanAllowed(userId, kind, limit) {
  const key = `${userId}:${kind}:${new Date().toISOString().slice(0, 10)}`;
  const n = scans.get(key) || 0;
  if (n >= limit) return false;
  if (scans.size > 5000) scans.clear();
  scans.set(key, n + 1);
  return true;
}

// Текущий вес: последняя запись в «Весе» (цели), иначе из анкеты
async function currentWeight(uid) {
  try {
    const w = await query('SELECT kg FROM weight_log WHERE user_id = $1 ORDER BY date DESC LIMIT 1', [uid]);
    if (w.rows[0]) return Number(w.rows[0].kg);
  } catch (e) { /* нет таблицы */ }
  try {
    const p = await query('SELECT weight_kg FROM athlete_profiles WHERE user_id = $1', [uid]);
    if (p.rows[0]?.weight_kg) return Number(p.rows[0].weight_kg);
  } catch (e) { /* нет таблицы */ }
  return null;
}

// Цель по весу на этот месяц: 'gain' | 'loss' | null
async function weightGoal(uid, date) {
  try {
    const g = await query(`SELECT target_num, start_num FROM goals WHERE user_id = $1 AND kind = 'weight' AND month = $2 ORDER BY id DESC LIMIT 1`, [uid, date.slice(0, 7)]);
    const x = g.rows[0];
    if (!x) return null;
    if (x.start_num == null) return null;
    return Number(x.target_num) > Number(x.start_num) ? 'gain' : Number(x.target_num) < Number(x.start_num) ? 'loss' : null;
  } catch (e) { return null; }
}

// ======================= АНАЛИЗЫ КРОВИ =======================
function cleanMarkers(list) {
  return (Array.isArray(list) ? list : []).slice(0, 80).map((m) => ({
    name: txt(m.name, 60),
    value: num(m.value, -100000, 1000000),
    unit: txt(m.unit, 20),
    ref_low: num(m.ref_low, -100000, 1000000),
    ref_high: num(m.ref_high, -100000, 1000000),
  })).filter((m) => m.name && m.value != null);
}
function testOut(t) {
  const markers = Array.isArray(t.markers) ? t.markers : [];
  return {
    id: t.id, date: day(t), lab: t.lab, notes: t.notes, fom: t.fom,
    markers: markers.map((m) => ({ ...m, status: markerStatus(m) })),
    off: markers.filter((m) => ['low', 'high'].includes(markerStatus(m))).length,
  };
}

// Нагрузка за 3 недели до сдачи анализа — готовые цифры для Fom
async function loadBefore(uid, date) {
  const from = addDays(date, -21);
  const ws = (await query(`${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.date >= $2::date AND w.date <= $3::date ORDER BY w.date DESC`, [uid, from, date])).rows;
  const tr = ws.filter((w) => w.type === 'training');
  if (!tr.length) return '';
  const km = tr.reduce((a, w) => a + volumeKm(w), 0);
  const heavy = tr.filter((w) => Number(w.rpe) >= 8);
  const lastHeavy = heavy[0];
  const high = tr.filter((w) => Number(w.altitude_m) >= 1000);
  const last2 = tr.filter((w) => day(w) >= addDays(date, -2));
  const lines = [
    `за 21 день: ${tr.length} тренировок, ≈${f1(km)} км, тяжёлых (RPE 8+) — ${heavy.length}`,
    lastHeavy ? `последняя тяжёлая — ${day(lastHeavy)} (за ${Math.round((Date.parse(date) - Date.parse(day(lastHeavy))) / 86400000)} дн. до анализа)` : 'тяжёлых не было',
    last2.length ? `в 2 дня перед анализом: ${last2.map((w) => `${day(w)} RPE ${w.rpe ?? '-'}, ${f1(volumeKm(w))} км`).join('; ')}` : 'в 2 дня перед анализом тренировок не было',
    high.length ? `тренировок на высоте от 1000 м: ${high.length} (последняя ${day(high[0])}, ≈${high[0].altitude_m} м)` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

async function writeBloodComment(uid, test) {
  const prev = await query(`SELECT * FROM blood_tests WHERE user_id = $1 AND date < $2 ORDER BY date DESC LIMIT 1`, [uid, day(test)]);
  const text = await getBloodComment(
    { date: day(test), lab: test.lab, markers: test.markers },
    prev.rows[0] ? { date: day(prev.rows[0]), markers: prev.rows[0].markers } : null,
    await loadBefore(uid, day(test)),
    await athleteContext(uid),
  );
  if (text) await query('UPDATE blood_tests SET fom = $1 WHERE id = $2', [text, test.id]);
  return text;
}

router.get('/blood', async (req, res) => {
  const r = await query('SELECT * FROM blood_tests WHERE user_id = $1 ORDER BY date DESC, id DESC LIMIT 50', [req.me.id]);
  res.json({ tests: r.rows.map(testOut) });
});

router.post('/blood/scan', async (req, res) => {
  const image = req.body.image;
  if (typeof image !== 'string' || !IMG_RE.test(image)) return res.status(400).json({ error: 'Нужно фото бланка' });
  if (image.length > 3_500_000) return res.status(400).json({ error: 'Фото слишком большое' });
  if (!scanAllowed(req.me.id, 'blood', 6)) return res.status(429).json({ error: 'На сегодня распознаваний бланков хватит — внеси показатели вручную' });
  try {
    const p = await scanBloodImage(image);
    res.json({
      date: isValidDate(p.date) ? p.date : null,
      lab: txt(p.lab, 60),
      markers: cleanMarkers(p.markers),
    });
  } catch (err) {
    console.error('Blood scan failed:', err.message);
    res.status(502).json({ error: 'Не получилось прочитать бланк. Попробуй фото ровнее и при хорошем свете — или внеси вручную.' });
  }
});

router.post('/blood', async (req, res) => {
  const b = req.body || {};
  const today = getClientToday(req);
  const date = isValidDate(b.date) && b.date <= today ? b.date : null;
  if (!date) return res.status(400).json({ error: 'Укажи дату сдачи анализа' });
  const markers = cleanMarkers(b.markers);
  if (!markers.length) return res.status(400).json({ error: 'Добавь хотя бы один показатель с числом' });
  const cnt = await query('SELECT count(*)::int AS n FROM blood_tests WHERE user_id = $1', [req.me.id]);
  if (cnt.rows[0].n >= 200) return res.status(400).json({ error: 'Слишком много анализов' });
  let t;
  if (parseInt(b.id, 10)) {
    t = (await query(`UPDATE blood_tests SET date = $1, lab = $2, markers = $3, notes = $4, fom = NULL WHERE id = $5 AND user_id = $6 RETURNING *`,
      [date, txt(b.lab, 60), JSON.stringify(markers), txt(b.notes, 500), parseInt(b.id, 10), req.me.id])).rows[0];
    if (!t) return res.status(404).json({ error: 'Анализ не найден' });
  } else {
    t = (await query(`INSERT INTO blood_tests (user_id, date, lab, markers, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.me.id, date, txt(b.lab, 60), JSON.stringify(markers), txt(b.notes, 500)])).rows[0];
  }
  try { t.fom = await writeBloodComment(req.me.id, t); } catch (err) { console.error('Blood comment failed:', err.message); }
  res.json({ test: testOut(t) });
});

router.post('/blood/:id/fom', async (req, res) => {
  const t = (await query('SELECT * FROM blood_tests WHERE id = $1 AND user_id = $2', [parseInt(req.params.id, 10) || 0, req.me.id])).rows[0];
  if (!t) return res.status(404).json({ error: 'Анализ не найден' });
  try {
    t.fom = await writeBloodComment(req.me.id, t);
    res.json({ test: testOut(t) });
  } catch (err) {
    console.error('Blood comment failed:', err.message);
    res.status(502).json({ error: 'Fom сейчас не ответил — попробуй через минуту' });
  }
});

router.delete('/blood/:id', async (req, res) => {
  await query('DELETE FROM blood_tests WHERE id = $1 AND user_id = $2', [parseInt(req.params.id, 10) || 0, req.me.id]);
  res.json({ ok: true });
});

// ======================= ПИТАНИЕ =======================
// Ориентиры на день (г на кг веса): белок 1,4–2,0 (при наборе — 1,6–2,2), углеводы — по нагрузке дня
async function dayTargets(uid, date) {
  const kg = await currentWeight(uid);
  const goal = await weightGoal(uid, date);
  const ws = (await query(`${WORKOUT_SELECT} WHERE w.user_id = $1 AND w.date = $2 AND w.type = 'training'`, [uid, date])).rows;
  const km = ws.reduce((a, w) => a + volumeKm(w), 0);
  const rpe = Math.max(0, ...ws.map((w) => Number(w.rpe) || 0));
  const load = !ws.length ? 'rest' : (rpe >= 8 || km >= 15 || ws.length > 1) ? 'high' : (rpe >= 5 || km >= 8) ? 'moderate' : 'light';
  const carbsPerKg = { rest: [3, 5], light: [3, 5], moderate: [5, 7], high: [6, 10] }[load];
  const protPerKg = goal === 'gain' ? [1.6, 2.2] : [1.4, 2.0];
  return {
    weight: kg, goal, load, km: Math.round(km * 10) / 10, rpe: rpe || null, trainings: ws.length,
    protein: kg ? [r0(protPerKg[0] * kg), r0(protPerKg[1] * kg)] : null,
    carbs: kg ? [r0(carbsPerKg[0] * kg), r0(carbsPerKg[1] * kg)] : null,
    protein_per_kg: protPerKg, carbs_per_kg: carbsPerKg,
  };
}
const LOAD_RU = { rest: 'день без тренировки', light: 'лёгкая тренировка', moderate: 'средняя нагрузка', high: 'тяжёлый день' };

function mealOut(m) {
  return {
    id: m.id, date: day(m), time: m.time, title: m.title, kcal: m.kcal,
    protein: m.protein == null ? null : Number(m.protein), fat: m.fat == null ? null : Number(m.fat), carbs: m.carbs == null ? null : Number(m.carbs),
    items: m.items || [], thumb: m.thumb,
  };
}

router.get('/food', async (req, res) => {
  const today = getClientToday(req);
  const date = isValidDate(req.query.date) ? req.query.date : today;
  const [meals, note] = await Promise.all([
    query('SELECT * FROM meals WHERE user_id = $1 AND date = $2 ORDER BY time NULLS LAST, id', [req.me.id, date]),
    query('SELECT text FROM food_notes WHERE user_id = $1 AND date = $2', [req.me.id, date]),
  ]);
  const list = meals.rows.map(mealOut);
  const sum = (k) => r0(list.reduce((a, m) => a + (Number(m[k]) || 0), 0));
  res.json({
    date, meals: list,
    totals: { kcal: sum('kcal'), protein: sum('protein'), fat: sum('fat'), carbs: sum('carbs') },
    targets: await dayTargets(req.me.id, date),
    fom: note.rows[0]?.text || null,
  });
});

router.post('/food/scan', async (req, res) => {
  const image = req.body.image || null;
  const text = txt(req.body.text, 300);
  if (image && (typeof image !== 'string' || !IMG_RE.test(image) || image.length > 3_500_000)) return res.status(400).json({ error: 'Не получилось прочитать фото' });
  if (!image && !text) return res.status(400).json({ error: 'Сфотографируй еду или опиши её' });
  if (!scanAllowed(req.me.id, 'food', 25)) return res.status(429).json({ error: 'На сегодня распознаваний хватит — впиши цифры вручную' });
  try {
    const p = await scanFood({ image, text });
    const items = (Array.isArray(p.items) ? p.items : []).slice(0, 20).map((x) => ({
      name: txt(x.name, 60), grams: num(x.grams, 0, 5000),
      kcal: r0(num(x.kcal, 0, 10000)), protein: r0(num(x.protein, 0, 1000)), fat: r0(num(x.fat, 0, 1000)), carbs: r0(num(x.carbs, 0, 2000)),
    })).filter((x) => x.name);
    const sum = (k) => r0(items.reduce((a, x) => a + x[k], 0));
    res.json({
      title: txt(p.title, 60) || 'Приём пищи', items,
      kcal: items.length ? sum('kcal') : r0(num(p.kcal, 0, 10000)),
      protein: items.length ? sum('protein') : r0(num(p.protein, 0, 1000)),
      fat: items.length ? sum('fat') : r0(num(p.fat, 0, 1000)),
      carbs: items.length ? sum('carbs') : r0(num(p.carbs, 0, 2000)),
      confidence: ['low', 'medium', 'high'].includes(p.confidence) ? p.confidence : 'medium',
      note: txt(p.note, 160),
    });
  } catch (err) {
    console.error('Food scan failed:', err.message);
    res.status(502).json({ error: 'Fom не смог оценить еду — попробуй ещё раз или впиши вручную' });
  }
});

router.post('/food', async (req, res) => {
  const b = req.body || {};
  const today = getClientToday(req);
  const date = isValidDate(b.date) && b.date <= today ? b.date : today;
  const thumb = typeof b.thumb === 'string' && IMG_RE.test(b.thumb) && b.thumb.length <= 60000 ? b.thumb : null;
  const time = /^\d{2}:\d{2}$/.test(String(b.time || '')) ? b.time : null;
  const n = await query('SELECT count(*)::int AS n FROM meals WHERE user_id = $1 AND date = $2', [req.me.id, date]);
  if (n.rows[0].n >= 15) return res.status(400).json({ error: 'За день уже 15 приёмов пищи' });
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 20).map((x) => ({ name: txt(x.name, 60), grams: num(x.grams, 0, 5000) })).filter((x) => x.name);
  const r = await query(
    `INSERT INTO meals (user_id, date, time, title, kcal, protein, fat, carbs, items, thumb)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [req.me.id, date, time, txt(b.title, 60) || 'Приём пищи', r0(num(b.kcal, 0, 10000)), num(b.protein, 0, 1000) ?? 0, num(b.fat, 0, 1000) ?? 0, num(b.carbs, 0, 2000) ?? 0, JSON.stringify(items), thumb]);
  await query('DELETE FROM food_notes WHERE user_id = $1 AND date = $2', [req.me.id, date]); // день изменился — старый вывод Fom уже не про него
  res.json({ meal: mealOut(r.rows[0]) });
});

router.delete('/food/:id', async (req, res) => {
  const r = await query('DELETE FROM meals WHERE id = $1 AND user_id = $2 RETURNING date', [parseInt(req.params.id, 10) || 0, req.me.id]);
  if (r.rows[0]) await query('DELETE FROM food_notes WHERE user_id = $1 AND date = $2', [req.me.id, r.rows[0].date]);
  res.json({ ok: true });
});

router.post('/food/fom', async (req, res) => {
  const today = getClientToday(req);
  const date = isValidDate(req.body.date) ? req.body.date : today;
  const meals = (await query('SELECT * FROM meals WHERE user_id = $1 AND date = $2 ORDER BY time NULLS LAST, id', [req.me.id, date])).rows.map(mealOut);
  if (!meals.length) return res.status(400).json({ error: 'За этот день ещё нет еды' });
  const t = await dayTargets(req.me.id, date);
  const sum = (k) => r0(meals.reduce((a, m) => a + (Number(m[k]) || 0), 0));
  const facts = [
    `Дата: ${date}${date === today ? ' (сегодня, день ещё не закончился)' : ''}.`,
    `Съедено по фото/записям (оценка): ${meals.length} ${meals.length % 10 === 1 && meals.length % 100 !== 11 ? 'приём' : [2, 3, 4].includes(meals.length % 10) && ![12, 13, 14].includes(meals.length % 100) ? 'приёма' : 'приёмов'} пищи — ${meals.map((m) => `${m.time ? m.time + ' ' : ''}${m.title} (≈${m.kcal} ккал, Б ${r0(m.protein)} г)`).join('; ')}.`,
    `Итого ≈ ${sum('kcal')} ккал, белок ≈ ${sum('protein')} г, жиры ≈ ${sum('fat')} г, углеводы ≈ ${sum('carbs')} г.`,
    `Нагрузка дня (посчитано программой): ${LOAD_RU[t.load]}${t.trainings ? `, ${f1(t.km)} км, RPE до ${t.rpe ?? '-'}` : ''}.`,
    t.weight ? `Вес ${f1(t.weight)} кг. Ориентиры для спортсмена на такой день: белок ${t.protein[0]}–${t.protein[1]} г (${t.protein_per_kg.join('–')} г/кг), углеводы ${t.carbs[0]}–${t.carbs[1]} г (${t.carbs_per_kg.join('–')} г/кг).` : 'Вес не указан — ориентиры в граммах не посчитаны.',
    t.goal === 'gain' ? 'Цель на месяц: набрать массу.' : t.goal === 'loss' ? 'Цель на месяц: снизить вес.' : '',
  ].filter(Boolean).join('\n');
  try {
    const text = await getFoodDayComment(facts, await athleteContext(req.me.id));
    if (!text) throw new Error('пустой ответ');
    await query(`INSERT INTO food_notes (user_id, date, text) VALUES ($1, $2, $3) ON CONFLICT (user_id, date) DO UPDATE SET text = EXCLUDED.text`, [req.me.id, date, text]);
    res.json({ fom: text });
  } catch (err) {
    console.error('Food comment failed:', err.message);
    res.status(502).json({ error: 'Fom сейчас не ответил — попробуй через минуту' });
  }
});

// ======================= БАДЫ =======================
router.get('/supps', async (req, res) => {
  const r = await query('SELECT id, name, dose, note, to_char(created_at, \'YYYY-MM-DD\') AS since FROM supplements WHERE user_id = $1 AND active ORDER BY id', [req.me.id]);
  res.json({ supps: r.rows });
});
router.post('/supps', async (req, res) => {
  const name = txt(req.body.name, 60);
  if (!name) return res.status(400).json({ error: 'Напиши название' });
  const n = await query('SELECT count(*)::int AS n FROM supplements WHERE user_id = $1 AND active', [req.me.id]);
  if (n.rows[0].n >= 20) return res.status(400).json({ error: 'Уже 20 добавок в списке' });
  const r = await query('INSERT INTO supplements (user_id, name, dose, note) VALUES ($1, $2, $3, $4) RETURNING id, name, dose, note',
    [req.me.id, name, txt(req.body.dose, 60), txt(req.body.note, 200)]);
  res.json({ supp: r.rows[0] });
});
router.delete('/supps/:id', async (req, res) => {
  await query('UPDATE supplements SET active = FALSE WHERE id = $1 AND user_id = $2', [parseInt(req.params.id, 10) || 0, req.me.id]);
  res.json({ ok: true });
});

export default router;
