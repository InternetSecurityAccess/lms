// routes/teacher/works.js
'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkTeacher } = require('../shared/authz');
const { handler, renderWith, audit } = require('../shared/handlers');
const { loadSubmissionAsTeacher } = require('../shared/loaders');
const { normalizeSort } = require('../shared/lists');
const { makeSubmissionChatRouter } = require('../shared/chat-routes');
const { invalidateCounters, getCountersCached } = require('../../utils/counters');
const chat = require('../shared/chat');
const TEACHER_ALLOWED_STATUSES = new Set(['accepted', 'rejected']);
const AI_REJECTION_TEXT = [
  'Здравствуйте!',
  '',
  'Работа отклонена: по результатам проверки видно, что она выполнена с помощью искусственного интеллекта.',
  'Пожалуйста, выполните задание самостоятельно и отправьте новую версию.',
  'Если считаете, что это ошибка — напишите в этот чат.',
].join('\n');
function markStatusRead(submissionId, teacherId, status) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO submission_status_reads
        (submission_id, reader_type, reader_id, read_status)
      VALUES (?, 'teacher', ?, ?)
    `).run(submissionId, teacherId, status);
  } catch (e) {
    console.error('[markStatusRead:teacher]', e.message);
  }
}
const TEACHER_UNREAD_SQL = `
  (
    EXISTS (SELECT 1 FROM messages m
      WHERE m.submission_id = s.id AND m.sender_type = 'student'
        AND m.is_read = 0 AND m.deleted_at IS NULL)
    OR (
      s.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM submission_status_reads r
        WHERE r.submission_id = s.id
          AND r.reader_type = 'teacher' AND r.reader_id = @tid
          AND r.read_status = 'pending'
      )
    )
  )
