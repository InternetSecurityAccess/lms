'use strict';
const DEFAULTS = require('./settings-defaults');

let dbRef = null;
let cache = null;

function init(db) {
  dbRef = db;
  cache = null;
}

function ensureInit() {
  if (!dbRef) throw new Error('[settings] init(db) не был вызван');
}

function loadFromDb() {
  ensureInit();
  const rows = dbRef.prepare('SELECT key, value FROM app_settings').all();
  const out = { ...DEFAULTS };
  for (const row of rows) {
    try { out[row.key] = JSON.parse(row.value); }
    catch { out[row.key] = row.value; }
  }
  return out;
}

function ensureCache() {
  if (!cache) cache = loadFromDb();
  return cache;
}

function isKnownKey(key) {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key);
}

function get(key) {
  if (!isKnownKey(key)) throw new Error(`[settings] unknown key: ${key}`);
  // Если база ещё не инициализирована — возвращаем дефолт,
  // чтобы не падать на ранней инициализации.
  if (!dbRef) return DEFAULTS[key];
  return ensureCache()[key];
}

function set(key, value) {
  if (!isKnownKey(key)) throw new Error(`[settings] unknown key: ${key}`);
  ensureInit();
  dbRef.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, JSON.stringify(value));
  ensureCache()[key] = value;
}

function setMany(pairs) {
  ensureInit();
  const stmt = dbRef.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `);
  const tx = dbRef.transaction(() => {
    for (const [key, value] of Object.entries(pairs)) {
      if (!isKnownKey(key)) continue;
      stmt.run(key, JSON.stringify(value));
      ensureCache()[key] = value;
    }
  });
  tx();
}

function getAll() {
  return { ...ensureCache() };
}

function resetCache() {
  cache = null;
}

function getAllDefaults() {
  return { ...DEFAULTS };
}

module.exports = {
  init, get, set, setMany, getAll, resetCache,
  getAllDefaults, DEFAULTS,
};