// public/js/form-upload-indicator.js
// Показывает оверлей «Отправка файлов…» при отправке формы с файлами.
// Проценты не считаются: формы шлются обычным submit (не XHR), проценты
// потребовали бы переделки всех форм и парсинга ответов. Оверлей + disabled
// кнопки решают 90% UX: «видно, что грузится» + «нельзя нажать дважды».
(() => {
  'use strict';
  if (window.__uploadIndicatorBound) return;
  window.__uploadIndicatorBound = true;

  function fmtSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function ensureOverlay() {
    let el = document.getElementById('uploadIndicator');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'uploadIndicator';
    el.className = 'upload-indicator';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = ''
      + '<div class="upload-indicator-backdrop"></div>'
      + '<div class="upload-indicator-box">'
      + '  <div class="upload-indicator-spinner" aria-hidden="true"></div>'
      + '  <div class="upload-indicator-title">Отправка файлов…</div>'
      + '  <div class="upload-indicator-files" data-role="files"></div>'
      + '  <div class="upload-indicator-hint">Не закрывайте страницу до завершения.</div>'
      + '</div>';
    document.body.appendChild(el);
    return el;
  }

  function collectFiles(form) {
    const inputs = form.querySelectorAll('input[type="file"]');
    const out = [];
    for (const input of inputs) {
      if (input.disabled) continue;
      const files = input.files;
      if (!files || files.length === 0) continue;
      for (const f of files) {
        out.push({ name: f.name, size: f.size });
      }
    }
    return out;
  }

  function showOverlay(form, files) {
    const el = ensureOverlay();
    const filesEl = el.querySelector('[data-role="files"]');
    if (filesEl) {
      const total = files.reduce((s, f) => s + (f.size || 0), 0);
      filesEl.textContent = '';
      const ul = document.createElement('ul');
      ul.className = 'upload-indicator-list';
      for (const f of files) {
        const sz = fmtSize(f.size);
        const li = document.createElement('li');
        li.textContent = sz ? `${f.name} · ${sz}` : f.name;
        ul.appendChild(li);
      }
      filesEl.appendChild(ul);
      if (files.length > 1) {
        const summary = document.createElement('div');
        summary.className = 'upload-indicator-summary';
        summary.textContent =
          `Всего: ${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')}`
          + (total > 0 ? `, ${fmtSize(total)}` : '');
        filesEl.appendChild(summary);
      }
    }
    el.hidden = false;
    document.body.classList.add('modal-open');

    form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach((b) => {
      b.disabled = true;
      b.dataset._uploadIndicatorDisabled = '1';
    });
  }

  // Регистрируемся в bubble. Все валидаторы (confirm-actions, file-validate)
  // работают в capture и при отказе делают preventDefault +
  // stopImmediatePropagation — до bubble дело не доходит, оверлей не показывается.
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (e.defaultPrevented) return;
    const files = collectFiles(form);
    if (files.length === 0) return;
    showOverlay(form, files);
  }, false);

  // Возврат из bfcache — скрываем оверлей, если он был.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    const el = document.getElementById('uploadIndicator');
    if (el && !el.hidden) {
      el.hidden = true;
      document.body.classList.remove('modal-open');
    }
  });
})();