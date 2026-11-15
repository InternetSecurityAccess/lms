'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkStudent } = require('../shared/authz');
const { handler, renderWith, notFound, forbid } = require('../shared/handlers');
const { loadStudentRow } = require('../shared/loaders');
const { makeStudentGroupChatRouter } = require('../shared/chat-routes');

router.get(
  '/my-chats',
  checkStudent, loadStudentRow,
  handler((req, res) => {
    const me = req.me;
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!me.group_id) {
      return renderWith(res, 'student/messages/my-chats', {
        title: 'Групповые чаты',
        me, hasGroup: false, group: null, threads: [], q,
      });
    }
    const group = db.prepare(
      'SELECT id, name FROM groups WHERE id = ? AND deleted_at IS NULL'
    ).get(me.group_id);
    if (!group) {
      return renderWith(res, 'student/messages/my-chats', {
        title: 'Групповые чаты',
        me, hasGroup: false, group: null, threads: [], q,
      });
    }
    let where = " WHERE tg.group_id = @gid AND t.status = 'active' AND t.deleted_at IS NULL";
    const params = { gid: group.id, sid: me.id };
    if (q) { where += ' AND t.name LIKE @q'; params.q = `%${q}%`; }
    const teachers = db.prepare(`
      SELECT t.id AS teacher_id, t.name AS teacher_name,
        gt.id AS thread_id, gt.last_message_at,
        (SELECT gm.message FROM group_messages gm
          WHERE gm.thread_id = gt.id AND gm.deleted_at IS NULL
          ORDER BY gm.created_at DESC, gm.id DESC LIMIT 1) AS last_message,
        (SELECT gm.sender_type FROM group_messages gm
          WHERE gm.thread_id = gt.id AND gm.deleted_at IS NULL
          ORDER BY gm.created_at DESC, gm.id DESC LIMIT 1) AS last_sender_type,
        (SELECT gm.sender_name FROM group_messages gm
          WHERE gm.thread_id = gt.id AND gm.deleted_at IS NULL
          ORDER BY gm.created_at DESC, gm.id DESC LIMIT 1) AS last_sender_name,
        (SELECT COUNT(*) FROM group_messages gm
          LEFT JOIN group_thread_reads gtr
            ON gtr.thread_id = gm.thread_id
            AND gtr.reader_type = 'student'
            AND gtr.reader_id = @sid
          WHERE gm.thread_id = gt.id AND gm.deleted_at IS NULL
            AND (gm.sender_type <> 'student' OR gm.sender_id <> @sid)
            AND (gtr.last_read_at IS NULL OR gm.created_at > gtr.last_read_at)
        ) AS unread_count
      FROM teacher_groups tg
      JOIN teachers t ON t.id = tg.teacher_id
      LEFT JOIN group_threads gt
        ON gt.group_id = tg.group_id AND gt.teacher_id = tg.teacher_id
      ${where}
      ORDER BY (gt.last_message_at IS NOT NULL) DESC, gt.last_message_at DESC, t.name
    `).all(params);
    return renderWith(res, 'student/messages/my-chats', {
      title: 'Групповые чаты',
      me, hasGroup: true, group, threads: teachers, q,
    });
  })
);

function loadMyThread(req, res, next) {
  const me = req.me;
  const gid = Number(req.params.groupId);
  const tid = Number(req.params.teacherId);
  if (!Number.isSafeInteger(gid) || gid < 1 || !Number.isSafeInteger(tid) || tid < 1) {
    return notFound(res, 'Чат не найден.');
  }
  if (!me.group_id || Number(me.group_id) !== gid) return forbid(res);
  const group = db.prepare(
    'SELECT id, name FROM groups WHERE id = ? AND deleted_at IS NULL'
  ).get(gid);
  if (!group) return notFound(res, 'Группа не найдена.');
  const teacher = db.prepare(`
    SELECT t.id, t.name FROM teachers t
    JOIN teacher_groups tg ON tg.teacher_id = t.id
    WHERE t.id = ? AND tg.group_id = ?
      AND t.status = 'active' AND t.deleted_at IS NULL
  `).get(tid, gid);
  if (!teacher) return notFound(res, 'Преподаватель не ведёт эту группу.');
  req.group = group;
  req.teacher = teacher;
  next();
}

router.use(
  '/my-chats/:groupId/t/:teacherId',
  makeStudentGroupChatRouter({
    basePath: (req) => `/my-chats/${req.group.id}/t/${req.teacher.id}`,
    loadContext: [checkStudent, loadStudentRow, loadMyThread],
    getViewLocals: (req, thread) => ({
      view: 'student/messages/group-chat',
      locals: (messages, q) => ({
        title: 'Чат с ' + req.teacher.name,
        me: req.me,
        group: req.group,
        teacher: req.teacher,
        messages, q,
        deletedMsgId: req.query.deleted ? Number(req.query.deleted) : null,
        basePath: `/my-chats/${req.group.id}/t/${req.teacher.id}`,
      }),
    }),
  })
);

router.get(
  '/my-announcements',
  checkStudent, loadStudentRow,
  handler((req, res) => {
    const me = req.me;
    const rows = db.prepare(`
      SELECT a.*, t.name AS teacher_name,
        CASE WHEN r.announcement_id IS NULL THEN 0 ELSE 1 END AS is_read
      FROM group_announcements a
      JOIN teachers t ON t.id = a.teacher_id
      LEFT JOIN group_announcement_reads r
        ON r.announcement_id = a.id AND r.student_id = ?
      WHERE a.group_id = ? AND a.deleted_at IS NULL
      ORDER BY a.pinned DESC, a.created_at DESC
    `).all(me.id, me.group_id);
    const ins = db.prepare(`
      INSERT OR IGNORE INTO group_announcement_reads (announcement_id, student_id)
      VALUES (?, ?)
    `);
    db.transaction(() => {
      for (const a of rows) if (!a.is_read) ins.run(a.id, me.id);
    })();
    return renderWith(res, 'student/messages/announcements', {
      title: 'Объявления',
      me, announcements: rows,
    });
  })
);

module.exports = router;