// routes/shared/loaders.js
'use strict';
const db = require('../../database');
const attachments = require('../../utils/attachments');
const { parseIdOr404, notFound, forbid } = require('./handlers');
const { isTeacherOfGroup } = require('./authz');
const { nowSql } = require('../../utils/dates');

const loadStudentRow = (req, res, next) => {
  const me = db.prepare(`
    SELECT s.*, g.name AS group_name,
           g.status AS group_status, g.deleted_at AS group_deleted_at
    FROM students s LEFT JOIN groups g ON g.id = s.group_id
    WHERE s.id = ?
  `).get(req.session.studentId);
  if (!me) return req.session.destroy(() => res.redirect('/login'));
  if (me.deleted_at || me.status === 'rejected') {
    return req.session.destroy(() => res.redirect('/login'));
  }
  if (me.group_deleted_at) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  req.me = me;
  next();
};

const loadTeacherRow = (req, res, next) => {
  const me = db.prepare(
    'SELECT * FROM teachers WHERE id = ? AND deleted_at IS NULL'
  ).get(req.session.teacherId);
  if (!me) return req.session.destroy(() => res.redirect('/login'));
  req.me = me;
  next();
};

const loadGroupAsTeacher = (req, res, next) => {
  const gid = parseIdOr404(req, res, 'groupId');
  if (!gid) return;
  const group = db.prepare(
    'SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL'
  ).get(gid);
  if (!group) return notFound(res, 'Группа не найдена.');
  req.group = group;
  req.isSubscribed = isTeacherOfGroup(req, gid);
  next();
};

const loadGroupAsStudent = (req, res, next) => {
  const gid = parseIdOr404(req, res, 'groupId');
  if (!gid) return;
  if (!req.me || Number(req.me.group_id) !== gid) return forbid(res);
  const group = db.prepare(
    'SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL'
  ).get(gid);
  if (!group) return notFound(res, 'Группа не найдена.');
  req.group = group;
  next();
};

const loadSubjectAsTeacher = (req, res, next) => {
  const sid = parseIdOr404(req, res, 'subjectId');
  if (!sid) return;
  const subject = db.prepare(`
    SELECT * FROM subjects
    WHERE id = ? AND teacher_id = ? AND deleted_at IS NULL
  `).get(sid, req.session.teacherId);
  if (!subject) return notFound(res, 'Предмет не найден.');
  req.subject = subject;
  next();
};

/**
 * loadSubjectAsStudent
 *
 * Доступ — по одной из трёх причин:
 *   1) активная связь subject_groups;
 *   2) история subject_groups_history (readonly-снимок);
 *   3) есть сдача по предмету (readonly, legacy).
 *
 * readonly — если любая из осей «неактивна» ИЛИ нет активной связи.
 * isHistory / historyFinishedAt — для последующих лоадеров
 * (loadTopicAsStudent / loadAssignmentAsStudent / loadSubmissionAsStudent),
 * чтобы они применили снимок на момент закрытия группы.
 */
const loadSubjectAsStudent = (req, res, next) => {
  const sid = parseIdOr404(req, res, 'subjectId');
  if (!sid) return;
  const teacherId = parseIdOr404(req, res, 'teacherId');
  if (!teacherId) return;
  if (!req.me) return forbid(res);
  const subject = db.prepare(`
    SELECT s.*, t.name AS teacher_name,
           t.status AS teacher_status, t.deleted_at AS teacher_deleted_at
    FROM subjects s
    JOIN teachers t ON t.id = s.teacher_id
    WHERE s.id = ? AND s.teacher_id = ?
      AND s.deleted_at IS NULL AND t.deleted_at IS NULL
  `).get(sid, teacherId);
  if (!subject) return notFound(res, 'Предмет не найден.');

  const activePair = !!db.prepare(
    'SELECT 1 FROM subject_groups WHERE subject_id = ? AND group_id = ?'
  ).get(sid, req.me.group_id);

  const historyPair = !activePair
    ? db.prepare(`
        SELECT finished_at FROM subject_groups_history
        WHERE subject_id = ? AND group_id = ?
        ORDER BY finished_at DESC LIMIT 1
      `).get(sid, req.me.group_id)
    : null;

  const hasSubs = !!db.prepare(`
    SELECT 1 FROM submissions s2
    JOIN assignments a ON a.id = s2.assignment_id
    WHERE a.subject_id = ? AND s2.student_id = ? AND s2.deleted_at IS NULL
    LIMIT 1
  `).get(sid, req.me.id);

  if (!activePair && !historyPair && !hasSubs) {
    return notFound(res, 'Предмет не найден.');
  }

  const reasonNotActive =
    subject.status !== 'active'
    || subject.teacher_status !== 'active'
    || req.me.status !== 'active'
    || req.me.group_status !== 'active'
    || !activePair;

  subject.readonly = reasonNotActive;
  subject.isHistory = !!historyPair && !activePair;
  subject.historyFinishedAt = historyPair ? historyPair.finished_at : null;
  req.subject = subject;
  next();
};

