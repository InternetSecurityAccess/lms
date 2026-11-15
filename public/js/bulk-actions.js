// public/js/bulk-actions.js
// ═══════════════════════════════════════════════════════════
// Массовые действия в админке.
//
// Работает с разметкой из views/shared/ui/bulk-toolbar.ejs:
//   <div data-bulk-toolbar data-bulk-entity="..." data-bulk-scope="...">
//     <button data-bulk-action="..." data-bulk-method="POST"
//             data-bulk-confirm="..."
//             data-bulk-ok-text="..." data-bulk-ok-class="..."
//             data-bulk-needs-reason="1">
//
// Чекбоксы строк:  <input data-bulk-checkbox data-bulk-scope="...">
// Чекбокс «все»:   <input data-bulk-all data-bulk-scope="...">
//                  (обычно в <th>, вне тулбара — поэтому ищем
//                   не через toolbar.querySelector, а по scope
//                   или вверх по DOM)
//
// Подтверждение — через window.confirmAsync (public/js/confirm.js).
// okText/okClass берутся из data-bulk-ok-* (задаются в шаблоне через
// actions[].okText / okClass). Если их нет — confirm.js подхватит
// по action (RULES) или по тексту сообщения (regex fallback).
// ═══════════════════════════════════════════════════════════
(() => {
  'use strict';
  const toolbars = document.querySelectorAll('[data-bulk-toolbar]');
  if (toolbars.length === 0) return;

  function checkboxesOf(toolbar) {
    const scope = toolbar.dataset.bulkScope || '';
    const sel = scope
      ? `[data-bulk-checkbox][data-bulk-scope="${scope}"]`
      : '[data-bulk-checkbox]';
    return Array.from(document.querySelectorAll(sel));
  }

  function allCheckboxOf(toolbar) {
    const direct = toolbar.querySelector('[data-bulk-all]');
    if (direct) return direct;
    const scope = toolbar.dataset.bulkScope || '';
    if (scope) {
      const byScope = document.querySelector(`[data-bulk-all][data-bulk-scope="${scope}"]`);
      if (byScope) return byScope;
    }
    let parent = toolbar.parentElement;
    while (parent && parent !== document.body) {
      const found = parent.querySelector('[data-bulk-all]');
      if (found) return found;
      parent = parent.parentElement;
    }
    return null;
  }

  function findToolbarForAll(all) {
    const direct = all.closest('[data-bulk-toolbar]');
    if (direct) return direct;
    const scope = all.dataset.bulkScope || '';
    if (scope) {
      const byScope = document.querySelector(`[data-bulk-toolbar][data-bulk-scope="${scope}"]`);
      if (byScope) return byScope;
    }
    if (toolbars.length === 1) return toolbars[0];
    let parent = all.parentElement;
    while (parent && parent !== document.body) {
      const found = parent.querySelector('[data-bulk-toolbar]');
      if (found) return found;
      parent = parent.parentElement;
    }
    return null;
  }

  function updateToolbar(toolbar) {
    const boxes = checkboxesOf(toolbar);
    const checked = boxes.filter((cb) => cb.checked);
    const countEl = toolbar.querySelector('[data-bulk-count]');
    if (countEl) countEl.textContent = String(checked.length);
    const actions = toolbar.querySelectorAll('[data-bulk-action]');
    actions.forEach((btn) => { btn.disabled = checked.length === 0; });
    const all = allCheckboxOf(toolbar);
    if (all) {
      all.checked = checked.length > 0 && checked.length === boxes.length;
      all.indeterminate = checked.length > 0 && checked.length < boxes.length;
    }
  }

  document.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-bulk-checkbox]');
    if (cb) {
      toolbars.forEach(updateToolbar);
      return;
    }
    const all = e.target.closest('[data-bulk-all]');
    if (all) {
      const toolbar = findToolbarForAll(all);
      if (!toolbar) return;
      const boxes = checkboxesOf(toolbar);
      boxes.forEach((c) => { c.checked = all.checked; });
      updateToolbar(toolbar);
    }
  });

  document.addEventListener('click', async (e) => {
    const clearBtn = e.target.closest('[data-bulk-clear]');
    if (clearBtn) {
      e.preventDefault();
      const toolbar = clearBtn.closest('[data-bulk-toolbar]');
      if (!toolbar) return;
      const boxes = checkboxesOf(toolbar);
      boxes.forEach((cb) => { cb.checked = false; });
      updateToolbar(toolbar);
      return;
    }

    const btn = e.target.closest('[data-bulk-action]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const toolbar = btn.closest('[data-bulk-toolbar]');
    if (!toolbar) return;
    const boxes = checkboxesOf(toolbar);
    const checked = boxes.filter((cb) => cb.checked);
    if (checked.length === 0) return;
    const endpoint = btn.dataset.bulkAction;
    const entity = toolbar.dataset.bulkEntity || '';
    const method = btn.dataset.bulkMethod || 'POST';
    const confirmMsg = btn.dataset.bulkConfirm
      || `Выполнить действие для ${checked.length} элементов?`;
    // okText/okClass читаются из data-bulk-ok-*, которые рендерит
    // bulk-toolbar.ejs из actions[].okText / okClass.
    // Если атрибута нет — передаём undefined, и confirm.js сам
    // определит текст и класс через detectStyle() по confirmMsg.
    const okText = btn.dataset.bulkOkText || undefined;
    const okClass = btn.dataset.bulkOkClass || undefined;
    const needsReason = btn.dataset.bulkNeedsReason === '1';
    let reason = null;
    if (needsReason) {
      reason = prompt('Причина (необязательно):', '');
      if (reason === null) return;
    }
    const ok = await window.confirmAsync(confirmMsg, { okText, okClass });
    if (!ok) return;

    const form = document.createElement('form');
    form.method = method;
    form.action = endpoint;
    form.style.display = 'none';
    form.dataset.confirmed = '1';
    form.dataset.skipConfirm = '1';
    const add = (name, value) => {
      const inp = document.createElement('input');
      inp.type = 'hidden';
      inp.name = name;
      inp.value = value;
      form.appendChild(inp);
    };
    add('entity', entity);
    for (const cb of checked) add('ids', cb.value);
    if (reason != null) add('reason', reason);
    document.body.appendChild(form);
    form.submit();
  });

  toolbars.forEach(updateToolbar);
})();