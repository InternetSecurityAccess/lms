// utils/storage/paths.js
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../../config');
const db = require('../../database');

// SUPPORT_FILES_DIR = data/storage/support.
// file_path в support_messages хранится относительно этой папки:
// '<s|t><userId>/sup-<uuid>.<ext>'.
const SUPPORT_FILES_DIR = config.SUPPORT_FILES_DIR;

const PREFIX = {
  work: 'work-',
  chat: 'chat-',
  lecture: 'lecture-',
  assignment: 'assignment-',
  lecture_image: '',
  support: 'sup-',
};

const filenamePrefix = (kind) => PREFIX[kind] ?? '';

// Достаём subjectId из assignment. Используется для 'work' и 'chat' (submission).
// Один SQL на файл — приемлемо, файлов в одной загрузке <= MAX_FILES_PER_UPLOAD.
function getSubjectIdByAssignment(assignmentId) {
  const row = db.prepare('SELECT subject_id FROM assignments WHERE id = ?')
    .get(Number(assignmentId));
  if (!row) throw new Error(`assignment ${assignmentId} not found`);
  return Number(row.subject_id);
}

/**
 * Возвращает { targetDir, relativeDir, meta? }.
 * targetDir — абсолютный путь, куда физически писать файл.
 * relativeDir — префикс от STORAGE_DIR, попадёт в req._storageRelativePath
 *               и в БД (attachments.stored_name / messages.file_path).
 * meta — служебные поля (для lecture_image).
 *
 * Структура — «по сущности», не по дате:
 *   subjects/<subjectId>/lectures/...                       — вложения к темам
 *   subjects/<subjectId>/lecture-images/...                 — картинки Quill
 *   subjects/<subjectId>/assignments/...                    — вложения к заданиям
 *   subjects/<subjectId>/works/<assignmentId>/<studentId>/  — сдачи и их чаты
 *   groups/<groupId>/<teacherId>/                           — групповой чат
 *   support/<s|t><userId>/                                  — скриншоты поддержки
 *
 * Все ID на момент загрузки уже есть в req:
 *   req.subject (loadSubjectAsTeacher) — для lecture/assignment/lecture_image
 *   req.submission (loadSubmissionAs*) — для work/chat (submission)
 *   req.group (loadGroupAs*) — для chat (group)
 *   req.session.studentId/teacherId — для support
 */
function getStorageDir(kind, req) {
  const storageDir = config.STORAGE_DIR;
  const uuid = crypto.randomUUID();

  switch (kind) {
    case 'work': {
      // subjects/<subjectId>/works/<assignmentId>/<studentId>/
      const assignmentId = Number(req.params.assignmentId || req.body?.assignment_id);
      const studentId = Number(req.session?.studentId);
      if (!assignmentId || !studentId) {
        throw new Error('work: missing assignmentId/studentId in request');
      }
      const subjectId = getSubjectIdByAssignment(assignmentId);
      const relativeDir = path.posix.join(
        'subjects', String(subjectId), 'works',
        String(assignmentId), String(studentId)
      );
      return {
        targetDir: path.join(storageDir, relativeDir),
        relativeDir,
      };
    }

    case 'chat': {
      // Чат по работе: subjects/<subjectId>/works/<assignmentId>/<studentId>/
      // Та же папка, что work, — файлы сдачи и файлы чата лежат рядом.
      if (req.submission) {
        const sub = req.submission;
        const subjectId = getSubjectIdByAssignment(sub.assignment_id);
        const relativeDir = path.posix.join(
          'subjects', String(subjectId), 'works',
          String(sub.assignment_id), String(sub.student_id)
        );
        return {
          targetDir: path.join(storageDir, relativeDir),
          relativeDir,
        };
      }
      // Групповой чат: groups/<groupId>/<teacherId>/
      // teacherId — из сессии (препод) или из req.teacher (студент смотрит чат препода).
      if (req.group) {
        const groupId = Number(req.group.id);
        const teacherId = Number(req.session?.teacherId || req.teacher?.id);
        if (!groupId || !teacherId) {
          throw new Error('group chat: missing groupId/teacherId in request');
        }
        const relativeDir = path.posix.join(
          'groups', String(groupId), String(teacherId)
        );
        return {
          targetDir: path.join(storageDir, relativeDir),
          relativeDir,
        };
      }
      throw new Error('chat: neither req.submission nor req.group present');
    }

    case 'lecture': {
      // subjects/<subjectId>/lectures/
      // topicId на момент загрузки нет (multer срабатывает до INSERT topics),
      // поэтому группируем по предмету — все вложения всех тем предмета рядом.
      // Привязка к конкретной теме — через attachments.owner_kind='topic'.
      const subjectId = Number(req.subject?.id);
      if (!subjectId) throw new Error('lecture: missing subjectId in request');
      const relativeDir = path.posix.join('subjects', String(subjectId), 'lectures');
      return {
        targetDir: path.join(storageDir, relativeDir),
        relativeDir,
      };
    }

    case 'assignment': {
      // subjects/<subjectId>/assignments/
      // assignmentId на момент создания задания ещё нет — группируем по предмету.
      const subjectId = Number(req.subject?.id);
      if (!subjectId) throw new Error('assignment: missing subjectId in request');
      const relativeDir = path.posix.join('subjects', String(subjectId), 'assignments');
      return {
        targetDir: path.join(storageDir, relativeDir),
        relativeDir,
      };
    }

    case 'lecture_image': {
      // subjects/<subjectId>/lecture-images/
      // Картинка загружается до создания темы (в Quill), topicId нет.
      // Группируем по предмету — все картинки предмета рядом.
      const subjectId = Number(req.subject?.id);
      if (!subjectId) throw new Error('lecture_image: missing subjectId in request');
      const relativeDir = path.posix.join('subjects', String(subjectId), 'lecture-images');
      return {
        targetDir: path.join(storageDir, relativeDir),
        relativeDir,
        meta: { subjectId, shard: uuid.slice(0, 2) },
      };
    }

    case 'support': {
      // support/<s|t><userId>/
      // Разделяем студента и препода префиксом, чтобы studentId=5 и teacherId=5
      // не попали в одну папку.
      const studentId = Number(req.session?.studentId);
      const teacherId = Number(req.session?.teacherId);
      if (!studentId && !teacherId) {
        throw new Error('support: missing userId in session');
      }
      const folder = studentId ? `s${studentId}` : `t${teacherId}`;
      return {
        targetDir: path.join(SUPPORT_FILES_DIR, folder),
        relativeDir: folder,
      };
    }

    default:
      throw new Error(`Unknown storage kind: ${kind}`);
  }
}

module.exports = { SUPPORT_FILES_DIR, getStorageDir, filenamePrefix };