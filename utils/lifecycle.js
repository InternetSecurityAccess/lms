// utils/lifecycle.js
'use strict';
const db = require('../database');
const config = require('../config');
const { safeJoin } = require('./helpers');

const KINDS = Object.freeze({
  teachers: Object.freeze({
    table: 'teachers',
    statuses: ['active', 'finished'],
    active: 'active',
    finished: 'finished',
  }),
  students: Object.freeze({
    table: 'students',
    statuses: ['active', 'finished', 'rejected'],
    active: 'active',
    finished: ['finished', 'rejected'],
  }),
  groups: Object.freeze({
    table: 'groups',
    statuses: ['active', 'finished'],
    active: 'active',
    finished: 'finished',
  }),
  subjects: Object.freeze({
    table: 'subjects',
    statuses: ['active', 'finished'],
    active: 'active',
    finished: 'finished',
  }),
  assignments: Object.freeze({
    table: 'assignments',
    statuses: ['draft', 'active', 'finished'],
    active: 'active',
    finished: 'finished',
  }),
  topics: Object.freeze({
    table: 'topics',
    statuses: ['draft', 'published', 'finished'],
    active: 'published',
    finished: 'finished',
  }),
  group_announcements: Object.freeze({
    table: 'group_announcements',
    statuses: ['active', 'finished'],
    active: 'active',
    finished: 'finished',
  }),
  submissions: Object.freeze({
    table: 'submissions',
    statuses: ['pending', 'accepted', 'rejected'],
    active: null,
    finished: null,
  }),
});

function configOf(kind) {
  const c = KINDS[kind];
  if (!c) throw new Error(`[lifecycle] unknown kind: ${kind}`);
  return c;
}

function getRow(kind, id) {
  const c = configOf(kind);
  return db.prepare(`SELECT * FROM ${c.table} WHERE id = ?`).get(Number(id)) || null;
}

function isDeleted(row) {
  return !!(row && row.deleted_at);
}

function isActive(kind, row) {
  if (!row || row.deleted_at) return false;
  const c = configOf(kind);
  if (c.active === null) return true;
  return row.status === c.active;
}

function isFinished(kind, row) {
  if (!row || row.deleted_at) return false;
  const c = configOf(kind);
  if (c.finished === null) return false;
  if (Array.isArray(c.finished)) return c.finished.includes(row.status);
  return row.status === c.finished;
}

function setStatus(kind, id, status, opts = {}) {
  const c = configOf(kind);
  if (!c.statuses.includes(status)) {
    throw new Error(
      `[lifecycle] ${kind}: недопустимый status "${status}". `
      + `Разрешены: ${c.statuses.join(', ')}`
    );
  }
  if (kind === 'students') return setStudentStatus(id, status, opts);
  const r = db.prepare(
    `UPDATE ${c.table} SET status = ? WHERE id = ? AND deleted_at IS NULL`
  ).run(status, Number(id));
  return { changes: r.changes };
}

function setStudentStatus(id, status, opts = {}) {
  const sid = Number(id);
  if (status === 'rejected') {
    const reason = String(opts.rejectionReason || '').trim();
    if (!reason) {
      throw new Error('[lifecycle] students: status "rejected" требует rejectionReason');
    }
    const r = db.prepare(`
      UPDATE students
      SET status = 'rejected',
          rejection_reason = ?,
          approved_at = NULL
      WHERE id = ? AND deleted_at IS NULL
    `).run(reason, sid);
    return { changes: r.changes };
  }
  if (status === 'finished') {
    const r = db.prepare(`
      UPDATE students
      SET status = 'finished',
          approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
          rejection_reason = NULL
      WHERE id = ? AND deleted_at IS NULL
    `).run(sid);
    return { changes: r.changes };
  }
  const r = db.prepare(`
    UPDATE students
    SET status = 'active',
        rejection_reason = NULL
    WHERE id = ? AND deleted_at IS NULL
  `).run(sid);
  return { changes: r.changes };
}

function softDelete(kind, id) {
  const c = configOf(kind);
  const r = db.prepare(
    `UPDATE ${c.table} SET deleted_at = CURRENT_TIMESTAMP `
    + `WHERE id = ? AND deleted_at IS NULL`
  ).run(Number(id));
  return { changes: r.changes };
}

