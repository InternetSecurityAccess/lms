// routes/shared/profile.js
'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../../database');
const config = require('../../config');
const { handler, renderWith } = require('./handlers');
const { validatePassword } = require('../../utils/password-policy');
const { bumpSessionVersion } = require('../../utils/sessions');
const { sanitizeMaxUrlOrNull } = require('../../utils/validation');
const { audit } = require('../../utils/audit');

function profileView(role) {
  return role === 'teacher' ? 'teacher/account' : 'student/account';
}
function forcedView(role) {
  return role === 'teacher'
    ? 'teacher/messages/change-password-required'
    : 'student/messages/change-password-required';
}
function tableOf(role) {
  return role === 'teacher' ? 'teachers' : 'students';
}
function homeOf(role) {
  return role === 'teacher' ? '/my-groups' : '/my-teachers';
}
function profileLocals(req, overrides = {}) {
  const role = req._profileRole;
  const base = {
    title: 'Профиль',
    me: req.me,
    role,
    error: null,
    success: null,
    maxError: null,
    maxSuccess: null,
    studentLoginType: config.STUDENT_LOGIN_TYPE,
  };
  return { ...base, ...overrides };
}
function forcedLocals(req, overrides = {}) {
  return { title: 'Смена пароля', error: null, ...overrides };
}

/**
 * Загружаем профиль вместе с зависимостями.
 *   teacher: все поля teachers.
 *   student: все поля students + group_name / group_status из groups —
 *            иначе в профиле нечего показать в блоке «Группа».
 */
function loadProfileRow(role, id) {
  if (role === 'student') {
    return db.prepare(`
      SELECT s.*, g.name AS group_name, g.status AS group_status
      FROM students s
      LEFT JOIN groups g ON g.id = s.group_id
      WHERE s.id = ? AND s.deleted_at IS NULL
    `).get(id);
  }
  const table = tableOf(role);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id);
}

function loadProfileUser(req, res, next) {
  if (req.session?.adminId) return res.redirect('/admin/profile');
  let role = null;
  let id = null;
  if (req.session?.teacherId) { role = 'teacher'; id = req.session.teacherId; }
  else if (req.session?.studentId) { role = 'student'; id = req.session.studentId; }
  if (!role) return res.redirect('/login');
  const row = loadProfileRow(role, id);
  if (!row) return req.session.destroy(() => res.redirect('/login'));
  if (Number(row.must_change_password) === 1) {
    return res.redirect('/change-password-required');
  }
  if (role === 'student' && !row.approved_at) {
    return res.redirect('/pending-approval');
  }
  req._profileRole = role;
  req.me = row;
  next();
}

function loadForcedChangeUser(req, res, next) {
  if (req.session?.adminId) return res.redirect('/admin/profile');
  let role = null;
  let id = null;
  if (req.session?.teacherId) { role = 'teacher'; id = req.session.teacherId; }
  else if (req.session?.studentId) { role = 'student'; id = req.session.studentId; }
  if (!role) return res.redirect('/login');
  const row = loadProfileRow(role, id);
  if (!row) return req.session.destroy(() => res.redirect('/login'));
  if (Number(row.must_change_password) !== 1) {
    return res.redirect(homeOf(role));
  }
  req._profileRole = role;
  req.me = row;
  next();
}

router.get('/my-profile', loadProfileUser, (req, res) => {
  return renderWith(res, profileView(req._profileRole), profileLocals(req));
});

