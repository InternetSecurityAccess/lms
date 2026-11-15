'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkTeacher } = require('../shared/authz');
const {
  handler, renderWith, parseIdOr404, audit, redirectWith,
} = require('../shared/handlers');
const { pickStr, pickBool } = require('../shared/form');
const { loadGroupAsTeacher } = require('../shared/loaders');
const { makeGroupChatRouter } = require('../shared/chat-routes');

function forbidGroup(res) {
  return res.status(403).render('common/error', {
    title: 'Доступ запрещён',
    message: 'Вы не ведёте эту группу. Чтобы получить доступ, отметьте '
      + 'её как «Моя группа» в разделе «Группы».',
    backUrl: '/groups',
    backLabel: '← К группам',
  });
}

router.get(
  '/my-group-chats',
  checkTeacher,
  handler((req, res) => {
    const tid = req.session.teacherId;
    const q = pickStr(req.query.q, 100);
    let where = ' WHERE tg.teacher_id = @tid AND g.deleted_at IS NULL';
    const params = { tid };
    if (q) { where += ' AND g.name LIKE @q'; params.q = `%${q}%`; }
    const rows = db.prepare(`
      SELECT g.id AS group_id, g.name AS group_name, g.status AS group_status,
        gt.id AS thread_id, gt.last_message_at,
        (SELECT COUNT(*) FROM students s
          WHERE s.group_id = g.id AND s.deleted_at IS NULL) AS students_count,
        (SELECT COUNT(*) FROM group_messages gm
          WHERE gm.thread_id = gt.id AND gm.deleted_at IS NULL) AS messages_count,
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
            AND gtr.reader_type = 'teacher'
            AND gtr.reader_id = @tid
          WHERE gm.thread_id = gt.id AND gm.deleted_at IS NULL
            AND (gm.sender_type <> 'teacher' OR gm.sender_id <> @tid)
            AND (gtr.last_read_at IS NULL OR gm.created_at > gtr.last_read_at)
        ) AS unread_count
      FROM teacher_groups tg
      JOIN groups g ON g.id = tg.group_id
      LEFT JOIN group_threads gt
        ON gt.group_id = tg.group_id AND gt.teacher_id = tg.teacher_id
      ${where}
      ORDER BY (gt.last_message_at IS NOT NULL) DESC, gt.last_message_at DESC, g.name
    `).all(params);
    const totalUnread = rows.reduce((sum, r) => sum + (r.unread_count || 0), 0);
    return renderWith(res, 'teacher/messages/chats', {
      title: 'Групповые чаты', chats: rows, q, totalUnread,
    });
  })
);

router.use(
  '/g/:groupId/chat',
  makeGroupChatRouter({
    basePath: (req) => `/g/${req.group.id}/chat`,
    loadContext: [checkTeacher, loadGroupAsTeacher],
    canView: (req) => req.isSubscribed,
    canClear: true,
    getViewLocals: (req, thread) => ({
      view: 'teacher/messages/group-chat',
      locals: (messages, q) => ({
        title: 'Групповой чат: ' + req.group.name,
        group: req.group,
        messages, q,
        deletedMsgId: req.query.deleted ? Number(req.query.deleted) : null,
        cleared: req.query.cleared === '1',
        basePath: `/g/${req.group.id}/chat`,
      }),
    }),
  })
);

router.get(
  '/my-group-announcements',
  checkTeacher,
  handler((req, res) => {
    const tid = req.session.teacherId;
    const groups = db.prepare(`
      SELECT g.id, g.name,
        (SELECT COUNT(*) FROM group_announcements a
          WHERE a.group_id = g.id AND a.teacher_id = @tid
            AND a.deleted_at IS NULL) AS announcements_count,
        (SELECT COUNT(*) FROM students s
          WHERE s.group_id = g.id AND s.deleted_at IS NULL) AS students_count
      FROM groups g
      JOIN teacher_groups tg ON tg.group_id = g.id AND tg.teacher_id = @tid
      WHERE g.deleted_at IS NULL
      ORDER BY g.name
    `).all({ tid });
    return renderWith(res, 'teacher/messages/my-announcements', {
      title: 'Объявления', groups,
    });
  })
);

router.get(
  '/g/:groupId/announcements',
  checkTeacher, loadGroupAsTeacher,
  handler((req, res) => {
    if (!req.isSubscribed) return forbidGroup(res);
    const tid = req.session.teacherId;
    const rows = db.prepare(`
      SELECT a.*, t.name AS teacher_name,
        (SELECT COUNT(*) FROM group_announcement_reads r
          WHERE r.announcement_id = a.id) AS read_count,
        (SELECT COUNT(*) FROM students s
          WHERE s.group_id = a.group_id AND s.deleted_at IS NULL) AS total_students
      FROM group_announcements a
      JOIN teachers t ON t.id = a.teacher_id
      WHERE a.group_id = ? AND a.teacher_id = ? AND a.deleted_at IS NULL
      ORDER BY a.pinned DESC, a.created_at DESC
    `).all(req.group.id, tid);
    return renderWith(res, 'teacher/messages/announcements', {
      title: 'Объявления: ' + req.group.name,
      group: req.group,
      isSubscribed: req.isSubscribed,
      announcements: rows,
      deleted: req.query.deleted === '1',
      created: req.query.created === '1',
      updated: req.query.updated === '1',
    });
  })
);

router.get(
  '/g/:groupId/announcements/new',
  checkTeacher, loadGroupAsTeacher,
  handler((req, res) => {
    if (!req.isSubscribed) return forbidGroup(res);
    return renderWith(res, 'teacher/messages/announcement-form', {
      title: 'Новое объявление',
      group: req.group, mode: 'create',
      announcement: { title: '', content: '', pinned: 0 },
      error: null,
    });
  })
);

