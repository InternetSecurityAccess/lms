// routes/admin/import-helpers.js
'use strict';
/**
 * Хелперы импорта/экспорта CSV (рефакторинг system.js).
 * Логика перенесена дословно, без изменения поведения.
 */
const config = require('../../config');
const { pick } = require('../../utils/csv');
const { composeName } = require('../../utils/names');

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

module.exports = {
    VALID_MODES,
    VALID_GROUP_MODES,
    MAX_IMPORT_ROWS,
    GENERATED_PASSWORD_LENGTH,
    parseMode,
    parseNameParts,
    parseStatus,
    renderImportError,
    tooManyRows,
};
