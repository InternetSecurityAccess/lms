'use strict';
const express = require('express');
const router = express.Router();
const db = require('../../database');
const config = require('../../config');
const settings = require('../../config/settings');
const { checkAdmin } = require('../shared/authz');
const { handler, renderWith, audit } = require('../shared/handlers');
const { invalidateUploaders } = require('../../utils/storage');
const { seedDemo, deleteDemo } = require('../../database/seed-demo');
const { isValidTimeZone } = require('../../utils/timezone');
const {
  CRITICAL_ACTIONS, EXTENDED_ACTIONS, KNOWN_ACTIONS,
  buildActionGroups,
} = require('../../utils/audit');

const PASSWORD_LEVELS = new Set(['basic', 'medium', 'strong']);
const LOGIN_TYPES = new Set(['student_id', 'email']);
const RESTART_KEYS = new Set([
  'security.sessionMaxAgeHours',
  'security.cookieSecure',
]);
const QUILL_GROUPS = new Set([
  'fonts', 'inline', 'color', 'script', 'list',
  'indent', 'align', 'blocks', 'link', 'image', 'formula', 'clean',
]);
const QUILL_GROUP_COMPAT = {
  media: ['link', 'image', 'formula'],
};
const EXTENDED_DURATIONS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

function readStr(body, name, maxLen = 500) {
  const v = body[name];
  const s = Array.isArray(v) ? (v[v.length - 1] || '') : (v || '');
  return String(s).trim().slice(0, maxLen);
}
function readInt(body, name, min, max, fallback) {
  const n = Number(readStr(body, name, 20));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.trunc(n);
}
function readBool(body, name) {
  const v = body[name];
  if (Array.isArray(v)) return v.includes('1');
  return v === '1' || v === 'on' || v === 'true';
}
function readEnum(body, name, allowed, fallback) {
  const v = readStr(body, name, 50);
  return allowed.has(v) ? v : fallback;
}
function readExtList(body, name, fallback) {
  const raw = readStr(body, name, 2000);
  const items = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s.startsWith('.') ? s : '.' + s))
    .filter((s) => /^\.[a-z0-9]{1,10}$/.test(s));
  const uniq = Array.from(new Set(items));
  return uniq.length > 0 ? uniq : fallback;
}
function readArray(body, name) {
  const v = body[name];
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => String(x).trim()).filter(Boolean);
}
function sanitizeMuted(list) {
  return Array.from(new Set(list.filter((a) =>
    KNOWN_ACTIONS.includes(a) && !CRITICAL_ACTIONS.has(a)
  )));
}
function sanitizeForced(list) {
  return Array.from(new Set(list.filter((a) =>
    KNOWN_ACTIONS.includes(a) && !CRITICAL_ACTIONS.has(a)
  )));
}
function expandQuillGroups(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const g of list) {
    const compat = QUILL_GROUP_COMPAT[g];
    if (Array.isArray(compat)) out.push(...compat);
    else out.push(g);
  }
  return out;
}

