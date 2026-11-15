// routes/admin/content.js
'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkAdmin } = require('../shared/authz');
const {
  handler, renderWith, parseIdOr404, notFound, audit,
  redirectWith, appendQuery,
} = require('../shared/handlers');
const { safeRedirect } = require('../../utils/helpers');
const { paginate } = require('../shared/lists');
const lifecycle = require('../../utils/lifecycle');
const PAGE_SIZE = 100;

router.get(
  '/admin/subjects',
  checkAdmin,
  handler((req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const status = ['active', 'finished'].includes(req.query.status) ? req.query.status : '';
    const teacherId = req.query.teacher ? Number(req.query.teacher) || null : null;
    let where = ' WHERE s.deleted_at IS NULL';
    const params = {};
    if (q) { where += ' AND (s.title LIKE @q OR s.description LIKE @q)'; params.q = `%${q}%`; }
    if (status) { where += ' AND s.status = @status'; params.status = status; }
    if (teacherId) { where += ' AND s.teacher_id = @teacherId'; params.teacherId = teacherId; }
    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM subjects s JOIN teachers t ON t.id = s.teacher_id ${where}
    `).get(params).c;
    const pg = paginate(req.query.page, total, PAGE_SIZE);
    const rows = db.prepare(`
      SELECT s.*, t.name AS teacher_name, t.status AS teacher_status,
        (SELECT COUNT(*) FROM topics tp WHERE tp.subject_id = s.id AND tp.deleted_at IS NULL) AS topics_count,
        (SELECT COUNT(*) FROM assignments a WHERE a.subject_id = s.id AND a.deleted_at IS NULL) AS assignments_count,
        (SELECT COUNT(*) FROM subject_groups sg WHERE sg.subject_id = s.id) AS groups_count
      FROM subjects s
      JOIN teachers t ON t.id = s.teacher_id
      ${where}
      ORDER BY s.title
      LIMIT ${pg.limit} OFFSET ${pg.offset}
    `).all(params);
    const teachers = db.prepare(
      'SELECT id, name FROM teachers WHERE deleted_at IS NULL ORDER BY name'
    ).all();
    const activeTeachers = db.prepare(
      "SELECT id, name FROM teachers WHERE status='active' AND deleted_at IS NULL ORDER BY name"
    ).all();
    return renderWith(res, 'admin/content/subjects', {
      title: 'Все предметы',
      rows, q, status, teacherId, teachers, activeTeachers,
      deletedDone: req.query.deleted === '1',
      finishedDone: req.query.finished_done === '1',
      teacherChanged: req.query.teacher_changed === '1',
      page: pg.page, pages: pg.pages, total, PAGE_SIZE,
    });
  })
);

router.post(
  '/admin/subjects/:id/toggle-status',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return res.redirect('/admin/subjects');
    const s = db.prepare(
      'SELECT id, status, title FROM subjects WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!s) return res.redirect('/admin/subjects');
    const next = s.status === 'active' ? 'finished' : 'active';
    lifecycle.setStatus('subjects', id, next);
    audit(req, next === 'finished' ? 'subject.archive' : 'subject.unarchive',
      'subject', id, { title: s.title, by: 'admin' });
    return redirectWith(res, '/admin/subjects', { finished_done: 1 });
  })
);

router.post(
  '/admin/subjects/:id/change-teacher',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return res.redirect('/admin/subjects');
    const redirectTo = safeRedirect(req.body.redirect, '/admin/subjects');
    const subject = db.prepare(
      'SELECT id, title, teacher_id FROM subjects WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!subject) return notFound(res, 'Предмет не найден.');
    const newTeacherId = Number(req.body.teacher_id);
    if (!Number.isSafeInteger(newTeacherId) || newTeacherId < 1) {
      return res.redirect(redirectTo);
    }
    if (Number(newTeacherId) === Number(subject.teacher_id)) {
      return res.redirect(redirectTo);
    }
    const newTeacher = db.prepare(
      "SELECT id, name FROM teachers WHERE id = ? AND status='active' AND deleted_at IS NULL"
    ).get(newTeacherId);
    if (!newTeacher) {
      return res.status(400).render('common/error', {
        title: 'Ошибка', message: 'Преподаватель не найден или завершён.',
      });
    }
    const oldTeacher = db.prepare('SELECT id, name FROM teachers WHERE id = ?')
      .get(subject.teacher_id);
    const submissionIds = db.prepare(`
      SELECT s.id FROM submissions s
      JOIN assignments a ON a.id = s.assignment_id
      WHERE a.subject_id = ? AND s.deleted_at IS NULL
    `).all(subject.id).map((r) => r.id);
    const messagesCount = db.prepare(`
      SELECT COUNT(*) AS c FROM messages m
      JOIN submissions s ON s.id = m.submission_id
      JOIN assignments a ON a.id = s.assignment_id
      WHERE a.subject_id = ? AND s.deleted_at IS NULL
    `).get(subject.id).c;
    const groupIds = db.prepare(
      'SELECT group_id FROM subject_groups WHERE subject_id = ?'
    ).all(subject.id).map((r) => r.group_id);
    let assignmentsCount = 0;
    let submissionsCount = 0;
    let statusReadsCleared = 0;
    let autoSubscribed = 0;
    db.transaction(() => {
      if (oldTeacher && submissionIds.length > 0) {
        const ph = submissionIds.map(() => '?').join(',');
        const del = db.prepare(`
          DELETE FROM submission_status_reads
          WHERE reader_type = 'teacher' AND reader_id = ?
            AND submission_id IN (${ph})
        `).run(oldTeacher.id, ...submissionIds);
        statusReadsCleared = del.changes;
      }
      const a = db.prepare(
        'UPDATE assignments SET teacher_id = ? WHERE subject_id = ? AND deleted_at IS NULL'
      ).run(newTeacher.id, subject.id);
      assignmentsCount = a.changes;
      const s = db.prepare(`
        UPDATE submissions SET teacher_id = ?
        WHERE deleted_at IS NULL
          AND assignment_id IN (SELECT id FROM assignments WHERE subject_id = ?)
      `).run(newTeacher.id, subject.id);
      submissionsCount = s.changes;
      db.prepare('UPDATE subjects SET teacher_id = ? WHERE id = ?')
        .run(newTeacher.id, subject.id);
      if (groupIds.length > 0) {
        const insertTG = db.prepare(
          'INSERT OR IGNORE INTO teacher_groups (teacher_id, group_id) VALUES (?, ?)'
        );
        for (const gid of groupIds) {
          const r = insertTG.run(newTeacher.id, gid);
          if (r.changes) autoSubscribed++;
        }
      }
    })();
    audit(req, 'subject.change_teacher', 'subject', subject.id, {
      title: subject.title,
      from_teacher_id: oldTeacher?.id || null,
      from_teacher_name: oldTeacher?.name || null,
      to_teacher_id: newTeacher.id,
      to_teacher_name: newTeacher.name,
      assignments: assignmentsCount,
      submissions: submissionsCount,
      messages: messagesCount,
      group_ids_subscribed: groupIds,
      groups_auto_subscribed: autoSubscribed,
      status_reads_cleared: statusReadsCleared,
    });
    return res.redirect(appendQuery(redirectTo, { teacher_changed: 1 }));
  })
);

router.post(
  '/admin/subjects/:id/delete',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return res.redirect('/admin/subjects');
    const s = db.prepare(
      'SELECT id, title FROM subjects WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!s) return res.redirect('/admin/subjects');
    lifecycle.softDelete('subjects', id);
    audit(req, 'subject.delete', 'subject', id, {
      title: s.title, by: 'admin', mode: 'soft',
    });
    return redirectWith(res, '/admin/subjects', { deleted: 1 });
  })
);

// ── Завершить/возобновить задание. Единственная точка в системе. ──
router.post(
  '/admin/assignments/:id/toggle-status',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    const redirectTo = safeRedirect(req.body.redirect, '/admin/subjects');
    if (!id) return res.redirect(redirectTo);
    const a = db.prepare(
      'SELECT id, title, status FROM assignments WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!a) return res.redirect(redirectTo);
    const next = a.status === 'active' ? 'finished' : 'active';
    lifecycle.setStatus('assignments', id, next);
    audit(req, next === 'finished' ? 'assignment.archive' : 'assignment.unarchive',
      'assignment', id, { title: a.title, status: next, by: 'admin' });
    return redirectWith(res, redirectTo, { finished_done: 1 });
  })
);

router.get(
  '/admin/topics',
  checkAdmin,
  handler((req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const subjectId = req.query.subject ? Number(req.query.subject) || null : null;
    let where = ' WHERE t.deleted_at IS NULL';
    const params = {};
    if (q) { where += ' AND (t.title LIKE @q OR t.description LIKE @q)'; params.q = `%${q}%`; }
    if (subjectId) { where += ' AND t.subject_id = @sid'; params.sid = subjectId; }
    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM topics t JOIN subjects s ON s.id = t.subject_id ${where}
    `).get(params).c;
    const pg = paginate(req.query.page, total, PAGE_SIZE);
    const rows = db.prepare(`
      SELECT t.*, s.title AS subject_title, s.teacher_id, s.id AS subject_id,
             a.title AS assignment_title
      FROM topics t
      JOIN subjects s ON s.id = t.subject_id
      LEFT JOIN assignments a ON a.id = t.assignment_id
      ${where}
      ORDER BY t.subject_id, t.position, t.id
      LIMIT ${pg.limit} OFFSET ${pg.offset}
    `).all(params);
    const subjects = db.prepare(
      'SELECT id, title FROM subjects WHERE deleted_at IS NULL ORDER BY title'
    ).all();
    return renderWith(res, 'admin/content/topics', {
      title: 'Все темы', rows, q, subjectId, subjects,
      deletedDone: req.query.deleted === '1',
      page: pg.page, pages: pg.pages, total, PAGE_SIZE,
    });
  })
);

