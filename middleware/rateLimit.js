'use strict';
const db = require('../database');
const config = require('../config');
const settings = require('../config/settings');
const { audit } = require('../utils/audit');

const MAX_ATTEMPTS = 5;
const BLOCK_MS = 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;

function getIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}
function getKey(routeName, req) { return `${routeName}:${getIp(req)}`; }
function getWho(req) {
  if (req.session?.studentId) return `s:${req.session.studentId}`;
  if (req.session?.teacherId) return `t:${req.session.teacherId}`;
  if (req.session?.adminId) return `a:${req.session.adminId}`;
  return `ip:${getIp(req)}`;
}

// Группы для селекта на /login — только активные и не в корзине.
function loadGroups() {
  return db.prepare(`
    SELECT id, name FROM groups
    WHERE status = 'active' AND deleted_at IS NULL
    ORDER BY name
  `).all();
}

function pruneStale() {
  const t = Date.now() - 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM rate_limits WHERE until_ms < ? AND last_attempt_ms < ?').run(t, t);
}
setInterval(() => {
  try { pruneStale(); } catch { /* ignore */ }
}, 10 * 60 * 1000).unref();

// /admin → 'admin', /teacher → 'teacher', иначе 'student'.
function detectTab(req) {
  const path = String(req.path || '');
  if (path.startsWith('/admin')) return 'admin';
  if (path.includes('/teacher')) return 'teacher';
  if (req.body?.tab === 'teacher') return 'teacher';
  return 'student';
}

function rateLimitLogin(templateName, routeName = templateName) {
  return (req, res, next) => {
    const key = getKey(routeName, req);
    const now = Date.now();
    const row = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
    if (row) {
      if (row.until_ms > now) {
        const wait = Math.ceil((row.until_ms - now) / 1000);
        const isRegister = String(req.path || '').startsWith('/register');
        return res.status(429).render(templateName, {
          error: `Слишком много попыток. Подождите ${wait} сек.`,
          mode: isRegister ? 'register' : 'login',
          tab: detectTab(req),
          groups: req.groups || loadGroups(),
          form: {
            login: String(req.body?.login || '').slice(0, 200),
            name: String(req.body?.name || '').slice(0, 200),
            group_id: String(req.body?.group_id || ''),
            last_name: String(req.body?.last_name || '').slice(0, 100),
            first_name: String(req.body?.first_name || '').slice(0, 100),
            middle_name: String(req.body?.middle_name || '').slice(0, 100),
          },
          studentLoginType: config.STUDENT_LOGIN_TYPE,
          registrationEnabled: config.REGISTRATION_ENABLED,
        });
      }
      if (now - row.last_attempt_ms > WINDOW_MS) {
        db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
      }
    }
    next();
  };
}

function rateLimitAction(actionName, { max = 30, windowMs = 60_000, blockMs = 60_000 } = {}) {
  return (req, res, next) => {
    const key = `act:${actionName}:${getWho(req)}`;
    const now = Date.now();
    let row = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
    if (row) {
      if (row.until_ms > now) {
        const wait = Math.ceil((row.until_ms - now) / 1000);
        return res.status(429).render('common/error', {
          title: 'Слишком много запросов',
          message: `Слишком много запросов. Подождите ${wait} сек.`,
        });
      }
      if (now - row.last_attempt_ms > windowMs) {
        db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
        row = null;
      }
    }
    const count = (row?.count || 0) + 1;
    const blocked = count >= max;
    db.prepare(`
      INSERT INTO rate_limits (key, count, until_ms, last_attempt_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = excluded.count,
        until_ms = excluded.until_ms,
        last_attempt_ms = excluded.last_attempt_ms
    `).run(key, blocked ? 0 : count, blocked ? now + blockMs : 0, now);
    if (blocked) {
      try {
        audit(req, 'rate_limit.block', 'action', null, {
          action: actionName, max, block_ms: blockMs,
        });
      } catch { /* ignore */ }
      const wait = Math.ceil(blockMs / 1000);
      return res.status(429).render('common/error', {
        title: 'Слишком много запросов',
        message: `Слишком много запросов. Подождите ${wait} сек.`,
      });
    }
    next();
  };
}

const _rateLimitActionCache = new Map();
function cachedRateLimitAction(actionName, opts) {
  const key = `${actionName}|${opts.max}|${opts.windowMs}|${opts.blockMs}`;
  let mw = _rateLimitActionCache.get(key);
  if (!mw) {
    mw = rateLimitAction(actionName, opts);
    if (_rateLimitActionCache.size > 200) _rateLimitActionCache.clear();
    _rateLimitActionCache.set(key, mw);
  }
  return mw;
}

function chatRateLimit(actionName = 'chat_msg') {
  return (req, res, next) => {
    let max = 30;
    let windowMs = 60_000;
    let blockMs = 60_000;
    try {
      const m = Number(settings.get('chat.messageRateLimitMax'));
      const w = Number(settings.get('chat.messageRateLimitWindowMin'));
      const b = Number(settings.get('chat.messageRateLimitBlockMin'));
      if (Number.isFinite(m) && m > 0) max = Math.min(m, 1000);
      if (Number.isFinite(w) && w > 0) windowMs = w * 60_000;
      if (Number.isFinite(b) && b > 0) blockMs = b * 60_000;
    } catch { /* fallback */ }
    return cachedRateLimitAction(actionName, { max, windowMs, blockMs })(req, res, next);
  };
}

function submitRateLimit(actionName = 'submit') {
  return (req, res, next) => {
    let max = 30;
    let windowMs = 60_000;
    let blockMs = 60_000;
    try {
      const m = Number(settings.get('submit.rateLimitMax'));
      const w = Number(settings.get('submit.rateLimitWindowMin'));
      const b = Number(settings.get('submit.rateLimitBlockMin'));
      if (Number.isFinite(m) && m > 0) max = Math.min(m, 1000);
      if (Number.isFinite(w) && w > 0) windowMs = w * 60_000;
      if (Number.isFinite(b) && b > 0) blockMs = b * 60_000;
    } catch { /* fallback */ }
    return cachedRateLimitAction(actionName, { max, windowMs, blockMs })(req, res, next);
  };
}

function recordFailure(routeName, req) {
  const key = getKey(routeName, req);
  const now = Date.now();
  const row = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key)
    || { count: 0, until_ms: 0, last_attempt_ms: 0 };
  const count = row.count + 1;
  const blocked = count === MAX_ATTEMPTS;
  const until = blocked ? now + BLOCK_MS : row.until_ms;
  db.prepare(`
    INSERT INTO rate_limits (key, count, until_ms, last_attempt_ms)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = excluded.count,
      until_ms = excluded.until_ms,
      last_attempt_ms = excluded.last_attempt_ms
  `).run(key, blocked ? 0 : count, until, now);
  if (blocked) {
    try {
      audit(req, 'auth.brute_force', null, null, {
        route: routeName,
        attempts: MAX_ATTEMPTS,
        block_ms: BLOCK_MS,
        login: String(req.body?.login || req.body?.name || '').slice(0, 200) || null,
      });
    } catch { /* ignore */ }
  }
}
function recordSuccess(routeName, req) {
  db.prepare('DELETE FROM rate_limits WHERE key = ?').run(getKey(routeName, req));
}

module.exports = {
  rateLimitLogin,
  rateLimitAction,
  chatRateLimit,
  submitRateLimit,
  recordFailure,
  recordSuccess,
};