router.get(
  '/admin/settings',
  checkAdmin,
  handler((req, res) => {
    const current = settings.getAll();
    const restartKeys = String(req.query.restart_keys || '').split(',').filter(Boolean);
    const mutedActions = Array.isArray(current['audit.mutedActions'])
      ? current['audit.mutedActions'] : [];
    const forceLogActions = Array.isArray(current['audit.forceLogActions'])
      ? current['audit.forceLogActions'] : [];
    const criticalActionsList = Array.from(CRITICAL_ACTIONS).sort()
      .map((code) => ({ code, label: require('../../utils/audit-labels').getActionLabel(code) }));
    const manageableActions = Array.from(new Set([
      ...EXTENDED_ACTIONS,
      ...KNOWN_ACTIONS.filter((a) => !CRITICAL_ACTIONS.has(a) && !EXTENDED_ACTIONS.has(a)),
    ])).sort();
    const manageableGroups = buildActionGroups(manageableActions);
    const quillToolbarGroupsDisplay = expandQuillGroups(current['quill.toolbarGroups'] || []);
    return renderWith(res, 'admin/system/settings', {
      title: 'Настройки',
      current,
      saved: req.query.saved === '1',
      restartKeys,
      demoEnabled: !!settings.get('demo.enabled'),
      demoGroupName: config.DEMO_GROUP_NAME,
      demoTeacherLogin: config.DEMO_TEACHER.login,
      demoStudentLogin: config.DEMO_STUDENT.login,
      demoPassword: config.DEMO_TEACHER.password,
      extendedAuditActive: (() => {
        try {
          const enabled = !!current['audit.extended'];
          if (!enabled) return false;
          const until = current['audit.extendedUntil'];
          if (until == null) return false;
          return Date.now() < Number(until);
        } catch { return false; }
      })(),
      extendedAuditUntil: current['audit.extendedUntil'],
      extendedAllActive: (() => {
        try {
          const enabled = !!current['audit.extended'];
          if (!enabled) return false;
          const until = current['audit.extendedUntil'];
          if (until != null && Date.now() >= Number(until)) return false;
          return !!current['audit.extendedAll'];
        } catch { return false; }
      })(),
      criticalActionsList,
      manageableGroups,
      mutedActions,
      forceLogActions,
      quillGroupsList: Array.from(QUILL_GROUPS),
      quillToolbarGroupsDisplay,
    });
  })
);

