'use strict';
const {
  getPreviewCategory, canPreview, PREVIEWABLE_EXTENSIONS,
} = require('../utils/mime');
const { sanitizeHtml } = require('../utils/sanitize');
const config = require('../config');
const { utcToLocalParts } = require('../utils/timezone');

const PREVIEWABLE_EXTS = Object.freeze(new Set(PREVIEWABLE_EXTENSIONS));

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function formatDate(value, withTime = false) {
  if (value == null || value === '') return '';
  const parts = utcToLocalParts(String(value), config.COLLEGE.TZ);
  if (!parts) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${pad(parts.d)}.${pad(parts.mo)}.${parts.y}`;
  if (!withTime) return dateStr;
  return `${dateStr}, ${pad(parts.h)}:${pad(parts.mi)}`;
}

function buildUrl(basePath, baseQuery = {}, overrides = {}) {
  const params = { ...baseQuery, ...overrides };
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === '' || v == null) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return basePath + (s ? '?' + s : '');
}

module.exports = function viewHelpers(req, res, next) {
  res.locals.canPreview = canPreview;
  res.locals.sanitizeHtml = sanitizeHtml;
  res.locals.plural = plural;
  res.locals.formatDate = formatDate;
  res.locals.buildUrl = buildUrl;
  res.locals.previewCategory = getPreviewCategory;
  res.locals.PREVIEWABLE_EXTS = PREVIEWABLE_EXTS;
  next();
};
module.exports.canPreview = canPreview;
module.exports.sanitizeHtml = sanitizeHtml;
module.exports.plural = plural;
module.exports.formatDate = formatDate;
module.exports.buildUrl = buildUrl;
module.exports.PREVIEWABLE_EXTS = PREVIEWABLE_EXTS;