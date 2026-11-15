'use strict';
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:']);

function isSafeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    if (!ALLOWED_URL_PROTOCOLS.has(u.protocol)) return false;
    if (!u.hostname) return false;
    return true;
  } catch { return false; }
}

function sanitizeUrlOrNull(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  return isSafeUrl(s) ? s : null;
}

// ← ДОБАВЛЕНО: проверка ссылок на канал MAX.
// Разрешаем https://max.ru/... и поддомены: www.max.ru, web.max.ru и т.п.
const MAX_URL_RE = /^https?:\/\/([a-z0-9-]+\.)*max\.ru\//i;

function isSafeMaxUrl(value) {
  if (!isSafeUrl(value)) return false;
  return MAX_URL_RE.test(String(value).trim());
}

function sanitizeMaxUrlOrNull(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  return isSafeMaxUrl(s) ? s : null;
}

module.exports = {
  isSafeUrl, sanitizeUrlOrNull,
  isSafeMaxUrl, sanitizeMaxUrlOrNull,
};