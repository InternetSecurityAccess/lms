// routes/files.js
'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const router = express.Router();
const db = require('../database');
const config = require('../config');
const { safeJoin, parseId } = require('../utils/helpers');
const { sendFile } = require('./shared/http');
const { nowSql } = require('../utils/dates');
const {
  canAccessProtectedContent,
  isAdmin, isTeacher, isStudent,
  isOwnerStudent, isAddresseeTeacher,
  isStudentOfGroup, isStudentOfSubject,
} = require('./shared/authz');
const { SUPPORT_FILES_DIR } = require('../utils/storage/paths');
const attachments = require('../utils/attachments');
const SUPPORT_IMAGE_FILENAME_RE = /^sup-[a-f0-9-]+\.(png|jpg|jpeg)$/i;

/**
 * Снимок истории: файл виден студенту, если тема/задание были созданы
 * до закрытия группы и (available_from IS NULL или наступил до закрытия).
 * Возвращает:
 *   { allowed: true } — видно;
 *   { allowed: false } — не видно;
 *   { allowed: true, denied: true } — если есть активная пара, проверим
 *     обычные правила available_from.
 *
 * Возвращает объект вида:
 *   { mode: 'active', available_from, created_at }
 *   { mode: 'history', finished_at, created_at, available_from }
 *   { mode: 'none' } — нет ни пары, ни истории.
 */
function resolvePairMode(subjectId, groupId) {
  const active = !!db.prepare(
    'SELECT 1 FROM subject_groups WHERE subject_id = ? AND group_id = ?'
  ).get(subjectId, groupId);
  if (active) return { mode: 'active' };
  const hist = db.prepare(`
    SELECT MAX(finished_at) AS f FROM subject_groups_history
    WHERE subject_id = ? AND group_id = ?
  `).get(subjectId, groupId);
  if (hist && hist.f) return { mode: 'history', finished_at: hist.f };
  return { mode: 'none' };
}

function topicVisibleForStudent({ created_at, available_from }, pairMode) {
  if (pairMode.mode === 'active') {
    if (available_from && available_from > nowSql()) return false;
    return true;
  }
  if (pairMode.mode === 'history') {
    const f = pairMode.finished_at;
    if (created_at && created_at > f) return false;
    if (available_from && available_from > f) return false;
    return true;
  }
  return false;
}

router.get('/download/:id', (req, res) => {
  const suffix = req.url.includes('inline=1') ? '?inline=1' : '';
  return res.redirect(301, `/file/submission/${req.params.id}${suffix}`);
});
router.get('/download-file/:fileId', (req, res) => {
  const suffix = req.url.includes('inline=1') ? '?inline=1' : '';
  return res.redirect(301, `/file/attachment/${req.params.fileId}${suffix}`);
});
router.get('/chat/download/:filename', (req, res) => {
  const suffix = req.url.includes('inline=1') ? '?inline=1' : '';
  return res.redirect(301,
    `/file/chat-file/${encodeURIComponent(req.params.filename)}${suffix}`);
});
router.get('/file/:kind/:id', (req, res, next) => {
  if (!canAccessProtectedContent(req)) return res.status(404).send('Файл не найден.');
  const { kind } = req.params;
  try {
    switch (kind) {
      case 'submission':     return handleSubmission(req, res, next);
      case 'attachment':     return handleAttachment(req, res, next);
      case 'chat-file':      return handleChatFile(req, res, next);
      case 'support-image':  return handleSupportImage(req, res, next);
      default:               return res.status(404).send('Файл не найден.');
    }
  } catch (e) { return next(e); }
});
router.get(
  '/uploads/lecture-images/:subjectId/:filename',
  handleLectureImage
);
router.get(
  '/file/lecture-image/:subjectId/:filename',
  handleLectureImage
);

