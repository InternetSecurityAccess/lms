// public/js/confirm.js
(() => {
  'use strict';
  if (window.__confirmBound) return;
  window.__confirmBound = true;
  let modalEl = null;
  let currentResolve = null;
  function ensureModal() {
    if (modalEl) return modalEl;
    const el = document.createElement('div');
    el.id = 'appConfirmModal';
    el.className = 'modal';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <div class="modal-backdrop" data-role="backdrop"></div>
      <div class="modal-dialog" role="document">
        <div class="modal-header">
          <h3 data-role="title">Подтверждение</h3>
          <button type="button" class="modal-close" data-role="close" aria-label="Закрыть">✕</button>
        </div>
        <p data-role="text" style="white-space: pre-line; margin: 0;"></p>
        <div class="actions-row" style="justify-content: flex-end; gap: 8px; margin-top: 16px;">
          <button type="button" class="btn btn-secondary" data-role="cancel">Отмена</button>
          <button type="button" class="btn btn-primary" data-role="ok">Подтвердить</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      const role = e.target.closest('[data-role]')?.dataset.role;
      if (!role) return;
      if (role === 'ok') finish(true);
      else if (role === 'cancel' || role === 'close' || role === 'backdrop') finish(false);
    });
    document.addEventListener('keydown', (e) => {
      if (el.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(false);
      } else if (e.key === 'Enter') {
        if (document.activeElement?.dataset?.role !== 'cancel') {
          e.preventDefault();
          e.stopImmediatePropagation();
          finish(true);
        }
      }
    }, true);
    modalEl = el;
    return el;
  }
  function finish(result) {
    if (!modalEl) return;
    modalEl.hidden = true;
    document.body.classList.remove('modal-open');
    const r = currentResolve;
    currentResolve = null;
    if (r) r(result);
  }
  function detectStyle(message) {
    const m = String(message || '').toLowerCase().trim();
    if (/^восстанов/.test(m)) {
      return { cls: 'btn btn-success', text: 'Восстановить' };
    }
    if (/(удал|убить|стереть|стёр|очист)/.test(m)) {
      return { cls: 'btn btn-danger', text: 'Удалить' };
    }
    if (/отклон/.test(m)) {
      return { cls: 'btn btn-danger', text: 'Отклонить' };
    }
    if (/(снять|отвяз|завершить)/.test(m)) {
      return { cls: 'btn btn-danger', text: 'Снять' };
    }
    if (/(архив|выпустить|перемест)/.test(m)) {
      return { cls: 'btn btn-warning', text: 'В архив' };
    }
    if (/подтверд|принять/.test(m)) {
      return { cls: 'btn btn-success', text: 'Подтвердить' };
    }
    return { cls: 'btn btn-primary', text: 'Подтвердить' };
  }
  function resolveOkClass(raw, fallback) {
    if (raw == null) return fallback;
    const s = String(raw).trim();
    if (!s) return fallback;
    return s.startsWith('btn') ? s : `btn btn-${s}`;
  }
  /**
   * Нормализует сообщение: EJS-экранирование превращает `&#10;` в `&amp;#10;`,
   * браузер декодирует в literal `&#10;`. Заменяем оба варианта на реальный \n,
   * чтобы `white-space: pre-line` работал как задумано.
   */
  function normalizeMessage(raw) {
    return String(raw || '')
      .replace(/&amp;#10;/g, '\n')
      .replace(/&#10;/g, '\n');
  }
  window.confirmAsync = function (message, options = {}) {
    const el = ensureModal();
    const titleEl = el.querySelector('[data-role="title"]');
    const textEl = el.querySelector('[data-role="text"]');
    const okBtn = el.querySelector('[data-role="ok"]');
    const cancelBtn = el.querySelector('[data-role="cancel"]');
    const normalized = normalizeMessage(message || 'Продолжить?');
    titleEl.textContent = options.title || 'Подтверждение';
    textEl.textContent = normalized;
    const style = detectStyle(normalized);
    okBtn.className = resolveOkClass(options.okClass, style.cls);
    okBtn.textContent = options.okText || style.text;
    el.hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(() => cancelBtn.focus(), 30);
    return new Promise((resolve) => {
      currentResolve = resolve;
    });
  };
  window.confirmSafe = function (msg) {
    return window.confirmAsync(msg);
  };
  function optsFromDataset(el) {
    if (!el) return undefined;
    const okText = el.dataset.confirmOkText || undefined;
    const okClass = el.dataset.confirmOkClass || undefined;
    if (okText === undefined && okClass === undefined) return undefined;
    return { okText, okClass };
  }
  function cleanMsg(s) {
    if (!s) return null;
    const t = String(s).trim();
    if (t === '$1' || t === '') return null;
    return t;
  }
  function submitConfirmed(form, submitter) {
    form.dataset.confirmed = '1';
    try {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit(submitter || undefined);
      } else {
        form.submit();
      }
    } finally {
      form.dataset.confirmed = '';
    }
  }
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-confirm]');
    if (!el) return;
    const msg = cleanMsg(el.dataset.confirm);
    if (!msg) return;
    if (el.tagName === 'FORM') return;
    const form = el.closest('form') || el.form || null;
    const isSubmitBtn =
      (el.tagName === 'BUTTON' && (el.type === 'submit' || el.type === '')) ||
      (el.tagName === 'INPUT' && el.type === 'submit');
    const ownOpts = optsFromDataset(el);
    if (isSubmitBtn && form && !cleanMsg(form.dataset.confirm)) {
      if (form.dataset.confirmed === '1') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const ok = await window.confirmAsync(msg, ownOpts || {});
      if (!ok) return;
      submitConfirmed(form, el);
      return;
    }
    if (isSubmitBtn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const ok = await window.confirmAsync(msg, ownOpts || {});
    if (!ok) return;
    if (el.tagName === 'A' && el.href) {
      window.location.href = el.href;
    } else if (el.form) {
      submitConfirmed(el.form, el);
    }
  }, true);
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-confirm]');
    if (!form) return;
    if (form.dataset.confirmed === '1') return;
    const msg = cleanMsg(form.dataset.confirm);
    if (!msg) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const ok = await window.confirmAsync(msg, optsFromDataset(form) || {});
    if (!ok) return;
    submitConfirmed(form);
  }, true);
  const RULES = [
    { re: /\/students\/\d+\/reset-password(\/|\?|$)/,
      msg: 'Сбросить пароль студенту?\n\nСтарый перестанет работать. Новый будет показан один раз.' },
    { re: /\/teachers\/\d+\/reset-password(\/|\?|$)/,
      msg: 'Сбросить пароль преподавателю?\n\nСтарый перестанет работать. Новый будет показан один раз.' },
    { re: /\/approvals\/\d+\/approve(\/|\?|$)/,
      msg: 'Подтвердить регистрацию?\n\nСтудент получит полный доступ к системе.' },
    { re: /\/approvals\/\d+\/reject(\/|\?|$)/,
      msg: 'Отклонить регистрацию?\n\nСтудент увидит причину и не сможет войти.' },
    { re: /\/students\/\d+\/approve(\/|\?|$)/,
      msg: 'Подтвердить регистрацию студента?' },
    { re: /\/students\/\d+\/reject(\/|\?|$)/,
      msg: 'Отклонить регистрацию студента?\n\nСтудент увидит причину и не сможет войти.' },
    { re: /\/sessions\/user\/[^/]+\/\d+\/logout-all(\/|\?|$)/,
      msg: 'Завершить ВСЕ сессии пользователя?\n\nВсе его устройства будут разлогинены.' },
    { re: /\/sessions\/[^/]+\/delete(\/|\?|$)/,
      msg: 'Завершить эту сессию?\n\nУстройство будет разлогинено.' },
    { re: /\/works\/\d+\/status(\/|\?|$)/,
      msg: 'Изменить статус работы?\n\nСтудент увидит новый статус.' },
    { re: /\/announcements\/\d+\/pin(\/|\?|$)/,
      msg: 'Закрепить или открепить объявление?' },
    { re: /\/chat\/clear(\/|\?|$)/,
      msg: 'Очистить весь чат?\n\nВсе сообщения и вложения будут удалены. Необратимо.' },
    { re: /\/support\/\d+\/clear(\/|\?|$)/,
      msg: 'Очистить всю переписку?\n\nВсе сообщения и скриншоты будут удалены. Необратимо.' },
    { re: /\/messages\/\d+\/delete(\/|\?|$)/,
      msg: 'Удалить сообщение?\n\nОно исчезнет у всех участников.' },
    { re: /\/detach(\/|\?|$)/,
      msg: 'Отвязать от группы?\n\nСтуденты этой группы потеряют доступ к предмету.' },
    { re: /\/toggle-active(\/|\?|$)/,
      msg: 'Изменить статус?\n\nПри архивации пользователь не сможет войти в систему.' },
    { re: /\/change-group(\/|\?|$)/,
      msg: 'Перевести в другую группу?\n\nСтарые работы останутся в прежней группе.' },
    { re: /\/unarchive(\/|\?|$)/,
      msg: 'Восстановить из архива?' },
    { re: /\/archive(\/|\?|$)/,
      msg: 'Переместить в архив?\n\nДанные сохранятся, но станут недоступны для обычных пользователей.' },
    { re: /\/delete(\/|\?|$)/,
      msg: 'Удалить?\n\nДействие необратимо. Все связанные данные и файлы будут стёрты.' },
  ];
  function checkImport(form) {
    const mode = form.querySelector('[data-import-mode]')?.value;
    if (mode !== 'delete') return null;
    const hard = form.querySelector('input[name="hard_delete"]');
    if (hard && hard.checked) {
      return 'УДАЛИТЬ НАВСЕГДА?\n\nВсе работы, чат и подписки этих пользователей будут стёрты безвозвратно.\n\nПродолжить?';
    }
    return 'Архивировать записи из списка? Данные сохранятся.';
  }
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form');
    if (!form) return;
    if (cleanMsg(form.dataset.confirm)) return;
    if (form.dataset.skipConfirm === '1') return;
    if (form.dataset.confirmed === '1') return;
    const action = form.getAttribute('action') || '';
    let msg = null;
    if (/\/import\//.test(action)) {
      msg = checkImport(form);
    } else {
      for (const rule of RULES) {
        if (rule.re.test(action)) { msg = rule.msg; break; }
      }
    }
    if (!msg) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const ok = await window.confirmAsync(msg, optsFromDataset(form) || {});
    if (!ok) return;
    submitConfirmed(form);
  }, true);
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-auto-submit]');
    if (!sel) return;
    const form = sel.closest('form');
    if (!form) return;
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
  }, true);
})();