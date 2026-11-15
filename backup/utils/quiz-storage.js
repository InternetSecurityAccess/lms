// utils/quiz-storage.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const filesPolicy = require('../config/files');

/* ═══════════════════════════════════════════════════════════
   Хранилище картинок тестов.

   Файлы лежат в <STORAGE_DIR>/quiz/<uuid>.<ext>.
   В БД хранится stored_name = 'quiz/<uuid>.<ext>' (относительно
   STORAGE_DIR) — как у attachments.

   Валидация:
     • размер ≤ QUIZ_IMAGE_MAX_MB;
     • magic bytes: PNG / JPEG / WebP (по содержимому, не по MIME
       от клиента — клиент может соврать);
     • расширение строится из magic bytes, не из originalname.
   ═══════════════════════════════════════════════════════════ */

const STORED_RE = /^quiz\/[0-9a-f-]{36}\.(png|jpg|webp)$/i;

function quizImagesDir() {
  return path.join(config.STORAGE_DIR, 'quiz');
}

function ensureQuizImagesDir() {
  fs.mkdirSync(quizImagesDir(), { recursive: true });
}
ensureQuizImagesDir();

// ─── Определение типа по magic bytes ───
function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 &&
    buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A &&
    buffer[6] === 0x1A && buffer[7] === 0x0A
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }
  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 &&
    buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 &&
    buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function extFromMime(mime) {
  return filesPolicy.QUIZ_IMAGE_MIME_TO_EXT[mime] || null;
}

// ─── Безопасный абсолютный путь по stored_name ───
function getQuizImagePath(stored_name) {
  const s = String(stored_name || '');
  if (!STORED_RE.test(s)) return null;
  return path.join(config.STORAGE_DIR, s);
}

// ─── Сохранение ───
// Возвращает { ok, stored_name, filename, filesize, mime } или { ok: false, error }
function saveQuizImage(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: 'Пустой файл' };
  }
  const maxBytes = filesPolicy.QUIZ_IMAGE_MAX_MB * filesPolicy.MB;
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      error: `Файл больше ${filesPolicy.QUIZ_IMAGE_MAX_MB} МБ`,
    };
  }
  const mime = detectImageMime(buffer);
  if (!mime) {
    return {
      ok: false,
      error: `Недопустимый формат. Разрешены: ${filesPolicy.QUIZ_IMAGE_EXTENSIONS.join(', ')}`,
    };
  }
  const ext = extFromMime(mime);
  if (!ext) {
    return { ok: false, error: 'Недопустимый формат картинки' };
  }

  const uuid = crypto.randomUUID();
  const stored_name = `quiz/${uuid}${ext}`;
  const absPath = path.join(config.STORAGE_DIR, stored_name);

  try {
    ensureQuizImagesDir();
    fs.writeFileSync(absPath, buffer, { mode: 0o644 });
  } catch (e) {
    console.error('[quiz-storage] save:', e.message);
    return { ok: false, error: 'Не удалось сохранить картинку' };
  }

  const filename = String(originalName || `image${ext}`).slice(0, 200);
  return {
    ok: true,
    stored_name,
    filename,
    filesize: buffer.length,
    mime,
  };
}

// ─── Удаление ───
function deleteQuizImage(stored_name) {
  const abs = getQuizImagePath(stored_name);
  if (!abs) return false;
  try {
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      return true;
    }
  } catch (e) {
    console.error('[quiz-storage] delete:', e.message);
  }
  return false;
}

// ─── Массовая очистка ───
// oldNames, newNames — Set<string> stored_name.
// Удаляем те, что были и пропали. Возвращает количество удалённых.
function cleanupRemovedQuizImages(oldNames, newNames) {
  const oldSet = oldNames instanceof Set ? oldNames : new Set();
  const newSet = newNames instanceof Set ? newNames : new Set();
  let removed = 0;
  for (const name of oldSet) {
    if (!newSet.has(name)) {
      if (deleteQuizImage(name)) removed++;
    }
  }
  return removed;
}

// ─── Сбор stored_name из payload (форма конструктора) ───
// payload.questions[]: { image_stored_name, options[]: { image_stored_name } }
function collectStoredNamesFromPayload(payload) {
  const set = new Set();
  const questions = payload && Array.isArray(payload.questions) ? payload.questions : [];
  for (const q of questions) {
    if (q && q.image_stored_name) set.add(String(q.image_stored_name));
    const opts = Array.isArray(q?.options) ? q.options : [];
    for (const o of opts) {
      if (o && o.image_stored_name) set.add(String(o.image_stored_name));
    }
  }
  return set;
}

module.exports = {
  quizImagesDir,
  ensureQuizImagesDir,
  detectImageMime,
  getQuizImagePath,
  saveQuizImage,
  deleteQuizImage,
  cleanupRemovedQuizImages,
  collectStoredNamesFromPayload,
  STORED_RE,
};