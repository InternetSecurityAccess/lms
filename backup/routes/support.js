'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const crypto = require('node:crypto');
const router = express.Router();
const db = require('../database');
const filesPolicy = require('../config/files');
const { fixFilename } = require('../utils/helpers');
const { rateLimitAction, chatRateLimit } = require('../middleware/rateLimit');
const { handler, redirectWith, renderWith } = require('./shared/handlers');
const { pickStr } = require('./shared/form');
const { isAdmin, isTeacher, isStudent } = require('./shared/authz');
const chat = require('./shared/chat');
const { SUPPORT_FILES_DIR } = require('../utils/storage/paths');
const { isValidImageBuffer } = require('../utils/file-signature');

const supportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: filesPolicy.MAX_FILE_SIZE, files: 1 },
});

const SUPPORT_IMAGE_RE = /^[st]\d+\/sup-[a-f0-9-]+\.(png|jpg|jpeg)$/;
const SUPPORT_FILENAME_RE = /^sup-[a-f0-9-]+\.(png|jpg|jpeg)$/i;

/* ═══════════════════════════════════════════════════════════
   saveSupportImage
   ═══════════════════════════════════════════════════════════
   Студент/преподаватель → папка из сессии: s<studentId> / t<teacherId>.

   Админ → папка определяется тредом: админ отвечает в чужой тред,
   и файл должен лежать в папке автора треда, а не в «админской».
   Поэтому админу нужен opts.threadId (id support_threads).

   Раньше saveSupportImage бросал 'no user in session' для админа —
   и загрузка скриншота из /admin/support/:id падала 500, хотя UI
   обещал Ctrl+V.
   ═══════════════════════════════════════════════════════════ */
function saveSupportImage(req, buffer, mimeType, { threadId = null } = {}) {
  const ext = filesPolicy.imageExtFromMime(mimeType);
  if (!ext) throw new Error('unsupported image type');

  let folder = null;

  if (isAdmin(req)) {
    const tid = Number(threadId);
    if (!Number.isSafeInteger(tid) || tid < 1) {
      throw new Error('admin upload requires valid thread_id');
    }
    const thread = db.prepare(
      'SELECT student_id, teacher_id FROM support_threads WHERE id = ?'
    ).get(tid);
    if (!thread) throw new Error('support thread not found');
    if (thread.student_id) folder = `s${Number(thread.student_id)}`;
    else if (thread.teacher_id) folder = `t${Number(thread.teacher_id)}`;
    else throw new Error('support thread has no owner');
  } else {
    const studentId = Number(req.session?.studentId);
    const teacherId = Number(req.session?.teacherId);
    if (studentId) folder = `s${studentId}`;
    else if (teacherId) folder = `t${teacherId}`;
    else throw new Error('no user in session');
  }

  const uuid = crypto.randomUUID();
  const filename = `sup-${uuid}${ext}`;
  const relativePath = path.posix.join(folder, filename);
  const absDir = path.join(SUPPORT_FILES_DIR, folder);
  fs.mkdirSync(absDir, { recursive: true });
  fs.writeFileSync(path.join(absDir, filename), buffer);
  return { relativePath, filename };
}

function resolveSupportImage(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  if (!SUPPORT_IMAGE_RE.test(relPath)) return null;
  const abs = path.join(SUPPORT_FILES_DIR, relPath);
  if (!abs.startsWith(SUPPORT_FILES_DIR + path.sep)) return null;
  if (!fs.existsSync(abs)) return null;
  return relPath;
}

function checkUser(req, res, next) {
  if (isAdmin(req)) return res.redirect('/admin/support');
  if (isStudent(req) || isTeacher(req)) return next();
  return res.redirect('/login');
}

function checkAnyAuth(req, res, next) {
  if (isAdmin(req) || isStudent(req) || isTeacher(req)) return next();
  return res.status(401).json({
    ok: false,
    error: 'unauthorized',
    message: 'Требуется вход в систему.',
  });
}

function senderOf(req) {
  if (req.session?.adminId) {
    return { type: 'admin', id: req.session.adminId, name: req.session.adminName || 'Администратор' };
  }
  if (req.session?.studentId) {
    return { type: 'user', id: req.session.studentId, name: req.session.studentName || 'Студент' };
  }
  if (req.session?.teacherId) {
    return { type: 'user', id: req.session.teacherId, name: req.session.teacherName || 'Преподаватель' };
  }
  return null;
}

router.get('/support', checkUser, handler((req, res) => {
  const thread = chat.getOrCreateSupportThread(req);
  if (!thread) return res.redirect('/login');
  chat.markRead('support', thread.id, 'user');
  const q = pickStr(req.query.q, 200);
  const messages = chat.listMessages('support', thread.id, { q });
  const role = isStudent(req) ? 'student' : 'teacher';
  const userName = req.session.studentName || req.session.teacherName || 'Пользователь';
  return renderWith(res, 'support/thread', {
    title: 'Поддержка',
    thread, messages, role, userName,
    q,
    deletedMsgId: req.query.deleted ? Number(req.query.deleted) : null,
  });
}));

router.get('/support/messages.json', checkUser, handler((req, res) => {
  const thread = chat.getOrCreateSupportThread(req);
  if (!thread) {
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      message: 'Требуется вход в систему.',
    });
  }
  chat.markRead('support', thread.id, 'user');
  const q = pickStr(req.query.q, 200);
  res.set('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    messages: chat.listMessages('support', thread.id, { q }),
  });
}));

