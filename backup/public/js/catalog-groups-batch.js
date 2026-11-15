// public/js/catalog-groups-batch.js
// Пакетное сохранение подписок на группы в каталоге /groups.
//   • чекбоксы не шлют запрос сразу;
//   • кнопка «Сохранить» собирает изменения и отправляет параллельно;
//   • группы, у которых есть работы и которые отвязываются — требуют подтверждения;
//   • после сохранения редирект на /groups?saved=N&added=X&removed=Y,
//     страница показывает зелёный info-box «Сохранено».
(() => {
  'use strict';
  const root = document.getElementById('catalogGroupsForm');
  if (!root) return;
  const saveBtn = document.getElementById('catalogGroupsSave');
  const statusEl = document.getElementById('catalogGroupsStatus');
  if (!saveBtn) return;

  const groups = Array.from(root.querySelectorAll('.catalog-group-checkbox')).map((cb) => ({
    cb,
    id: String(cb.value),
    initial: cb.dataset.initial === '1',
    worksCount: Number(cb.dataset.worksCount) || 0,
    name: cb.dataset.groupName || '',
  }));

  function computeChanges() {
    const toAdd = [];
    const toRemove = [];
    for (const g of groups) {
      if (g.cb.checked && !g.initial) toAdd.push(g);
      else if (!g.cb.checked && g.initial) toRemove.push(g);
    }
    return { toAdd, toRemove };
  }

  function updateState() {
    const { toAdd, toRemove } = computeChanges();
    const changed = toAdd.length + toRemove.length;
    saveBtn.disabled = changed === 0;
    if (changed === 0) {
      statusEl.textContent = '';
      return;
    }
    const parts = [];
    if (toAdd.length > 0) parts.push(`добавить: ${toAdd.length}`);
    if (toRemove.length > 0) parts.push(`убрать: ${toRemove.length}`);
    statusEl.textContent = 'Не сохранено — ' + parts.join(', ');
  }

  groups.forEach((g) => g.cb.addEventListener('change', updateState));
  updateState();

  async function fetchJson(url, opts) {
    const res = await fetch(url, Object.assign({
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    }, opts));
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, data };
  }

  saveBtn.addEventListener('click', async () => {
    const { toAdd, toRemove } = computeChanges();
    if (toAdd.length + toRemove.length === 0) return;

    const withWorks = toRemove.filter((g) => g.worksCount > 0);
    let force = false;
    if (withWorks.length > 0) {
      const names = withWorks.map((g) => `«${g.name}»`).join(', ');
      const msg = `У групп есть работы: ${names}.\n`
        + 'При отвязке они пропадут из «Моих групп» (сами работы и файлы сохранятся).\n\n'
        + 'Продолжить?';
      const ok = await window.confirmAsync(msg, {
        okText: 'Отвязать',
        okClass: 'warning',
      });
      if (!ok) return;
      force = true;
    }

    saveBtn.disabled = true;
    const origLabel = saveBtn.textContent;
    saveBtn.textContent = 'Сохранение…';

    try {
      const results = await Promise.all([
        ...toAdd.map((g) => fetchJson(`/api/my-groups/${g.id}`, { method: 'POST' })),
        ...toRemove.map((g) => fetchJson(
          `/api/my-groups/${g.id}${force ? '?force=1' : ''}`,
          { method: 'DELETE' }
        )),
      ]);
      const failed = results.filter((r) => !r.ok);

      if (failed.length > 0) {
        alert(
          `Не удалось сохранить ${failed.length} из ${results.length} изменений. `
          + 'Страница будет перезагружена — проверьте состояние групп.'
        );
        window.location.reload();
        return;
      }

      // Успех: редирект с параметрами для показа уведомления.
      const total = toAdd.length + toRemove.length;
      const params = new URLSearchParams();
      params.set('saved', String(total));
      if (toAdd.length > 0) params.set('added', String(toAdd.length));
      if (toRemove.length > 0) params.set('removed', String(toRemove.length));
      // Сохраняем поисковый запрос, если был.
      const cur = new URLSearchParams(window.location.search);
      const q = cur.get('q');
      if (q) params.set('q', q);
      window.location.href = '/groups?' + params.toString();
    } catch (e) {
      console.error('catalog save:', e);
      alert('Не удалось сохранить. Проверьте соединение.');
      saveBtn.disabled = false;
      saveBtn.textContent = origLabel;
    }
  });
})();