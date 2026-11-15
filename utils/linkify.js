'use strict';
const URL_RE = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

// ← ДОБАВЛЕНО: обрезка завершающей пунктуации из URL.
//   «Точка/запятая/! /? /: /;» в конце — почти всегда часть предложения,
//   а не URL. Скобки ) и ] убираем только при нарушенном балансе
//   (в URL вроде https://en.wikipedia.org/wiki/Foo_(bar) баланс соблюдён).
function trimTrailingUrl(url) {
  let s = String(url);
  while (/[.,;:!?]$/.test(s)) s = s.slice(0, -1);
  while (/[)\]]$/.test(s)) {
    const ch = s.slice(-1);
    const opener = ch === ')' ? '(' : '[';
    const opens = s.split(opener).length - 1;
    const closes = s.split(ch).length - 1;
    if (closes > opens) s = s.slice(0, -1);
    else break;
  }
  return s;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderText(text) {
  if (text == null || text === '') return '';
  const s = String(text);
  const parts = [];
  let last = 0;
  s.replace(URL_RE, (match, url, offset) => {
    if (offset > last) parts.push(escapeHtml(s.slice(last, offset)));
    const trimmed = trimTrailingUrl(match);
    const tail = match.slice(trimmed.length);
    const href = trimmed.toLowerCase().startsWith('www.')
      ? 'https://' + trimmed
      : trimmed;
    parts.push(
      `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(trimmed)}</a>`
    );
    if (tail) parts.push(escapeHtml(tail));
    last = offset + match.length;
    return match;
  });
  if (last < s.length) parts.push(escapeHtml(s.slice(last)));
  return parts.join('').replace(/\n/g, '<br>');
}

module.exports = { renderText, escapeHtml, trimTrailingUrl };