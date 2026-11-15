// routes/student/works.js
'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const router = express.Router();
const db = require('../../database');
const filesPolicy = require('../../config/files');
const config = require('../../config');
const { checkStudent } = require('../shared/authz');
const { submitRateLimit } = require('../../middleware/rateLimit');
const { fixFilename, safeJoin } = require('../../utils/helpers');
const { workMultiUpload } = require('../../utils/storage');
const attachments = require('../../utils/attachments');
const {
  handler, renderWith, renderErr, uploadWithFallback, friendlyFileError,
  readonlyForbid,
} = require('../shared/handlers');
const { loadStudentRow, loadSubmissionAsStudent } = require('../shared/loaders');
const { normalizeSort } = require('../shared/lists');
const { makeSubmissionChatRouter } = require('../shared/chat-routes');
const { invalidateCounters, getCountersCached } = require('../../utils/counters');
const chat = require('../shared/chat');
const { nowSql } = require('../../utils/dates');

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  return [v];
}
function markStatusRead(submissionId, studentId, status) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO submission_status_reads
        (submission_id, reader_type, reader_id, read_status)
      VALUES (?, 'student', ?, ?)
    `).run(submissionId, studentId, status);
  } catch (e) {
    console.error('[markStatusRead:student]', e.message);
  }
}

function rejectReadonlySubmission(req, res, next) {
  if (!req.submission || !req.submission.readonly) return next();
  if (!req.submission.assignment_id) {
    return res.status(404).render('common/error', {
      title: 'Работа недоступна',
      message: 'Работа в архиве, задание не найдено.',
    });
  }
  return res.redirect(
    `/t/${req.submission.teacher_id}/assignments/${req.submission.assignment_id}/archive`
  );
}

const STUDENT_UNREAD_SQL = `
  (
    EXISTS (SELECT 1 FROM messages m
      WHERE m.submission_id = s.id AND m.sender_type = 'teacher'
        AND m.is_read = 0 AND m.deleted_at IS NULL)
    OR (
      s.status IN ('accepted','rejected')
      AND NOT EXISTS (
        SELECT 1 FROM submission_status_reads r
        WHERE r.submission_id = s.id
          AND r.reader_type = 'student' AND r.reader_id = @studentId
          AND r.read_status = s.status
      )
    )
    OR (s.ai_flag = 1 AND s.ai_flag_read_by_student = 0)
  )
