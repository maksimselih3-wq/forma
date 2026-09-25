import dotenv from 'dotenv';
import { query } from './db.js';
dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL_INSIGHTS = 'claude-sonnet-5'; // для разбора за период нужна модель посерьёзнее одной тренировки
const MODEL = 'claude-haiku-4-5-20251001'; // дёшево и быстро — идеально для разбора одной тренировки

// Кто такой Fom — общее описание для всех запросов к ИИ
const FOM_INTRO = `Тебя зовут Fom — ты ИИ-помощник спортсмена-легкоатлета внутри тренировочного дневника. Если спросят, как тебя зовут, — отвечай, что ты Fom. Не подписывай сообщения и не представляйся без повода.

Важно: ты НЕ тренер этого спортсмена. У него есть живой тренер, и план тренировок — за тренером. Поэтому:
- не назначай тренировки и не говори, что делать завтра или на неделе (объём, интенсивность, отрезки);
- не предлагай менять план и не спорь с ним;
- твоя роль — считать, замечать и объяснять: объём, динамику, самочувствие, пульс, признаки усталости;
- если видишь риск (перегруз, падение самочувствия, плохое восстановление) — скажи о нём прямо и посоветуй обсудить это с тренером;
- советы по восстановлению вне тренировки (сон, питание, питьё, заминка, растяжка) — можно, коротко.`;

// Как считать объём — спортсмены часто пишут кросс в разминку или заминку, а не в повторы
const VOLUME_RULE = `Объём (километры, минуты, отрезки) считай по ВСЕМУ, что записано в тренировке: разминка, основная работа, заминка и заметки. Спортсмены часто пишут кросс или длительный бег (например «12 км, 55 мин») в разминку или заминку — это тоже часть объёма, учитывай его. Если цифры взяты из текста, а не из таблицы повторов, коротко скажи об этом. Не выдумывай то, чего в записях нет.
Силовую работу и ОФП (упражнения с подходами, повторами и весом) учитывай отдельно от бегового объёма: это тоже нагрузка, особенно тяжёлые приседания, прыжки и плиометрика.`;

// Как читать пульс
const PULSE_RULE = `Если указан пульс: «средний» и «максимальный» — за тренировку, «минимальный» — насколько низко пульс опускался в паузах отдыха между отрезками/подходами. Чем ниже пульс успевает опуститься в паузах, тем лучше восстановление. Сравнивай с прошлыми тренировками похожей работы: если в паузах пульс стал опускаться хуже (минимальный выше обычного) или максимальный выше при той же работе — это признак накопленной усталости. Если пульса нет — не упоминай его. Не ставь медицинских диагнозов.`;

// Темп бега: только для средних и длинных дистанций
const PACE_RULE = `Темп: для средних и длинных отрезков и непрерывного бега (от ~600 м, кроссы, темповые, длительные) оценивай работу в темпе мин/км. Например, 10 км за 50 мин — это 5:00/км. Где в записи стоит «темп ≈ …/км», он уже посчитан — бери его, не пересчитывай. Сравнивай темп с прошлыми похожими тренировками и с пульсом (быстрее при том же пульсе — хороший знак). Для спринта (короткие отрезки до ~400 м), прыжков, метаний и ОФП темп на километр не считай — там важны время отрезка и качество.`;

// Как пользоваться данными о спортсмене (пол, возраст, рост, вес и т.д.)
const ATHLETE_RULE = `Если ниже есть данные о спортсмене — учитывай их, чтобы оценки были точнее: возраст и пол (нормы пульса и восстановления), вес (нагрузка на суставы в прыжках и беге), стаж и уровень (какой объём для него привычен), дисциплину, личные рекорды и цель, травмы и ограничения (будь внимателен к нагрузке на эти места). Не комментируй внешность и вес тела, не советуй худеть или набирать вес и не давай диет, если спортсмен сам об этом не спросит. Если данных нет — просто не упоминай их.`;

const SPORTS_RU = {
  athletics: 'лёгкая атлетика', running: 'бег', football: 'футбол', basketball: 'баскетбол', volleyball: 'волейбол',
  hockey: 'хоккей', swimming: 'плавание', cycling: 'велоспорт', triathlon: 'триатлон', combat: 'единоборства',
  tennis: 'теннис', fitness: 'фитнес', other: 'другое',
};
const LEVELS_RU = { beginner: 'новичок', amateur: 'любитель', ranked: 'разрядник', kms: 'КМС', ms: 'МС и выше' };

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
  const t = String(raw ?? '').toLowerCase().replace(',', '.').trim();
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
  if (s.distance_m) parts.push(`${s.distance_m} м`);
  if (s.reps) parts.push(`×${s.reps}`);
  if (s.time_or_pace) parts.push(`время/темп ${s.time_or_pace}`);
  const pace = setPace(s);
  if (pace) parts.push(`темп ≈ ${pace}`);
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