router.post(
  '/g/:groupId/announcements',
  checkTeacher, loadGroupAsTeacher,
  handler((req, res) => {
    if (!req.isSubscribed) return forbidGroup(res);
    const title = pickStr(req.body.title, 200);
    const content = pickStr(req.body.content, 5000);
    const pinned = pickBool(req.body.pinned) ? 1 : 0;
    if (!title) {
      return res.status(400).render('teacher/messages/announcement-form', {
        title: 'Новое объявление',
        group: req.group, mode: 'create',
        announcement: { title, content, pinned },
        error: 'Укажите заголовок.',
      });
    }
    const r = db.prepare(`
      INSERT INTO group_announcements
        (group_id, teacher_id, title, content, pinned, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(req.group.id, req.session.teacherId, title, content || null, pinned);
    audit(req, 'announcement.create', 'group_announcement', Number(r.lastInsertRowid), {
      group_id: req.group.id,
    });
    return redirectWith(res, `/g/${req.group.id}/announcements`, { created: 1 });
  })
);

router.get(
  '/g/:groupId/announcements/:id/edit',
  checkTeacher, loadGroupAsTeacher,
  handler((req, res) => {
    if (!req.isSubscribed) return forbidGroup(res);
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const a = db.prepare(
      'SELECT * FROM group_announcements WHERE id = ? AND group_id = ? AND deleted_at IS NULL'
    ).get(id, req.group.id);
    if (!a) return res.redirect(`/g/${req.group.id}/announcements`);
    if (Number(a.teacher_id) !== Number(req.session.teacherId)) {
      return res.status(403).render('common/error', {
        title: 'Доступ запрещён',
        message: 'Редактировать объявление может только его автор или администратор.',
      });
    }
    return renderWith(res, 'teacher/messages/announcement-form', {
      title: 'Редактировать объявление',
      group: req.group, mode: 'edit', announcement: a, error: null,
    });
  })
);

router.post(
  '/g/:groupId/announcements/:id',
  checkTeacher, loadGroupAsTeacher,
  handler((req, res) => {
    if (!req.isSubscribed) return forbidGroup(res);
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const a = db.prepare(
      'SELECT * FROM group_announcements WHERE id = ? AND group_id = ? AND deleted_at IS NULL'
    ).get(id, req.group.id);
    if (!a) return res.redirect(`/g/${req.group.id}/announcements`);
    if (Number(a.teacher_id) !== Number(req.session.teacherId)) {
      return res.status(403).render('common/error', {
        title: 'Доступ запрещён',
        message: 'Редактировать объявление может только его автор или администратор.',
      });
    }
    const title = pickStr(req.body.title, 200);
    const content = pickStr(req.body.content, 5000);
    const pinned = pickBool(req.body.pinned) ? 1 : 0;
    if (!title) {
      return res.status(400).render('teacher/messages/announcement-form', {
        title: 'Редактировать объявление',
        group: req.group, mode: 'edit',
        announcement: { ...a, title, content, pinned },
        error: 'Укажите заголовок.',
      });
    }
    db.prepare(
      'UPDATE group_announcements SET title = ?, content = ?, pinned = ? WHERE id = ?'
    ).run(title, content || null, pinned, id);
    audit(req, 'announcement.update', 'group_announcement', id, { group_id: req.group.id });
    return redirectWith(res, `/g/${req.group.id}/announcements`, { updated: 1 });
  })
);

// Учитель не удаляет физически — soft-delete через lifecycle.
router.post(
  '/g/:groupId/announcements/:id/delete',
  checkTeacher, loadGroupAsTeacher,
  handler((req, res) => {
    if (!req.isSubscribed) return forbidGroup(res);
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const a = db.prepare(
      'SELECT * FROM group_announcements WHERE id = ? AND group_id = ? AND deleted_at IS NULL'
    ).get(id, req.group.id);
    if (!a) return res.redirect(`/g/${req.group.id}/announcements`);
    if (Number(a.teacher_id) !== Number(req.session.teacherId)) {
      return res.status(403).render('common/error', {
        title: 'Доступ запрещён',
        message: 'Удалять объявление может только его автор или администратор.',
      });
    }
    db.prepare(
      'UPDATE group_announcements SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(id);
    audit(req, 'announcement.delete', 'group_announcement', id, {
      group_id: req.group.id, mode: 'soft',
    });
    return redirectWith(res, `/g/${req.group.id}/announcements`, { deleted: 1 });
  })
);

router.post(
  '/g/:groupId/announcements/:id/pin',
  checkTeacher, loadGroupAsTeacher,
  handler((req, res) => {
    if (!req.isSubscribed) return forbidGroup(res);
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const a = db.prepare(
      'SELECT * FROM group_announcements WHERE id = ? AND group_id = ? AND deleted_at IS NULL'
    ).get(id, req.group.id);
    if (!a) return res.redirect(`/g/${req.group.id}/announcements`);
    if (Number(a.teacher_id) !== Number(req.session.teacherId)) {
      return res.status(403).render('common/error', {
        title: 'Доступ запрещён',
        message: 'Закреплять можно только свои объявления.',
      });
    }
    const newPinned = a.pinned ? 0 : 1;
    db.prepare('UPDATE group_announcements SET pinned = ? WHERE id = ?')
      .run(newPinned, id);
    audit(req, newPinned ? 'announcement.pin' : 'announcement.unpin',
      'group_announcement', id, { group_id: req.group.id });
    return res.redirect(`/g/${req.group.id}/announcements`);
  })
);

module.exports = router;