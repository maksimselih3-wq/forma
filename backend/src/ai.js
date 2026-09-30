import dotenv from 'dotenv';
import { query } from './db.js';
dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL_INSIGHTS = 'claude-sonnet-5'; // для разбора за период нужна модель посерьёзнее одной тренировки
const MODEL = 'claude-haiku-4-5-20251001'; // дёшево и быстро — идеально для разбора одной тренировки

// Кто такой Fom — общее описание для всех запросов к ИИ
const FOM_INTRO = `Тебя зовут Fom — ты помощник спортсмена-легкоатлета внутри тренировочного дневника. Если спросят, как тебя зовут, — отвечай, что ты Fom. Не подписывай сообщения и не представляйся без повода.

Важно: ты НЕ тренер этого спортсмена. У него есть живой тренер, и план тренировок — за тренером. Поэтому:
- не назначай тренировки и не говори, что делать завтра или на неделе (объём, интенсивность, отрезки);
- не предлагай менять план и не спорь с ним;
- твоя роль — считать, замечать и объяснять: объём, динамику, самочувствие, пульс, признаки усталости;
- если видишь риск (перегруз, падение самочувствия, плохое восстановление) — скажи о нём прямо и посоветуй обсудить это с тренером;
- советы по восстановлению вне тренировки (сон, питание, питьё, заминка, растяжка) — можно, коротко.`;

// Как считать объём — спортсмены часто пишут кросс в разминку или заминку, а не в повторы
const VOLUME_RULE = `Отрезки «по времени» (фартлек, вставки) — это работа по минутам: «1'» = минута, «30"» = секунды; если указан темп, примерная дистанция отрезка уже посчитана. Если вставки сделаны внутри кросса, они уже входят в его километры — не прибавляй их второй раз.
Объём (километры, минуты, отрезки) считай по ВСЕМУ, что записано в тренировке: разминка, основная работа, заминка и заметки. Спортсмены часто пишут кросс или длительный бег (например «12 км, 55 мин») в разминку или заминку — это тоже часть объёма, учитывай его. Если цифры взяты из текста, а не из таблицы повторов, коротко скажи об этом. Не выдумывай то, чего в записях нет.
Силовую работу и ОФП (упражнения с подходами, повторами и весом) учитывай отдельно от бегового объёма: это тоже нагрузка, особенно тяжёлые приседания, прыжки и плиометрика.`;

// Время тренировки: когда была и сколько прошло с прошлой
const TIME_RULE = `Если у тренировки указано время («время 18:00–19:30») — учитывай его: сколько часов прошло с конца прошлой тренировки (готовые цифры даны ниже, не пересчитывай) и в какое время суток спортсмену тренировки заходят лучше (по самочувствию и RPE). Отдых меньше ~12 часов после тяжёлой работы — повод отметить, что восстановиться могло не хватить; после лёгкой — это нормально. Если времени нет — не упоминай его и ничего не выдумывай.`;

// Как читать пульс
const ALT_RULE = `Если у тренировки указано место и высота («место: … высота ≈ 1240 м», «СБОР») — учитывай высоту. Примерно с 1000–1200 м и выше в первые 3–7 дней обычно выше пульс (и в покое, и на работе), тяжелее RPE и медленнее темп при той же нагрузке, хуже сон — это адаптация к высоте, а не спад формы; сравнивай такие тренировки между собой, а не с равниной. После возвращения со среднегорья отметь, как изменились результаты, но без обещаний. Дни на высоте уже посчитаны программой (ниже), не пересчитывай. Если места нет — не упоминай его и ничего не выдумывай.`;

export const SUPP_RULE = `БАДы, витамины, добавки: можешь рассказать общими словами, о чём спортсмену стоит подумать и почему (например, при плохом сне часто обсуждают магний; зимой — витамин D, лучше по анализу; при низком ферритине в анализах — железо, но только по назначению врача; белок — если не добирает с едой). Обязательно в каждом таком ответе:
1) решение о любой добавке и дозировке — только вместе с врачом или тренером;
2) каждый конкретный препарат нужно самому проверить в официальном сервисе РУСАДА list.rusada.ru — ты не можешь гарантировать, что он разрешён;
3) у БАДов есть риск загрязнения запрещёнными веществами — безопаснее продукты с независимой проверкой партий на допинг; ответственность за то, что попало в организм, лежит на спортсмене.
Никогда не называй конкретный бренд или препарат «точно разрешённым», не советуй рецептурные лекарства, гормоны и ничего из запрещённого списка ВАДА, не помогай «обойти» допинг-контроль.`;

const HEALTH_RULE = `Анализы и здоровье: ты не врач и не ставишь диагнозов. Можешь объяснить простыми словами, что обычно означает показатель, и связать его с нагрузкой (например, КФК после тяжёлых тренировок часто повышена; у бегунов на выносливость нередко снижен ферритин; после высоты меняется гемоглобин). Если показатель вне нормы лаборатории — спокойно скажи, что это стоит обсудить с врачом (спортивным врачом), без запугивания и без назначения лекарств.`;

const PULSE_RULE = `Если указан пульс: «средний» и «максимальный» — за тренировку, «минимальный» — насколько низко пульс опускался в паузах отдыха между отрезками/подходами. Чем ниже пульс успевает опуститься в паузах, тем лучше восстановление. Сравнивай с прошлыми тренировками похожей работы: если в паузах пульс стал опускаться хуже (минимальный выше обычного) или максимальный выше при той же работе — это признак накопленной усталости. Если пульса нет — не упоминай его. Не ставь медицинских диагнозов.`;

// Темп бега: только для средних и длинных дистанций
const PACE_RULE = `Темп: для средних и длинных отрезков и непрерывного бега (от ~600 м, кроссы, темповые, длительные) оценивай работу в темпе мин/км. Например, 10 км за 50 мин — это 5:00/км. Где в записи стоит «темп ≈ …/км», он уже посчитан — бери его, не пересчитывай. Сравнивай темп с прошлыми похожими тренировками и с пульсом (быстрее при том же пульсе — хороший знак). Для спринта (короткие отрезки до ~400 м), прыжков, метаний и ОФП темп на километр не считай — там важны время отрезка и качество.`;

// Старты (соревнования)
const COMP_RULE = `Если запись помечена как СТАРТ (соревнование) — это не обычная тренировка. Оцени результат: сравни с прошлыми стартами в этой дисциплине и с лучшими результатами спортсмена (если они есть ниже). Если это личный рекорд — обязательно отметь и порадуйся вместе с ним. Если результат хуже — без критики, коротко отметь, что могло повлиять (самочувствие, пульс, нагрузка в предыдущие дни), и не делай выводов за тренера.`;

// ---------- Результаты стартов ----------
// Прыжки и метания — «больше = лучше» (метры), бег и ходьба — «меньше = лучше» (время)
const FIELD_EVENT_RE = /прыж|длин|тройн|высот|шест|ядр|диск|копь|молот|метан|толк/i;
export function higherIsBetter(discipline) {
  return FIELD_EVENT_RE.test(discipline || '');
}
// «10.95» → 10.95 с, «1:58.4» → 118.4 с, «15:20,3» → 920.3 с, «7,12 м» → 7.12 м
export function parseResult(result, discipline) {
  const t = String(result || '').replace(/,/g, '.').trim();
  const token = t.match(/\d[\d:.]*/)?.[0];
  if (!token) return null;
  if (higherIsBetter(discipline)) {
    const n = parseFloat(token);
    return Number.isFinite(n) ? n : null;
  }
  const parts = token.split(':').map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return null;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}
