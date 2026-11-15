'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../../database');
const config = require('../../config');
const { checkAdmin } = require('../shared/authz');
const { handler, renderWith } = require('../shared/handlers');
const { bumpSessionVersion } = require('../../utils/sessions');
const { validatePassword } = require('../../utils/password-policy');

/* ═══════════════════════════════════════════════════════════
   Профиль
   ═══════════════════════════════════════════════════════════ */
router.get(
  '/admin/profile',
  checkAdmin,
  handler((req, res) => {
    const me = db.prepare('SELECT id, name, created_at FROM admins WHERE id = ?')
      .get(req.session.adminId);
    return renderWith(res, 'admin/account/profile', {
      title: 'Профиль администратора',
      me, error: null, success: null,
    });
  })
);

/* ═══════════════════════════════════════════════════════════
   Смена логина
   ═══════════════════════════════════════════════════════════ */
router.post(
  '/admin/profile/change-name',
  checkAdmin,
  handler((req, res) => {
    const me = db.prepare('SELECT id, name, created_at FROM admins WHERE id = ?')
      .get(req.session.adminId);
    const newName = String(req.body.name || '').trim().slice(0, 200);

    if (!newName) {
      return res.status(400).render('admin/account/profile', {
        title: 'Профиль администратора', me,
        error: 'Логин не может быть пустым.', success: null,
      });
    }

    const exists = db.prepare('SELECT id FROM admins WHERE name = ? AND id <> ?')
      .get(newName, me.id);
    if (exists) {
      return res.status(400).render('admin/account/profile', {
        title: 'Профиль администратора', me,
        error: 'Этот логин уже занят.', success: null,
      });
    }

    db.prepare('UPDATE admins SET name = ? WHERE id = ?').run(newName, me.id);
    req.session.adminName = newName;

    return renderWith(res, 'admin/account/profile', {
      title: 'Профиль администратора',
      me: { ...me, name: newName },
      error: null, success: 'Логин изменён.',
    });
  })
);

/* ═══════════════════════════════════════════════════════════
   Смена пароля
   ═══════════════════════════════════════════════════════════ */
router.post(
  '/admin/profile/change-password',
  checkAdmin,
  handler(async (req, res) => {
    const me = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
    const oldPassword = String(req.body.old_password || '');
    const newPassword = String(req.body.new_password || '');

    if (!oldPassword || !newPassword) {
      return res.status(400).render('admin/account/profile', {
        title: 'Профиль администратора', me,
        error: 'Заполните все поля.', success: null,
      });
    }

    const policyErrors = validatePassword(newPassword, {
      level: config.ADMIN_PASSWORD_LEVEL,
      login: me.name,
    });
    if (policyErrors.length > 0) {
      return res.status(400).render('admin/account/profile', {
        title: 'Профиль администратора', me,
        error: policyErrors.join(' '), success: null,
      });
    }

    const valid = await bcrypt.compare(oldPassword, me.password_hash);
    if (!valid) {
      return res.status(400).render('admin/account/profile', {
        title: 'Профиль администратора', me,
        error: 'Неверный текущий пароль.', success: null,
      });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, me.id);
    bumpSessionVersion('admins', me.id);

    const updated = db.prepare('SELECT session_version FROM admins WHERE id = ?').get(me.id);
    if (updated) req.session.sessionVersion = updated.session_version;

    return renderWith(res, 'admin/account/profile', {
      title: 'Профиль администратора', me,
      error: null, success: 'Пароль изменён. Остальные сессии завершены.',
    });
  })
);

module.exports = router;