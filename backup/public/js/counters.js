// public/js/counters.js
(() => {
  'use strict';
  if (!document.querySelector('[data-nav-badge-value]')) return;
  function updateBadge(name, value) {
    const el = document.querySelector(`[data-nav-badge-value="${name}"]`);
    if (!el) return;
    const n = Number(value) || 0;
    el.textContent = String(n);
    el.style.display = n > 0 ? '' : 'none';
  }
  let isFetching = false;
  let pendingRefresh = false;
  async function doFetch() {
    isFetching = true;
    try {
      const res = await fetch('/api/counters', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) {
        if (res.status !== 401) {
          console.warn('[counters] HTTP', res.status);
        }
        return;
      }
      const data = await res.json();
      if (!data || data.ok === false) {
        console.warn('[counters] server error:', data?.error || 'unknown');
        return;
      }
      // Игнорируем служебное поле ok, обновляем только счётчики.
      for (const [key, value] of Object.entries(data)) {
        if (key === 'ok') continue;
        updateBadge(key, value);
      }
    } catch (e) {
      console.warn('[counters] fetch failed:', e.message);
    } finally {
      isFetching = false;
      if (pendingRefresh) {
        pendingRefresh = false;
        doFetch();
      }
    }
  }
  function refresh() {
    if (isFetching) {
      pendingRefresh = true;
      return;
    }
    doFetch();
  }
  window.refreshCounters = refresh;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(refresh, 50);
    }, { once: true });
  } else {
    setTimeout(refresh, 50);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) refresh();
  });
})();