router.post(
  '/admin/topics/:id/delete',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return res.redirect('/admin/topics');
    const t = db.prepare(
      'SELECT id, title FROM topics WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!t) return res.redirect('/admin/topics');
    const result = lifecycle.softDeleteTopic(id);
    audit(req, 'topic.delete', 'topic', id, {
      title: t.title, by: 'admin', mode: 'soft',
      assignment: result.assignmentAction || null,
    });
    return redirectWith(res, '/admin/topics', { deleted: 1 });
  })
);

router.get(
  '/admin/announcements',
  checkAdmin,
  handler((req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const groupId = req.query.group ? Number(req.query.group) || null : null;
    let where = ' WHERE a.deleted_at IS NULL';
    const params = {};
    if (q) { where += ' AND (a.title LIKE @q OR a.content LIKE @q)'; params.q = `%${q}%`; }
    if (groupId) { where += ' AND a.group_id = @gid'; params.gid = groupId; }
    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM group_announcements a ${where}
    `).get(params).c;
    const pg = paginate(req.query.page, total, PAGE_SIZE);
    const rows = db.prepare(`
      SELECT a.*, g.name AS group_name, t.name AS teacher_name
      FROM group_announcements a
      JOIN groups g ON g.id = a.group_id
      JOIN teachers t ON t.id = a.teacher_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT ${pg.limit} OFFSET ${pg.offset}
    `).all(params);
    const groups = db.prepare(
      'SELECT id, name FROM groups WHERE deleted_at IS NULL ORDER BY name'
    ).all();
    return renderWith(res, 'admin/content/announcements', {
      title: 'Все объявления', rows, q, groupId, groups,
      deletedDone: req.query.deleted === '1',
      page: pg.page, pages: pg.pages, total, PAGE_SIZE,
    });
  })
);

router.post(
  '/admin/announcements/:id/delete',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return res.redirect('/admin/announcements');
    const a = db.prepare(
      'SELECT id, title FROM group_announcements WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!a) return res.redirect('/admin/announcements');
    lifecycle.softDelete('group_announcements', id);
    audit(req, 'announcement.delete', 'group_announcement', id, {
      title: a.title, by: 'admin', mode: 'soft',
    });
    return redirectWith(res, '/admin/announcements', { deleted: 1 });
  })
);

module.exports = router;