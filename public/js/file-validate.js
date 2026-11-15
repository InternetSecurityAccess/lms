// public/js/file-validate.js
// Клиентская предвалидация файлов до отправки формы.
// Правила — в window.fileRules (public/js/file-rules.js).
// Каждый <input type="file"> может нести свои параметры:
//   data-max-size-mb  — лимит размера файла в МБ
//   data-max-files    — максимум файлов
//   accept            — список расширений
// Если data-атрибут не задан, берём из window.__files.
(() => {
  'use strict';
  if (!window.fileRules) {
    console.warn('[file-validate] file-rules.js не загружен — пропускаю');
    return;
  }
  const R = window.fileRules;

  function getErrorEl(input) {
    if (input.__fileErrorEl) return input.__fileErrorEl;
    const field = input.closest('.field') || input.parentElement;
    if (!field) return null;
    const el = document.createElement('div');
    el.className = 'hint file-error';
    el.hidden = true;
    el.style.color = 'var(--error)';
    el.style.marginTop = 'var(--space-1)';
    field.appendChild(el);
    input.__fileErrorEl = el;
    return el;
  }

  function setError(input, messages) {
    const el = getErrorEl(input);
    if (!el) return;
    if (!messages || messages.length === 0) {
      el.hidden = true;
      el.textContent = '';
      input.setCustomValidity('');
      return;
    }
    el.hidden = false;
    el.textContent = messages.join(' ');
    input.setCustomValidity(messages[0]);
  }

  function attach(input) {
    if (input.dataset.fileValidateBound === '1') return;
    input.dataset.fileValidateBound = '1';
    try {
      const r = R.rulesFor(input);
      console.debug(
        `[file-validate] input#${input.id || '(no id)'} name=${input.name || '—'} `
        + `maxSizeMb=${r.maxSizeMb} maxFiles=${r.maxFiles} accept="${r.accept}"`
      );
    } catch { /* ignore */ }
    input.addEventListener('change', () => {
      const rules = R.rulesFor(input);
      setError(input, R.validateFiles(input.files, rules));
    });
  }

  function init() {
    const inputs = document.querySelectorAll('input[type="file"]');
    if (inputs.length === 0) return;
    inputs.forEach(attach);
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const fileInputs = form.querySelectorAll('input[type="file"]');
      if (fileInputs.length === 0) return;
      let hasError = false;
      fileInputs.forEach((input) => {
        const rules = R.rulesFor(input);
        const errors = R.validateFiles(input.files, rules);
        setError(input, errors);
        if (errors.length > 0) {
          hasError = true;
          try {
            if (!input.hidden) {
              input.scrollIntoView({ behavior: 'smooth', block: 'center' });
              input.focus({ preventScroll: true });
            }
          } catch { /* ignore */ }
        }
      });
      if (hasError) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();