'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../../database');
const { checkTeacher } = require('../shared/authz');
const {
  handler, renderWith, parseIdOr404, audit, redirectWith,
} = require('../shared/handlers');
const { pickStr } = require('../shared/form');
const { loadGroupAsTeacher } = require('../shared/loaders');
const { normalizeSort } = require('../shared/lists');
const { bumpSessionVersion } = require('../../utils/sessions');
const { randomNumericPassword } = require('../../utils/password-policy');
const lifecycle = require('../../utils/lifecycle');

router.get(
  '/g/:groupId',
  checkTeacher, loadGroupAsTeacher,
  handler((req, res) => {
    const tid = req.session.teacherId;
    const tab = req.query.tab === 'students' ? 'students' : 'subjects';
    const q = pickStr(req.query.q, 100);
    const subjectsQ = pickStr(req.query.subjects_q, 100);
    if (tab === 'students' && !req.isSubscribed) {
      return res.status(403).render('common/error', {
        title: 'Доступ запрещён',
        message: 'Вы не ведёте эту группу. Список студентов доступен только '
          + 'преподавателям, отметившим её как «Моя группа».',
        backUrl: '/groups',
        backLabel: '← К группам',
      });
    }

    // ─── Предметы группы (только свои) ───
    let subjectsWhere = `
      WHERE s.teacher_id = @tid
        AND sg.group_id = @gid
        AND s.status = 'active'
        AND s.deleted_at IS NULL
    `;
    const subjectsParams = { tid, gid: req.group.id };
    if (subjectsQ) {
      subjectsWhere += ' AND (s.title LIKE @sq OR s.description LIKE @sq)';
      subjectsParams.sq = `%${subjectsQ}%`;
    }
    const subjects = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM topics t
          WHERE t.subject_id = s.id AND t.status='published' AND t.deleted_at IS NULL) AS topics_count,
        (SELECT COUNT(*) FROM topics t
          WHERE t.subject_id = s.id AND t.deleted_at IS NULL) AS topics_total
      FROM subjects s
      JOIN subject_groups sg ON sg.subject_id = s.id
      ${subjectsWhere}
      ORDER BY s.title
    `).all(subjectsParams);
    const subjectsCount = db.prepare(`
      SELECT COUNT(*) AS c FROM subjects s
      JOIN subject_groups sg ON sg.subject_id = s.id
      WHERE s.teacher_id = ? AND sg.group_id = ?
        AND s.status='active' AND s.deleted_at IS NULL
    `).get(tid, req.group.id).c;

    // ─── Студенты ───
    const hasWorks = ['none', 'yes'].includes(req.query.has_works) ? req.query.has_works : '';
    let studentsWhere = ' WHERE s.group_id = @gid AND s.deleted_at IS NULL';
    const studentsParams = { gid: req.group.id, tid };
    if (q) {
      studentsWhere += ' AND (s.name LIKE @q OR s.login LIKE @q)';
      studentsParams.q = `%${q}%`;
    }
    if (hasWorks === 'none') {
      studentsWhere += ' AND (SELECT COUNT(*) FROM submissions sub WHERE sub.student_id = s.id AND sub.teacher_id = @tid AND sub.deleted_at IS NULL) = 0';
    } else if (hasWorks === 'yes') {
      studentsWhere += ' AND (SELECT COUNT(*) FROM submissions sub WHERE sub.student_id = s.id AND sub.teacher_id = @tid AND sub.deleted_at IS NULL) > 0';
    }
    const sSort = normalizeSort(req.query.sort, ['name_asc', 'name_desc', 'date_desc', 'date_asc']);
    const sOrderBy = sSort === 'name_desc' ? 's.name DESC'
      : sSort === 'date_desc' ? 's.created_at DESC'
      : sSort === 'date_asc' ? 's.created_at ASC'
      : 's.name ASC';
    const students = req.isSubscribed
      ? db.prepare(`
          SELECT s.id, s.name, s.login, s.created_at, s.must_change_password,
            s.approved_at, s.rejection_reason, s.status,
            (SELECT COUNT(*) FROM submissions sub
              WHERE sub.student_id = s.id AND sub.teacher_id = @tid
                AND sub.deleted_at IS NULL) AS my_works_count
          FROM students s
          ${studentsWhere}
          ORDER BY ${sOrderBy}
        `).all(studentsParams)
      : [];

    const allMySubjects = db.prepare(`
      SELECT s.id, s.title
      FROM subjects s
      WHERE s.teacher_id = ? AND s.status='active' AND s.deleted_at IS NULL
        AND s.id NOT IN (SELECT subject_id FROM subject_groups WHERE group_id = ?)
      ORDER BY s.title
    `).all(tid, req.group.id);

    return renderWith(res, 'teacher/people/workspace', {
      title: req.group.name,
      group: req.group,
      isSubscribed: req.isSubscribed,
      subjects, subjectsCount, allMySubjects,
      students,
      hasWorks, q, subjectsQ, sort: sSort, tab,
    });
  })
);

// Подтверждение: approved_at = NOW(), status остаётся 'active'.
// rejection_reason сбрасываем — если студент был rejected и препод
// подтверждает повторно, CHECK (status='active' AND rejection_reason IS NULL)
// иначе упадёт.
router.post(
  '/g/:groupId/students/:studentId/approve',
  checkTeacher, loadGroupAsTeacher,
  handler((req, res) => {
    if (!req.isSubscribed) return res.status(403).render('common/error', {
      title: 'Доступ запрещён', message: 'Вы не ведёте эту группу.',
    });
    const sid = parseIdOr404(req, res, 'studentId');
    if (!sid) return;
    const r = db.prepare(`
      UPDATE students
      SET approved_at = CURRENT_TIMESTAMP,
          rejection_reason = NULL,
          approved_by_teacher_id = ?
      WHERE id = ? AND group_id = ? AND approved_at IS NULL
        AND status='active' AND deleted_at IS NULL
    `).run(req.session.teacherId, sid, req.group.id);
    if (r.changes) audit(req, 'student.approve', 'student', sid, { group: req.group.id });
    return redirectWith(res, `/g/${req.group.id}`, { tab: 'students' });
  })
);

// Отклонение: status='rejected' через lifecycle (CHECK-связка).
router.post(
  '/g/:groupId/students/:studentId/reject',
  checkTeacher, loadGroupAsTeacher,
  handler((req, res) => {
    if (!req.isSubscribed) return res.status(403).render('common/error', {
      title: 'Доступ запрещён', message: 'Вы не ведёте эту группу.',
    });
    const sid = parseIdOr404(req, res, 'studentId');
    if (!sid) return;
    const reason = pickStr(req.body.reason, 500) || 'без указания причины';
    const student = db.prepare(
      'SELECT id, approved_at FROM students WHERE id = ? AND group_id = ? AND deleted_at IS NULL'
    ).get(sid, req.group.id);
    if (!student || student.approved_at) {
      // Уже подтверждён — отклонять нечего.
      return redirectWith(res, `/g/${req.group.id}`, { tab: 'students' });
    }
    try {
      lifecycle.setStatus('students', sid, 'rejected', { rejectionReason: reason });
      audit(req, 'student.reject', 'student', sid, { group: req.group.id, reason });
    } catch (e) {
      console.error('[teacher/people/reject]', e.message);
    }
    return redirectWith(res, `/g/${req.group.id}`, { tab: 'students' });
  })
);

router.post(
  '/g/:groupId/students/:studentId/reset-password',
  checkTeacher, loadGroupAsTeacher,
  handler(async (req, res) => {
    if (!req.isSubscribed) {
      return res.status(403).json({
        ok: false, error: 'forbidden', message: 'Вы не ведёте эту группу.',
      });
    }
    const studentId = Number(req.params.studentId);
    if (!Number.isSafeInteger(studentId) || studentId < 1) {
      return res.status(400).json({
        ok: false, error: 'bad_id', message: 'Некорректный студент.',
      });
    }
    const student = db.prepare(
      'SELECT id, name FROM students WHERE id = ? AND group_id = ? AND deleted_at IS NULL'
    ).get(studentId, req.group.id);
    if (!student) {
      return res.status(404).json({
        ok: false, error: 'not_found', message: 'Студент не найден.',
      });
    }
    const newPassword = randomNumericPassword(8);
    const hash = await bcrypt.hash(newPassword, 10);
    db.prepare(
      'UPDATE students SET password_hash = ?, must_change_password = 1 WHERE id = ?'
    ).run(hash, studentId);
    bumpSessionVersion('students', studentId);
    audit(req, 'student.reset_password', 'student', studentId, { by: 'teacher' });
    return res.json({
      ok: true, userName: student.name,
      password: newPassword, passwordDigits: 8,
    });
  })
);

module.exports = router;