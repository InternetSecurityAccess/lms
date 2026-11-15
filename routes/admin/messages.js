'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const router = express.Router();
const db = require('../../database');
const { checkAdmin } = require('../shared/authz');
const { chatRateLimit } = require('../../middleware/rateLimit');
const { handler, renderWith, parseIdOr404, notFound } = require('../shared/handlers');
const { audit } = require('../shared/handlers');
const { SUPPORT_FILES_DIR } = require('../../utils/storage/paths');
const chat = require('../shared/chat');

const SUPPORT_IMAGE_RE = /^[st]\d+\/sup-[a-f0-9-]+\.(png|jpg|jpeg)$/;

router.get(
  '/admin/support',
  checkAdmin,
  handler((req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const filter = ['all', 'unread'].includes(req.query.filter) ? req.query.filter : 'all';
    let where = ' WHERE 1=1';
    const params = {};
    if (q) {
      where += ' AND (s.name LIKE @q OR t.name LIKE @q)';
      params.q = `%${q}%`;
    }
    if (filter === 'unread') {
      where += ` AND EXISTS (
        SELECT 1 FROM support_messages m
        WHERE m.thread_id = st.id AND m.sender_type = 'user' AND m.is_read = 0
          AND m.deleted_at IS NULL
      )`;
    }
    const threads = db.prepare(`
      SELECT st.id, st.student_id, st.teacher_id, st.created_at, st.last_message_at,
        s.name AS student_name,
        t.name AS teacher_name,
        (SELECT COUNT(*) FROM support_messages m
          WHERE m.thread_id = st.id AND m.sender_type = 'user'
            AND m.is_read = 0 AND m.deleted_at IS NULL)
          AS unread_count,
        (SELECT m.message FROM support_messages m
          WHERE m.thread_id = st.id AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC LIMIT 1) AS last_message,
        (SELECT m.sender_type FROM support_messages m
          WHERE m.thread_id = st.id AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC LIMIT 1) AS last_sender
      FROM support_threads st
      LEFT JOIN students s ON s.id = st.student_id
      LEFT JOIN teachers t ON t.id = st.teacher_id
      ${where}
      ORDER BY (unread_count > 0) DESC, COALESCE(st.last_message_at, st.created_at) DESC
    `).all(params);
    const countsRow = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM support_messages m
          WHERE m.thread_id = st.id AND m.sender_type = 'user' AND m.is_read = 0
            AND m.deleted_at IS NULL
        ) THEN 1 ELSE 0 END) AS unread
      FROM support_threads st
    `).get();
    const counts = {
      total: Number(countsRow.total || 0),
      unread: Number(countsRow.unread || 0),
    };
    return renderWith(res, 'admin/messages/list', {
      title: 'Обращения',
      threads, counts, q, filter,
    });
  })
);

router.get(
  '/admin/support/:id',
  checkAdmin,
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const thread = db.prepare(`
      SELECT st.*, s.name AS student_name, t.name AS teacher_name
      FROM support_threads st
      LEFT JOIN students s ON s.id = st.student_id
      LEFT JOIN teachers t ON t.id = st.teacher_id
      WHERE st.id = ?
    `).get(id);
    if (!thread) return notFound(res, 'Обращение не найдено.');
    db.prepare(`
      UPDATE support_messages SET is_read = 1
      WHERE thread_id = ? AND sender_type = 'user' AND is_read = 0
    `).run(thread.id);
    const q = String(req.query.q || '').trim().slice(0, 200);
    const messages = chat.listMessages('support', thread.id, { q });
    return renderWith(res, 'admin/messages/thread', {
      title: 'Обращение',
      thread, messages, q,
      deletedMsgId: req.query.deleted ? Number(req.query.deleted) : null,
      cleared: req.query.cleared === '1',
    });
  })
);

router.get(
  '/admin/support/:id/messages.json',
  checkAdmin,
  handler((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        ok: false,
        error: 'bad_id',
        message: 'Некорректный id.',
      });
    }
    const thread = db.prepare('SELECT id FROM support_threads WHERE id = ?').get(id);
    if (!thread) {
      return res.status(404).json({
        ok: false,
        error: 'not_found',
        message: 'Обращение не найдено.',
      });
    }
    db.prepare(`
      UPDATE support_messages SET is_read = 1
      WHERE thread_id = ? AND sender_type = 'user' AND is_read = 0
    `).run(thread.id);
    const q = String(req.query.q || '').trim().slice(0, 200);
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      messages: chat.listMessages('support', thread.id, { q }),
    });
  })
);

router.post(
  '/admin/support/:id',
  checkAdmin,
  chatRateLimit('support_msg'),
  handler((req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const thread = db.prepare('SELECT id FROM support_threads WHERE id = ?').get(id);
    if (!thread) return res.redirect('/admin/support');
    const text = String(req.body.message || '').trim().slice(0, 5000);
    const rawFilePath = String(req.body.file_path || '').trim();
    const fileName = String(req.body.file_name || '').trim().slice(0, 255);
    let filePath = null;
    if (SUPPORT_IMAGE_RE.test(rawFilePath)) {
      const abs = path.join(SUPPORT_FILES_DIR, rawFilePath);
      if (abs.startsWith(SUPPORT_FILES_DIR + path.sep) && fs.existsSync(abs)) {
        filePath = rawFilePath;
      }
    }
    if (!text && !filePath) return res.redirect(`/admin/support/${id}`);
    db.transaction(() => {
      chat.addMessage('support', thread.id, {
        senderType: 'admin',
        senderId: req.session.adminId,
        senderName: req.session.adminName || 'Администратор',
        message: text,
        file_path: filePath,
        file_name: filePath ? (fileName || null) : null,
      });
      chat.touchSupportThread(thread.id);
    })();
    return res.redirect(`/admin/support/${id}`);
  })
);

router.post(
  '/admin/support/:id/messages/:mid/delete',
  checkAdmin,
  handler(async (req, res) => {
    const id = parseIdOr404(req, res, 'id');
    const mid = parseIdOr404(req, res, 'mid');
    if (!id || !mid) return;
    const thread = db.prepare('SELECT id FROM support_threads WHERE id = ?').get(id);
    if (!thread) return res.redirect('/admin/support');
    const m = db.prepare(
      'SELECT * FROM support_messages WHERE id = ? AND thread_id = ?'
    ).get(mid, thread.id);
    if (!m || !chat.canDeleteSupportMessage(m, 'admin')) {
      return res.redirect(`/admin/support/${id}`);
    }
    const result = chat.softDelete('support', mid, 'admin', req.session.adminId);
    if (result?.file_path) {
      try {
        const abs = path.join(SUPPORT_FILES_DIR, result.file_path);
        if (abs.startsWith(SUPPORT_FILES_DIR + path.sep)) {
          await fs.promises.unlink(abs).catch(() => {});
        }
      } catch { /* ignore */ }
    }
    audit(req, 'support_message.delete', 'support_message', mid, { thread_id: id });
    return res.redirect(`/admin/support/${id}?deleted=${mid}`);
  })
);

router.post(
  '/admin/support/:id/clear',
  checkAdmin,
  handler(async (req, res) => {
    const id = parseIdOr404(req, res, 'id');
    if (!id) return;
    const thread = db.prepare('SELECT id FROM support_threads WHERE id = ?').get(id);
    if (!thread) return res.redirect('/admin/support');
    const result = chat.clearMessages('support', thread.id, 'admin', req.session.adminId);
    for (const file of result.files) {
      try {
        const abs = path.join(SUPPORT_FILES_DIR, file);
        if (abs.startsWith(SUPPORT_FILES_DIR + path.sep)) {
          await fs.promises.unlink(abs).catch(() => {});
        }
      } catch { /* ignore */ }
    }
    audit(req, 'support_thread.clear', 'support_thread', thread.id, {
      count: result.count,
    });
    return res.redirect(`/admin/support/${id}?cleared=1`);
  })
);

module.exports = router;