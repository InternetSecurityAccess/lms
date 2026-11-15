'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../../database');
const config = require('../../config');
const { checkAdmin } = require('../shared/authz');
const {
  handler, renderWith, parseIdOr404, notFound, audit,
  redirectWith, appendQuery,
} = require('../shared/handlers');
const { pickStr, pickInt } = require('../shared/form');
const { normalizeSort, paginate } = require('../shared/lists');
const { composeName } = require('../../utils/names');
const { randomNumericPassword, MIN_LENGTH } = require('../../utils/password-policy');
const { bumpSessionVersion } = require('../../utils/sessions');
const { safeRedirect } = require('../../utils/helpers');
const lifecycle = require('../../utils/lifecycle');
const {
  validateTeacherLogin, normalizeTeacherLogin,
  validateStudentLoginAuto, normalizeStudentLoginAuto,
  validateStudentLoginByType, normalizeStudentLoginByType,
} = require('../../utils/login-validation');
const PAGE_SIZE = 100;
function loadGroups() {
  return db.prepare(
    "SELECT id, name FROM groups WHERE status='active' AND deleted_at IS NULL ORDER BY name"
  ).all();
}
function defaultLoginType() {
  return config.STUDENT_LOGIN_TYPE === 'email' ? 'email' : 'student_id';
}
function normalizeStatusFilter(v) {
  return ['active', 'finished', 'all'].includes(v) ? v : 'active';
}
/* ═══════════════════════════════════════════════════════════
   ПРЕПОДАВАТЕЛИ
   ═══════════════════════════════════════════════════════════ */
