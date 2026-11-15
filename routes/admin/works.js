'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkAdmin } = require('../shared/authz');
const {
  handler, renderWith, parseIdOr404, audit,
  redirectWith, appendQuery,
} = require('../shared/handlers');
const { paginate } = require('../shared/lists');
const { WORK_STATUSES } = require('../../utils/statuses');
const { safeRedirect } = require('../../utils/helpers');
const lifecycle = require('../../utils/lifecycle');
const PAGE_SIZE = 50;
router.get(
  '/admin/works',
  checkAdmin,
  handler((req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const status = ['pending', 'accepted', 'rejected'].includes(req.query.status)
      ? req.query.status : '';
    const deleted = req.query.deleted === 'yes' ? 'yes'
      : (req.query.deleted === 'all' ? 'all' : 'no');
    const groupId = req.query.group ? Number(req.query.group) || null : null;
    const teacherId = req.query.teacher ? Number(req.query.teacher) || null : null;
    let where = ' WHERE 1=1';
    const params = {};
    if (q) {
      where += ' AND (s.topic LIKE @q OR st.name LIKE @q OR t.name LIKE @q OR g.name LIKE @q)';
      params.q = `%${q}%`;
    }
    if (status) { where += ' AND s.status = @status'; params.status = status; }
    if (deleted === 'no') where += ' AND s.deleted_at IS NULL';
    else if (deleted === 'yes') where += ' AND s.deleted_at IS NOT NULL';
    where += ' AND g.deleted_at IS NULL';
    if (groupId) { where += ' AND s.group_id = @groupId'; params.groupId = groupId; }
    if (teacherId) { where += ' AND s.teacher_id = @teacherId'; params.teacherId = teacherId; }
    const total = db.prepare(`
      SELECT COUNT(*) AS c
      FROM submissions s
      JOIN students st ON st.id = s.student_id
      JOIN teachers t ON t.id = s.teacher_id
      JOIN groups g ON g.id = s.group_id
      ${where}
    `).get(params).c;
    const pg = paginate(req.query.page, total, PAGE_SIZE);
    const rows = db.prepare(`
      SELECT s.*, st.name AS student_name, st.login AS student_login,
             t.name AS teacher_name, g.name AS group_name,
             (SELECT COUNT(*) FROM attachments a
               WHERE a.owner_kind = 'submission' AND a.owner_id = s.id) AS files_count
      FROM submissions s
      JOIN students st ON st.id = s.student_id
      JOIN teachers t ON t.id = s.teacher_id
      JOIN groups g ON g.id = s.group_id
      ${where}
      ORDER BY s.uploaded_at DESC, s.id DESC
      LIMIT ${pg.limit} OFFSET ${pg.offset}
    `).all(params);
    const groups = db.prepare(
      'SELECT id, name FROM groups WHERE deleted_at IS NULL ORDER BY name'
    ).all();
    const teachers = db.prepare(
      'SELECT id, name FROM teachers WHERE deleted_at IS NULL ORDER BY name'
    ).all();
    return renderWith(res, 'admin/works/list', {
      title: 'Все работы',
      rows, total, page: pg.page, pages: pg.pages, PAGE_SIZE,
      q, status, deleted, groupId, teacherId,
      groups, teachers, WORK_STATUSES,
      deletedDone: req.query.deleted_done === '1',
      statusDone: req.query.status_done === '1',
      restoreDone: req.query.restore_done === '1',
    });
  })
);
router.post(
  '/admin/works/:id/toggle-deleted',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    const redirectTo = safeRedirect(req.body.redirect, '/admin/works');
    if (!id) return res.redirect(redirectTo);
    const sub = db.prepare(
      'SELECT id, deleted_at FROM submissions WHERE id = ?'
    ).get(id);
    if (!sub) return res.redirect(redirectTo);
    if (sub.deleted_at) {
      lifecycle.restore('submissions', id);
      audit(req, 'submission.unarchive', 'submission', id, { by: 'admin' });
    } else {
      lifecycle.softDelete('submissions', id);
      audit(req, 'submission.archive', 'submission', id, { by: 'admin' });
    }
    return res.redirect(appendQuery(redirectTo, { restore_done: 1 }));
  })
);
router.post(
  '/admin/works/:id/delete',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    const redirectTo = safeRedirect(req.body.redirect, '/admin/works');
    if (!id) return res.redirect(redirectTo);
    const sub = db.prepare(
      'SELECT id, topic, student_id FROM submissions WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!sub) return res.redirect(redirectTo);
    lifecycle.softDelete('submissions', id);
    audit(req, 'submission.delete', 'submission', id, {
      topic: sub.topic, student_id: sub.student_id, by: 'admin', mode: 'soft',
    });
    return res.redirect(appendQuery(redirectTo, { deleted_done: 1 }));
  })
);
router.post(
  '/admin/works/:id/status',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    const status = String(req.body.status || '');
    const redirectTo = safeRedirect(req.body.redirect, '/admin/works');
    if (!id || !Object.keys(WORK_STATUSES).includes(status)) {
      return res.redirect(redirectTo);
    }
    const sub = db.prepare(
      'SELECT id, status FROM submissions WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!sub) return res.redirect(redirectTo);
    db.transaction(() => {
      if (status === 'accepted') {
        db.prepare(`
          UPDATE submissions
          SET status = 'accepted', ai_flag = 0, ai_flag_read_by_student = 0
          WHERE id = ?
        `).run(id);
      } else {
        db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run(status, id);
      }
      db.prepare('DELETE FROM submission_status_reads WHERE submission_id = ?').run(id);
    })();
    audit(req, 'submission.status', 'submission', id, {
      from: sub.status, to: status, by: 'admin',
    });
    return res.redirect(appendQuery(redirectTo, { status_done: 1 }));
  })
);
module.exports = router;