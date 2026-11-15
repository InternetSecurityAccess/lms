// middleware/csp.js
'use strict';
// CSP ставится per-request, а не через helmet, потому что политика
// собирается из директив ниже (а в будущем может зависеть от ролей
// или настроек). Вынесено в отдельный middleware, чтобы не плодить
// условия в app.js.
//
// Шрифты теперь локальные (public/css/fonts.css → /fonts/*.woff2),
// поэтому style-src и font-src больше не содержат внешних доменов
// Google Fonts. Это освобождает от preconnect и ускоряет первую
// отрисовку: не ждём рукопожатие с fonts.googleapis.com.
//
// frame-src: только 'self'. Встраивание внешних iframe отключено —
//            ни UI-кнопки в редакторе, ни разрешения в санитайзере.
// media-src: не указывается отдельно — наследуется от default-src
//            'self'. Видео в HTML темы не разрешено; видео-вложения
//            отдаются через /file/attachment/:id, это тоже 'self'.
function buildCsp() {
  const directives = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", "'unsafe-inline'"]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['font-src', ["'self'", 'data:']],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['connect-src', ["'self'"]],
    ['worker-src', ["'self'", 'blob:']],
    ['frame-src', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['manifest-src', ["'self'"]],
  ];
  return directives.map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}
module.exports = function csp(req, res, next) {
  try {
    res.setHeader('Content-Security-Policy', buildCsp());
  } catch (e) {
    console.error('[csp] build failed:', e.message);
  }
  next();
};