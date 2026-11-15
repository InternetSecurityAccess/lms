// routes/student/account.js
'use strict';
// Раньше здесь жил весь профиль (и /my-profile, и /change-password-required).
// Теперь они в routes/shared/profile.js — единая точка для teacher и student.
// В этом файле остался только /pending-approval — спецстраница студента,
// ожидающего подтверждения регистрации.
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkStudent } = require('../shared/authz');
const { handler, renderWith } = require('../shared/handlers');
router.get('/pending-approval', checkStudent, handler((req, res) => {
  const me = db.prepare(`
    SELECT s.*, g.name AS group_name FROM students s
    JOIN groups g ON g.id = s.group_id WHERE s.id = ?
  `).get(req.session.studentId);
  if (!me) return res.redirect('/login');
  if (me.approved_at) return res.redirect('/');
  if (me.status === 'rejected' || me.rejection_reason) {
    return res.status(403).render('common/error', {
      title: 'Учётная запись отклонена',
      message: 'Ваша учётная запись отклонена. Причина: ' + (me.rejection_reason || 'не указана'),
    });
  }
  return renderWith(res, 'student/messages/pending-approval', {
    title: 'Ожидание подтверждения',
    me,
  });
}));
module.exports = router;