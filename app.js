'use strict';
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const config = require('./config');
const settings = require('./config/settings');
const filesPolicy = require('./config/files');
const db = require('./database');
const { WORK_STATUSES } = require('./utils/statuses');
const { getCountersCached } = require('./utils/counters');
const { buildSessionStore } = require('./middleware/session-store');
const loadCurrentUser = require('./middleware/load-current-user');
const csrfProtection = require('./middleware/csrf');
const clientInfoMiddleware = require('./middleware/clientInfo');
const viewHelpers = require('./middleware/view-helpers');
const { renderText } = require('./utils/linkify');
const { getPasswordRequirements } = require('./utils/password-policy');
const { safeRedirect } = require('./utils/helpers');
const MENUS = require('./config/nav');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY);
app.set('view engine', 'ejs');
app.set('views', config.VIEWS_DIR);
// ВАЖНО: helmet с contentSecurityPolicy: false — CSP теперь ставит
// middleware/csp.js per-request, потому что frame-src зависит от настроек
// (whitelist iframe-доменов редактируется в /admin/settings без рестарта).
// Остальные заголовки helmet (X-Frame-Options и т.п.) остаются как были.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'same-origin' },
}));
app.use(require('./middleware/csp'));
// /health вынесен ДО session, статики и бизнес-логики
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(config.PUBLIC_DIR, {
  dotfiles: 'ignore',
  index: false,
  fallthrough: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.mjs')) {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    }
  },
}));
// ─── Slow-log ───
// Логирует запросы медленнее 300 мс. Один и тот же path — не чаще раза в 5 сек.
// Статика не логируется (middleware после express.static).
app.use(require('./middleware/slow-log')({ thresholdMs: 300, cooldownMs: 5000 }));
app.use(session({
  name: 'workstud.sid',
  secret: config.SESSION_SECRET,
  store: buildSessionStore(db),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    maxAge: config.SESSION_MAX_AGE,
  },
}));
app.use(viewHelpers);
app.use((req, res, next) => {
  res.locals.WORK_STATUSES = WORK_STATUSES;
  res.locals.college = config.COLLEGE;
  res.locals.session = req.session;
  res.locals.query = req.query;
  res.locals.demoMode = config.DEMO_MODE;
  res.locals.demoUsers = config.DEMO_USERS;
  res.locals.demoTeacherLogin = config.DEMO_TEACHER.login;
  res.locals.demoStudentLogin = config.DEMO_STUDENT.login;
  res.locals.registrationEnabled = config.REGISTRATION_ENABLED;
  res.locals.renderText = renderText;
  res.locals.passwordRequirements = getPasswordRequirements();
  res.locals.adminPasswordRequirements = getPasswordRequirements({ level: config.ADMIN_PASSWORD_LEVEL });
  res.locals.passwordMinLength = res.locals.passwordRequirements[0]?.text || '';
  res.locals.filesPolicy = filesPolicy;
  res.locals.ACCEPT_UPLOAD = filesPolicy.ACCEPT_UPLOAD;
  res.locals.ACCEPT_IMAGE = filesPolicy.ACCEPT_IMAGE;
  res.locals.MAX_FILE_SIZE_MB = filesPolicy.MAX_FILE_SIZE_MB;
  res.locals.MAX_FILES_PER_UPLOAD = filesPolicy.MAX_FILES_PER_UPLOAD;
  res.locals.HINT_UPLOAD =
    `До ${filesPolicy.MAX_FILES_PER_UPLOAD} файлов, каждый до ${filesPolicy.MAX_FILE_SIZE_MB} МБ. ` +
    `Форматы: ${filesPolicy.formatExtList(filesPolicy.UPLOAD_EXTENSIONS)}.`;
  res.locals.HINT_IMAGE =
    `Один файл до ${filesPolicy.MAX_FILE_SIZE_MB} МБ. ` +
    `Форматы: ${filesPolicy.formatExtList(filesPolicy.IMAGE_EXTENSIONS)}.`;
  res.locals.filesClient = {
    maxFileSizeMb: filesPolicy.MAX_FILE_SIZE_MB,
    maxFilesPerUpload: filesPolicy.MAX_FILES_PER_UPLOAD,
    acceptUpload: filesPolicy.ACCEPT_UPLOAD,
    acceptImage: filesPolicy.ACCEPT_IMAGE,
    previewableExts: filesPolicy.PREVIEWABLE_EXTENSIONS.map((e) => e.slice(1)),
  };
  // ← НОВОЕ: конфиг Quill для клиента. Передаётся через footer как
  //   window.__quillConfig. quill-init.js строит тулбар по этим данным.
  res.locals.quillConfig = {
    toolbarGroups: settings.get('quill.toolbarGroups') || [],
    tableEnabled: settings.get('quill.tableEnabled') !== false,
  };
  // ← ИЗМЕНЕНО: счётчики в SSR, а не хардкод «0». getCountersCached
  //   кэширует по sessionID на 10 с, поэтому это не «N запросов к БД
  //   на каждый рендер», а один пересчёт раз в 10 секунд на сессию.
  //   Благодаря этому бейджи в меню отрисованы сразу, без мигания 0→N.
  let counters;
  try { counters = getCountersCached(req.session, req.sessionID); }
  catch { counters = { inboxCount: 0, supportUnreadCount: 0, groupChatUnread: 0, announcementsUnread: 0, pendingApprovals: 0 }; }
  res.locals.inboxCount = counters.inboxCount;
  res.locals.supportUnreadCount = counters.supportUnreadCount;
  res.locals.groupChatUnread = counters.groupChatUnread;
  res.locals.announcementsUnread = counters.announcementsUnread;
  res.locals.pendingApprovals = counters.pendingApprovals;
  res.locals.currentPath = req.path;
  const role = req.session?.adminId ? 'admin'
    : req.session?.teacherId ? 'teacher'
    : req.session?.studentId ? 'student'
    : 'guest';
  const menuDef = (MENUS[role] || MENUS.guest).filter((item) => {
    if (item.adminOnly && config.IS_PRODUCTION) return false;
    if (item.registrationOnly && !config.REGISTRATION_ENABLED) return false;
    return true;
  });
res.locals.navItems = menuDef.map((item) => {
  if (!item.badge) return item;
  return { ...item, badgeValue: counters[item.badge] || 0 };
});
// Активный пункт меню — fallback для заголовка страницы (top-bar-title).
// Если страница не передала title в page-top, заголовок берётся отсюда.
const activeMenuItem = menuDef.find((item) => {
  if (!item || !item.href) return false;
  if (item.exact) return req.path === item.href;
  if (item.href === '/') return req.path === '/';
  return req.path === item.href || req.path.startsWith(item.href + '/');
});
res.locals.defaultTopBarTitle = (activeMenuItem && activeMenuItem.label) || '';
next();
});
app.use(csrfProtection);
app.use(clientInfoMiddleware);
app.use(loadCurrentUser);
app.use(require('./routes'));
app.use((req, res) => {
  return res.status(404).render('common/error', {
    title: 'Не найдено',
    message: 'Страница не найдена.',
  });
});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const multer = require('multer');
  const backUrl = safeRedirect(req.get('referer'), '/');
  // ─── Обрыв загрузки ───
  // Сценарии:
  //   • клиент закрыл вкладку / переключил Wi-Fi / пропал интернет
  //   • NPM client_body_timeout / proxy_send_timeout (60 с по умолчанию)
  //   • Node server.requestTimeout (300 с по умолчанию, в server.js поднят до 30 мин)
  //   • наш _handleFile поймал req.aborted раньше multer (code=UPLOAD_ABORTED)
  //
  // Если клиент уже отключился (req.aborted) — тело отправить некому,
  // браузер ничего не покажет. Отдаём 499 (nginx-конвенция Client Closed Request)
  // пустым телом — только для логов. Если клиент ещё слушает (например,
  // NPM отдал 504, а браузер ждёт) — рендерим страницу с рекомендациями.
  const isAbort = err && (
    err.message === 'Request aborted'
    || err.code === 'ECONNABORTED'
    || err.code === 'ETIMEDOUT'
    || err.code === 'ECONNRESET'
    || err.code === 'UPLOAD_ABORTED'
  );
  if (isAbort) {
    // Express 4 — req.aborted, Express 5 — req.destroyed. Оба варианта
    // проверяем, чтобы не сломаться при апгрейде.
    const clientGone = req.aborted === true
      || req.destroyed === true
      || res.writableEnded;
    console.warn('[upload] aborted:', req.method, req.path, {
      code: err.code || err.message,
      clientGone,
    });
    if (clientGone) {
      if (!res.headersSent && !res.writableEnded) {
        try { res.status(499).end(); } catch { /* ignore */ }
      }
      return;
    }
    // Клиент ещё слушает — показываем страницу с рекомендациями.
    // 408 Request Timeout — семантически ближе, чем 500, и браузер
    // корректно отрендерит нашу страницу.
    return res.status(408).render('common/error', {
      title: 'Загрузка прервалась',
      message: 'Соединение прервалось до того, как файл полностью загрузился. '
        + 'Частично загруженный файл удалён — в системе ничего не сохранено.',
      hints: [
        'Уменьшите размер файла: сожмите изображение, разбейте архив на части, '
          + 'удалите лишние страницы из PDF.',
        'Проверьте соединение с интернетом. При переключении Wi-Fi '
          + 'или переходе на мобильный интернет загрузка прерывается.',
        'Не закрывайте вкладку и не переключайтесь на другое приложение '
          + 'во время загрузки.',
        `Если файл большой (ближе к ${filesPolicy.MAX_FILE_SIZE_MB} МБ) — `
          + 'попробуйте загрузить его через стабильное проводное соединение.',
        'Если ничего не помогает — напишите в поддержку (/support), '
          + 'приложите скриншот ошибки.',
      ],
      backUrl,
      backLabel: '← Попробовать снова',
    });
  }
  // ─── Multer: размер / тип ───
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).render('common/error', {
        title: 'Файл слишком большой',
        message: `Сервер отклонил загрузку: файл больше ${filesPolicy.MAX_FILE_SIZE_MB} МБ.`,
        hints: [
          `Максимальный размер одного файла — ${filesPolicy.MAX_FILE_SIZE_MB} МБ.`,
          'Сожмите файл или разбейте его на несколько частей.',
          `Разрешённые форматы: ${filesPolicy.formatExtList(filesPolicy.UPLOAD_EXTENSIONS)}.`,
        ],
        backUrl,
        backLabel: '← Вернуться к загрузке',
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).render('common/error', {
        title: 'Слишком много файлов',
        message: `Можно прикрепить не больше ${filesPolicy.MAX_FILES_PER_UPLOAD} файлов за раз.`,
        backUrl,
        backLabel: '← Вернуться к загрузке',
      });
    }
    return res.status(400).render('common/error', {
      title: 'Ошибка загрузки',
      message: err.message || 'Не удалось загрузить файл.',
      backUrl,
      backLabel: '← Вернуться к загрузке',
    });
  }
  // ─── Наши ошибки: тип / размер ───
  if (err && (err.code === 'INVALID_FILE_TYPE' || err.code === 'INVALID_IMAGE_TYPE')) {
    return res.status(400).render('common/error', {
      title: 'Недопустимый формат',
      message: err.message || 'Этот тип файла не разрешён.',
      hints: [
        `Разрешённые форматы: ${filesPolicy.formatExtList(filesPolicy.UPLOAD_EXTENSIONS)}.`,
      ],
      backUrl,
      backLabel: '← Вернуться к загрузке',
    });
  }
  if (err.status && err.status < 500) {
    return res.status(err.status).render('common/error', {
      title: 'Ошибка запроса',
      message: err.message || 'Ошибка запроса.',
      backUrl,
      backLabel: '← Вернуться',
    });
  }
  console.error('[app] Ошибка:', err);
  return res.status(500).render('common/error', {
    title: 'Внутренняя ошибка',
    message: 'Внутренняя ошибка сервера.',
    backUrl,
    backLabel: '← Вернуться',
  });
});
module.exports = app;