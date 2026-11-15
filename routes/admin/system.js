// routes/admin/system.js
'use strict';
const { nowSql } = require('../../utils/dates');
const express = require('express');
const router = express.Router();
const db = require('../../database');
const settings = require('../../config/settings');
const config = require('../../config');
const { checkAdmin } = require('../shared/authz');
const { handler, renderWith, parseIdOr404, notFound, audit } = require('../shared/handlers');
const { ROLE_TABLE, loadSessionItems } = require('./system-sessions');
const {
  isExtendedAuditActive, isExtendedAllActive, getActionLabel,
} = require('../../utils/audit');
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
module.exports = router;