/* ─── /file/submission/:id ─── */
function handleSubmission(req, res, next) {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).send('Файл не найден.');
  const work = db.prepare(`
    SELECT s.*, a.subject_id,
           sub.status AS subject_status, sub.deleted_at AS subject_deleted_at,
           t.status AS teacher_status, t.deleted_at AS teacher_deleted_at
    FROM submissions s
    LEFT JOIN assignments a ON a.id = s.assignment_id
    LEFT JOIN subjects sub ON sub.id = a.subject_id
    LEFT JOIN teachers t ON t.id = s.teacher_id
    WHERE s.id = ?
  `).get(id);
  if (!work) return res.status(404).send('Файл не найден.');
  if (isStudent(req)) {
    if (work.deleted_at) return res.status(404).send('Файл не найден.');
    if (work.subject_deleted_at) return res.status(404).send('Файл не найден.');
    if (work.teacher_deleted_at) return res.status(404).send('Файл не найден.');
    // Снимок истории: если группа отвязана, работа должна быть сдана до закрытия.
    const student = req.currentStudent;
    if (student) {
      const pairMode = resolvePairMode(work.subject_id, student.group_id);
      if (pairMode.mode === 'history' && pairMode.finished_at
          && work.uploaded_at && work.uploaded_at > pairMode.finished_at) {
        return res.status(404).send('Файл не найден.');
      }
      if (pairMode.mode === 'none') {
        // Нет ни пары, ни истории — legacy. Проверим по сдаче (она есть).
        // Разрешаем — но только владельцу.
      }
    }
  }
  const allowed = isAdmin(req)
    || isOwnerStudent(req, work)
    || isAddresseeTeacher(req, work);
  if (!allowed) return res.status(404).send('Файл не найден.');
  const first = attachments.listAttachments('submission', id)[0];
  if (!first) return res.status(404).send('Файл не найден.');
  return sendFile(req, res, next,
    safeJoin(config.STORAGE_DIR, first.stored_name), first.filename);
}

/* ─── /file/attachment/:id ─── */
function handleAttachment(req, res, next) {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).send('Файл не найден.');
  const att = attachments.getAttachment(id);
  if (!att) return res.status(404).send('Файл не найден.');
  let allowed = false;

  if (att.owner_kind === 'submission') {
    const sub = db.prepare(`
      SELECT s.student_id, s.teacher_id, s.deleted_at, s.uploaded_at,
             a.subject_id, sub.status AS subject_status,
             sub.deleted_at AS subject_deleted_at,
             t.status AS teacher_status, t.deleted_at AS teacher_deleted_at
      FROM submissions s
      LEFT JOIN assignments a ON a.id = s.assignment_id
      LEFT JOIN subjects sub ON sub.id = a.subject_id
      LEFT JOIN teachers t ON t.id = s.teacher_id
      WHERE s.id = ?
    `).get(att.owner_id);
    if (!sub) return res.status(404).send('Файл не найден.');
    if (isStudent(req)) {
      if (sub.deleted_at) return res.status(404).send('Файл не найден.');
      if (sub.subject_deleted_at) return res.status(404).send('Файл не найден.');
      if (sub.teacher_deleted_at) return res.status(404).send('Файл не найден.');
      const student = req.currentStudent;
      if (student) {
        const pm = resolvePairMode(sub.subject_id, student.group_id);
        if (pm.mode === 'history' && pm.finished_at
            && sub.uploaded_at && sub.uploaded_at > pm.finished_at) {
          return res.status(404).send('Файл не найден.');
        }
      }
    }
    allowed = isAdmin(req) || isOwnerStudent(req, sub) || isAddresseeTeacher(req, sub);
  } else if (att.owner_kind === 'topic') {
    const t = db.prepare(`
      SELECT t.subject_id, t.status, t.deleted_at,
             t.created_at, t.available_from,
             s.teacher_id, s.status AS subject_status,
             s.deleted_at AS subject_deleted_at,
             tt.status AS teacher_status, tt.deleted_at AS teacher_deleted_at
      FROM topics t
      JOIN subjects s ON s.id = t.subject_id
      LEFT JOIN teachers tt ON tt.id = s.teacher_id
      WHERE t.id = ?
    `).get(att.owner_id);
    if (!t) return res.status(404).send('Файл не найден.');
    if (isStudent(req)) {
      if (t.deleted_at) return res.status(404).send('Файл не найден.');
      if (t.status === 'draft') return res.status(404).send('Файл не найден.');
      if (t.subject_deleted_at) return res.status(404).send('Файл не найден.');
      if (t.teacher_deleted_at) return res.status(404).send('Файл не найден.');
      const student = req.currentStudent;
      if (student) {
        const pm = resolvePairMode(t.subject_id, student.group_id);
        if (!topicVisibleForStudent(
          { created_at: t.created_at, available_from: t.available_from },
          pm
        )) {
          return res.status(404).send('Файл не найден.');
        }
      }
    }
    allowed = isAdmin(req)
      || (isTeacher(req) && Number(req.session.teacherId) === Number(t.teacher_id))
      || (isStudent(req) && isStudentOfSubject(req, t.subject_id));
  } else if (att.owner_kind === 'assignment') {
    const a = db.prepare(`
      SELECT a.subject_id, a.teacher_id, a.status, a.deleted_at,
             s.status AS subject_status, s.deleted_at AS subject_deleted_at,
             t.status AS teacher_status, t.deleted_at AS teacher_deleted_at
      FROM assignments a
      LEFT JOIN subjects s ON s.id = a.subject_id
      LEFT JOIN teachers t ON t.id = a.teacher_id
      WHERE a.id = ?
    `).get(att.owner_id);
    if (!a) return res.status(404).send('Файл не найден.');
    if (isStudent(req)) {
      if (a.deleted_at) return res.status(404).send('Файл не найден.');
      if (a.status === 'draft') return res.status(404).send('Файл не найден.');
      if (a.subject_deleted_at) return res.status(404).send('Файл не найден.');
      if (a.teacher_deleted_at) return res.status(404).send('Файл не найден.');
      const student = req.currentStudent;
      if (student) {
        // Тема-обёртка задания: проверяем created_at/available_from.
        const topic = db.prepare(
          'SELECT created_at, available_from FROM topics WHERE assignment_id = ? AND deleted_at IS NULL LIMIT 1'
        ).get(att.owner_id);
        if (topic) {
          const pm = resolvePairMode(a.subject_id, student.group_id);
          if (!topicVisibleForStudent(
            { created_at: topic.created_at, available_from: topic.available_from },
            pm
          )) {
            return res.status(404).send('Файл не найден.');
          }
        }
      }
    }
    allowed = isAdmin(req)
      || (isTeacher(req) && Number(req.session.teacherId) === Number(a.teacher_id))
      || (isStudent(req) && isStudentOfSubject(req, a.subject_id));
  } else {
    return res.status(404).send('Файл не найден.');
  }

  if (!allowed) return res.status(404).send('Файл не найден.');
  return sendFile(req, res, next,
    safeJoin(config.STORAGE_DIR, att.stored_name), att.filename);
}