router.get(
  '/admin/teachers',
  checkAdmin,
  handler((req, res) => {
    const q = pickStr(req.query.q, 100);
    const status = normalizeStatusFilter(req.query.status);
    const hasGroups = ['none', 'yes'].includes(req.query.has_groups) ? req.query.has_groups : '';
    const sort = normalizeSort(req.query.sort, ['name_asc', 'name_desc', 'date_desc', 'date_asc']);
    let where = ' WHERE t.deleted_at IS NULL';
    const params = {};
    if (status === 'active') where += " AND t.status='active'";
    else if (status === 'finished') where += " AND t.status='finished'";
    if (q) { where += ' AND (t.name LIKE @q OR t.login LIKE @q)'; params.q = `%${q}%`; }
    if (hasGroups === 'none') where += ' AND (SELECT COUNT(*) FROM teacher_groups WHERE teacher_id = t.id) = 0';
    else if (hasGroups === 'yes') where += ' AND (SELECT COUNT(*) FROM teacher_groups WHERE teacher_id = t.id) > 0';
    const orderBy = sort === 'name_desc' ? 't.name DESC'
      : sort === 'date_desc' ? 't.created_at DESC'
      : sort === 'date_asc' ? 't.created_at ASC'
      : 't.name ASC';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM teachers t ${where}`).get(params).c;
    const pg = paginate(req.query.page, total, PAGE_SIZE);
    const teachers = db.prepare(`
      SELECT t.*,
        (SELECT COUNT(*) FROM teacher_groups WHERE teacher_id = t.id) AS groups_count,
        (SELECT COUNT(*) FROM submissions
          WHERE teacher_id = t.id AND deleted_at IS NULL) AS works_count
      FROM teachers t
      ${where}
      ORDER BY (t.status = 'active') DESC, ${orderBy}
      LIMIT ${pg.limit} OFFSET ${pg.offset}
    `).all(params);
    const counts = {
      active: db.prepare("SELECT COUNT(*) AS c FROM teachers WHERE status='active' AND deleted_at IS NULL").get().c,
      finished: db.prepare("SELECT COUNT(*) AS c FROM teachers WHERE status='finished' AND deleted_at IS NULL").get().c,
    };
    const createdTeacher = req.session.flashCreatedTeacher || null;
    if (createdTeacher) delete req.session.flashCreatedTeacher;
    return renderWith(res, 'admin/people/teachers', {
      title: 'Преподаватели',
      teachers, q, status, hasGroups, sort, counts,
      minPasswordLen: MIN_LENGTH,
      error: null,
      createdTeacher,
      deletedDone: req.query.deleted === '1',
      page: pg.page, pages: pg.pages, total, PAGE_SIZE,
    });
  })
);
router.post(
  '/admin/teachers',
  checkAdmin,
  handler(async (req, res) => {
    const login = normalizeTeacherLogin(pickStr(req.body.login, 200));
    const last_name = pickStr(req.body.last_name, 100);
    const first_name = pickStr(req.body.first_name, 100);
    const middle_name = pickStr(req.body.middle_name, 100);
    const name = composeName(last_name, first_name, middle_name);
    const loginErr = validateTeacherLogin(login);
    if (loginErr) return res.status(400).render('common/error', { title: 'Ошибка', message: loginErr });
    if (!last_name) return res.status(400).render('common/error', { title: 'Ошибка', message: 'Укажите фамилию.' });
    if (!first_name) return res.status(400).render('common/error', { title: 'Ошибка', message: 'Укажите имя.' });
    if (db.prepare('SELECT id FROM teachers WHERE login = ? AND deleted_at IS NULL').get(login)) {
      return res.status(400).render('common/error', {
        title: 'Ошибка', message: 'Преподаватель с таким email уже существует.',
      });
    }
    const password = randomNumericPassword(8);
    const hash = await bcrypt.hash(password, 10);
    const r = db.prepare(`
      INSERT INTO teachers
        (name, last_name, first_name, middle_name, login, password_hash,
         must_change_password, status)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'active')
    `).run(name, last_name, first_name, middle_name, login, hash);
    const newId = Number(r.lastInsertRowid);
    audit(req, 'teacher.create', 'teacher', newId, { login, must_change_password: 1 });
    req.session.flashCreatedTeacher = { name, login, password, digits: 8 };
    return req.session.save((err) => {
      if (err) console.error('[admin/teachers] session.save:', err.message);
      return res.redirect('/admin/teachers');
    });
  })
);
router.post(
  '/admin/teachers/:id/change-name',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const last_name = pickStr(req.body.last_name, 100);
    const first_name = pickStr(req.body.first_name, 100);
    const middle_name = pickStr(req.body.middle_name, 100);
    const redirectTo = safeRedirect(req.body.redirect, '/admin/teachers');
    if (!last_name) return res.status(400).render('common/error', { title: 'Ошибка', message: 'Фамилия не может быть пустой.' });
    if (!first_name) return res.status(400).render('common/error', { title: 'Ошибка', message: 'Имя не может быть пустым.' });
    const name = composeName(last_name, first_name, middle_name);
    const result = db.prepare(`
      UPDATE teachers
      SET name = ?, last_name = ?, first_name = ?, middle_name = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(name, last_name, first_name, middle_name, id);
    if (result.changes === 0) return notFound(res, 'Преподаватель не найден.');
    audit(req, 'teacher.change_name', 'teacher', id, { name });
    return res.redirect(redirectTo);
  })
);
router.post(
  '/admin/teachers/:id/change-login',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const login = normalizeTeacherLogin(pickStr(req.body.login, 200));
    const redirectTo = safeRedirect(req.body.redirect, '/admin/teachers');
    const loginErr = validateTeacherLogin(login);
    if (loginErr) return res.status(400).render('common/error', { title: 'Ошибка', message: loginErr });
    const other = db.prepare(
      'SELECT id FROM teachers WHERE login = ? AND id <> ? AND deleted_at IS NULL'
    ).get(login, id);
    if (other) return res.status(400).render('common/error', { title: 'Ошибка', message: 'Этот email уже занят.' });
    db.prepare('UPDATE teachers SET login = ? WHERE id = ? AND deleted_at IS NULL').run(login, id);
    bumpSessionVersion('teachers', id);
    audit(req, 'teacher.change_login', 'teacher', id, { login });
    return res.redirect(redirectTo);
  })
);
router.post(
  '/admin/teachers/:id/reset-password',
  checkAdmin,
  handler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ ok: false, error: 'bad_id', message: 'Некорректный id.' });
    }
    const teacher = db.prepare(
      'SELECT id, name FROM teachers WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!teacher) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Преподаватель не найден.' });
    }
    const password = randomNumericPassword(8);
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE teachers SET password_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(hash, id);
    bumpSessionVersion('teachers', id);
    audit(req, 'teacher.reset_password', 'teacher', id, { by: 'admin' });
    return res.json({ ok: true, userName: teacher.name, password, passwordDigits: 8 });
  })
);
router.post(
  '/admin/teachers/:id/toggle-status',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const t = db.prepare('SELECT status FROM teachers WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!t) return res.redirect('/admin/teachers');
    const next = t.status === 'active' ? 'finished' : 'active';
    lifecycle.setStatus('teachers', id, next);
    bumpSessionVersion('teachers', id);
    audit(req, next === 'finished' ? 'teacher.archive' : 'teacher.activate',
      'teacher', id, { status: next });
    return res.redirect(safeRedirect(req.body.redirect, '/admin/teachers'));
  })
);
router.post(
  '/admin/teachers/:id/delete',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const redirectTo = safeRedirect(req.body.redirect, '/admin/teachers');
    const teacher = db.prepare('SELECT id, name, login FROM teachers WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!teacher) return res.redirect(redirectTo);
    lifecycle.softDelete('teachers', id);
    bumpSessionVersion('teachers', id);
    audit(req, 'teacher.delete', 'teacher', id, {
      name: teacher.name, login: teacher.login, by: 'admin', mode: 'soft',
    });
    return res.redirect(appendQuery(redirectTo, { deleted: 1 }));
  })
);
/* ═══════════════════════════════════════════════════════════
   СТУДЕНТЫ
   ═══════════════════════════════════════════════════════════ */
