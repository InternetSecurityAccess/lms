// routes/shared/handlers.js
'use strict';
const { audit: auditFn } = require('../../utils/audit');
const filesPolicy = require('../../config/files');

const handler = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.catch === 'function') return r.catch(next);
    return r;
  } catch (e) { return next(e); }
};

const parseIdOr404 = (req, res, paramName = 'id') => {
  const n = Number(req.params[paramName]);
  if (!Number.isSafeInteger(n) || n < 1) {
    res.status(404).render('common/error', {
      title: 'Не найдено',
      message: 'Объект не найден.',
    });
    return null;
  }
  return n;
};

const notFound = (res, message = 'Объект не найден.') =>
  res.status(404).render('common/error', { title: 'Не найдено', message });

const forbid = (res, message = 'Доступ запрещён.') =>
  res.status(403).render('common/error', { title: 'Доступ запрещён', message });

/* ═══════════════════════════════════════════════════════════
   readonlyForbid — единый ответ для write-операций по объектам
   с readonly (finished-предмет/задание, work.status='accepted').

   Использование:
     if (req.subject.readonly) return readonlyForbid(res, 'Задание');
   ═══════════════════════════════════════════════════════════ */
const readonlyForbid = (res, what = 'Объект') =>
  res.status(403).render('common/error', {
    title: 'Только для чтения',
    message: `${what} завершён. Действие недоступно.`,
  });

const redirectWith = (res, path, query = {}) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === '' || v == null) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return res.redirect(path + (s ? '?' + s : ''));
};

const appendQuery = (url, extra = {}) => {
  if (!url) return url;
  try {
    const u = new URL(url, 'http://x');
    for (const [k, v] of Object.entries(extra)) {
      if (v === '' || v == null) continue;
      u.searchParams.set(k, String(v));
    }
    return u.pathname + (u.search || '') + (u.hash || '');
  } catch {
    return url;
  }
};

const renderWith = (res, view, locals = {}) => res.render(view, locals);

const renderErr = (res, view, locals, error, status = 400) =>
  res.status(status).render(view, { ...locals, error });

const audit = (req, action, targetType, targetId, details) =>
  auditFn(req, action, targetType, targetId, details);

const uploadWithFallback = (uploadMw, onUploadError) => (req, res, next) => {
  uploadMw(req, res, (err) => {
    if (!err) return next();
    const isKnown = err.code === 'LIMIT_FILE_SIZE'
      || err.code === 'INVALID_FILE_TYPE'
      || err.code === 'INVALID_IMAGE_TYPE';
    if (isKnown && typeof onUploadError === 'function') {
      try { return onUploadError(err, req, res, next); }
      catch (e) { return next(e); }
    }
    return next(err);
  });
};

function friendlyFileError(err) {
  const maxMb = filesPolicy.MAX_FILE_SIZE_MB;
  const extList = filesPolicy.formatExtList(filesPolicy.UPLOAD_EXTENSIONS);
  const imgList = filesPolicy.formatExtList(filesPolicy.IMAGE_EXTENSIONS);
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return `Файл больше допустимого размера. Максимум — ${maxMb} МБ.`;
  }
  if (err && err.code === 'INVALID_IMAGE_TYPE') {
    return `Разрешены только картинки: ${imgList}.`;
  }
  if (err && err.code === 'INVALID_FILE_TYPE') {
    return `Недопустимый формат файла. Разрешены: ${extList}.`;
  }
  return (err && err.message) || 'Не удалось загрузить файл.';
}

module.exports = {
  handler, parseIdOr404, notFound, forbid, readonlyForbid,
  redirectWith, appendQuery,
  renderWith, renderErr, audit,
  uploadWithFallback, friendlyFileError,
};