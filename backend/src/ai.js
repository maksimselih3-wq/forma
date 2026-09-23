import dotenv from 'dotenv';
dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL_INSIGHTS = 'claude-sonnet-5'; // для разбора за период нужна модель посерьёзнее одной тренировки
const MODEL = 'claude-haiku-4-5-20251001'; // дёшево и быстро — идеально для разбора одной тренировки

// Кто такой Fom — общее описание для всех запросов к ИИ
const FOM_INTRO = `Тебя зовут Fom — ты ИИ-тренер по лёгкой атлетике внутри тренировочного дневника. Если спросят, как тебя зовут, — отвечай, что ты Fom. Не подписывай сообщения и не представляйся без повода.`;

/**
 * Разбор нагрузки за период (неделя/месяц): тренды, риск перегруза, рекомендации.
 */
export async function getPeriodInsight(workouts, period) {
  const periodLabel = period === 'month' ? 'месяц' : 'неделю';

  const summary = workouts
    .map((w) => {
      if (w.type === 'rest') return `${w.date}: отдых`;
      const setsCount = (w.sets || []).length;
      return `${w.date}: тренировка, RPE=${w.rpe ?? '-'}, самочувствие=${w.feeling ?? '-'}, повторов в работе=${setsCount}`;
    })
    .join('\n');

  const prompt = `${FOM_INTRO}

Сейчас ты как тренер, который раз в ${period === 'month' ? 'месяц' : 'неделю'} делает разбор тренировочного процесса спортсмена, как бухгалтер сводит баланс.

Вот записи с начала ${period === 'month' ? 'текущего месяца' : 'текущей недели (с понедельника)'} по сегодня:
${summary || 'записей нет'}

Дай структурированный разбор на русском, используя заголовки **жирным**:
**Объём и частота:** сколько тренировок и дней отдыха, есть ли баланс.
**Динамика нагрузки:** растёт ли RPE, есть ли резкие скачки.
**Самочувствие:** как менялось, есть ли тревожные признаки (падающее самочувствие при растущей нагрузке).
**Риск перегрузки:** явно скажи, есть он или нет, и почему.
**Рекомендация на следующую ${periodLabel}:** 1-2 конкретных совета.

Пиши тепло, как заботливый тренер, но по делу. Если данных мало — так и скажи, не выдумывай.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL_INSIGHTS,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
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
 * Чат с Fom: отвечает на вопросы спортсмена, опираясь на его реальные записи.
 * history — предыдущие сообщения диалога (без текущего вопроса).
 */
export async function getChatReply(contextSummary, history, message) {
  const systemPrompt = `${FOM_INTRO}
Ты заботливый помощник спортсмена.
Ты отвечаешь на вопросы, опираясь ТОЛЬКО на реальные данные его тренировок, которые даны ниже. Если чего-то в данных нет — честно скажи, что не можешь это посчитать, не выдумывай цифры.

Данные тренировок за последние 30 дней:
${contextSummary || 'записей нет'}

Отвечай кратко и по делу, на русском, дружелюбным тоном тренера. Если вопрос не про тренировки/восстановление/здоровье — можешь мягко напомнить, что ты помогаешь именно с этим.`;

  const messages = [...history, { role: 'user', content: message }];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages,
    }),
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
 * Fom оценивает тренировку в контексте предыдущих дней
 * и даёт короткий фидбек + совет по восстановлению.
 */
export async function getWorkoutFeedback(workout, recentWorkouts) {
  const recentSummary = recentWorkouts
    .map((w) => `${w.date}: ${w.type}, RPE=${w.rpe ?? '-'}, самочувствие=${w.feeling ?? '-'}`)
    .join('\n');

  const dayLabel = workout.isBackdated ? 'Тренировка (внесена задним числом)' : 'Сегодняшняя тренировка';

  const prompt = `${FOM_INTRO}
Ты опытный тренер и одновременно заботливый "бухгалтер нагрузки" спортсмена.
Тебе дана тренировка и сводка за дни перед ней.

${dayLabel}:
Дата: ${workout.date}
Разминка: ${workout.warmup || '-'}
Основная работа: ${JSON.stringify(workout.sets || [])}
RPE (воспринимаемая нагрузка, 1-10): ${workout.rpe ?? '-'}
Самочувствие (1-10): ${workout.feeling ?? '-'}
Заметки спортсмена: ${workout.notes || '-'}

Предыдущие дни для контекста:
${recentSummary || 'данных нет'}

Дай ответ в 3-4 коротких предложения на русском:
1. Оценка этой тренировки в контексте предыдущих дней (хорошо выполнена / есть признаки перебора).
2. Если видишь риск перегрузки (высокий RPE несколько дней подряд, падающее самочувствие) — прямо укажи на это.
3. ${workout.isBackdated ? 'Один конкретный вывод или совет на будущее (тренировка уже в прошлом, поэтому не советуй «на завтра»).' : 'Одна конкретная подсказка по восстановлению на завтра.'}
Пиши тепло, но по делу, без воды.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text : null;
}
