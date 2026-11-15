// public/js/dragdrop.js
// Визуальный drop-zone для input[type=file].
// Правила — в window.fileRules (public/js/file-rules.js).
// Требует в разметке: #dropZone (зона) и #fileInput (input[type=file]).
// #fileName — опциональный элемент для сообщения о выбранном файле.
(() => {
  'use strict';
  if (!window.fileRules) {
    console.warn('[dragdrop] file-rules.js не загружен — пропускаю');
    return;
  }
  const R = window.fileRules;

  function showMsg(text, isErr) {
    const el = document.getElementById('fileName');
    if (!el) return;
    el.textContent = text;
    el.style.color = isErr ? 'var(--error)' : 'var(--success)';
    el.style.display = 'block';
  }

  function setFile(input, file) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      return true;
    } catch { return false; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const zone = document.getElementById('dropZone');
    const input = document.getElementById('fileInput');
    if (!zone || !input) return;

    zone.addEventListener('click', (e) => {
      if (e.target !== input) input.click();
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('dragover');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const rules = R.rulesFor(input);
      const err = R.validateFile(file, rules);
      if (err) { input.value = ''; showMsg(err, true); return; }
      if (!setFile(input, file)) { showMsg('Выберите файл через диалог.', true); return; }
      showMsg(`Выбран: ${file.name}`, false);
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const rules = R.rulesFor(input);
      const err = R.validateFile(file, rules);
      if (err) { input.value = ''; showMsg(err, true); return; }
      showMsg(`Выбран: ${file.name}`, false);
    });
  });
})();