router.post('/my-profile/change-password', loadProfileUser, handler(async (req, res) => {
  const me = req.me;
  const role = req._profileRole;
  const view = profileView(role);
  const oldPassword = String(req.body.old_password || '');
  const newPassword = String(req.body.new_password || '');
  const renderErr = (err) => res.status(400).render(view, profileLocals(req, { error: err }));
  if (!oldPassword || !newPassword) return renderErr('Заполните все поля.');
  if (oldPassword === newPassword) return renderErr('Новый пароль должен отличаться от текущего.');
  const valid = await bcrypt.compare(oldPassword, me.password_hash);
  if (!valid) return renderErr('Неверный текущий пароль.');
  const policyErrors = validatePassword(newPassword, { login: me.login });
  if (policyErrors.length > 0) return renderErr(policyErrors.join(' '));
  const hash = await bcrypt.hash(newPassword, 10);
  const table = tableOf(role);
  db.prepare(
    `UPDATE ${table} SET password_hash = ?, must_change_password = 0 WHERE id = ? AND deleted_at IS NULL`
  ).run(hash, me.id);
  bumpSessionVersion(table, me.id);
  const updated = db.prepare(`SELECT session_version FROM ${table} WHERE id = ?`).get(me.id);
  if (updated) req.session.sessionVersion = updated.session_version;
  return renderWith(res, view, profileLocals(req, {
    success: 'Пароль изменён. Остальные сессии завершены.',
  }));
}));

router.post('/my-profile/update-max', (req, res, next) => {
  if (req.session?.adminId) return res.redirect('/admin/profile');
  if (req.session?.studentId) return res.redirect('/my-profile');
  if (!req.session?.teacherId) return res.redirect('/login');
  next();
}, loadProfileUser, handler((req, res) => {
  if (req._profileRole !== 'teacher') return res.redirect('/my-profile');
  const me = req.me;
  const raw = String(req.body.max_url || '').trim().slice(0, 500);
  const maxUrl = sanitizeMaxUrlOrNull(raw);
  if (raw && !maxUrl) {
    return res.status(400).render('teacher/account', profileLocals(req, {
      me: { ...me, max_url: raw },
      maxError: 'Ссылка должна быть вида https://max.ru/...',
    }));
  }
  db.prepare(
    'UPDATE teachers SET max_url = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(maxUrl, me.id);
  audit(req, 'teacher.update_max', 'teacher', me.id, { max_url: maxUrl });
  const msg = maxUrl ? 'Ссылка на канал MAX сохранена.' : 'Ссылка на канал MAX удалена.';
  return renderWith(res, 'teacher/account', profileLocals(req, {
    me: { ...me, max_url: maxUrl },
    maxSuccess: msg,
  }));
}));

router.get('/change-password-required', loadForcedChangeUser, (req, res) => {
  return renderWith(res, forcedView(req._profileRole), forcedLocals(req));
});

router.post('/change-password-required', loadForcedChangeUser, handler(async (req, res) => {
  const me = req.me;
  const role = req._profileRole;
  const view = forcedView(role);
  const newPassword = String(req.body.new_password || '');
  const confirmPassword = String(req.body.confirm_password || '');
  const renderErr = (err) => res.status(400).render(view, forcedLocals(req, { error: err }));
  if (!newPassword || !confirmPassword) return renderErr('Заполните оба поля.');
  if (newPassword !== confirmPassword) return renderErr('Пароли не совпадают.');
  const policyErrors = validatePassword(newPassword, { login: me.login });
  if (policyErrors.length > 0) return renderErr(policyErrors.join(' '));
  const same = await bcrypt.compare(newPassword, me.password_hash);
  if (same) return renderErr('Новый пароль должен отличаться от текущего.');
  const hash = await bcrypt.hash(newPassword, 10);
  const table = tableOf(role);
  db.prepare(
    `UPDATE ${table} SET password_hash = ?, must_change_password = 0 WHERE id = ? AND deleted_at IS NULL`
  ).run(hash, me.id);
  if (role === 'teacher') {
    bumpSessionVersion('teachers', me.id);
    const updated = db.prepare('SELECT session_version FROM teachers WHERE id = ?').get(me.id);
    if (updated) req.session.sessionVersion = updated.session_version;
  }
  req.session.mustChangePassword = false;
  return res.redirect(homeOf(role));
}));

module.exports = router;