/* ─── /file/chat-file/:filename ─── */
function handleChatFile(req, res, next) {
  const filename = String(req.params.id || '');
  if (!filename
      || filename !== path.basename(filename)
      || filename.includes('..')
      || filename.includes('/')
      || filename.includes('\\')) {
    return res.status(404).send('Файл не найден.');
  }
  const msg = db.prepare(`
    SELECT m.file_name, m.file_path, m.created_at,
           s.student_id, s.teacher_id, s.deleted_at AS sub_deleted_at,
           s.uploaded_at AS sub_uploaded_at,
           a.subject_id, sub.status AS subject_status,
           sub.deleted_at AS subject_deleted_at,
           t.status AS teacher_status, t.deleted_at AS teacher_deleted_at
    FROM messages m
    JOIN submissions s ON s.id = m.submission_id
    LEFT JOIN assignments a ON a.id = s.assignment_id
    LEFT JOIN subjects sub ON sub.id = a.subject_id
    LEFT JOIN teachers t ON t.id = s.teacher_id
    WHERE substr(m.file_path, -length(?)) = ?
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  `).get(filename, filename);
  const gm = db.prepare(`
    SELECT gm.file_name, gm.file_path,
           gt.group_id, gt.teacher_id,
           g.deleted_at AS group_deleted_at,
           t.status AS teacher_status, t.deleted_at AS teacher_deleted_at
    FROM group_messages gm
    JOIN group_threads gt ON gt.id = gm.thread_id
    LEFT JOIN groups g ON g.id = gt.group_id
    LEFT JOIN teachers t ON t.id = gt.teacher_id
    WHERE substr(gm.file_path, -length(?)) = ?
    ORDER BY gm.created_at DESC, gm.id DESC
    LIMIT 1
  `).get(filename, filename);
  let storagePath, displayName, allowed = false;
  if (msg) {
    if (isStudent(req)) {
      if (msg.sub_deleted_at) return res.status(404).send('Файл не найден.');
      if (msg.subject_deleted_at) return res.status(404).send('Файл не найден.');
      if (msg.teacher_deleted_at) return res.status(404).send('Файл не найден.');
      const student = req.currentStudent;
      if (student) {
        const pm = resolvePairMode(msg.subject_id, student.group_id);
        if (pm.mode === 'history' && pm.finished_at
            && msg.sub_uploaded_at && msg.sub_uploaded_at > pm.finished_at) {
          return res.status(404).send('Файл не найден.');
        }
        // Сообщения после закрытия тоже не показываем.
        if (pm.mode === 'history' && pm.finished_at
            && msg.created_at && msg.created_at > pm.finished_at) {
          return res.status(404).send('Файл не найден.');
        }
      }
    }
    allowed = isAdmin(req) || isOwnerStudent(req, msg) || isAddresseeTeacher(req, msg);
    storagePath = msg.file_path;
    displayName = msg.file_name;
  } else if (gm) {
    if (isStudent(req)) {
      if (gm.group_deleted_at) return res.status(404).send('Файл не найден.');
      if (gm.teacher_deleted_at) return res.status(404).send('Файл не найден.');
    }
    allowed = isAdmin(req)
      || (isTeacher(req) && Number(req.session.teacherId) === Number(gm.teacher_id))
      || (isStudent(req) && isStudentOfGroup(req, gm.group_id));
    storagePath = gm.file_path;
    displayName = gm.file_name;
  } else {
    return res.status(404).send('Файл не найден.');
  }
  if (!allowed) return res.status(404).send('Файл не найден.');
  return sendFile(req, res, next,
    safeJoin(config.STORAGE_DIR, storagePath), displayName);
}