`;
router.get(
  '/inbox',
  checkTeacher,
  handler((req, res) => {
    const tid = req.session.teacherId;
    const q = String(req.query.q || '').trim().slice(0, 100);
    const sort = normalizeSort(req.query.sort,
      ['date_desc', 'date_asc', 'name_asc', 'name_desc']);
    let where = ' WHERE s.teacher_id = @tid AND s.deleted_at IS NULL';
    where += " AND sj.status = 'active' AND sj.deleted_at IS NULL";
    where += ' AND g.deleted_at IS NULL';
    where += ` AND ${TEACHER_UNREAD_SQL}`;
    const params = { tid };
    if (q) {
      where += ' AND (s.topic LIKE @q OR st.name LIKE @q OR g.name LIKE @q OR a.title LIKE @q)';
      params.q = `%${q}%`;
    }
    const orderBy = sort === 'date_asc' ? 's.uploaded_at ASC'
      : sort === 'name_asc' ? 'st.name ASC'
      : sort === 'name_desc' ? 'st.name DESC'
      : 's.uploaded_at DESC';
    const rows = db.prepare(`
      SELECT s.id, s.topic, s.status, s.uploaded_at,
        s.teacher_id, s.group_id,
        s.ai_flag,
        st.name AS counterpart_name,
        g.name AS group_name,
        a.title AS assignment_title,
        (SELECT COUNT(*) FROM messages m
          WHERE m.submission_id = s.id AND m.sender_type = 'student'
            AND m.is_read = 0 AND m.deleted_at IS NULL)
          AS unread_count,
        (
          s.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM submission_status_reads r
            WHERE r.submission_id = s.id
              AND r.reader_type = 'teacher' AND r.reader_id = @tid
              AND r.read_status = 'pending'
          )
        ) AS unread_status,
        (SELECT m.message FROM messages m
          WHERE m.submission_id = s.id AND m.sender_type = 'student'
            AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC LIMIT 1) AS last_message,
        (SELECT m.created_at FROM messages m
          WHERE m.submission_id = s.id AND m.sender_type = 'student'
            AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
      FROM submissions s
      JOIN students st ON st.id = s.student_id
      JOIN groups g ON g.id = s.group_id
      JOIN assignments a ON a.id = s.assignment_id
      JOIN subjects sj ON sj.id = a.subject_id
      ${where}
      ORDER BY ${orderBy}
    `).all(params);
    for (const r of rows) {
      r.unread_status = !!r.unread_status;
      r.ai_flag = !!r.ai_flag;
      r.open_url = `/g/${r.group_id}/works/${r.id}`;
    }
    return renderWith(res, 'teacher/works/inbox', {
      title: 'Уведомления',
      rows, q, sort, unreadCount: rows.length,
    });
  })
);
router.get(
  '/g/:groupId/works/:id',
  checkTeacher, loadSubmissionAsTeacher,
  handler((req, res) => {
    chat.markRead('submission', req.submission.id, 'teacher');
    markStatusRead(req.submission.id, req.session.teacherId, req.submission.status);
    invalidateCounters(req.sessionID);
    try {
      const c = getCountersCached(req.session, req.sessionID);
      res.locals.inboxCount = c.inboxCount;
    } catch { /* ignore */ }
    const q = String(req.query.q || '').trim().slice(0, 200);
    const messages = chat.listMessages('submission', req.submission.id, { q });
    return renderWith(res, 'teacher/works/submission', {
      title: req.submission.topic,
      submission: req.submission,
      messages, q,
    });
  })
);
router.post(
  '/g/:groupId/works/:id/status',
  checkTeacher, loadSubmissionAsTeacher,
  handler((req, res) => {
    const newStatus = String(req.body.status || '');
    const base = `/g/${req.submission.group_id}/works/${req.submission.id}`;
    if (!TEACHER_ALLOWED_STATUSES.has(newStatus)) return res.redirect(base);
    const prevStatus = req.submission.status;
    if (prevStatus === newStatus) return res.redirect(base);
    db.transaction(() => {
      if (newStatus === 'accepted') {
        db.prepare(`
          UPDATE submissions
          SET status = 'accepted', ai_flag = 0, ai_flag_read_by_student = 0
          WHERE id = ?
        `).run(req.submission.id);
      } else {
        db.prepare('UPDATE submissions SET status = ? WHERE id = ?')
          .run(newStatus, req.submission.id);
      }
      db.prepare('DELETE FROM submission_status_reads WHERE submission_id = ?')
        .run(req.submission.id);
    })();
    audit(req, 'submission.status', 'submission', req.submission.id, {
      from: prevStatus, to: newStatus,
      student_id: req.submission.student_id, group_id: req.submission.group_id,
    });
    invalidateCounters(req.sessionID);
    return res.redirect(base);
  })
);
router.post(
  '/g/:groupId/works/:id/reject-ai',
  checkTeacher, loadSubmissionAsTeacher,
  handler((req, res) => {
    const base = `/g/${req.submission.group_id}/works/${req.submission.id}`;
    const prevStatus = req.submission.status;
    db.transaction(() => {
      db.prepare(`
        UPDATE submissions
        SET status = 'rejected', ai_flag = 1, ai_flag_read_by_student = 0
        WHERE id = ?
      `).run(req.submission.id);
      db.prepare('DELETE FROM submission_status_reads WHERE submission_id = ?')
        .run(req.submission.id);
      db.prepare(`
        INSERT INTO messages (submission_id, sender_type, sender_id, sender_name, message)
        VALUES (?, 'teacher', ?, ?, ?)
      `).run(
        req.submission.id,
        req.session.teacherId,
        req.session.teacherName || 'Преподаватель',
        AI_REJECTION_TEXT
      );
    })();
    audit(req, 'submission.reject_ai', 'submission', req.submission.id, {
      from: prevStatus, to: 'rejected',
      student_id: req.submission.student_id, group_id: req.submission.group_id,
    });
    invalidateCounters(req.sessionID);
    return res.redirect(base);
  })
);
router.use(
  '/g/:groupId/works/:id',
  makeSubmissionChatRouter({
    basePath: (req) => `/g/${req.submission.group_id}/works/${req.submission.id}`,
    loadContext: [checkTeacher, loadSubmissionAsTeacher],
    canView: () => true,
    canWrite: (req) => req.submission.status !== 'accepted',
    getSender: (req) => ({
      type: 'teacher',
      id: req.session.teacherId,
      name: req.session.teacherName || 'Преподаватель',
    }),
    getViewLocals: (req) => ({
      view: 'teacher/works/submission',
      locals: (messages, q) => ({
        title: req.submission.topic,
        submission: req.submission,
        messages, q,
      }),
    }),
  })
);
module.exports = router;