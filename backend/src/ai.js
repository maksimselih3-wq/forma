import dotenv from 'dotenv';
dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL_INSIGHTS = 'claude-sonnet-5'; // для разбора за период нужна модель посерьёзнее одной тренировки
const MODEL = 'claude-haiku-4-5-20251001'; // дёшево и быстро — идеально для разбора одной тренировки

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

  const prompt = `Ты — тренер по лёгкой атлетике, который раз в ${period === 'month' ? 'месяц' : 'неделю'} делает разбор тренировочного процесса спортсмена, как бухгалтер сводит баланс.

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
 * Просит Claude выступить в роли тренера: оценить тренировку
 * в контексте последних дней и дать короткий фидбек + совет по восстановлению.
 */
export async function getWorkoutFeedback(workout, recentWorkouts) {
  const recentSummary = recentWorkouts
    .map((w) => `${w.date}: ${w.type}, RPE=${w.rpe ?? '-'}, самочувствие=${w.feeling ?? '-'}`)
    .join('\n');

  const prompt = `Ты — опытный тренер по лёгкой атлетике и одновременно заботливый "бухгалтер нагрузки" спортсмена.
Тебе дана сегодняшняя тренировка и сводка за последние дни.

Сегодняшняя тренировка:
Дата: ${workout.date}
Разминка: ${workout.warmup || '-'}
Основная работа: ${JSON.stringify(workout.sets || [])}
RPE (воспринимаемая нагрузка, 1-10): ${workout.rpe ?? '-'}
Самочувствие (1-10): ${workout.feeling ?? '-'}
Заметки спортсмена: ${workout.notes || '-'}

Последние дни для контекста:
${recentSummary || 'данных нет'}

Дай ответ в 3-4 коротких предложения на русском:
1. Оценка сегодняшней тренировки в контексте последних дней (хорошо выполнена / есть признаки перебора).
2. Если видишь риск перегрузки (высокий RPE несколько дней подряд, падающее самочувствие) — прямо укажи на это.
3. Одна конкретная подсказка по восстановлению на завтра.
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
