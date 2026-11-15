// config/files.js
'use strict';
const settings = require('./settings');
const MB = 1024 * 1024;

// ─── Статические MIME / preview (не меняются из админки) ───
const MIME_BY_EXT = Object.freeze({
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
});
const IMAGE_MIME_TO_EXT = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
});
const PREVIEW_CATEGORY = Object.freeze({
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.txt': 'text',
});
const PREVIEWABLE_EXTENSIONS = Object.freeze(Object.keys(PREVIEW_CATEGORY));

// ─── Quiz images (константы, не из настроек) ───
const QUIZ_IMAGE_MAX_MB = 2;
const QUIZ_IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);
const QUIZ_IMAGE_MIME_TO_EXT = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
});

// ─── Хелперы ───
function extOf(name) {
  if (!name) return '';
  const s = String(name);
  const idx = s.lastIndexOf('.');
  return idx >= 0 ? s.slice(idx).toLowerCase() : '';
}
function hasExtIn(name, list) {
  return list.includes(extOf(name));
}
function getMimeType(name) {
  return MIME_BY_EXT[extOf(name)] || 'application/octet-stream';
}
function getPreviewCategory(name) {
  return PREVIEW_CATEGORY[extOf(name)] || null;
}
function canPreview(name) {
  return !!getPreviewCategory(name);
}
function isAllowedImageMime(mime) {
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME_TO_EXT, mime);
}
function imageExtFromMime(mime) {
  return IMAGE_MIME_TO_EXT[mime] || null;
}
function acceptFor(list) {
  return list.join(',');
}
function formatExtList(list) {
  return list.join(', ');
}

// ─── Динамические значения из БД ───
const filesPolicy = {
  MB,
  get MAX_FILE_SIZE_MB() {
    const v = Number(settings.get('files.maxSizeMb'));
    return Number.isFinite(v) && v > 0 ? v : 100;
  },
  get MAX_FILE_SIZE() {
    return this.MAX_FILE_SIZE_MB * MB;
  },
  get MAX_FILES_PER_UPLOAD() {
    const v = Number(settings.get('files.maxFilesPerUpload'));
    return Number.isFinite(v) && v > 0 ? v : 5;
  },
  get UPLOAD_RATE_LIMIT_MBPS() {
    const v = Number(settings.get('files.uploadRateLimitMbps'));
    return Number.isFinite(v) && v > 0 ? v : 0;
  },
  get UPLOAD_EXTENSIONS() {
    const v = settings.get('files.uploadExtensions');
    return Array.isArray(v) ? v.slice() : ['.pdf'];
  },
  get IMAGE_EXTENSIONS() {
    const v = settings.get('files.imageExtensions');
    return Array.isArray(v) ? v.slice() : ['.png', '.jpg', '.jpeg'];
  },
  get ACCEPT_UPLOAD() {
    return acceptFor(this.UPLOAD_EXTENSIONS);
  },
  get ACCEPT_IMAGE() {
    return acceptFor(this.IMAGE_EXTENSIONS);
  },

  // Quiz-картинки — константы, не из settings
  QUIZ_IMAGE_MAX_MB,
  QUIZ_IMAGE_MAX_SIZE: QUIZ_IMAGE_MAX_MB * MB,
  QUIZ_IMAGE_EXTENSIONS,
  QUIZ_IMAGE_MIME_TO_EXT,
  QUIZ_IMAGE_ACCEPT: acceptFor([...QUIZ_IMAGE_EXTENSIONS]),
  isAllowedQuizImageMime(mime) {
    return Object.prototype.hasOwnProperty.call(QUIZ_IMAGE_MIME_TO_EXT, mime);
  },
  quizImageExtFromMime(mime) {
    return QUIZ_IMAGE_MIME_TO_EXT[mime] || null;
  },

  PREVIEWABLE_EXTENSIONS,
  MIME_BY_EXT,
  IMAGE_MIME_TO_EXT,
  PREVIEW_CATEGORY,
  extOf, hasExtIn,
  getMimeType, getPreviewCategory, canPreview,
  isAllowedImageMime, imageExtFromMime,
  formatExtList,
};
module.exports = filesPolicy;