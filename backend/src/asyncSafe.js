/**
 * Ошибка внутри async-обработчика в Express 4 не доходит до обработчика ошибок:
 * запрос просто «зависает» до таймаута. Эта функция один раз проходит по уже зарегистрированным
 * маршрутам роутера и оборачивает каждый обработчик, чтобы ошибка превращалась в ответ 500.
 * (В Express 5 это работает само, и вызов ничему не мешает.)
 *
 * Вызывать после того, как роутер полностью собран, до первого запроса.
 */
function wrap(fn) {
  // обработчики ошибок (4 аргумента) и вложенные роутеры не трогаем; уже обёрнутые — тоже
  if (typeof fn !== 'function' || fn.length === 4 || fn.__asyncSafe || fn.stack) return fn;
  const wrapped = function (req, res, next) {
    let result;
    try {
      result = fn(req, res, next);
    } catch (err) {
      return next(err);
    }
    // возвращаем уже «обезвреженный» промис: если кто-то повесит на него .then, ошибка не станет необработанной
    if (result && typeof result.catch === 'function') return result.catch(next);
    return result;
  };
  wrapped.__asyncSafe = true;
  return wrapped;
}

export function protectAsync(router) {
  for (const layer of router.stack || []) {
    if (layer.route) {
      for (const l of layer.route.stack) l.handle = wrap(l.handle);
    } else {
      layer.handle = wrap(layer.handle);
    }
  }
  return router;
}
