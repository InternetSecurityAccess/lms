'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../database');
const config = require('../../config');
const { fixFilename, safeJoin } = require('../../utils/helpers');
const { chatRateLimit } = require('../../middleware/rateLimit');
const { chatUpload } = require('../../utils/storage');
const {
  handler, redirectWith, renderWith, forbid, uploadWithFallback,
} = require('./handlers');
const chat = require('./chat');

async function unlinkChatFile(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(safeJoin(config.STORAGE_DIR, filePath));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('unlink chat:', e);
  }
}

function uploadErrorRedirect(getBase) {
  return (err, req, res) => {
    const files = Array.isArray(req.files) ? req.files
      : (req.file ? [req.file] : []);
    for (const f of files) {
      if (f && f.path) fs.promises.unlink(f.path).catch(() => {});
    }
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'file_type_invalid';
    return res.redirect(`${getBase(req)}?error=${code}`);
  };
}

function makeSubmissionChatRouter({
  basePath, loadContext, canView, canWrite, getSender, getViewLocals,
}) {
  const router = express.Router({ mergeParams: true });
  const base = (req) => basePath(req);
  function isWritable(req) {
    if (typeof canWrite !== 'function') return true;
    try { return !!canWrite(req); }
    catch { return false; }
  }
  function requireWritable(req, res, next) {
    if (!canView(req)) return forbid(res);
    if (!isWritable(req)) return res.redirect(base(req));
    return next();
  }
  router.get('/', loadContext, handler((req, res) => {
    if (!canView(req)) return forbid(res);
    const sender = getSender(req);
    chat.markRead('submission', req.submission.id, sender.type);
    const q = String(req.query.q || '').trim().slice(0, 200);
    const messages = chat.listMessages('submission', req.submission.id, { q });
    const v = getViewLocals(req);
    return renderWith(res, v.view, v.locals(messages, q));
  }));
  router.get('/messages.json', loadContext, handler((req, res) => {
    if (!canView(req)) return forbid(res);
    const sender = getSender(req);
    chat.markRead('submission', req.submission.id, sender.type);
    const q = String(req.query.q || '').trim().slice(0, 200);
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      messages: chat.listMessages('submission', req.submission.id, { q }),
    });
  }));
  router.post(
    '/messages',
    loadContext,
    requireWritable,
    chatRateLimit('chat_msg'),
    uploadWithFallback(chatUpload.single('file'), uploadErrorRedirect(base)),
    handler((req, res) => {
      const text = String(req.body.message || '').trim().slice(0, 10000);
      const fileRel = req._storageRelativePath || null;
      const fileName = req.file
        ? path.basename(fixFilename(req.file.originalname)).slice(0, 255)
        : null;
      if (!text && !fileRel) return res.redirect(base(req));
      const replyTo = Number(req.body.reply_to_id) || null;
      let validReply = null;
      if (replyTo) {
        const ok = db.prepare(
          'SELECT 1 FROM messages WHERE id = ? AND submission_id = ? AND deleted_at IS NULL'
        ).get(replyTo, req.submission.id);
        if (ok) validReply = replyTo;
      }
      const sender = getSender(req);
      chat.addMessage('submission', req.submission.id, {
        senderType: sender.type,
        senderId: sender.id,
        senderName: sender.name,
        message: text,
        file_path: fileRel,
        file_name: fileName,
        reply_to_id: validReply,
      });
      return res.redirect(base(req));
    })
  );
  router.post('/messages/:messageId/delete', loadContext, handler(async (req, res) => {
    if (!canView(req)) return forbid(res);
    if (!isWritable(req)) return res.redirect(base(req));
    const messageId = Number(req.params.messageId);
    if (!Number.isSafeInteger(messageId) || messageId < 1) return res.redirect(base(req));
    const m = db.prepare(
      'SELECT * FROM messages WHERE id = ? AND submission_id = ?'
    ).get(messageId, req.submission.id);
    const sender = getSender(req);
    if (!m || !chat.canDeleteSubmissionMessage(m, sender.type, sender.id)) {
      return res.redirect(base(req));
    }
    const result = chat.softDelete('submission', messageId, sender.type, sender.id);
    if (result?.file_path) await unlinkChatFile(result.file_path);
    return redirectWith(res, base(req), { deleted: messageId });
  }));
  return router;
}

