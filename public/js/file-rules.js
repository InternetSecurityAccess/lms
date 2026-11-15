// public/js/file-rules.js
// Единый источник правил валидации файлов на клиенте.
// Используется: file-validate.js (проверка перед submit),
// dragdrop.js (проверка при drop/change), form-upload-indicator.js
// (показ размеров в оверлее).
// Параметры берутся из data-* атрибутов инпута с fallback на window.__files
// (см. views/layout/footer.ejs: window.__files = <%- JSON.stringify(filesClient) %>).
(() => {
  'use strict';
  if (window.fileRules) return;

  const FILES = window.__files || {};
  const DEFAULT_MAX_MB = Number(FILES.maxFileSizeMb) || 100;
  const DEFAULT_MAX_FILES = Number(FILES.maxFilesPerUpload) || 5;
  const DEFAULT_ACCEPT = String(FILES.acceptUpload || '.pdf,.docx,.pptx,.txt,.zip,.png,.jpg,.jpeg');

  function extOf(name) {
    const s = String(name || '');
    const i = s.lastIndexOf('.');
    return i >= 0 ? s.slice(i).toLowerCase() : '';
  }

  function fmtSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }

  function fmtMb(mb) {
    return mb % 1 === 0 ? `${mb} МБ` : `${mb.toFixed(1)} МБ`;
  }

  function pluralRu(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function allowedExtsOf(acceptString) {
    return new Set(
      String(acceptString || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    );
  }

  function extListText(acceptString) {
    return String(acceptString || '')
      .split(',').map((s) => s.trim()).filter(Boolean).join(', ');
  }

  // Правила для конкретного инпута: data-атрибуты переопределяют глобальные.
  function rulesFor(input) {
    const maxSizeMbAttr = Number(input.dataset.maxSizeMb);
    const maxSizeMb = Number.isFinite(maxSizeMbAttr) && maxSizeMbAttr > 0
      ? maxSizeMbAttr
      : DEFAULT_MAX_MB;
    const maxFilesAttr = Number(input.dataset.maxFiles);
    const maxFiles = Number.isFinite(maxFilesAttr) && maxFilesAttr >= 1
      ? maxFilesAttr
      : DEFAULT_MAX_FILES;
    const accept = input.getAttribute('accept') || DEFAULT_ACCEPT;
    return { maxSizeMb, maxFiles, accept, allowed: allowedExtsOf(accept) };
  }

  // Проверка одного файла. Возвращает null (ок) или строку-ошибку.
  function validateFile(file, rules) {
    if (!file) return 'Файл не выбран.';
    const ext = extOf(file.name);
    if (ext && rules.allowed.size > 0 && !rules.allowed.has(ext)) {
      return `Формат «${ext}» не разрешён. Разрешены: ${extListText(rules.accept)}.`;
    }
    const maxSize = rules.maxSizeMb * 1024 * 1024;
    if (file.size > maxSize) {
      return `Файл «${file.name}» слишком большой (${fmtSize(file.size)}). `
        + `Максимум — ${fmtMb(rules.maxSizeMb)}.`;
    }
    if (file.size === 0) {
      return `Файл «${file.name}» пустой.`;
    }
    return null;
  }

  // Проверка списка: сначала количество, потом каждый файл.
  function validateFiles(files, rules) {
    const errors = [];
    const list = Array.from(files || []);
    if (list.length > rules.maxFiles) {
      errors.push(
        `Можно прикрепить не более ${rules.maxFiles} `
        + `${pluralRu(rules.maxFiles, 'файла', 'файлов', 'файлов')}. `
        + `Сейчас выбрано: ${list.length}.`
      );
    }
    for (const f of list) {
      const err = validateFile(f, rules);
      if (err) errors.push(err);
    }
    return errors;
  }

  window.fileRules = {
    FILES,
    DEFAULT_MAX_MB,
    DEFAULT_MAX_FILES,
    DEFAULT_ACCEPT,
    extOf,
    fmtSize,
    fmtMb,
    pluralRu,
    allowedExtsOf,
    extListText,
    rulesFor,
    validateFile,
    validateFiles,
  };
})();