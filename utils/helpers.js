'use strict';

const path = require('node:path');

function fixFilename(value) {
  if (typeof value !== 'string') return '';
  if (/[\u0080-\u00ff]/.test(value)) {
    try {
      const decoded = Buffer.from(value, 'latin1').toString('utf8');
      if (decoded && decoded !== value && !decoded.includes('\uFFFD')) {
        return decoded;
      }
    } catch { /* ignore */ }
  }
  return value;
}

function encodeFilename(filename) {
  return encodeURIComponent(String(filename || 'download'));
}

function safeJoin(root, relativePath) {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (
    absolutePath !== absoluteRoot
    && !absolutePath.startsWith(absoluteRoot + path.sep)
  ) {
    throw new Error('Некорректный путь');
  }
  return absolutePath;
}

function safeRedirect(value, fallback = '/') {
  if (
    typeof value === 'string'
    && value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('\r')
    && !value.includes('\n')
  ) return value;
  return fallback;
}

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

module.exports = { fixFilename, encodeFilename, safeJoin, safeRedirect, parseId };