function makeGroupChatRouter({ basePath, loadContext, canView, canClear, getViewLocals }) {
  const router = express.Router({ mergeParams: true });
  const base = (req) => basePath(req);
  function threadOf(req) {
    const thread = chat.getOrCreateGroupThread(req.group.id, req.session.teacherId);
    if (!thread) throw new Error('Не удалось открыть чат');
    return thread;
  }
  function requireViewable(req, res, next) {
    if (!canView(req)) return forbid(res);
    return next();
  }
  router.get('/', loadContext, handler((req, res) => {
    if (!canView(req)) return forbid(res);
    const thread = threadOf(req);
    chat.markGroupThreadRead(thread.id, 'teacher', req.session.teacherId);
    const q = String(req.query.q || '').trim().slice(0, 200);
    const messages = chat.listMessages('group', thread.id, { q });
    const v = getViewLocals(req, thread);
    return renderWith(res, v.view, v.locals(messages, q));
  }));
  router.get('/messages.json', loadContext, handler((req, res) => {
    if (!canView(req)) return forbid(res);
    const thread = threadOf(req);
    chat.markGroupThreadRead(thread.id, 'teacher', req.session.teacherId);
    const q = String(req.query.q || '').trim().slice(0, 200);
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      messages: chat.listMessages('group', thread.id, { q }),
    });
  }));
  router.post(
    '/messages',
    loadContext,
    requireViewable,
    chatRateLimit('chat_msg'),
    uploadWithFallback(chatUpload.single('file'), uploadErrorRedirect(base)),
    handler((req, res) => {
      const text = String(req.body.message || '').trim().slice(0, 10000);
      const fileRel = req._storageRelativePath || null;
      const fileName = req.file
        ? path.basename(fixFilename(req.file.originalname)).slice(0, 255)
        : null;
      if (!text && !fileRel) return res.redirect(base(req));
      const thread = threadOf(req);
      const replyTo = Number(req.body.reply_to_id) || null;
      let validReply = null;
      if (replyTo) {
        const ok = db.prepare(
          'SELECT 1 FROM group_messages WHERE id = ? AND thread_id = ? AND deleted_at IS NULL'
        ).get(replyTo, thread.id);
        if (ok) validReply = replyTo;
      }
      db.transaction(() => {
        chat.addMessage('group', thread.id, {
          senderType: 'teacher',
          senderId: req.session.teacherId,
          senderName: req.session.teacherName || 'Преподаватель',
          message: text,
          file_path: fileRel,
          file_name: fileName,
          reply_to_id: validReply,
        });
        chat.touchGroupThread(thread.id);
        chat.markGroupThreadRead(thread.id, 'teacher', req.session.teacherId);
      })();
      return res.redirect(base(req));
    })
  );
  router.post('/messages/:messageId/delete', loadContext, handler(async (req, res) => {
    if (!canView(req)) return forbid(res);
    const thread = threadOf(req);
    const messageId = Number(req.params.messageId);
    if (!Number.isSafeInteger(messageId) || messageId < 1) return res.redirect(base(req));
    const m = db.prepare(
      'SELECT * FROM group_messages WHERE id = ? AND thread_id = ?'
    ).get(messageId, thread.id);
    if (!m || !chat.canDeleteGroupMessage(m, 'teacher', req.session.teacherId)) {
      return res.redirect(base(req));
    }
    const result = chat.softDelete('group', messageId, 'teacher', req.session.teacherId);
    if (result?.file_path) await unlinkChatFile(result.file_path);
    return redirectWith(res, base(req), { deleted: messageId });
  }));
  if (canClear) {
    router.post('/clear', loadContext, handler(async (req, res) => {
      if (!canView(req)) return forbid(res);
      const thread = threadOf(req);
      const result = chat.clearMessages('group', thread.id, 'teacher', req.session.teacherId);
      for (const file of result.files) await unlinkChatFile(file);
      return redirectWith(res, base(req), { cleared: 1 });
    }));
  }
  return router;
}

