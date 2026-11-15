// public/js/admin-table.js
(() => {
  'use strict';
  if (!document.body.classList.contains('admin-body')) return;

  function clearSelection() {
    document.querySelectorAll('.data-table .is-selected').forEach((el) => {
      el.classList.remove('is-selected');
    });
  }

  document.addEventListener('click', (e) => {
    const td = e.target.closest('.data-table td');
    if (!td) return;
    if (e.target.closest('a, button, input, select, textarea, form, details, summary, label')) return;
    // Строки с data-href ведут себя как ссылки — не выделяем
    if (td.closest('tr[data-href]')) return;
    clearSelection();
    td.classList.add('is-selected');
  });

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
    const sel = document.querySelector('.data-table td.is-selected');
    if (!sel) return;
    const text = sel.innerText.trim();
    if (!text) return;
    e.preventDefault();
    const write = (navigator.clipboard && navigator.clipboard.writeText)
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('no clipboard'));
    write.then(() => {
      sel.style.transition = 'background 0.15s';
      sel.style.background = 'var(--success-soft)';
      setTimeout(() => { sel.style.background = ''; }, 350);
    }).catch(() => { /* тихо игнорируем */ });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearSelection();
  });
})();