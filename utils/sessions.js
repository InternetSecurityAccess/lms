'use strict';

const db = require('../database');

const ALLOWED_TABLES = new Set(['students', 'teachers', 'admins']);

function bumpSessionVersion(table, id) {
  if (!ALLOWED_TABLES.has(table)) return;
  db.prepare(`UPDATE ${table} SET session_version = session_version + 1 WHERE id = ?`).run(id);
}

module.exports = { bumpSessionVersion };