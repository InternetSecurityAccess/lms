// routes/admin/system-sessions.js
'use strict';
/**
 * Реестр активных сессий (рефакторинг system.js).
 * Логика перенесена дословно, без изменения поведения.
 */
const db = require('../../database');

const ROLE_TABLE = { admin: 'admins', teacher: 'teachers', student: 'students' };
function loadSessionItems() {
  const rows = db.prepare(
    'SELECT sid, sess, expire FROM sessions WHERE expire > ? ORDER BY expire DESC'
  ).all(Date.now());
  const items = [];
  for (const row of rows) {
    let sess = null;
    try { sess = JSON.parse(row.sess); } catch { /* ignore */ }
    if (!sess) continue;
    let role = null, userId = null, userName = null, userLogin = null;
    let currentVersion = null;
    if (sess.adminId) {
      role = 'admin'; userId = sess.adminId;
      const u = db.prepare('SELECT name, session_version FROM admins WHERE id = ?').get(userId);
      userName = u?.name; userLogin = u?.name; currentVersion = u?.session_version;
    } else if (sess.teacherId) {
      role = 'teacher'; userId = sess.teacherId;
      const u = db.prepare(
        'SELECT name, login, status, deleted_at, session_version FROM teachers WHERE id = ?'
      ).get(userId);
      userName = u?.name; userLogin = u?.login; currentVersion = u?.session_version;
      if (!u || u.deleted_at || u.status !== 'active') {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
        continue;
      }
    } else if (sess.studentId) {
      role = 'student'; userId = sess.studentId;
      const u = db.prepare(
        'SELECT name, login, status, deleted_at, session_version FROM students WHERE id = ?'
      ).get(userId);
      userName = u?.name; userLogin = u?.login; currentVersion = u?.session_version;
      if (!u || u.deleted_at || u.status === 'rejected') {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
        continue;
      }
    }
    if (!role) continue;
    if (currentVersion == null || Number(sess.sessionVersion) !== Number(currentVersion)) {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
      continue;
    }
    items.push({
      sid: row.sid, sidShort: row.sid.slice(0, 12) + '…',
      expire: row.expire, role, userId,
      userName: userName || '—', userLogin: userLogin || '',
      sessionVersion: sess.sessionVersion || null,
    });
  }
  return items;
}

module.exports = { ROLE_TABLE, loadSessionItems };