/* ─── /file/support-image/:id ─── */
function handleSupportImage(req, res, next) {
  const filename = String(req.params.id || '');
  if (!SUPPORT_IMAGE_FILENAME_RE.test(filename)) {
    return res.status(404).send('Файл не найден.');
  }
  const row = db.prepare(`
    SELECT m.file_path, t.student_id, t.teacher_id
    FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
    WHERE substr(m.file_path, -length(?)) = ?
    LIMIT 1
  `).get(filename, filename);
  if (!row) return res.status(404).send('Файл не найден.');
  const allowed = isAdmin(req)
    || (isStudent(req) && Number(req.session.studentId) === Number(row.student_id))
    || (isTeacher(req) && Number(req.session.teacherId) === Number(row.teacher_id));
  if (!allowed) return res.status(404).send('Файл не найден.');
  let abs;
  try { abs = safeJoin(SUPPORT_FILES_DIR, row.file_path); }
  catch { return res.status(404).send('Файл не найден.'); }
  return sendFile(req, res, next, abs, filename);
}

/* ─── /uploads/lecture-images/:subjectId/:filename ─── */
function handleLectureImage(req, res, next) {
  const subjectId = parseId(req.params.subjectId);
  const filename = String(req.params.filename || '');
  if (!subjectId) return res.status(404).send('Файл не найден.');
  if (!/^[a-f0-9-]+\.(png|jpg|jpeg)$/i.test(filename)) {
    return res.status(404).send('Файл не найден.');
  }
  const subject = db.prepare(`
    SELECT s.teacher_id, s.status, s.deleted_at,
           t.status AS teacher_status, t.deleted_at AS teacher_deleted_at
    FROM subjects s
    LEFT JOIN teachers t ON t.id = s.teacher_id
    WHERE s.id = ?
  `).get(subjectId);
  if (!subject || subject.deleted_at || subject.teacher_deleted_at) {
    return res.status(404).send('Файл не найден.');
  }
  const allowed = isAdmin(req)
    || (isTeacher(req) && Number(req.session.teacherId) === Number(subject.teacher_id))
    || (isStudent(req) && isStudentOfSubject(req, subjectId));
  if (!allowed) return res.status(404).send('Файл не найден.');
  if (isStudent(req)) {
    const refPath = `/uploads/lecture-images/${subjectId}/${filename}`;
    const ref = db.prepare(`
      SELECT 1 FROM topics
      WHERE subject_id = ?
        AND status IN ('published','finished')
        AND deleted_at IS NULL
        AND description LIKE ?
      LIMIT 1
    `).get(subjectId, `%${refPath}%`);
    if (!ref) return res.status(404).send('Файл не найден.');
  }
  const rel = path.posix.join('subjects', String(subjectId), 'lecture-images', filename);
  const abs = safeJoin(config.STORAGE_DIR, rel);
  if (!fs.existsSync(abs)) return res.status(404).send('Файл не найден.');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.sendFile(abs, (err) => {
    if (err && !res.headersSent) {
      if (err.code === 'ENOENT') return res.status(404).send('Файл не найден.');
      return next(err);
    }
  });
}

module.exports = router;