// public/js/unsaved-guard.js
// Защита от случайной потери несохранённых изменений.
// Активируется opt-in: <form data-unsaved-guard>.
//
// Два уровня:
//   1. Клик по навигационной ссылке (назад, к списку, отмена и т.п.) —
//      перехватываем, показываем модал «Сохранить / Не сохранять / Отмена».
//   2. Закрытие вкладки, F5, кнопка «Назад» браузера — стандартный
//      beforeunload с системным диалогом «Покинуть / Остаться»
//      (текст и кнопки кастомизировать нельзя — политика браузеров).
(() => {
  'use strict';
  const forms = document.querySelectorAll('form[data-unsaved-guard]');
  if (forms.length === 0) {
    window.UnsavedGuard = {
      markDirty: () => {},
      markClean: () => {},
      isDirty: () => false,
    };
    return;
  }

  let dirty = false;
  let bypass = false;
  let modalEl = null;
  let pendingHref = null;

  function markDirty() {
    if (!dirty) {
      dirty = true;
      forms.forEach((f) => f.classList.add('is-dirty'));
    }
  }
  function markClean() {
    dirty = false;
    forms.forEach((f) => f.classList.remove('is-dirty'));
  }
  // На странице всегда одна форма с data-unsaved-guard — либо тема,
  // либо задание. Но если когда-нибудь появится вторая, «Сохранить»
  // будет отправлять первую.
  function getMainForm() { return forms[0]; }

  for (const form of forms) {
    // capture: true — ловим ввод внутри Quill и других обёрток,
    // которые могут останавливать всплытие.
    form.addEventListener('input', markDirty, true);
    form.addEventListener('change', markDirty, true);
    form.addEventListener('paste', markDirty, true);

    // Пользователь отправил форму — защита больше не нужна.
    // requestSubmit() вызовет этот же handler.
    form.addEventListener('submit', () => {
      dirty = false;
      bypass = true;
      forms.forEach((f) => f.classList.remove('is-dirty'));
    });
  }

  /* ═══════════════════════════════════════════════════════════
     Модал «Сохранить / Не сохранять / Отмена»
     ═══════════════════════════════════════════════════════════ */
  function ensureModal() {
    if (modalEl) return modalEl;
    const el = document.createElement('div');
    el.id = 'unsavedGuardModal';
    el.className = 'modal';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <div class="modal-backdrop" data-role="backdrop"></div>
      <div class="modal-dialog" role="document">
        <div class="modal-header">
          <h3 data-role="title">Есть несохранённые изменения</h3>
          <button type="button" class="modal-close" data-role="close" aria-label="Закрыть">✕</button>
        </div>
        <p style="white-space: pre-line; margin: 0;">
          Вы изменили данные, но не сохранили их.
          Если уйдёте сейчас — изменения будут потеряны.
        </p>
        <div class="actions-row" style="justify-content: flex-end; gap: 8px; margin-top: 16px;">
          <button type="button" class="btn btn-secondary" data-role="cancel">Отмена</button>
          <button type="button" class="btn btn-danger" data-role="discard">Не сохранять</button>
          <button type="button" class="btn btn-success" data-role="save">Сохранить</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      const role = e.target.closest('[data-role]')?.dataset.role;
      if (!role) return;

      if (role === 'save') {
        el.hidden = true;
        document.body.classList.remove('modal-open');
        const form = getMainForm();
        if (!form) return;
        // dirty сбрасывает submit-listener — только если форма прошла
        // HTML5-валидацию. При невалидности форма остаётся dirty,
        // пользователь увидит подсказку браузера у поля.
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          // Fallback для старых браузеров: form.submit() не эмитит
          // событие submit, снимаем dirty вручную.
          dirty = false;
          bypass = true;
          form.submit();
        }
        return;
      }

      if (role === 'discard') {
        el.hidden = true;
        document.body.classList.remove('modal-open');
        dirty = false;
        bypass = true;
        const href = pendingHref;
        pendingHref = null;
        if (href) window.location.href = href;
        return;
      }

      if (role === 'cancel' || role === 'close' || role === 'backdrop') {
        el.hidden = true;
        document.body.classList.remove('modal-open');
        pendingHref = null;
      }
    });
    document.addEventListener('keydown', (e) => {
      if (el.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        el.hidden = true;
        document.body.classList.remove('modal-open');
        pendingHref = null;
      }
    }, true);
    modalEl = el;
    return el;
  }

  function showModal(href) {
    const el = ensureModal();
    pendingHref = href || null;
    el.hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(() => el.querySelector('[data-role="cancel"]')?.focus(), 30);
  }

  /* ═══════════════════════════════════════════════════════════
     Перехват навигации по ссылкам
     ═══════════════════════════════════════════════════════════
     Пропускаем:
       • не-ссылки и ссылки без href
       • target="_blank"
       • download
       • data-file-preview — открывает модал просмотра, не навигация
       • data-confirm — свой диалог (не дублируем)
       • data-skip-unsaved-guard — ручной opt-out
       • href="#…", javascript:, /file/*, /download*, /uploads/*,
         /support/image/* — скачивание/просмотр, не уход со страницы
       • клики с модификаторами (ctrl/cmd/shift/alt) и не ЛКМ
       • ссылки на текущий URL
     Всё остальное (назад, к предмету, отмена, к заданиям и т.п.)
     перехватываем и показываем модал.
     ═══════════════════════════════════════════════════════════ */
  function isNavigationLink(a) {
    if (!a || a.tagName !== 'A') return false;
    if (!a.getAttribute('href')) return false;
    if (a.getAttribute('target') === '_blank') return false;
    if (a.hasAttribute('download')) return false;
    if (a.hasAttribute('data-file-preview')) return false;
    if (a.hasAttribute('data-confirm')) return false;
    if (a.hasAttribute('data-skip-unsaved-guard')) return false;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) return false;
    if (href.startsWith('javascript:')) return false;
    if (/^\/file\//.test(href)) return false;
    if (/^\/download\//.test(href)) return false;
    if (/^\/download-file\//.test(href)) return false;
    if (/^\/chat\/download\//.test(href)) return false;
    if (/^\/uploads\//.test(href)) return false;
    if (/^\/support\/image\//.test(href)) return false;
    return true;
  }

  document.addEventListener('click', (e) => {
    if (!dirty || bypass) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.button !== 0) return;

    const a = e.target.closest('a');
    if (!isNavigationLink(a)) return;

    // Перезагрузка той же страницы — не «уход», не мешаем (F5 обработает
    // beforeunload ниже).
    try {
      const target = new URL(a.href, window.location.origin);
      const current = window.location.pathname + window.location.search + window.location.hash;
      if (target.pathname + target.search + target.hash === current) return;
    } catch { /* ignore */ }

    e.preventDefault();
    e.stopPropagation();
    showModal(a.href);
  }, true);

  /* ═══════════════════════════════════════════════════════════
     Fallback: закрытие вкладки, F5, кнопка «Назад» браузера
     ═══════════════════════════════════════════════════════════ */
  window.addEventListener('beforeunload', (e) => {
    if (!dirty || bypass) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  window.UnsavedGuard = {
    markDirty,
    markClean,
    isDirty: () => dirty,
  };
})();