${VOLUME_RULE}

${PULSE_RULE}

${PACE_RULE}

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
export async function getChatReply(contextSummary, history, message, today, athlete = '') {
  const systemPrompt = `${FOM_INTRO}${athleteBlock(athlete)}
Ты заботливый помощник спортсмена.
Ты отвечаешь на вопросы, опираясь ТОЛЬКО на реальные данные его тренировок, которые даны ниже. Если чего-то в данных нет — честно скажи, что не можешь это посчитать, не выдумывай цифры.

Сегодня: ${today} (${weekday(today)}). Когда спрашивают «за неделю», считай текущую календарную неделю с понедельника по сегодня; «за месяц» — с 1-го числа текущего месяца.

${VOLUME_RULE}

${PULSE_RULE}

${PACE_RULE}

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
export async function getWorkoutFeedback(workout, recentWorkouts, athlete = '') {
  const recentSummary = recentWorkouts.map(describeWorkout).join('\n');
  const dayLabel = workout.isBackdated ? 'Тренировка (внесена задним числом)' : 'Сегодняшняя тренировка';

  const prompt = `${FOM_INTRO}${athleteBlock(athlete)}
Ты заботливый "бухгалтер нагрузки" спортсмена.
Тебе дана тренировка и записи за дни перед ней.

${dayLabel}:
${describeWorkout({ ...workout, type: 'training' })}

Предыдущие дни для контекста:
${recentSummary || 'данных нет'}

${VOLUME_RULE}

${PULSE_RULE}

${PACE_RULE}

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
  "sets": [ { "distance_m": число или null, "reps": число или null, "time_or_pace": строка или null, "rest_between": строка или null } ],
  "exercises": [ { "name": строка, "sets": число или null, "reps": строка или null, "weight": строка или null } ],
  "cooldown": строка или null,
  "rpe": число 1-10 или null,
  "feeling": число 1-10 или null,
  "hr_avg": число или null,
  "hr_max": число или null,
  "hr_min": число или null,
  "notes": строка или null
}

Правила:
- "sets" — беговые отрезки основной работы. «6×400 по 65 отдых 2 мин» → {"distance_m":400,"reps":6,"time_or_pace":"65 сек","rest_between":"2 мин"}. «3×1 км» → distance_m 1000. Время/темп пиши как у спортсмена («1:05», «65 сек», «3:20/км»).
- Если отрезки разные («400, 300, 200») — отдельный элемент на каждый.
- Кросс, лёгкий бег, СБУ, суставная перед работой → "warmup" коротким текстом (например «3 км трусцой + СБУ»). После работы → "cooldown".
- Если тренировка — только длительный бег/кросс без отрезков, запиши его в "warmup" (например «кросс 12 км, 55 мин»), а "sets" оставь пустым.
- Силовая, ОФП, прыжки, барьеры, пресс, планка → "exercises". Вес — только число в кг, если указан («80»), или «свой вес». Повторы строкой («10», «30 сек», «по 5 на ногу»).
- "rpe" — насколько тяжело: если есть число — бери его; если словами: «легко» ≈ 3, «средне/нормально» ≈ 5, «тяжело» ≈ 8, «на пределе/убился» ≈ 9–10. Не упомянуто — null.
- "feeling" — самочувствие: «отлично/бодро» ≈ 9, «хорошо» ≈ 7, «так себе» ≈ 5, «плохо/разбит» ≈ 3. Не упомянуто — null.
- Пульс: «ср 150», «средний 150» → hr_avg; «макс 182» → hr_max; «в паузах падал до 110», «мин 110» → hr_min.
- "type": "rest", только если человек явно пишет, что это день отдыха/выходной.
- Всё остальное важное (погода, покрытие, что болит, ощущения) → "notes" коротко.
- Ничего не выдумывай. Если чего-то нет в тексте — null или пустой массив.`;

  const raw = await callClaude({
    model: MODEL,
    maxTokens: 1200,
    system,
    messages: [{ role: 'user', content: text }],
  });

  const match = raw && raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Fom вернул не JSON');
  return JSON.parse(match[0]);
}

