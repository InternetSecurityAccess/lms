// public/js/chat.js
(() => {
  'use strict';
  const messagesDiv = document.getElementById('messages');
  const refreshBtn = document.getElementById('refreshBtn');
  const countEl = document.getElementById('messageCount');
  const timeEl = document.getElementById('lastUpdateTime');
  const toast = document.getElementById('newMessagesToast');
  const dataEl = document.getElementById('chat-init-data');
  let chatConfig = {};
  if (dataEl) {
    try { chatConfig = JSON.parse(dataEl.textContent); }
    catch (e) { console.error('chat-init-data:', e); }
  }
  const baseUrl = chatConfig.baseUrl || window.baseUrl;
  if (!messagesDiv || !baseUrl) return;
  const POLL_MS = 30000;
  const viewerRole = window.userRole || '';
  const viewerId = window.userId != null ? String(window.userId) : '';
  const FILES = window.__files || {};
  const PREVIEWABLE_EXTS = Array.isArray(FILES.previewableExts) && FILES.previewableExts.length > 0
    ? FILES.previewableExts.map((s) => String(s).toLowerCase())
    : ['pdf', 'png', 'jpg', 'jpeg', 'txt'];
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
  function computeIsOwn(m) {
    return m.sender_id != null
      && String(m.sender_id) === viewerId
      && m.sender_type === viewerRole;
  }
  let isRefreshing = false;
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
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
  function renderAttachment(wrap, m) {
    const filename = String(m.file_path || '').split('/').pop();
    if (!filename) return;
    const encoded = encodeURIComponent(filename);
    const downloadUrl = `/file/chat-file/${encoded}`;
    const viewUrl = `${downloadUrl}?inline=1`;
    const displayName = m.file_name || filename;
    const ext = (String(displayName).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const previewable = PREVIEWABLE_EXTS.includes(ext);
    const label = document.createElement('div');
    label.append('Вложение: ');
    const strong = document.createElement('strong');
    strong.textContent = displayName;
    label.appendChild(strong);
    wrap.appendChild(label);
    const actions = document.createElement('div');
    actions.className = 'actions-row';
    actions.style.marginTop = '6px';
    if (previewable) {
      const btnOpen = document.createElement('button');
      btnOpen.type = 'button';
      btnOpen.className = 'btn btn-ghost btn-sm';
      btnOpen.textContent = 'Открыть';
      btnOpen.dataset.filePreview = '';
      btnOpen.dataset.fileName = displayName;
      btnOpen.dataset.viewUrl = viewUrl;
      btnOpen.dataset.downloadUrl = downloadUrl;
      actions.appendChild(btnOpen);
    }
    const btnDl = document.createElement('a');
    btnDl.href = downloadUrl;
    btnDl.className = 'btn btn-secondary btn-sm';
    btnDl.textContent = 'Скачать';
    actions.appendChild(btnDl);
    wrap.appendChild(actions);
  }
  function appendMessage(m) {
    const isOwn = computeIsOwn(m);
    const art = document.createElement('article');
    art.className = `message ${isOwn ? 'is-own' : 'is-other'}`;
    if (m.deleted_at) art.classList.add('message-deleted');
    art.dataset.id = String(m.id);
    const header = document.createElement('div');
    header.className = 'message-header';
    const sender = document.createElement('span');
    sender.className = 'message-sender';
    sender.textContent = m.sender_name || 'Пользователь';
    const time = document.createElement('time');
    time.className = 'message-time';
    const d = new Date(m.created_at);
    time.textContent = Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU');
    const actions = document.createElement('div');
    actions.className = 'actions-row';
    actions.style.gap = '8px';
    actions.appendChild(time);
    if (!m.deleted_at) {
      const replyBtn = document.createElement('button');
      replyBtn.type = 'button';
      replyBtn.className = 'btn btn-ghost btn-sm';
      replyBtn.textContent = '↩';
      replyBtn.dataset.replyTo = String(m.id);
      replyBtn.dataset.replySender = m.sender_name || '';
      replyBtn.dataset.replyText = String(m.message || '').slice(0, 80);
      actions.appendChild(replyBtn);
    }
    header.append(sender, actions);
    art.appendChild(header);
    if (m.reply_sender) {
      const rep = document.createElement('div');
      rep.className = 'message-reply';
      rep.innerHTML = `<strong>${escapeHtml(m.reply_sender)}</strong>: ${escapeHtml(String(m.reply_text || '').slice(0, 120))}`;
      art.appendChild(rep);
    }
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
        const wrap = document.createElement('div');
        wrap.className = 'message-file';
        renderAttachment(wrap, m);
        art.appendChild(wrap);
      }
    }
    art.classList.add('new-message');
    messagesDiv.appendChild(art);
  }
  function removeStaleMessages(serverIds) {
    let removed = 0;
    messagesDiv.querySelectorAll('.message[data-id]').forEach((el) => {
      if (!serverIds.has(el.dataset.id)) { el.remove(); removed++; }
    });
    return removed;
  }
  function ensureEmptyState(aliveCount) {
    const existing = messagesDiv.querySelector('.empty-state');
    if (aliveCount === 0) {
      if (!existing) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'Сообщений пока нет. Напишите первым.';
        messagesDiv.appendChild(empty);
      }
    } else if (existing) existing.remove();
  }
  async function refresh(isAuto = false) {
    if (isRefreshing) return;
    isRefreshing = true;
    if (!isAuto && refreshBtn) { refreshBtn.disabled = true; refreshBtn.classList.add('loading'); }
    const wasAtBottom = (messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight) < 80;
    try {
      const res = await fetch(`${baseUrl}/messages.json`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // ← ИЗМЕНЕНО: сервер теперь возвращает { ok: true, messages: [...] }.
      // При ok: false — показываем ошибку, не трогаем список.
      if (!data || data.ok === false) {
        throw new Error((data && data.message) || 'Ошибка сервера');
      }
      if (!Array.isArray(data.messages)) throw new Error('bad response');
      const serverIds = new Set(data.messages.map((m) => String(m.id)));
      const removedCount = removeStaleMessages(serverIds);
      const fresh = data.messages.filter((m) =>
        !messagesDiv.querySelector(`.message[data-id="${m.id}"]`)
      );
      if (fresh.length > 0) {
        messagesDiv.querySelector('.empty-state')?.remove();
        fresh.forEach(appendMessage);
        if (wasAtBottom || !isAuto) messagesDiv.scrollTop = messagesDiv.scrollHeight;
        if (!isAuto) showToast(`Новых сообщений: ${fresh.length}`);
      } else if (removedCount > 0) {
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
      console.error('chat refresh:', e);
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
  window.refreshChat = () => refresh(false);
  refreshBtn?.addEventListener('click', () => refresh(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); refresh(false); }
  });
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
  updateTime();
})();