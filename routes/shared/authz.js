'use strict';
const db = require('../../database');

/* ═══════════════════════════════════════════════════════════
   Правило 401 / 404 / 403 для защищённого контента
   401 Unauthorized — нет сессии вообще.
   404 — «не твоё» / «скрыто»:
       • deleted_at IS NOT NULL (корзина);
       • rejected / must_change_password;
       • тема/задание в draft (для студента);
       • группа в корзине.
   403 — «знает о существовании, но действие запрещено»:
       • писать в чат принятой / readonly работы;
       • не-подписаный препод управляет группой.
   ═══════════════════════════════════════════════════════════ */

const isAdmin = (req) => !!req.session?.adminId;
const isTeacher = (req) => !!req.session?.teacherId;
const isStudent = (req) => !!req.session?.studentId;
const currentRole = (req) =>
  isAdmin(req) ? 'admin'
    : isTeacher(req) ? 'teacher'
      : isStudent(req) ? 'student'
        : 'guest';

function checkAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.redirect('/admin/login');
}
function checkTeacher(req, res, next) {
  if (isAdmin(req)) return res.redirect('/admin');
  if (isStudent(req)) return res.redirect('/my-teachers');
  if (!isTeacher(req)) return res.redirect('/login');
  const t = req.currentTeacher;
  if (t && Number(t.must_change_password) === 1) {
    const allowed = ['/change-password-required', '/logout'];
    if (!allowed.includes(req.path)) return res.redirect('/change-password-required');
  }
  next();
}
function checkStudent(req, res, next) {
  if (isAdmin(req)) return res.redirect('/admin');
  if (isTeacher(req)) return res.redirect('/my-groups');
  if (!isStudent(req)) return res.redirect('/login');
  const s = req.currentStudent;
  if (!s) return req.session.destroy(() => res.redirect('/login'));
  if (s.deleted_at || s.status === 'rejected') {
    return req.session.destroy(() => res.redirect('/login'));
  }
  if (s.group_deleted_at) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  if (!s.approved_at) {
    const allowed = ['/pending-approval', '/logout', '/support',
      '/support/messages.json', '/support/upload-image'];
    if (!allowed.includes(req.path)) return res.redirect('/pending-approval');
    return next();
  }
  if (s.must_change_password === 1) {
    const allowed = ['/change-password-required', '/logout'];
    if (!allowed.includes(req.path)) return res.redirect('/change-password-required');
  }
  return next();
}
function checkStudentOrSkip(req, res, next) {
  if (isAdmin(req) || isTeacher(req)) return next('route');
  return checkStudent(req, res, next);
}

/* ═══════════════════════════════════════════════════════════
   canAccessProtectedContent — для routes/files.js.
   ═══════════════════════════════════════════════════════════ */
function canAccessProtectedContent(req) {
  if (isAdmin(req)) return true;
  if (isTeacher(req)) {
    const t = req.currentTeacher;
    if (!t) return false;
    if (t.deleted_at || t.status !== 'active') return false;
    if (Number(t.must_change_password) === 1) return false;
    return true;
  }
  if (!isStudent(req) || !req.currentStudent) return false;
  const s = req.currentStudent;
  if (s.deleted_at) return false;
  if (s.status === 'rejected') return false;
  if (s.group_deleted_at) return false;
  return !!s.approved_at
    && Number(s.must_change_password) !== 1;
}

const isOwnerStudent = (req, sub) =>
  isStudent(req) && Number(req.session.studentId) === Number(sub.student_id);
const isAddresseeTeacher = (req, sub) =>
  isTeacher(req) && Number(req.session.teacherId) === Number(sub.teacher_id);
const isTeacherOfGroup = (req, groupId) =>
  isTeacher(req) && !!db.prepare(
    'SELECT 1 FROM teacher_groups WHERE teacher_id = ? AND group_id = ?'
  ).get(req.session.teacherId, groupId);
const isStudentOfGroup = (req, groupId) => {
  if (!isStudent(req)) return false;
  const g = db.prepare(
    'SELECT deleted_at FROM groups WHERE id = ?'
  ).get(groupId);
  if (!g || g.deleted_at) return false;
  return !!db.prepare(
    'SELECT 1 FROM students WHERE id = ? AND group_id = ?'
  ).get(req.session.studentId, groupId);
};

/**
 * isStudentOfSubject — «студент имеет право видеть содержимое предмета».
 *
 * True, если:
 *   • есть активная связь (subject_groups) — обычный доступ;
 *   • есть история (subject_groups_history) — readonly-доступ;
 *   • есть сдача по этому предмету — readonly-доступ (legacy).
 *
 * False, если:
 *   • предмет или преподаватель в корзине / не active;
 *   • группа студента в корзине;
 *   • нет ни активной связи, ни истории, ни сдач.
 */
const isStudentOfSubject = (req, subjectId) => {
  if (!isStudent(req)) return false;
  const s = req.currentStudent;
  if (!s) return false;
  if (s.deleted_at || s.status === 'rejected') return false;
  if (s.group_deleted_at) return false;
  const subject = db.prepare(`
    SELECT s.id, s.deleted_at,
           t.status AS teacher_status, t.deleted_at AS teacher_deleted_at
    FROM subjects s
    JOIN teachers t ON t.id = s.teacher_id
    WHERE s.id = ?
  `).get(subjectId);
  if (!subject || subject.deleted_at || subject.teacher_deleted_at) return false;
  const activePair = !!db.prepare(
    'SELECT 1 FROM subject_groups WHERE subject_id = ? AND group_id = ?'
  ).get(subjectId, s.group_id);
  if (activePair) return true;
  const historyPair = !!db.prepare(
    'SELECT 1 FROM subject_groups_history WHERE subject_id = ? AND group_id = ? LIMIT 1'
  ).get(subjectId, s.group_id);
  if (historyPair) return true;
  return !!db.prepare(`
    SELECT 1 FROM submissions s2
    JOIN assignments a ON a.id = s2.assignment_id
    WHERE a.subject_id = ? AND s2.student_id = ? AND s2.deleted_at IS NULL
    LIMIT 1
  `).get(subjectId, s.id);
};

module.exports = {
  isAdmin, isTeacher, isStudent, currentRole,
  checkAdmin, checkTeacher, checkStudent, checkStudentOrSkip,
  canAccessProtectedContent,
  isOwnerStudent, isAddresseeTeacher,
  isTeacherOfGroup, isStudentOfGroup, isStudentOfSubject,
};