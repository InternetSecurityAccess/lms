// public/js/reset-password.js
(() => {
  'use strict';
  const modal = document.getElementById('resetPasswordModal');
  if (!modal) return;
  const nameEl = document.getElementById('rpStudentName');
  const passEl = document.getElementById('rpPassword');
  const digitsEl = document.getElementById('rpDigitsCount');
  const copyBtn = document.getElementById('rpCopy');
  const closeBtn = document.getElementById('rpClose');
  const backdrop = modal.querySelector('.modal-backdrop');
  function openModal(displayName, password, digits) {
    if (nameEl) nameEl.textContent = displayName || '';
    if (passEl) passEl.textContent = password || '';
    if (digitsEl) digitsEl.textContent = String(digits || (password || '').length);
    modal.hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(() => closeBtn && closeBtn.focus(), 50);
  }
  function closeModal() {
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    if (nameEl) nameEl.textContent = '';
    if (passEl) passEl.textContent = '';
    if (digitsEl) digitsEl.textContent = '';
    if (copyBtn) copyBtn.textContent = 'Копировать';
  }
  document.querySelectorAll('.reset-password-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const explicitUrl = btn.dataset.url;
      const studentId = btn.dataset.studentId;
      const groupId = btn.dataset.groupId;
      const displayName = btn.dataset.userName
        || btn.dataset.studentName
        || 'пользователю';
      let url;
      if (explicitUrl) {
        url = explicitUrl;
      } else if (studentId && groupId) {
        url = `/g/${groupId}/students/${studentId}/reset-password`;
      } else {
        return;
      }
      const ok = await window.confirmAsync(
        `Сбросить пароль ${displayName}?\n\n` +
        `Старый пароль перестанет работать. Новый пароль будет показан один раз.`
      );
      if (!ok) return;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = 'Сброс…';
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
        });
        let data = {};
        try { data = await res.json(); } catch { /* ignore */ }
        // ← ИЗМЕНЕНО: { ok: false, error, message } при ошибке.
        if (!res.ok || data.ok === false) {
          throw new Error(
            (data && (data.message || data.error))
            || `Ошибка ${res.status}`
          );
        }
        if (!data.password) throw new Error('Сервер не вернул пароль.');
        const display = data.userName || displayName;
        openModal(display, data.password, data.passwordDigits || data.password.length);
      } catch (e) {
        console.error('reset-password error:', e);
        alert('Не удалось сбросить пароль: ' + (e.message || 'неизвестная ошибка'));
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = (passEl && passEl.textContent) || '';
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const range = document.createRange();
          range.selectNodeContents(passEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('copy');
          sel.removeAllRanges();
        }
        copyBtn.textContent = 'Скопировано!';
        setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1500);
      } catch (e) {
        console.error('copy error:', e);
        copyBtn.textContent = 'Не удалось';
        setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1500);
      }
    });
  }
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (backdrop) backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });
  if (modal.dataset.autoPassword) {
    const displayName = modal.dataset.autoName || '';
    const password = modal.dataset.autoPassword;
    const digits = Number(modal.dataset.autoDigits) || password.length;
    setTimeout(() => openModal(displayName, password, digits), 30);
  }
})();