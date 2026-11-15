// middleware/slow-log.js
'use strict';
const db = require('../database');

/**
 * Логирует запросы медленнее thresholdMs в таблицу slow_log.
 * Троттлинг: один и тот же «method + path» — не чаще раза в cooldownMs.
 *
 * Хранение — 30 дней, ротация в database/index.js раз в сутки.
 * Просмотр — /admin/slow-log.
 */
module.exports = function slowLog(opts = {}) {
  const thresholdMs = Number(opts.thresholdMs) || 300;
  const cooldownMs = Number(opts.cooldownMs) || 5000;
  const lastLogged = new Map();

  // Чистка in-memory кэша троттлинга раз в 5 минут.
  setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, t] of lastLogged) {
      if (t < cutoff) lastLogged.delete(k);
    }
  }, 5 * 60 * 1000).unref();

  const insert = db.prepare(`
    INSERT INTO slow_log
      (method, path, status, duration_ms, role, user_id, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return function (req, res, next) {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (ms < thresholdMs) return;

      const key = `${req.method} ${req.path}`;
      const now = Date.now();
      const last = lastLogged.get(key) || 0;
      if (now - last < cooldownMs) return;
      lastLogged.set(key, now);

      const role = req.session?.adminId ? 'admin'
        : req.session?.teacherId ? 'teacher'
        : req.session?.studentId ? 'student'
        : 'guest';
      const userId = req.session?.adminId
        || req.session?.teacherId
        || req.session?.studentId
        || null;

      try {
        insert.run(
          req.method,
          req.path,
          res.statusCode,
          Math.round(ms),
          role,
          userId,
          req.clientIp || null,
          (req.get('user-agent') || '').slice(0, 200) || null
        );
      } catch (e) {
        console.error('[slow-log] insert:', e.message);
      }
    });

    next();
  };
};