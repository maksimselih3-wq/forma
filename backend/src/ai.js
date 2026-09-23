import dotenv from 'dotenv';
dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL_INSIGHTS = 'claude-sonnet-5'; // для разбора за период нужна модель посерьёзнее одной тренировки
const MODEL = 'claude-haiku-4-5-20251001'; // дёшево и быстро — идеально для разбора одной тренировки

// Кто такой Fom — общее описание для всех запросов к ИИ
const FOM_INTRO = `Тебя зовут Fom — ты ИИ-тренер по лёгкой атлетике внутри тренировочного дневника. Если спросят, как тебя зовут, — отвечай, что ты Fom. Не подписывай сообщения и не представляйся без повода.`;

// Как считать объём — спортсмены часто пишут кросс в разминку или заминку, а не в повторы
const VOLUME_RULE = `Объём (километры, минуты, отрезки) считай по ВСЕМУ, что записано в тренировке: разминка, основная работа, заминка и заметки. Спортсмены часто пишут кросс или длительный бег (например «12 км, 55 мин») в разминку или заминку — это тоже часть объёма, учитывай его. Если цифры взяты из текста, а не из таблицы повторов, коротко скажи об этом. Не выдумывай то, чего в записях нет.`;

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function weekday(dateStr) {
  return WEEKDAYS[new Date(dateStr + 'T00:00:00Z').getUTCDay()];
}

// Один повтор/отрезок одной строкой: «400 м ×6, время/темп 1:05, отдых 2 мин»
function formatSet(s) {
  const parts = [];
  if (s.distance_m) parts.push(`${s.distance_m} м`);
  if (s.reps) parts.push(`×${s.reps}`);
  if (s.time_or_pace) parts.push(`время/темп ${s.time_or_pace}`);
  if (s.rest_between) parts.push(`отдых ${s.rest_between}`);
  return parts.join(', ');
}

/**
 * Полное описание одной записи для ИИ: дата, день недели, разминка, повторы, заминка, RPE, самочувствие, заметка.
 * Используется и в отзыве после тренировки, и в разборе нагрузки, и в чате.
 */
export function describeWorkout(w) {
  const d = String(w.date).slice(0, 10);
  const head = `${d} (${weekday(d)})`;

  if (w.type === 'rest') {
    return `${head}: отдых${w.notes ? `, заметка: ${w.notes}` : ''}`;
  }

  const parts = [];
  if (w.warmup) parts.push(`разминка: ${w.warmup}`);
  const sets = (Array.isArray(w.sets) ? w.sets : []).map(formatSet).filter(Boolean);
  if (sets.length) parts.push(`основная работа: ${sets.join('; ')}`);
  if (w.cooldown) parts.push(`заминка: ${w.cooldown}`);
  parts.push(`RPE ${w.rpe ?? '-'}/10, самочувствие ${w.feeling ?? '-'}/10`);
  if (w.notes) parts.push(`заметка: ${w.notes}`);

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
export async function getPeriodInsight(workouts, period) {
  const periodLabel = period === 'month' ? 'месяц' : 'неделю';
  const summary = workouts.map(describeWorkout).join('\n');

  const prompt = `${FOM_INTRO}

Сейчас ты как тренер, который раз в ${period === 'month' ? 'месяц' : 'неделю'} делает разбор тренировочного процесса спортсмена, как бухгалтер сводит баланс.

Вот записи с начала ${period === 'month' ? 'текущего месяца' : 'текущей недели (с понедельника)'} по сегодня:
${summary || 'записей нет'}

${VOLUME_RULE}

Дай структурированный разбор на русском, используя заголовки **жирным**:
**Объём и частота:** сколько тренировок и дней отдыха, общий беговой объём (км/минуты), есть ли баланс.
**Динамика нагрузки:** растёт ли RPE и объём, есть ли резкие скачки.
**Самочувствие:** как менялось, есть ли тревожные признаки (падающее самочувствие при растущей нагрузке).
**Риск перегрузки:** явно скажи, есть он или нет, и почему.
**Рекомендация на следующую ${periodLabel}:** 1-2 конкретных совета.

Пиши тепло, как заботливый тренер, но по делу. Если данных мало — так и скажи, не выдумывай.`;

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
export async function getChatReply(contextSummary, history, message, today) {
  const systemPrompt = `${FOM_INTRO}
Ты заботливый помощник спортсмена.
Ты отвечаешь на вопросы, опираясь ТОЛЬКО на реальные данные его тренировок, которые даны ниже. Если чего-то в данных нет — честно скажи, что не можешь это посчитать, не выдумывай цифры.

Сегодня: ${today} (${weekday(today)}). Когда спрашивают «за неделю», считай текущую календарную неделю с понедельника по сегодня; «за месяц» — с 1-го числа текущего месяца.

${VOLUME_RULE}

Записи тренировок за последние 30 дней:
${contextSummary || 'записей нет'}

Отвечай кратко и по делу, на русском, дружелюбным тоном тренера. Если вопрос не про тренировки/восстановление/здоровье — можешь мягко напомнить, что ты помогаешь именно с этим.`;

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
export async function getWorkoutFeedback(workout, recentWorkouts) {
  const recentSummary = recentWorkouts.map(describeWorkout).join('\n');
  const dayLabel = workout.isBackdated ? 'Тренировка (внесена задним числом)' : 'Сегодняшняя тренировка';

  const prompt = `${FOM_INTRO}
Ты опытный тренер и одновременно заботливый "бухгалтер нагрузки" спортсмена.
Тебе дана тренировка и записи за дни перед ней.

${dayLabel}:
${describeWorkout({ ...workout, type: 'training' })}

Предыдущие дни для контекста:
${recentSummary || 'данных нет'}

${VOLUME_RULE}

Дай ответ в 3-4 коротких предложения на русском:
1. Оценка этой тренировки в контексте предыдущих дней (хорошо выполнена / есть признаки перебора).
2. Если видишь риск перегрузки (высокий RPE несколько дней подряд, падающее самочувствие, резкий рост объёма) — прямо укажи на это.
3. ${workout.isBackdated ? 'Один конкретный вывод или совет на будущее (тренировка уже в прошлом, поэтому не советуй «на завтра»).' : 'Одна конкретная подсказка по восстановлению на завтра.'}
Пиши тепло, но по делу, без воды.`;

  return callClaude({
    model: MODEL,
    maxTokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
}
