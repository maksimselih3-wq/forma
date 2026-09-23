import dotenv from 'dotenv';
dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001'; // дёшево и быстро — идеально для разбора одной тренировки

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
