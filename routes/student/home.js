'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkStudent } = require('../shared/authz');
const { handler, renderWith } = require('../shared/handlers');
const { loadStudentRow } = require('../shared/loaders');

router.get(
  '/my-teachers',
  checkStudent, loadStudentRow,
  handler((req, res) => {
    const me = req.me;
    const q = String(req.query.q || '').trim().slice(0, 100);
    let where = ` WHERE t.status = 'active' AND t.deleted_at IS NULL
                  AND tg.group_id = @groupId `;
    const params = { groupId: me.group_id, studentId: me.id };
    if (q) {
      where += ' AND t.name LIKE @q';
      params.q = `%${q}%`;
    }
    const teachers = db.prepare(`
      SELECT t.id, t.name, t.max_url,
        (SELECT COUNT(*) FROM subjects s
          JOIN subject_groups sg ON sg.subject_id = s.id
          WHERE s.teacher_id = t.id AND sg.group_id = @groupId
            AND s.status = 'active' AND s.deleted_at IS NULL) AS subjects_count,
        (SELECT COUNT(*) FROM submissions sub
          JOIN assignments a ON a.id = sub.assignment_id
          JOIN subjects sj ON sj.id = a.subject_id
          WHERE sub.teacher_id = t.id AND sub.student_id = @studentId
            AND sub.deleted_at IS NULL
            AND sj.status = 'active' AND sj.deleted_at IS NULL) AS my_works_count,
        (SELECT COUNT(*) FROM submissions sub
          JOIN assignments a ON a.id = sub.assignment_id
          JOIN subjects sj ON sj.id = a.subject_id
          WHERE sub.teacher_id = t.id AND sub.student_id = @studentId
            AND sub.status = 'pending' AND sub.deleted_at IS NULL
            AND sj.status = 'active' AND sj.deleted_at IS NULL) AS my_pending_count,
        (SELECT COUNT(*) FROM messages m
          JOIN submissions s2 ON s2.id = m.submission_id
          JOIN assignments a2 ON a2.id = s2.assignment_id
          JOIN subjects sj2 ON sj2.id = a2.subject_id
          WHERE s2.teacher_id = t.id AND s2.student_id = @studentId
            AND s2.deleted_at IS NULL
            AND sj2.status = 'active' AND sj2.deleted_at IS NULL
            AND m.sender_type = 'teacher' AND m.is_read = 0 AND m.deleted_at IS NULL)
          AS unread_count
      FROM teachers t
      JOIN teacher_groups tg ON tg.teacher_id = t.id AND tg.group_id = @groupId
      ${where}
      ORDER BY unread_count DESC, my_pending_count DESC, t.name
    `).all(params);
    return renderWith(res, 'student/people/my-teachers', {
      title: 'Мои преподаватели',
      me, teachers, q,
    });
  })
);

module.exports = router;