// routes/student/works/assignment-view.js
'use strict';



const { checkStudent } = require('../../shared/authz');
const { handler, renderWith } = require('../../shared/handlers');
const { loadStudentRow } = require('../../shared/loaders');

const loadFormLocals = require('./load-form-locals');

const express = require('express');
const router = express.Router();

router.get(
  '/t/:teacherId/assignments/:assignmentId',
  checkStudent, loadStudentRow,
  handler(async (req, res) => {
    const teacherId = Number(req.params.teacherId);
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isSafeInteger(teacherId) || !Number.isSafeInteger(assignmentId)) {
      return res.status(404).render('common/error', {
        title: 'Не найдено', message: 'Задание не найдено.',
      });
    }
    const locals = await loadFormLocals(req.me, teacherId, assignmentId);
    if (!locals) {
      return res.status(404).render('common/error', {
        title: 'Не найдено', message: 'Задание не найдено.',
      });
    }
    if (locals.submitBlocked) {
      return res.redirect(`/t/${teacherId}/assignments/${assignmentId}/archive`);
    }
    return renderWith(res, 'student/content/assignment-submit', {
      ...locals,
      justUploaded: req.query.uploaded === '1',
    });
  })
);

module.exports = router;