function makeStudentGroupChatRouter({ basePath, loadContext, getViewLocals }) {
  const router = express.Router({ mergeParams: true });
  const base = (req) => basePath(req);
  function threadOf(req) {
    const thread = chat.getOrCreateGroupThread(req.group.id, req.teacher.id);
    if (!thread) throw new Error('Не удалось открыть чат');
    return thread;
  }
  router.get('/', loadContext, handler((req, res) => {
    const thread = threadOf(req);
    chat.markGroupThreadRead(thread.id, 'student', req.me.id);
    const q = String(req.query.q || '').trim().slice(0, 200);
    const messages = chat.listMessages('group', thread.id, { q });
    const v = getViewLocals(req, thread);
    return renderWith(res, v.view, v.locals(messages, q));
  }));
  router.get('/messages.json', loadContext, handler((req, res) => {
    const thread = threadOf(req);
    chat.markGroupThreadRead(thread.id, 'student', req.me.id);
    const q = String(req.query.q || '').trim().slice(0, 200);
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      messages: chat.listMessages('group', thread.id, { q }),
    });
  }));
  router.post(
    '/messages',
    loadContext,
    chatRateLimit('chat_msg'),
    uploadWithFallback(chatUpload.single('file'), uploadErrorRedirect(base)),
    handler((req, res) => {
      const thread = threadOf(req);
      const text = String(req.body.message || '').trim().slice(0, 10000);
      const fileRel = req._storageRelativePath || null;
      const fileName = req.file
        ? path.basename(fixFilename(req.file.originalname)).slice(0, 255)
        : null;
      if (!text && !fileRel) {
        return res.redirect(base(req));
      }
      const replyTo = Number(req.body.reply_to_id) || null;
      let validReply = null;
      if (replyTo) {
        const ok = db.prepare(
          'SELECT 1 FROM group_messages WHERE id = ? AND thread_id = ? AND deleted_at IS NULL'
        ).get(replyTo, thread.id);
        if (ok) validReply = replyTo;
      }
      db.transaction(() => {
        chat.addMessage('group', thread.id, {
          senderType: 'student',
          senderId: req.me.id,
          senderName: req.session.studentName || 'Студент',
          message: text,
          file_path: fileRel,
          file_name: fileName,
          reply_to_id: validReply,
        });
        chat.touchGroupThread(thread.id);
        chat.markGroupThreadRead(thread.id, 'student', req.me.id);
      })();
      return res.redirect(base(req));
    })
  );
  router.post('/messages/:messageId/delete', loadContext, handler(async (req, res) => {
    const thread = threadOf(req);
    const messageId = Number(req.params.messageId);
    if (!Number.isSafeInteger(messageId) || messageId < 1) return res.redirect(base(req));
    const m = db.prepare(
      'SELECT * FROM group_messages WHERE id = ? AND thread_id = ?'
    ).get(messageId, thread.id);
    if (!m || !chat.canDeleteGroupMessage(m, 'student', req.me.id)) {
      return res.redirect(base(req));
    }
    const result = chat.softDelete('group', messageId, 'student', req.me.id);
    if (result?.file_path) await unlinkChatFile(result.file_path);
    return redirectWith(res, base(req), { deleted: messageId });
  }));
  return router;
}

module.exports = {
  makeSubmissionChatRouter,
  makeGroupChatRouter,
  makeStudentGroupChatRouter,
};