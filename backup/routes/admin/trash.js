// routes/admin/trash.js
'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkAdmin } = require('../shared/authz');
const {
  handler, renderWith, parseIdOr404, notFound, audit,
  redirectWith,
} = require('../shared/handlers');
const lifecycle = require('../../utils/lifecycle');
const TRASH_KINDS = [
  'teachers', 'students', 'groups', 'subjects',
  'assignments', 'topics', 'group_announcements', 'submissions',
];
const KIND_LABELS = Object.freeze({
  teachers: 'Преподаватели',
  students: 'Студенты',
  groups: 'Группы',
  subjects: 'Предметы',
  assignments: 'Задания',
  topics: 'Темы',
  group_announcements: 'Объявления',
  submissions: 'Работы',
});
const LIST_SQL = {
  teachers: `
    SELECT id, name AS title, login AS subtitle, deleted_at
    FROM teachers WHERE deleted_at IS NOT NULL
    ORDER BY deleted_at DESC`,
  students: `
    SELECT s.id, s.name AS title,
           (s.login || ' · ' || g.name) AS subtitle, s.deleted_at
    FROM students s LEFT JOIN groups g ON g.id = s.group_id
    WHERE s.deleted_at IS NOT NULL
    ORDER BY s.deleted_at DESC`,
  groups: `
    SELECT id, name AS title, NULL AS subtitle, deleted_at
    FROM groups WHERE deleted_at IS NOT NULL
    ORDER BY deleted_at DESC`,
  subjects: `
    SELECT s.id, s.title, t.name AS subtitle, s.deleted_at
    FROM subjects s LEFT JOIN teachers t ON t.id = s.teacher_id
    WHERE s.deleted_at IS NOT NULL
    ORDER BY s.deleted_at DESC`,
  assignments: `
    SELECT a.id, a.title, s.title AS subtitle, a.deleted_at
    FROM assignments a LEFT JOIN subjects s ON s.id = a.subject_id
    WHERE a.deleted_at IS NOT NULL
    ORDER BY a.deleted_at DESC`,
  topics: `
    SELECT t.id, t.title, s.title AS subtitle, t.deleted_at
    FROM topics t LEFT JOIN subjects s ON s.id = t.subject_id
    WHERE t.deleted_at IS NOT NULL
    ORDER BY t.deleted_at DESC`,
  group_announcements: `
    SELECT a.id, a.title, g.name AS subtitle, a.deleted_at
    FROM group_announcements a LEFT JOIN groups g ON g.id = a.group_id
    WHERE a.deleted_at IS NOT NULL
    ORDER BY a.deleted_at DESC`,
  submissions: `
    SELECT s.id, s.topic AS title,
           (st.name || ' · ' || s.status) AS subtitle, s.deleted_at
    FROM submissions s LEFT JOIN students st ON st.id = s.student_id
    WHERE s.deleted_at IS NOT NULL
    ORDER BY s.deleted_at DESC`,
};
router.get(
  '/admin/trash',
  checkAdmin,
  handler((req, res) => {
    const groups = [];
    let total = 0;
    for (const kind of TRASH_KINDS) {
      const rows = db.prepare(LIST_SQL[kind]).all();
      if (rows.length === 0) continue;
      groups.push({ kind, label: KIND_LABELS[kind], rows });
      total += rows.length;
    }
    return renderWith(res, 'admin/trash', {
      title: 'Корзина',
      groups, total, KIND_LABELS,
      restored: req.query.restored === '1',
      purged: req.query.purged === '1',
      purgeErrors: req.query.err ? String(req.query.err).slice(0, 200) : null,
    });
  })
);
router.post(
  '/admin/trash/:kind/:id/restore',
  checkAdmin,
  handler((req, res) => {
    const kind = String(req.params.kind || '');
    const id = parseIdOr404(req, res, 'id');
    if (!id) return res.redirect('/admin/trash');
    if (!TRASH_KINDS.includes(kind)) return res.redirect('/admin/trash');
    const r = lifecycle.restore(kind, id);
    if (r.changes) {
      audit(req, `${kind.replace(/s$/, '')}.restore`, kind, id, { by: 'admin' });
      return redirectWith(res, '/admin/trash', { restored: 1 });
    }
    if (r.error === 'unique_conflict') {
      return redirectWith(res, '/admin/trash', {
        err: 'Нельзя восстановить: логин или название уже заняты активной записью.',
      });
    }
    return redirectWith(res, '/admin/trash', { restored: 1 });
  })
);
router.post(
  '/admin/trash/:kind/:id/hard-delete',
  checkAdmin,
  handler(async (req, res) => {
    const kind = String(req.params.kind || '');
    const id = parseIdOr404(req, res, 'id');
    if (!id) return res.redirect('/admin/trash');
    if (!TRASH_KINDS.includes(kind)) return res.redirect('/admin/trash');
    const row = lifecycle.getRow(kind, id);
    if (!row) return notFound(res, 'Объект не найден.');
    if (!lifecycle.isDeleted(row)) {
      return res.redirect('/admin/trash');
    }
    let result;
    try {
      result = await lifecycle.hardDelete(kind, id, { cleanupFiles: true });
    } catch (e) {
      console.error(`[trash] hardDelete ${kind}#${id}:`, e);
      return redirectWith(res, '/admin/trash', {
        err: `${kind}#${id}: ${e.message || 'ошибка'}`,
      });
    }
    if (!result || result.ok === false) {
      const reason = result?.reason === 'not_empty'
        ? 'объект не пуст — hard-delete запрещён'
        : (result?.reason || 'не удалено');
      return redirectWith(res, '/admin/trash', {
        err: `${kind}#${id}: ${reason}`,
      });
    }
    audit(req, `${kind.replace(/s$/, '')}.hard_delete`, kind, id, { by: 'admin' });
    return redirectWith(res, '/admin/trash', { purged: 1 });
  })
);
module.exports = router;