`;

router.get(
  '/my-inbox',
  checkStudent, loadStudentRow,
  handler((req, res) => {
    const me = req.me;
    const q = String(req.query.q || '').trim().slice(0, 100);
    const filter = ['unread', 'rejected', 'accepted'].includes(req.query.filter)
      ? req.query.filter : 'unread';
    const sort = normalizeSort(req.query.sort,
      ['date_desc', 'date_asc', 'name_asc', 'name_desc']);
    let where = ' WHERE s.student_id = @studentId AND s.deleted_at IS NULL';
    where += " AND a.status = 'active' AND a.deleted_at IS NULL";
    where += " AND sj.status = 'active' AND sj.deleted_at IS NULL";
    where += " AND t.status = 'active' AND t.deleted_at IS NULL";
    where += ' AND g.deleted_at IS NULL';
    where += ` AND ${STUDENT_UNREAD_SQL}`;
    const params = { studentId: me.id };
    if (q) {
      where += ' AND (s.topic LIKE @q OR t.name LIKE @q OR a.title LIKE @q)';
      params.q = `%${q}%`;
    }
    if (filter !== 'unread') {
      where += ' AND s.status = @status';
      params.status = filter;
    }
    const orderBy = sort === 'date_asc' ? 's.uploaded_at ASC'
      : sort === 'name_asc' ? 't.name ASC'
      : sort === 'name_desc' ? 't.name DESC'
      : 's.uploaded_at DESC';
    const rows = db.prepare(`
      SELECT s.id, s.topic, s.status, s.uploaded_at,
        s.teacher_id, s.group_id,
        s.ai_flag, s.ai_flag_read_by_student,
        t.name AS counterpart_name,
        g.name AS group_name,
        a.title AS assignment_title,
        (SELECT COUNT(*) FROM messages m
          WHERE m.submission_id = s.id AND m.sender_type = 'teacher'
            AND m.is_read = 0 AND m.deleted_at IS NULL) AS unread_count,
        (
          s.status IN ('accepted','rejected')
          AND NOT EXISTS (
            SELECT 1 FROM submission_status_reads r
            WHERE r.submission_id = s.id
              AND r.reader_type = 'student' AND r.reader_id = @studentId
              AND r.read_status = s.status
          )
        ) AS unread_status,
        (SELECT m.message FROM messages m
          WHERE m.submission_id = s.id AND m.sender_type = 'teacher'
            AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC LIMIT 1) AS last_message,
        (SELECT m.created_at FROM messages m
          WHERE m.submission_id = s.id AND m.sender_type = 'teacher'
            AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
      FROM submissions s
      JOIN teachers t ON t.id = s.teacher_id
      JOIN groups g ON g.id = s.group_id
      JOIN assignments a ON a.id = s.assignment_id
      JOIN subjects sj ON sj.id = a.subject_id
      ${where}
      ORDER BY ${orderBy}
    `).all(params);
    for (const r of rows) {
      r.unread_status = !!r.unread_status;
      r.ai_flag = !!r.ai_flag;
      r.ai_flag_unread = !!r.ai_flag && !r.ai_flag_read_by_student;
      r.open_url = `/t/${r.teacher_id}/works/${r.id}`;
    }
    const countsRow = db.prepare(`
      WITH base AS (
        SELECT s.id, s.status, s.ai_flag, s.ai_flag_read_by_student,
          (
            EXISTS (SELECT 1 FROM messages m
              WHERE m.submission_id = s.id
                AND m.sender_type = 'teacher' AND m.is_read = 0
                AND m.deleted_at IS NULL)
            OR (
              s.status IN ('accepted','rejected')
              AND NOT EXISTS (
                SELECT 1 FROM submission_status_reads r
                WHERE r.submission_id = s.id
                  AND r.reader_type = 'student' AND r.reader_id = ?
                  AND r.read_status = s.status
              )
            )
            OR (s.ai_flag = 1 AND s.ai_flag_read_by_student = 0)
          ) AS has_unread
        FROM submissions s
        JOIN teachers t ON t.id = s.teacher_id
        JOIN groups g ON g.id = s.group_id
        JOIN assignments a ON a.id = s.assignment_id
        JOIN subjects sj ON sj.id = a.subject_id
        WHERE s.student_id = ? AND s.deleted_at IS NULL
          AND a.status = 'active' AND a.deleted_at IS NULL
          AND sj.status = 'active' AND sj.deleted_at IS NULL
          AND t.status = 'active' AND t.deleted_at IS NULL
          AND g.deleted_at IS NULL
      )
      SELECT
        SUM(CASE WHEN has_unread = 1 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN has_unread = 1 AND status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN has_unread = 1 AND status = 'accepted' THEN 1 ELSE 0 END) AS accepted
      FROM base
    `).get(me.id, me.id);
    const counts = {
      unread: Number(countsRow.unread || 0),
      rejected: Number(countsRow.rejected || 0),
      accepted: Number(countsRow.accepted || 0),
    };
    return renderWith(res, 'student/works/inbox', {
      title: 'Уведомления',
      me, rows, counts, q, filter, sort,
    });
  })
);

router.get(
  '/t/:teacherId/works/:id',
  checkStudent, loadStudentRow, loadSubmissionAsStudent, rejectReadonlySubmission,
  handler((req, res) => {
    chat.markRead('submission', req.submission.id, 'student');
    markStatusRead(req.submission.id, req.session.studentId, req.submission.status);
    invalidateCounters(req.sessionID);
    try {
      const c = getCountersCached(req.session, req.sessionID);
      res.locals.inboxCount = c.inboxCount;
    } catch { /* ignore */ }
    const q = String(req.query.q || '').trim().slice(0, 200);
    const messages = chat.listMessages('submission', req.submission.id, { q });
    return renderWith(res, 'student/works/submission', {
      title: req.submission.topic,
      me: req.me,
      submission: req.submission,
      attachments: req.submission.attachments,
      messages, q,
      justUploaded: req.query.new === '1',
      justReplaced: req.query.replaced === '1',
      basePath: `/t/${req.submission.teacher_id}/works/${req.submission.id}`,
    });
  })
);

router.use(
  '/t/:teacherId/works/:id',
  makeSubmissionChatRouter({
    basePath: (req) => `/t/${req.submission.teacher_id}/works/${req.submission.id}`,
    loadContext: [
      checkStudent,
      loadStudentRow,
      loadSubmissionAsStudent,
      rejectReadonlySubmission,
    ],
    canView: () => true,
    canWrite: (req) => req.submission.status !== 'accepted',
    getSender: (req) => ({
      type: 'student',
      id: req.session.studentId,
      name: req.session.studentName || 'Студент',
    }),
    getViewLocals: (req) => ({
      view: 'student/works/submission',
      locals: (messages, q) => ({
        title: req.submission.topic,
        me: req.me,
        submission: req.submission,
        attachments: req.submission.attachments,
        messages, q,
        justUploaded: false,
        justReplaced: false,
        basePath: `/t/${req.submission.teacher_id}/works/${req.submission.id}`,
      }),
    }),
  })
);

/**
 * loadFormLocals — общий для GET /submit, GET /archive, POST /submit.
 * Возвращает null, если задания для этого студента нет (нет пары / истории /
 * сдач, либо тема-обёртка вне видимости по снимку finished_at).
 *
 * submitBlocked — «сдача недоступна»:
 *   • группа/задание/предмет/преподаватель не active;
 *   • нет активной пары subject_groups;
 *   • не в группе предмета.
 */
async function loadFormLocals(me, teacherId, assignmentId) {
  const assignment = db.prepare(`
    SELECT a.*, s.title AS subject_title, s.id AS subject_id,
           s.status AS subject_status,
           t.name AS teacher_name, t.status AS teacher_status
    FROM assignments a
    JOIN subjects s ON s.id = a.subject_id
    JOIN teachers t ON t.id = s.teacher_id
    WHERE a.id = ? AND a.teacher_id = ? AND a.deleted_at IS NULL
      AND a.status IN ('active','finished')
      AND s.deleted_at IS NULL AND t.deleted_at IS NULL
  `).get(assignmentId, teacherId);
  if (!assignment) return null;

  const activePair = !!db.prepare(
    'SELECT 1 FROM subject_groups WHERE subject_id = ? AND group_id = ?'
  ).get(assignment.subject_id, me.group_id);
  const historyPair = !activePair
    ? db.prepare(`
        SELECT finished_at FROM subject_groups_history
        WHERE subject_id = ? AND group_id = ?
        ORDER BY finished_at DESC LIMIT 1
      `).get(assignment.subject_id, me.group_id)
    : null;
  const hasSubs = !!db.prepare(`
    SELECT 1 FROM submissions
    WHERE assignment_id = ? AND student_id = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(assignmentId, me.id);

  if (!activePair && !historyPair && !hasSubs) return null;

  // Тема-обёртка: проверка created_at/available_from.
  const topic = db.prepare(
    'SELECT id, content_url, available_from, created_at FROM topics WHERE assignment_id = ? AND deleted_at IS NULL LIMIT 1'
  ).get(assignmentId) || null;
  if (topic) {
    if (historyPair && historyPair.finished_at) {
      if (topic.created_at && topic.created_at > historyPair.finished_at) return null;
      if (topic.available_from && topic.available_from > historyPair.finished_at) return null;
    } else if (topic.available_from && topic.available_from > nowSql()) {
      return null;
    }
    topic.attachments = attachments.listAttachments('topic', topic.id);
  }

  assignment.attachments = attachments.listAttachments('assignment', assignmentId);
  const inGroup = activePair;
  const works = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM messages m
        WHERE m.submission_id = s.id AND m.sender_type = 'teacher'
          AND m.is_read = 0 AND m.deleted_at IS NULL) AS unread_count,
      (SELECT COUNT(*) FROM attachments a
        WHERE a.owner_kind = 'submission' AND a.owner_id = s.id) AS files_count
    FROM submissions s
    WHERE s.assignment_id = ? AND s.student_id = ? AND s.deleted_at IS NULL
    ORDER BY s.uploaded_at DESC
  `).all(assignmentId, me.id);
  const existing = works[0] || null;
  const existingFiles = existing ? attachments.listAttachments('submission', existing.id) : [];
  const submitBlocked =
    me.group_status !== 'active'
    || assignment.status !== 'active'
    || assignment.subject_status !== 'active'
    || assignment.teacher_status !== 'active'
    || !inGroup;
  let blockReason = null;
  if (submitBlocked) {
    if (assignment.status === 'finished') blockReason = 'assignment_finished';
    else if (assignment.subject_status !== 'active') blockReason = 'subject_finished';
    else if (assignment.teacher_status !== 'active') blockReason = 'teacher_finished';
    else if (me.group_status !== 'active') blockReason = 'group_finished';
    else if (!inGroup) blockReason = 'not_in_group';
  }
  return {
    title: assignment.title,
    me, assignment, topic, works, existing, existingFiles,
    lastStatus: existing ? existing.status : null,
    hasAccepted: works.some((w) => w.status === 'accepted'),
    submitBlocked,
    blockReason,
    justUploaded: false,
    error: null,
    formData: null,
  };
}

router.get(
  '/t/:teacherId/assignments/:assignmentId',
  checkStudent, loadStudentRow,
  handler(async (req, res) => {
    const teacherId = Number(req.params.teacherId);
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isSafeInteger(teacherId) || !Number.isSafeInteger(assignmentId)) {
      return res.status(404).render('common/error', {
        title: 'Не найдено', message: 'Задание не найдено.',
      });
    }
    const locals = await loadFormLocals(req.me, teacherId, assignmentId);
    if (!locals) {
      return res.status(404).render('common/error', {
        title: 'Не найдено', message: 'Задание не найдено.',
      });
    }
    if (locals.submitBlocked) {
      return res.redirect(`/t/${teacherId}/assignments/${assignmentId}/archive`);
    }
    return renderWith(res, 'student/content/assignment-submit', {
      ...locals,
      justUploaded: req.query.uploaded === '1',
    });
  })
);

router.get(
  '/t/:teacherId/assignments/:assignmentId/archive',
  checkStudent, loadStudentRow,
  handler(async (req, res) => {
    const teacherId = Number(req.params.teacherId);
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isSafeInteger(teacherId) || !Number.isSafeInteger(assignmentId)) {
      return res.status(404).render('common/error', {
        title: 'Не найдено', message: 'Задание не найдено.',
      });
    }
    const locals = await loadFormLocals(req.me, teacherId, assignmentId);
    if (!locals) {
      return res.status(404).render('common/error', {
        title: 'Не найдено', message: 'Задание не найдено.',
      });
    }
    if (!locals.submitBlocked) {
      return res.redirect(`/t/${teacherId}/assignments/${assignmentId}`);
    }
    return renderWith(res, 'student/content/assignment-archive', locals);
  })
);

async function renderSubmitUploadError(req, res, err) {
  const me = req.me;
  const teacherId = Number(req.params.teacherId);
  const assignmentId = Number(req.params.assignmentId);
  const message = friendlyFileError(err);
  if (!me || !Number.isSafeInteger(teacherId) || !Number.isSafeInteger(assignmentId)) {
    return res.status(400).render('common/error', {
      title: 'Ошибка загрузки', message,
      backUrl: req.get('referer') || '/my-assignments',
      backLabel: '← Вернуться к заданию',
    });
  }
  const locals = await loadFormLocals(me, teacherId, assignmentId);
  if (!locals) {
    return res.status(400).render('common/error', {
      title: 'Ошибка загрузки', message,
      backUrl: '/my-assignments', backLabel: '← К заданиям',
    });
  }
  locals.formData = {
    comment: String(req.body.comment || ''),
    external_url: String(req.body.external_url || ''),
  };
  return renderErr(res, 'student/content/assignment-submit', locals, message, 400);
}

router.post(
  '/t/:teacherId/assignments/:assignmentId/submit',
  checkStudent, loadStudentRow,
  submitRateLimit('submit'),
  uploadWithFallback(
    workMultiUpload.array('work', filesPolicy.MAX_FILES_PER_UPLOAD),
    (err, req, res, next) => {
      renderSubmitUploadError(req, res, err).catch(next);
    }
  ),
  handler(async (req, res) => {
    const files = req.files || [];
    const cleanup = () => {
      for (const f of files) if (f.path) fs.promises.unlink(f.path).catch(() => {});
    };
    const teacherId = Number(req.params.teacherId);
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isSafeInteger(teacherId) || !Number.isSafeInteger(assignmentId)) {
      cleanup();
      return res.status(404).render('common/error', {
        title: 'Не найдено', message: 'Задание не найдено.',
      });
    }
    const me = req.me;
    const assignment = db.prepare(`
      SELECT a.*, s.status AS subject_status, t.status AS teacher_status
      FROM assignments a
      JOIN subjects s ON s.id = a.subject_id
      JOIN teachers t ON t.id = s.teacher_id
      WHERE a.id = ? AND a.teacher_id = ? AND a.deleted_at IS NULL
        AND s.deleted_at IS NULL AND t.deleted_at IS NULL
    `).get(assignmentId, teacherId);
    if (!assignment) {
      cleanup();
      return res.status(404).render('common/error', {
        title: 'Не найдено', message: 'Задание не найдено.',
      });
    }
    // Студент должен быть в активной паре subject_groups.
    const activePair = !!db.prepare(
      'SELECT 1 FROM subject_groups WHERE subject_id = ? AND group_id = ?'
    ).get(assignment.subject_id, me.group_id);
    if (!activePair) {
      cleanup();
      return readonlyForbid(res, 'Задание');
    }
    // Тема-обёртка: available_from должен уже наступить.
    const topicGate = db.prepare(`
      SELECT available_from FROM topics
      WHERE assignment_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(assignmentId);
    if (topicGate && topicGate.available_from && topicGate.available_from > nowSql()) {
      cleanup();
      return readonlyForbid(res, 'Задание');
    }
    if (me.group_status !== 'active'
        || assignment.status !== 'active'
        || assignment.subject_status !== 'active'
        || assignment.teacher_status !== 'active') {
      cleanup();
      return readonlyForbid(res, 'Задание');
    }
    const externalUrl = String(req.body.external_url || '').trim().slice(0, 1000);
    const hasFiles = files.length > 0;
    const hasUrl = !!externalUrl;
    if (hasUrl && !/^https?:\/\//i.test(externalUrl)) {
      cleanup();
      return renderErr(res, 'student/content/assignment-submit',
        await loadFormLocals(me, teacherId, assignmentId),
        'Ссылка должна начинаться с http:// или https://.');
    }
    const comment = String(req.body.comment || '').trim().slice(0, 2000);
    const removeFileIds = toArray(req.body.remove_file_ids).map(Number).filter((n) => n > 0);
    const existing = db.prepare(`
      SELECT * FROM submissions
      WHERE assignment_id = ? AND student_id = ? AND deleted_at IS NULL
      ORDER BY uploaded_at DESC LIMIT 1
    `).get(assignmentId, me.id);
    if (existing) {
      if (existing.status === 'accepted') {
        cleanup();
        return renderErr(res, 'student/content/assignment-submit',
          await loadFormLocals(me, teacherId, assignmentId),
          'Работа по этому заданию уже принята. Сдача новой версии невозможна.', 409);
      }
      const oldFiles = attachments.listAttachments('submission', existing.id);
      const filesToRemove = oldFiles.filter((f) => removeFileIds.includes(f.id));
      const filesToKeep = oldFiles.filter((f) => !removeFileIds.includes(f.id));
      const filesAfterCount = filesToKeep.length + (hasFiles ? files.length : 0);
      if (filesAfterCount === 0 && !hasUrl) {
        cleanup();
        return renderErr(res, 'student/content/assignment-submit',
          await loadFormLocals(me, teacherId, assignmentId),
          'Нечего сохранять: должен остаться хотя бы один файл или ссылка.');
      }
      const removedStored = [];
      try {
        db.transaction(() => {
          for (const f of filesToRemove) {
            removedStored.push(f.stored_name);
            attachments.removeAttachment(f.id);
          }
          for (let i = 0; i < files.length; i++) {
            attachments.addAttachment('submission', existing.id, {
              stored_name: req.storedNames[i],
              filename: path.basename(fixFilename(files[i].originalname)).slice(0, 255),
              filesize: files[i].size,
            });
          }
          db.prepare(`
            UPDATE submissions
            SET topic = ?, external_url = ?, comment = ?,
                status = 'pending', uploaded_at = CURRENT_TIMESTAMP,
                pc_name = ?, ip_address = ?, user_agent = ?,
                ai_flag = 0, ai_flag_read_by_student = 0
            WHERE id = ?
          `).run(
            assignment.title,
            hasUrl ? externalUrl : null, comment || null,
            req.clientPcName || 'unknown', req.clientIp || 'unknown',
            req.clientUserAgent || 'unknown',
            existing.id
          );
          db.prepare('DELETE FROM submission_status_reads WHERE submission_id = ?')
            .run(existing.id);
          const parts = ['Загружена новая версия работы.'];
          if (hasFiles) parts.push(`Добавлено файлов: ${files.length}.`);
          if (filesToRemove.length > 0) parts.push(`Удалено файлов: ${filesToRemove.length}.`);
          if (hasUrl) parts.push(`Ссылка: ${externalUrl}.`);
          else if (existing.external_url && !hasUrl) parts.push('Ссылка удалена.');
          let msg = parts.join(' ');
          if (comment) msg += `\n\n${comment}`;
          db.prepare(`
            INSERT INTO messages (submission_id, sender_type, sender_id, sender_name, message)
            VALUES (?, 'student', ?, ?, ?)
          `).run(existing.id, req.session.studentId, req.session.studentName || 'Студент', msg);
        })();
        for (const name of removedStored) {
          try { await fs.promises.unlink(safeJoin(config.UPLOAD_DIR, name)); } catch (e) {
            if (e.code !== 'ENOENT') console.error('unlink:', e);
          }
        }
        invalidateCounters(req.sessionID);
        return res.redirect(`/t/${teacherId}/works/${existing.id}?replaced=1`);
      } catch (e) {
        cleanup();
        throw e;
      }
    }
    if (!hasFiles && !hasUrl) {
      cleanup();
      return renderErr(res, 'student/content/assignment-submit',
        await loadFormLocals(me, teacherId, assignmentId),
        'Приложите файл или укажите ссылку.');
    }
    let submissionId;
    try {
      submissionId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO submissions (
            student_id, teacher_id, group_id, assignment_id, topic,
            comment, external_url, pc_name, ip_address, user_agent
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          me.id, teacherId, me.group_id, assignmentId, assignment.title,
          comment, hasUrl ? externalUrl : null,
          req.clientPcName, req.clientIp, req.clientUserAgent
        );
        const sid = Number(r.lastInsertRowid);
        for (let i = 0; i < files.length; i++) {
          attachments.addAttachment('submission', sid, {
            stored_name: req.storedNames[i],
            filename: path.basename(fixFilename(files[i].originalname)).slice(0, 255),
            filesize: files[i].size,
          });
        }
        return sid;
      })();
    } catch (txErr) {
      cleanup();
      throw txErr;
    }
    invalidateCounters(req.sessionID);
    return res.redirect(`/t/${teacherId}/assignments/${assignmentId}?uploaded=1`);
  })
);

module.exports = router;