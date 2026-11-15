// public/js/modal-open.js
// Универсальная обработка модалок:
//   • [data-modal-open="<id>"] — открыть модалку #<id>;
//   • [data-modal-close] — закрыть ближайшую .modal;
//   • Escape — закрыть модалку;
//   • tr[data-href] — кликабельная строка (админские списки).
// Работает на всех страницах: преподаватель, студент, админ.
(() => {
  'use strict';
  if (window.__modalOpenBound) return;
  window.__modalOpenBound = true;

  function closeModal(modal) {
    if (!modal) return;
    modal.hidden = true;
    if (!document.querySelector('.modal:not([hidden])')) {
      document.body.classList.remove('modal-open');
    }
  }

  // Модалки: открытие/закрытие
  document.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-modal-open]');
    if (openBtn) {
      e.preventDefault();
      const id = openBtn.dataset.modalOpen;
      const modal = document.getElementById(id);
      if (!modal) return;
      modal.hidden = false;
      document.body.classList.add('modal-open');
      const focusable = modal.querySelector(
        'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])'
      );
      if (focusable) setTimeout(() => focusable.focus(), 30);
      return;
    }
    const closeBtn = e.target.closest('[data-modal-close]');
    if (closeBtn) {
      e.preventDefault();
      closeModal(closeBtn.closest('.modal'));
    }
  });

  // Кликабельные строки: tr[data-href]
  document.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-href]');
    if (!row) return;
    if (e.target.closest('a, button, input, select, textarea, form, label')) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const href = row.dataset.href;
    if (href) window.location.href = href;
  });

  // Escape закрывает модалку
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.querySelector('.modal:not([hidden])');
    if (!modal) return;
    e.preventDefault();
    closeModal(modal);
  });
})();