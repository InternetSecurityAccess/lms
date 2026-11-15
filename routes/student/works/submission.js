// routes/student/works/submission.js
'use strict';

const attachments = require('../../../utils/attachments');
const { invalidateCounters, getCountersCached } = require('../../../utils/counters');

const { checkStudent } = require('../../shared/authz');
const { handler, renderWith } = require('../../shared/handlers');
const { loadStudentRow, loadSubmissionAsStudent } = require('../../shared/loaders');
const { makeSubmissionChatRouter } = require('../../shared/chat-routes');
const chat = require('../../shared/chat');

const { toArray, markStatusRead, rejectReadonlySubmission, STUDENT_UNREAD_SQL } = require('./helpers');

const express = require('express');
const router = express.Router();

router.get(
  '/t/:teacherId/works/:id',
  checkStudent, loadStudentRow, loadSubmissionAsStudent, rejectReadonlySubmission,
  handler((req, res) => {
    chat.markRead('submission', req.submission.id, 'student');
    markStatusRead(req.submission.id, req.session.studentId, req.submission.status);
    invalidateCounters(req.sessionID);
    try {
      const c = getCountersCached(req.session, req.sessionID);
      res.locals.inboxCount = c.inboxCount;
    } catch { /* ignore */ }
    const q = String(req.query.q || '').trim().slice(0, 200);
    const messages = chat.listMessages('submission', req.submission.id, { q });
    return renderWith(res, 'student/works/submission', {
      title: req.submission.topic,
      me: req.me,
      submission: req.submission,
      attachments: req.submission.attachments,
      messages, q,
      justUploaded: req.query.new === '1',
      justReplaced: req.query.replaced === '1',
      basePath: `/t/${req.submission.teacher_id}/works/${req.submission.id}`,
    });
  })
);


router.use(
  '/t/:teacherId/works/:id',
  makeSubmissionChatRouter({
    basePath: (req) => `/t/${req.submission.teacher_id}/works/${req.submission.id}`,
    loadContext: [
      checkStudent,
      loadStudentRow,
      loadSubmissionAsStudent,
      rejectReadonlySubmission,
    ],
    canView: () => true,
    canWrite: (req) => req.submission.status !== 'accepted',
    getSender: (req) => ({
      type: 'student',
      id: req.session.studentId,
      name: req.session.studentName || 'Студент',
    }),
    getViewLocals: (req) => ({
      view: 'student/works/submission',
      locals: (messages, q) => ({
        title: req.submission.topic,
        me: req.me,
        submission: req.submission,
        attachments: req.submission.attachments,
        messages, q,
        justUploaded: false,
        justReplaced: false,
        basePath: `/t/${req.submission.teacher_id}/works/${req.submission.id}`,
      }),
    }),
  })
);

module.exports = router;
