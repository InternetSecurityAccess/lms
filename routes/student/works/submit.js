// routes/student/works/submit.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../database');
const filesPolicy = require('../../../config/files');
const config = require('../../../config');
const { submitRateLimit } = require('../../../middleware/rateLimit');
const { fixFilename, safeJoin } = require('../../../utils/helpers');
const { workMultiUpload } = require('../../../utils/storage');
const attachments = require('../../../utils/attachments');
const invalidateCounters = require('../../../utils/counters');
const nowSql = require('../../../utils/dates');

const { checkStudent } = require('../../shared/authz');
const {
  handler,
  renderErr,
  uploadWithFallback,
  readonlyForbid,
} = require('../../shared/handlers');
const { loadStudentRow } = require('../../shared/loaders');

const { toArray, markStatusRead, rejectReadonlySubmission, STUDENT_UNREAD_SQL } = require('./helpers');
const loadFormLocals = require('./load-form-locals');

const express = require('express');
const router = express.Router();

router.post(
  '/t/:teacherId/assignments/:assignmentId/submit',
  checkStudent, loadStudentRow,
  submitRateLimit('submit'),
  uploadWithFallback(
    workMultiUpload.array('work', filesPolicy.MAX_FILES_PER_UPLOAD),
    (err, req, res, next) => {
      renderSubmitUploadError(req, res, err).catch(next);
    }
  ),
  handler(async (req, res) => {
    const files = req.files || [];
    const cleanup = () => {
      for (const f of files) if (f.path) fs.promises.unlink(f.path).catch(() => {});
    };
    const teacherId = Number(req.params.teacherId);
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isSafeInteger(teacherId) || !Number.isSafeInteger(assignmentId)) {
      cleanup();
      return res.status(404).render('common/error', {
        title: 'Не найдено', message: 'Задание не найдено.',
      });
    }
    const me = req.me;
    const assignment = db.prepare(`
      SELECT a.*, s.status AS subject_status, t.status AS teacher_status
      FROM assignments a
      JOIN subjects s ON s.id = a.subject_id
      JOIN teachers t ON t.id = s.teacher_id
      WHERE a.id = ? AND a.teacher_id = ? AND a.deleted_at IS NULL
        AND s.deleted_at IS NULL AND t.deleted_at IS NULL
    `).get(assignmentId, teacherId);
    if (!assignment) {
      cleanup();
      return res.status(404).render('common/error', {
        title: 'Не найдено', message: 'Задание не найдено.',
      });
    }
    // Студент должен быть в активной паре subject_groups.
    const activePair = !!db.prepare(
      'SELECT 1 FROM subject_groups WHERE subject_id = ? AND group_id = ?'
    ).get(assignment.subject_id, me.group_id);
    if (!activePair) {
      cleanup();
      return readonlyForbid(res, 'Задание');
    }
    // Тема-обёртка: available_from должен уже наступить.
    const topicGate = db.prepare(`
      SELECT available_from FROM topics
      WHERE assignment_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(assignmentId);
    if (topicGate && topicGate.available_from && topicGate.available_from > nowSql()) {
      cleanup();
      return readonlyForbid(res, 'Задание');
    }
    if (me.group_status !== 'active'
        || assignment.status !== 'active'
        || assignment.subject_status !== 'active'
        || assignment.teacher_status !== 'active') {
      cleanup();
      return readonlyForbid(res, 'Задание');
    }
    const externalUrl = String(req.body.external_url || '').trim().slice(0, 1000);
    const hasFiles = files.length > 0;
    const hasUrl = !!externalUrl;
    if (hasUrl && !/^https?:\/\//i.test(externalUrl)) {
      cleanup();
      return renderErr(res, 'student/content/assignment-submit',
        await loadFormLocals(me, teacherId, assignmentId),
        'Ссылка должна начинаться с http:// или https://.');
    }
    const comment = String(req.body.comment || '').trim().slice(0, 2000);
    const removeFileIds = toArray(req.body.remove_file_ids).map(Number).filter((n) => n > 0);
    const existing = db.prepare(`
      SELECT * FROM submissions
      WHERE assignment_id = ? AND student_id = ? AND deleted_at IS NULL
      ORDER BY uploaded_at DESC LIMIT 1
    `).get(assignmentId, me.id);
    if (existing) {
      if (existing.status === 'accepted') {
        cleanup();
        return renderErr(res, 'student/content/assignment-submit',
          await loadFormLocals(me, teacherId, assignmentId),
          'Работа по этому заданию уже принята. Сдача новой версии невозможна.', 409);
      }
      const oldFiles = attachments.listAttachments('submission', existing.id);
      const filesToRemove = oldFiles.filter((f) => removeFileIds.includes(f.id));
      const filesToKeep = oldFiles.filter((f) => !removeFileIds.includes(f.id));
      const filesAfterCount = filesToKeep.length + (hasFiles ? files.length : 0);
      if (filesAfterCount === 0 && !hasUrl) {
        cleanup();
        return renderErr(res, 'student/content/assignment-submit',
          await loadFormLocals(me, teacherId, assignmentId),
          'Нечего сохранять: должен остаться хотя бы один файл или ссылка.');
      }
      const removedStored = [];
      try {
        db.transaction(() => {
          for (const f of filesToRemove) {
            removedStored.push(f.stored_name);
            attachments.removeAttachment(f.id);
          }
          for (let i = 0; i < files.length; i++) {
            attachments.addAttachment('submission', existing.id, {
              stored_name: req.storedNames[i],
              filename: path.basename(fixFilename(files[i].originalname)).slice(0, 255),
              filesize: files[i].size,
            });
          }
          db.prepare(`
            UPDATE submissions
            SET topic = ?, external_url = ?, comment = ?,
                status = 'pending', uploaded_at = CURRENT_TIMESTAMP,
                pc_name = ?, ip_address = ?, user_agent = ?,
                ai_flag = 0, ai_flag_read_by_student = 0
            WHERE id = ?
          `).run(
            assignment.title,
            hasUrl ? externalUrl : null, comment || null,
            req.clientPcName || 'unknown', req.clientIp || 'unknown',
            req.clientUserAgent || 'unknown',
            existing.id
          );
          db.prepare('DELETE FROM submission_status_reads WHERE submission_id = ?')
            .run(existing.id);
          const parts = ['Загружена новая версия работы.'];
          if (hasFiles) parts.push(`Добавлено файлов: ${files.length}.`);
          if (filesToRemove.length > 0) parts.push(`Удалено файлов: ${filesToRemove.length}.`);
          if (hasUrl) parts.push(`Ссылка: ${externalUrl}.`);
          else if (existing.external_url && !hasUrl) parts.push('Ссылка удалена.');
          let msg = parts.join(' ');
          if (comment) msg += `\n\n${comment}`;
          db.prepare(`
            INSERT INTO messages (submission_id, sender_type, sender_id, sender_name, message)
            VALUES (?, 'student', ?, ?, ?)
          `).run(existing.id, req.session.studentId, req.session.studentName || 'Студент', msg);
        })();
        for (const name of removedStored) {
          try { await fs.promises.unlink(safeJoin(config.UPLOAD_DIR, name)); } catch (e) {
            if (e.code !== 'ENOENT') console.error('unlink:', e);
          }
        }
        invalidateCounters(req.sessionID);
        return res.redirect(`/t/${teacherId}/works/${existing.id}?replaced=1`);
      } catch (e) {
        cleanup();
        throw e;
      }
    }
    if (!hasFiles && !hasUrl) {
      cleanup();
      return renderErr(res, 'student/content/assignment-submit',
        await loadFormLocals(me, teacherId, assignmentId),
        'Приложите файл или укажите ссылку.');
    }
    let submissionId;
    try {
      submissionId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO submissions (
            student_id, teacher_id, group_id, assignment_id, topic,
            comment, external_url, pc_name, ip_address, user_agent
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          me.id, teacherId, me.group_id, assignmentId, assignment.title,
          comment, hasUrl ? externalUrl : null,
          req.clientPcName, req.clientIp, req.clientUserAgent
        );
        const sid = Number(r.lastInsertRowid);
        for (let i = 0; i < files.length; i++) {
          attachments.addAttachment('submission', sid, {
            stored_name: req.storedNames[i],
            filename: path.basename(fixFilename(files[i].originalname)).slice(0, 255),
            filesize: files[i].size,
          });
        }
        return sid;
      })();
    } catch (txErr) {
      cleanup();
      throw txErr;
    }
    invalidateCounters(req.sessionID);
    return res.redirect(`/t/${teacherId}/assignments/${assignmentId}?uploaded=1`);
  })
);

module.exports = router;
