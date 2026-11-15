// routes/admin/import-export.js
'use strict';
/**
 * Импорт/экспорт CSV (рефакторинг system.js).
 * Маршруты и логика перенесены дословно, без изменения поведения.
 */
const express = require('express');
const multer = require('multer');
const router = express.Router();
const db = require('../../database');
const config = require('../../config');
const { checkAdmin } = require('../shared/authz');
const { audit } = require('../shared/handlers');
const { toCsv, parseCsv, pick } = require('../../utils/csv');

// CSV-файл импорта читается в память (req.file.buffer), на диск не пишется.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});
const { randomNumericPassword, validatePassword } = require('../../utils/password-policy');
const { composeName } = require('../../utils/names');
const {
    VALID_MODES, VALID_GROUP_MODES, MAX_IMPORT_ROWS, GENERATED_PASSWORD_LENGTH,
    parseMode, parseNameParts, parseStatus, renderImportError, tooManyRows,
} = require('./import-helpers');

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
