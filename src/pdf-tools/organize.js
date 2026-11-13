import { PDFDocument, degrees } from '../../vendor/pdf-lib.mjs';
import { zipSync } from '../../vendor/fflate.mjs';
import { openPdf, renderPageCanvas } from './pdfjs.js';
import {
  downloadBytes,
  ensurePdfName,
  friendlyPdfError,
  isPdfBytes,
  normalizeImage,
  readFileBytes,
  uid,
} from './util.js';

const A4 = [595.28, 841.89];
const THUMB_CSS_WIDTH = 170;

const $ = (id) => document.getElementById(id);

export function createOrganizer({ onSendToEditor }) {
  const drop = $('orgDrop');
  const fileInput = $('orgFileInput');
  const work = $('orgWork');
  const grid = $('orgGrid');
  const sourcesEl = $('orgSources');
  const countEl = $('orgCount');
  const statusEl = $('orgStatus');
  const filenameInput = $('orgFilename');

  /** id -> { id, name, kind: 'pdf'|'image', bytes, pdf?, image?, hue } */
  const sources = new Map();
  /** Ordered page list: { key, srcId, index, rotation, selected } */
  let pages = [];
  const cards = new Map();
  let dragKey = null;
  let busy = false;
  let hueCursor = 0;

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const key = entry.target.dataset.key;
        io.unobserve(entry.target);
        const p = pages.find((pg) => pg.key === key);
        if (p) renderThumb(p);
      }
    },
    { rootMargin: '400px' }
  );

  function setStatus(msg, kind = '') {
    statusEl.textContent = msg || '';
    statusEl.className = `pdf-status ${kind ? `is-${kind}` : ''}`;
  }

  function setBusy(on, msg) {
    busy = on;
    work.querySelectorAll('[data-needs-pages]').forEach((b) => {
      b.disabled = on || pages.length === 0;
    });
    work.querySelectorAll('[data-needs-selection]').forEach((b) => {
      b.disabled = on || !pages.some((p) => p.selected);
    });
    if (msg !== undefined) setStatus(msg, on ? '' : 'ok');
  }

  async function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    setStatus(`Loading ${files.length} file${files.length > 1 ? 's' : ''}…`);
    let added = 0;
    const errors = [];

    for (const file of files) {
      try {
        const bytes = await readFileBytes(file);
        const id = uid();
        const hue = (hueCursor++ * 137.5) % 360; // golden-angle spread = distinct colors
        if (isPdfBytes(bytes)) {
          const pdf = await openPdf(bytes);
          sources.set(id, { id, name: file.name, kind: 'pdf', bytes, pdf, hue });
          for (let i = 0; i < pdf.numPages; i++) {
            pages.push({ key: uid(), srcId: id, index: i, rotation: 0, selected: false });
          }
          added += pdf.numPages;
        } else if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
          const image = await normalizeImage(bytes, file.type);
          sources.set(id, { id, name: file.name, kind: 'image', bytes: image.bytes, image, hue });
          pages.push({ key: uid(), srcId: id, index: 0, rotation: 0, selected: false });
          added += 1;
        } else {
          errors.push(`${file.name}: not a PDF or image`);
        }
      } catch (err) {
        errors.push(`${file.name}: ${friendlyPdfError(err)}`);
      }
    }

    if (!filenameInput.dataset.touched && sources.size === 1) {
      const only = [...sources.values()][0];
      filenameInput.value = only.name.replace(/\.[^.]+$/, '') + '-edited.pdf';
    } else if (!filenameInput.dataset.touched) {
      filenameInput.value = 'merged.pdf';
    }

    render();
    if (errors.length) setStatus(errors.join(' · '), 'err');
    else setStatus(`Added ${added} page${added === 1 ? '' : 's'}.`, 'ok');
  }

  async function renderThumb(p) {
    const card = cards.get(p.key);
    const src = sources.get(p.srcId);
    if (!card || !src) return;
    const host = card.querySelector('.page-card__thumb');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const token = `${p.rotation}`;
    host.dataset.token = token;

    try {
      let canvas;
      if (src.kind === 'pdf') {
        const page = await src.pdf.getPage(p.index + 1);
        const rotation = (page.rotate + p.rotation) % 360;
        const base = page.getViewport({ scale: 1, rotation });
        const scale = (THUMB_CSS_WIDTH * dpr) / Math.max(base.width, base.height);
        ({ canvas } = await renderPageCanvas(page, { scale, rotation }));
      } else {
        const { bitmap } = src.image;
        const quarter = p.rotation % 180 !== 0;
        const scale = (THUMB_CSS_WIDTH * dpr) / Math.max(bitmap.width, bitmap.height);
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);
        canvas = document.createElement('canvas');
        canvas.width = quarter ? h : w;
        canvas.height = quarter ? w : h;
        const ctx = canvas.getContext('2d');
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
      }
      // A newer rotation may have started while this one rendered.
      if (host.dataset.token !== token) return;
      host.replaceChildren(canvas);
    } catch (err) {
      host.textContent = 'Preview failed';
      console.error(err);
    }
  }

  function makeCard(p) {
    const li = document.createElement('li');
    li.className = 'page-card';
    li.draggable = true;
    li.dataset.key = p.key;
    li.innerHTML = `
      <div class="page-card__thumb"><span class="page-card__loading">…</span></div>
      <div class="page-card__bar">
        <label class="page-card__select">
          <input type="checkbox" aria-label="Select page" />
          <span class="page-card__num"></span>
        </label>
        <span class="page-card__src"></span>
      </div>
      <div class="page-card__actions">
        <button type="button" class="icon-btn" data-act="left" title="Move left" aria-label="Move left">←</button>
        <button type="button" class="icon-btn" data-act="rotate" title="Rotate 90°" aria-label="Rotate 90 degrees">↻</button>
        <button type="button" class="icon-btn" data-act="right" title="Move right" aria-label="Move right">→</button>
        <button type="button" class="icon-btn icon-btn--danger" data-act="delete" title="Delete page" aria-label="Delete page">✕</button>
      </div>`;

    li.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
      const pg = pages.find((x) => x.key === p.key);
      if (pg) pg.selected = e.target.checked;
      render();
    });

    li.querySelector('.page-card__actions').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const idx = pages.findIndex((x) => x.key === p.key);
      if (idx === -1) return;
      const act = btn.dataset.act;
      if (act === 'delete') {
        pages.splice(idx, 1);
      } else if (act === 'rotate') {
        pages[idx].rotation = (pages[idx].rotation + 90) % 360;
        renderThumb(pages[idx]);
      } else if (act === 'left' && idx > 0) {
        [pages[idx - 1], pages[idx]] = [pages[idx], pages[idx - 1]];
      } else if (act === 'right' && idx < pages.length - 1) {
        [pages[idx + 1], pages[idx]] = [pages[idx], pages[idx + 1]];
      }
      render();
    });

    li.addEventListener('dragstart', (e) => {
      dragKey = p.key;
      li.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.key);
    });
    li.addEventListener('dragend', () => {
      dragKey = null;
      li.classList.remove('is-dragging');
      clearDropMarks();
    });
    li.addEventListener('dragover', (e) => {
      if (!dragKey || dragKey === p.key) return;
      e.preventDefault();
      const rect = li.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      clearDropMarks();
      li.classList.add(after ? 'is-drop-after' : 'is-drop-before');
    });
    li.addEventListener('drop', (e) => {
      if (!dragKey || dragKey === p.key) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = li.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      const from = pages.findIndex((x) => x.key === dragKey);
      const [moved] = pages.splice(from, 1);
      let to = pages.findIndex((x) => x.key === p.key);
      if (after) to += 1;
      pages.splice(to, 0, moved);
      clearDropMarks();
      render();
    });

    cards.set(p.key, li);
    io.observe(li);
    return li;
  }

  function clearDropMarks() {
    grid.querySelectorAll('.is-drop-before, .is-drop-after').forEach((el) => {
      el.classList.remove('is-drop-before', 'is-drop-after');
    });
  }

  function render() {
    work.hidden = pages.length === 0 && sources.size === 0;
    drop.classList.toggle('dropzone--compact', !work.hidden);

    // Drop sources whose pages were all deleted.
    const used = new Set(pages.map((p) => p.srcId));
    for (const id of [...sources.keys()]) {
      if (!used.has(id)) {
        sources.get(id).pdf?.destroy();
        sources.delete(id);
      }
    }

    // Remove cards for deleted pages, then append in order (appendChild moves nodes).
    const live = new Set(pages.map((p) => p.key));
    for (const [key, el] of cards) {
      if (!live.has(key)) {
        io.unobserve(el);
        el.remove();
        cards.delete(key);
      }
    }
    pages.forEach((p, i) => {
      const card = cards.get(p.key) || makeCard(p);
      const src = sources.get(p.srcId);
      card.style.setProperty('--src-hue', src.hue);
      card.classList.toggle('is-selected', p.selected);
      card.querySelector('input[type="checkbox"]').checked = p.selected;
      card.querySelector('.page-card__num').textContent = String(i + 1);
      const srcLabel = src.kind === 'pdf' ? `${src.name} · p${p.index + 1}` : src.name;
      const srcEl = card.querySelector('.page-card__src');
      srcEl.textContent = srcLabel;
      srcEl.title = srcLabel;
      card.querySelector('[data-act="left"]').disabled = i === 0;
      card.querySelector('[data-act="right"]').disabled = i === pages.length - 1;
      grid.appendChild(card);
    });

    sourcesEl.innerHTML = [...sources.values()]
      .map(
        (s) =>
          `<span class="source-chip" style="--src-hue:${s.hue}"><span class="source-chip__dot"></span>${escapeHtml(s.name)}</span>`
      )
      .join('');

    const sel = pages.filter((p) => p.selected).length;
    countEl.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}${sel ? ` · ${sel} selected` : ''}`;
    setBusy(busy);
  }

  /**
   * Build a PDF from an ordered page list. One copyPages() call per source
   * so shared resources (fonts, images) are copied once, not once per page.
   */
  async function buildPdf(pageList, libCache = new Map()) {
    const out = await PDFDocument.create();
    out.setProducer('Converter PDF Tools (browser)');
    out.setCreator('Converter PDF Tools (browser)');

    const copied = new Map(); // `${srcId}:${index}` -> PDFPage
    const bySource = new Map();
    for (const p of pageList) {
      if (sources.get(p.srcId).kind !== 'pdf') continue;
      if (!bySource.has(p.srcId)) bySource.set(p.srcId, []);
      bySource.get(p.srcId).push(p.index);
    }
    for (const [srcId, indices] of bySource) {
      let lib = libCache.get(srcId);
      if (!lib) {
        lib = await PDFDocument.load(sources.get(srcId).bytes);
        libCache.set(srcId, lib);
      }
      const copies = await out.copyPages(lib, indices);
      indices.forEach((idx, i) => copied.set(`${srcId}:${idx}`, copies[i]));
    }

    const embedded = new Map();
    for (const p of pageList) {
      const src = sources.get(p.srcId);
      if (src.kind === 'pdf') {
        const page = copied.get(`${p.srcId}:${p.index}`);
        const base = page.getRotation().angle || 0;
        page.setRotation(degrees((((base + p.rotation) % 360) + 360) % 360));
        out.addPage(page);
      } else {
        let img = embedded.get(src.id);
        if (!img) {
          img = src.image.mime === 'image/png' ? await out.embedPng(src.bytes) : await out.embedJpg(src.bytes);
          embedded.set(src.id, img);
        }
        // Fit the image to an A4 box in its own orientation, no borders.
        const landscape = img.width > img.height;
        const [boxW, boxH] = landscape ? [A4[1], A4[0]] : A4;
        const s = Math.min(boxW / img.width, boxH / img.height);
        const w = img.width * s;
        const h = img.height * s;
        const page = out.addPage([w, h]);
        page.drawImage(img, { x: 0, y: 0, width: w, height: h });
        if (p.rotation) page.setRotation(degrees(p.rotation));
      }
    }
    return out.save();
  }

  async function runExport(kind) {
    if (busy || !pages.length) return;
    const list = kind === 'selected' ? pages.filter((p) => p.selected) : pages;
    if (!list.length) return;
    const name = ensurePdfName(filenameInput.value, 'merged.pdf');
    setBusy(true, 'Building PDF…');
    try {
      if (kind === 'split') {
        const libCache = new Map();
        const entries = {};
        const base = name.replace(/\.pdf$/i, '');
        const width = String(list.length).length;
        for (let i = 0; i < list.length; i++) {
          setStatus(`Splitting page ${i + 1}/${list.length}…`);
          entries[`${base}-p${String(i + 1).padStart(width, '0')}.pdf`] = await buildPdf([list[i]], libCache);
        }
        downloadBytes(zipSync(entries, { level: 0 }), `${base}-pages.zip`, 'application/zip');
        setBusy(false, `Split into ${list.length} PDFs.`);
      } else {
        const bytes = await buildPdf(list);
        if (kind === 'editor') {
          setBusy(false, '');
          onSendToEditor(bytes, name);
        } else {
          const outName = kind === 'selected' ? name.replace(/\.pdf$/i, '-selected.pdf') : name;
          downloadBytes(bytes, outName);
          setBusy(false, `Saved ${outName} · ${list.length} page${list.length === 1 ? '' : 's'} · ${formatBytes(bytes.length)}`);
        }
      }
    } catch (err) {
      console.error(err);
      setBusy(false);
      setStatus(friendlyPdfError(err), 'err');
    }
  }

  // ---- wiring ----
  const openPicker = () => fileInput.click();
  drop.addEventListener('click', openPicker);
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });
  $('orgBrowseBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openPicker();
  });
  $('orgAddBtn').addEventListener('click', openPicker);
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) addFiles(fileInput.files);
    fileInput.value = '';
  });

  for (const target of [drop, grid]) {
    target.addEventListener('dragover', (e) => {
      if (dragKey) return;
      if ([...(e.dataTransfer?.types || [])].includes('Files')) {
        e.preventDefault();
        target.classList.add('is-dragover');
      }
    });
    target.addEventListener('dragleave', () => target.classList.remove('is-dragover'));
    target.addEventListener('drop', (e) => {
      target.classList.remove('is-dragover');
      if (dragKey || !e.dataTransfer?.files?.length) return;
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    });
  }

  $('orgSelectAllBtn').addEventListener('click', () => {
    const all = pages.every((p) => p.selected);
    pages.forEach((p) => (p.selected = !all));
    render();
  });
  $('orgRotateSelBtn').addEventListener('click', () => {
    for (const p of pages) {
      if (!p.selected) continue;
      p.rotation = (p.rotation + 90) % 360;
      renderThumb(p);
    }
    render();
  });
  $('orgDeleteSelBtn').addEventListener('click', () => {
    pages = pages.filter((p) => !p.selected);
    render();
  });
  $('orgClearBtn').addEventListener('click', () => {
    pages = [];
    filenameInput.dataset.touched = '';
    render();
    setStatus('');
  });
  filenameInput.addEventListener('input', () => (filenameInput.dataset.touched = '1'));
  $('orgExportBtn').addEventListener('click', () => runExport('all'));
  $('orgExtractBtn').addEventListener('click', () => runExport('selected'));
  $('orgSplitBtn').addEventListener('click', () => runExport('split'));
  $('orgToEditorBtn').addEventListener('click', () => runExport('editor'));

  render();
  return { addFiles };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}
