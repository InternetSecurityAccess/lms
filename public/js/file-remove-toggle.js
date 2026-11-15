// public/js/file-remove-toggle.js
(() => {
  'use strict';
  document.querySelectorAll('form').forEach((form) => {
    form.querySelectorAll('.js-toggle-remove').forEach((btn) => {
      if (btn.dataset.fileRemoveBound === '1') return;
      btn.dataset.fileRemoveBound = '1';
      btn.addEventListener('click', () => {
        const id = btn.dataset.fileId;
        const input = form.querySelector(`[data-remove-input="${id}"]`);
        const row = form.querySelector(`.file-row[data-file-id="${id}"]`);
        if (!input || !row) return;
        const willMark = btn.dataset.marked !== '1';
        btn.dataset.marked = willMark ? '1' : '0';
        btn.textContent = willMark ? 'Отменить' : 'Удалить';
        btn.classList.toggle('btn-danger-soft', !willMark);
        btn.classList.toggle('btn-ghost', willMark);
        // toggle — это изменение состояния формы, но input/change/paste
        // не срабатывают. Помечаем dirty явно, иначе уход со страницы
        // без сохранения не спросит подтверждения.
        input.disabled = !willMark;
        row.classList.toggle('is-marked', willMark);
        window.UnsavedGuard?.markDirty();
      });
    });
  });
})();