router.post(
  '/admin/settings',
  checkAdmin,
  handler((req, res) => {
    const body = req.body || {};
    const before = settings.getAll();
    const updates = {};
    // Безопасность
    updates['security.passwordLevel'] = readEnum(body, 'passwordLevel', PASSWORD_LEVELS, 'medium');
    updates['security.adminPasswordLevel'] = readEnum(body, 'adminPasswordLevel', PASSWORD_LEVELS, 'strong');
    updates['security.passwordMinLength'] = readInt(body, 'passwordMinLength', 0, 200, 0);
    updates['security.sessionMaxAgeHours'] = readInt(body, 'sessionMaxAgeHours', 1, 720, 8);
    const cookieSecureRaw = readStr(body, 'cookieSecure', 10);
    updates['security.cookieSecure'] =
      cookieSecureRaw === 'on' ? true
        : cookieSecureRaw === 'off' ? false
          : null;
    // Аутентификация
    updates['auth.studentLoginType'] = readEnum(body, 'studentLoginType', LOGIN_TYPES, 'student_id');
    updates['auth.registrationEnabled'] = readBool(body, 'registrationEnabled');
    updates['auth.registrationNeedsApproval'] = readBool(body, 'registrationNeedsApproval');
    // Аудит
    const extendedEnabled = readBool(body, 'auditExtended');
    if (extendedEnabled) {
      const durRaw = readStr(body, 'auditExtendedDuration', 10);
      const durMs = EXTENDED_DURATIONS[durRaw] || EXTENDED_DURATIONS['1h'];
      updates['audit.extended'] = true;
      updates['audit.extendedUntil'] = Date.now() + durMs;
    } else {
      updates['audit.extended'] = false;
      updates['audit.extendedUntil'] = null;
    }
    updates['audit.extendedAll'] = readBool(body, 'auditExtendedAll');
    updates['audit.retentionDays'] = readInt(body, 'auditRetentionDays', 1, 36500, 1500);
    updates['audit.mutedActions'] = sanitizeMuted(readArray(body, 'auditMutedActions'));
    updates['audit.forceLogActions'] = sanitizeForced(readArray(body, 'auditForceLogActions'));
    // Файлы
    updates['files.maxSizeMb'] = readInt(body, 'filesMaxSizeMb', 1, 1000, 100);
    updates['files.maxFilesPerUpload'] = readInt(body, 'filesMaxFilesPerUpload', 1, 50, 5);
    updates['files.uploadRateLimitMbps'] = readInt(body, 'filesUploadRateLimitMbps', 0, 10000, 0);
    updates['files.uploadExtensions'] = readExtList(body, 'filesUploadExtensions', ['.pdf']);
    // Quill
    updates['quill.toolbarGroups'] = readArray(body, 'quillToolbarGroups')
      .filter((g) => QUILL_GROUPS.has(g));
    updates['quill.tableEnabled'] = readBool(body, 'quillTableEnabled');
    // Обратная связь
    updates['feedback.rateLimitMax'] = readInt(body, 'feedbackRateLimitMax', 1, 100, 5);
    updates['feedback.rateLimitWindowMin'] = readInt(body, 'feedbackRateLimitWindowMin', 1, 10080, 60);
    // Чаты
    updates['chat.messageRateLimitMax'] = readInt(body, 'chatRateLimitMax', 1, 1000, 30);
    updates['chat.messageRateLimitWindowMin'] = readInt(body, 'chatRateLimitWindowMin', 1, 10080, 1);
    updates['chat.messageRateLimitBlockMin'] = readInt(body, 'chatRateLimitBlockMin', 1, 10080, 1);
    // Сдача работ
    updates['submit.rateLimitMax'] = readInt(body, 'submitRateLimitMax', 1, 1000, 30);
    updates['submit.rateLimitWindowMin'] = readInt(body, 'submitRateLimitWindowMin', 1, 10080, 1);
    updates['submit.rateLimitBlockMin'] = readInt(body, 'submitRateLimitBlockMin', 1, 10080, 1);
    // Колледж
    updates['college.short'] = readStr(body, 'collegeShort', 50) || 'ЧГТК';
    updates['college.shortName'] = readStr(body, 'collegeShortName', 300) || 'Колледж';
    updates['college.name'] = readStr(body, 'collegeName', 300) || 'Колледж';
    updates['college.systemName'] = readStr(body, 'collegeSystemName', 50) || 'ИС';
    updates['college.systemFull'] = readStr(body, 'collegeSystemFull', 200) || 'Система управления обучением';
    updates['college.address'] = readStr(body, 'collegeAddress', 300);
    updates['college.phone'] = readStr(body, 'collegePhone', 50);
    updates['college.email'] = readStr(body, 'collegeEmail', 200);
    updates['college.site'] = readStr(body, 'collegeSite', 300);
    const tzRaw = readStr(body, 'collegeTimezone', 100);
    updates['college.timezone'] = (tzRaw && isValidTimeZone(tzRaw))
      ? tzRaw
      : (settings.get('college.timezone') || 'Asia/Irkutsk');
    const changed = [];
    const restartKeys = [];
    for (const [key, value] of Object.entries(updates)) {
      if (JSON.stringify(before[key]) !== JSON.stringify(value)) {
        changed.push(key);
        if (RESTART_KEYS.has(key)) restartKeys.push(key);
      }
    }
    settings.setMany(updates);
    invalidateUploaders();
    audit(req, 'settings.update', 'settings', null, { changed });
    const params = new URLSearchParams({ saved: '1' });
    if (restartKeys.length > 0) {
      params.set('restart_keys', restartKeys.join(','));
    }
    return res.redirect('/admin/settings?' + params.toString());
  })
);

router.post(
  '/admin/settings/demo/enable',
  checkAdmin,
  handler(async (req, res) => {
    settings.set('demo.enabled', true);
    try {
      seedDemo(db);
      audit(req, 'demo.seed', 'demo', null, {});
    } catch (e) {
      console.error('[demo-seed]', e);
    }
    return res.redirect('/admin/settings?saved=1');
  })
);

router.post(
  '/admin/settings/demo/disable',
  checkAdmin,
  handler(async (req, res) => {
    settings.set('demo.enabled', false);
    try {
      await deleteDemo(db);
      audit(req, 'demo.delete', 'demo', null, {});
    } catch (e) {
      console.error('[demo-delete]', e);
    }
    return res.redirect('/admin/settings?saved=1');
  })
);

module.exports = router;