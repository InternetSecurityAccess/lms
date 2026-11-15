'use strict';
const db = require('../database');

function destroyAndRedirect(req, res, to) {
  return req.session.destroy(() => res.redirect(to));
}

/* ═══════════════════════════════════════════════════════════
   loadCurrentUser

   Модель B для группы: finished = readonly, не destroy.
   Destroy-им только реально «мёртвые» сессии:
     • удалённый студент (deleted_at);
     • rejected-заявка;
     • группа в корзине (deleted_at) — «её нет».
   Студент finished-группы заходит, видит историю, но писать
   и сдавать не может (это блокируется в readonly-проверках
   роутов и в isSubmissionReadonly).
   ═══════════════════════════════════════════════════════════ */
module.exports = function loadCurrentUser(req, res, next) {
  if (req.session?.adminId) {
    const a = db.prepare('SELECT id, session_version FROM admins WHERE id = ?')
      .get(req.session.adminId);
    if (!a || a.session_version !== req.session.sessionVersion) {
      return destroyAndRedirect(req, res, '/admin/login');
    }
    return next();
  }

  if (req.session?.teacherId) {
    const t = db.prepare(
      'SELECT id, status, deleted_at, session_version, must_change_password '
      + 'FROM teachers WHERE id = ?'
    ).get(req.session.teacherId);
    if (!t
        || t.deleted_at
        || t.status !== 'active'
        || t.session_version !== req.session.sessionVersion) {
      return destroyAndRedirect(req, res, '/login');
    }
    req.currentTeacher = t;
    return next();
  }

  if (req.session?.studentId) {
    const s = db.prepare(`
      SELECT s.id, s.status, s.deleted_at, s.approved_at, s.rejection_reason,
             s.session_version, s.must_change_password, s.group_id,
             g.status AS group_status, g.deleted_at AS group_deleted_at
      FROM students s
      LEFT JOIN groups g ON g.id = s.group_id
      WHERE s.id = ?
    `).get(req.session.studentId);

    // rejected / deleted / группа в корзине / version — destroy.
    // group_status='finished' — НЕ destroy (readonly).
    const shouldDrop = !s
      || s.deleted_at
      || s.status === 'rejected'
      || s.group_deleted_at
      || s.session_version !== req.session.sessionVersion;

    if (shouldDrop) {
      return destroyAndRedirect(req, res, '/login');
    }
    req.currentStudent = s;
    return next();
  }

  return next();
};