// Ключ дисциплины для группировки: «100 м», «100м», «100 метров» — одно и то же
export function disciplineKey(d) {
  return String(d || '').toLowerCase().replace(/метр(ов|а)?/g, 'м').replace(/\s+/g, '').replace(/ё/g, 'е');
}
// Лучший результат в каждой дисциплине по списку записей
export function bestResults(workouts) {
  const best = {};
  for (const w of workouts) {
    const c = w.competition;
    if (!c?.discipline || !c?.result) continue;
    const v = parseResult(c.result, c.discipline);
    if (v == null) continue;
    const key = disciplineKey(c.discipline);
    const cur = best[key];
    const better = !cur || (higherIsBetter(c.discipline) ? v > cur.value : v < cur.value);
    if (better) best[key] = { value: v, discipline: c.discipline, result: c.result, date: String(w.date).slice(0, 10), name: c.name, id: w.id };
  }
  return Object.values(best);
}

// Как пользоваться данными о спортсмене (пол, возраст, рост, вес и т.д.)
const ATHLETE_RULE = `Если ниже есть данные о спортсмене — учитывай их, чтобы оценки были точнее: возраст и пол (нормы пульса и восстановления), вес (нагрузка на суставы в прыжках и беге), стаж и уровень (какой объём для него привычен), дисциплину, личные рекорды и цель, травмы и ограничения (будь внимателен к нагрузке на эти места). Не комментируй внешность и вес тела, не советуй худеть или набирать вес и не давай диет, если спортсмен сам об этом не спросит. Если данных нет — просто не упоминай их.`;

const SPORTS_RU = {
  athletics: 'лёгкая атлетика', running: 'бег', football: 'футбол', basketball: 'баскетбол', volleyball: 'волейбол',
  hockey: 'хоккей', swimming: 'плавание', cycling: 'велоспорт', triathlon: 'триатлон', combat: 'единоборства',
  tennis: 'теннис', fitness: 'фитнес', other: 'другое',
};
const LEVELS_RU = { beginner: 'новичок', amateur: 'любитель', ranked: 'разрядник', kms: 'КМС', ms: 'МС и выше' };

// ---------- Цели на месяц: прогресс для Fom ----------
export async function goalsFacts(userId) {
  const month = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 7);
  const g = await query(`SELECT * FROM goals WHERE user_id = $1 AND month = $2 ORDER BY id`, [userId, month]);
  if (!g.rows.length) return '';
  const need = g.rows.some((x) => ['volume', 'count'].includes(x.kind));
  const ws = need
    ? (await query(`SELECT w.type, w.warmup, w.cooldown, w.competition,
          COALESCE((SELECT json_agg(s.*) FROM workout_sets s WHERE s.workout_id = w.id), '[]') AS sets
        FROM workouts w WHERE w.user_id = $1 AND to_char(w.date, 'YYYY-MM') = $2`, [userId, month])).rows
    : [];
  const km = Math.round(ws.reduce((a, w) => a + volumeKm(w), 0) * 10) / 10;
  const cnt = ws.filter((w) => w.type === 'training').length;
  let weightNow = null;
  if (g.rows.some((x) => x.kind === 'weight')) {
    const w = await query(`SELECT kg FROM weight_log WHERE user_id = $1 ORDER BY date DESC LIMIT 1`, [userId]);
    weightNow = w.rows[0] ? Number(w.rows[0].kg) : null;
  }
  let best = [];
  if (g.rows.some((x) => x.kind === 'pb')) {
    const comps = await query(`SELECT id, date, competition FROM workouts WHERE user_id = $1 AND competition IS NOT NULL`, [userId]);
    let manual = [];
    try {
      const m = await query(`SELECT id, discipline, result FROM manual_records WHERE user_id = $1`, [userId]);
      manual = m.rows.map((x) => ({ id: `m${x.id}`, date: '1900-01-01', competition: { discipline: x.discipline, result: x.result } }));
    } catch (e) { /* нет таблицы */ }
    best = bestResults([...comps.rows, ...manual]);
  }
  const f = (n) => String(n).replace('.', ',');
  const items = g.rows.map((x) => {
    if (x.kind === 'volume') return `набегать ${f(Number(x.target_num))} км за месяц — сейчас ${f(km)} км`;
    if (x.kind === 'count') return `${Number(x.target_num)} тренировок за месяц — сейчас ${cnt}`;
    if (x.kind === 'pb') {
      const b = best.find((r) => disciplineKey(r.discipline) === disciplineKey(x.discipline));
      return `личный рекорд ${x.discipline}: цель ${x.target}${b ? `, сейчас лучший ${b.result}` : ', рекорда пока нет'}`;
    }
    if (x.kind === 'weight') {
      const dir = x.start_num != null && Number(x.target_num) < Number(x.start_num) ? 'похудеть' : 'набрать вес (мышечную массу)';
      return `${dir} до ${f(Number(x.target_num))} кг${x.start_num != null ? ` (в начале месяца ${f(Number(x.start_num))} кг)` : ''}${weightNow != null ? `, сейчас ${f(weightNow)} кг` : ''}`;
    }
    return `${x.title}${x.done ? ' — отмечена выполненной' : ''}`;
  });
  return `Цели на этот месяц (${month}), прогресс посчитан программой: ${items.join('; ')}. Когда уместно — связывай тренировки с этими целями: помогают ли они к ним идти. Питание и вес обсуждай бережно, без жёстких диет.`;
}

// ---------- Здоровье: что Fom знает об анализах, БАДах и питании ----------
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}
export function markerStatus(m) {
  const v = Number(m.value), lo = m.ref_low == null ? null : Number(m.ref_low), hi = m.ref_high == null ? null : Number(m.ref_high);
  if (!Number.isFinite(v)) return null;
  if (lo != null && Number.isFinite(lo) && v < lo) return 'low';
  if (hi != null && Number.isFinite(hi) && v > hi) return 'high';
  return lo != null || hi != null ? 'ok' : null;
}
export function markerLine(m) {
  const st = markerStatus(m);
  const ref = m.ref_low != null || m.ref_high != null ? ` (норма лаборатории ${m.ref_low ?? '…'}–${m.ref_high ?? '…'})` : '';
  return `${m.name} ${String(m.value).replace('.', ',')}${m.unit ? ' ' + m.unit : ''}${ref}${st === 'low' ? ' — НИЖЕ нормы' : st === 'high' ? ' — ВЫШЕ нормы' : ''}`;
}
export async function healthFacts(userId) {
  const out = [];
  try {
    const b = await query(`SELECT to_char(date, 'YYYY-MM-DD') AS date, markers FROM blood_tests
      WHERE user_id = $1 AND date >= CURRENT_DATE - 180 ORDER BY date DESC LIMIT 1`, [userId]);
    const t = b.rows[0];
    if (t) {
      const ms = Array.isArray(t.markers) ? t.markers : [];
      const off = ms.filter((m) => ['low', 'high'].includes(markerStatus(m)));
      out.push(`Последний анализ крови ${t.date}: ${ms.length} ${plural(ms.length, 'показатель', 'показателя', 'показателей')}${off.length ? `; вне нормы лаборатории: ${off.map(markerLine).join('; ')}` : ', все в норме лаборатории (или норма не указана)'}.`);
    }
  } catch (e) { /* нет таблицы */ }
  try {
    const s = await query(`SELECT name, dose FROM supplements WHERE user_id = $1 AND active ORDER BY id`, [userId]);
    if (s.rows.length) out.push(`Принимает (со слов спортсмена): ${s.rows.map((x) => x.name + (x.dose ? ` — ${x.dose}` : '')).join('; ')}.`);
  } catch (e) { /* нет таблицы */ }
  try {
    const m = await query(`SELECT to_char(date, 'YYYY-MM-DD') AS date, count(*)::int AS n, sum(kcal)::int AS kcal, round(sum(protein))::int AS protein, round(sum(carbs))::int AS carbs
      FROM meals WHERE user_id = $1 AND date >= CURRENT_DATE - 3 GROUP BY date ORDER BY date DESC`, [userId]);
    if (m.rows.length) out.push(`Питание по фото/записям (оценка, неполная — не всё сфотографировано): ${m.rows.map((x) => `${x.date}: ${x.n} ${plural(x.n, 'приём', 'приёма', 'приёмов')} пищи, ≈${x.kcal} ккал, белок ≈${x.protein} г, углеводы ≈${x.carbs} г`).join('; ')}.`);
  } catch (e) { /* нет таблицы */ }
  return out.join('\n');
}

