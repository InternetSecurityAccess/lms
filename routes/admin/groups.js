'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkAdmin } = require('../shared/authz');
const {
  handler, renderWith, parseIdOr404, notFound, audit,
  redirectWith,
} = require('../shared/handlers');
const { pickStr } = require('../shared/form');
const { normalizeSort, paginate } = require('../shared/lists');
const { safeRedirect } = require('../../utils/helpers');
const lifecycle = require('../../utils/lifecycle');
const PAGE_SIZE = 100;
function normalizeStatusFilter(v) {
  return ['active', 'finished', 'all'].includes(v) ? v : 'active';
}
router.get(
  '/admin/groups',
  checkAdmin,
  handler((req, res) => {
    const q = pickStr(req.query.q, 100);
    const status = normalizeStatusFilter(req.query.status);
    const sort = normalizeSort(req.query.sort,
      ['name_asc', 'name_desc', 'date_desc', 'date_asc']);
    let where = ' WHERE g.deleted_at IS NULL';
    const params = {};
    if (status === 'active') where += " AND g.status='active'";
    else if (status === 'finished') where += " AND g.status='finished'";
    if (q) { where += ' AND g.name LIKE @q'; params.q = `%${q}%`; }
    const orderBy = sort === 'name_desc' ? 'g.name DESC'
      : sort === 'date_desc' ? 'g.created_at DESC'
      : sort === 'date_asc' ? 'g.created_at ASC'
      : 'g.name ASC';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM groups g ${where}`).get(params).c;
    const pg = paginate(req.query.page, total, PAGE_SIZE);
    const groups = db.prepare(`
      SELECT g.*,
        (SELECT COUNT(*) FROM students s
          WHERE s.group_id = g.id AND s.deleted_at IS NULL) AS students_count,
        (SELECT COUNT(*) FROM teacher_groups tg
          WHERE tg.group_id = g.id) AS teachers_count,
        (SELECT COUNT(*) FROM subject_groups sg
          WHERE sg.group_id = g.id) AS subjects_count,
        (SELECT COUNT(*) FROM submissions sub
          WHERE sub.group_id = g.id AND sub.deleted_at IS NULL) AS works_count,
        (SELECT COUNT(*) FROM group_announcements a
          WHERE a.group_id = g.id AND a.deleted_at IS NULL) AS announcements_count,
        (SELECT COUNT(*) FROM group_threads t
          WHERE t.group_id = g.id) AS threads_count
      FROM groups g
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${pg.limit} OFFSET ${pg.offset}
    `).all(params);
    const counts = {
      active: db.prepare("SELECT COUNT(*) AS c FROM groups WHERE status='active' AND deleted_at IS NULL").get().c,
      finished: db.prepare("SELECT COUNT(*) AS c FROM groups WHERE status='finished' AND deleted_at IS NULL").get().c,
      all: db.prepare('SELECT COUNT(*) AS c FROM groups WHERE deleted_at IS NULL').get().c,
    };
    return renderWith(res, 'admin/people/groups', {
      title: 'Группы',
      groups, q, status, sort, counts,
      created: req.query.created === '1',
      renamed: req.query.renamed === '1',
      finishedDone: req.query.finished_done === '1',
      deletedDone: req.query.deleted === '1',
      page: pg.page, pages: pg.pages, total, PAGE_SIZE,
    });
  })
);
router.post(
  '/admin/groups',
  checkAdmin,
  handler((req, res) => {
    const name = pickStr(req.body.name, 50);
    if (!name) {
      return res.status(400).render('common/error', {
        title: 'Ошибка', message: 'Укажите название группы.',
      });
    }
    if (db.prepare('SELECT id FROM groups WHERE name = ? AND deleted_at IS NULL').get(name)) {
      return res.status(400).render('common/error', {
        title: 'Ошибка', message: 'Группа с таким названием уже существует.',
      });
    }
    const r = db.prepare(
      "INSERT INTO groups (name, status) VALUES (?, 'active')"
    ).run(name);
    audit(req, 'group.create', 'group', Number(r.lastInsertRowid), { name });
    return redirectWith(res, '/admin/groups', { created: 1 });
  })
);
router.post(
  '/admin/groups/:id/rename',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const name = pickStr(req.body.name, 50);
    if (!name) {
      return res.status(400).render('common/error', {
        title: 'Ошибка', message: 'Название не может быть пустым.',
      });
    }
    const existing = db.prepare(
      'SELECT id FROM groups WHERE name = ? AND id <> ? AND deleted_at IS NULL'
    ).get(name, id);
    if (existing) {
      return res.status(400).render('common/error', {
        title: 'Ошибка', message: 'Группа с таким названием уже существует.',
      });
    }
    const group = db.prepare(
      'SELECT id, name FROM groups WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!group) return notFound(res, 'Группа не найдена.');
    if (group.name === name) {
      return res.redirect(safeRedirect(req.body.redirect, '/admin/groups'));
    }
    db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id);
    audit(req, 'group.rename', 'group', id, { from: group.name, to: name });
    return res.redirect(safeRedirect(req.body.redirect, '/admin/groups?renamed=1'));
  })
);
router.post(
  '/admin/groups/:id/toggle-status',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const g = db.prepare(
      'SELECT id, name, status FROM groups WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!g) return notFound(res, 'Группа не найдена.');
    const next = g.status === 'active' ? 'finished' : 'active';
    lifecycle.setStatus('groups', id, next);
    audit(req, next === 'finished' ? 'group.archive' : 'group.unarchive',
      'group', id, { name: g.name, status: next });
    return redirectWith(res, '/admin/groups', { finished_done: 1 });
  })
);
router.post(
  '/admin/groups/:id/delete',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const g = db.prepare(
      'SELECT id, name FROM groups WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!g) return notFound(res, 'Группа не найдена.');
    lifecycle.softDelete('groups', id);
    audit(req, 'group.delete', 'group', id, { name: g.name, by: 'admin', mode: 'soft' });
    return redirectWith(res, '/admin/groups', { deleted: 1 });
  })
);
module.exports = router;