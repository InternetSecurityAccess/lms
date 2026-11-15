// utils/sanitize.js
'use strict';
const sanitizeHtmlLib = require('sanitize-html');
// Встраивание внешних ресурсов в HTML темы отключено:
//   • <iframe> и <video> не разрешены — теги вырезаются;
//   • из медиа остались только <img src="/uploads/lecture-images/...">;
//   • картинки с внешних доменов не проходят (см. IMG_SRC_RE).
// Видео к теме грузится как обычное вложение (attachments) и
// отдаётся через /file/attachment/:id — этот путь не в тексте темы,
// поэтому sanitize его не касается.
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
  'blockquote', 'ol', 'ul', 'li', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'pre', 'code', 'span', 'sub', 'sup', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
];
const ALLOWED_ATTRIBUTES = {
  a: ['href', 'title', 'target', 'rel'],
  span: ['class', 'style'],
  p: ['class', 'style'],
  h1: ['class', 'style'],
  h2: ['class', 'style'],
  h3: ['class', 'style'],
  h4: ['class', 'style'],
  h5: ['class', 'style'],
  h6: ['class', 'style'],
  li: ['class'],
  blockquote: ['class'],
  code: ['class'],
  pre: ['class'],
  img: ['src', 'alt', 'title', 'width', 'height', 'style', 'class'],
  table: ['style', 'class', 'border', 'cellpadding', 'cellspacing'],
  colgroup: ['span'],
  col: ['span', 'width'],
  thead: [],
  tbody: [],
  tfoot: [],
  tr: ['style'],
  td: ['colspan', 'rowspan', 'style', 'class'],
  th: ['colspan', 'rowspan', 'style', 'class'],
  caption: ['style'],
};
const ALLOWED_STYLES = {
  '*': {
    color: [/^#[0-9a-f]{3,6}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i],
    'background-color': [/^#[0-9a-f]{3,6}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i],
    'text-align': [/^left$/, /^right$/, /^center$/, /^justify$/],
    'font-size': [/^\d+(px|em|rem|%)$/],
    'font-family': [/^[\w\s,"'-]+$/],
    'vertical-align': [/^top$/, /^middle$/, /^bottom$/],
    'white-space': [/^normal$/, /^nowrap$/, /^pre$/, /^pre-wrap$/],
    'word-break': [/^normal$/, /^break-word$/],
    'width': [/^\d+(px|%|em|rem)$/],
    'min-width': [/^\d+(px|%|em|rem)$/],
    'height': [/^\d+(px|%|em|rem)$/],
    'float': [/^left$/, /^right$/, /^none$/],
    'margin': [/^\d+(px|em|rem|%)?(\s+\d+(px|em|rem|%)?){0,3}$/],
    'padding': [/^\d+(px|em|rem|%)?(\s+\d+(px|em|rem|%)?){0,3}$/],
    'border': [
      /^\d+(px|em|rem)\s+(solid|dashed|dotted)(\s+(#[0-9a-f]{3,6}|rgba?\([^)]+\)|[a-z]+))?$/i,
      /^none$/,
    ],
    'border-collapse': [/^collapse$/, /^separate$/],
    'border-spacing': [/^\d+(px|em|rem)?(\s+\d+(px|em|rem)?)?$/],
    'border-radius': [/^\d+(px|%|em|rem)$/],
  },
};
// Единственный источник картинок — загрузчик Quill. Он кладёт файл в
// storage/subjects/<subjectId>/lecture-images/, а URL имеет вид
// /uploads/lecture-images/<subjectId>/<uuid>.png|jpg|jpeg.
// Внешние <img src="https://…"> вырезаются — иначе через лекцию можно
// было бы трекать студентов (пиксель-трекеры) или подсунуть фишинг.
const IMG_SRC_RE = /^\/uploads\/lecture-images\/\d+\/[a-f0-9-]+\.(png|jpg|jpeg)$/i;
const IMG_WIDTH_RE = /^\d{1,3}%$|^\d+$/;
function sanitizeHtml(dirty) {
  if (typeof dirty !== 'string') return '';
  return sanitizeHtmlLib(dirty, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedStyles: ALLOWED_STYLES,
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtmlLib.simpleTransform('a', { rel: 'noopener noreferrer' }),
      img: (tagName, attribs) => {
        const src = String(attribs.src || '');
        if (!IMG_SRC_RE.test(src)) {
          return { tagName: 'span', text: '' };
        }
        const clean = { src };
        if (attribs.alt) clean.alt = String(attribs.alt).slice(0, 200);
        if (attribs.title) clean.title = String(attribs.title).slice(0, 200);
        if (attribs.width && IMG_WIDTH_RE.test(String(attribs.width))) {
          clean.width = String(attribs.width);
        }
        if (attribs.height && /^\d+$/.test(String(attribs.height))) {
          clean.height = String(attribs.height);
        }
        if (attribs.style) clean.style = String(attribs.style).slice(0, 500);
        if (attribs.class) clean.class = String(attribs.class).slice(0, 200);
        return { tagName: 'img', attribs: clean };
      },
    },
  });
}
function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function textToHtml(text) {
  const safe = escapeHtml(String(text || ''));
  const withBreaks = safe.replace(/\r?\n/g, '<br>');
  return `<p>${withBreaks}</p>`;
}
function stripHtml(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
module.exports = {
  sanitizeHtml, escapeHtml, textToHtml, stripHtml,
};