// Если ключ ИИ не принимается (401/403), не мучаем людей ошибками «связи»:
// показываем понятное сообщение и не тратим их дневной лимит. Раз в минуту пропускаем один запрос —
// «пробу»: как только ключ заработает, всё включится само, без перезапуска.
export const AI_DOWN_MESSAGE = 'Приносим свои извинения — Fom настраивается и скоро снова будет готов вам помочь 🙂';
export const aiState = { down: false, since: 0, lastProbe: 0 };

export function markAiDown() {
  if (!aiState.down) aiState.since = Date.now();
  aiState.down = true;
}
export function markAiUp() { aiState.down = false; }

export function aiGuard(req, res, next) {
  if (!aiState.down) return next();
  const now = Date.now();
  if (now - aiState.lastProbe > 60_000) { aiState.lastProbe = now; return next(); }
  return res.status(503).json({ error: AI_DOWN_MESSAGE, ai_down: true });
}
