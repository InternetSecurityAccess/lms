// routes/quiz-image.js
'use strict';
const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const db = require('../database');
const config = require('../config');
const filesPolicy = require('../config/files');
const {
  saveQuizImage,
  getQuizImagePath,
  detectImageMime,
  STORED_RE,
} = require('../utils/quiz-storage');

const router = express.Router();

/* ═══════════════════════════════════════════════════════════
   Подсистема тестирования — картинки.

   POST /quiz/upload-image
     Multipart, поле image. Только преподаватель (или админ).
     Отвечает JSON: { ok, stored_name, filename, filesize }.

   GET /file/quiz-image/raw/:filename
     Превью для конструктора (до сохранения теста).
     filename = <uuid>.<ext> (без префикса 'quiz/').
     Доступ — teacher/admin. UUID угадать нельзя.

   GET /file/quiz-image/:kind/:id
     Финальный показ. kind ∈ {question, option}, id — id вопроса/варианта.
     Доступ — владелец-преподаватель, админ, либо студент с доступной темой.
   ═══════════════════════════════════════════════════════════ */

// ─── Авторизация ───
function isTeacherOrAdmin(req) {
  return !!(req.session?.teacherId || req.session?.adminId);
}

// ─── Multer (memory storage — файл ≤ 2 МБ, это нормально) ───
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: filesPolicy.QUIZ_IMAGE_MAX_MB * filesPolicy.MB,
    files: 1,
  },
});

// ─── POST /quiz/upload-image ───
router.post('/quiz/upload-image', (req, res) => {
  if (!isTeacherOrAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'Требуется вход преподавателя' });
  }

  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            ok: false,
            error: `Файл больше ${filesPolicy.QUIZ_IMAGE_MAX_MB} МБ`,
          });
        }
        return res.status(400).json({ ok: false, error: err.message || 'Ошибка загрузки' });
      }
      console.error('[quiz-image] multer:', err);
      return res.status(400).json({ ok: false, error: 'Ошибка загрузки' });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: 'Файл не передан' });
    }

    const result = saveQuizImage(req.file.buffer, req.file.originalname);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    return res.json({
      ok: true,
      stored_name: result.stored_name,
      filename: result.filename,
      filesize: result.filesize,
    });
  });
});

// ─── GET /file/quiz-image/raw/:filename ───
// Только teacher/admin. filename = '<uuid>.<ext>'.
router.get('/file/quiz-image/raw/:filename', (req, res) => {
  if (!isTeacherOrAdmin(req)) {
    return res.status(403).end();
  }
  const name = String(req.params.filename || '');
  // Дополняем до формата stored_name и проверяем регуляркой.
  const stored_name = `quiz/${name}`;
  if (!STORED_RE.test(stored_name)) {
    return res.status(404).end();
  }
  const abs = getQuizImagePath(stored_name);
  if (!abs || !fs.existsSync(abs)) {
    return res.status(404).end();
  }
  const ext = path.extname(abs).toLowerCase();
  res.set('Cache-Control', 'private, max-age=300');
  return res.sendFile(abs, { headers: { 'Content-Type': mimeByExt(ext) } });
});

// ─── GET /file/quiz-image/:kind/:id ───
router.get('/file/quiz-image/:kind/:id', (req, res) => {
  const kind = String(req.params.kind || '');
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
  if (kind !== 'question' && kind !== 'option') return res.status(400).end();

  const info = kind === 'question'
    ? loadQuestionImageInfo(id)
    : loadOptionImageInfo(id);

  if (!info || !info.image_stored_name) return res.status(404).end();

  if (!canView(req, info)) return res.status(403).end();

  const abs = getQuizImagePath(info.image_stored_name);
  if (!abs || !fs.existsSync(abs)) return res.status(404).end();

  const ext = path.extname(abs).toLowerCase();
  res.set('Cache-Control', 'private, max-age=300');
  return res.sendFile(abs, { headers: { 'Content-Type': mimeByExt(ext) } });
});

// ─── Хелперы ───
function mimeByExt(ext) {
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function loadQuestionImageInfo(questionId) {
  return db.prepare(`
    SELECT
      qq.image_stored_name,
      qq.quiz_id,
      t.id          AS topic_id,
      t.status      AS topic_status,
      t.deleted_at  AS topic_deleted_at,
      t.available_from,
      s.id          AS subject_id,
      s.teacher_id,
      s.status      AS subject_status,
      s.deleted_at  AS subject_deleted_at
    FROM quiz_questions qq
    LEFT JOIN topics   t ON t.quiz_id = qq.quiz_id AND t.deleted_at IS NULL
    LEFT JOIN subjects s ON s.id = t.subject_id
    WHERE qq.id = ?
    LIMIT 1
  `).get(questionId);
}

function loadOptionImageInfo(optionId) {
  return db.prepare(`
    SELECT
      qo.image_stored_name,
      qq.quiz_id,
      t.id          AS topic_id,
      t.status      AS topic_status,
      t.deleted_at  AS topic_deleted_at,
      t.available_from,
      s.id          AS subject_id,
      s.teacher_id,
      s.status      AS subject_status,
      s.deleted_at  AS subject_deleted_at
    FROM quiz_options qo
    JOIN quiz_questions qq ON qq.id = qo.question_id
    LEFT JOIN topics   t ON t.quiz_id = qq.quiz_id AND t.deleted_at IS NULL
    LEFT JOIN subjects s ON s.id = t.subject_id
    WHERE qo.id = ?
    LIMIT 1
  `).get(optionId);
}

function canView(req, info) {
  // Админ
  if (req.session?.adminId) return true;

  // Преподаватель-владелец предмета
  if (req.session?.teacherId && info.teacher_id === req.session.teacherId) {
    return true;
  }

  // Студент
  if (req.session?.studentId) {
    if (!info.topic_id || info.topic_deleted_at) return false;
    if (info.subject_deleted_at || info.subject_status !== 'active') return false;
    if (info.topic_status !== 'published' && info.topic_status !== 'finished') return false;

    // available_from — до даты скрыт
    if (info.available_from) {
      const from = String(info.available_from);
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      if (from > now) return false;
    }

    // Группа студента должна быть активна в subject_groups (не только в истории)
    const ok = db.prepare(`
      SELECT 1
      FROM students st
      JOIN subject_groups sg ON sg.group_id = st.group_id
      WHERE st.id = ? AND sg.subject_id = ? AND st.deleted_at IS NULL
      LIMIT 1
    `).get(req.session.studentId, info.subject_id);
    return !!ok;
  }

  return false;
}

module.exports = router;