// routes/teacher/trash.js
'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkTeacher } = require('../shared/authz');
const {
  handler, renderWith, parseIdOr404, audit, redirectWith,
} = require('../shared/handlers');
const lifecycle = require('../../utils/lifecycle');

const TRASH_KINDS = ['subjects', 'assignments', 'topics'];

const KIND_LABELS = Object.freeze({
  subjects: 'Предметы',
  assignments: 'Задания',
  topics: 'Темы',
});

router.get(
  '/trash',
  checkTeacher,
  handler((req, res) => {
    const tid = req.session.teacherId;
    const groups = [];
    let total = 0;

    const subjects = db.prepare(`
      SELECT id, title, deleted_at
      FROM subjects
      WHERE teacher_id = ? AND deleted_at IS NOT NULL
      ORDER BY deleted_at DESC
    `).all(tid);
    if (subjects.length > 0) {
      groups.push({
        kind: 'subjects',
        label: KIND_LABELS.subjects,
        rows: subjects.map((r) => ({
          id: r.id, title: r.title, subtitle: null, deleted_at: r.deleted_at,
        })),
      });
      total += subjects.length;
    }

    const assignments = db.prepare(`
      SELECT a.id, a.title, s.title AS subject_title, a.deleted_at
      FROM assignments a
      LEFT JOIN subjects s ON s.id = a.subject_id
      WHERE a.teacher_id = ? AND a.deleted_at IS NOT NULL
      ORDER BY a.deleted_at DESC
    `).all(tid);
    if (assignments.length > 0) {
      groups.push({
        kind: 'assignments',
        label: KIND_LABELS.assignments,
        rows: assignments.map((r) => ({
          id: r.id, title: r.title, subtitle: r.subject_title || null, deleted_at: r.deleted_at,
        })),
      });
      total += assignments.length;
    }

    const topics = db.prepare(`
      SELECT t.id, t.title, s.title AS subject_title, t.deleted_at
      FROM topics t
      JOIN subjects s ON s.id = t.subject_id
      WHERE s.teacher_id = ? AND t.deleted_at IS NOT NULL
      ORDER BY t.deleted_at DESC
    `).all(tid);
    if (topics.length > 0) {
      groups.push({
        kind: 'topics',
        label: KIND_LABELS.topics,
        rows: topics.map((r) => ({
          id: r.id, title: r.title, subtitle: r.subject_title || null, deleted_at: r.deleted_at,
        })),
      });
      total += topics.length;
    }

    return renderWith(res, 'teacher/trash', {
      title: 'Корзина',
      groups, total, KIND_LABELS,
      restored: req.query.restored === '1',
      restoreErr: req.query.err ? String(req.query.err).slice(0, 200) : null,
    });
  })
);

router.post(
  '/trash/:kind/:id/restore',
  checkTeacher,
  handler((req, res) => {
    const kind = String(req.params.kind || '');
    const id = parseIdOr404(req, res, 'id');
    if (!id) return res.redirect('/trash');
    if (!TRASH_KINDS.includes(kind)) return res.redirect('/trash');

    const tid = req.session.teacherId;

    // Проверка принадлежности: преподаватель может восстановить только своё.
    let row = null;
    if (kind === 'subjects') {
      row = db.prepare(
        'SELECT id FROM subjects WHERE id = ? AND teacher_id = ? AND deleted_at IS NOT NULL'
      ).get(id, tid);
    } else if (kind === 'assignments') {
      row = db.prepare(
        'SELECT id FROM assignments WHERE id = ? AND teacher_id = ? AND deleted_at IS NOT NULL'
      ).get(id, tid);
    } else if (kind === 'topics') {
      row = db.prepare(`
        SELECT t.id FROM topics t
        JOIN subjects s ON s.id = t.subject_id
        WHERE t.id = ? AND s.teacher_id = ? AND t.deleted_at IS NOT NULL
      `).get(id, tid);
    }
    if (!row) return res.redirect('/trash');

    const r = lifecycle.restore(kind, id);
    if (r.changes) {
      audit(req, `${kind.replace(/s$/, '')}.restore`, kind, id, { by: 'teacher' });
      return redirectWith(res, '/trash', { restored: 1 });
    }
    if (r.error === 'unique_conflict') {
      return redirectWith(res, '/trash', {
        err: 'Нельзя восстановить: название уже занято.',
      });
    }
    return redirectWith(res, '/trash', { restored: 1 });
  })
);

module.exports = router;