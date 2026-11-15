'use strict';
const express = require('express');
const router = express.Router();
const db = require('../database');
const { checkTeacher } = require('./shared/authz');
const { parseId } = require('../utils/helpers');
const { computeCounters, setCountersCache } = require('../utils/counters');

router.get('/api/counters', (req, res) => {
  const s = req.session;
  if (!s?.studentId && !s?.teacherId && !s?.adminId) {
    return res.status(401).json({
      ok: false, error: 'unauthorized', message: 'Требуется вход в систему.',
    });
  }
  const counters = computeCounters(s);
  setCountersCache(req.sessionID, counters);
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, ...counters });
});

router.post('/api/my-groups/:id', checkTeacher, (req, res) => {
  const gid = parseId(req.params.id);
  if (!gid) {
    return res.status(400).json({
      ok: false, error: 'bad_id', message: 'Некорректный id группы.',
    });
  }
  const g = db.prepare(
    'SELECT id FROM groups WHERE id = ? AND deleted_at IS NULL'
  ).get(gid);
  if (!g) {
    return res.status(404).json({
      ok: false, error: 'not_found', message: 'Группа не найдена.',
    });
  }
  db.prepare(
    'INSERT OR IGNORE INTO teacher_groups (teacher_id, group_id) VALUES (?, ?)'
  ).run(req.session.teacherId, gid);
  res.json({ ok: true });
});

router.delete('/api/my-groups/:id', checkTeacher, (req, res) => {
  const gid = parseId(req.params.id);
  if (!gid) {
    return res.status(400).json({
      ok: false, error: 'bad_id', message: 'Некорректный id группы.',
    });
  }
  const force = req.query.force === '1';
  const worksCount = db.prepare(`
    SELECT COUNT(*) AS c FROM submissions
    WHERE teacher_id = ? AND group_id = ? AND deleted_at IS NULL
  `).get(req.session.teacherId, gid).c;
  if (worksCount > 0 && !force) {
    return res.status(409).json({
      ok: false, error: 'has_works', works: worksCount,
      message:
        `У вас ${worksCount} ${worksCount === 1 ? 'работа' : 'работ'} в этой группе. ` +
        'При отвязке они пропадут из «Моих групп» (сами работы и файлы сохранятся). Продолжить?',
    });
  }
  const tx = db.transaction(() => {
    db.prepare(
      'DELETE FROM teacher_groups WHERE teacher_id = ? AND group_id = ?'
    ).run(req.session.teacherId, gid);
    db.prepare(`
      DELETE FROM subject_groups
      WHERE group_id = ? AND subject_id IN (
        SELECT id FROM subjects WHERE teacher_id = ?
      )
    `).run(gid, req.session.teacherId);
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;