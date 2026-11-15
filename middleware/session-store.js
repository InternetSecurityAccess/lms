'use strict';

const session = require('express-session');
const SqliteStoreFactory = require('better-sqlite3-session-store');

function buildSessionStore(db) {
  const SqliteStore = SqliteStoreFactory(session);
  return new SqliteStore({
    client: db,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  });
}

module.exports = { buildSessionStore };