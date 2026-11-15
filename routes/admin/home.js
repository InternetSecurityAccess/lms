'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkAdmin } = require('../shared/authz');
const { handler, renderWith } = require('../shared/handlers');

router.get(
  '/admin',
  checkAdmin,
  handler((req, res) => {
    const stats = {
      teachers: db.prepare(
        "SELECT COUNT(*) AS c FROM teachers WHERE status='active' AND deleted_at IS NULL"
      ).get().c,
      students: db.prepare(
        "SELECT COUNT(*) AS c FROM students WHERE status='active' AND deleted_at IS NULL"
      ).get().c,
      groups: db.prepare(
        "SELECT COUNT(*) AS c FROM groups WHERE status='active' AND deleted_at IS NULL"
      ).get().c,
      finishedGroups: db.prepare(
        "SELECT COUNT(*) AS c FROM groups WHERE status='finished' AND deleted_at IS NULL"
      ).get().c,
      pendingApprovals: db.prepare(`
        SELECT COUNT(*) AS c FROM students
        WHERE approved_at IS NULL
          AND status='active'
          AND deleted_at IS NULL
      `).get().c,
      subjects: db.prepare(
        "SELECT COUNT(*) AS c FROM subjects WHERE status='active' AND deleted_at IS NULL"
      ).get().c,
      pendingWorks: db.prepare(`
        SELECT COUNT(*) AS c FROM submissions
        WHERE status='pending' AND deleted_at IS NULL
      `).get().c,
      supportUnread: db.prepare(`
        SELECT COUNT(*) AS c FROM support_threads st
        WHERE EXISTS (
          SELECT 1 FROM support_messages m
          WHERE m.thread_id = st.id AND m.sender_type='user' AND m.is_read=0
        )
      `).get().c,
    };
    return renderWith(res, 'admin/home', {
      title: 'Админка',
      stats,
      adminName: req.session.adminName,
    });
  })
);

module.exports = router;