router.post(
  '/support',
  checkUser,
  chatRateLimit('support_msg'),
  handler((req, res) => {
    const thread = chat.getOrCreateSupportThread(req);
    if (!thread) return res.redirect('/login');
    const text = pickStr(req.body.message, 5000);
    const rawFilePath = pickStr(req.body.file_path, 500);
    const fileName = fixFilename(pickStr(req.body.file_name, 255));
    const filePath = resolveSupportImage(rawFilePath);
    if (!text && !filePath) return res.redirect('/support');
    const sender = senderOf(req);
    if (!sender) return res.redirect('/login');
    db.transaction(() => {
      chat.addMessage('support', thread.id, {
        senderType: 'user',
        senderId: sender.id,
        senderName: sender.name,
        message: text,
        file_path: filePath,
        file_name: filePath ? (fileName || null) : null,
      });
      chat.touchSupportThread(thread.id);
    })();
    return res.redirect('/support');
  })
);

router.post('/support/messages/:id/delete', checkUser, handler(async (req, res) => {
  const thread = chat.getOrCreateSupportThread(req);
  if (!thread) return res.redirect('/login');
  const messageId = Number(req.params.id);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.redirect('/support');
  const m = db.prepare(
    'SELECT * FROM support_messages WHERE id = ? AND thread_id = ?'
  ).get(messageId, thread.id);
  const sender = senderOf(req);
  const viewerRole = sender?.type === 'admin' ? 'admin' : 'student';
  if (!m || !chat.canDeleteSupportMessage(m, viewerRole)) {
    return res.redirect('/support');
  }
  const result = chat.softDelete('support', messageId, sender.type, sender.id);
  if (result?.file_path) {
    try {
      const abs = path.join(SUPPORT_FILES_DIR, result.file_path);
      if (abs.startsWith(SUPPORT_FILES_DIR + path.sep)) {
        await fs.promises.unlink(abs).catch(() => {});
      }
    } catch { /* ignore */ }
  }
  return redirectWith(res, '/support', { deleted: messageId });
}));

/* ═══════════════════════════════════════════════════════════
   POST /support/upload-image
   ═══════════════════════════════════════════════════════════
   Используется и в личной поддержке (студент/преподаватель),
   и в админской (/admin/support/:id → тот же эндпоинт).

   Админ обязан передать thread_id в теле — по нему определяется
   папка автора треда. Студент/преподаватель thread_id игнорирует,
   папка берётся из сессии.

   Старая версия saveSupportImage для админа падала с
   no user in session (в сессии только adminId), и загрузка шла 500.
   ═══════════════════════════════════════════════════════════ */
router.post(
  '/support/upload-image',
  checkAnyAuth,
  rateLimitAction('support_upload', { max: 20, windowMs: 60_000, blockMs: 300_000 }),
  (req, res, next) => {
    supportUpload.single('image')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            ok: false,
            error: 'file_too_large',
            message: `Файл больше ${filesPolicy.MAX_FILE_SIZE_MB} МБ`,
          });
        }
        return res.status(400).json({
          ok: false,
          error: 'upload_failed',
          message: err.message || 'Ошибка загрузки',
        });
      }
      next();
    });
  },
  handler((req, res) => {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        error: 'no_file',
        message: 'Файл не передан',
      });
    }
    if (!filesPolicy.isAllowedImageMime(req.file.mimetype)
        || !isValidImageBuffer(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_image_type',
        message: 'Недопустимый формат. Разрешены: '
          + filesPolicy.formatExtList(filesPolicy.IMAGE_EXTENSIONS),
      });
    }

    const threadIdRaw = Number(req.body.thread_id);
    const threadId = Number.isSafeInteger(threadIdRaw) && threadIdRaw > 0
      ? threadIdRaw : null;

    let saved;
    try {
      saved = saveSupportImage(req, req.file.buffer, req.file.mimetype, { threadId });
    } catch (e) {
      // no user in session / thread not found / admin upload requires thread_id —
      // отдаём клиенту понятную ошибку, а не 500.
      const code = e.message === 'support thread not found' ? 'not_found'
        : e.message === 'admin upload requires valid thread_id' ? 'bad_thread'
        : 'upload_failed';
      const status = code === 'not_found' ? 404 : 400;
      return res.status(status).json({
        ok: false,
        error: code,
        message: 'Не удалось сохранить файл.',
      });
    }
    const { relativePath, filename } = saved;
    return res.json({
      ok: true,
      path: relativePath,
      url: `/support/image/${encodeURIComponent(filename)}`,
    });
  })
);

router.get('/support/image/:filename', (req, res) => {
  if (!req.session?.adminId && !req.session?.studentId && !req.session?.teacherId) {
    return res.status(401).send('Требуется вход в систему.');
  }
  const filename = String(req.params.filename || '');
  if (!SUPPORT_FILENAME_RE.test(filename) || filename !== path.basename(filename)) {
    return res.status(404).send('Файл не найден.');
  }
  const row = db.prepare(`
    SELECT m.file_path, t.student_id, t.teacher_id
    FROM support_messages m
    JOIN support_threads t ON t.id = m.thread_id
    WHERE substr(m.file_path, -length(?)) = ?
    LIMIT 1
  `).get(filename, filename);
  if (!row) return res.status(404).send('Файл не найден.');
  const allowed = !!req.session?.adminId
    || (req.session?.studentId && Number(req.session.studentId) === Number(row.student_id))
    || (req.session?.teacherId && Number(req.session.teacherId) === Number(row.teacher_id));
  if (!allowed) return res.status(404).send('Файл не найден.');
  const safe = resolveSupportImage(row.file_path);
  if (!safe) return res.status(404).send('Файл не найден.');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.sendFile(path.join(SUPPORT_FILES_DIR, safe));
});

module.exports = router;