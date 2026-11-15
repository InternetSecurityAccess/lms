'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkStudent } = require('../shared/authz');
const { handler, parseIdOr404, notFound, renderWith } = require('../shared/handlers');
const { parseId } = require('../../utils/helpers');
const { loadStudentRow } = require('../shared/loaders');
const { normalizeSort } = require('../shared/lists');

router.get(
  '/t/:teacherId',
  checkStudent, loadStudentRow,
  handler((req, res) => {
    const teacherId = parseIdOr404(req, res, 'teacherId');
    if (!teacherId) return;
    const me = req.me;
    const teacher = db.prepare(
      'SELECT id, name, max_url, status FROM teachers WHERE id = ? AND deleted_at IS NULL'
    ).get(teacherId);
    if (!teacher) return notFound(res, 'Преподаватель не найден.');
    const teachesMyGroup = !!db.prepare(
      'SELECT 1 FROM teacher_groups WHERE teacher_id = ? AND group_id = ?'
    ).get(teacherId, me.group_id);
    const subjectsQ = String(req.query.subjects_q || '').trim().slice(0, 100);
    let subjWhere = `
      WHERE s.teacher_id = @teacherId
        AND s.deleted_at IS NULL
        AND t2.status = 'active' AND t2.deleted_at IS NULL
        AND (
          sg.group_id = @groupId
          OR s.id IN (
            SELECT a2.subject_id FROM assignments a2
            JOIN submissions s2 ON s2.assignment_id = a2.id
            WHERE s2.student_id = @studentId AND s2.deleted_at IS NULL
          )
        )
    `;
    const subjParams = { teacherId, groupId: me.group_id, studentId: me.id };
    if (subjectsQ) {
      subjWhere += ' AND (s.title LIKE @sq OR s.description LIKE @sq)';
      subjParams.sq = `%${subjectsQ}%`;
    }
    // t2 — alias teachers для проверки: реально JOIN по subject.teacher_id,
    // но в этом запросе teacher тот же, что в teacherId.
    const subjects = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM topics tp
          WHERE tp.subject_id = s.id
            AND tp.status IN ('published','finished') AND tp.deleted_at IS NULL) AS topics_count
      FROM subjects s
      JOIN subject_groups sg ON sg.subject_id = s.id
      JOIN teachers t2 ON t2.id = s.teacher_id
      ${subjWhere}
      ORDER BY s.title
    `).all(subjParams);
    const assignments = db.prepare(`
      SELECT a.*, s.title AS subject_title, s.id AS subject_id,
        (SELECT COUNT(*) FROM submissions sub
          WHERE sub.assignment_id = a.id AND sub.student_id = ?
            AND sub.deleted_at IS NULL) AS my_works_count,
        (SELECT sub.status FROM submissions sub
          WHERE sub.assignment_id = a.id AND sub.student_id = ?
            AND sub.deleted_at IS NULL
          ORDER BY sub.uploaded_at DESC LIMIT 1) AS my_last_status
      FROM assignments a
      JOIN subjects s ON s.id = a.subject_id
      JOIN subject_groups sg ON sg.subject_id = s.id AND sg.group_id = ?
      WHERE a.teacher_id = ? AND a.status IN ('active','finished')
        AND a.deleted_at IS NULL
        AND s.status IN ('active','finished') AND s.deleted_at IS NULL
      ORDER BY a.deadline IS NULL, a.deadline ASC, a.created_at DESC
    `).all(me.id, me.id, me.group_id, teacherId);
    const q = String(req.query.q || '').trim().slice(0, 100);
    const statusFilter = ['pending', 'accepted', 'rejected'].includes(req.query.status)
      ? req.query.status : null;
    const sort = normalizeSort(req.query.sort,
      ['date_desc', 'date_asc', 'name_asc', 'name_desc', 'status']);
    // Работы: не удалённые, все видимые (включая finished-предмет).
    // Readonly не блокирует отображение, только действия.
    let where = `
      WHERE s.teacher_id = ? AND s.student_id = ? AND s.deleted_at IS NULL
        AND a.deleted_at IS NULL
        AND sj.deleted_at IS NULL
        AND t.deleted_at IS NULL
        AND g.deleted_at IS NULL
    `;
    const params = [teacherId, me.id];
    if (statusFilter) { where += ' AND s.status = ?'; params.push(statusFilter); }
    if (q) {
      where += ' AND (s.topic LIKE ? OR a.title LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    const orderBy = sort === 'date_asc' ? 's.uploaded_at ASC'
      : sort === 'name_asc' ? 's.topic ASC'
      : sort === 'name_desc' ? 's.topic DESC'
      : sort === 'status' ? "CASE s.status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, s.uploaded_at DESC"
      : 's.uploaded_at DESC';
    const works = db.prepare(`
      SELECT s.*, a.title AS assignment_title,
        (SELECT COUNT(*) FROM messages m
          WHERE m.submission_id = s.id AND m.sender_type = 'teacher'
            AND m.is_read = 0 AND m.deleted_at IS NULL)
          AS unread_count
      FROM submissions s
      JOIN teachers t ON t.id = s.teacher_id
      JOIN groups g ON g.id = s.group_id
      JOIN assignments a ON a.id = s.assignment_id
      JOIN subjects sj ON sj.id = a.subject_id
      ${where}
      ORDER BY ${orderBy}
    `).all(...params);
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN s.status='pending'  THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN s.status='accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN s.status='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM submissions s
      JOIN teachers t ON t.id = s.teacher_id
      JOIN groups g ON g.id = s.group_id
      JOIN assignments a ON a.id = s.assignment_id
      JOIN subjects sj ON sj.id = a.subject_id
      WHERE s.teacher_id = ? AND s.student_id = ? AND s.deleted_at IS NULL
        AND a.deleted_at IS NULL
        AND sj.deleted_at IS NULL
        AND t.deleted_at IS NULL
        AND g.deleted_at IS NULL
    `).get(teacherId, me.id);
    return renderWith(res, 'student/people/workspace', {
      title: teacher.name,
      me, teacher,
      teachesMyGroup,
      isRelated: teachesMyGroup || subjects.length > 0,
      subjects, assignments, works, counts,
      q, subjectsQ, statusFilter, sort,
      newSubmissionId: req.query.new ? parseId(req.query.new) : null,
    });
  })
);

module.exports = router;