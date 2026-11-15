// public/js/quiz-builder.js
'use strict';

/* ═══════════════════════════════════════════════════════════
   Конструктор теста.

   Монтируется на #quiz-builder в шаблоне topic-form.ejs.
   Читает начальные данные из #quiz-builder-data (JSON).
   Сериализует всё в скрытый input[name="quiz_json"] при submit.

   Возможности:
     • аккордеон (все свёрнуты на старте);
     • «Развернуть/Свернуть все»;
     • добавление/удаление/перемещение вопросов и вариантов;
     • single: чекбоксы ведут как radio (выбор снимает остальные);
     • ordering: номер позиции пересчитывается при ↑↓, чекбоксы скрыты;
     • картинки: Ctrl+V и клик по слоту → file input;
     • импорт из текста с шаблоном для ИИ;
     • блокировка полей, если attemptsCount > 0.
   ═══════════════════════════════════════════════════════════ */

(function () {
  const root = document.getElementById('quiz-builder');
  if (!root) return;

  const dataScript = document.getElementById('quiz-builder-data');
  let initial = { quiz: null, attemptsCount: 0 };
  if (dataScript) {
    try { initial = JSON.parse(dataScript.textContent || '{}'); } catch { /* ignore */ }
  }

  const attemptsCount = Number(initial.attemptsCount) || 0;
  const readonly = attemptsCount > 0;

  const questionsEl = root.querySelector('#quiz-questions');
  const jsonInput = root.querySelector('input[name="quiz_json"]');
  const form = root.closest('form');
  const importDialog = document.getElementById('quiz-import-dialog');

  let tmpCounter = 0;
  const nextTmpId = () => `new-${++tmpCounter}`;

  // ─── Утилиты ───
  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') e.className = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v === false || v == null) { /* skip */ }
      else e.setAttribute(k, v);
    }
    for (const child of children) {
      if (child == null) continue;
      e.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return e;
  }

  function esc(s) {
    return String(s == null ? '' : s);
  }

  function typeLabel(t) {
    return t === 'single' ? 'Один'
      : t === 'multiple' ? 'Несколько'
      : t === 'ordering' ? 'Порядок'
      : '—';
  }

  // ═══════════════════════════════════════════════════════════
  // Загрузка картинки
  // ═══════════════════════════════════════════════════════════
  async function uploadImage(file) {
    if (!file) return null;
    if (file.size > 2 * 1024 * 1024) {
      alert('Файл больше 2 МБ');
      return null;
    }
    const fd = new FormData();
    fd.append('image', file, file.name || 'paste.png');
    try {
      const res = await fetch('/quiz/upload-image', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      const json = await res.json();
      if (!json.ok) {
        alert(json.error || 'Не удалось загрузить картинку');
        return null;
      }
      return {
        stored_name: json.stored_name,
        filename: json.filename,
        filesize: json.filesize,
      };
    } catch (e) {
      alert('Ошибка сети при загрузке картинки');
      return null;
    }
  }

  function rawUrl(stored_name) {
    // stored_name = 'quiz/<uuid>.<ext>' → '<uuid>.<ext>'
    const name = String(stored_name || '').replace(/^quiz\//, '');
    return `/file/quiz-image/raw/${encodeURIComponent(name)}`;
  }

  // ─── Слот картинки ───
  // Опции: { stored_name, filename, filesize } либо пусто.
  // onChange(newInfo | null) — при изменении.
  function makeImageSlot(info, onChange, { disabled = false } = {}) {
    const slot = el('div', { className: 'quiz-image-slot' });
    if (info && info.stored_name) slot.classList.add('has-image');

    const input = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp',
      style: 'display:none',
    });

    function render() {
      slot.innerHTML = '';
      if (info && info.stored_name) {
        const img = el('img', { src: rawUrl(info.stored_name), alt: 'картинка' });
        const btn = el('button', {
          type: 'button',
          className: 'quiz-image-remove',
          title: 'Убрать картинку',
          onclick: (e) => {
            e.stopPropagation();
            if (disabled) return;
            info = null;
            onChange(null);
            render();
          },
        }, ['✕']);
        slot.appendChild(img);
        slot.appendChild(btn);
      } else {
        slot.appendChild(document.createTextNode('Ctrl+V'));
      }
    }

    slot.addEventListener('click', () => {
      if (disabled) return;
      input.click();
    });

    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const up = await uploadImage(f);
      input.value = '';
      if (!up) return;
      info = up;
      onChange(up);
      render();
    });

    // Ctrl+V — глобально ловится родителем, тут только приём
    slot.addEventListener('paste', async (e) => {
      if (disabled) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) return;
          slot.classList.add('pasting');
          const up = await uploadImage(file);
          slot.classList.remove('pasting');
          if (!up) return;
          info = up;
          onChange(up);
          render();
          return;
        }
      }
    });

    render();
    slot.appendChild(input);
    return slot;
  }

  // ═══════════════════════════════════════════════════════════
  // Вопрос
  // ═══════════════════════════════════════════════════════════
  function makeQuestion(q) {
    const state = {
      id: q.id || nextTmpId(),
      text: q.text || '',
      type: q.type || 'single',
      points: Number(q.points) > 0 ? Number(q.points) : 1,
      image: q.image_stored_name ? {
        stored_name: q.image_stored_name,
        filename: q.image_filename || '',
        filesize: q.image_filesize || 0,
      } : null,
      options: (q.options || []).map((o) => ({
        id: o.id || nextTmpId(),
        text: o.text || '',
        is_correct: !!o.is_correct,
        position: Number.isInteger(o.position) ? o.position : 0,
        image: o.image_stored_name ? {
          stored_name: o.image_stored_name,
          filename: o.image_filename || '',
          filesize: o.image_filesize || 0,
        } : null,
      })),
      open: false,
    };

    const wrapper = el('div', { className: 'quiz-q', dataset: { open: '0' } });
    const headEl = el('div', { className: 'quiz-q-head' });
    const bodyEl = el('div', { className: 'quiz-q-body' });
    bodyEl.hidden = true;

    // ── Head ──
    function renderHead() {
      headEl.innerHTML = '';
      const num = el('span', { className: 'quiz-q-num' });
      const badge = el('span', { className: 'quiz-q-type-badge' }, [typeLabel(state.type)]);
      const preview = el('span', { className: 'quiz-q-preview' });
      const warn = el('span', { className: 'quiz-q-badge-warn' }, ['не заполнено']);
      const img = el('span', { className: 'quiz-q-preview', style: 'flex:0 0 auto;max-width:120px' });

      if (state.image && state.image.stored_name) {
        const thumb = el('img', {
          src: rawUrl(state.image.stored_name),
          style: 'max-height:32px;border-radius:4px;',
        });
        img.appendChild(thumb);
      }

      preview.textContent = state.text
        ? state.text
        : (state.image ? '' : 'Без текста');

      const up = el('button', {
        type: 'button', className: 'btn-icon', title: 'Выше',
        onclick: (e) => { e.stopPropagation(); moveQuestion(-1); },
      }, ['↑']);
      const down = el('button', {
        type: 'button', className: 'btn-icon', title: 'Ниже',
        onclick: (e) => { e.stopPropagation(); moveQuestion(1); },
      }, ['↓']);
      const del = el('button', {
        type: 'button', className: 'btn-icon', title: 'Удалить вопрос',
        onclick: (e) => {
          e.stopPropagation();
          if (!confirm('Удалить вопрос?')) return;
          wrapper.remove();
          renumberAll();
        },
      }, ['✕']);

      if (readonly) { up.disabled = true; down.disabled = true; del.disabled = true; }

      headEl.appendChild(num);
      headEl.appendChild(badge);
      if (img.childNodes.length) headEl.appendChild(img);
      headEl.appendChild(preview);
      if (!isQuestionValid()) headEl.appendChild(warn);
      headEl.appendChild(up);
      headEl.appendChild(down);
      headEl.appendChild(del);
      num.textContent = String(getIndex(wrapper) + 1) + '.';
    }

    // ── Body ──
    function renderBody() {
      bodyEl.innerHTML = '';

      // Текст + картинка
      const textRow = el('div', { style: 'display:flex;gap:12px;align-items:flex-start;' });
      const textCol = el('div', { style: 'flex:1;' });
      textCol.appendChild(el('label', { style: 'font-size:13px;color:#64748b;' }, ['Текст вопроса']));
      const textarea = el('textarea', {
        rows: 2,
        placeholder: 'Введите текст вопроса (или прикрепите картинку)',
        style: 'width:100%;min-height:60px;padding:6px;border:1px solid #cbd5e1;border-radius:6px;font-family:inherit;font-size:14px;resize:vertical;',
      });
      textarea.value = state.text;
      textarea.disabled = readonly;
      textarea.addEventListener('input', () => {
        state.text = textarea.value;
        updateHeadDebounced();
      });
      // paste в textarea → ловим картинку для вопроса
      textarea.addEventListener('paste', async (e) => {
        if (readonly) return;
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (const item of items) {
          if (item.type && item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (!file) return;
            const up = await uploadImage(file);
            if (!up) return;
            state.image = up;
            refreshQuestionImageSlot();
            updateHead();
            return;
          }
        }
      });
      textCol.appendChild(textarea);

      const imgSlotHolder = el('div');
      function refreshQuestionImageSlot() {
        imgSlotHolder.innerHTML = '';
        const slot = makeImageSlot(state.image, (info) => {
          state.image = info;
          updateHead();
        }, { disabled: readonly });
        imgSlotHolder.appendChild(slot);
      }
      refreshQuestionImageSlot();
      textRow.appendChild(textCol);
      textRow.appendChild(imgSlotHolder);

      // Мета
      const meta = el('div', { className: 'quiz-q-meta' });
      const typeSel = el('select', {
        disabled: readonly,
      });
      for (const [val, lbl] of [['single', 'Один'], ['multiple', 'Несколько'], ['ordering', 'Порядок']]) {
        const opt = el('option', { value: val }, [lbl]);
        if (val === state.type) opt.selected = true;
        typeSel.appendChild(opt);
      }
      typeSel.addEventListener('change', () => {
        state.type = typeSel.value;
        // Для single — оставляем только один правильный
        if (state.type === 'single') {
          let found = false;
          for (const o of state.options) {
            if (o.is_correct && !found) { found = true; } else { o.is_correct = false; }
          }
        }
        renderBody();
        updateHead();
      });
      meta.appendChild(el('label', {}, ['Тип: ']));
      meta.appendChild(typeSel);
      meta.appendChild(el('label', {}, [' Баллы: ']));
      const pts = el('input', {
        type: 'number', min: '1', value: String(state.points), disabled: readonly,
      });
      pts.addEventListener('input', () => {
        state.points = Math.max(1, parseInt(pts.value || '1', 10) || 1);
      });
      meta.appendChild(pts);

      // Опции
      const optsHolder = el('div', { style: 'display:flex;flex-direction:column;gap:8px;' });
      renderOptions(optsHolder);

      const addBtn = el('button', {
        type: 'button', className: 'btn',
        onclick: () => {
          state.options.push({
            id: nextTmpId(),
            text: '',
            is_correct: false,
            position: state.options.length,
            image: null,
          });
          renderOptions(optsHolder);
          updateHead();
        },
      }, ['+ вариант']);
      if (readonly) addBtn.disabled = true;

      bodyEl.appendChild(textRow);
      bodyEl.appendChild(meta);
      bodyEl.appendChild(optsHolder);
      bodyEl.appendChild(addBtn);
    }

    function renderOptions(holder) {
      holder.innerHTML = '';
      const orderingMode = state.type === 'ordering';

      state.options.forEach((opt, idx) => {
        const row = el('div', {
          className: 'quiz-opt' + (opt.is_correct ? ' is-correct' : ''),
        });

        if (orderingMode) {
          const num = el('div', { className: 'quiz-opt-order' }, [String(idx + 1)]);
          row.appendChild(num);
        } else {
          const cb = el('input', { type: 'checkbox' });
          cb.checked = !!opt.is_correct;
          cb.disabled = readonly;
          cb.addEventListener('change', () => {
            if (state.type === 'single' && cb.checked) {
              for (const o of state.options) o.is_correct = false;
              opt.is_correct = true;
            } else {
              opt.is_correct = cb.checked;
            }
            renderOptions(holder);
            updateHead();
          });
          row.appendChild(cb);
        }

        const textInput = el('input', {
          type: 'text',
          className: 'quiz-opt-text',
          placeholder: 'Текст варианта (или картинка)',
          value: opt.text,
        });
        textInput.disabled = readonly;
        textInput.addEventListener('input', () => {
          opt.text = textInput.value;
          updateHeadDebounced();
        });
        textInput.addEventListener('paste', async (e) => {
          if (readonly) return;
          const items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
              e.preventDefault();
              const file = item.getAsFile();
              if (!file) return;
              const up = await uploadImage(file);
              if (!up) return;
              opt.image = up;
              renderOptions(holder);
              updateHead();
              return;
            }
          }
        });
        row.appendChild(textInput);

        const slotHolder = el('div', { style: 'flex:0 0 auto;' });
        slotHolder.appendChild(makeImageSlot(opt.image, (info) => {
          opt.image = info;
          updateHead();
        }, { disabled: readonly }));
        row.appendChild(slotHolder);

        const up = el('button', {
          type: 'button', className: 'btn-icon', title: 'Выше',
          onclick: () => {
            if (idx === 0) return;
            [state.options[idx - 1], state.options[idx]] = [state.options[idx], state.options[idx - 1]];
            renderOptions(holder);
          },
        }, ['↑']);
        const down = el('button', {
          type: 'button', className: 'btn-icon', title: 'Ниже',
          onclick: () => {
            if (idx === state.options.length - 1) return;
            [state.options[idx + 1], state.options[idx]] = [state.options[idx], state.options[idx + 1]];
            renderOptions(holder);
          },
        }, ['↓']);
        const del = el('button', {
          type: 'button', className: 'btn-icon', title: 'Удалить вариант',
          onclick: () => {
            if (state.options.length <= 2) {
              alert('Должно быть минимум 2 варианта');
              return;
            }
            state.options.splice(idx, 1);
            renderOptions(holder);
            updateHead();
          },
        }, ['✕']);
        if (readonly) { up.disabled = true; down.disabled = true; del.disabled = true; }
        row.appendChild(up);
        row.appendChild(down);
        row.appendChild(del);

        holder.appendChild(row);
      });
    }

    // ── Helpers ──
    let headTimer = null;
    function updateHeadDebounced() {
      clearTimeout(headTimer);
      headTimer = setTimeout(updateHead, 150);
    }
    function updateHead() {
      renderHead();
    }

    function isQuestionValid() {
      if (!state.text && !(state.image && state.image.stored_name)) return false;
      if (state.options.length < 2) return false;
      return state.options.every(
        (o) => o.text || (o.image && o.image.stored_name)
      );
    }

    function moveQuestion(dir) {
      const all = Array.from(questionsEl.querySelectorAll(':scope > .quiz-q'));
      const idx = all.indexOf(wrapper);
      const target = idx + dir;
      if (target < 0 || target >= all.length) return;
      if (dir < 0) questionsEl.insertBefore(wrapper, all[target]);
      else questionsEl.insertBefore(all[target], wrapper);
      renumberAll();
    }

    // ── Клик по head = toggle ──
    headEl.addEventListener('click', () => {
      state.open = !state.open;
      bodyEl.hidden = !state.open;
      wrapper.dataset.open = state.open ? '1' : '0';
    });

    wrapper.appendChild(headEl);
    wrapper.appendChild(bodyEl);

    renderHead();
    renderBody();

    // API для сериализации
    wrapper._getData = () => ({
      text: state.text,
      type: state.type,
      points: state.points,
      image_stored_name: state.image ? state.image.stored_name : null,
      image_filename: state.image ? state.image.filename : null,
      image_filesize: state.image ? state.image.filesize : null,
      options: state.options.map((o, i) => ({
        text: o.text,
        is_correct: o.is_correct,
        position: i,
        image_stored_name: o.image ? o.image.stored_name : null,
        image_filename: o.image ? o.image.filename : null,
        image_filesize: o.image ? o.image.filesize : null,
      })),
    });
    wrapper._setOpen = (v) => {
      state.open = !!v;
      bodyEl.hidden = !state.open;
      wrapper.dataset.open = state.open ? '1' : '0';
    };
    wrapper._isValid = isQuestionValid;

    return wrapper;
  }

  function getIndex(node) {
    const all = Array.from(questionsEl.querySelectorAll(':scope > .quiz-q'));
    return all.indexOf(node);
  }

  function renumberAll() {
    const all = Array.from(questionsEl.querySelectorAll(':scope > .quiz-q'));
    all.forEach((q, i) => {
      const num = q.querySelector('.quiz-q-num');
      if (num) num.textContent = String(i + 1) + '.';
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Добавление / инициализация
  // ═══════════════════════════════════════════════════════════
  function addQuestion(data) {
    const q = makeQuestion(data || {
      text: '',
      type: 'single',
      points: 1,
      options: [
        { text: '', is_correct: false },
        { text: '', is_correct: false },
      ],
    });
    questionsEl.appendChild(q);
    renumberAll();
    q._setOpen(true);
    // Фокус на первом textarea
    const ta = q.querySelector('textarea');
    if (ta) ta.focus();
    return q;
  }

  // Стартовое наполнение
  if (initial.quiz && Array.isArray(initial.quiz.questions) && initial.quiz.questions.length > 0) {
    for (const q of initial.quiz.questions) addQuestion(q);
    // После старта — свёрнуты
    document.querySelectorAll('#quiz-questions > .quiz-q').forEach((q) => q._setOpen(false));
  }

  // ═══════════════════════════════════════════════════════════
  // Тулбар
  // ═══════════════════════════════════════════════════════════
  root.querySelector('[data-action="expand-all"]')?.addEventListener('click', () => {
    root.querySelectorAll('#quiz-questions > .quiz-q').forEach((q) => q._setOpen(true));
  });
  root.querySelector('[data-action="collapse-all"]')?.addEventListener('click', () => {
    root.querySelectorAll('#quiz-questions > .quiz-q').forEach((q) => q._setOpen(false));
  });
  root.querySelector('[data-action="add-question"]')?.addEventListener('click', () => {
    if (readonly) return;
    addQuestion();
  });

  // ═══════════════════════════════════════════════════════════
  // Импорт из текста
  // ═══════════════════════════════════════════════════════════
  function openImportDialog() {
    if (!importDialog) return;
    importDialog.hidden = false;
    const ta = importDialog.querySelector('textarea');
    const errs = importDialog.querySelector('.quiz-errors');
    if (ta) ta.value = '';
    if (errs) { errs.textContent = ''; errs.hidden = true; }
    if (ta) ta.focus();
  }
  function closeImportDialog() {
    if (importDialog) importDialog.hidden = true;
  }

  root.querySelector('[data-action="import"]')?.addEventListener('click', openImportDialog);

  if (importDialog) {
    importDialog.querySelector('[data-action="cancel-import"]')?.addEventListener('click', closeImportDialog);
    importDialog.querySelector('[data-action="copy-template"]')?.addEventListener('click', async (e) => {
      const tpl = importDialog.querySelector('.quiz-template-text');
      if (!tpl) return;
      try {
        await navigator.clipboard.writeText(tpl.textContent);
        e.target.textContent = 'Скопировано ✓';
        setTimeout(() => { e.target.textContent = 'Скопировать шаблон'; }, 1500);
      } catch {
        alert('Не удалось скопировать');
      }
    });
    importDialog.querySelector('[data-action="confirm-import"]')?.addEventListener('click', () => {
      const ta = importDialog.querySelector('textarea');
      const errs = importDialog.querySelector('.quiz-errors');
      const text = ta ? ta.value : '';
      const parsed = parseImportText(text);
      if (!parsed.ok) {
        if (errs) {
          errs.hidden = false;
          errs.innerHTML = '<strong>Ошибки:</strong><ul>' +
            parsed.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('') +
            '</ul>';
        }
        return;
      }
      for (const q of parsed.questions) {
        addQuestion({
          text: q.text,
          type: 'single',
          points: 1,
          options: q.options.map((o) => ({ text: o, is_correct: false })),
        });
      }
      // После импорта — все свёрнуты
      root.querySelectorAll('#quiz-questions > .quiz-q').forEach((q) => q._setOpen(false));
      closeImportDialog();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Локальная копия парсера (тот же, что на сервере — для UX).
  function stripMd(line) {
    return String(line)
      .replace(/^\s*[*_`]+\s*/, '')
      .replace(/\s*[*_`]+\s*$/, '');
  }
  function parseImportText(text) {
    const errors = [];
    const questions = [];
    const lines = String(text || '').split(/\r?\n/).map(stripMd);
    const qre = /^(?:вопрос|question)\b\s*(\d*)\s*[.:)-]?\s*(.*)$/i;
    const ore = /^\s*(\d+)\s*[.):\-]\s*(.+)$/;
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const qm = line.match(qre);
      if (qm) {
        if (cur) questions.push(cur);
        cur = { text: String(qm[2] || '').trim(), options: [], line: i + 1 };
        continue;
      }
      const om = line.match(ore);
      if (om) {
        if (!cur) { errors.push(`Строка ${i + 1}: вариант вне вопроса`); continue; }
        cur.options.push(String(om[2] || '').trim());
        continue;
      }
      if (cur) {
        if (cur.options.length === 0) cur.text += (cur.text ? ' ' : '') + line;
        else cur.options[cur.options.length - 1] += ' ' + line;
      } else {
        errors.push(`Строка ${i + 1}: не удалось разобрать`);
      }
    }
    if (cur) questions.push(cur);
    if (questions.length === 0) errors.push('Не найдено ни одного вопроса');
    questions.forEach((q, i) => {
      if (!q.text) errors.push(`Вопрос ${i + 1}: пустой текст`);
      if (q.options.length < 2) errors.push(`Вопрос ${i + 1}: минимум 2 варианта`);
      q.options.forEach((o, j) => {
        if (!o) errors.push(`Вопрос ${i + 1}, вариант ${j + 1}: пустой`);
      });
    });
    return { ok: errors.length === 0, errors, questions };
  }

  // ═══════════════════════════════════════════════════════════
  // Сериализация при submit
  // ═══════════════════════════════════════════════════════════
  function collectPayload() {
    const meta = {
      title: (root.querySelector('[name="quiz_title"]') || {}).value || '',
      description: (root.querySelector('[name="quiz_description"]') || {}).value || '',
      pass_percent: Number((root.querySelector('[name="quiz_pass_percent"]') || {}).value || 60),
      max_attempts: Number((root.querySelector('[name="quiz_max_attempts"]') || {}).value || 1),
      time_limit_minutes: (() => {
        const v = (root.querySelector('[name="quiz_time_limit"]') || {}).value;
        return v ? Number(v) : null;
      })(),
      show_correct: !!(root.querySelector('[name="quiz_show_correct"]') || {}).checked,
      questions: [],
    };

    const qs = root.querySelectorAll('#quiz-questions > .quiz-q');
    qs.forEach((q) => {
      if (typeof q._getData === 'function') meta.questions.push(q._getData());
    });
    return meta;
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      const payload = collectPayload();
      // Базовая клиентская валидация — чтобы не гонять заведомо битое.
      const invalid = [];
      payload.questions.forEach((q, i) => {
        if (!q.text && !q.image_stored_name) invalid.push(`Вопрос ${i + 1}: пустой`);
        if (q.options.length < 2) invalid.push(`Вопрос ${i + 1}: < 2 вариантов`);
      });
      if (invalid.length > 0) {
        e.preventDefault();
        alert('Проверьте тест:\n' + invalid.join('\n'));
        return;
      }
      jsonInput.value = JSON.stringify(payload);
    });
  }

  // ─── Глобальный Ctrl+V на блоке конструктора (если не сработал на слоте) ───
  // Ловим только когда focus НЕ в textarea/input — чтобы не мешать вставке текста.
  root.addEventListener('paste', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        // Вставляем в первый развёрнутый вопрос без картинки
        const open = root.querySelector('#quiz-questions > .quiz-q[data-open="1"]');
        if (!open) {
          alert('Разверните вопрос, куда вставить картинку');
          return;
        }
        const slot = open.querySelector('.quiz-q-body .quiz-image-slot');
        if (slot) {
          const ev = new ClipboardEvent('paste', { clipboardData: e.clipboardData });
          slot.dispatchEvent(ev);
        }
        return;
      }
    }
  });
})();