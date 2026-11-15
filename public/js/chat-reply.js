// public/js/chat-reply.js
(() => {
  'use strict';

  document.addEventListener('click', (e) => {
    const replyBtn = e.target.closest('[data-reply-to]');
    if (replyBtn) {
      const replyId = document.getElementById('replyToId');
      const replyPreview = document.getElementById('replyPreview');
      const replyPreviewText = document.getElementById('replyPreviewText');
      const chatMsg = document.getElementById('chat-msg');
      if (!replyId) return;
      replyId.value = replyBtn.dataset.replyTo;
      if (replyPreviewText) {
        replyPreviewText.textContent =
          (replyBtn.dataset.replySender || '—') + ': ' + (replyBtn.dataset.replyText || '');
      }
      if (replyPreview) replyPreview.hidden = false;
      if (chatMsg) chatMsg.focus();
      return;
    }

    const clearBtn = e.target.closest('[data-action="clear-reply"]');
    if (clearBtn) {
      const replyId = document.getElementById('replyToId');
      const replyPreview = document.getElementById('replyPreview');
      if (replyId) replyId.value = '';
      if (replyPreview) replyPreview.hidden = true;
    }
  });
})();