/**
 * Мягкое удаление темы с корректной обработкой связанного assignment:
 *   • есть сдачи → assignment.status = 'finished' (работы сохраняются);
 *   • нет сдач   → assignment мягко удаляется (deleted_at), файлы остаются до hard-delete.
 * Используется админкой и bulk-операциями, чтобы не оставлять «висящих» активных заданий.
 */
function softDeleteTopic(id) {
  const n = Number(id);
  const topic = db.prepare(
    'SELECT id, assignment_id FROM topics WHERE id = ? AND deleted_at IS NULL'
  ).get(n);
  if (!topic) return { changes: 0, assignmentAction: null };
  let assignmentAction = null;
  if (topic.assignment_id) {
    const hasSubs = db.prepare(
      'SELECT 1 FROM submissions WHERE assignment_id = ? AND deleted_at IS NULL LIMIT 1'
    ).get(topic.assignment_id);
    if (hasSubs) {
      db.prepare("UPDATE assignments SET status = 'finished' WHERE id = ?")
        .run(topic.assignment_id);
      assignmentAction = 'finished';
    } else {
      softDelete('assignments', topic.assignment_id);
      assignmentAction = 'soft_deleted';
    }
  }
  const r = db.prepare(
    'UPDATE topics SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL'
  ).run(n);
  return { changes: r.changes, assignmentAction };
}

function restore(kind, id) {
  const c = configOf(kind);
  try {
    const r = db.prepare(
      `UPDATE ${c.table} SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`
    ).run(Number(id));
    return { changes: r.changes };
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE'
        || /UNIQUE constraint failed/.test(e.message)) {
      return { changes: 0, error: 'unique_conflict' };
    }
    throw e;
  }
}

