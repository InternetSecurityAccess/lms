// routes/auth.js
'use strict';
const { nowSql } = require('../utils/dates');
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../database');
const config = require('../config');
const { rateLimitLogin, recordFailure, recordSuccess } = require('../middleware/rateLimit');
const {
  normalizeStudentLogin, normalizeTeacherLogin,
  validateStudentLogin,
} = require('../utils/login-validation');
const { composeName } = require('../utils/names');
const { validatePassword } = require('../utils/password-policy');
const { audit } = require('../utils/audit');
const { findDemoUser } = require('../config/demo-users');

/* ═══════════════════════════════════════════════════════════
   loadGroups — только активные, неудалённые группы.
   В finished-группу новых студентов не регистрируем (она
   выпущена), но существующие студенты туда уже не попадают
   через эту функцию.
   ═══════════════════════════════════════════════════════════ */
function loadGroups() {
  return db.prepare(`
    SELECT id, name FROM groups
    WHERE status = 'active' AND deleted_at IS NULL
    ORDER BY name
  `).all();
}

function renderLogin(res, opts = {}) {
  const {
    error = null, mode = 'login', tab = 'student', form = {}, status = 200,
  } = opts;
  return res.status(status).render('auth/login', {
    title: 'Вход',
    error, mode, tab,
    groups: loadGroups(),
    form,
    studentLoginType: config.STUDENT_LOGIN_TYPE,
    registrationEnabled: config.REGISTRATION_ENABLED,
  });
}

function redirectIfAuthed(req, res) {
  if (req.session?.adminId) return res.redirect('/admin');
  if (req.session?.studentId) {
    return res.redirect(req.session.mustChangePassword ? '/change-password-required' : '/my-teachers');
  }
  if (req.session?.teacherId) {
    const t = db.prepare(
      'SELECT must_change_password FROM teachers WHERE id = ? AND deleted_at IS NULL'
    ).get(req.session.teacherId);
    if (t && Number(t.must_change_password) === 1) return res.redirect('/change-password-required');
    return res.redirect('/my-groups');
  }
  return null;
}

router.get('/login', (req, res) => {
  if (redirectIfAuthed(req, res)) return;
  return renderLogin(res);
});

router.get('/login/student', (req, res) => {
  if (redirectIfAuthed(req, res)) return;
  return renderLogin(res, { tab: 'student', mode: 'login' });
});

router.get('/login/teacher', (req, res) => {
  if (redirectIfAuthed(req, res)) return;
  return renderLogin(res, { tab: 'teacher', mode: 'login' });
});

router.get('/register', (req, res) => {
  if (redirectIfAuthed(req, res)) return;
  if (!config.REGISTRATION_ENABLED) {
    return res.status(403).render('common/error', {
      title: 'Регистрация закрыта',
      message: 'Регистрация закрыта. Обратитесь к администратору.',
    });
  }
  return renderLogin(res, { tab: 'student', mode: 'register' });
});

/* ═══════════════════════════════════════════════════════════
   POST /login/student

   Destroy-условия (не пускаем):
     • student.deleted_at — в корзине;
     • student.status='rejected' — заявка отклонена (с причиной);
     • group.deleted_at — «группы нет».

   Пропускаем (readonly):
     • student.status='finished' — выпускник читает историю;
     • group.status='finished' — readonly (модель B);
     • student.approved_at IS NULL (pending) — ведём на
       /pending-approval через redirectIfAuthed-подобную логику
       ниже в save().
   ═══════════════════════════════════════════════════════════ */
