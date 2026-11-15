// utils/storage/cascade.js
'use strict';
const db = require('../../database');
const {
  cleanupSubmissionFiles, cleanupAssignmentFiles,
} = require('./cleanup');

/**
 * Полное каскадное удаление задания вместе со всеми сдачами.
 *
 *  1. Для каждой сдачи — удаляются её attachment'ы (owner_kind='submission')
 *     и файлы чата (messages.file_path) с диска.
 *  2. Удаляются сами сдачи — messages уходят ON DELETE CASCADE по FK.
 *  3. Удаляются attachment'ы самого задания (owner_kind='assignment').
 *  4. Удаляется строка assignments.
 *
 * ВНИМАНИЕ: необратимо. Вызывающий код обязан проверить наличие сдач
 * и явно запросить force-режим (см. routes/teacher/content.js).
 *
 * @param {number} assignmentId
 * @returns {Promise<{submissions: number, files: number}>}
 *   submissions — сколько работ удалено,
 *   files       — сколько файлов удалено с диска (сдачи + задание).
 */
async function cascadeDeleteAssignment(assignmentId) {
  const aid = Number(assignmentId);
  if (!Number.isSafeInteger(aid) || aid < 1) {
    return { submissions: 0, files: 0 };
  }

  const submissions = db.prepare(
    'SELECT id FROM submissions WHERE assignment_id = ?'
  ).all(aid);

  let files = 0;

  // 1. Файлы сдач (attachments + chat files)
  for (const sub of submissions) {
    try {
      files += db.prepare(
        "SELECT COUNT(*) AS c FROM attachments WHERE owner_kind = 'submission' AND owner_id = ?"
      ).get(sub.id).c;
      files += db.prepare(
        'SELECT COUNT(*) AS c FROM messages WHERE submission_id = ? AND file_path IS NOT NULL'
      ).get(sub.id).c;
      await cleanupSubmissionFiles(db, sub.id);
    } catch (e) {
      // Не прерываемся: лучше оставить один битый файл, чем всё задание.
      console.error('[cascade] cleanupSubmissionFiles:', sub.id, e);
    }
  }

  // 2. Attachment'ы самого задания
  try {
    files += db.prepare(
      "SELECT COUNT(*) AS c FROM attachments WHERE owner_kind = 'assignment' AND owner_id = ?"
    ).get(aid).c;
    await cleanupAssignmentFiles(db, aid);
  } catch (e) {
    console.error('[cascade] cleanupAssignmentFiles:', aid, e);
  }

  // 3. Удаляем сдачи (messages → ON DELETE CASCADE)
  if (submissions.length > 0) {
    const ph = submissions.map(() => '?').join(',');
    db.prepare(`DELETE FROM submissions WHERE id IN (${ph})`)
      .run(...submissions.map((s) => s.id));
  }

  // 4. Удаляем само задание
  db.prepare('DELETE FROM assignments WHERE id = ?').run(aid);

  return { submissions: submissions.length, files };
}

module.exports = { cascadeDeleteAssignment };