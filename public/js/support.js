// public/js/support.js
(() => {
  'use strict';
  const container = document.getElementById('supportMessages');
  const refreshBtn = document.getElementById('supportRefreshBtn');
  const countEl = document.getElementById('supportMessageCount');
  const timeEl = document.getElementById('supportLastUpdate');
  const toast = document.getElementById('supportToast');
  const form = document.getElementById('supportForm');
  const textarea = document.getElementById('support-msg');
  const attachment = document.getElementById('supportAttachment');
  const preview = document.getElementById('supportAttachmentPreview');
  const nameEl = document.getElementById('supportAttachmentName');
  const removeBtn = document.getElementById('supportAttachmentRemove');
  const hiddenPath = form ? form.querySelector('input[name="file_path"]') : null;
  const hiddenName = form ? form.querySelector('input[name="file_name"]') : null;

  const dataEl = document.getElementById('support-init-data');
  let supportConfig = {};
  if (dataEl) {
    try { supportConfig = JSON.parse(dataEl.textContent); }
    catch (e) { console.error('support-init-data:', e); }
  }
  // threadId нужен для админской вкладки /admin/support/:id —
  // по нему сервер определяет папку автора треда.
  const threadId = Number(supportConfig.threadId) || null;
  const messagesUrl = supportConfig.messagesUrl;
  if (!container || !messagesUrl) return;

  const POLL_MS = 30000;
  const viewerRole = String(supportConfig.viewerRole || 'user');
  const FILES = window.__files || {};
  const MAX_FILE_SIZE = (Number(FILES.maxFileSizeMb) || 100) * 1024 * 1024;
  const MAX_FILE_SIZE_MB = Number(FILES.maxFileSizeMb) || 100;

  const URL_RE = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function trimTrailingUrl(url) {
    let s = String(url);
    while (/[.,;:!?]$/.test(s)) s = s.slice(0, -1);
    while (/[)\]]$/.test(s)) {
      const ch = s.slice(-1);
      const opener = ch === ')' ? '(' : '[';
      const opens = s.split(opener).length - 1;
      const closes = s.split(ch).length - 1;
      if (closes > opens) s = s.slice(0, -1);
      else break;
    }
    return s;
  }
  function renderText(text) {
    if (text == null || text === '') return '';
    const s = String(text);
    const parts = []; let last = 0;
    s.replace(URL_RE, (match, url, offset) => {
      if (offset > last) parts.push(escapeHtml(s.slice(last, offset)));
      const trimmed = trimTrailingUrl(match);
      const tail = match.slice(trimmed.length);
      const href = trimmed.toLowerCase().startsWith('www.') ? 'https://' + trimmed : trimmed;
      parts.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(trimmed)}</a>`);
      if (tail) parts.push(escapeHtml(tail));
      last = offset + match.length;
      return match;
    });
    if (last < s.length) parts.push(escapeHtml(s.slice(last)));
    return parts.join('').replace(/\n/g, '<br>');
  }

  let isRefreshing = false;
  container.scrollTop = container.scrollHeight;

  function updateTime() {
    if (timeEl) timeEl.textContent = `Обновлено: ${new Date().toLocaleTimeString('ru-RU')}`;
  }
  function showToast(text, type = 'success') {
    if (!toast) return;
    toast.textContent = text;
    toast.dataset.type = type;
    toast.classList.add('visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('visible'), 2500);
  }

  function renderMessage(m) {
    const isOwn = m.sender_type === viewerRole;
    const art = document.createElement('article');
    art.className = `message ${isOwn ? 'is-own' : 'is-other'}`;
    if (m.deleted_at) art.classList.add('message-deleted');
    art.dataset.id = String(m.id);

    const header = document.createElement('div');
    header.className = 'message-header';
    const sender = document.createElement('span');
    sender.className = 'message-sender';
    sender.textContent = m.sender_name + (m.sender_type === 'admin' ? ' (админ)' : '');
    const time = document.createElement('time');
    time.className = 'message-time';
    const d = new Date(m.created_at);
    time.textContent = Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU');
    header.append(sender, time);
    art.appendChild(header);

    if (m.deleted_at) {
      const del = document.createElement('div');
      del.className = 'message-text message-text-deleted';
      del.textContent = 'Сообщение удалено';
      art.appendChild(del);
    } else {
      if (m.message) {
        const text = document.createElement('div');
        text.className = 'message-text';
        text.innerHTML = renderText(m.message);
        art.appendChild(text);
      }
      if (m.file_path) {
        const filename = m.file_path.split('/').pop();
        const encoded = encodeURIComponent(filename);
        const fileUrl = `/support/image/${encoded}`;
        const displayName = m.file_name || 'screenshot';
        const wrap = document.createElement('div');
        wrap.className = 'message-file';
        const a = document.createElement('a');
        a.href = fileUrl;
        a.style.cssText = 'display:inline-block;cursor:zoom-in;';
        a.dataset.filePreview = '';
        a.dataset.fileName = displayName;
        a.dataset.viewUrl = fileUrl;
        a.dataset.downloadUrl = fileUrl;
        const img = document.createElement('img');
        img.className = 'support-image';
        img.src = fileUrl;
        img.alt = displayName;
        img.loading = 'lazy';
        a.appendChild(img);
        wrap.appendChild(a);
        art.appendChild(wrap);
      }
    }
    return art;
  }

  function removeStaleMessages(serverIds) {
    let removed = 0;
    container.querySelectorAll('.message[data-id]').forEach((el) => {
      if (!serverIds.has(el.dataset.id)) { el.remove(); removed++; }
    });
    return removed;
  }

  function ensureEmptyState(aliveCount) {
    const existing = container.querySelector('.empty-state');
    if (aliveCount === 0) {
      if (!existing) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'Сообщений пока нет.';
        container.appendChild(empty);
      }
    } else if (existing) existing.remove();
  }

  async function refresh(isAuto = false) {
    if (isRefreshing) return;
    isRefreshing = true;
    if (!isAuto && refreshBtn) { refreshBtn.disabled = true; refreshBtn.classList.add('loading'); }
    const wasAtBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 80;
    try {
      const res = await fetch(messagesUrl, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      if (!data || data.ok === false) {
        throw new Error((data && data.message) || 'Ошибка сервера');
      }
      if (!Array.isArray(data.messages)) throw new Error('bad response');
      const serverIds = new Set(data.messages.map((m) => String(m.id)));
      const removed = removeStaleMessages(serverIds);
      const fresh = data.messages.filter((m) =>
        !container.querySelector(`.message[data-id="${m.id}"]`)
      );
      if (fresh.length > 0) {
        container.querySelector('.empty-state')?.remove();
        fresh.forEach((m) => {
          const el = renderMessage(m);
          el.classList.add('new-message');
          container.appendChild(el);
        });
        if (wasAtBottom || !isAuto) container.scrollTop = container.scrollHeight;
        if (!isAuto) showToast(`Новых сообщений: ${fresh.length}`);
      } else if (removed > 0) {
        if (!isAuto) showToast('Сообщения обновлены', 'neutral');
      } else {
        if (!isAuto) showToast('Новых нет', 'neutral');
      }
      ensureEmptyState(data.messages.length);
      if (countEl) countEl.textContent = String(data.messages.length);
      updateTime();
      refreshBtn?.classList.remove('error-state');
      refreshBtn?.removeAttribute('title');
      if (!isAuto) window.refreshCounters?.();
    } catch (e) {
      console.error('support refresh:', e);
      if (!isAuto) {
        refreshBtn?.classList.add('error-state');
        refreshBtn?.setAttribute('title', 'Нет связи с сервером');
        showToast('Не удалось обновить', 'error');
      }
    } finally {
      isRefreshing = false;
      if (!isAuto && refreshBtn) { refreshBtn.disabled = false; refreshBtn.classList.remove('loading'); }
    }
  }

  window.refreshSupport = () => refresh(false);
  refreshBtn?.addEventListener('click', () => refresh(false));
  updateTime();

  let pollTimer = null;
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (!document.hidden) refresh(true); }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else { refresh(true); startPolling(); }
  });
  startPolling();

  if (!form || !textarea || !attachment || !preview) return;

  let uploading = false;
  function clearAttachment() {
    attachment.hidden = true;
    if (attachment.dataset.blobUrl) {
      try { URL.revokeObjectURL(attachment.dataset.blobUrl); } catch { /* ignore */ }
      delete attachment.dataset.blobUrl;
    }
    preview.removeAttribute('src');
    preview.style.display = 'none';
    if (nameEl) nameEl.textContent = '';
    if (hiddenPath) hiddenPath.value = '';
    if (hiddenName) hiddenName.value = '';
  }
  function showAttachment(file, blobUrl) {
    if (attachment.dataset.blobUrl) {
      try { URL.revokeObjectURL(attachment.dataset.blobUrl); } catch { /* ignore */ }
    }
    attachment.dataset.blobUrl = blobUrl;
    preview.src = blobUrl;
    preview.style.display = 'block';
    if (nameEl) {
      nameEl.textContent = (file && file.name && file.name !== 'blob') ? file.name : 'Скриншот';
    }
    attachment.hidden = false;
  }
  removeBtn?.addEventListener('click', clearAttachment);

  async function uploadImageFile(file) {
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) return;
    if (file.size > MAX_FILE_SIZE) {
      showToast(`Файл больше ${MAX_FILE_SIZE_MB} МБ`, 'error');
      return;
    }
    clearAttachment();
    const blobUrl = URL.createObjectURL(file);
    showAttachment(file, blobUrl);
    uploading = true;
    const formData = new FormData();
    formData.append('image', file, file.name || 'screenshot.png');
    // Для админки threadId приходит из support-init-data — сервер
    // определит по нему папку автора треда. Для студента/преподавателя
    // поля нет, сервер возьмёт папку из сессии.
    if (threadId) formData.append('thread_id', String(threadId));
    try {
      const res = await fetch('/support/upload-image', {
        method: 'POST', body: formData, credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      let data = null;
      try { data = await res.json(); } catch { /* ignore */ }
      if (!res.ok || !data || data.ok === false) {
        throw new Error(
          (data && (data.message || data.error))
          || `Ошибка ${res.status}`
        );
      }
      if (hiddenPath) hiddenPath.value = data.path;
      if (hiddenName) hiddenName.value = file.name || 'screenshot';
    } catch (e) {
      console.error('upload support image:', e);
      clearAttachment();
      showToast('Не удалось прикрепить: ' + (e.message || 'ошибка'), 'error');
    } finally {
      uploading = false;
    }
  }

  textarea.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (file) uploadImageFile(file);
  });

  form.addEventListener('submit', (e) => {
    if (uploading) {
      e.preventDefault();
      showToast('Скриншот ещё загружается…', 'neutral');
      return;
    }
    const hasText = textarea.value.trim().length > 0;
    const hasFile = hiddenPath && hiddenPath.value;
    if (!hasText && !hasFile) {
      e.preventDefault();
      showToast('Введите сообщение или прикрепите скриншот (Ctrl+V)', 'error');
    }
  });
})();