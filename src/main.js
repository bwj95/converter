import { zipSync } from '../vendor/fflate.mjs';
import { FORMATS, OUTPUT_FORMATS } from './core/registry.js';
import { detectFormat } from './core/detect.js';

const worker = new Worker(new URL('./worker/convert.worker.js', import.meta.url), {
  type: 'module',
});

let nextJobId = 1;
const pendingJobs = new Map();

worker.onmessage = (event) => {
  const { id, type, ok, result, error, progress, message } = event.data;
  const job = pendingJobs.get(id);
  if (!job) return;

  if (type === 'progress') {
    if (job.onProgress) job.onProgress(progress, message);
    return;
  }

  pendingJobs.delete(id);
  if (ok) job.resolve(result);
  else job.reject(new Error(error || 'Worker error'));
};

function runWorker(action, payload, transfer = [], onProgress = null) {
  const id = nextJobId++;
  return new Promise((resolve, reject) => {
    pendingJobs.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, action, payload }, transfer);
  });
}

// DOM refs
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const sampleBtn = document.getElementById('sampleBtn');
const workspace = document.getElementById('workspace');
const queueList = document.getElementById('queueList');
const globalFormatSelect = document.getElementById('globalFormat');
const convertAllBtn = document.getElementById('convertAllBtn');
const downloadZipBtn = document.getElementById('downloadZipBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const toggleOptionsBtn = document.getElementById('toggleOptionsBtn');
const optionsPanel = document.getElementById('optionsPanel');
const formatPills = document.getElementById('formatPills');
const themeToggle = document.getElementById('themeToggle');

// Options refs
const optPageSize = document.getElementById('optPageSize');
const optFontFamily = document.getElementById('optFontFamily');
const optFontSize = document.getElementById('optFontSize');
const optMargin = document.getElementById('optMargin');
const optPageNumbers = document.getElementById('optPageNumbers');

// Modal refs
const inspectorModal = document.getElementById('inspectorModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const modalTitle = document.getElementById('modalTitle');
const modalStats = document.getElementById('modalStats');
const metaTitle = document.getElementById('metaTitle');
const metaAuthor = document.getElementById('metaAuthor');
const metaLang = document.getElementById('metaLang');
const metaPublisher = document.getElementById('metaPublisher');
const chapterNav = document.getElementById('chapterNav');
const chapterPreview = document.getElementById('chapterPreview');
const saveMetaBtn = document.getElementById('saveMetaBtn');

// App state
const queue = [];
let activeInspectId = null;

// Theme initialization
function initTheme() {
  const saved = localStorage.getItem('converter-theme');
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
}

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('converter-theme', next);
  themeToggle.textContent = next === 'dark' ? 'Light' : 'Dark';
});

