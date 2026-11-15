// public/js/theme.js
(() => {
  'use strict';
  const KEY = 'workstud-theme';
  const stored = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();

  function apply(theme) {
    document.documentElement.classList.toggle('light-theme', theme === 'light');
    const btn = document.getElementById('themeToggle');
    if (btn) {
      const isLight = theme === 'light';
      btn.textContent = isLight ? 'Тёмная тема' : 'Светлая тема';
      btn.setAttribute('aria-label', isLight ? 'Переключить на тёмную' : 'Переключить на светлую');
    }
  }

  function toggleTheme() {
    const isLight = document.documentElement.classList.contains('light-theme');
    const next = isLight ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
    apply(next);
  }

  window.toggleTheme = toggleTheme;

  function init() {
    apply(stored === 'light' ? 'light' : 'dark');
    const btn = document.getElementById('themeToggle');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', toggleTheme);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();