// Картинка для Claude: data:image/jpeg;base64,... → блок image
function imageBlock(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('bad image');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}
function jsonFrom(raw) {
  const match = raw && raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Fom вернул не JSON');
  return JSON.parse(match[0]);
}

/** Бланк анализа крови (фото) → { date, lab, markers: [{ name, value, unit, ref_low, ref_high }] } */
export async function scanBloodImage(dataUrl) {
  const system = `Ты читаешь фото бланка анализа крови из лаборатории. Верни ТОЛЬКО JSON без пояснений:
{"date": "ГГГГ-ММ-ДД" или null, "lab": строка или null, "markers": [{"name": строка, "value": число, "unit": строка или null, "ref_low": число или null, "ref_high": число или null}]}
Правила: название показателя — по-русски, коротко, как на бланке («Гемоглобин», «Ферритин», «Витамин D (25-OH)»). value — только число (запятую замени точкой). Референсные значения бери с бланка: «120–160» → ref_low 120, ref_high 160; «< 5» → ref_low null, ref_high 5; «> 30» → ref_low 30, ref_high null. Дата — дата взятия материала. Ничего не выдумывай: чего не видно — null; нечитаемые строки пропускай. Если это не анализ — {"markers": []}.`;
  const raw = await callClaude({ model: MODEL_INSIGHTS, maxTokens: 2500, system, messages: [{ role: 'user', content: [imageBlock(dataUrl), { type: 'text', text: 'Разбери этот бланк.' }] }] });
  return jsonFrom(raw);
}

/** Еда (фото и/или описание) → оценка КБЖУ */
export async function scanFood({ image, text }) {
  const system = `Ты помогаешь спортсмену примерно оценить приём пищи по фото и/или описанию. Верни ТОЛЬКО JSON без пояснений:
{"title": короткое название по-русски, "items": [{"name": строка, "grams": число или null, "kcal": число, "protein": число, "fat": число, "carbs": число}], "kcal": число, "protein": число, "fat": число, "carbs": число, "confidence": "low"|"medium"|"high", "note": строка или null}
Правила: оценивай порцию по фото (тарелка, упаковка, рука), граммы белка/жиров/углеводов — целые числа, итог — сумма по items. Если подпись уточняет продукт или вес — верь подписи. Если на фото не еда — {"items": [], "kcal": 0, "protein": 0, "fat": 0, "carbs": 0, "title": "Не похоже на еду", "confidence": "low"}. note — одно короткое замечание, если оценка очень неточная (например, «соус не виден»), иначе null. Без оценок «хорошо/плохо».`;
  const content = [];
  if (image) content.push(imageBlock(image));
  content.push({ type: 'text', text: text ? `Подпись спортсмена: ${String(text).slice(0, 300)}` : 'Оцени этот приём пищи.' });
  const raw = await callClaude({ model: MODEL, maxTokens: 900, system, messages: [{ role: 'user', content }] });
  return jsonFrom(raw);
}

/**
 * Короткая справка о спортсмене для Fom: пол, возраст, рост, вес, пульс покоя, стаж, уровень,
 * вид спорта, рекорды, цель, травмы. Эти данные видит только сам спортсмен и Fom.
 */
// «1 год», «3 года», «21 год», «15 лет»
function yearsRu(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  const w = a > 10 && a < 20 ? 'лет' : b === 1 ? 'год' : b >= 2 && b <= 4 ? 'года' : 'лет';
  return `${n} ${w}`;
}

export async function athleteContext(userId) {
  try {
    const u = await query('SELECT sport, discipline FROM users WHERE id = $1', [userId]);
    let p = {};
    try {
      const r = await query('SELECT * FROM athlete_profiles WHERE user_id = $1', [userId]);
      p = r.rows[0] || {};
    } catch (e) { /* таблицы ещё нет — не страшно */ }
    const sport = u.rows[0]?.sport;
    const discipline = u.rows[0]?.discipline;
    const parts = [];
    if (p.sex) parts.push(p.sex === 'f' ? 'женщина' : 'мужчина');
    if (p.birth_year) parts.push(`возраст ${yearsRu(new Date().getFullYear() - p.birth_year)}`);
    if (p.height_cm) parts.push(`рост ${p.height_cm} см`);
    if (p.weight_kg) parts.push(`вес ${Number(p.weight_kg)} кг`);
    if (p.rest_hr) parts.push(`пульс в покое ${p.rest_hr}`);
    if (p.experience_years != null) parts.push(`стаж ${yearsRu(p.experience_years)}`);
    if (p.level) parts.push(`уровень: ${LEVELS_RU[p.level] || p.level}`);
    if (sport) parts.push(`вид спорта: ${SPORTS_RU[sport] || sport}${discipline ? ' — ' + discipline : ''}`);
    const lines = [];
    if (parts.length) lines.push(parts.join(', '));
    if (p.records) lines.push(`Личные рекорды: ${p.records}`);
    if (p.goal) lines.push(`Цель: ${p.goal}`);
    if (p.injuries) lines.push(`Травмы и ограничения: ${p.injuries}`);
    // лучшие результаты на стартах, которые спортсмен записал в дневник
    try {
      const comps = await query(`SELECT id, date, competition FROM workouts WHERE user_id = $1 AND competition IS NOT NULL`, [userId]);
      let manual = [];
      try {
        const m = await query(`SELECT id, discipline, result, note, to_char(date, 'YYYY-MM-DD') AS date FROM manual_records WHERE user_id = $1`, [userId]);
        manual = m.rows.map((x) => ({ id: `m${x.id}`, date: x.date || '1900-01-01', competition: { discipline: x.discipline, result: x.result, name: x.note } }));
      } catch (e) { /* таблицы ещё нет */ }
      const best = bestResults([...comps.rows, ...manual]);
      if (best.length) lines.push(`Личные рекорды (со стартов в дневнике и внесённые вручную): ${best.map((b) => `${b.discipline} — ${b.result}${b.date && b.date !== '1900-01-01' ? ` (${b.date})` : ''}`).join('; ')}`);
    } catch (e) { /* колонки ещё нет — не страшно */ }
    // цели на месяц и как они идут (прогресс посчитан программой)
    try {
      const g = await goalsFacts(userId);
      if (g) lines.push(g);
    } catch (e) { /* таблицы ещё нет */ }
    // ближайшие старты из календаря
    try {
      const st = await query(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, name, discipline, goal FROM planned_starts
         WHERE user_id = $1 AND date >= CURRENT_DATE ORDER BY date LIMIT 3`, [userId]);
      if (st.rows.length) {
        lines.push(`Ближайшие старты: ${st.rows.map((x) => `${x.date} — ${x.name}${x.discipline ? `, ${x.discipline}` : ''}${x.goal ? `, цель ${x.goal}` : ''}`).join('; ')}`);
      }
    } catch (e) { /* таблицы ещё нет */ }
    // утренние отметки: сон, пульс покоя, самочувствие (1–5)
    try {
      const mc = await query(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, sleep_h, rest_hr, mood FROM morning_checks
         WHERE user_id = $1 AND date >= CURRENT_DATE - 14 ORDER BY date DESC`, [userId]);
      if (mc.rows.length) {
        const fmt = (x) => [x.sleep_h != null && `сон ${Number(x.sleep_h)} ч`, x.rest_hr && `пульс покоя ${x.rest_hr}`, x.mood && `самочувствие ${x.mood}/5`].filter(Boolean).join(', ');
        lines.push(`Утренние отметки (свежие сверху): ${mc.rows.slice(0, 7).map((x) => `${x.date}: ${fmt(x)}`).join('; ')}`);
        const hrs = mc.rows.map((x) => x.rest_hr).filter(Boolean);
        if (hrs.length >= 5) {
          const recent = hrs.slice(0, 3), base = hrs.slice(3);
          const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
          if (recent.length === 3 && base.length >= 2 && avg(recent) - avg(base) >= 5) {
            lines.push(`Внимание: пульс покоя последние 3 дня в среднем на ${Math.round(avg(recent) - avg(base))} уд/мин выше обычного — возможно, организм не восстановился или начинается болезнь.`);
          }
        }
      }
    } catch (e) { /* таблицы ещё нет */ }
    // здоровье: последний анализ крови, БАДы, питание за 3 дня
    try {
      const h = await healthFacts(userId);
      if (h) lines.push(h);
    } catch (e) { /* таблиц ещё нет */ }
    return lines.join('\n');
  } catch (err) {
    console.error('Athlete context failed:', err.message);
    return '';
  }
}