router.post(
  '/login/student',
  (req, res, next) => { req.groups = loadGroups(); next(); },
  rateLimitLogin('auth/login', 'student'),
  async (req, res, next) => {
    const login = normalizeStudentLogin(req.body.login);
    const password = String(req.body.password || '');
    const form = { login };
    if (!login || !password) {
      return renderLogin(res, { error: 'Заполните все поля.', tab: 'student', form });
    }
    try {
      const student = db.prepare(`
        SELECT s.*,
               g.status     AS group_status,
               g.deleted_at AS group_deleted_at
        FROM students s
        LEFT JOIN groups g ON g.id = s.group_id
        WHERE s.login = ?
      `).get(login);
      if (!student) {
        recordFailure('student', req);
        return renderLogin(res, {
          error: 'Студент с таким логином не найден.',
          tab: 'student', form,
        });
      }
      if (student.deleted_at) {
        recordFailure('student', req);
        return renderLogin(res, {
          error: 'Учётная запись заблокирована. Обратитесь к администратору.',
          tab: 'student', form, status: 403,
        });
      }
      if (student.status === 'rejected') {
        recordFailure('student', req);
        return renderLogin(res, {
          error: student.rejection_reason
            ? 'Ваша заявка отклонена: ' + student.rejection_reason
            : 'Ваша заявка отклонена. Обратитесь к администратору.',
          tab: 'student', form, status: 403,
        });
      }
      // deleted-группа = «нет». finished — readonly, пускаем.
      if (student.group_deleted_at) {
        recordFailure('student', req);
        return renderLogin(res, {
          error: 'Ваша группа удалена. Обратитесь к администратору.',
          tab: 'student', form, status: 403,
        });
      }
      const valid = await bcrypt.compare(password, student.password_hash);
      if (!valid) {
        recordFailure('student', req);
        return renderLogin(res, { error: 'Неверный пароль.', tab: 'student', form });
      }
      recordSuccess('student', req);
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.studentId = student.id;
        req.session.studentName = student.name;
        req.session.sessionVersion = student.session_version;
        req.session.mustChangePassword = student.must_change_password === 1;
        req.session.save((e) => {
          if (e) return next(e);
          audit(req, 'auth.login', 'student', student.id, { login });
          if (!student.approved_at) return res.redirect('/pending-approval');
          return res.redirect(
            req.session.mustChangePassword ? '/change-password-required' : '/my-teachers'
          );
        });
      });
    } catch (e) { return next(e); }
  }
);

router.post(
  '/login/teacher',
  rateLimitLogin('auth/login', 'teacher'),
  async (req, res, next) => {
    const login = normalizeTeacherLogin(req.body.login);
    const password = String(req.body.password || '');
    if (!login || !password) {
      return renderLogin(res, {
        error: 'Заполните все поля.',
        tab: 'teacher', form: { login },
      });
    }
    try {
      const teacher = db.prepare(`
        SELECT * FROM teachers
        WHERE login = ? AND status = 'active' AND deleted_at IS NULL
      `).get(login);
      if (!teacher) {
        recordFailure('teacher', req);
        return renderLogin(res, {
          error: 'Преподаватель с таким email не найден или завершён.',
          tab: 'teacher', form: { login },
        });
      }
      const valid = await bcrypt.compare(password, teacher.password_hash);
      if (!valid) {
        recordFailure('teacher', req);
        return renderLogin(res, {
          error: 'Неверный пароль.',
          tab: 'teacher', form: { login },
        });
      }
      recordSuccess('teacher', req);
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.teacherId = teacher.id;
        req.session.teacherName = teacher.name;
        req.session.sessionVersion = teacher.session_version;
        req.session.save((e) => {
          if (e) return next(e);
          audit(req, 'auth.login', 'teacher', teacher.id, { login });
          if (Number(teacher.must_change_password) === 1) {
            return res.redirect('/change-password-required');
          }
          return res.redirect('/my-groups');
        });
      });
    } catch (e) { return next(e); }
  }
);

