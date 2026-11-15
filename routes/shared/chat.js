'use strict';
const db = require('../../database');
// ═══════════════════════════════════════════════════════════
// ВАЖНО: разные sender_type в разных чатах
// ═══════════════════════════════════════════════════════════
//   submission (чат по работе):  'student' | 'teacher'
//   group (групповой чат):       'student' | 'teacher'
//   support (поддержка):         'user'    | 'admin'
//
// В support «user» — это либо студент, либо преподаватель (в зависимости от того,
// чей это тред). В submission/group роль однозначная — берётся из сессии.
//
// Если добавляете четвёртый тип чата — определите sender_types явно в KINDS.
// Не полагайтесь на то, что «user» везде значит студента: в support это и
// преподаватель тоже.
// ═══════════════════════════════════════════════════════════
const KINDS = {
  submission: {
    table: 'messages',
    parentKey: 'submission_id',
    senderTypes: ['student', 'teacher'],
    hasReply: true,
    hasRead: true,
    messageNotNull: false,
  },
  group: {
    table: 'group_messages',
    parentKey: 'thread_id',
    senderTypes: ['student', 'teacher'],
    hasReply: true,
    hasRead: false,
    messageNotNull: false,
  },
  support: {
    table: 'support_messages',
    parentKey: 'thread_id',
    senderTypes: ['user', 'admin'],
    hasReply: false,
    hasRead: true,
    messageNotNull: true,
  },
};

const configOf = (kind) => {
  const c = KINDS[kind];
  if (!c) throw new Error(`Unknown chat kind: ${kind}`);
  return c;
};

function normalizeMessage(kind, value) {
  const c = configOf(kind);
  const isEmpty = value == null || value === '';
  if (c.messageNotNull) return isEmpty ? '' : String(value);
  return isEmpty ? null : String(value);
}

function listMessages(kind, parentId, { q = '' } = {}) {
  const c = configOf(kind);
  const where = ['m.deleted_at IS NULL'];
  const params = [parentId];
  if (q) {
    where.push('m.message LIKE ?');
    params.push(`%${q}%`);
  }
  const cols = [
    'm.id', 'm.sender_type', 'm.sender_id', 'm.sender_name',
    'm.message', 'm.file_path', 'm.file_name', 'm.created_at', 'm.deleted_at',
  ];
  if (c.hasRead) cols.push('m.is_read');
  if (c.hasReply) cols.push('m.reply_to_id');
  let from = `FROM ${c.table} m`;
  if (c.hasReply) {
    from += ` LEFT JOIN ${c.table} r ON r.id = m.reply_to_id`;
    cols.push('r.sender_name AS reply_sender', 'r.message AS reply_text');
  }
  return db.prepare(`
    SELECT ${cols.join(', ')}
    ${from}
    WHERE m.${c.parentKey} = ? AND ${where.join(' AND ')}
    ORDER BY m.created_at ASC, m.id ASC
  `).all(...params);
}

function addMessage(kind, parentId, payload) {
  const c = configOf(kind);
  if (!c.senderTypes.includes(payload.senderType)) {
    throw new Error(`Invalid sender_type "${payload.senderType}" for ${kind}`);
  }
  const cols = [
    c.parentKey, 'sender_type', 'sender_id', 'sender_name',
    'message', 'file_path', 'file_name',
  ];
  const vals = [
    parentId, payload.senderType, payload.senderId, payload.senderName,
    normalizeMessage(kind, payload.message),
    payload.file_path || null, payload.file_name || null,
  ];
  if (c.hasReply) {
    cols.push('reply_to_id');
    vals.push(payload.reply_to_id || null);
  }
  const placeholders = cols.map(() => '?').join(', ');
  const r = db.prepare(
    `INSERT INTO ${c.table} (${cols.join(', ')}) VALUES (${placeholders})`
  ).run(...vals);
  return Number(r.lastInsertRowid);
}

function softDelete(kind, messageId, byType, byId) {
  const c = configOf(kind);
  const m = db.prepare(`SELECT * FROM ${c.table} WHERE id = ?`).get(messageId);
  if (!m || m.deleted_at) return null;
  db.prepare(`
    UPDATE ${c.table}
    SET message = ?, file_path = NULL, file_name = NULL,
        deleted_at = CURRENT_TIMESTAMP, deleted_by_type = ?, deleted_by_id = ?
    WHERE id = ?
  `).run(normalizeMessage(kind, null), byType, byId, messageId);
  return { file_path: m.file_path, message: m };
}

