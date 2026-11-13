import { PDFDocument, StandardFonts, PDFTextField, PDFCheckBox, degrees, rgb } from '../../vendor/pdf-lib.mjs';
import { openPdf, renderPageCanvas } from './pdfjs.js';
import { createSignatureModal } from './signature-modal.js';
import {
  downloadBytes,
  ensurePdfName,
  friendlyPdfError,
  isPdfBytes,
  readFileBytes,
  toWinAnsiSafe,
  uid,
} from './util.js';

const $ = (id) => document.getElementById(id);

function hexToRgb(hex = '#111827') {
  const clean = hex.replace('#', '');
  const num = parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16) || 0;
  return rgb(((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255);
}

export function createAnnotator() {
  const drop = $('edDrop');
  const fileInput = $('edFileInput');
  const work = $('edWork');
  const stage = $('edStage');
  const statusEl = $('edStatus');
  const filenameInput = $('edFilename');
  const zoomSelect = $('edZoom');
  const toolBtns = [...document.querySelectorAll('[data-ed-tool]')];
  const colorInput = $('edColor');
  const fontSizeSelect = $('edFontSize');
  const fontFamilySelect = $('edFontFamily');
  const undoBtn = $('edUndoBtn');
  const clearAnnBtn = $('edClearAnnBtn');
  const exportBtn = $('edExportBtn');
  const formsBar = $('edFormsBar');
  const formsList = $('edFormsList');
  const flattenFormsCheck = $('edFlattenForms');
  const sigPreviewChip = $('edSigChip');
  const newSigBtn = $('edNewSigBtn');

  const sigModal = createSignatureModal();

  let pdfBytes = null;
  let pdfJsDoc = null;
  let activeTool = 'select'; // select | text | date | check | sign | whiteout | highlight
  let activeSignature = sigModal.getSaved();
  let annotations = [];
  let undoStack = [];
  let selectedId = null;
  let formFields = []; // { name, type: 'text'|'checkbox', value }
  let busy = false;

  function setStatus(msg, kind = '') {
    statusEl.textContent = msg || '';
    statusEl.className = `pdf-status ${kind ? `is-${kind}` : ''}`;
  }

  function updateSigChip() {
    if (activeSignature?.dataUrl) {
      sigPreviewChip.innerHTML = `<img src="${activeSignature.dataUrl}" alt="Current signature" />`;
      sigPreviewChip.hidden = false;
    } else {
      sigPreviewChip.hidden = true;
    }
  }

  function pushUndo() {
    undoStack.push(JSON.stringify(annotations));
    if (undoStack.length > 40) undoStack.shift();
    undoBtn.disabled = undoStack.length === 0;
  }

  function setTool(tool) {
    activeTool = tool;
    toolBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.edTool === tool));
    stage.dataset.tool = tool;
    if (tool !== 'select') {
      selectedId = null;
      syncSelectionUI();
    }
  }

  async function loadPdf(bytes, name = 'document.pdf') {
    if (!isPdfBytes(bytes)) {
      setStatus('Not a valid PDF file.', 'err');
      return;
    }
    setStatus('Loading PDF…');
    try {
      const doc = await openPdf(bytes);
      const libDoc = await PDFDocument.load(bytes);

      pdfBytes = bytes;
      pdfJsDoc?.destroy();
      pdfJsDoc = doc;
      annotations = [];
      undoStack = [];
      selectedId = null;
      undoBtn.disabled = true;

      filenameInput.value = name.replace(/\.pdf$/i, '') + '-signed.pdf';

      // Inspect AcroForm fields
      formFields = [];
      try {
        const form = libDoc.getForm();
        for (const f of form.getFields()) {
          if (f instanceof PDFTextField) {
            formFields.push({ name: f.getName(), type: 'text', value: f.getText() || '' });
          } else if (f instanceof PDFCheckBox) {
            formFields.push({ name: f.getName(), type: 'checkbox', value: f.isChecked() });
          }
        }
      } catch {
        // No form or unsupported form dictionary
      }

      renderFormsBar();
      work.hidden = false;
      drop.classList.add('dropzone--compact');
      await renderAllPages();
      setStatus(`Loaded ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}. Click any tool above, then click a page.`, 'ok');
    } catch (err) {
      console.error(err);
      setStatus(friendlyPdfError(err), 'err');
    }
  }

  function renderFormsBar() {
    if (!formFields.length) {
      formsBar.hidden = true;
      formsList.innerHTML = '';
      return;
    }
    formsBar.hidden = false;
    formsList.innerHTML = '';
    formFields.forEach((ff) => {
      const wrap = document.createElement('label');
      wrap.className = ff.type === 'checkbox' ? 'field field--checkbox' : 'field';
      if (ff.type === 'checkbox') {
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = Boolean(ff.value);
        inp.addEventListener('change', () => (ff.value = inp.checked));
        const span = document.createElement('span');
        span.textContent = ff.name;
        wrap.append(inp, span);
      } else {
        const span = document.createElement('span');
        span.textContent = ff.name;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'input';
        inp.value = ff.value;
        inp.addEventListener('input', () => (ff.value = inp.value));
        wrap.append(span, inp);
      }
      formsList.appendChild(wrap);
    });
  }

  async function renderAllPages() {
    if (!pdfJsDoc) return;
    stage.innerHTML = '';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const zoomVal = zoomSelect.value;

    for (let p = 1; p <= pdfJsDoc.numPages; p++) {
      const page = await pdfJsDoc.getPage(p);
      const baseVp = page.getViewport({ scale: 1 });
      const stageW = Math.max(320, stage.clientWidth - 32);
      const cssScale = zoomVal === 'fit' ? Math.min(1.4, stageW / baseVp.width) : Number(zoomVal);
      const cssW = Math.round(baseVp.width * cssScale);
      const cssH = Math.round(baseVp.height * cssScale);

      const wrap = document.createElement('div');
      wrap.className = 'ed-page-wrap';
      wrap.dataset.page = String(p);
      wrap.style.width = `${cssW}px`;
      wrap.style.height = `${cssH}px`;

      const { canvas } = await renderPageCanvas(page, { scale: cssScale * dpr });
      canvas.className = 'ed-page-canvas';
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;

      const overlay = document.createElement('div');
      overlay.className = 'ed-overlay';
      overlay.dataset.page = String(p);

      const badge = document.createElement('span');
      badge.className = 'ed-page-badge';
      badge.textContent = `Page ${p} / ${pdfJsDoc.numPages}`;

      overlay.addEventListener('click', (e) => onOverlayClick(e, p, overlay));

      wrap.append(canvas, overlay, badge);
      stage.appendChild(wrap);
      renderAnnotationsOnPage(p, overlay);
    }
  }

  async function onOverlayClick(e, pageNum, overlay) {
    if (e.target !== overlay) return;
    if (activeTool === 'select') {
      selectedId = null;
      syncSelectionUI();
      return;
    }

    const rect = overlay.getBoundingClientRect();
    const nx = Math.max(0, Math.min(0.9, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(0.92, (e.clientY - rect.top) / rect.height));

    if (activeTool === 'sign') {
      if (!activeSignature) {
        const res = await sigModal.open();
        if (!res) return;
        activeSignature = res;
        updateSigChip();
      }
      pushUndo();
      const aspect = activeSignature.height / Math.max(1, activeSignature.width);
      const nw = 0.24;
      const nh = Math.min(0.25, Math.max(0.04, (nw * rect.width * aspect) / rect.height));
      const ann = {
        id: uid(),
        page: pageNum,
        type: 'sign',
        nx: Math.min(nx, 1 - nw),
        ny: Math.min(ny, 1 - nh),
        nw,
        nh,
        dataUrl: activeSignature.dataUrl,
      };
      annotations.push(ann);
      selectedId = ann.id;
      setTool('select');
      renderAnnotationsOnPage(pageNum, overlay);
      return;
    }

    pushUndo();
    let ann;
    if (activeTool === 'text') {
      ann = {
        id: uid(),
        page: pageNum,
        type: 'text',
        nx,
        ny,
        nw: 0.26,
        nh: 0.045,
        text: 'Type here',
        color: colorInput.value,
        fontSize: Number(fontSizeSelect.value),
        fontFamily: fontFamilySelect.value,
      };
    } else if (activeTool === 'date') {
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      ann = {
        id: uid(),
        page: pageNum,
        type: 'text',
        nx,
        ny,
        nw: 0.18,
        nh: 0.04,
        text: today,
        color: colorInput.value,
        fontSize: Number(fontSizeSelect.value),
        fontFamily: fontFamilySelect.value,
      };
    } else if (activeTool === 'check') {
      ann = {
        id: uid(),
        page: pageNum,
        type: 'check',
        nx,
        ny,
        nw: 0.035,
        nh: 0.035,
        color: colorInput.value,
      };
    } else if (activeTool === 'whiteout') {
      ann = {
        id: uid(),
        page: pageNum,
        type: 'whiteout',
        nx,
        ny,
        nw: 0.22,
        nh: 0.04,
      };
    } else if (activeTool === 'highlight') {
      ann = {
        id: uid(),
        page: pageNum,
        type: 'highlight',
        nx,
        ny,
        nw: 0.26,
        nh: 0.03,
      };
    }

    if (ann) {
      annotations.push(ann);
      selectedId = ann.id;
      setTool('select');
      renderAnnotationsOnPage(pageNum, overlay);
      if (ann.type === 'text') {
        const el = overlay.querySelector(`[data-ann-id="${ann.id}"] .ed-ann__text`);
        if (el) {
          el.focus();
          document.execCommand('selectAll', false, null);
        }
      }
    }
  }

  function renderAnnotationsOnPage(pageNum, overlay) {
    overlay.innerHTML = '';
    const pageW = overlay.clientWidth || 600;
    const pageH = overlay.clientHeight || 800;

    for (const ann of annotations.filter((a) => a.page === pageNum)) {
      const el = document.createElement('div');
      el.className = `ed-ann ed-ann--${ann.type} ${ann.id === selectedId ? 'is-selected' : ''}`;
      el.dataset.annId = ann.id;
      el.style.left = `${ann.nx * 100}%`;
      el.style.top = `${ann.ny * 100}%`;
      el.style.width = `${ann.nw * 100}%`;
      el.style.height = `${ann.nh * 100}%`;

      if (ann.type === 'sign') {
        const img = document.createElement('img');
        img.src = ann.dataUrl;
        img.alt = 'Signature';
        img.draggable = false;
        el.appendChild(img);
      } else if (ann.type === 'text') {
        const span = document.createElement('div');
        span.className = 'ed-ann__text';
        span.contentEditable = 'true';
        span.spellcheck = false;
        span.textContent = ann.text;
        span.style.color = ann.color;
        span.style.fontSize = `${Math.max(9, Math.round((ann.fontSize / 612) * pageW * 1.15))}px`;
        span.style.fontFamily =
          ann.fontFamily === 'serif'
            ? 'Georgia, serif'
            : ann.fontFamily === 'mono'
              ? 'monospace'
              : 'Helvetica, Arial, sans-serif';
        span.addEventListener('input', () => {
          ann.text = span.innerText.replace(/\n$/, '');
        });
        span.addEventListener('pointerdown', (e) => {
          if (selectedId === ann.id) e.stopPropagation();
        });
        el.appendChild(span);
      } else if (ann.type === 'check') {
        el.style.color = ann.color;
        el.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      }

      // Delete button & resize handle
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ed-ann__del';
      del.textContent = '✕';
      del.title = 'Delete';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndo();
        annotations = annotations.filter((a) => a.id !== ann.id);
        if (selectedId === ann.id) selectedId = null;
        renderAnnotationsOnPage(pageNum, overlay);
      });

      const handle = document.createElement('div');
      handle.className = 'ed-ann__resize';
      handle.title = 'Drag to resize';

      el.append(del, handle);

      // Drag move
      el.addEventListener('pointerdown', (e) => {
        if (e.target === del || e.target === handle) return;
        e.stopPropagation();
        selectedId = ann.id;
        syncSelectionUI();

        const startX = e.clientX;
        const startY = e.clientY;
        const origNx = ann.nx;
        const origNy = ann.ny;
        let moved = false;

        const onMove = (ev) => {
          const dx = (ev.clientX - startX) / pageW;
          const dy = (ev.clientY - startY) / pageH;
          if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) {
            pushUndo();
            moved = true;
          }
          if (moved) {
            ann.nx = Math.max(0, Math.min(1 - ann.nw, origNx + dx));
            ann.ny = Math.max(0, Math.min(1 - ann.nh, origNy + dy));
            el.style.left = `${ann.nx * 100}%`;
            el.style.top = `${ann.ny * 100}%`;
          }
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });

      // Drag resize
      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        pushUndo();
        const startX = e.clientX;
        const startY = e.clientY;
        const origW = ann.nw;
        const origH = ann.nh;
        const lockRatio = ann.type === 'sign' || ann.type === 'check';

        const onMove = (ev) => {
          const dx = (ev.clientX - startX) / pageW;
          const dy = (ev.clientY - startY) / pageH;
          ann.nw = Math.max(0.025, Math.min(1 - ann.nx, origW + dx));
          if (lockRatio) {
            ann.nh = Math.max(0.02, Math.min(1 - ann.ny, origH * (ann.nw / origW)));
          } else {
            ann.nh = Math.max(0.02, Math.min(1 - ann.ny, origH + dy));
          }
          el.style.width = `${ann.nw * 100}%`;
          el.style.height = `${ann.nh * 100}%`;
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });

      overlay.appendChild(el);
    }
  }

  function syncSelectionUI() {
    stage.querySelectorAll('.ed-ann').forEach((el) => {
      el.classList.toggle('is-selected', el.dataset.annId === selectedId);
    });
  }

  async function exportPdf() {
    if (!pdfBytes || busy) return;
    busy = true;
    exportBtn.disabled = true;
    setStatus('Applying edits & signatures…');

    try {
      const doc = await PDFDocument.load(pdfBytes);

      // Apply AcroForm values
      if (formFields.length) {
        const form = doc.getForm();
        for (const ff of formFields) {
          try {
            if (ff.type === 'text') form.getTextField(ff.name).setText(toWinAnsiSafe(ff.value));
            else if (ff.type === 'checkbox') {
              const cb = form.getCheckBox(ff.name);
              if (ff.value) cb.check();
              else cb.uncheck();
            }
          } catch {
            // Skip read-only/problematic field
          }
        }
        if (flattenFormsCheck.checked) {
          try {
            form.flatten();
          } catch {
            // Ignore flatten errors on exotic forms
          }
        }
      }

      const fonts = {
        sans: await doc.embedFont(StandardFonts.Helvetica),
        serif: await doc.embedFont(StandardFonts.TimesRoman),
        mono: await doc.embedFont(StandardFonts.Courier),
      };
      const pngCache = new Map();
      const pages = doc.getPages();

      for (const ann of annotations) {
        const page = pages[ann.page - 1];
        if (!page) continue;
        const { width: W, height: H } = page.getSize();
        const rot = ((page.getRotation().angle || 0) % 360 + 360) % 360;

        // Viewer dimensions vs unrotated PDF page dimensions
        const vw = rot === 90 || rot === 270 ? H : W;
        const vh = rot === 90 || rot === 270 ? W : H;
        const vx = ann.nx * vw;
        const vy = ann.ny * vh;
        const boxW = ann.nw * vw;
        const boxH = ann.nh * vh;

        // Map viewer top-left + bottom-left anchor to unrotated PDF coords
        const mapBox = () => {
          if (rot === 90) return { x: vy + boxH, y: vx, angle: 90 };
          if (rot === 180) return { x: W - vx, y: vy + boxH, angle: 180 };
          if (rot === 270) return { x: W - (vy + boxH), y: H - vx, angle: 270 };
          return { x: vx, y: H - (vy + boxH), angle: 0 };
        };
        const pos = mapBox();

        if (ann.type === 'whiteout') {
          page.drawRectangle({
            x: pos.x,
            y: pos.y,
            width: boxW,
            height: boxH,
            color: rgb(1, 1, 1),
            rotate: degrees(pos.angle),
          });
        } else if (ann.type === 'highlight') {
          page.drawRectangle({
            x: pos.x,
            y: pos.y,
            width: boxW,
            height: boxH,
            color: rgb(1, 0.92, 0.23),
            opacity: 0.42,
            rotate: degrees(pos.angle),
          });
        } else if (ann.type === 'sign') {
          let img = pngCache.get(ann.dataUrl);
          if (!img) {
            const b64 = ann.dataUrl.slice(ann.dataUrl.indexOf(',') + 1);
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            img = await doc.embedPng(bytes);
            pngCache.set(ann.dataUrl, img);
          }
          page.drawImage(img, {
            x: pos.x,
            y: pos.y,
            width: boxW,
            height: boxH,
            rotate: degrees(pos.angle),
          });
        } else if (ann.type === 'check') {
          const c = hexToRgb(ann.color);
          const s = Math.min(boxW, boxH);
          const ox = pos.x;
          const oy = pos.y;
          page.drawLine({
            start: { x: ox + s * 0.16, y: oy + s * 0.5 },
            end: { x: ox + s * 0.42, y: oy + s * 0.22 },
            thickness: Math.max(1.5, s * 0.12),
            color: c,
          });
          page.drawLine({
            start: { x: ox + s * 0.42, y: oy + s * 0.22 },
            end: { x: ox + s * 0.85, y: oy + s * 0.78 },
            thickness: Math.max(1.5, s * 0.12),
            color: c,
          });
        } else if (ann.type === 'text') {
          const font = fonts[ann.fontFamily] || fonts.sans;
          const size = ann.fontSize || 12;
          const lines = toWinAnsiSafe(ann.text).split('\n');
          const topY = rot === 0 ? H - vy - size : pos.y + boxH - size;
          lines.forEach((line, i) => {
            page.drawText(line, {
              x: pos.x + 2,
              y: topY - i * (size * 1.25),
              size,
              font,
              color: hexToRgb(ann.color),
              rotate: degrees(pos.angle),
            });
          });
        }
      }

      const outBytes = await doc.save();
      const outName = ensurePdfName(filenameInput.value, 'signed.pdf');
      downloadBytes(outBytes, outName);
      setStatus(`Saved ${outName} (${(outBytes.length / 1024).toFixed(1)} KB)`, 'ok');
    } catch (err) {
      console.error(err);
      setStatus(friendlyPdfError(err), 'err');
    } finally {
      busy = false;
      exportBtn.disabled = false;
    }
  }

  // Wiring
  const openPicker = () => fileInput.click();
  drop.addEventListener('click', openPicker);
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });
  $('edBrowseBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openPicker();
  });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (f) await loadPdf(await readFileBytes(f), f.name);
    fileInput.value = '';
  });

  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-dragover');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-dragover'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('is-dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f) await loadPdf(await readFileBytes(f), f.name);
  });

  toolBtns.forEach((btn) =>
    btn.addEventListener('click', async () => {
      const tool = btn.dataset.edTool;
      if (tool === 'sign' && !activeSignature) {
        const res = await sigModal.open();
        if (!res) return;
        activeSignature = res;
        updateSigChip();
      }
      setTool(tool);
    })
  );

  newSigBtn.addEventListener('click', async () => {
    const res = await sigModal.open();
    if (res) {
      activeSignature = res;
      updateSigChip();
      setTool('sign');
    }
  });

  zoomSelect.addEventListener('change', () => renderAllPages());

  undoBtn.addEventListener('click', () => {
    if (!undoStack.length) return;
    annotations = JSON.parse(undoStack.pop());
    undoBtn.disabled = undoStack.length === 0;
    selectedId = null;
    stage.querySelectorAll('.ed-overlay').forEach((ov) => {
      renderAnnotationsOnPage(Number(ov.dataset.page), ov);
    });
  });

  clearAnnBtn.addEventListener('click', () => {
    if (!annotations.length) return;
    pushUndo();
    annotations = [];
    selectedId = null;
    stage.querySelectorAll('.ed-overlay').forEach((ov) => {
      renderAnnotationsOnPage(Number(ov.dataset.page), ov);
    });
  });

  exportBtn.addEventListener('click', exportPdf);

  window.addEventListener('keydown', (e) => {
    if (work.hidden) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      if (document.activeElement?.isContentEditable || document.activeElement?.tagName === 'INPUT') return;
      e.preventDefault();
      pushUndo();
      const target = annotations.find((a) => a.id === selectedId);
      annotations = annotations.filter((a) => a.id !== selectedId);
      selectedId = null;
      if (target) {
        const ov = stage.querySelector(`.ed-overlay[data-page="${target.page}"]`);
        if (ov) renderAnnotationsOnPage(target.page, ov);
      }
    }
  });

  updateSigChip();
  return { loadPdf };
}
