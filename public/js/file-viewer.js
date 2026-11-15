'use strict';
let pdfDoc = null;
let pdfPageNum = 1;
let pdfScale = 1.5;
let pdfRendering = false;
let pdfPending = null;
const FILE_VIEWER_IMAGE_EXTS = ['jpg', 'jpeg', 'png'];
const FILE_VIEWER_TEXT_EXTS = ['txt'];
const PDFJS_BASE = '/vendor/pdfjs';

function js_pdf_viewer_getExtension(fileName) {
  const m = /\.([a-z0-9]+)$/i.exec(fileName || '');
  return m ? m[1].toLowerCase() : '';
}
function js_pdf_viewer_getMode(fileName) {
  const ext = js_pdf_viewer_getExtension(fileName);
  if (ext === 'pdf') return 'pdf';
  if (FILE_VIEWER_IMAGE_EXTS.includes(ext)) return 'image';
  if (FILE_VIEWER_TEXT_EXTS.includes(ext)) return 'text';
  return 'unsupported';
}
function js_pdf_viewer_resetPanels() {
  const canvas = document.getElementById('pdf-canvas');
  if (canvas) { canvas.style.display = 'none'; canvas.width = canvas.height = 0; }
  const img = document.getElementById('image-viewer');
  if (img) { img.style.display = 'none'; img.src = ''; }
  const pre = document.getElementById('text-viewer');
  if (pre) { pre.style.display = 'none'; pre.textContent = ''; }
  const unsup = document.getElementById('unsupported-viewer');
  if (unsup) unsup.style.display = 'none';
  const pdfCtrls = document.getElementById('pdf-controls');
  if (pdfCtrls) pdfCtrls.style.display = 'none';
  if (pdfDoc) { try { pdfDoc.destroy(); } catch (e) { /* ignore */ } pdfDoc = null; }
}
async function js_pdf_viewer_open(fileName, viewUrl, downloadUrl) {
  const modal = document.getElementById('file-viewer-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  js_pdf_viewer_resetPanels();
  document.getElementById('file-modal-title').textContent = fileName || 'Просмотр файла';
  document.getElementById('file-download-link').href = downloadUrl || viewUrl;
  const mode = js_pdf_viewer_getMode(fileName);
  try {
    switch (mode) {
      case 'pdf':   await js_pdf_viewer_openPdf(viewUrl, fileName); break;
      case 'image': js_pdf_viewer_openImage(viewUrl); break;
      case 'text':  await js_pdf_viewer_openText(viewUrl); break;
      default:      js_pdf_viewer_openUnsupported(viewUrl, downloadUrl); break;
    }
  } catch (err) {
    console.error('Ошибка открытия файла:', err);
    document.getElementById('file-modal-title').textContent =
      'Ошибка: ' + (err.message || 'неизвестная');
  }
}
async function js_pdf_viewer_openPdf(url, fileName) {
  const canvas = document.getElementById('pdf-canvas');
  const pdfCtrls = document.getElementById('pdf-controls');
  canvas.style.display = 'block';
  pdfCtrls.style.display = 'flex';
  document.getElementById('pdf-page-info').textContent = '1 / …';
  pdfPageNum = 1;
  pdfScale = 1.5;
  if (!window.pdfjsLib) {
    const pdfjs = await import(`${PDFJS_BASE}/build/pdf.mjs`);
    window.pdfjsLib = pdfjs;
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.mjs`;
  }
  const loadingTask = window.pdfjsLib.getDocument({
    url,
    wasmUrl: `${PDFJS_BASE}/wasm/`,
    cMapUrl: `${PDFJS_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
    iccUrl: `${PDFJS_BASE}/iccs/`,
  });
  loadingTask.onProgress = (progress) => {
    if (progress.total > 0) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      document.getElementById('file-modal-title').textContent = `${fileName} — ${pct}%`;
    }
  };
  pdfDoc = await loadingTask.promise;
  document.getElementById('file-modal-title').textContent = fileName || 'PDF';
  js_pdf_viewer_queueRenderPage(pdfPageNum);
}
function js_pdf_viewer_openImage(url) {
  const img = document.getElementById('image-viewer');
  img.style.display = 'block';
  img.src = url;
  img.onerror = () => {
    img.style.display = 'none';
    document.getElementById('unsupported-viewer').style.display = 'block';
  };
}
async function js_pdf_viewer_openText(url) {
  const pre = document.getElementById('text-viewer');
  pre.style.display = 'block';
  pre.textContent = 'Загрузка…';
  const resp = await fetch(url, { credentials: 'same-origin' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  const MAX_CHARS = 2 * 1024 * 1024;
  pre.textContent = text.length > MAX_CHARS
    ? text.slice(0, MAX_CHARS) + '\n\n… (файл обрезан)'
    : text;
}
function js_pdf_viewer_openUnsupported(viewUrl, downloadUrl) {
  const unsup = document.getElementById('unsupported-viewer');
  const link = document.getElementById('unsupported-download-link');
  if (link) link.href = downloadUrl || viewUrl;
  unsup.style.display = 'block';
}
function js_pdf_viewer_queueRenderPage(num) {
  if (pdfRendering) { pdfPending = num; return; }
  pdfRendering = true;
  js_pdf_viewer_renderPage(num).finally(() => {
    pdfRendering = false;
    if (pdfPending !== null) {
      const next = pdfPending;
      pdfPending = null;
      js_pdf_viewer_queueRenderPage(next);
    }
  });
}
async function js_pdf_viewer_renderPage(num) {
  if (!pdfDoc) return;
  try {
    const page = await pdfDoc.getPage(num);
    const viewport = page.getViewport({ scale: pdfScale });
    const canvas = document.getElementById('pdf-canvas');
    const ctx = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    await page.render({ canvasContext: ctx, viewport }).promise;
    document.getElementById('pdf-page-info').textContent = `${num} / ${pdfDoc.numPages}`;
    document.getElementById('pdf-prev-page').disabled = num <= 1;
    document.getElementById('pdf-next-page').disabled = num >= pdfDoc.numPages;
  } catch (err) {
    console.error('Ошибка рендера:', err);
  }
}
function js_pdf_viewer_close() {
  const modal = document.getElementById('file-viewer-modal');
  if (modal) modal.style.display = 'none';
  js_pdf_viewer_resetPanels();
}
function js_pdf_viewer_openOrDownload(evt, fileName, viewUrl, downloadUrl) {
  const mode = js_pdf_viewer_getMode(fileName);
  if (mode === 'pdf' || mode === 'image' || mode === 'text') {
    evt.preventDefault();
    js_pdf_viewer_open(fileName, viewUrl, downloadUrl);
    return true;
  }
  return false;
}
function js_pdf_viewer_initialize() {
  const closeBtn = document.getElementById('file-close');
  if (closeBtn) closeBtn.addEventListener('click', js_pdf_viewer_close);
  const prevBtn = document.getElementById('pdf-prev-page');
  if (prevBtn) prevBtn.addEventListener('click', () => {
    if (pdfPageNum <= 1) return;
    pdfPageNum--;
    js_pdf_viewer_queueRenderPage(pdfPageNum);
  });
  const nextBtn = document.getElementById('pdf-next-page');
  if (nextBtn) nextBtn.addEventListener('click', () => {
    if (!pdfDoc || pdfPageNum >= pdfDoc.numPages) return;
    pdfPageNum++;
    js_pdf_viewer_queueRenderPage(pdfPageNum);
  });
  const zoomIn = document.getElementById('pdf-zoom-in');
  if (zoomIn) zoomIn.addEventListener('click', () => {
    if (!pdfDoc) return;
    pdfScale = Math.min(pdfScale + 0.25, 4);
    js_pdf_viewer_queueRenderPage(pdfPageNum);
  });
  const zoomOut = document.getElementById('pdf-zoom-out');
  if (zoomOut) zoomOut.addEventListener('click', () => {
    if (!pdfDoc) return;
    pdfScale = Math.max(pdfScale - 0.25, 0.5);
    js_pdf_viewer_queueRenderPage(pdfPageNum);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('file-viewer-modal');
      if (modal && modal.style.display !== 'none') js_pdf_viewer_close();
    }
  });
  const modal = document.getElementById('file-viewer-modal');
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target === modal) js_pdf_viewer_close();
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-file-preview]');
    if (!el) return;
    js_pdf_viewer_openOrDownload(
      e,
      el.dataset.fileName,
      el.dataset.viewUrl,
      el.dataset.downloadUrl
    );
  });
}
document.addEventListener('DOMContentLoaded', js_pdf_viewer_initialize);