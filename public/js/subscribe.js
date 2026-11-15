// public/js/subscribe.js
(() => {
  'use strict';
  document.querySelectorAll('.subscribe-checkbox').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const url = cb.dataset.url;
      if (!url) return;
      const method = cb.checked ? 'POST' : 'DELETE';
      const prev = !cb.checked;
      const isGroupSubscription = url.startsWith('/api/my-groups/');
      if (method === 'DELETE' && isGroupSubscription) {
        const ok = await window.confirmAsync(
          'Снять «Моя группа»?\n\n' +
          'ВСЕ предметы, привязанные к этой группе, будут АВТОМАТИЧЕСКИ ОТВЯЗАНЫ. ' +
          'Студенты потеряют доступ к предметам.\n\n' +
          'Работы, оценки и чат сохранятся.'
        );
        if (!ok) { cb.checked = prev; return; }
      }
      if (method === 'POST' && isGroupSubscription) {
        const ok = await window.confirmAsync(
          'Отметить «Моя группа»?\n\n' +
          'Вы получите доступ к чату группы, объявлениям и управлению студентами. ' +
          'Все студенты группы автоматически подпишутся на вас.'
        );
        if (!ok) { cb.checked = prev; return; }
      }
      cb.disabled = true;
      try {
        if (method === 'DELETE') {
          const res1 = await fetch(url, {
            method, credentials: 'same-origin',
            headers: { Accept: 'application/json' },
          });
          if (res1.status === 409) {
            const data = await res1.json().catch(() => ({}));
            // ← ИЗМЕНЕНО: сервер возвращает { ok: false, error, message, works }.
            const msg = (data && (data.message || data.error)) || 'Продолжить?';
            const ok2 = await window.confirmAsync(msg);
            if (!ok2) { cb.checked = prev; return; }
            const res2 = await fetch(url + '?force=1', {
              method, credentials: 'same-origin',
              headers: { Accept: 'application/json' },
            });
            const data2 = await res2.json().catch(() => ({}));
            if (!res2.ok || data2.ok === false) throw new Error('fail');
          } else if (!res1.ok) {
            const data = await res1.json().catch(() => ({}));
            throw new Error((data && (data.message || data.error)) || 'fail');
          }
        } else {
          const res = await fetch(url, {
            method, credentials: 'same-origin',
            headers: { Accept: 'application/json' },
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            throw new Error((data && (data.message || data.error)) || 'fail');
          }
        }
      } catch (e) {
        console.error('subscribe error', e);
        cb.checked = prev;
        alert('Не удалось сохранить. Проверьте соединение.');
      } finally {
        cb.disabled = false;
      }
    });
  });
})();