function canHardDelete(kind, id) {
  const n = Number(id);
  const row = getRow(kind, n);
  if (!row) return { ok: false, reason: 'not_found' };
  if (kind === 'subjects') {
    const blockers = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subject_groups WHERE subject_id = @id) AS subject_groups,
        (SELECT COUNT(*) FROM topics         WHERE subject_id = @id) AS topics,
        (SELECT COUNT(*) FROM assignments    WHERE subject_id = @id) AS assignments,
        (SELECT COUNT(*) FROM submissions s
          JOIN assignments a ON a.id = s.assignment_id
          WHERE a.subject_id = @id) AS submissions
    `).get({ id: n });
    const empty = Object.values(blockers).every((v) => v === 0);
    return { ok: empty, reason: empty ? null : 'not_empty', blockers };
  }
  if (kind === 'assignments') {
    const blockers = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM submissions WHERE assignment_id = @id) AS submissions,
        (SELECT COUNT(*) FROM topics      WHERE assignment_id = @id) AS topics
    `).get({ id: n });
    const empty = Object.values(blockers).every((v) => v === 0);
    return { ok: empty, reason: empty ? null : 'not_empty', blockers };
  }
  if (kind === 'topics') {
    const subs = row.assignment_id
      ? db.prepare(
          'SELECT COUNT(*) AS c FROM submissions WHERE assignment_id = ?'
        ).get(row.assignment_id).c
      : 0;
    const blockers = { submissions_of_assignment: subs };
    const empty = subs === 0;
    return { ok: empty, reason: empty ? null : 'not_empty', blockers };
  }
  if (kind === 'groups') {
    const blockers = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM students            WHERE group_id = @id) AS students,
        (SELECT COUNT(*) FROM teacher_groups      WHERE group_id = @id) AS teacher_groups,
        (SELECT COUNT(*) FROM subject_groups      WHERE group_id = @id) AS subject_groups,
        (SELECT COUNT(*) FROM submissions         WHERE group_id = @id) AS submissions,
        (SELECT COUNT(*) FROM group_threads       WHERE group_id = @id) AS threads,
        (SELECT COUNT(*) FROM group_announcements WHERE group_id = @id) AS announcements
    `).get({ id: n });
    const empty = Object.values(blockers).every((v) => v === 0);
    return { ok: empty, reason: empty ? null : 'not_empty', blockers };
  }
  if (kind === 'teachers') {
    const blockers = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM subjects       WHERE teacher_id = @id) AS subjects,
        (SELECT COUNT(*) FROM assignments    WHERE teacher_id = @id) AS assignments,
        (SELECT COUNT(*) FROM submissions    WHERE teacher_id = @id) AS submissions,
        (SELECT COUNT(*) FROM teacher_groups WHERE teacher_id = @id) AS teacher_groups,
        (SELECT COUNT(*) FROM support_threads WHERE teacher_id = @id) AS support_threads
    `).get({ id: n });
    const empty = Object.values(blockers).every((v) => v === 0);
    return { ok: empty, reason: empty ? null : 'not_empty', blockers };
  }
  if (kind === 'students') {
    const blockers = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM submissions      WHERE student_id = @id) AS submissions,
        (SELECT COUNT(*) FROM support_threads  WHERE student_id = @id) AS support_threads
    `).get({ id: n });
    const empty = Object.values(blockers).every((v) => v === 0);
    return { ok: empty, reason: empty ? null : 'not_empty', blockers };
  }
  if (kind === 'submissions' || kind === 'group_announcements') {
    return { ok: true, reason: null, blockers: {} };
  }
  return { ok: false, reason: 'unsupported_kind' };
}

function storageCleanup() {
  return require('./storage/cleanup');
}

async function safeCleanup(fn) {
  try {
    await fn();
  } catch (e) {
    console.error('[lifecycle] cleanup:', e.message);
  }
}

async function hardDelete(kind, id, opts = {}) {
  const cleanupFiles = opts.cleanupFiles !== false;
  const n = Number(id);
  const row = getRow(kind, n);
  if (!row) return { ok: false, reason: 'not_found' };
  switch (kind) {
    case 'teachers':            return hardDeleteTeacher(n, cleanupFiles);
    case 'students':            return hardDeleteStudent(n, cleanupFiles);
    case 'groups':              return hardDeleteGroup(n, cleanupFiles);
    case 'subjects':            return hardDeleteSubject(n, cleanupFiles);
    case 'assignments':         return hardDeleteAssignment(n, cleanupFiles);
    case 'topics':              return hardDeleteTopic(n, cleanupFiles);
    case 'group_announcements': return hardDeleteAnnouncement(n);
    case 'submissions':         return hardDeleteSubmission(n, cleanupFiles);
    default:                    return { ok: false, reason: 'unsupported_kind' };
  }
}

async function hardDeleteTeacher(id, cleanupFiles) {
  if (cleanupFiles) {
    const { cleanupTeacherFiles } = storageCleanup();
    await safeCleanup(() => cleanupTeacherFiles(db, id));
  }
  db.transaction(() => {
    db.prepare('DELETE FROM submissions WHERE teacher_id = ?').run(id);
    db.prepare('DELETE FROM assignments WHERE teacher_id = ?').run(id);
    db.prepare(`
      DELETE FROM topics
      WHERE subject_id IN (SELECT id FROM subjects WHERE teacher_id = ?)
    `).run(id);
    db.prepare('DELETE FROM subjects WHERE teacher_id = ?').run(id);
    db.prepare('DELETE FROM teachers WHERE id = ?').run(id);
  })();
  return { ok: true };
}

async function hardDeleteStudent(id, cleanupFiles) {
  if (cleanupFiles) {
    const { cleanupStudentFiles } = storageCleanup();
    await safeCleanup(() => cleanupStudentFiles(db, id));
  }
  db.transaction(() => {
    db.prepare('DELETE FROM submissions WHERE student_id = ?').run(id);
    db.prepare('DELETE FROM students WHERE id = ?').run(id);
  })();
  return { ok: true };
}

async function hardDeleteGroup(id, cleanupFiles) {
  // Защита от каскадного удаления студентов и связанных данных.
  const check = canHardDelete('groups', id);
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason === 'not_empty' ? 'not_empty' : (check.reason || 'not_empty'),
      blockers: check.blockers,
    };
  }
  if (cleanupFiles) {
    const { cleanupSubmissionFiles, unlinkQuiet } = storageCleanup();
    const subs = db.prepare('SELECT id FROM submissions WHERE group_id = ?').all(id);
    for (const s of subs) {
      await safeCleanup(() => cleanupSubmissionFiles(db, s.id));
    }
    const msgs = db.prepare(`
      SELECT gm.file_path FROM group_messages gm
      JOIN group_threads gt ON gt.id = gm.thread_id
      WHERE gt.group_id = ? AND gm.file_path IS NOT NULL
    `).all(id);
    for (const m of msgs) {
      await safeCleanup(() => unlinkQuiet(safeJoin(config.STORAGE_DIR, m.file_path)));
    }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM submissions WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  })();
  return { ok: true };
}

async function hardDeleteSubject(id, cleanupFiles) {
  if (cleanupFiles) {
    const {
      cleanupSubmissionFiles, cleanupTopicFiles, cleanupAssignmentFiles,
      cleanupImagesFromHtml, cleanupTopicImages,
    } = storageCleanup();
    const subs = db.prepare(`
      SELECT s.id FROM submissions s
      JOIN assignments a ON a.id = s.assignment_id
      WHERE a.subject_id = ?
    `).all(id);
    for (const s of subs) {
      await safeCleanup(() => cleanupSubmissionFiles(db, s.id));
    }
    const topics = db.prepare(
      'SELECT id, description FROM topics WHERE subject_id = ?'
    ).all(id);
    for (const t of topics) {
      await safeCleanup(() => cleanupTopicFiles(db, t.id));
      await safeCleanup(() => cleanupImagesFromHtml(t.description));
    }
    const asg = db.prepare('SELECT id FROM assignments WHERE subject_id = ?').all(id);
    for (const a of asg) {
      await safeCleanup(() => cleanupAssignmentFiles(db, a.id));
    }
    await safeCleanup(() => cleanupTopicImages(db, id));
  }
  db.transaction(() => {
    db.prepare(`
      DELETE FROM submissions
      WHERE assignment_id IN (SELECT id FROM assignments WHERE subject_id = ?)
    `).run(id);
    db.prepare('DELETE FROM assignments WHERE subject_id = ?').run(id);
    db.prepare('DELETE FROM topics WHERE subject_id = ?').run(id);
    db.prepare('DELETE FROM subjects WHERE id = ?').run(id);
  })();
  return { ok: true };
}

async function hardDeleteAssignment(id, cleanupFiles) {
  if (cleanupFiles) {
    const { cleanupSubmissionFiles, cleanupAssignmentFiles } = storageCleanup();
    const subs = db.prepare('SELECT id FROM submissions WHERE assignment_id = ?').all(id);
    for (const s of subs) {
      await safeCleanup(() => cleanupSubmissionFiles(db, s.id));
    }
    await safeCleanup(() => cleanupAssignmentFiles(db, id));
  }
  db.transaction(() => {
    db.prepare('DELETE FROM submissions WHERE assignment_id = ?').run(id);
    db.prepare('DELETE FROM assignments WHERE id = ?').run(id);
  })();
  return { ok: true };
}

async function hardDeleteTopic(id, cleanupFiles) {
  const row = db.prepare(
    'SELECT id, description, assignment_id FROM topics WHERE id = ?'
  ).get(id);
  if (!row) return { ok: false, reason: 'not_found' };
  const hasSubs = row.assignment_id
    ? !!db.prepare(
        'SELECT 1 FROM submissions WHERE assignment_id = ? LIMIT 1'
      ).get(row.assignment_id)
    : false;
  if (cleanupFiles) {
    const {
      cleanupTopicFiles, cleanupImagesFromHtml, cleanupAssignmentFiles,
    } = storageCleanup();
    await safeCleanup(() => cleanupImagesFromHtml(row.description));
    if (row.assignment_id && !hasSubs) {
      await safeCleanup(() => cleanupAssignmentFiles(db, row.assignment_id));
    }
    await safeCleanup(() => cleanupTopicFiles(db, id));
  }
  db.transaction(() => {
    if (row.assignment_id) {
      if (hasSubs) {
        db.prepare(
          "UPDATE assignments SET status = 'finished' WHERE id = ?"
        ).run(row.assignment_id);
      } else {
        db.prepare('DELETE FROM assignments WHERE id = ?').run(row.assignment_id);
      }
    }
    db.prepare('DELETE FROM topics WHERE id = ?').run(id);
  })();
  return { ok: true };
}

async function hardDeleteAnnouncement(id) {
  db.prepare('DELETE FROM group_announcements WHERE id = ?').run(id);
  return { ok: true };
}

async function hardDeleteSubmission(id, cleanupFiles) {
  if (cleanupFiles) {
    const { cleanupSubmissionFiles } = storageCleanup();
    await safeCleanup(() => cleanupSubmissionFiles(db, id));
  }
  db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
  return { ok: true };
}

module.exports = {
  KINDS,
  getRow,
  isActive, isFinished, isDeleted,
  setStatus,
  softDelete, softDeleteTopic, restore, hardDelete,
  canHardDelete,
};