router.post(
  '/register/student',
  (req, res, next) => { req.groups = loadGroups(); next(); },
  (req, res, next) => {
    if (!config.REGISTRATION_ENABLED) {
      return res.status(403).render('common/error', {
        title: 'Регистрация закрыта',
        message: 'Регистрация закрыта. Обратитесь к администратору.',
      });
    }
    next();
  },
  rateLimitLogin('auth/login', 'register_student'),
  async (req, res, next) => {
    const login = normalizeStudentLogin(req.body.login);
    const last_name = String(req.body.last_name || '').trim().slice(0, 100);
    const first_name = String(req.body.first_name || '').trim().slice(0, 100);
    const middle_name = String(req.body.middle_name || '').trim().slice(0, 100);
    const name = composeName(last_name, first_name, middle_name);
    const groupId = Number(req.body.group_id);
    const password = String(req.body.password || '');
    const form = { login, last_name, first_name, middle_name, group_id: req.body.group_id };
    const loginErr = validateStudentLogin(login);
    if (loginErr) {
      recordFailure('register_student', req);
      return renderLogin(res, {
        error: loginErr, mode: 'register', tab: 'student', form,
      });
    }
    if (!last_name || !first_name || !password || !groupId) {
      recordFailure('register_student', req);
      return renderLogin(res, {
        error: 'Заполните обязательные поля.',
        mode: 'register', tab: 'student', form,
      });
    }
    const policyErrors = validatePassword(password, { login });
    if (policyErrors.length > 0) {
      recordFailure('register_student', req);
      return renderLogin(res, {
        error: policyErrors.join(' '), mode: 'register', tab: 'student', form,
      });
    }
    try {
      // Регистрация — только в active-группу. В finished не пускаем:
      // это уже выпущенная группа, новых студентов туда не добавляем.
      const group = db.prepare(`
        SELECT id FROM groups
        WHERE id = ? AND status = 'active' AND deleted_at IS NULL
      `).get(groupId);
      if (!group) {
        recordFailure('register_student', req);
        return renderLogin(res, {
          error: 'Выберите группу.', mode: 'register', tab: 'student', form,
        });
      }
      if (db.prepare(
        'SELECT id FROM students WHERE login = ? AND deleted_at IS NULL'
      ).get(login)) {
        recordFailure('register_student', req);
        return renderLogin(res, {
          error: 'Этот логин уже занят. Укажите другой.',
          mode: 'register', tab: 'student', form,
        });
      }
      if (db.prepare(`
        SELECT id FROM students
        WHERE name = ? AND group_id = ? AND deleted_at IS NULL
      `).get(name, groupId)) {
        recordFailure('register_student', req);
        return renderLogin(res, {
          error: 'Студент с таким ФИО уже есть в этой группе.',
          mode: 'register', tab: 'student', form,
        });
      }
      const hash = await bcrypt.hash(password, 10);
      const needsApproval = config.REGISTRATION_NEEDS_APPROVAL;
      const approvedAt = needsApproval ? null : nowSql();
      const r = db.prepare(`
        INSERT INTO students
          (name, last_name, first_name, middle_name, login, group_id,
           password_hash, approved_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `).run(name, last_name, first_name, middle_name, login, groupId, hash, approvedAt);
      const studentId = Number(r.lastInsertRowid);
      const created = db.prepare('SELECT session_version FROM students WHERE id = ?')
        .get(studentId);
      recordSuccess('register_student', req);
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.studentId = studentId;
        req.session.studentName = name;
        req.session.sessionVersion = created?.session_version ?? 1;
        req.session.mustChangePassword = false;
        req.session.save((e) => {
          if (e) return next(e);
          return res.redirect(needsApproval ? '/pending-approval' : '/');
        });
      });
    } catch (e) { return next(e); }
  }
);

router.get('/admin/login', (req, res) => {
  if (req.session?.adminId) return res.redirect('/admin');
  return res.render('admin/account/login', {
    title: 'Вход для администратора', error: null, form: {},
  });
});

router.post(
  '/admin/login',
  rateLimitLogin('admin/account/login', 'admin'),
  async (req, res, next) => {
    const name = String(req.body.name || '').trim().slice(0, 200);
    const password = String(req.body.password || '');
    if (!name || !password) {
      return res.status(400).render('admin/account/login', {
        title: 'Вход для администратора',
        error: 'Заполните все поля.',
        form: { name },
      });
    }
    try {
      const admin = db.prepare('SELECT * FROM admins WHERE name = ?').get(name);
      if (!admin) {
        recordFailure('admin', req);
        return res.status(401).render('admin/account/login', {
          title: 'Вход для администратора',
          error: 'Неверный логин или пароль.',
          form: { name },
        });
      }
      const valid = await bcrypt.compare(password, admin.password_hash);
      if (!valid) {
        recordFailure('admin', req);
        return res.status(401).render('admin/account/login', {
          title: 'Вход для администратора',
          error: 'Неверный логин или пароль.',
          form: { name },
        });
      }
      recordSuccess('admin', req);
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.adminId = admin.id;
        req.session.adminName = admin.name;
        req.session.sessionVersion = admin.session_version;
        req.session.save((e) => {
          if (e) return next(e);
          audit(req, 'auth.login', 'admin', admin.id, { name });
          return res.redirect('/admin');
        });
      });
    } catch (e) { return next(e); }
  }
);

