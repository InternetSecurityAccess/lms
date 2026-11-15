'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkTeacher } = require('../shared/authz');
const { handler, renderWith } = require('../shared/handlers');

// Каталог групп: доступен всем преподам, но «мои» видны отдельно.
// Фильтр deleted_at — группы в корзине не показываем. status=finished
// тоже показываем: препод может «Возобновить».
router.get(
  '/groups',
  checkTeacher,
  handler((req, res) => {
    const tid = req.session.teacherId;
    const q = String(req.query.q || '').trim().slice(0, 100);
    const groups = db.prepare(`
      SELECT g.*,
        (SELECT COUNT(*) FROM students
          WHERE group_id = g.id AND deleted_at IS NULL) AS students_count,
        (SELECT COUNT(*) FROM teacher_groups tg
          WHERE tg.group_id = g.id AND tg.teacher_id = @tid) AS is_subscribed,
        (SELECT COUNT(*) FROM submissions s
          JOIN assignments a ON a.id = s.assignment_id
          JOIN subjects sj ON sj.id = a.subject_id
          WHERE s.group_id = g.id AND s.teacher_id = @tid AND s.deleted_at IS NULL
            AND sj.status = 'active' AND sj.deleted_at IS NULL) AS my_works_count,
        (SELECT COUNT(*) FROM submissions s
          JOIN assignments a ON a.id = s.assignment_id
          JOIN subjects sj ON sj.id = a.subject_id
          WHERE s.group_id = g.id AND s.teacher_id = @tid
            AND s.status = 'pending' AND s.deleted_at IS NULL
            AND sj.status = 'active' AND sj.deleted_at IS NULL) AS my_pending_count
      FROM groups g
      WHERE g.deleted_at IS NULL
      ${q ? 'AND g.name LIKE @q' : ''}
      ORDER BY g.name
    `).all({ tid, q: `%${q}%` });
    const myCount = groups.filter((g) => g.is_subscribed).length;

    // Пакетное сохранение: ?saved=N&added=X&removed=Y (см. catalog-groups-batch.js)
    const savedTotal = Number(req.query.saved) || 0;
    const savedAdded = Number(req.query.added) || 0;
    const savedRemoved = Number(req.query.removed) || 0;
    const savedInfo = savedTotal > 0
      ? { total: savedTotal, added: savedAdded, removed: savedRemoved }
      : null;

    return renderWith(res, 'teacher/people/catalog', {
      title: 'Группы', groups, myCount, q, savedInfo,
    });
  })
);

router.get(
  '/my-groups',
  checkTeacher,
  handler((req, res) => {
    const tid = req.session.teacherId;
    const q = String(req.query.q || '').trim().slice(0, 100);
    const groups = db.prepare(`
      SELECT g.*,
        (SELECT COUNT(*) FROM students
          WHERE group_id = g.id AND deleted_at IS NULL) AS students_count,
        (SELECT COUNT(*) FROM submissions s
          JOIN assignments a ON a.id = s.assignment_id
          JOIN subjects sj ON sj.id = a.subject_id
          WHERE s.group_id = g.id AND s.teacher_id = @tid AND s.deleted_at IS NULL
            AND sj.status = 'active' AND sj.deleted_at IS NULL) AS my_works_count,
        (SELECT COUNT(*) FROM submissions s
          JOIN assignments a ON a.id = s.assignment_id
          JOIN subjects sj ON sj.id = a.subject_id
          WHERE s.group_id = g.id AND s.teacher_id = @tid
            AND s.status = 'pending' AND s.deleted_at IS NULL
            AND sj.status = 'active' AND sj.deleted_at IS NULL) AS my_pending_count,
        (SELECT COUNT(*) FROM messages m
          JOIN submissions s2 ON s2.id = m.submission_id
          JOIN assignments a2 ON a2.id = s2.assignment_id
          JOIN subjects sj2 ON sj2.id = a2.subject_id
          WHERE s2.group_id = g.id AND s2.teacher_id = @tid
            AND s2.deleted_at IS NULL
            AND sj2.status = 'active' AND sj2.deleted_at IS NULL
            AND m.sender_type = 'student' AND m.is_read = 0
            AND m.deleted_at IS NULL) AS unread_count
      FROM groups g
      JOIN teacher_groups tg ON tg.group_id = g.id AND tg.teacher_id = @tid
      WHERE g.deleted_at IS NULL
      ${q ? 'AND g.name LIKE @q' : ''}
      ORDER BY unread_count DESC, my_pending_count DESC, g.name
    `).all({ tid, q: `%${q}%` });
    return renderWith(res, 'teacher/people/my-groups', {
      title: 'Мои группы', groups, q,
    });
  })
);

module.exports = router;