'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const { checkAdmin } = require('../shared/authz');
const { handler, audit } = require('../shared/handlers');
const { bumpSessionVersion } = require('../../utils/sessions');
const lifecycle = require('../../utils/lifecycle');
const MAX_BULK = 200;
function normalizeIds(raw) {
  const arr = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
function backTo(req, params = {}) {
  const ref = String(req.get('referer') || '');
  let base = '/admin';
  let search = '';
  try {
    const u = new URL(ref, 'http://x');
    base = u.pathname || '/admin';
    search = u.search || '';
  } catch { /* ignore */ }
  const sp = new URLSearchParams(search);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return base + (s ? '?' + s : '');
}
function validateBulk(req, res) {
  const ids = normalizeIds(req.body.ids);
  if (ids.length === 0) return { error: backTo(req, { bulk_error: 'no_ids' }) };
  if (ids.length > MAX_BULK) {
    return { error: backTo(req, { bulk_error: 'too_many', bulk_limit: MAX_BULK }) };
  }
  return { ids };
}
const BULK_ENTITY_TO_KIND = {
  teachers: 'teachers',
  students: 'students',
  groups: 'groups',
  subjects: 'subjects',
  topics: 'topics',
  works: 'submissions',
  announcements: 'group_announcements',
};
router.post(
  '/admin/bulk-delete',
  checkAdmin,
  handler((req, res) => {
    const entity = String(req.body.entity || '').trim();
    const kind = BULK_ENTITY_TO_KIND[entity];
    if (!kind) return res.redirect(backTo(req, { bulk_error: 'bad_entity' }));
    const v = validateBulk(req, res);
    if (v.error) return res.redirect(v.error);
    const { ids } = v;
    let deleted = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        let r;
        if (kind === 'topics') {
          r = lifecycle.softDeleteTopic(id);
        } else {
          r = lifecycle.softDelete(kind, id);
        }
        if (r.changes) {
          deleted++;
          if (kind === 'teachers') bumpSessionVersion('teachers', id);
          if (kind === 'students') bumpSessionVersion('students', id);
        } else {
          failed++;
        }
      } catch (e) {
        console.error(`[bulk:${entity}]`, id, e.message);
        failed++;
      }
    }
    audit(req, `${kind.replace(/s$/, '')}.bulk_delete`, kind, null, {
      ids, deleted, failed, mode: 'soft',
    });
    return res.redirect(backTo(req, {
      bulk_done: 'delete',
      bulk_deleted: deleted,
      bulk_failed: failed || null,
    }));
  })
);
const FINISHABLE = new Set(['teachers', 'students', 'groups', 'subjects']);
router.post(
  '/admin/bulk-finish',
  checkAdmin,
  handler((req, res) => {
    const entity = String(req.body.entity || '').trim();
    if (!FINISHABLE.has(entity)) {
      return res.redirect(backTo(req, { bulk_error: 'bad_entity' }));
    }
    const v = validateBulk(req, res);
    if (v.error) return res.redirect(v.error);
    const { ids } = v;
    let updated = 0;
    for (const id of ids) {
      try {
        const r = lifecycle.setStatus(entity, id, 'finished');
        if (r.changes) {
          updated++;
          if (entity === 'teachers') bumpSessionVersion('teachers', id);
          if (entity === 'students') bumpSessionVersion('students', id);
        }
      } catch (e) {
        console.error(`[bulk-finish:${entity}]`, id, e.message);
      }
    }
    audit(req, `${entity.replace(/s$/, '')}.bulk_finish`, entity, null, {
      ids, finished: updated,
    });
    return res.redirect(backTo(req, {
      bulk_done: 'finish',
      bulk_finished: updated,
    }));
  })
);
router.post(
  '/admin/bulk-activate',
  checkAdmin,
  handler((req, res) => {
    const entity = String(req.body.entity || '').trim();
    if (!FINISHABLE.has(entity)) {
      return res.redirect(backTo(req, { bulk_error: 'bad_entity' }));
    }
    const v = validateBulk(req, res);
    if (v.error) return res.redirect(v.error);
    const { ids } = v;
    let updated = 0;
    for (const id of ids) {
      try {
        const r = lifecycle.setStatus(entity, id, 'active');
        if (r.changes) updated++;
      } catch (e) {
        console.error(`[bulk-activate:${entity}]`, id, e.message);
      }
    }
    audit(req, `${entity.replace(/s$/, '')}.bulk_activate`, entity, null, {
      ids, activated: updated,
    });
    return res.redirect(backTo(req, {
      bulk_done: 'activate',
      bulk_activated: updated,
    }));
  })
);
router.post(
  '/admin/bulk-approve',
  checkAdmin,
  handler((req, res) => {
    const v = validateBulk(req, res);
    if (v.error) return res.redirect(v.error);
    const { ids } = v;
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const r = db.prepare(`
          UPDATE students
          SET approved_at = CURRENT_TIMESTAMP, rejection_reason = NULL
          WHERE id = ? AND approved_at IS NULL
            AND status='active' AND deleted_at IS NULL
        `).run(id);
        if (r.changes) ok++; else failed++;
      } catch { failed++; }
    }
    audit(req, 'student.bulk_approve', 'students', null, { ids, approved: ok, failed });
    return res.redirect(backTo(req, {
      bulk_done: 'approve',
      bulk_approved: ok,
      bulk_failed: failed || null,
    }));
  })
);
router.post(
  '/admin/bulk-reject',
  checkAdmin,
  handler((req, res) => {
    const v = validateBulk(req, res);
    if (v.error) return res.redirect(v.error);
    const { ids } = v;
    const reason = String(req.body.reason || '').trim().slice(0, 500) || 'без указания причины';
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const r = lifecycle.setStatus('students', id, 'rejected', { rejectionReason: reason });
        if (r.changes) ok++; else failed++;
      } catch { failed++; }
    }
    audit(req, 'student.bulk_reject', 'students', null, { ids, rejected: ok, failed, reason });
    return res.redirect(backTo(req, {
      bulk_done: 'reject',
      bulk_rejected: ok,
      bulk_failed: failed || null,
    }));
  })
);
module.exports = router;