function populateFormats() {
  for (const fmt of OUTPUT_FORMATS) {
    const opt = document.createElement('option');
    opt.value = fmt.id;
    opt.textContent = fmt.label;
    globalFormatSelect.appendChild(opt);
  }
  globalFormatSelect.value = 'epub';

  formatPills.innerHTML = Object.values(FORMATS)
    .map(
      (f) => `<div class="format-pill">
        <strong>${f.label} (${f.ext})</strong>
        <span>${f.description}</span>
      </div>`
    )
    .join('');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function defaultTargetFor(srcFormat) {
  if (srcFormat === 'epub') return 'mobi';
  if (srcFormat === 'mobi') return 'epub';
  if (srcFormat === 'pdf') return 'epub';
  return 'epub';
}

function getPdfOptions() {
  return {
    pageSize: optPageSize.value,
    fontFamily: optFontFamily.value,
    fontSize: Number(optFontSize.value),
    marginPreset: optMargin.value,
    showPageNumbers: optPageNumbers.checked,
  };
}

async function addFiles(fileList) {
  for (const file of fileList) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const sourceFormat = detectFormat(bytes, file.name);
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

    const item = {
      id,
      filename: file.name,
      size: bytes.length,
      bytes,
      sourceFormat,
      targetFormat: sourceFormat ? defaultTargetFor(sourceFormat) : 'epub',
      status: sourceFormat ? 'ready' : 'error',
      statusMessage: sourceFormat ? 'Ready to convert' : 'Unsupported file format',
      progress: 0,
      metadataOverride: null,
      outputBlob: null,
      outputName: null,
      outputBytes: null,
    };
    queue.push(item);
  }
  renderQueue();
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function convertItem(item) {
  if (!item.sourceFormat) return;
  item.status = 'working';
  item.statusMessage = 'Starting...';
  item.progress = 0.05;
  item.outputBlob = null;
  item.outputBytes = null;
  renderQueue();

  try {
    // Copy buffer so original stays intact for re-conversions
    const copy = item.bytes.slice().buffer;
    const result = await runWorker(
      'convert',
      {
        buffer: copy,
        filename: item.filename,
        sourceFormat: item.sourceFormat,
        targetFormat: item.targetFormat,
        metadataOverride: item.metadataOverride,
        options: getPdfOptions(),
      },
      [copy],
      (progress, message) => {
        item.progress = progress;
        item.statusMessage = message;
        updateItemProgressUI(item);
      }
    );

    const outU8 = new Uint8Array(result.outputBuffer);
    item.outputBytes = outU8;
    item.outputName = result.outputName;
    item.outputBlob = new Blob([outU8], { type: result.mimeType });
    item.status = 'done';
    item.progress = 1;
    item.statusMessage = `Done · ${formatBytes(outU8.length)} (${result.stats.chapters} ch, ${result.stats.words.toLocaleString()} words)`;
  } catch (err) {
    item.status = 'error';
    item.progress = 0;
    item.statusMessage = err.message || 'Conversion failed';
  }
  renderQueue();
}

function updateItemProgressUI(item) {
  const el = queueList.querySelector(`[data-id="${item.id}"]`);
  if (!el) return;
  const bar = el.querySelector('.progress__bar');
  const statusEl = el.querySelector('.queue-item__status');
  if (bar) bar.style.width = `${Math.round(item.progress * 100)}%`;
  if (statusEl) statusEl.textContent = item.statusMessage;
}

async function openInspector(item) {
  activeInspectId = item.id;
  modalTitle.textContent = item.filename;
  modalStats.textContent = 'Parsing book structure...';
  chapterNav.innerHTML = '';
  chapterPreview.innerHTML = '<p>Loading preview...</p>';
  inspectorModal.showModal();

  try {
    const copy = item.bytes.slice().buffer;
    const res = await runWorker(
      'inspect',
      { buffer: copy, filename: item.filename },
      [copy]
    );
    const meta = { ...res.book.metadata, ...(item.metadataOverride || {}) };
    metaTitle.value = meta.title || '';
    metaAuthor.value = meta.author || '';
    metaLang.value = meta.language || 'en';
    metaPublisher.value = meta.publisher || '';
    modalStats.textContent = `${FORMATS[res.sourceFormat]?.label || res.sourceFormat} · ${res.stats.chapters} chapters · ${res.stats.words.toLocaleString()} words · ${res.stats.images} images`;

    const renderChapter = (idx) => {
      const ch = res.book.chapters[idx];
      if (!ch) return;
      // Strip any inline scripts for safe preview
      chapterPreview.innerHTML = ch.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      chapterNav.querySelectorAll('button').forEach((b, i) => {
        b.classList.toggle('is-active', i === idx);
      });
    };

    res.book.chapters.forEach((ch, idx) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = ch.title || `Chapter ${idx + 1}`;
      btn.addEventListener('click', () => renderChapter(idx));
      li.appendChild(btn);
      chapterNav.appendChild(li);
    });

    if (res.book.chapters.length > 0) renderChapter(0);
  } catch (err) {
    modalStats.textContent = 'Inspection error';
    chapterPreview.innerHTML = `<p style="color:var(--err)">${err.message}</p>`;
  }
}