const loadTopicAsTeacher = (req, res, next) => {
  const tid = parseIdOr404(req, res, 'topicId');
  if (!tid) return;
  const topic = db.prepare(
    'SELECT * FROM topics WHERE id = ? AND subject_id = ? AND deleted_at IS NULL'
  ).get(tid, req.subject.id);
  if (!topic) return notFound(res, 'Тема не найдена.');
  topic.attachments = attachments.listAttachments('topic', topic.id);
  req.topic = topic;
  next();
};

/**
 * loadTopicAsStudent
 *
 * Два режима:
 *   • активная пара — обычные правила (status, available_from <= now);
 *   • история      — снимок на момент finished_at:
 *                    created_at <= finished_at
 *                    AND (available_from IS NULL OR available_from <= finished_at).
 * Если тема создана/открылась после закрытия — 404 (её «не было»
 * на момент закрытия).
 */
const loadTopicAsStudent = (req, res, next) => {
  const tid = parseIdOr404(req, res, 'topicId');
  if (!tid) return;

  let sql = `
    SELECT * FROM topics
    WHERE id = ? AND subject_id = ? AND deleted_at IS NULL
      AND status IN ('published','finished')
  `;
  const params = [tid, req.subject.id];

  if (req.subject.isHistory && req.subject.historyFinishedAt) {
    sql += ` AND created_at <= ?
             AND (available_from IS NULL OR available_from <= ?)`;
    params.push(req.subject.historyFinishedAt, req.subject.historyFinishedAt);
  } else {
    sql += ` AND (available_from IS NULL OR available_from <= CURRENT_TIMESTAMP)`;
  }

  const topic = db.prepare(sql).get(...params);
  if (!topic) return notFound(res, 'Тема не найдена.');
  topic.attachments = attachments.listAttachments('topic', topic.id);
  req.topic = topic;

  if (topic.assignment_id) {
    req.assignment = db.prepare(`
      SELECT * FROM assignments
      WHERE id = ? AND deleted_at IS NULL
        AND status IN ('active','finished')
    `).get(topic.assignment_id) || null;
    if (req.assignment) {
      req.assignment.attachments =
        attachments.listAttachments('assignment', req.assignment.id);
    }
    req.topicWorks = req.assignment ? db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM messages m
        WHERE m.submission_id = s.id AND m.sender_type = 'teacher' AND m.is_read = 0
          AND m.deleted_at IS NULL) AS unread_count
      FROM submissions s
      WHERE s.assignment_id = ? AND s.student_id = ? AND s.deleted_at IS NULL
      ORDER BY s.uploaded_at DESC
    `).all(req.assignment.id, req.session.studentId) : [];
  }
  next();
};

const loadAssignmentAsTeacher = (req, res, next) => {
  const aid = parseIdOr404(req, res, 'assignmentId');
  if (!aid) return;
  const assignment = db.prepare(`
    SELECT * FROM assignments
    WHERE id = ? AND subject_id = ? AND teacher_id = ? AND deleted_at IS NULL
  `).get(aid, req.subject.id, req.session.teacherId);
  if (!assignment) return notFound(res, 'Задание не найдено.');
  assignment.attachments = attachments.listAttachments('assignment', assignment.id);
  req.assignment = assignment;
  next();
};

/**
 * loadAssignmentAsStudent
 *
 * Студент должен иметь доступ к паре:
 *   • активная связь subject_groups — обычный доступ;
 *   • история subject_groups_history — readonly;
 *   • есть сдача — readonly (legacy).
 * Проверка темы-обёртки (available_from / created_at) с учётом истории.
 */
const loadAssignmentAsStudent = (req, res, next) => {
  const aid = parseIdOr404(req, res, 'assignmentId');
  if (!aid) return;
  const teacherId = parseIdOr404(req, res, 'teacherId');
  if (!teacherId) return;
  if (!req.me) return forbid(res);
  const assignment = db.prepare(`
    SELECT a.*, s.title AS subject_title, s.id AS subject_id,
           s.status AS subject_status, s.deleted_at AS subject_deleted_at,
           t.name AS teacher_name,
           t.status AS teacher_status, t.deleted_at AS teacher_deleted_at
    FROM assignments a
    JOIN subjects s ON s.id = a.subject_id
    JOIN teachers t ON t.id = s.teacher_id
    WHERE a.id = ? AND a.teacher_id = ? AND a.deleted_at IS NULL
      AND s.deleted_at IS NULL AND t.deleted_at IS NULL
  `).get(aid, teacherId);
  if (!assignment) return notFound(res, 'Задание не найдено.');
  if (assignment.status === 'draft') {
    return notFound(res, 'Задание не найдено.');
  }

  const activePair = !!db.prepare(
    'SELECT 1 FROM subject_groups WHERE subject_id = ? AND group_id = ?'
  ).get(assignment.subject_id, req.me.group_id);
  const historyPair = !activePair
    ? db.prepare(`
        SELECT finished_at FROM subject_groups_history
        WHERE subject_id = ? AND group_id = ?
        ORDER BY finished_at DESC LIMIT 1
      `).get(assignment.subject_id, req.me.group_id)
    : null;
  const hasSubs = !!db.prepare(`
    SELECT 1 FROM submissions
    WHERE assignment_id = ? AND student_id = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(aid, req.me.id);

  if (!activePair && !historyPair && !hasSubs) {
    return notFound(res, 'Задание не найдено.');
  }

  // Проверка темы-обёртки: created_at/available_from и снимок истории.
  const topicGate = db.prepare(`
    SELECT available_from, created_at FROM topics
    WHERE assignment_id = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(aid);
  if (topicGate) {
    if (historyPair && historyPair.finished_at) {
      if (topicGate.created_at && topicGate.created_at > historyPair.finished_at) {
        return notFound(res, 'Задание не найдено.');
      }
      if (topicGate.available_from && topicGate.available_from > historyPair.finished_at) {
        return notFound(res, 'Задание не найдено.');
      }
    } else if (topicGate.available_from && topicGate.available_from > nowSql()) {
      return notFound(res, 'Задание не найдено.');
    }
  }

  assignment.readonly = (
    assignment.status !== 'active'
    || assignment.subject_status !== 'active'
    || assignment.teacher_status !== 'active'
    || req.me.status !== 'active'
    || req.me.group_status !== 'active'
    || !activePair
  );
  assignment.isHistory = !!historyPair && !activePair;
  assignment.historyFinishedAt = historyPair ? historyPair.finished_at : null;
  assignment.attachments = attachments.listAttachments('assignment', assignment.id);
  req.assignment = assignment;
  next();
};

const loadSubmissionAsTeacher = (req, res, next) => {
  const sid = parseIdOr404(req, res, 'id');
  if (!sid) return;
  const gid = parseIdOr404(req, res, 'groupId');
  if (!gid) return;
  const sub = db.prepare(`
    SELECT s.*, g.name AS group_name, t.name AS teacher_name,
           st.name AS student_name, st.login AS student_login,
           a.title AS assignment_title,
           a.status AS assignment_status,
           a.subject_id AS subject_id,
           a.subject_id AS assignment_subject_id,
           sub.title AS subject_title
    FROM submissions s
    LEFT JOIN groups g ON g.id = s.group_id
    LEFT JOIN teachers t ON t.id = s.teacher_id
    LEFT JOIN students st ON st.id = s.student_id
    LEFT JOIN assignments a ON a.id = s.assignment_id
    LEFT JOIN subjects sub ON sub.id = a.subject_id
    WHERE s.id = ? AND s.group_id = ? AND s.teacher_id = ?
      AND s.deleted_at IS NULL
  `).get(sid, gid, req.session.teacherId);
  if (!sub) return notFound(res, 'Работа не найдена.');
  sub.attachments = attachments.listAttachments('submission', sub.id);
  req.submission = sub;
  next();
};

/**
 * loadSubmissionAsStudent
 *
 * Плюс проверка истории: если работа сдана ПОСЛЕ закрытия группы —
 * 404 (на момент закрытия её «не было», в readonly-историю не попадает).
 * readonly = true, если нет активной пары subject_groups.
 */
const loadSubmissionAsStudent = (req, res, next) => {
  const sid = parseIdOr404(req, res, 'id');
  if (!sid) return;
  const teacherId = parseIdOr404(req, res, 'teacherId');
  if (!teacherId) return;
  const sub = db.prepare(`
    SELECT s.*, g.name AS group_name, t.name AS teacher_name,
           a.title AS assignment_title,
           a.status AS assignment_status,
           a.subject_id AS subject_id,
           sub.title AS subject_title,
           sub.status AS subject_status,
           sub.deleted_at AS subject_deleted_at,
           t.status AS teacher_status, t.deleted_at AS teacher_deleted_at,
           g.status AS group_status, g.deleted_at AS group_deleted_at
    FROM submissions s
    JOIN groups g ON g.id = s.group_id
    JOIN teachers t ON t.id = s.teacher_id
    JOIN assignments a ON a.id = s.assignment_id
    JOIN subjects sub ON sub.id = a.subject_id
    WHERE s.id = ? AND s.student_id = ? AND s.teacher_id = ?
      AND s.deleted_at IS NULL
      AND sub.deleted_at IS NULL
      AND t.deleted_at IS NULL
      AND g.deleted_at IS NULL
  `).get(sid, req.session.studentId, teacherId);
  if (!sub) return notFound(res, 'Работа не найдена.');

  const activePair = !!db.prepare(
    'SELECT 1 FROM subject_groups WHERE subject_id = ? AND group_id = ?'
  ).get(sub.subject_id, sub.group_id);
  const historyPair = !activePair
    ? db.prepare(`
        SELECT finished_at FROM subject_groups_history
        WHERE subject_id = ? AND group_id = ?
        ORDER BY finished_at DESC LIMIT 1
      `).get(sub.subject_id, sub.group_id)
    : null;

  // Если история: работа должна быть сдана до закрытия.
  if (historyPair && historyPair.finished_at
      && sub.uploaded_at
      && sub.uploaded_at > historyPair.finished_at) {
    return notFound(res, 'Работа не найдена.');
  }

  sub.readonly = (
    sub.assignment_status !== 'active'
    || sub.subject_status !== 'active'
    || sub.teacher_status !== 'active'
    || sub.group_status !== 'active'
    || !activePair
  );
  sub.isHistory = !!historyPair && !activePair;
  sub.historyFinishedAt = historyPair ? historyPair.finished_at : null;
  sub.attachments = attachments.listAttachments('submission', sub.id);
  req.submission = sub;
  next();
};

module.exports = {
  loadStudentRow, loadTeacherRow,
  loadGroupAsTeacher, loadGroupAsStudent,
  loadSubjectAsTeacher, loadSubjectAsStudent,
  loadTopicAsTeacher, loadTopicAsStudent,
  loadAssignmentAsTeacher, loadAssignmentAsStudent,
  loadSubmissionAsTeacher, loadSubmissionAsStudent,
};