/* ═══════════════════════════════════════════════════════════
   ДЕМО-ВХОД
   ═══════════════════════════════════════════════════════════
   Работает только при config.DEMO_MODE. Логин проверяется по
   config.DEMO_USERS. Для demo-студента group_status не важен:
   если группа finished — readonly-доступ (модель B). Destroy
   только при deleted_at.
   ═══════════════════════════════════════════════════════════ */
function demoLoginStudent(req, res, next, login) {
  const demo = findDemoUser('student', login);
  if (!demo) return res.redirect('/login');
  try {
    const student = db.prepare(`
      SELECT s.*,
             g.status     AS group_status,
             g.deleted_at AS group_deleted_at
      FROM students s
      LEFT JOIN groups g ON g.id = s.group_id
      WHERE s.login = ?
        AND s.deleted_at IS NULL
        AND s.status = 'active'
    `).get(login);
    if (!student || student.group_deleted_at) return res.redirect('/login');
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.studentId = student.id;
      req.session.studentName = student.name;
      req.session.sessionVersion = student.session_version;
      req.session.mustChangePassword = false;
      req.session.save((e) => {
        if (e) return next(e);
        audit(req, 'auth.login', 'student', student.id, { login, demo: true });
        return res.redirect('/my-teachers');
      });
    });
  } catch (e) { return next(e); }
}

function demoLoginTeacher(req, res, next, login) {
  const demo = findDemoUser('teacher', login);
  if (!demo) return res.redirect('/login');
  try {
    const teacher = db.prepare(`
      SELECT * FROM teachers
      WHERE login = ? AND status = 'active' AND deleted_at IS NULL
    `).get(login);
    if (!teacher) return res.redirect('/login');
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.teacherId = teacher.id;
      req.session.teacherName = teacher.name;
      req.session.sessionVersion = teacher.session_version;
      req.session.save((e) => {
        if (e) return next(e);
        audit(req, 'auth.login', 'teacher', teacher.id, { login, demo: true });
        if (Number(teacher.must_change_password) === 1) {
          return res.redirect('/change-password-required');
        }
        return res.redirect('/my-groups');
      });
    });
  } catch (e) { return next(e); }
}

router.post('/demo/login/teacher/:login', (req, res, next) => {
  if (!config.DEMO_MODE) return res.redirect('/login');
  return demoLoginTeacher(req, res, next, String(req.params.login || '').trim());
});
router.post('/demo/login/student/:login', (req, res, next) => {
  if (!config.DEMO_MODE) return res.redirect('/login');
  return demoLoginStudent(req, res, next, String(req.params.login || '').trim());
});

router.post('/demo/login-student', (req, res, next) => {
  if (!config.DEMO_MODE) return res.redirect('/login');
  return demoLoginStudent(req, res, next, config.DEMO_STUDENT.login);
});
router.post('/demo/login-teacher', (req, res, next) => {
  if (!config.DEMO_MODE) return res.redirect('/login');
  return demoLoginTeacher(req, res, next, config.DEMO_TEACHER.login);
});
router.post('/demo/login-admin', (req, res, next) => {
  if (!config.DEMO_MODE) return res.redirect('/admin/login');
  try {
    const admin = db.prepare('SELECT * FROM admins ORDER BY id LIMIT 1').get();
    if (!admin) return res.redirect('/admin/login');
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.adminId = admin.id;
      req.session.adminName = admin.name;
      req.session.sessionVersion = admin.session_version;
      req.session.save((e) => {
        if (e) return next(e);
        audit(req, 'auth.login', 'admin', admin.id, { demo: true });
        return res.redirect('/admin');
      });
    });
  } catch (e) { return next(e); }
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.redirect('/login');
  req.session.destroy((err) => {
    if (err) console.error('destroy:', err);
    res.clearCookie('workstud.sid');
    res.redirect('/login');
  });
});

router.post('/admin/logout', (req, res) => {
  if (!req.session) return res.redirect('/admin/login');
  req.session.destroy((err) => {
    if (err) console.error('destroy:', err);
    res.clearCookie('workstud.sid');
    res.redirect('/admin/login');
  });
});

module.exports = router;