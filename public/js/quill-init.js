// public/js/quill-init.js
(() => {
  'use strict';
  const FILES = window.__files || {};
  const QUILL_CFG = window.__quillConfig || {};
  const MAX_FILE_SIZE = (Number(FILES.maxFileSizeMb) || 100) * 1024 * 1024;
  const MAX_FILE_SIZE_MB = Number(FILES.maxFileSizeMb) || 100;
  const IMAGE_MIME_MAP = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };
  const ACCEPT_IMAGE = (() => {
    const raw = String(FILES.acceptImage || '.png,.jpg,.jpeg');
    const mimes = raw.split(',')
      .map((s) => s.trim())
      .map((ext) => IMAGE_MIME_MAP[ext] || null)
      .filter(Boolean);
    return mimes.length > 0 ? mimes.join(',') : 'image/png,image/jpeg';
  })();
  const ALLOWED_IMAGE_MIMES = Object.values(IMAGE_MIME_MAP);
  const FORMATS_HINT = String(FILES.acceptImage || '.png,.jpg,.jpeg');
  const TOOLBAR_GROUPS = {
    fonts:  [{ font: [] }, { header: [1, 2, 3, 4, 5, 6, false] }],
    inline: ['bold', 'italic', 'underline', 'strike'],
    color:  [{ color: [] }, { background: [] }],
    script: [{ script: 'sub' }, { script: 'super' }],
    list:   [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
    indent: [{ indent: '-1' }, { indent: '+1' }],
    align:  [{ align: [] }, { direction: 'rtl' }],
    blocks: ['blockquote', 'code-block'],
    link:    ['link'],
    image:   ['image'],
    formula: ['formula'],
    clean:  ['clean'],
  };
  function buildToolbarOptions() {
    const enabled = Array.isArray(QUILL_CFG.toolbarGroups)
      ? QUILL_CFG.toolbarGroups
      : Object.keys(TOOLBAR_GROUPS);
    const out = [];
    for (const g of enabled) {
      const items = TOOLBAR_GROUPS[g];
      if (Array.isArray(items)) out.push(...items);
    }
    return out;
  }
  function addTableFeatures(quill, toolbar) {
    const TABLE_STYLE = 'border-collapse:collapse;width:100%;margin:8px 0;';
    const CELL_STYLE = 'border:1px solid #ccc;padding:6px;min-width:40px;vertical-align:top;';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ql-table';
    btn.title = 'Вставить таблицу';
    btn.innerHTML = '<svg viewBox="0 0 18 18">'
      + '<rect class="ql-stroke" x="2" y="2" width="14" height="14" rx="1" fill="none"/>'
      + '<line class="ql-stroke" x1="2" y1="7" x2="16" y2="7"/>'
      + '<line class="ql-stroke" x1="7" y1="7" x2="7" y2="16"/>'
      + '</svg>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const input = prompt(
        'Размер таблицы — «строки x столбцы» (1–20). Пример: 3x4',
        '3x3'
      );
      if (input == null) return;
      const m = String(input).match(/^\s*(\d{1,2})\s*[xх×*]\s*(\d{1,2})\s*$/i);
      if (!m) { alert('Неверный формат. Пример: 3x4'); return; }
      const rows = Math.max(1, Math.min(parseInt(m[1], 10) || 3, 20));
      const cols = Math.max(1, Math.min(parseInt(m[2], 10) || 3, 20));
      const range = quill.getSelection(true) || { index: quill.getLength() };
      let html = `<table style="${TABLE_STYLE}">`;
      for (let r = 0; r < rows; r++) {
        html += '<tr>';
        for (let c = 0; c < cols; c++) {
          html += `<td style="${CELL_STYLE}"><br></td>`;
        }
        html += '</tr>';
      }
      html += '</table><p><br></p>';
      quill.clipboard.dangerouslyPasteHTML(range.index, html, 'user');
      quill.setSelection(range.index, 0, 'user');
    });
    const cleanBtn = toolbar.querySelector('.ql-clean');
    if (cleanBtn && cleanBtn.parentNode) {
      cleanBtn.parentNode.insertBefore(btn, cleanBtn);
    } else {
      toolbar.appendChild(btn);
    }
    const panel = document.createElement('div');
    panel.className = 'ql-table-panel';
    panel.hidden = true;
    panel.innerHTML = ''
      + '<button type="button" data-table-action="add-row-after" title="Добавить строку снизу">+ Стр</button>'
      + '<button type="button" data-table-action="add-row-before" title="Добавить строку сверху">+ Стр↑</button>'
      + '<button type="button" data-table-action="add-col-after" title="Добавить столбец справа">+ Кол</button>'
      + '<button type="button" data-table-action="add-col-before" title="Добавить столбец слева">+ Кол←</button>'
      + '<button type="button" data-table-action="del-row" title="Удалить строку">− Стр</button>'
      + '<button type="button" data-table-action="del-col" title="Удалить столбец">− Кол</button>'
      + '<button type="button" data-table-action="del-table" class="is-danger" title="Удалить таблицу">× Таблица</button>';
    document.body.appendChild(panel);
    let currentTable = null;
    let currentCell = null;
    panel.addEventListener('mousedown', (e) => e.preventDefault());
    function findTableFromSelection() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      let node = sel.anchorNode;
      if (node && node.nodeType === 3) node = node.parentNode;
      while (node && node !== quill.root) {
        if (node.tagName === 'TABLE') return node;
        node = node.parentNode;
      }
      return null;
    }
    function findCellFromSelection(table) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      let node = sel.anchorNode;
      if (node && node.nodeType === 3) node = node.parentNode;
      while (node && node !== table) {
        if (node.tagName === 'TD' || node.tagName === 'TH') return node;
        node = node.parentNode;
      }
      return null;
    }
    function positionPanel(table) {
      if (!table || !document.body.contains(table)) return;
      const rect = table.getBoundingClientRect();
      const top = rect.top + window.scrollY - panel.offsetHeight - 4;
      const left = rect.left + window.scrollX;
      panel.style.top = Math.max(0, top) + 'px';
      panel.style.left = Math.max(0, left) + 'px';
    }
    function showPanel(table, cell) {
      currentTable = table;
      currentCell = cell;
      panel.hidden = false;
      positionPanel(table);
    }
    function hidePanel() {
      currentTable = null;
      currentCell = null;
      panel.hidden = true;
    }
    function cellIndex(cell) {
      return Array.from(cell.parentNode.children).indexOf(cell);
    }
    function addRow(cell, isAfter) {
      const row = cell.parentNode;
      const colCount = row.children.length;
      const newRow = document.createElement('tr');
      for (let i = 0; i < colCount; i++) {
        const td = document.createElement('td');
        td.style.cssText = CELL_STYLE;
        td.innerHTML = '<br>';
        newRow.appendChild(td);
      }
      row.parentNode.insertBefore(newRow, isAfter ? row.nextSibling : row);
    }
    function addCol(cell, isAfter) {
      const idx = cellIndex(cell);
      const table = cell.closest('table');
      if (!table) return;
      for (const row of table.querySelectorAll('tr')) {
        const cells = row.children;
        if (cells.length === 0) continue;
        const refCell = cells[Math.min(idx, cells.length - 1)];
        const newCell = document.createElement(refCell.tagName === 'TH' ? 'th' : 'td');
        newCell.style.cssText = CELL_STYLE;
        newCell.innerHTML = '<br>';
        row.insertBefore(newCell, isAfter ? refCell.nextSibling : refCell);
      }
    }
    function deleteRow(cell) {
      const row = cell.parentNode;
      const table = row.closest('table');
      row.remove();
      if (table && table.querySelectorAll('tr').length === 0) table.remove();
    }
    function deleteCol(cell) {
      const idx = cellIndex(cell);
      const table = cell.closest('table');
      if (!table) return;
      for (const row of table.querySelectorAll('tr')) {
        const cells = row.children;
        if (idx < cells.length) cells[idx].remove();
      }
      if (table.querySelectorAll('td, th').length === 0) table.remove();
    }
    function deleteTable(cell) {
      const table = cell.closest('table');
      if (table) table.remove();
    }
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-table-action]');
      if (!b || !currentTable || !currentCell) return;
      window.UnsavedGuard?.markDirty();
      const action = b.dataset.tableAction;
      if (action === 'add-row-after') addRow(currentCell, true);
      else if (action === 'add-row-before') addRow(currentCell, false);
      else if (action === 'add-col-after') addCol(currentCell, true);
      else if (action === 'add-col-before') addCol(currentCell, false);
      else if (action === 'del-row') deleteRow(currentCell);
      else if (action === 'del-col') deleteCol(currentCell);
      else if (action === 'del-table') deleteTable(currentCell);
      if (!document.body.contains(currentTable)) {
        hidePanel();
      } else {
        positionPanel(currentTable);
        if (!document.body.contains(currentCell)) {
          const newCell = currentTable.querySelector('td, th');
          if (newCell) {
            currentCell = newCell;
          } else {
            hidePanel();
          }
        }
      }
    });
    quill.root.addEventListener('click', (e) => {
      const table = findTableFromSelection();
      if (!table) { hidePanel(); return; }
      const cell = findCellFromSelection(table);
      if (!cell) { hidePanel(); return; }
      showPanel(table, cell);
    });
    document.addEventListener('mousedown', (e) => {
      if (panel.hidden) return;
      if (e.target.closest('.ql-table-panel')) return;
      if (quill.root.contains(e.target) && e.target.closest('table')) return;
      hidePanel();
    });
    window.addEventListener('scroll', () => {
      if (!panel.hidden && currentTable) positionPanel(currentTable);
    }, { passive: true });
    window.addEventListener('resize', () => {
      if (!panel.hidden && currentTable) positionPanel(currentTable);
    });
  }
  function initQuill() {
    if (window.__workstudQuillReady) {
      console.warn('[quill-init] уже инициализирован — пропускаю повторный вызов');
      return;
    }
    const editorEl = document.getElementById('editor');
    const form = document.getElementById('topicForm');
    const hidden = document.getElementById('descriptionInput');
    const fallback = document.getElementById('editorFallback');
    const dataEl = document.getElementById('topic-init-data');
    if (!editorEl || !dataEl) return;
    window.__workstudQuillReady = true;
    let config;
    try {
      config = JSON.parse(dataEl.textContent);
    } catch (e) {
      console.error('topic-init-data:', e);
      window.__workstudQuillReady = false;
      return;
    }
    const { subjectId, initialHtml = '' } = config;
    if (typeof Quill === 'undefined') {
      if (editorEl) editorEl.hidden = true;
      if (fallback) {
        fallback.hidden = false;
        fallback.value = initialHtml;
      }
      if (form && hidden && fallback) {
        form.addEventListener('submit', () => { hidden.value = fallback.value; });
      }
      console.warn('[quill-init] Quill не загружен — используется textarea');
      return;
    }
    const uploadImageFile = async (file) => {
      if (!file) return;
      if (!ALLOWED_IMAGE_MIMES.includes(file.type)) {
        alert('Недопустимый формат. Разрешены: ' + FORMATS_HINT);
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        alert(`Файл больше ${MAX_FILE_SIZE_MB} МБ`);
        return;
      }
      const fd = new FormData();
      fd.append('image', file);
      try {
        const res = await fetch(`/subjects/${subjectId}/images`, {
          method: 'POST',
          body: fd,
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        let data = null;
        try { data = await res.json(); } catch { /* ignore */ }
        if (!res.ok || !data || data.ok === false) {
          alert('Не удалось загрузить: '
            + ((data && (data.message || data.error)) || ('Ошибка ' + res.status)));
          return;
        }
        const range = quill.getSelection(true) || { index: quill.getLength() };
        quill.insertEmbed(range.index, 'image', data.url, 'user');
        quill.setSelection(range.index + 1, 0, 'user');
      } catch (e) {
        console.error('image upload:', e);
        alert('Не удалось загрузить картинку');
      }
    };
    const imageHandler = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = ACCEPT_IMAGE;
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (file) uploadImageFile(file);
      };
      input.click();
    };
    const toolbarOptions = buildToolbarOptions();
    const quill = new Quill('#editor', {
      theme: 'snow',
      placeholder: 'Введите содержание темы...',
      modules: {
        toolbar: {
          container: toolbarOptions,
          handlers: {
            image: imageHandler,
          },
        },
        resize: {
          modules: ['DisplaySize', 'Toolbar', 'Resize', 'Keyboard'],
          tools: ['left', 'center', 'right', 'full', 'edit'],
        },
      },
    });
    if (quill.root) {
      quill.root.setAttribute('aria-labelledby', 'editor-label');
      quill.root.setAttribute('role', 'textbox');
      quill.root.setAttribute('aria-multiline', 'true');
    }
    if (fallback) fallback.setAttribute('aria-labelledby', 'editor-label');
    if (initialHtml) quill.clipboard.dangerouslyPasteHTML(initialHtml);
    quill.on('text-change', () => {
      window.UnsavedGuard?.markDirty();
    });
    try {
      const Delta = Quill.import('delta');
      quill.clipboard.addMatcher('img', () => new Delta());
    } catch (err) {
      console.warn('quill.addMatcher(img):', err);
    }
    quill.root.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      let file = null;
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          file = it.getAsFile();
          break;
        }
      }
      if (!file && e.clipboardData?.files?.length > 0) {
        file = Array.from(e.clipboardData.files)
          .find((f) => f.type.startsWith('image/')) || null;
      }
      if (!file) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      uploadImageFile(file);
    }, true);
    const shell = document.getElementById('editorShell');
    const toolbar = shell ? shell.querySelector('.ql-toolbar') : null;
    if (toolbar && QUILL_CFG.tableEnabled !== false && !toolbar.querySelector('.ql-table')) {
      addTableFeatures(quill, toolbar);
    }
    if (form && hidden) {
      form.addEventListener('submit', () => {
        const mode = document.getElementById('t-assignment-mode')?.value;
        if (mode === 'internal') {
          hidden.value = '';
          hidden.disabled = true;
        } else {
          hidden.disabled = false;
          hidden.value = quill.root.innerHTML;
        }
      });
    }
  }
  function init() { initQuill(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();