function renderQueue() {
  workspace.hidden = queue.length === 0;
  queueList.innerHTML = '';

  const doneItems = queue.filter((q) => q.status === 'done' && q.outputBytes);
  downloadZipBtn.hidden = doneItems.length < 2;

  for (const item of queue) {
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.dataset.id = item.id;

    const srcLabel = item.sourceFormat ? FORMATS[item.sourceFormat]?.label : 'Unknown';
    const statusClass =
      item.status === 'done' ? 'is-ok' : item.status === 'error' ? 'is-err' : '';

    li.innerHTML = `
      <div class="queue-item__info">
        <div class="queue-item__title" title="${item.filename}">${item.filename}</div>
        <div class="queue-item__meta">
          <span class="fmt-tag">${srcLabel}</span>
          <span>${formatBytes(item.size)}</span>
          ${item.metadataOverride?.title ? `<span>· "${item.metadataOverride.title}"</span>` : ''}
        </div>
        <div class="queue-item__status ${statusClass}">${item.statusMessage}</div>
        ${item.status === 'working' ? `<div class="progress"><div class="progress__bar" style="width:${Math.round(item.progress * 100)}%"></div></div>` : ''}
      </div>

      <div class="queue-item__target">
        <span aria-hidden="true">→</span>
        <select class="select target-select" aria-label="Target format for ${item.filename}" ${item.status === 'working' ? 'disabled' : ''}>
          ${OUTPUT_FORMATS.map(
            (f) => `<option value="${f.id}" ${f.id === item.targetFormat ? 'selected' : ''}>${f.label}</option>`
          ).join('')}
        </select>
      </div>

      <div class="queue-item__actions">
        <button class="btn btn--ghost btn--sm inspect-btn" type="button" ${!item.sourceFormat || item.status === 'working' ? 'disabled' : ''}>Inspect</button>
        ${
          item.status === 'done'
            ? `<button class="btn btn--primary btn--sm download-btn" type="button">Download</button>`
            : `<button class="btn btn--primary btn--sm convert-btn" type="button" ${!item.sourceFormat || item.status === 'working' ? 'disabled' : ''}>Convert</button>`
        }
        <button class="btn btn--ghost btn--sm remove-btn" type="button" aria-label="Remove ${item.filename}">✕</button>
      </div>
    `;

    li.querySelector('.target-select').addEventListener('change', (e) => {
      item.targetFormat = e.target.value;
      if (item.status === 'done') {
        item.status = 'ready';
        item.statusMessage = 'Ready to convert';
        item.outputBlob = null;
        renderQueue();
      }
    });

    li.querySelector('.inspect-btn').addEventListener('click', () => openInspector(item));
    const convBtn = li.querySelector('.convert-btn');
    if (convBtn) convBtn.addEventListener('click', () => convertItem(item));
    const dlBtn = li.querySelector('.download-btn');
    if (dlBtn) dlBtn.addEventListener('click', () => triggerDownload(item.outputBlob, item.outputName));
    li.querySelector('.remove-btn').addEventListener('click', () => {
      const idx = queue.findIndex((q) => q.id === item.id);
      if (idx !== -1) queue.splice(idx, 1);
      renderQueue();
    });

    queueList.appendChild(li);
  }
}

// Event wiring
browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files?.length) {
    addFiles(e.target.files);
    fileInput.value = '';
  }
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('is-dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('is-dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('is-dragover');
  if (e.dataTransfer?.files?.length) {
    addFiles(e.dataTransfer.files);
  }
});

sampleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const sampleMd = `---
title: "The Browser Workshop"
author: "Open Source Reader"
language: "en"
---

# Chapter 1: Local First

This sample book was generated in your browser to test **EPUB**, **MOBI**, **PDF**, **FB2**, **HTML**, **Markdown**, and **TXT** conversions.

> Everything runs locally inside a Web Worker. No files are ever uploaded to a server.

## Why It Matters

- Zero server costs — hosts statically on GitHub Pages
- Instant conversions for DRM-free books
- Editable metadata before export

# Chapter 2: Open Formats

Open formats like EPUB and Markdown preserve structure across devices, while PDF locks in print-ready pagination.
`;
  const file = new File([sampleMd], 'the-browser-workshop.md', { type: 'text/markdown' });
  addFiles([file]);
});

globalFormatSelect.addEventListener('change', () => {
  const fmt = globalFormatSelect.value;
  for (const item of queue) {
    item.targetFormat = fmt;
    if (item.status === 'done') {
      item.status = 'ready';
      item.statusMessage = 'Ready to convert';
      item.outputBlob = null;
    }
  }
  renderQueue();
});

toggleOptionsBtn.addEventListener('click', () => {
  const hidden = optionsPanel.hidden;
  optionsPanel.hidden = !hidden;
  toggleOptionsBtn.setAttribute('aria-expanded', String(hidden));
});

convertAllBtn.addEventListener('click', async () => {
  convertAllBtn.disabled = true;
  for (const item of queue) {
    if (item.sourceFormat && item.status !== 'done') {
      await convertItem(item);
    }
  }
  convertAllBtn.disabled = false;
});

downloadZipBtn.addEventListener('click', () => {
  const entries = {};
  for (const item of queue) {
    if (item.status === 'done' && item.outputBytes && item.outputName) {
      entries[item.outputName] = item.outputBytes;
    }
  }
  const zipped = zipSync(entries, { level: 6 });
  triggerDownload(new Blob([zipped], { type: 'application/zip' }), 'converted-books.zip');
});

clearAllBtn.addEventListener('click', () => {
  queue.length = 0;
  renderQueue();
});

closeModalBtn.addEventListener('click', () => inspectorModal.close());
saveMetaBtn.addEventListener('click', () => {
  const item = queue.find((q) => q.id === activeInspectId);
  if (item) {
    item.metadataOverride = {
      title: metaTitle.value.trim(),
      author: metaAuthor.value.trim(),
      language: metaLang.value.trim(),
      publisher: metaPublisher.value.trim(),
    };
    if (item.status === 'done') {
      item.status = 'ready';
      item.statusMessage = 'Metadata updated · Ready to convert';
      item.outputBlob = null;
    }
    renderQueue();
  }
  inspectorModal.close();
});

initTheme();
populateFormats();