function clearMessages(kind, parentId, byType, byId) {
  const c = configOf(kind);
  const rows = db.prepare(`
    SELECT id, file_path FROM ${c.table}
    WHERE ${c.parentKey} = ? AND deleted_at IS NULL
  `).all(parentId);
  if (rows.length === 0) return { count: 0, files: [] };
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  db.prepare(`
    UPDATE ${c.table}
    SET message = ?, file_path = NULL, file_name = NULL,
        deleted_at = CURRENT_TIMESTAMP, deleted_by_type = ?, deleted_by_id = ?
    WHERE id IN (${ph})
  `).run(normalizeMessage(kind, null), byType, byId, ...ids);
  return {
    count: rows.length,
    files: rows.filter((r) => r.file_path).map((r) => r.file_path),
  };
}

function markRead(kind, parentId, readerSide) {
  const c = configOf(kind);
  if (!c.hasRead) return;
  if (kind === 'submission') {
    const opposite = readerSide === 'teacher' ? 'student' : 'teacher';
    db.prepare(`
      UPDATE messages SET is_read = 1
      WHERE submission_id = ? AND sender_type = ? AND is_read = 0 AND deleted_at IS NULL
    `).run(parentId, opposite);
  } else if (kind === 'support') {
    const opposite = readerSide === 'admin' ? 'user' : 'admin';
    db.prepare(`
      UPDATE support_messages SET is_read = 1
      WHERE thread_id = ? AND sender_type = ? AND is_read = 0
    `).run(parentId, opposite);
  }
}

function getOrCreateGroupThread(groupId, teacherId) {
  const gid = Number(groupId);
  const tid = Number(teacherId);
  if (!Number.isSafeInteger(gid) || gid < 1) return null;
  if (!Number.isSafeInteger(tid) || tid < 1) return null;
  const existing = db.prepare(
    'SELECT * FROM group_threads WHERE group_id = ? AND teacher_id = ?'
  ).get(gid, tid);
  if (existing) return existing;
  try {
    const r = db.prepare(
      'INSERT INTO group_threads (group_id, teacher_id) VALUES (?, ?)'
    ).run(gid, tid);
    return db.prepare('SELECT * FROM group_threads WHERE id = ?').get(r.lastInsertRowid);
  } catch {
    return db.prepare(
      'SELECT * FROM group_threads WHERE group_id = ? AND teacher_id = ?'
    ).get(gid, tid);
  }
}

