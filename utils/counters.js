'use strict';
const db = require('../database');
let chat = null;
try {
  chat = require('../routes/shared/chat');
} catch {
  console.warn('[counters] routes/shared/chat.js ещё не создан — групповые счётчики = 0');
}
const COUNTERS_TTL_MS = 10_000;
const _cache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (v.exp <= now) _cache.delete(k);
  }
}, 5 * 60 * 1000).unref();
function countUnreadForTeacher(teacherId) {
  if (!chat) return 0;
  try { return chat.countUnreadForTeacher(teacherId); }
  catch { return 0; }
}
function countUnreadForStudent(studentId) {
  if (!chat) return 0;
  try { return chat.countUnreadForStudent(studentId); }
  catch { return 0; }
}
function computeCounters(session) {
  const out = {
    inboxCount: 0,
    supportUnreadCount: 0,
    groupChatUnread: 0,
    announcementsUnread: 0,
    pendingApprovals: 0,
  };
  if (!session) return out;

  if (session.studentId) {
    let s = null;
    try {
      s = db.prepare(`
        SELECT s.approved_at, s.status, s.deleted_at,
               g.status AS group_status, g.deleted_at AS group_deleted_at
        FROM students s
        LEFT JOIN groups g ON g.id = s.group_id
        WHERE s.id = ?
      `).get(session.studentId);
    } catch { return out; }

    // Нет доступа вообще: удалён или отклонён.
    if (!s || s.deleted_at || s.status === 'rejected') return out;

    // Заявка на рассмотрении: доступна только поддержка.
    if (!s.approved_at) {
      try {
        const r = db.prepare(`
          SELECT COUNT(*) AS c FROM support_messages m
          JOIN support_threads t ON t.id = m.thread_id
          WHERE t.student_id = ?
            AND m.sender_type = 'admin' AND m.is_read = 0
            AND m.deleted_at IS NULL
        `).get(session.studentId);
        out.supportUnreadCount = Number(r.c || 0);
      } catch { /* ignore */ }
      return out;
    }

    // Подтверждён (в т.ч. finished-группа — readonly, но чтение доступно).
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS quiz_attempt_reads (
          attempt_id   INTEGER NOT NULL,
          reader_type  TEXT    NOT NULL DEFAULT 'student',
          reader_id    INTEGER NOT NULL,
          read_passed  INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (attempt_id, reader_type, reader_id, read_passed)
        )
      `);
      const r = db.prepare(`
        SELECT COUNT(*) AS c FROM submissions s
        JOIN teachers t ON t.id = s.teacher_id
        JOIN groups g ON g.id = s.group_id
        JOIN assignments a ON a.id = s.assignment_id
        JOIN subjects sj ON sj.id = a.subject_id
        WHERE s.student_id = @sid AND s.deleted_at IS NULL
          AND a.status = 'active' AND a.deleted_at IS NULL
          AND sj.status = 'active' AND sj.deleted_at IS NULL
          AND t.status = 'active' AND t.deleted_at IS NULL
          AND g.deleted_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM messages m
              WHERE m.submission_id = s.id
                AND m.sender_type = 'teacher' AND m.is_read = 0
                AND m.deleted_at IS NULL)
            OR (
              s.status IN ('accepted','rejected')
              AND NOT EXISTS (
                SELECT 1 FROM submission_status_reads r
                WHERE r.submission_id = s.id
                  AND r.reader_type = 'student' AND r.reader_id = @sid
                  AND r.read_status = s.status
              )
            )
            OR (s.ai_flag = 1 AND s.ai_flag_read_by_student = 0)
          )
      `).get({ sid: session.studentId });
      out.inboxCount = Number(r.c || 0);
    } catch { /* ignore */ }

    // Уведомления о результатах тестов (непрочитанные завершённые попытки).
    try {
      const rq = db.prepare(`
        SELECT COUNT(*) AS c FROM quiz_attempts qa
        JOIN topics t ON t.id = (
          SELECT tt.id FROM topics tt
          WHERE tt.quiz_id = qa.quiz_id AND tt.deleted_at IS NULL
          ORDER BY tt.position, tt.id LIMIT 1
        )
        JOIN subjects sj ON sj.id = t.subject_id
          AND sj.status = 'active' AND sj.deleted_at IS NULL
        WHERE qa.student_id = ?
          AND qa.status != 'in_progress'
          AND qa.finished_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM quiz_attempt_reads r
            WHERE r.attempt_id = qa.id
              AND r.reader_type = 'student' AND r.reader_id = ?
              AND r.read_passed = qa.passed
          )
      `).get(session.studentId, session.studentId);
      out.inboxCount += Number(rq.c || 0);
    } catch { /* ignore */ }

    out.groupChatUnread = countUnreadForStudent(session.studentId);

    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS c FROM group_announcements a
        JOIN students s ON s.group_id = a.group_id AND s.id = ?
        WHERE a.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM group_announcement_reads r
            WHERE r.announcement_id = a.id AND r.student_id = ?
          )
      `).get(session.studentId, session.studentId);
      out.announcementsUnread = Number(r.c || 0);
    } catch { /* ignore */ }

    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS c FROM support_messages m
        JOIN support_threads t ON t.id = m.thread_id
        WHERE t.student_id = ?
          AND m.sender_type = 'admin' AND m.is_read = 0
          AND m.deleted_at IS NULL
      `).get(session.studentId);
      out.supportUnreadCount = Number(r.c || 0);
    } catch { /* ignore */ }

    return out;
  }

  if (session.teacherId) {
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS c FROM submissions s
        JOIN assignments a ON a.id = s.assignment_id
        JOIN subjects sj ON sj.id = a.subject_id
        JOIN groups g ON g.id = s.group_id
        WHERE s.teacher_id = @tid AND s.deleted_at IS NULL
          AND sj.status = 'active' AND sj.deleted_at IS NULL
          AND g.deleted_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM messages m
              WHERE m.submission_id = s.id
                AND m.sender_type = 'student' AND m.is_read = 0
                AND m.deleted_at IS NULL)
            OR (
              s.status = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM submission_status_reads r
                WHERE r.submission_id = s.id
                  AND r.reader_type = 'teacher' AND r.reader_id = @tid
                  AND r.read_status = 'pending'
              )
            )
          )
      `).get({ tid: session.teacherId });
      out.inboxCount = Number(r.c || 0);
    } catch { /* ignore */ }

    out.groupChatUnread = countUnreadForTeacher(session.teacherId);

    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS c FROM support_messages m
        JOIN support_threads t ON t.id = m.thread_id
        WHERE t.teacher_id = ?
          AND m.sender_type = 'admin' AND m.is_read = 0
          AND m.deleted_at IS NULL
      `).get(session.teacherId);
      out.supportUnreadCount = Number(r.c || 0);
    } catch { /* ignore */ }

    return out;
  }

  if (session.adminId) {
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS c FROM support_threads st
        WHERE EXISTS (
          SELECT 1 FROM support_messages m
          WHERE m.thread_id = st.id
            AND m.sender_type = 'user' AND m.is_read = 0
            AND m.deleted_at IS NULL
        )
      `).get();
      out.supportUnreadCount = Number(r.c || 0);
    } catch { /* ignore */ }

    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS c FROM students s
        JOIN groups g ON g.id = s.group_id
        WHERE s.approved_at IS NULL
          AND s.status = 'active'
          AND s.deleted_at IS NULL
          AND g.status = 'active'
          AND g.deleted_at IS NULL
      `).get();
      out.pendingApprovals = Number(r.c || 0);
    } catch { /* ignore */ }

    return out;
  }

  return out;
}
function getCountersCached(session, sessionID) {
  if (!session) return computeCounters(null);
  if (!sessionID) return computeCounters(session);
  const now = Date.now();
  const hit = _cache.get(sessionID);
  if (hit && hit.exp > now) return hit.value;
  const value = computeCounters(session);
  _cache.set(sessionID, { exp: now + COUNTERS_TTL_MS, value });
  return value;
}
function invalidateCounters(sessionID) {
  if (sessionID) _cache.delete(sessionID);
}
function setCountersCache(sessionID, value) {
  if (!sessionID) return;
  _cache.set(sessionID, { exp: Date.now() + COUNTERS_TTL_MS, value });
}
module.exports = {
  computeCounters,
  getCountersCached,
  invalidateCounters,
  setCountersCache,
  COUNTERS_TTL_MS,
};