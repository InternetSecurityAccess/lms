// routes/student/works/load-form-locals.js
'use strict';

const db = require('../../../database');
const { nowSql } = require('../../../utils/dates');
const attachments = require('../../../utils/attachments');

/**
 * loadFormLocals — общий для GET /submit, GET /archive, POST /submit.
 * Возвращает null, если задания для этого студента нет (нет пары / истории /
 * сдач, либо тема-обёртка вне видимости по снимку finished_at).
 *
 * submitBlocked — «сдача недоступна»:
 *   • группа/задание/предмет/преподаватель не active;
 *   • нет активной пары subject_groups;
 *   • не в группе предмета.
 */
async function loadFormLocals(me, teacherId, assignmentId) {
  const assignment = db.prepare(`
    SELECT a.*, s.title AS subject_title, s.id AS subject_id,
           s.status AS subject_status,
           t.name AS teacher_name, t.status AS teacher_status
    FROM assignments a
    JOIN subjects s ON s.id = a.subject_id
    JOIN teachers t ON t.id = s.teacher_id
    WHERE a.id = ? AND a.teacher_id = ? AND a.deleted_at IS NULL
      AND a.status IN ('active','finished')
      AND s.deleted_at IS NULL AND t.deleted_at IS NULL
  `).get(assignmentId, teacherId);
  if (!assignment) return null;

  const activePair = !!db.prepare(
    'SELECT 1 FROM subject_groups WHERE subject_id = ? AND group_id = ?'
  ).get(assignment.subject_id, me.group_id);
  const historyPair = !activePair
    ? db.prepare(`
        SELECT finished_at FROM subject_groups_history
        WHERE subject_id = ? AND group_id = ?
        ORDER BY finished_at DESC LIMIT 1
      `).get(assignment.subject_id, me.group_id)
    : null;
  const hasSubs = !!db.prepare(`
    SELECT 1 FROM submissions
    WHERE assignment_id = ? AND student_id = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(assignmentId, me.id);

  if (!activePair && !historyPair && !hasSubs) return null;

  // Тема-обёртка: проверка created_at/available_from.
  const topic = db.prepare(
    'SELECT id, content_url, available_from, created_at FROM topics WHERE assignment_id = ? AND deleted_at IS NULL LIMIT 1'
  ).get(assignmentId) || null;
  if (topic) {
    if (historyPair && historyPair.finished_at) {
      if (topic.created_at && topic.created_at > historyPair.finished_at) return null;
      if (topic.available_from && topic.available_from > historyPair.finished_at) return null;
    } else if (topic.available_from && topic.available_from > nowSql()) {
      return null;
    }
    topic.attachments = attachments.listAttachments('topic', topic.id);
  }

  assignment.attachments = attachments.listAttachments('assignment', assignmentId);
  const inGroup = activePair;
  const works = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM messages m
        WHERE m.submission_id = s.id AND m.sender_type = 'teacher'
          AND m.is_read = 0 AND m.deleted_at IS NULL) AS unread_count,
      (SELECT COUNT(*) FROM attachments a
        WHERE a.owner_kind = 'submission' AND a.owner_id = s.id) AS files_count
    FROM submissions s
    WHERE s.assignment_id = ? AND s.student_id = ? AND s.deleted_at IS NULL
    ORDER BY s.uploaded_at DESC
  `).all(assignmentId, me.id);
  const existing = works[0] || null;
  const existingFiles = existing ? attachments.listAttachments('submission', existing.id) : [];
  const submitBlocked =
    me.group_status !== 'active'
    || assignment.status !== 'active'
    || assignment.subject_status !== 'active'
    || assignment.teacher_status !== 'active'
    || !inGroup;
  let blockReason = null;
  if (submitBlocked) {
    if (assignment.status === 'finished') blockReason = 'assignment_finished';
    else if (assignment.subject_status !== 'active') blockReason = 'subject_finished';
    else if (assignment.teacher_status !== 'active') blockReason = 'teacher_finished';
    else if (me.group_status !== 'active') blockReason = 'group_finished';
    else if (!inGroup) blockReason = 'not_in_group';
  }
  return {
    title: assignment.title,
    me, assignment, topic, works, existing, existingFiles,
    lastStatus: existing ? existing.status : null,
    hasAccepted: works.some((w) => w.status === 'accepted'),
    submitBlocked,
    blockReason,
    justUploaded: false,
    error: null,
    formData: null,
  };
}

module.exports = loadFormLocals;