function touchGroupThread(threadId) {
  db.prepare(
    'UPDATE group_threads SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(threadId);
}

function markGroupThreadRead(threadId, readerType, readerId) {
  if (!['student', 'teacher'].includes(readerType)) return;
  db.prepare(`
    INSERT INTO group_thread_reads (thread_id, reader_type, reader_id, last_read_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(thread_id, reader_type, reader_id) DO UPDATE SET
      last_read_at = CURRENT_TIMESTAMP
  `).run(threadId, readerType, Number(readerId));
}

// ← ИЗМЕНЕНО: добавлен try/catch вокруг INSERT. При параллельных запросах
// (двойной клик, авто-retry) UNIQUE INDEX на support_threads(student_id)
// / support_threads(teacher_id) выбросит SQLITE_CONSTRAINT — ловим и
// возвращаем уже созданный тред из БД. Раньше второй запрос получал 500.
function getOrCreateSupportThread(req) {
  if (req.session?.studentId) {
    const sid = Number(req.session.studentId);
    const existing = db.prepare(
      'SELECT * FROM support_threads WHERE student_id = ?'
    ).get(sid);
    if (existing) return existing;
    try {
      const r = db.prepare(
        'INSERT INTO support_threads (student_id) VALUES (?)'
      ).run(sid);
      return db.prepare('SELECT * FROM support_threads WHERE id = ?')
        .get(r.lastInsertRowid);
    } catch (e) {
      const fallback = db.prepare(
        'SELECT * FROM support_threads WHERE student_id = ?'
      ).get(sid);
      if (fallback) return fallback;
      throw e;
    }
  }
  if (req.session?.teacherId) {
    const tid = Number(req.session.teacherId);
    const existing = db.prepare(
      'SELECT * FROM support_threads WHERE teacher_id = ?'
    ).get(tid);
    if (existing) return existing;
    try {
      const r = db.prepare(
        'INSERT INTO support_threads (teacher_id) VALUES (?)'
      ).run(tid);
      return db.prepare('SELECT * FROM support_threads WHERE id = ?')
        .get(r.lastInsertRowid);
    } catch (e) {
      const fallback = db.prepare(
        'SELECT * FROM support_threads WHERE teacher_id = ?'
      ).get(tid);
      if (fallback) return fallback;
      throw e;
    }
  }
  return null;
}

function touchSupportThread(threadId) {
  db.prepare(
    'UPDATE support_threads SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(threadId);
}

/* ═══════════════════════════════════════════════════════════
   countUnreadForTeacher / countUnreadForStudent

   Добавлен JOIN groups с deleted_at IS NULL. Причина: списки
   /my-group-chats и /my-chats показывают только живые группы.
   Если группа в корзине, её сообщения не должны «висеть» в
   бейдже в меню — иначе пользователь видит «3», открывает
   список, а там пусто.
   ═══════════════════════════════════════════════════════════ */
function countUnreadForTeacher(teacherId) {
  const tid = Number(teacherId);
  if (!Number.isSafeInteger(tid) || tid < 1) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS c
    FROM group_messages gm
    JOIN group_threads gt ON gt.id = gm.thread_id
    JOIN groups g ON g.id = gt.group_id AND g.deleted_at IS NULL
    LEFT JOIN group_thread_reads gtr
      ON gtr.thread_id = gt.id
      AND gtr.reader_type = 'teacher'
      AND gtr.reader_id = @tid
    WHERE gt.teacher_id = @tid
      AND gm.deleted_at IS NULL
      AND (gm.sender_type <> 'teacher' OR gm.sender_id <> @tid)
      AND (gtr.last_read_at IS NULL OR gm.created_at > gtr.last_read_at)
  `).get({ tid });
  return Number(row?.c || 0);
}

function countUnreadForStudent(studentId) {
  const sid = Number(studentId);
  if (!Number.isSafeInteger(sid) || sid < 1) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS c
    FROM group_messages gm
    JOIN group_threads gt ON gt.id = gm.thread_id
    JOIN groups g ON g.id = gt.group_id AND g.deleted_at IS NULL
    JOIN students s ON s.group_id = gt.group_id AND s.id = @sid
    LEFT JOIN group_thread_reads gtr
      ON gtr.thread_id = gt.id
      AND gtr.reader_type = 'student'
      AND gtr.reader_id = @sid
    WHERE gm.deleted_at IS NULL
      AND (gm.sender_type <> 'student' OR gm.sender_id <> @sid)
      AND (gtr.last_read_at IS NULL OR gm.created_at > gtr.last_read_at)
  `).get({ sid });
  return Number(row?.c || 0);
}

function canDeleteSubmissionMessage(msg, viewerRole, viewerId) {
  if (!msg || msg.deleted_at) return false;
  return msg.sender_type === viewerRole
    && Number(msg.sender_id) === Number(viewerId);
}

function canDeleteGroupMessage(msg, viewerRole, viewerId) {
  if (!msg || msg.deleted_at) return false;
  if (viewerRole === 'teacher') return true;
  return msg.sender_type === 'student'
    && Number(msg.sender_id) === Number(viewerId);
}

function canDeleteSupportMessage(msg, viewerRole) {
  if (!msg || msg.deleted_at) return false;
  if (viewerRole === 'admin') return true;
  return msg.sender_type === 'user';
}

module.exports = {
  KINDS,
  listMessages, addMessage, softDelete, clearMessages, markRead,
  getOrCreateGroupThread, touchGroupThread, markGroupThreadRead,
  getOrCreateSupportThread, touchSupportThread,
  countUnreadForTeacher, countUnreadForStudent,
  canDeleteSubmissionMessage, canDeleteGroupMessage, canDeleteSupportMessage,
};