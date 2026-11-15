// utils/storage/cleanup.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../../config');
const { SUPPORT_FILES_DIR } = require('./paths');
const { safeJoin } = require('../helpers');

async function unlinkQuiet(abs) {
  try { await fs.promises.unlink(abs); }
  catch (e) { if (e.code !== 'ENOENT') console.error('unlink:', e); }
}

async function cleanupByOwner(db, kind, ownerId) {
  const files = db.prepare(
    'SELECT stored_name FROM attachments WHERE owner_kind = ? AND owner_id = ?'
  ).all(kind, Number(ownerId));
  for (const f of files) {
    if (f.stored_name) {
      try { await unlinkQuiet(safeJoin(config.STORAGE_DIR, f.stored_name)); } catch { /* ignore */ }
    }
  }
  db.prepare(
    'DELETE FROM attachments WHERE owner_kind = ? AND owner_id = ?'
  ).run(kind, Number(ownerId));
}

// URL картинок: /uploads/lecture-images/<subjectId>/<filename>
// Физический путь: subjects/<subjectId>/lecture-images/<filename>
// Регулярка ищет src в HTML темы; удаляем по списку.
const IMG_TAG_RE = /<img[^>]+src=["'](\/uploads\/lecture-images\/[^"']+)["']/gi;

async function cleanupImagesFromHtml(html) {
  if (!html) return;
  const srcs = new Set();
  for (const m of String(html).matchAll(IMG_TAG_RE)) {
    srcs.add(m[1]);
  }
  for (const src of srcs) {
    try {
      // src = '/uploads/lecture-images/<subjectId>/<filename>'
      // → rel = 'subjects/<subjectId>/lecture-images/<filename>'
      const m = src.match(/^\/uploads\/lecture-images\/(\d+)\/([^/]+)$/);
      if (!m) continue;
      const rel = path.posix.join('subjects', m[1], 'lecture-images', m[2]);
      const abs = safeJoin(config.STORAGE_DIR, rel);
      await unlinkQuiet(abs);
    } catch { /* ignore */ }
  }
}