function athleteBlock(athlete) {
  return athlete ? `\n\nО спортсмене:\n${athlete}\n\n${ATHLETE_RULE}` : '';
}

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function weekday(dateStr) {
  return WEEKDAYS[new Date(dateStr + 'T00:00:00Z').getUTCDay()];
}

// ---------- Темп ----------
// «1:05» → 65, «65 сек» → 65, «57-58 с» → 57.5, «4 мин 10 с» → 250, «1:02:30» → 3750, «3 мин» → 180
export function parseSeconds(raw) {
  const t = String(raw ?? '').toLowerCase().replace(',', '.').replace(/[′’]/g, "'").replace(/[″”]/g, '"').trim();
  if (!t || /\/\s*км|мин\s*\/|в\s*км/.test(t)) return null; // уже темп на км — не считаем
  const hms = t.match(/(\d+):(\d{2})(?::(\d{2}))?/);
  if (hms) {
    const [a, b, c] = [Number(hms[1]), Number(hms[2]), hms[3] != null ? Number(hms[3]) : null];
    return c != null ? a * 3600 + b * 60 + c : a * 60 + b;
  }
  const range = t.match(/(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)/);
  const pick = (re) => { const m = t.match(re); return m ? Number(m[1]) : 0; };
  // \b с русскими буквами не работает — поэтому «после буквы не идёт другая буква»
  let min = pick(/(\d+(?:\.\d+)?)\s*(?:мин|m(?![a-zа-яё])|')/);
  let sec = pick(/(\d+(?:\.\d+)?)\s*(?:сек|с(?![a-zа-яё])|s(?![a-zа-яё])|")/);
  if (min && !sec) { const tail = t.match(/'\s*(\d{1,2})$/); if (tail) sec = Number(tail[1]); } // «1'30» без кавычек
  if (range && !/мин/.test(t)) sec = (Number(range[1]) + Number(range[2])) / 2;
  if (!min && !sec) {
    const n = t.match(/^(\d+(?:\.\d+)?)$/);
    if (n) sec = Number(n[1]);
  }
  const total = min * 60 + sec;
  return total > 0 ? total : null;
}

// Темп мин/км: 330 с на 1000 м → «5:30/км»
export function paceLabel(seconds, meters) {
  if (!seconds || !meters) return null;
  const perKm = Math.round(seconds / (meters / 1000));
  if (perKm < 100 || perKm > 1200) return null; // быстрее 1:40/км или медленнее 20:00/км — скорее ошибка ввода
  return `${Math.floor(perKm / 60)}:${String(perKm % 60).padStart(2, '0')}/км`;
}

// Темп для средних и длинных отрезков (от 600 м). Спринт — без темпа на км.
function setPace(s) {
  const m = Number(s.distance_m);
  if (!m || m < 600) return null;
  return paceLabel(parseSeconds(s.time_or_pace), m);
}

// «60» → «1'», «90» → «1'30"», «30» → «30"»
export function durLabel(sec) {
  sec = Math.round(Number(sec) || 0);
  const m = Math.floor(sec / 60), r = sec % 60;
  return m ? `${m}'${r ? String(r).padStart(2, '0') + '"' : ''}` : `${r}"`;
}
// Вставка по времени в темпе «3:40» → примерно сколько метров (темп 2:00–9:00 на км)
function durationMeters(s) {
  const pace = parseSeconds(String(s.time_or_pace || '').replace(/\/\s*км|мин\s*\/\s*км|в\s*км/gi, ''));
  if (!s.duration_s || !pace || pace < 120 || pace > 540) return null;
  return Math.round(((s.duration_s / pace) * 1000) / 10) * 10;
}

// Кроссы и длительные в тексте: «10 км за 50 мин», «12 км, 55 мин», «8 км 36:30» → считаем темп
export function textPaces(text) {
  const out = [];
  const re = /(\d+(?:[.,]\d+)?)\s*км[^\d\n]{0,12}?(\d{1,2}:\d{2}(?::\d{2})?|\d{1,3}(?:[.,]\d+)?\s*мин(?:ут[аыу]?)?(?:\s*\d{1,2}\s*(?:сек|с)(?![a-zа-яё]))?)/gi;
  for (const m of String(text || '').matchAll(re)) {
    const km = Number(m[1].replace(',', '.'));
    if (!km || km < 0.6 || km > 100) continue;
    const pace = paceLabel(parseSeconds(m[2]), km * 1000);
    if (pace) out.push(`${m[1]} км за ${m[2].trim()} → темп ≈ ${pace}`);
  }
  return out;
}

// Один повтор/отрезок одной строкой: «400 м ×6, время/темп 1:05, отдых 2 мин»
function formatSet(s) {
  const parts = [];
  if (s.duration_s) parts.push(`по времени ${durLabel(s.duration_s)} (${s.duration_s} с)`);
  else if (s.distance_m) parts.push(`${s.distance_m} м`);
  if (s.reps) parts.push(`×${s.reps}`);
  if (s.time_or_pace) parts.push(`время/темп ${s.time_or_pace}`);
  const pace = setPace(s);
  if (pace) parts.push(`темп ≈ ${pace}`);
  const approx = durationMeters(s);
  if (approx) parts.push(`≈ ${approx} м за отрезок`);
  if (s.rest_between) parts.push(`отдых ${s.rest_between}`);
  return parts.join(', ');
}

// Упражнение силовой/ОФП одной строкой: «присед 5×5, 80 кг»
function formatExercise(e) {
  let line = e.name || '';
  if (e.sets && e.reps) line += ` ${e.sets}×${e.reps}`;
  else if (e.sets) line += ` ${e.sets} подх.`;
  else if (e.reps) line += ` ×${e.reps}`;
  if (e.weight) line += `, ${e.weight}${/^[\d.,]+$/.test(e.weight) ? ' кг' : ''}`;
  return line.trim();
}

// ---------- Беговой объём: считаем программой, а не «в уме» у модели ----------
// Ровно так же, как в приложении (графики «Разбора», календарь, цели недели):
// отрезки (метры × повторы) + все «N км»/«N м» в разминке и заминке + дистанция старта.
// Метры из текста: «кросс 12 км», «3000 м», «3 000м», «ускорения 5×100 м», «6 по 400 м»
// (темп «3:40/км», «4:00 км» и минуты «мин» не считаются)
function textMeters(text) {
  const t = String(text || '').replace(/(\d)[\s ](\d{3})(?!\d)/g, '$1$2');
  const re = /(?:(\d{1,2})\s*(?:[x×х*]|по)\s*)?(?<![\d:.,])(\d+(?:[.,]\d+)?)\s*(км|km|м|m)(?![a-zа-яё])(?!\s*\/\s*[чсh])/gi;
  let m = 0;
  for (const x of t.matchAll(re)) {
    const val = Number(x[2].replace(',', '.'));
    const unit = x[3].toLowerCase();
    const mult = x[1] && Number(x[1]) > 0 && Number(x[1]) <= 50 ? Number(x[1]) : 1;
    if (unit === 'км' || unit === 'km') { if (val > 0 && val < 100) m += val * 1000 * mult; }
    else if (val >= 20 && val <= 30000) m += val * mult;
  }
  return m;
}
// Повторы: «10», «3×4» (серии × повторы)
function repsCount(r) {
  const s = String(r ?? '').trim();
  const x = /^(\d+)\s*[x×х*]\s*(\d+)$/i.exec(s);
  if (x) return Number(x[1]) * Number(x[2]);
  const n = parseInt(s, 10);
  return n > 0 ? n : 1;
}
export function volumeKm(w) {
  if (!w || w.type !== 'training') return 0;
  let m = 0;
  (Array.isArray(w.sets) ? w.sets : []).forEach((s) => { m += (Number(s.distance_m) || 0) * repsCount(s.reps); });
  m += textMeters([w.warmup, w.cooldown].filter(Boolean).join('\n'));
  // старт: дистанция из дисциплины («5000 м», «10 км»)
  if (w.competition && w.competition.discipline) m += textMeters(w.competition.discipline);
  return m / 1000;
}
const kmFmt = (km) => String(Math.round(km * 10) / 10).replace('.', ',');
function shiftDate(str, n) {
  const d = new Date(str + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOfStr(str) {
  const dow = new Date(str + 'T00:00:00Z').getUTCDay();
  return shiftDate(str, -((dow + 6) % 7));
}
function periodLine(label, workouts, from, to) {
  const list = workouts.filter((w) => { const d = String(w.date).slice(0, 10); return d >= from && d <= to; });
  const tr = list.filter((w) => w.type === 'training');
  const km = tr.reduce((a, w) => a + volumeKm(w), 0);
  const rest = list.filter((w) => w.type === 'rest').length;
  return `- ${label} (${from} — ${to}): беговой объём ${kmFmt(km)} км, тренировок ${tr.length}, дней отдыха ${rest}`;
}
/**
 * Готовые итоги по неделям — модель берёт их, а не складывает десятки чисел сама (так она ошибалась).
 * weeksBack — сколько прошлых календарных недель показать.
 */
export function volumeFacts(workouts, today, { weeksBack = 3, month = true, last7 = true } = {}) {
  if (!today) return '';
  const lines = [];
  const mon = mondayOfStr(today);
  lines.push(periodLine('текущая неделя, с понедельника по сегодня', workouts, mon, today));
  for (let i = 1; i <= weeksBack; i++) {
    const from = shiftDate(mon, -7 * i);
    lines.push(periodLine(i === 1 ? 'прошлая неделя' : `${i} недели назад`, workouts, from, shiftDate(from, 6)));
  }
  if (last7) lines.push(periodLine('последние 7 дней', workouts, shiftDate(today, -6), today));
  if (month) lines.push(periodLine('текущий месяц, с 1-го числа', workouts, today.slice(0, 8) + '01', today));
  return `ИТОГИ ОБЪЁМА — посчитаны программой точно так же, как в приложении (графики и календарь). Когда говоришь об объёме за неделю или месяц, бери цифры отсюда и НЕ пересчитывай их сам. Минуты «по времени» и ОФП сюда не входят — о них можно сказать отдельно.
${lines.join('\n')}`;
}

// ---------- Время тренировки ----------
function minutesOf(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? +m[1] * 60 + +m[2] : null;
}
function durText(min) {
  if (!(min > 0)) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} ч${m ? ` ${m} мин` : ''}` : `${m} мин`;
}
export function timeLabel(w) {
  const a = minutesOf(w.start_time), b = minutesOf(w.end_time);
  if (a == null) return '';
  let len = b != null ? b - a : null;
  if (len != null && len <= 0) len += 24 * 60; // закончилась после полуночи
  return `${w.start_time}${b != null ? `–${w.end_time}` : ''}${len ? ` (${durText(len)})` : ''}`;
}
// Момент начала/конца тренировки в минутах от «эпохи» (дата + время); без времени — null
function stamp(w, which) {
  const t = minutesOf(which === 'end' ? (w.end_time || w.start_time) : w.start_time);
  if (t == null) return null;
  return Math.round(Date.parse(String(w.date).slice(0, 10) + 'T00:00:00Z') / 60000) + t;
}
// Сколько часов отдыха было между прошлой тренировкой и этой (если у обеих есть время)
export function restGapText(workout, previous) {
  const prev = (previous || []).find((w) => w.type === 'training');
  if (!prev) return '';
  const a = stamp(prev, 'end'), b = stamp(workout, 'start');
  if (a == null || b == null || b <= a) {
    const days = Math.round((Date.parse(String(workout.date).slice(0, 10)) - Date.parse(String(prev.date).slice(0, 10))) / 86400000);
    return days > 0 ? `С прошлой тренировки (${String(prev.date).slice(0, 10)}) прошло ${days} дн. (точное время не указано).` : '';
  }
  const h = Math.round((b - a) / 6) / 10;
  return `Отдых с конца прошлой тренировки (${String(prev.date).slice(0, 10)}${prev.end_time ? ' до ' + prev.end_time : ''}, RPE ${prev.rpe ?? '-'}) до начала этой — ${String(h).replace('.', ',')} ч.`;
}
// В какое время суток тренировки заходят лучше: среднее самочувствие и RPE по утру / дню / вечеру
export function timeOfDayFacts(workouts) {
  const buckets = { 'утро (до 12:00)': [], 'день (12–17)': [], 'вечер (после 17:00)': [] };
  for (const w of workouts || []) {
    if (w.type !== 'training') continue;
    const t = minutesOf(w.start_time);
    if (t == null) continue;
    const k = t < 720 ? 'утро (до 12:00)' : t < 1020 ? 'день (12–17)' : 'вечер (после 17:00)';
    buckets[k].push(w);
  }
  const avg = (arr) => { const v = arr.filter((x) => x > 0); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1).replace('.', ',') : '-'; };
  const lines = Object.entries(buckets).filter(([, l]) => l.length)
    .map(([k, l]) => `${k}: ${l.length} трен., самочувствие в среднем ${avg(l.map((w) => Number(w.feeling)))}/10, RPE ${avg(l.map((w) => Number(w.rpe)))}/10`);
  return lines.length ? `Время тренировок (посчитано программой): ${lines.join('; ')}.` : '';
}

// Высота: какой по счёту день на высоте (от 1000 м) или сколько дней назад спустился.
// workout — текущая запись, previous — предыдущие записи (новые сначала).
export function altitudeFacts(workout, previous) {
  const HIGH = 1000;
  const high = (w) => w && w.type !== 'rest' && Number(w.altitude_m) >= HIGH;
  const day = (w) => String(w.date).slice(0, 10);
  const diff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
  const prev = (previous || []).filter((w) => w.type === 'training');
  if (high(workout)) {
    let first = day(workout);
    for (const w of prev) {
      if (!high(w) || diff(first, day(w)) > 3) break; // пропуск больше 3 дней — значит, был перерыв
      first = day(w);
    }
    const n = diff(day(workout), first) + 1;
    return `Высота (посчитано программой): тренировка на ≈${workout.altitude_m} м — ${n}-й день на высоте (первая запись на высоте ${first}).`;
  }
  const lastHigh = prev.find(high);
  if (lastHigh) {
    const ago = diff(day(workout), day(lastHigh));
    if (ago > 0 && ago <= 28) return `Высота (посчитано программой): спустился с высоты ≈${lastHigh.altitude_m} м (${lastHigh.place || 'сбор'}) ${ago} дн. назад.`;
  }
  return '';
}

// Коротко, что было на тренировке: «5×1000 по 3:05», «кросс 12 км», «старт 800 м — 2:05,3»
export function shortWorkout(w) {
  if (!w) return '';
  if (w.type === 'rest') return 'отдых';
  const c = w.competition;
  if (c && (c.discipline || c.result)) return `старт ${[c.discipline, c.result].filter(Boolean).join(' — ')}`;
  const sets = (Array.isArray(w.sets) ? w.sets : []).filter((x) => x.distance_m || x.duration_s);
  if (sets.length) {
    const x = sets[0];
    const what = x.duration_s ? durLabel(x.duration_s) : x.distance_m >= 1000 && x.distance_m % 100 === 0 ? `${String(x.distance_m / 1000).replace('.', ',')} км` : `${x.distance_m}`;
    const one = `${x.reps > 1 ? x.reps + '×' : ''}${what}${x.time_or_pace ? ' по ' + x.time_or_pace : ''}`;
    return sets.length > 1 ? `${one} + ещё ${sets.length - 1}` : one;
  }
  const t = String(w.warmup || w.notes || '').trim().split('\n')[0];
  if (t) return t.length > 40 ? t.slice(0, 38) + '…' : t;
  if ((w.exercises || []).length) return 'ОФП / силовая';
  return 'тренировка';
}

/**
 * Полное описание одной записи для ИИ: дата, день недели, разминка, повторы, заминка, RPE, самочувствие, заметка.
 * Используется и в отзыве после тренировки, и в разборе нагрузки, и в чате.
 */
export function describeWorkout(w) {
  const d = String(w.date).slice(0, 10);
  const head = `${d} (${weekday(d)})${w.session > 1 ? ', вторая тренировка дня' : ''}`;

  if (w.type === 'rest') {
    return `${head}: отдых${w.notes ? `, заметка: ${w.notes}` : ''}`;
  }

  const parts = [];
  const c = w.competition;
  if (c && (c.discipline || c.result)) {
    parts.push(`СТАРТ${c.name ? ` «${c.name}»` : ''}: ${[c.discipline, c.result && `результат ${c.result}`, c.place && `${c.place} место`].filter(Boolean).join(', ')}`);
  }
  const tl = timeLabel(w);
  if (tl) parts.push(`время ${tl}`);
  if (w.place || w.altitude_m != null) parts.push(`место: ${w.place || 'не указано'}${w.altitude_m != null ? `, высота ≈ ${w.altitude_m} м` : ''}${w.camp ? ', СБОР' : ''}`);
  if (w.warmup) parts.push(`разминка: ${w.warmup}`);
  const sets = (Array.isArray(w.sets) ? w.sets : []).map(formatSet).filter(Boolean);
  if (sets.length) parts.push(`беговая работа: ${sets.join('; ')}`);
  const exercises = (Array.isArray(w.exercises) ? w.exercises : []).map(formatExercise).filter(Boolean);
  if (exercises.length) parts.push(`силовая/ОФП: ${exercises.join('; ')}`);
  if (w.cooldown) parts.push(`заминка: ${w.cooldown}`);
  const pulse = [];
  if (w.hr_avg) pulse.push(`средний ${w.hr_avg}`);
  if (w.hr_max) pulse.push(`максимальный ${w.hr_max}`);
  if (w.hr_min) pulse.push(`минимальный в паузах ${w.hr_min}`);
  if (pulse.length) parts.push(`пульс (уд/мин): ${pulse.join(', ')}`);
  const km = volumeKm(w);
  if (km > 0) parts.push(`беговой объём записи ${kmFmt(km)} км`);
  parts.push(`RPE ${w.rpe ?? '-'}/10, самочувствие ${w.feeling ?? '-'}/10`);
  if (w.notes) parts.push(`заметка: ${w.notes}`);
  const paces = textPaces([w.warmup, w.cooldown, w.notes].filter(Boolean).join('\n'));
  if (paces.length) parts.push(`темп по тексту: ${paces.join('; ')}`);

  return `${head}: тренировка — ${parts.join(' | ')}`;
}

async function callClaude({ model, maxTokens, system, messages }) {
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text : null;
}

/**
 * Разбор нагрузки за период (неделя/месяц): тренды, риск перегруза, рекомендации.
 */
export async function getPeriodInsight(workouts, period, athlete = '') {
  const summary = workouts.map(describeWorkout).join('\n');

  const prompt = `${FOM_INTRO}${athleteBlock(athlete)}

Сейчас ты как помощник, который раз в ${period === 'month' ? 'месяц' : 'неделю'} делает разбор тренировочного процесса спортсмена, как бухгалтер сводит баланс.

Вот записи с начала ${period === 'month' ? 'текущего месяца' : 'текущей недели (с понедельника)'} по сегодня:
${summary || 'записей нет'}

Беговой объём за этот период (посчитан программой точно так же, как в приложении — бери это число и НЕ пересчитывай): ${kmFmt(workouts.reduce((a, w) => a + volumeKm(w), 0))} км. Минуты «по времени» и ОФП сюда не входят.
${timeOfDayFacts(workouts)}

${TIME_RULE}

${ALT_RULE}

${VOLUME_RULE}

${PULSE_RULE}

${PACE_RULE}

${COMP_RULE}

Дай структурированный разбор на русском, используя заголовки **жирным**:
**Объём и частота:** сколько тренировок и дней отдыха, общий беговой объём (км/минуты), есть ли баланс.
**Динамика нагрузки:** растёт ли RPE и объём, есть ли резкие скачки.
**Пульс и восстановление:** только если в записях есть пульс — как меняются средний/максимальный и насколько хорошо пульс опускается в паузах.
**Самочувствие:** как менялось, есть ли тревожные признаки (падающее самочувствие при растущей нагрузке).
**Риск перегрузки:** явно скажи, есть он или нет, и почему.
**Что обсудить с тренером:** 1-2 пункта — наблюдения, которые стоит показать тренеру. Не составляй план на будущее.

Пиши тепло, но по делу. Если данных мало — так и скажи, не выдумывай.`;

  return callClaude({
    model: MODEL_INSIGHTS,
    maxTokens: 900,
    messages: [{ role: 'user', content: prompt }],
  });
}

/**
 * Чат с Fom: отвечает на вопросы спортсмена, опираясь на его реальные записи.
 * history — предыдущие сообщения диалога (без текущего вопроса).
 * today — сегодняшняя дата пользователя 'ГГГГ-ММ-ДД'.
 */
export async function getChatReply(contextSummary, history, message, today, athlete = '', workouts = []) {
  const systemPrompt = `${FOM_INTRO}${athleteBlock(athlete)}
Ты заботливый помощник спортсмена.
Ты отвечаешь на вопросы, опираясь ТОЛЬКО на реальные данные его тренировок, которые даны ниже. Если чего-то в данных нет — честно скажи, что не можешь это посчитать, не выдумывай цифры.

Сегодня: ${today} (${weekday(today)}). Когда спрашивают «за неделю», имей в виду текущую календарную неделю с понедельника по сегодня; но если неделя только началась (сегодня понедельник или вторник) — скорее всего, человек спрашивает про прошлую полную неделю: назови её объём и коротко уточни, что текущая только началась. «За месяц» — с 1-го числа текущего месяца. Всегда называй, за какие даты цифра.

${VOLUME_RULE}

${PULSE_RULE}

${PACE_RULE}

${COMP_RULE}

${volumeFacts(workouts, today)}

${timeOfDayFacts(workouts)}

${TIME_RULE}

${ALT_RULE}

${SUPP_RULE}

${HEALTH_RULE}

Записи тренировок за последние 30 дней:
${contextSummary || 'записей нет'}

Если просят план или «что делать завтра» — можешь объяснить общие принципы, но прямо скажи, что конкретный план лучше согласовать с тренером.

Отвечай кратко и по делу, на русском, дружелюбным тоном. Если вопрос не про тренировки/восстановление/здоровье — можешь мягко напомнить, что ты помогаешь именно с этим.`;

  return callClaude({
    model: MODEL,
    maxTokens: 600,
    system: systemPrompt,
    messages: [...history, { role: 'user', content: message }],
  });
}

/**
 * Fom оценивает тренировку в контексте предыдущих дней
 * и даёт короткий фидбек + совет по восстановлению.
 */
export async function getWorkoutFeedback(workout, recentWorkouts, athlete = '', similar = null) {
  const recentSummary = recentWorkouts.map(describeWorkout).join('\n');
  const dayLabel = workout.isBackdated ? 'Тренировка (внесена задним числом)' : 'Сегодняшняя тренировка';

  const prompt = `${FOM_INTRO}${athleteBlock(athlete)}
Ты заботливый "бухгалтер нагрузки" спортсмена.
Тебе дана тренировка и записи за дни перед ней.

${dayLabel}:
${describeWorkout({ ...workout, type: 'training' })}

Предыдущие дни для контекста:
${recentSummary || 'данных нет'}
${restGapText(workout, recentWorkouts)}
${timeOfDayFacts([workout, ...recentWorkouts])}
${altitudeFacts(workout, recentWorkouts)}
${similar ? `\nПохожая тренировка раньше (та же основная работа):\n${describeWorkout(similar)}\nКоротко сравни с ней: время отрезков, пульс, RPE — стало лучше или хуже.\n` : ''}
${VOLUME_RULE}

${PULSE_RULE}

${PACE_RULE}

${COMP_RULE}

${TIME_RULE}

${ALT_RULE}

Дай ответ в 3-4 коротких предложения на русском:
1. Оценка этой тренировки в контексте предыдущих дней (хорошо выполнена / есть признаки перебора).
2. Если видишь риск перегрузки (высокий RPE несколько дней подряд, падающее самочувствие, резкий рост объёма, пульс в паузах опускается хуже обычного) — прямо укажи на это. Если указан пульс — коротко оцени восстановление в паузах.
3. ${workout.isBackdated ? 'Один короткий вывод по этой тренировке (она уже в прошлом).' : 'Одна короткая подсказка по восстановлению (сон, питание, заминка) — без указаний, как тренироваться дальше.'}
Пиши тепло, но по делу, без воды.`;

  return callClaude({
    model: MODEL,
    maxTokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
}

/**
 * Умный ввод: спортсмен пишет тренировку своими словами, Fom раскладывает её по полям формы.
 * Возвращает объект с полями формы (без проверки — её делает сервер в workouts.js).
 */
export async function parseWorkoutText(text) {
  const system = `Ты — помощник тренировочного дневника по лёгкой атлетике. Спортсмен описал тренировку своими словами. Разложи текст по полям и верни ТОЛЬКО JSON (без пояснений и без markdown) строго такого вида:
{
  "type": "training" или "rest",
  "warmup": строка или null,
  "sets": [ { "distance_m": число или null, "duration_s": число секунд или null, "reps": число или null, "time_or_pace": строка или null, "rest_between": строка или null } ],
  "exercises": [ { "name": строка, "sets": число или null, "reps": строка или null, "weight": строка или null } ],
  "cooldown": строка или null,
  "rpe": число 1-10 или null,
  "feeling": число 1-10 или null,
  "hr_avg": число или null,
  "hr_max": число или null,
  "hr_min": число или null,
  "notes": строка или null,
  "start_time": "ЧЧ:ММ" или null,
  "end_time": "ЧЧ:ММ" или null,
  "place": строка или null
}

Правила:
- "sets" — беговые отрезки основной работы. «6×400 по 65 отдых 2 мин» → {"distance_m":400,"reps":6,"time_or_pace":"65 сек","rest_between":"2 мин"}. «3×1 км» → distance_m 1000. Время/темп пиши как у спортсмена («1:05», «65 сек», «3:20/км»).
- Если отрезки разные («400, 300, 200») — отдельный элемент на каждый.
- Обозначения времени: «1'» = 1 минута, «30"» = 30 секунд, «1'30"» = 1 минута 30 секунд, «2'» = 2 минуты. Так же пиши их и в ответе (time_or_pace, rest_between): «1'», «30"».
- Отрезки ПО ВРЕМЕНИ (фартлек, вставки, «10 по 1 минуте») → "duration_s" в секундах, "distance_m": null. Темп вставки («в темпе 3:40») → "time_or_pace": «3:40/км». Отдых между ними («через 1' спокойно», «1 мин трусцой») → "rest_between".
- Вставки ВНУТРИ кросса («кросс 10 км, внутри 10 вставок по 1' в темпе 3:40 через 1' спокойно»): кросс → "warmup" («кросс 10 км с вставками»), вставки → "sets" по времени. Вставки уже входят в эти 10 км — не прибавляй их к объёму.
- Кросс, лёгкий бег, СБУ, суставная перед работой → "warmup" коротким текстом (например «3 км трусцой + СБУ»). После работы → "cooldown".
- Если тренировка — только длительный бег/кросс без отрезков, запиши его в "warmup" (например «кросс 12 км, 55 мин»), а "sets" оставь пустым.
- Силовая, ОФП, прыжки, барьеры, пресс, планка → "exercises". Вес — только число в кг, если указан («80»), или «свой вес». Повторы строкой («10», «30 сек», «по 5 на ногу»).
- "start_time"/"end_time" — во сколько была тренировка, если сказано: «в 18:00» → start_time "18:00"; «с 10 до 12» → "10:00" и "12:00"; «утром в 7» → "07:00". Не сказано — null.
- "place" — где была тренировка, если сказано: «в манеже» → "Манеж"; «на стадионе Лужники» → "Лужники"; «сбор в Кисловодске» → "Кисловодск". Коротко, с большой буквы. Не сказано — null.
- "rpe" — насколько тяжело: если есть число — бери его; если словами: «легко» ≈ 3, «средне/нормально» ≈ 5, «тяжело» ≈ 8, «на пределе/убился» ≈ 9–10. Не упомянуто — null.
- "feeling" — самочувствие: «отлично/бодро» ≈ 9, «хорошо» ≈ 7, «так себе» ≈ 5, «плохо/разбит» ≈ 3. Не упомянуто — null.
- Пульс: «ср 150», «средний 150» → hr_avg; «макс 182» → hr_max; «в паузах падал до 110», «мин 110» → hr_min.
- "type": "rest", только если человек явно пишет, что это день отдыха/выходной.
- Всё остальное важное (погода, покрытие, что болит, ощущения) → "notes" коротко.
- Ничего не выдумывай. Если чего-то нет в тексте — null или пустой массив.

Если текст начинается с «Тренировка из файла часов» — это круги (lap) с часов по порядку:
- Первые спокойные круги (помечены «разминка», или медленный темп и низкий пульс перед работой) → "warmup" одной строкой с суммой: «3,2 км, 16:10».
- Круги «работа» (или быстрые круги с высоким пульсом) → "sets". Подряд идущие одинаковые по дистанции работы объединяй в ОДИН элемент: reps = сколько их, time_or_pace = времена через запятую («1:05, 1:04, 1:03, 1:05»), если их не больше 10, иначе диапазон («1:02–1:06»).
- Круги «отдых»/«восстановление» между работами → "rest_between" у этих отрезков: время отдыха (например «1:30») и, если дистанция есть, «трусцой 200 м».
- Последние спокойные круги после работы → "cooldown" с суммой.
- Если работы нет (все круги похожи — автокруг по 1 км), это длительный/кросс: запиши в "warmup" итог («кросс 12,4 км, 58:30, 4:43/км»), "sets" пустой.
- Пульс за всю тренировку («Итого: … пульс ср … макс …») → hr_avg и hr_max. «Пульс в паузах» → hr_min.
- rpe и feeling из файла не бывает — оставь null.`;

  const raw = await callClaude({
    model: MODEL,
    maxTokens: 2000,
    system,
    messages: [{ role: 'user', content: text }],
  });

  const match = raw && raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Fom вернул не JSON');
  return JSON.parse(match[0]);
}



/**
 * Итоги недели от Fom — короткое сообщение в бота по воскресеньям.
 */
export async function getWeeklyDigest(workouts, athlete = '', name = '') {
  const summary = workouts.map(describeWorkout).join('\n');
  const prompt = `${FOM_INTRO}${athleteBlock(athlete)}
Подведи итоги недели спортсмена${name ? ` по имени ${name}` : ''} для короткого сообщения в Telegram.

Записи за неделю (пн–вс):
${summary}

Беговой объём за неделю (посчитан программой, как в приложении — бери это число, не пересчитывай): ${kmFmt(workouts.reduce((a, w) => a + volumeKm(w), 0))} км.

${VOLUME_RULE}

${PACE_RULE}

Формат — 4–6 коротких строк, без заголовков и markdown-звёздочек, можно 2–3 эмодзи:
- сколько тренировок и дней отдыха, примерный объём (км) и ОФП;
- лучшая или самая тяжёлая тренировка недели одной фразой;
- что заметил в самочувствии, пульсе, RPE (если есть данные);
- одна тёплая фраза-поддержка без советов, как тренироваться дальше.
Не выдумывай цифры, которых нет.`;
  return callClaude({ model: MODEL, maxTokens: 500, messages: [{ role: 'user', content: prompt }] });
}

// «Подпись» основной работы: одинаковые отрезки → похожие тренировки (например, «400x6»)
export function workSignature(sets) {
  const parts = (Array.isArray(sets) ? sets : [])
    .filter((x) => x.distance_m || x.duration_s)
    .map((x) => (x.duration_s ? `${x.duration_s}sx${x.reps || 1}` : `${x.distance_m}x${x.reps || 1}`));
  return parts.length ? parts.join('+') : null;
}

/**
 * Для тренера: короткий вывод по одному спортсмену (3–4 предложения).
 * facts — цифры, посчитанные программой; workouts — записи за 2 недели.
 */
export async function getCoachAthleteSummary(name, facts, workouts, athlete = '') {
  const prompt = `${FOM_INTRO}${athleteBlock(athlete)}
Сейчас ты пишешь не спортсмену, а его ТРЕНЕРУ — коротко, как ассистент тренера. Спортсмен: ${name}.

Цифры (посчитаны программой, бери их, не пересчитывай):
${facts}

Записи за последние 2 недели (новые сверху):
${workouts.map(describeWorkout).join('\n') || 'записей нет'}

${VOLUME_RULE}

${PULSE_RULE}

${TIME_RULE}

${ALT_RULE}

Напиши тренеру 3–4 коротких предложения на русском, без заголовков и markdown:
- что главное произошло за неделю (объём, интенсивность, самочувствие, сон, высота — только то, что есть в данных);
- есть ли признаки перегруза или недовосстановления, с конкретными цифрами и днями;
- о чём стоит поговорить со спортсменом (1 пункт).
Не составляй план и не давай указаний, как тренировать — решает тренер. Никаких диагнозов. Не выдумывай цифры.`;
  return callClaude({ model: MODEL, maxTokens: 350, messages: [{ role: 'user', content: prompt }] });
}

/**
 * Для тренера: сводка недели по всей группе. lines — по строке фактов на спортсмена.
 */
export async function getCoachTeamDigest(groupName, weekLabel, lines, totals) {
  const prompt = `${FOM_INTRO}
Сейчас ты пишешь ТРЕНЕРУ группы «${groupName}» сводку по его спортсменам за ${weekLabel}.

Итого по группе (посчитано программой): ${totals}

По спортсменам (посчитано программой; «флаги» — автоматические пометки):
${lines.join('\n') || 'данных нет'}

${ALT_RULE}

Формат — короткое сообщение без markdown-звёздочек, 3 блока, каждый с новой строки и эмодзи в начале:
⚠️ Обратить внимание — 1–4 спортсмена с конкретной причиной в цифрах (или «никого, неделя ровная»);
✅ Хорошее — рекорды, стабильность, прогресс (если есть);
🏔 На сборе — только если кто-то тренируется на высоте.
Каждый пункт — одна строка: «Имя — причина». Без плана и указаний, как тренировать. Не выдумывай ничего сверх данных.`;
  return callClaude({ model: MODEL, maxTokens: 500, messages: [{ role: 'user', content: prompt }] });
}

/**
 * Комментарий Fom к анализу крови: связь с нагрузкой перед сдачей, сравнение с прошлым анализом.
 */
export async function getBloodComment(test, prevTest, loadFacts, athlete = '') {
  const lines = (t) => (Array.isArray(t.markers) ? t.markers : []).map(markerLine).join('\n');
  const prompt = `${FOM_INTRO}${athleteBlock(athlete)}
Спортсмен внёс анализ крови. Помоги ему понять его в связи с тренировками.

Анализ от ${test.date}${test.lab ? ` (${test.lab})` : ''} — «ниже/выше нормы» посчитано программой по нормам лаборатории:
${lines(test)}
${prevTest ? `\nПрошлый анализ от ${prevTest.date}:\n${lines(prevTest)}\n` : ''}
Нагрузка за 3 недели до сдачи (посчитано программой):
${loadFacts || 'записей тренировок нет'}

${HEALTH_RULE}

${ALT_RULE}

Ответ на русском, 4–7 коротких строк без markdown-звёздочек:
- что вне нормы или заметно изменилось с прошлого раза (если есть прошлый) и что это обычно значит у спортсменов — простыми словами;
- могла ли на это повлиять нагрузка (объём, тяжёлые тренировки накануне, высота) — только если это правда следует из данных;
- что обсудить с врачом (если есть что) и когда может иметь смысл пересдать;
- если всё в норме — коротко порадуйся и скажи, какие показатели полезно отслеживать спортсмену.
Последней строкой: «Это не диагноз — решения по лечению и добавкам принимает врач.» Не назначай лекарств и доз.`;
  return callClaude({ model: MODEL_INSIGHTS, maxTokens: 700, messages: [{ role: 'user', content: prompt }] });
}

/**
 * Комментарий Fom к питанию за день: хватает ли энергии и белка под нагрузку и цели.
 */
export async function getFoodDayComment(dayFacts, athlete = '') {
  const prompt = `${FOM_INTRO}${athleteBlock(athlete)}
Спортсмен фотографирует еду, а программа примерно считает КБЖУ. Посмотри на его день.

${dayFacts}

Правила: цифры — грубая оценка по фото, и спортсмен мог сфотографировать не всё — помни об этом. Главное для спортсмена — чтобы еды хватало под нагрузку и восстановление; про недобор говори прямо, про «много» — бережно. Никаких жёстких диет, подсчёта «запрещённых» продуктов и стыда за еду. Если цель — набрать массу, а белка или энергии явно мало — скажи об этом и предложи 1–2 простые идеи, что добавить (обычная еда, не БАДы). Если цель — похудеть, не предлагай урезать еду в дни тяжёлых тренировок.

Ответ — 3–4 коротких предложения на русском, без markdown.`;
  return callClaude({ model: MODEL, maxTokens: 350, messages: [{ role: 'user', content: prompt }] });
}
