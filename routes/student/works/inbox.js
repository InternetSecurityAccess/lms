// routes/student/works/inbox.js
'use strict';

const db = require('../../../database');

const { checkStudent } = require('../../shared/authz');
const { handler, renderWith } = require('../../shared/handlers');
const { loadStudentRow } = require('../../shared/loaders');
const { normalizeSort } = require('../../shared/lists');

const { toArray, markStatusRead, rejectReadonlySubmission, STUDENT_UNREAD_SQL, getStudentQuizNotifications } = require('./helpers');

const express = require('express');
const router = express.Router();

router.get(
  '/my-inbox',
  checkStudent, loadStudentRow,
  handler((req, res) => {
    const me = req.me;
    const q = String(req.query.q || '').trim().slice(0, 100);
    const filter = ['unread', 'rejected', 'accepted', 'quizzes'].includes(req.query.filter)
      ? req.query.filter : 'unread';
    const sort = normalizeSort(req.query.sort,
      ['date_desc', 'date_asc', 'name_asc', 'name_desc']);
    // Уведомления по результатам тестов.
    let quizRows = [];
    try { quizRows = getStudentQuizNotifications(me.id); } catch (e) { console.error('[inbox quizzes]', e.message); }
    for (const r of quizRows) {
      r.kind = 'quiz';
      r.open_url = `/my-subjects/${r.subject_id}/topics/${r.topic_id}/quiz/attempt/${r.attempt_id}/result`;
    }
    if (filter === 'quizzes') {
      let qr = quizRows;
      if (q) {
        const qlc = q.toLowerCase();
        qr = qr.filter((r) =>
          String(r.quiz_title || '').toLowerCase().includes(qlc) ||
          String(r.subject_title || '').toLowerCase().includes(qlc) ||
          String(r.teacher_name || '').toLowerCase().includes(qlc));
      }
      const orderByQ = sort === 'date_asc' ? (a, b) => String(a.finished_at).localeCompare(String(b.finished_at))
        : sort === 'name_asc' ? (a, b) => String(a.quiz_title).localeCompare(String(b.quiz_title))
        : sort === 'name_desc' ? (a, b) => String(b.quiz_title).localeCompare(String(a.quiz_title))
        : (a, b) => String(b.finished_at).localeCompare(String(a.finished_at));
      qr.sort(orderByQ);
      return renderWith(res, 'student/works/inbox', {
        title: 'Уведомления',
        me, rows: [], counts: null,
        q, filter, sort, quizRows: qr,
      });
    }
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
    // Добавляем уведомления по тестам в общий список (фильтры unread/rejected/accepted).
    const quizNotifRows = filter === 'unread' ? quizRows.filter((r) => r.unread) : [];
    if (filter === 'unread') {
      counts.unread += quizNotifRows.length;
    }
    let mergedRows;
    if (filter === 'unread') {
      mergedRows = [...rows, ...quizNotifRows].sort((a, b) => {
        const ta = sort === 'name_asc' ? String(a.counterpart_name || a.teacher_name).localeCompare(String(b.counterpart_name || b.teacher_name))
          : sort === 'name_desc' ? String(b.counterpart_name || b.teacher_name).localeCompare(String(a.counterpart_name || a.teacher_name))
          : sort === 'date_asc' ? String(a.uploaded_at || a.last_message_at || a.finished_at).localeCompare(String(b.uploaded_at || b.last_message_at || b.finished_at))
          : String(b.uploaded_at || b.last_message_at || b.finished_at).localeCompare(String(a.uploaded_at || a.last_message_at || a.finished_at));
        return ta;
      });
    } else {
      mergedRows = rows;
    }
    return renderWith(res, 'student/works/inbox', {
      title: 'Уведомления',
      me, rows: mergedRows, counts, q, filter, sort,
    });
  })
);

module.exports = router;