// Удаляет все картинки Quill предмета: subjects/<subjectId>/lecture-images/
// Вызывается при удалении предмета.
async function cleanupTopicImages(db, subjectId) {
  const dir = path.join(config.STORAGE_DIR, 'subjects', String(subjectId), 'lecture-images');
  if (fs.existsSync(dir)) {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// Удаляет файлы сдачи:
//   • attachments с owner_kind='submission' (файлы, приложенные к работе)
//   • messages.file_path (вложения в чате по работе)
// Оба теперь лежат в subjects/<subjectId>/works/<assignmentId>/<studentId>/.
// Папку целиком НЕ удаляем: у пары assignment-student может быть несколько
// submissions (активная + архивные), у каждой — свои файлы.
// Поэтому — точечно по stored_name / file_path из БД.
async function cleanupSubmissionFiles(db, submissionId) {
  await cleanupByOwner(db, 'submission', submissionId);
  const msgs = db.prepare(
    "SELECT file_path FROM messages WHERE submission_id = ? AND file_path IS NOT NULL"
  ).all(submissionId);
  for (const m of msgs) {
    try {
      await unlinkQuiet(safeJoin(config.STORAGE_DIR, m.file_path));
    } catch { /* ignore */ }
  }
}

async function cleanupTopicFiles(db, topicId) {
  await cleanupByOwner(db, 'topic', topicId);
}

async function cleanupAssignmentFiles(db, assignmentId) {
  await cleanupByOwner(db, 'assignment', assignmentId);
}

// Чистит групповые сообщения конкретного студента:
//   • файлы из group_messages.file_path (STORAGE_DIR/groups/<gid>/<tid>/...)
//   • сами сообщения → soft-delete, чтобы не висели с несуществующим sender_id
// Это нужно при жёстком удалении студента: group_messages не имеет FK
// на students, каскад не сработает.
async function cleanupStudentGroupMessages(db, studentId) {
  const rows = db.prepare(`
    SELECT id, file_path FROM group_messages
    WHERE sender_type = 'student' AND sender_id = ?
  `).all(Number(studentId));
  for (const m of rows) {
    if (m.file_path) {
      try {
        await unlinkQuiet(safeJoin(config.STORAGE_DIR, m.file_path));
      } catch { /* ignore */ }
    }
  }
  if (rows.length > 0) {
    db.prepare(`
      UPDATE group_messages
      SET message = '', file_path = NULL, file_name = NULL,
          deleted_at = CURRENT_TIMESTAMP,
          deleted_by_type = 'student', deleted_by_id = ?
      WHERE sender_type = 'student' AND sender_id = ?
    `).run(Number(studentId), Number(studentId));
  }
}

async function cleanupStudentFiles(db, studentId) {
  const sid = Number(studentId);
  if (!Number.isSafeInteger(sid) || sid < 1) return;

  const subs = db.prepare('SELECT id FROM submissions WHERE student_id = ?').all(sid);
  for (const s of subs) {
    try { await cleanupSubmissionFiles(db, s.id); } catch { /* ignore */ }
  }

  // Групповые чаты: файлы + soft-delete сообщений.
  // Раньше этот блок отсутствовал, и после жёсткого удаления студента
  // в data/storage/groups/... оставались его файлы, а в чате — записи
  // с sender_id, указывающим в никуда.
  try { await cleanupStudentGroupMessages(db, sid); } catch { /* ignore */ }

  // Скриншоты поддержки.
  const supportFiles = db.prepare(`
    SELECT m.file_path FROM support_messages m
    JOIN support_threads t ON t.id = m.thread_id
    WHERE t.student_id = ? AND m.file_path IS NOT NULL
  `).all(sid);
  for (const m of supportFiles) {
    try { await unlinkQuiet(safeJoin(SUPPORT_FILES_DIR, m.file_path)); } catch { /* ignore */ }
  }
}

async function cleanupTeacherFiles(db, teacherId) {
  const tid = Number(teacherId);
  if (!Number.isSafeInteger(tid) || tid < 1) return;

  const subs = db.prepare('SELECT id FROM submissions WHERE teacher_id = ?').all(tid);
  for (const s of subs) {
    try { await cleanupSubmissionFiles(db, s.id); } catch { /* ignore */ }
  }

  const assignments = db.prepare('SELECT id FROM assignments WHERE teacher_id = ?').all(tid);
  for (const a of assignments) {
    try { await cleanupAssignmentFiles(db, a.id); } catch { /* ignore */ }
  }

  const topics = db.prepare(`
    SELECT t.id, t.description FROM topics t
    JOIN subjects s ON s.id = t.subject_id
    WHERE s.teacher_id = ?
  `).all(tid);
  for (const t of topics) {
    try { await cleanupTopicFiles(db, t.id); } catch { /* ignore */ }
    try { await cleanupImagesFromHtml(t.description); } catch { /* ignore */ }
  }

  const subjects = db.prepare('SELECT id FROM subjects WHERE teacher_id = ?').all(tid);
  for (const s of subjects) {
    try { await cleanupTopicImages(db, s.id); } catch { /* ignore */ }
  }

  // Групповые чаты преподавателя: groups/<groupId>/<teacherId>/chat-<uuid>.<ext>
  const groupMsgs = db.prepare(`
    SELECT gm.file_path FROM group_messages gm
    JOIN group_threads gt ON gt.id = gm.thread_id
    WHERE gt.teacher_id = ? AND gm.file_path IS NOT NULL
  `).all(tid);
  for (const m of groupMsgs) {
    try {
      await unlinkQuiet(safeJoin(config.STORAGE_DIR, m.file_path));
    } catch { /* ignore */ }
  }

  const supportFiles = db.prepare(`
    SELECT m.file_path FROM support_messages m
    JOIN support_threads t ON t.id = m.thread_id
    WHERE t.teacher_id = ? AND m.file_path IS NOT NULL
  `).all(tid);
  for (const m of supportFiles) {
    try { await unlinkQuiet(safeJoin(SUPPORT_FILES_DIR, m.file_path)); } catch { /* ignore */ }
  }
}

module.exports = {
  unlinkQuiet,
  cleanupImagesFromHtml,
  cleanupSubmissionFiles,
  cleanupTopicFiles,
  cleanupAssignmentFiles,
  cleanupStudentFiles,
  cleanupTeacherFiles,
  cleanupTopicImages,
};