router.get(
  '/admin/students',
  checkAdmin,
  handler((req, res) => {
    let groupId = null;
    if (req.query.group) {
      const n = pickInt(req.query.group);
      if (!n) return notFound(res, 'Группа не найдена.');
      groupId = n;
    }
    const q = pickStr(req.query.q, 100);
    const status = normalizeStatusFilter(req.query.status);
    const hasWorks = ['none', 'yes'].includes(req.query.has_works) ? req.query.has_works : '';
    const sort = normalizeSort(req.query.sort, ['name_asc', 'name_desc', 'date_desc', 'date_asc']);
    let where = ' WHERE s.deleted_at IS NULL';
    const params = {};
    if (groupId) { where += ' AND s.group_id = @groupId'; params.groupId = groupId; }
    if (q) {
      where += ' AND (s.name LIKE @q OR s.login LIKE @q)';
      params.q = `%${q}%`;
    }
    if (status === 'active') where += " AND s.status='active'";
    else if (status === 'finished') where += " AND s.status='finished'";
    if (hasWorks === 'none') {
      where += ' AND (SELECT COUNT(*) FROM submissions WHERE student_id = s.id AND deleted_at IS NULL) = 0';
    } else if (hasWorks === 'yes') {
      where += ' AND (SELECT COUNT(*) FROM submissions WHERE student_id = s.id AND deleted_at IS NULL) > 0';
    }
    const orderBy = sort === 'name_desc' ? 's.name DESC'
      : sort === 'date_desc' ? 's.created_at DESC'
      : sort === 'date_asc' ? 's.created_at ASC'
      : 's.name ASC';
    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM students s JOIN groups g ON g.id = s.group_id ${where}
    `).get(params).c;
    const pg = paginate(req.query.page, total, PAGE_SIZE);
    const students = db.prepare(`
      SELECT s.*, g.name AS group_name,
        (SELECT COUNT(*) FROM submissions WHERE student_id = s.id AND deleted_at IS NULL) AS works_count
      FROM students s
      JOIN groups g ON g.id = s.group_id
      ${where}
      ORDER BY g.name, ${orderBy}
      LIMIT ${pg.limit} OFFSET ${pg.offset}
    `).all(params);
    const counts = {
      active: db.prepare("SELECT COUNT(*) AS c FROM students WHERE status='active' AND deleted_at IS NULL").get().c,
      finished: db.prepare("SELECT COUNT(*) AS c FROM students WHERE status='finished' AND deleted_at IS NULL").get().c,
    };
    const createdStudent = req.session.flashCreatedStudent || null;
    if (createdStudent) delete req.session.flashCreatedStudent;
    return renderWith(res, 'admin/people/students', {
      title: 'Студенты',
      students,
      groups: loadGroups(),
      selectedGroup: groupId ? String(groupId) : '',
      q, status, hasWorks, sort, counts,
      studentLoginType: config.STUDENT_LOGIN_TYPE,
      error: null,
      createdStudent,
      deletedDone: req.query.deleted === '1',
      page: pg.page, pages: pg.pages, total, PAGE_SIZE,
    });
  })
);
router.get(
  '/admin/students/new',
  checkAdmin,
  handler((req, res) => {
    return renderWith(res, 'admin/people/student-form', {
      title: 'Новый студент',
      mode: 'create',
      groups: loadGroups(),
      form: { login: '', last_name: '', first_name: '', middle_name: '', group_id: '' },
      loginType: defaultLoginType(),
      error: null,
      studentLoginType: config.STUDENT_LOGIN_TYPE,
    });
  })
);
router.post(
  '/admin/students',
  checkAdmin,
  handler(async (req, res) => {
    const rawLoginType = pickStr(req.body.login_type, 20);
    const loginType = ['email', 'student_id'].includes(rawLoginType) ? rawLoginType : 'auto';
    const login = normalizeStudentLoginByType(req.body.login, loginType);
    const last_name = pickStr(req.body.last_name, 100);
    const first_name = pickStr(req.body.first_name, 100);
    const middle_name = pickStr(req.body.middle_name, 100);
    const name = composeName(last_name, first_name, middle_name);
    const groupId = pickInt(req.body.group_id);
    const renderErrForm = (error) => res.status(400).render('admin/people/student-form', {
      title: 'Новый студент', mode: 'create',
      groups: loadGroups(),
      form: { login, last_name, first_name, middle_name, group_id: req.body.group_id || '' },
      loginType: loginType === 'auto' ? defaultLoginType() : loginType,
      error,
      studentLoginType: config.STUDENT_LOGIN_TYPE,
    });
    const loginErr = validateStudentLoginByType(login, loginType);
    if (loginErr) return renderErrForm(loginErr);
    if (!last_name) return renderErrForm('Укажите фамилию.');
    if (!first_name) return renderErrForm('Укажите имя.');
    if (!groupId) return renderErrForm('Выберите группу.');
    const group = db.prepare(
      "SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL"
    ).get(groupId);
    if (!group) return renderErrForm('Группа не найдена.');
    if (db.prepare('SELECT id FROM students WHERE login = ? AND deleted_at IS NULL').get(login)) {
      return renderErrForm('Этот логин уже занят.');
    }
    if (db.prepare(
      'SELECT id FROM students WHERE name = ? AND group_id = ? AND deleted_at IS NULL'
    ).get(name, groupId)) {
      return renderErrForm('Студент с таким ФИО уже есть в этой группе.');
    }
    const password = randomNumericPassword(8);
    const hash = await bcrypt.hash(password, 10);
    const r = db.prepare(`
      INSERT INTO students
        (name, last_name, first_name, middle_name, login, group_id,
         password_hash, must_change_password, approved_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, 'active')
    `).run(name, last_name, first_name, middle_name, login, groupId, hash);
    const newId = Number(r.lastInsertRowid);
    audit(req, 'student.create', 'student', newId, {
      login, group: groupId, login_type: loginType, must_change_password: 1,
    });
    req.session.flashCreatedStudent = { name, login, password, digits: 8 };
    return req.session.save((err) => {
      if (err) console.error('[admin/students] session.save:', err.message);
      return res.redirect('/admin/students');
    });
  })
);
router.post(
  '/admin/students/:id/change-name',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const last_name = pickStr(req.body.last_name, 100);
    const first_name = pickStr(req.body.first_name, 100);
    const middle_name = pickStr(req.body.middle_name, 100);
    const redirectTo = safeRedirect(req.body.redirect, '/admin/students');
    if (!last_name) return res.status(400).render('common/error', { title: 'Ошибка', message: 'Фамилия не может быть пустой.' });
    if (!first_name) return res.status(400).render('common/error', { title: 'Ошибка', message: 'Имя не может быть пустым.' });
    const student = db.prepare(
      'SELECT id, group_id FROM students WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!student) return notFound(res, 'Студент не найден.');
    const name = composeName(last_name, first_name, middle_name);
    const exists = db.prepare(
      'SELECT id FROM students WHERE name = ? AND group_id = ? AND id <> ? AND deleted_at IS NULL'
    ).get(name, student.group_id, id);
    if (exists) {
      return res.status(400).render('common/error', {
        title: 'Ошибка', message: 'Студент с таким ФИО уже есть в этой группе.',
      });
    }
    db.prepare(`
      UPDATE students SET name = ?, last_name = ?, first_name = ?, middle_name = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(name, last_name, first_name, middle_name, id);
    audit(req, 'student.change_name', 'student', id, { name });
    return res.redirect(redirectTo);
  })
);
router.post(
  '/admin/students/:id/change-login',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const redirectTo = safeRedirect(req.body.redirect, '/admin/students');
    const login = normalizeStudentLoginAuto(pickStr(req.body.login, 200));
    const loginErr = validateStudentLoginAuto(login);
    if (loginErr) return res.status(400).render('common/error', { title: 'Ошибка', message: loginErr });
    const other = db.prepare(
      'SELECT id FROM students WHERE login = ? AND id <> ? AND deleted_at IS NULL'
    ).get(login, id);
    if (other) return res.status(400).render('common/error', { title: 'Ошибка', message: 'Этот логин уже занят.' });
    db.prepare('UPDATE students SET login = ? WHERE id = ? AND deleted_at IS NULL').run(login, id);
    bumpSessionVersion('students', id);
    audit(req, 'student.change_login', 'student', id, { login });
    return res.redirect(redirectTo);
  })
);
router.post(
  '/admin/students/:id/reset-password',
  checkAdmin,
  handler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ ok: false, error: 'bad_id', message: 'Некорректный id.' });
    }
    const student = db.prepare(
      'SELECT id, name FROM students WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!student) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Студент не найден.' });
    }
    const password = randomNumericPassword(8);
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE students SET password_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(hash, id);
    bumpSessionVersion('students', id);
    audit(req, 'student.reset_password', 'student', id, { by: 'admin' });
    return res.json({ ok: true, userName: student.name, password, passwordDigits: 8 });
  })
);
router.post(
  '/admin/students/:id/finish',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const r = lifecycle.setStatus('students', id, 'finished');
    if (r.changes) {
      bumpSessionVersion('students', id);
      audit(req, 'student.finish', 'student', id, { by: 'admin' });
    }
    return res.redirect(safeRedirect(req.body.redirect, '/admin/students'));
  })
);
router.post(
  '/admin/students/:id/activate',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const r = lifecycle.setStatus('students', id, 'active');
    if (r.changes) {
      audit(req, 'student.activate', 'student', id, { by: 'admin' });
    }
    return res.redirect(safeRedirect(req.body.redirect, '/admin/students'));
  })
);
router.post(
  '/admin/students/:id/change-group',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    const newGroupId = pickInt(req.body.group_id);
    const redirectTo = safeRedirect(req.body.redirect, '/admin/students');
    if (!id || !newGroupId) return res.redirect(redirectTo);
    const student = db.prepare(
      'SELECT * FROM students WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!student || student.group_id === newGroupId) return res.redirect(redirectTo);
    const newGroup = db.prepare(
      "SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL"
    ).get(newGroupId);
    if (!newGroup) return res.redirect(redirectTo);
    let worksMoved = 0;
    let worksKept = 0;
    db.transaction(() => {
      db.prepare('UPDATE students SET group_id = ? WHERE id = ?').run(newGroupId, id);
      const moved = db.prepare(`
        UPDATE submissions SET group_id = ?
        WHERE student_id = ?
          AND group_id <> ?
          AND deleted_at IS NULL
          AND assignment_id IN (
            SELECT a.id FROM assignments a
            JOIN subject_groups sg ON sg.subject_id = a.subject_id
            WHERE sg.group_id = ?
          )
      `).run(newGroupId, id, newGroupId, newGroupId);
      worksMoved = moved.changes;
      const kept = db.prepare(`
        SELECT COUNT(*) AS c FROM submissions
        WHERE student_id = ? AND group_id <> ? AND deleted_at IS NULL
      `).get(id, newGroupId).c;
      worksKept = kept;
    })();
    audit(req, 'student.change_group', 'student', id, {
      from: student.group_id, to: newGroupId,
      works_moved: worksMoved, works_kept_in_old_group: worksKept,
    });
    return res.redirect(redirectTo);
  })
);
router.post(
  '/admin/students/:id/delete',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const redirectTo = safeRedirect(req.body.redirect, '/admin/students');
    const student = db.prepare(
      'SELECT id, name, login FROM students WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    if (!student) return res.redirect(redirectTo);
    lifecycle.softDelete('students', id);
    bumpSessionVersion('students', id);
    audit(req, 'student.delete', 'student', id, {
      name: student.name, login: student.login, by: 'admin', mode: 'soft',
    });
    return res.redirect(appendQuery(redirectTo, { deleted: 1 }));
  })
);
/* ═══════════════════════════════════════════════════════════
   ЗАЯВКИ НА РЕГИСТРАЦИЮ
   ═══════════════════════════════════════════════════════════ */
