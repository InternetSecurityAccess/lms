// utils/storage/index.js
'use strict';
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const filesPolicy = require('../../config/files');
const { getStorageDir, filenamePrefix } = require('./paths');
const { ThrottleTransform } = require('./throttle');
// Имя файла: <prefix>-<uuid>.<ext>. Timestamp не нужен — UUID v4 уникален,
// хронологию даёт mtime файла. Короче путь, меньше визуального шума.
function createFilename(prefix, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  return `${prefix}${crypto.randomUUID()}${ext}`;
}
// Ограничение скорости загрузки. Значение в настройке — Мбит/с (Mbps).
// Пересчёт в байты/с: Mbps * 1024 * 1024 / 8.
function getUploadLimitBps() {
  try {
    const mbps = Number(filesPolicy.UPLOAD_RATE_LIMIT_MBPS);
    if (!Number.isFinite(mbps) || mbps <= 0) return 0;
    return Math.round((mbps * 1024 * 1024) / 8);
  } catch { return 0; }
}
function makeRealUploader(kind, opts) {
  const { limitMb, maxFiles, extensions } = opts;
  const imageExtList = filesPolicy.formatExtList(filesPolicy.IMAGE_EXTENSIONS);
  const storage = {
    _handleFile(req, file, cb) {
      let targetDir, relativeDir, meta;
      try {
        const info = getStorageDir(kind, req);
        targetDir = info.targetDir;
        relativeDir = info.relativeDir;
        meta = info.meta;
        fs.mkdirSync(targetDir, { recursive: true });
        req._storageRelativeDir = relativeDir;
        if (meta) req.lectureImageMeta = meta;
      } catch (e) {
        return cb(e);
      }
      let name;
      if (kind === 'lecture_image') {
        const ext = filesPolicy.imageExtFromMime(file.mimetype);
        if (!ext) {
          const err = new Error(`Разрешены только ${imageExtList}`);
          err.code = 'INVALID_IMAGE_TYPE';
          err.status = 400;
          return cb(err);
        }
        name = `${crypto.randomUUID()}${ext}`;
        if (req.lectureImageMeta) req.lectureImageMeta.filename = name;
      } else {
        name = createFilename(filenamePrefix(kind), file.originalname);
        const rel = req._storageRelativeDir
          ? path.posix.join(req._storageRelativeDir, name)
          : name;
        if (!req.storedNames) req.storedNames = [];
        req.storedNames.push(rel);
        req._storageRelativePath = rel;
      }
      const finalPath = path.join(targetDir, name);
      const outStream = fs.createWriteStream(finalPath);
      const limitBps = getUploadLimitBps();
      // Защита от прерывания. Подписка на req.aborted — ключевая:
      // multer эмитит 'Request aborted' РАНЬШЕ, чем file.stream успевает
      // закрыться, и без req.on('aborted') unlink partial-файла не успевает.
      //
      // Express 4: req.aborted — boolean, deprecated в Express 5.
      // Express 5: req.destroyed — boolean. Читаем оба, чтобы не сломаться
      // при апгрейде; лишняя проверка стоит копейки.
      let settled = false;
      const cleanupListeners = () => {
        req.removeListener('aborted', onReqAborted);
        req.removeListener('close', onReqClose);
        file.stream.removeListener('aborted', onStreamAborted);
        file.stream.removeListener('close', onStreamClose);
        file.stream.removeListener('error', onStreamError);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        try { outStream.destroy(); } catch { /* ignore */ }
        fs.promises.unlink(finalPath).catch(() => { /* ignore */ });
        cb(err);
      };
      const succeed = (info) => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        cb(null, info);
      };
      const makeAbortError = () => {
        const e = new Error('upload aborted by client');
        e.code = 'UPLOAD_ABORTED';
        return e;
      };
      // req.aborted → в Express 4 приходит по aborted; в Express 5 поле
      // переименовали в destroyed. Проверяем оба, чтобы abort ловился
      // до того, как outStream.on('error') получит голый ECONNRESET.
      const onReqAborted = () => fail(makeAbortError());
      const onReqClose = () => {
        const aborted = req.aborted === true || req.destroyed === true;
        if (aborted || !req.readableEnded) fail(makeAbortError());
      };
      req.on('aborted', onReqAborted);
      req.on('close', onReqClose);
      const onStreamAborted = () => fail(makeAbortError());
      // readableEnded === false → поток не дочитан до конца, значит abort.
      // !readableEnded — то же самое, но короче и без сравнения с boolean:
      // свойство либо true, либо false, промежуточных состояний нет.
      const onStreamClose = () => {
        if (!file.stream.readableEnded) fail(makeAbortError());
      };
      const onStreamError = (err) => fail(err);
      file.stream.on('aborted', onStreamAborted);
      file.stream.on('close', onStreamClose);
      file.stream.on('error', onStreamError);
      outStream.on('error', fail);
      outStream.on('finish', () => {
        fs.stat(finalPath, (err, stat) => {
          if (err) return fail(err);
          succeed({
            destination: targetDir,
            filename: name,
            path: finalPath,
            size: stat.size,
          });
        });
      });
      let src = file.stream;
      if (limitBps > 0) {
        const throttle = new ThrottleTransform(limitBps);
        throttle.on('error', fail);
        src = file.stream.pipe(throttle);
      }
      src.pipe(outStream);
    },
    _removeFile(req, file, cb) {
      if (file && file.path) {
        fs.unlink(file.path, () => cb(null));
      } else {
        cb(null);
      }
    },
  };
  const fileFilter = (req, file, cb) => {
    if (kind === 'lecture_image') {
      if (!filesPolicy.isAllowedImageMime(file.mimetype)) {
        const err = new Error(`Разрешены только ${imageExtList}`);
        err.code = 'INVALID_IMAGE_TYPE';
        err.status = 400;
        return cb(err);
      }
      return cb(null, true);
    }
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!extensions.includes(ext)) {
      const err = new Error(`Недопустимый формат: ${ext || 'без расширения'}`);
      err.code = 'INVALID_FILE_TYPE';
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  };
  return multer({
    storage,
    limits: { fileSize: limitMb * filesPolicy.MB, files: maxFiles },
    fileFilter,
  });
}
const cache = new Map();
function getRealUploader(kind) {
  if (cache.has(kind)) return cache.get(kind);
  const maxMb = filesPolicy.MAX_FILE_SIZE_MB;
  const maxFiles = filesPolicy.MAX_FILES_PER_UPLOAD;
  const exts = filesPolicy.UPLOAD_EXTENSIONS;
  let opts;
  switch (kind) {
    case 'work':
    case 'lecture':
    case 'assignment':
      opts = { limitMb: maxMb, maxFiles, extensions: exts };
      break;
    case 'chat':
      opts = { limitMb: maxMb, maxFiles: 1, extensions: exts };
      break;
    case 'lecture_image':
      opts = { limitMb: maxMb, maxFiles: 1 };
      break;
    default:
      throw new Error(`[storage] unknown uploader kind: ${kind}`);
  }
  const up = makeRealUploader(kind, opts);
  cache.set(kind, up);
  return up;
}
function invalidateUploaders() {
  cache.clear();
}
function makeDynamic(kind) {
  return {
    single(field) {
      return (req, res, next) => getRealUploader(kind).single(field)(req, res, next);
    },
    array(field, maxCount) {
      return (req, res, next) => {
        const current = filesPolicy.MAX_FILES_PER_UPLOAD;
        const m = (maxCount == null || maxCount > current) ? current : maxCount;
        return getRealUploader(kind).array(field, m)(req, res, next);
      };
    },
    fields(fields) {
      return (req, res, next) => getRealUploader(kind).fields(fields)(req, res, next);
    },
  };
}
const workUpload = makeDynamic('work');
const workMultiUpload = makeDynamic('work');
const chatUpload = makeDynamic('chat');
const lectureUpload = makeDynamic('lecture');
const lectureImageUpload = makeDynamic('lecture_image');
const assignmentUpload = makeDynamic('assignment');
module.exports = {
  makeUploader: makeRealUploader,
  invalidateUploaders,
  workUpload,
  workMultiUpload,
  chatUpload,
  lectureUpload,
  lectureImageUpload,
  assignmentAttachmentUpload: assignmentUpload,
  assignmentUpload,
};