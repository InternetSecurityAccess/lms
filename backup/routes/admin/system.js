// routes/admin/system.js
'use strict';
const { nowSql } = require('../../utils/dates');
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const router = express.Router();
const db = require('../../database');
const settings = require('../../config/settings');
const config = require('../../config');
const { checkAdmin } = require('../shared/authz');
const { handler, renderWith, parseIdOr404, notFound, audit } = require('../shared/handlers');
const {
  isExtendedAuditActive, isExtendedAllActive, getActionLabel,
} = require('../../utils/audit');
const { toCsv, parseCsv, pick } = require('../../utils/csv');
const { bumpSessionVersion } = require('../../utils/sessions');
const { composeName } = require('../../utils/names');
const {
  randomNumericPassword, validatePassword,
} = require('../../utils/password-policy');
const lifecycle = require('../../utils/lifecycle');
const {
  validateTeacherLogin, validateStudentLoginAuto,
  normalizeStudentLoginAuto, normalizeTeacherLogin,
} = require('../../utils/login-validation');
const PAGE_SIZE = 100;
function buildAuditFilters(req) {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const actorType = ['all', 'admin', 'teacher', 'student', 'anonymous'].includes(req.query.actor_type)
    ? req.query.actor_type : 'all';
  const action = String(req.query.action || '').trim().slice(0, 100);
  const period = ['all', 'today', 'week', 'month'].includes(req.query.period)
    ? req.query.period : 'all';
  let where = ' WHERE 1=1';
  const params = {};
  if (q) {
    where += ' AND (action LIKE @q OR actor_name LIKE @q OR details LIKE @q OR ip LIKE @q)';
    params.q = `%${q}%`;
  }
  if (actorType !== 'all') { where += ' AND actor_type = @actorType'; params.actorType = actorType; }
  if (action) { where += ' AND action = @action'; params.action = action; }
  if (period === 'today') where += " AND created_at >= datetime('now', 'start of day')";
  else if (period === 'week') where += " AND created_at >= datetime('now', '-7 days')";
  else if (period === 'month') where += " AND created_at >= datetime('now', '-30 days')";
  return { q, actorType, action, period, where, params };
}
router.get(
  '/admin/audit',
  checkAdmin,
  handler((req, res) => {
    const { q, actorType, action, period, where, params } = buildAuditFilters(req);
    const page = Math.max(1, Number(req.query.page) || 1);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM audit_log ${where}`).get(params).count;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, pages);
    const offset = (safePage - 1) * PAGE_SIZE;
    const raw = db.prepare(`
      SELECT id, actor_type, actor_id, actor_name, action,
             target_type, target_id, details, ip, user_agent, created_at
      FROM audit_log ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `).all(params);
    const rows = raw.map((r) => {
      let details = null;
      if (r.details) { try { details = JSON.parse(r.details); } catch { details = r.details; } }
      return { ...r, details, actionLabel: getActionLabel(r.action) };
    });
    const actionList = db.prepare(
      'SELECT DISTINCT action FROM audit_log ORDER BY action'
    ).all().map((r) => ({ code: r.action, label: getActionLabel(r.action) }));
    const extActive = isExtendedAuditActive();
    const extAllActive = isExtendedAllActive();
    const extUntil = settings.get('audit.extendedUntil');
    const extUntilText = extUntil ? new Date(Number(extUntil)).toLocaleString('ru-RU') : null;
    const retentionDays = Math.max(1, Number(settings.get('audit.retentionDays')) || 1500);
    return renderWith(res, 'admin/system/audit', {
      title: 'Аудит',
      rows, total, page: safePage, pages, PAGE_SIZE,
      q, actorType, action, period, actionList,
      cleaned: req.query.cleaned === '1',
      cleanupCount: req.query.deleted ? Number(req.query.deleted) : null,
      extendedAuditActive: extActive,
      extendedAllActive: extAllActive,
      extendedAuditUntilText: extUntilText,
      auditRetentionDays: retentionDays,
    });
  })
);
router.get(
  '/admin/audit/export',
  checkAdmin,
  handler((req, res) => {
    const { where, params } = buildAuditFilters(req);
    const rows = db.prepare(`
      SELECT id, created_at, actor_type, actor_id, actor_name,
             action, target_type, target_id, details, ip, user_agent
      FROM audit_log ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT 10000
    `).all(params);
    const csv = toCsv(rows, [
      'id', 'created_at', 'actor_type', 'actor_id', 'actor_name',
      'action', 'target_type', 'target_id', 'details', 'ip', 'user_agent',
    ]);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent('audit-' + date + '.csv')}`);
    return res.send(csv);
  })
);
router.post(
  '/admin/audit/cleanup',
  checkAdmin,
  handler((req, res) => {
    const days = Math.max(1, Number(req.body.days) || 1500);
    const r = db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)")
      .run(`-${days} days`);
    audit(req, 'audit.cleanup', 'audit', null, { days, deleted: r.changes });
    return res.redirect(`/admin/audit?cleaned=1&deleted=${r.changes}`);
  })
);
router.get(
  '/admin/slow-log',
  checkAdmin,
  handler((req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const period = ['all', 'hour', 'day', 'week'].includes(req.query.period)
      ? req.query.period : 'day';
    const page = Math.max(1, Number(req.query.page) || 1);
    let where = ' WHERE 1=1';
    const params = {};
    if (q) { where += ' AND (path LIKE @q OR role LIKE @q OR ip LIKE @q)'; params.q = `%${q}%`; }
    if (period === 'hour') where += " AND created_at >= datetime('now', '-1 hour')";
    else if (period === 'day') where += " AND created_at >= datetime('now', '-1 day')";
    else if (period === 'week') where += " AND created_at >= datetime('now', '-7 days')";
    const total = db.prepare(`SELECT COUNT(*) AS c FROM slow_log ${where}`).get(params).c;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, pages);
    const offset = (safePage - 1) * PAGE_SIZE;
    const rows = db.prepare(`
      SELECT * FROM slow_log ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `).all(params);
    return renderWith(res, 'admin/system/slow-log', {
      title: 'Slow-log',
      rows, total, page: safePage, pages, PAGE_SIZE,
      q, period,
      cleaned: req.query.cleaned === '1',
      cleanupCount: req.query.deleted ? Number(req.query.deleted) : null,
    });
  })
);
router.post(
  '/admin/slow-log/cleanup',
  checkAdmin,
  handler((req, res) => {
    const days = Math.max(1, Number(req.body.days) || 30);
    const r = db.prepare("DELETE FROM slow_log WHERE created_at < datetime('now', ?)")
      .run(`-${days} days`);
    audit(req, 'slow_log.cleanup', 'slow_log', null, { days, deleted: r.changes });
    return res.redirect(`/admin/slow-log?cleaned=1&deleted=${r.changes}`);
  })
);
const ROLE_TABLE = { admin: 'admins', teacher: 'teachers', student: 'students' };
function loadSessionItems() {
  const rows = db.prepare(
    'SELECT sid, sess, expire FROM sessions WHERE expire > ? ORDER BY expire DESC'
  ).all(Date.now());
  const items = [];
  for (const row of rows) {
    let sess = null;
    try { sess = JSON.parse(row.sess); } catch { /* ignore */ }
    if (!sess) continue;
    let role = null, userId = null, userName = null, userLogin = null;
    let currentVersion = null;
    if (sess.adminId) {
      role = 'admin'; userId = sess.adminId;
      const u = db.prepare('SELECT name, session_version FROM admins WHERE id = ?').get(userId);
      userName = u?.name; userLogin = u?.name; currentVersion = u?.session_version;
    } else if (sess.teacherId) {
      role = 'teacher'; userId = sess.teacherId;
      const u = db.prepare(
        'SELECT name, login, status, deleted_at, session_version FROM teachers WHERE id = ?'
      ).get(userId);
      userName = u?.name; userLogin = u?.login; currentVersion = u?.session_version;
      if (!u || u.deleted_at || u.status !== 'active') {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
        continue;
      }
    } else if (sess.studentId) {
      role = 'student'; userId = sess.studentId;
      const u = db.prepare(
        'SELECT name, login, status, deleted_at, session_version FROM students WHERE id = ?'
      ).get(userId);
      userName = u?.name; userLogin = u?.login; currentVersion = u?.session_version;
      if (!u || u.deleted_at || u.status === 'rejected') {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
        continue;
      }
    }
    if (!role) continue;
    if (currentVersion == null || Number(sess.sessionVersion) !== Number(currentVersion)) {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
      continue;
    }
    items.push({
      sid: row.sid, sidShort: row.sid.slice(0, 12) + '…',
      expire: row.expire, role, userId,
      userName: userName || '—', userLogin: userLogin || '',
      sessionVersion: sess.sessionVersion || null,
    });
  }
  return items;
}
router.get(
  '/admin/sessions',
  checkAdmin,
  handler((req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const roleFilter = ['all', 'admin', 'teacher', 'student'].includes(req.query.role)
      ? req.query.role : 'all';
    let items = loadSessionItems();
    if (roleFilter !== 'all') items = items.filter((i) => i.role === roleFilter);
    if (q) {
      const needle = q.toLowerCase();
      items = items.filter((i) =>
        (i.userName || '').toLowerCase().includes(needle)
        || (i.userLogin || '').toLowerCase().includes(needle));
    }
    const groups = new Map();
    for (const it of items) {
      const key = `${it.role}:${it.userId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const grouped = Array.from(groups.values()).map((sessions) => ({
      role: sessions[0].role, userId: sessions[0].userId,
      userName: sessions[0].userName, userLogin: sessions[0].userLogin,
      sessions,
    }));
    return renderWith(res, 'admin/system/sessions', {
      title: 'Активные сессии', grouped,
      q, roleFilter,
      totalSessions: items.length, totalUsers: grouped.length,
      justDeleted: req.query.deleted === '1',
      justLoggedOut: req.query.logged_out === '1',
    });
  })
);
router.post(
  '/admin/sessions/:sid/delete',
  checkAdmin,
  handler((req, res) => {
    const sid = String(req.params.sid || '');
    if (!sid) return res.redirect('/admin/sessions');
    const r = db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    if (r.changes) audit(req, 'session.delete', 'session', null, { sid: sid.slice(0, 12) });
    return res.redirect('/admin/sessions?deleted=1');
  })
);
router.post(
  '/admin/sessions/user/:role/:id/logout-all',
  checkAdmin,
  handler((req, res) => {
    const role = String(req.params.role || '');
    const id = Number(req.params.id);
    if (!ROLE_TABLE[role] || !Number.isSafeInteger(id) || id < 1) {
      return res.redirect('/admin/sessions');
    }
    const table = ROLE_TABLE[role];
    const r = db.prepare(
      `UPDATE ${table} SET session_version = session_version + 1 WHERE id = ?`
    ).run(id);
    if (r.changes) audit(req, 'session.logout_all', role, id, {});
    return res.redirect('/admin/sessions?logged_out=1');
  })
);
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});
const VALID_MODES = ['create', 'update', 'upsert', 'delete'];
const VALID_GROUP_MODES = ['create', 'upsert', 'delete'];
const MAX_IMPORT_ROWS = 2000;
const GENERATED_PASSWORD_LENGTH = 8;
function parseMode(raw, allowed = VALID_MODES) {
  const m = String(raw || 'create').trim();
  return allowed.includes(m) ? m : 'create';
}
function parseNameParts(row) {
  const rawLast = pick(row, ['last_name', 'фамилия']);
  const rawFirst = pick(row, ['first_name', 'имя']);
  const rawMiddle = pick(row, ['middle_name', 'отчество']);
  if (rawLast.length > 100 || rawFirst.length > 100 || rawMiddle.length > 100) {
    return { error: 'одно из полей ФИО длиннее 100 символов' };
  }
  if (rawLast || rawFirst) {
    return {
      last_name: rawLast, first_name: rawFirst, middle_name: rawMiddle,
      name: composeName(rawLast, rawFirst, rawMiddle),
    };
  }
  const full = pick(row, ['name', 'фио']).slice(0, 200);
  const parts = full.split(/\s+/).filter(Boolean);
  return {
    last_name: parts[0] || '', first_name: parts[1] || '',
    middle_name: parts[2] || '', name: full,
  };
}
function parseStatus(row) {
  const s = pick(row, ['status', 'статус']).toLowerCase();
  if (s === 'active' || s === 'активен') return 'active';
  if (s === 'archived' || s === 'архив' || s === 'в архиве'
      || s === 'finished' || s === 'завершён' || s === 'завершен') return 'finished';
  return '';
}
function renderImportError(res, title, error) {
  return res.status(400).render('admin/system/import-export', {
    title, error, studentLoginType: config.STUDENT_LOGIN_TYPE,
  });
}
function tooManyRows(res, title, count) {
  return renderImportError(res, title,
    `Файл содержит ${count} строк. Максимум ${MAX_IMPORT_ROWS} за один импорт. Разделите файл на части.`);
}
router.get('/admin/import-export', checkAdmin, (req, res) => {
  res.render('admin/system/import-export', {
    title: 'Импорт и экспорт',
    studentLoginType: config.STUDENT_LOGIN_TYPE,
    error: null,
  });
});
router.get('/admin/import-export/template/:type', checkAdmin, (req, res) => {
  const type = req.params.type;
  const templates = {
    teachers:
      '\uFEFFlogin;last_name;first_name;middle_name;password;status\r\n' +
      'ivanov@chgtk.ru;Иванов;Иван;Иванович;;active\r\n' +
      'petrov@chgtk.ru;Петров;Пётр;Петрович;MyPass2025;active\r\n' +
      'sidorov@chgtk.ru;;;;finished\r\n',
    students:
      '\uFEFFlogin;last_name;first_name;middle_name;group;password;status\r\n' +
      '1000002;Сидоров;Сидор;Сидорович;ИС-25;;active\r\n' +
      'student@example.com;Кузнецов;Алексей;Владимирович;ИС-25;MyPass2025;active\r\n',
    groups:
      '\uFEFFname;status\r\n' +
      'ИС-25;active\r\n' +
      'ОПИ-26;active\r\n' +
      'ТЭЭМ-23;finished\r\n',
  };
  const csv = templates[type];
  if (!csv) return res.status(404).send('Шаблон не найден.');
  const filename = `template-${type}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return res.send(csv);
});
router.get('/admin/import-export/export/teachers', checkAdmin, (req, res) => {
  const teachers = db.prepare(`
    SELECT login, last_name, first_name, middle_name, status
    FROM teachers WHERE deleted_at IS NULL
    ORDER BY last_name, first_name
  `).all();
  const rows = teachers.map((t) => ({
    login: t.login || '', last_name: t.last_name || '',
    first_name: t.first_name || '', middle_name: t.middle_name || '',
    status: t.status,
  }));
  const csv = toCsv(rows, ['login', 'last_name', 'first_name', 'middle_name', 'status']);
  audit(req, 'export.teachers', 'teachers', null, { count: rows.length });
  const filename = `teachers_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return res.send(csv);
});
router.get('/admin/import-export/export/students', checkAdmin, (req, res) => {
  const students = db.prepare(`
    SELECT s.login, s.last_name, s.first_name, s.middle_name,
           g.name AS group_name, s.status
    FROM students s
    JOIN groups g ON g.id = s.group_id
    WHERE s.deleted_at IS NULL
    ORDER BY g.name, s.last_name, s.first_name
  `).all();
  const rows = students.map((s) => ({
    login: s.login || '', last_name: s.last_name || '',
    first_name: s.first_name || '', middle_name: s.middle_name || '',
    group: s.group_name, status: s.status,
  }));
  const csv = toCsv(rows, ['login', 'last_name', 'first_name', 'middle_name', 'group', 'status']);
  audit(req, 'export.students', 'students', null, { count: rows.length });
  const filename = `students_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return res.send(csv);
});
router.get('/admin/import-export/export/groups', checkAdmin, (req, res) => {
  const groups = db.prepare(
    'SELECT name, status FROM groups WHERE deleted_at IS NULL ORDER BY name'
  ).all();
  const rows = groups.map((g) => ({ name: g.name, status: g.status }));
  const csv = toCsv(rows, ['name', 'status']);
  audit(req, 'export.groups', 'groups', null, { count: rows.length });
  const filename = `groups_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return res.send(csv);
});
// ─── ИМПОРТ ПРЕПОДАВАТЕЛЕЙ ───
router.post(
  '/admin/import-export/import/teachers',
  checkAdmin,
  csvUpload.single('file'),
  async (req, res, next) => {
    try {
      const mode = parseMode(req.body.mode);
      const hardDelete = req.body.hard_delete === '1';
      if (!req.file || !req.file.buffer) {
        return renderImportError(res, 'Импорт и экспорт', 'Файл не загружен.');
      }
      const { rows } = parseCsv(req.file.buffer.toString('utf8'));
      if (rows.length === 0) return renderImportError(res, 'Импорт и экспорт', 'Файл пустой.');
      if (rows.length > MAX_IMPORT_ROWS) return tooManyRows(res, 'Импорт и экспорт', rows.length);
      const result = {
        mode, hardDelete,
        created: 0, updated: 0, deleted: 0, archived: 0,
        skipped: 0, errors: [], generatedPasswords: [],
      };
      const existsByLogin = db.prepare(
        'SELECT * FROM teachers WHERE login = ? AND deleted_at IS NULL'
      );
      const insert = db.prepare(`
        INSERT INTO teachers
          (name, last_name, first_name, middle_name, login, password_hash,
           status, must_change_password)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateStmt = (fields) =>
        db.prepare(`UPDATE teachers SET ${fields.join(', ')} WHERE id = ?`);
      for (let i = 0; i < rows.length; i++) {
        const lineNum = i + 2;
        const row = rows[i];
        const login = normalizeTeacherLogin(pick(row, ['login', 'email', 'логин', 'почта']));
        const loginErr = validateTeacherLogin(login);
        if (loginErr) { result.errors.push({ line: lineNum, reason: loginErr }); continue; }
        const existing = existsByLogin.get(login);
        if (mode === 'delete') {
          if (!existing) {
            result.skipped++;
            result.errors.push({ line: lineNum, reason: 'не найден' });
            continue;
          }
          try {
            if (hardDelete) {
              const hr = await lifecycle.hardDelete('teachers', existing.id, { cleanupFiles: true });
              if (hr.ok) result.deleted++; else result.errors.push({ line: lineNum, reason: hr.reason || 'hard-delete fail' });
            } else {
              lifecycle.softDelete('teachers', existing.id);
              bumpSessionVersion('teachers', existing.id);
              result.archived++;
            }
          } catch (e) {
            result.errors.push({ line: lineNum, reason: 'ошибка удаления: ' + e.message });
          }
          continue;
        }
        const nameParts = parseNameParts(row);
        if (nameParts.error) { result.errors.push({ line: lineNum, reason: nameParts.error }); continue; }
        const { last_name, first_name, middle_name, name } = nameParts;
        const password = pick(row, ['password', 'пароль']);
        const status = parseStatus(row);
        const finalStatus = status === 'finished' ? 'finished' : 'active';
        if (mode === 'create' || (mode === 'upsert' && !existing)) {
          if (existing) { result.skipped++; result.errors.push({ line: lineNum, reason: 'уже существует' }); continue; }
          if (!last_name) { result.errors.push({ line: lineNum, reason: 'пустая фамилия' }); continue; }
          if (!first_name) { result.errors.push({ line: lineNum, reason: 'пустое имя' }); continue; }
          if (password) {
            const pErrs = validatePassword(password, { login });
            if (pErrs.length > 0) { result.errors.push({ line: lineNum, reason: 'пароль: ' + pErrs.join(' ') }); continue; }
          }
          let plainPassword = password;
          let generated = false;
          if (!plainPassword) {
            plainPassword = randomNumericPassword(GENERATED_PASSWORD_LENGTH);
            generated = true;
          }
          const hash = await bcrypt.hash(plainPassword, 10);
          const mustChange = generated ? 1 : 0;
          insert.run(name, last_name, first_name, middle_name, login, hash, finalStatus, mustChange);
          result.created++;
          if (generated) result.generatedPasswords.push({ login, password: plainPassword });
          continue;
        }
        if (mode === 'update' || (mode === 'upsert' && existing)) {
          if (!existing) { result.skipped++; result.errors.push({ line: lineNum, reason: 'не найден' }); continue; }
          const fields = [];
          const values = [];
          let needsBump = false;
          if (last_name || first_name || middle_name) {
            const finalLast = last_name || existing.last_name;
            const finalFirst = first_name || existing.first_name;
            const finalMiddle = middle_name || existing.middle_name;
            fields.push('name = ?', 'last_name = ?', 'first_name = ?', 'middle_name = ?');
            values.push(composeName(finalLast, finalFirst, finalMiddle), finalLast, finalFirst, finalMiddle);
          }
          if (password) {
            const pErrs = validatePassword(password, { login });
            if (pErrs.length > 0) { result.errors.push({ line: lineNum, reason: 'пароль: ' + pErrs.join(' ') }); continue; }
            fields.push('password_hash = ?', 'must_change_password = 0');
            values.push(await bcrypt.hash(password, 10));
            needsBump = true;
          }
          if (status === 'active') fields.push("status = 'active'");
          else if (status === 'finished') { fields.push("status = 'finished'"); needsBump = true; }
          if (fields.length === 0) { result.skipped++; result.errors.push({ line: lineNum, reason: 'нет данных для обновления' }); continue; }
          values.push(existing.id);
          updateStmt(fields).run(...values);
          if (needsBump) bumpSessionVersion('teachers', existing.id);
          result.updated++;
        }
      }
      audit(req, 'import.teachers', 'teachers', null, {
        mode, hardDelete,
        created: result.created, updated: result.updated,
        deleted: result.deleted, archived: result.archived,
        errors: result.errors.length,
      });
      return res.render('admin/system/import-result', {
        title: 'Импорт преподавателей',
        type: 'teachers', mode, hardDelete, result,
      });
    } catch (e) { return next(e); }
  }
);
// ─── ИМПОРТ СТУДЕНТОВ ───
router.post(
  '/admin/import-export/import/students',
  checkAdmin,
  csvUpload.single('file'),
  async (req, res, next) => {
    try {
      const mode = parseMode(req.body.mode);
      const hardDelete = req.body.hard_delete === '1';
      if (!req.file || !req.file.buffer) {
        return renderImportError(res, 'Импорт и экспорт', 'Файл не загружен.');
      }
      const { rows } = parseCsv(req.file.buffer.toString('utf8'));
      if (rows.length === 0) return renderImportError(res, 'Импорт и экспорт', 'Файл пустой.');
      if (rows.length > MAX_IMPORT_ROWS) return tooManyRows(res, 'Импорт и экспорт', rows.length);
      const result = {
        mode, hardDelete,
        created: 0, updated: 0, deleted: 0, archived: 0,
        skipped: 0, errors: [], generatedPasswords: [],
      };
      const groups = db.prepare(
        "SELECT id, name FROM groups WHERE status='active' AND deleted_at IS NULL"
      ).all();
      const groupByName = new Map(groups.map((g) => [g.name.toLowerCase(), g]));
      const existsByLogin = db.prepare(
        'SELECT * FROM students WHERE login = ? AND deleted_at IS NULL'
      );
      const insert = db.prepare(`
        INSERT INTO students
          (name, last_name, first_name, middle_name, login, group_id,
           password_hash, must_change_password, status, approved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateStmt = (fields) =>
        db.prepare(`UPDATE students SET ${fields.join(', ')} WHERE id = ?`);
      for (let i = 0; i < rows.length; i++) {
        const lineNum = i + 2;
        const row = rows[i];
        const login = normalizeStudentLoginAuto(
          pick(row, ['login', 'email', 'логин', 'почта', 'студенческий'])
        );
        const loginErr = validateStudentLoginAuto(login);
        if (loginErr) { result.errors.push({ line: lineNum, reason: loginErr }); continue; }
        const existing = existsByLogin.get(login);
        if (mode === 'delete') {
          if (!existing) { result.skipped++; result.errors.push({ line: lineNum, reason: 'не найден' }); continue; }
          try {
            if (hardDelete) {
              const hr = await lifecycle.hardDelete('students', existing.id, { cleanupFiles: true });
              if (hr.ok) result.deleted++; else result.errors.push({ line: lineNum, reason: hr.reason || 'hard-delete fail' });
            } else {
              lifecycle.softDelete('students', existing.id);
              bumpSessionVersion('students', existing.id);
              result.archived++;
            }
          } catch (e) {
            result.errors.push({ line: lineNum, reason: 'ошибка удаления: ' + e.message });
          }
          continue;
        }
        const nameParts = parseNameParts(row);
        if (nameParts.error) { result.errors.push({ line: lineNum, reason: nameParts.error }); continue; }
        const { last_name, first_name, middle_name, name } = nameParts;
        const groupName = pick(row, ['group', 'группа']);
        const password = pick(row, ['password', 'пароль']);
        const status = parseStatus(row);
        if (mode === 'create' || (mode === 'upsert' && !existing)) {
          if (existing) { result.skipped++; result.errors.push({ line: lineNum, reason: 'уже существует' }); continue; }
          if (!last_name) { result.errors.push({ line: lineNum, reason: 'пустая фамилия' }); continue; }
          if (!first_name) { result.errors.push({ line: lineNum, reason: 'пустое имя' }); continue; }
          if (!groupName) { result.errors.push({ line: lineNum, reason: 'не указана группа' }); continue; }
          const group = groupByName.get(groupName.toLowerCase());
          if (!group) { result.errors.push({ line: lineNum, reason: `группа "${groupName}" не найдена или не активна` }); continue; }
          if (password) {
            const pErrs = validatePassword(password, { login });
            if (pErrs.length > 0) { result.errors.push({ line: lineNum, reason: 'пароль: ' + pErrs.join(' ') }); continue; }
          }
          let plainPassword = password;
          let generated = false;
          if (!plainPassword) {
            plainPassword = randomNumericPassword(GENERATED_PASSWORD_LENGTH);
            generated = true;
          }
          const hash = await bcrypt.hash(plainPassword, 10);
          const mustChange = generated ? 1 : 0;
          const finalStatus = status === 'finished' ? 'finished' : 'active';
          const approvedAt = nowSql();
          insert.run(
            name, last_name, first_name, middle_name, login, group.id,
            hash, mustChange, finalStatus, approvedAt
          );
          result.created++;
          if (generated) result.generatedPasswords.push({ login, password: plainPassword });
          continue;
        }
        if (mode === 'update' || (mode === 'upsert' && existing)) {
          if (!existing) { result.skipped++; result.errors.push({ line: lineNum, reason: 'не найден' }); continue; }
          const fields = [];
          const values = [];
          let needsBump = false;
          if (last_name || first_name || middle_name) {
            const finalLast = last_name || existing.last_name;
            const finalFirst = first_name || existing.first_name;
            const finalMiddle = middle_name || existing.middle_name;
            fields.push('name = ?', 'last_name = ?', 'first_name = ?', 'middle_name = ?');
            values.push(composeName(finalLast, finalFirst, finalMiddle), finalLast, finalFirst, finalMiddle);
          }
          if (groupName) {
            const group = groupByName.get(groupName.toLowerCase());
            if (!group) { result.errors.push({ line: lineNum, reason: `группа "${groupName}" не найдена или не активна` }); continue; }
            if (group.id !== existing.group_id) {
              fields.push('group_id = ?');
              values.push(group.id);
            }
          }
          if (password) {
            const pErrs = validatePassword(password, { login });
            if (pErrs.length > 0) { result.errors.push({ line: lineNum, reason: 'пароль: ' + pErrs.join(' ') }); continue; }
            fields.push('password_hash = ?', 'must_change_password = 0');
            values.push(await bcrypt.hash(password, 10));
            needsBump = true;
          }
          if (status === 'active') {
            fields.push("status = 'active'");
            fields.push('rejection_reason = NULL');
          } else if (status === 'finished') {
            fields.push("status = 'finished'");
            fields.push('rejection_reason = NULL');
            fields.push('approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP)');
            needsBump = true;
          }
          if (fields.length === 0) { result.skipped++; result.errors.push({ line: lineNum, reason: 'нет данных для обновления' }); continue; }
          values.push(existing.id);
          updateStmt(fields).run(...values);
          if (needsBump) bumpSessionVersion('students', existing.id);
          result.updated++;
        }
      }
      audit(req, 'import.students', 'students', null, {
        mode, hardDelete,
        created: result.created, updated: result.updated,
        deleted: result.deleted, archived: result.archived,
        errors: result.errors.length,
      });
      return res.render('admin/system/import-result', {
        title: 'Импорт студентов', type: 'students', mode, hardDelete, result,
      });
    } catch (e) { return next(e); }
  }
);
// ─── ИМПОРТ ГРУПП ───
router.post(
  '/admin/import-export/import/groups',
  checkAdmin,
  csvUpload.single('file'),
  async (req, res, next) => {
    try {
      const mode = parseMode(req.body.mode, VALID_GROUP_MODES);
      const hardDelete = req.body.hard_delete === '1';
      if (!req.file || !req.file.buffer) {
        return renderImportError(res, 'Импорт и экспорт', 'Файл не загружен.');
      }
      const { rows } = parseCsv(req.file.buffer.toString('utf8'));
      if (rows.length === 0) return renderImportError(res, 'Импорт и экспорт', 'Файл пустой.');
      if (rows.length > MAX_IMPORT_ROWS) return tooManyRows(res, 'Импорт и экспорт', rows.length);
      const result = {
        mode, hardDelete,
        created: 0, updated: 0, deleted: 0, archived: 0,
        skipped: 0, errors: [],
      };
      const existsByName = db.prepare(
        'SELECT * FROM groups WHERE name = ? AND deleted_at IS NULL'
      );
      const insertActive = db.prepare("INSERT INTO groups (name, status) VALUES (?, 'active')");
      const insertFinished = db.prepare("INSERT INTO groups (name, status) VALUES (?, 'finished')");
      for (let i = 0; i < rows.length; i++) {
        const lineNum = i + 2;
        const row = rows[i];
        const name = pick(row, ['name', 'группа', 'название']).trim().slice(0, 50);
        const status = parseStatus(row);
        if (!name) { result.errors.push({ line: lineNum, reason: 'пустое название' }); continue; }
        const existing = existsByName.get(name);
        if (mode === 'delete') {
          if (!existing) { result.skipped++; result.errors.push({ line: lineNum, reason: 'не найдена' }); continue; }
          try {
            if (hardDelete) {
              const hr = await lifecycle.hardDelete('groups', existing.id, { cleanupFiles: true });
              if (hr.ok) {
                result.deleted++;
              } else {
                result.errors.push({
                  line: lineNum,
                  reason: hr.reason === 'not_empty'
                    ? 'группа не пуста — hard-delete запрещён, используйте soft-delete'
                    : (hr.reason || 'hard-delete fail'),
                });
              }
            } else {
              lifecycle.softDelete('groups', existing.id);
              result.archived++;
            }
          } catch (e) {
            result.errors.push({ line: lineNum, reason: 'ошибка удаления: ' + e.message });
          }
          continue;
        }
        if (mode === 'create' || (mode === 'upsert' && !existing)) {
          if (existing) { result.skipped++; result.errors.push({ line: lineNum, reason: 'уже существует' }); continue; }
          try {
            if (status === 'finished') insertFinished.run(name);
            else insertActive.run(name);
            result.created++;
          } catch (e) {
            result.errors.push({ line: lineNum, reason: 'ошибка создания: ' + e.message });
          }
          continue;
        }
        if (mode === 'upsert' && existing) {
          if (status === 'active' && existing.status !== 'active') {
            lifecycle.setStatus('groups', existing.id, 'active'); result.updated++;
          } else if (status === 'finished' && existing.status !== 'finished') {
            lifecycle.setStatus('groups', existing.id, 'finished'); result.updated++;
          } else {
            result.skipped++;
          }
        }
      }
      audit(req, 'import.groups', 'groups', null, {
        mode, hardDelete,
        created: result.created, updated: result.updated,
        deleted: result.deleted, archived: result.archived,
        errors: result.errors.length,
      });
      return res.render('admin/system/import-result', {
        title: 'Импорт групп', type: 'groups', mode, hardDelete, result,
      });
    } catch (e) { return next(e); }
  }
);
module.exports = router;