router.get(
  '/admin/approvals',
  checkAdmin,
  handler((req, res) => {
    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM students s
      JOIN groups g ON g.id = s.group_id
      WHERE s.approved_at IS NULL
        AND s.status='active' AND s.deleted_at IS NULL
        AND g.status='active' AND g.deleted_at IS NULL
    `).get().c;
    const pg = paginate(req.query.page, total, PAGE_SIZE);
    const rows = db.prepare(`
      SELECT s.id, s.name, s.login, s.created_at, s.rejection_reason,
             g.id AS group_id, g.name AS group_name
      FROM students s
      JOIN groups g ON g.id = s.group_id
      WHERE s.approved_at IS NULL
        AND s.status='active'
        AND s.deleted_at IS NULL
        AND g.status='active'
        AND g.deleted_at IS NULL
      ORDER BY s.created_at ASC
      LIMIT ${pg.limit} OFFSET ${pg.offset}
    `).all();
    return renderWith(res, 'admin/people/approvals', {
      title: 'Заявки на регистрацию', rows,
      page: pg.page, pages: pg.pages, total, PAGE_SIZE,
    });
  })
);
router.post(
  '/admin/approvals/:id/approve',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return res.redirect('/admin/approvals');
    const r = db.prepare(`
      UPDATE students
      SET approved_at = CURRENT_TIMESTAMP, rejection_reason = NULL
      WHERE id = ? AND approved_at IS NULL
        AND status='active' AND deleted_at IS NULL
    `).run(id);
    if (r.changes) audit(req, 'student.approve', 'student', id, { by: 'admin' });
    return res.redirect('/admin/approvals');
  })
);
router.post(
  '/admin/approvals/:id/reject',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return res.redirect('/admin/approvals');
    const reason = pickStr(req.body.reason, 500) || 'без указания причины';
    try {
      lifecycle.setStatus('students', id, 'rejected', { rejectionReason: reason });
      audit(req, 'student.reject', 'student', id, { reason, by: 'admin' });
    } catch (e) {
      console.error('[approvals/reject]', e.message);
    }
    return res.redirect('/admin/approvals');
  })
);
module.exports = router;