import { dataUrlToBytes, trimCanvas } from './util.js';

const STORAGE_KEY = 'converter-saved-signature';

/**
 * Signature Pad modal: Draw, Type (with vendored handwriting fonts), or Upload PNG/JPG.
 * Resolves with { dataUrl, bytes, width, height } or null if cancelled.
 */
export function createSignatureModal() {
  const dialog = document.getElementById('sigModal');
  const closeBtn = document.getElementById('sigCloseBtn');
  const cancelBtn = document.getElementById('sigCancelBtn');
  const applyBtn = document.getElementById('sigApplyBtn');
  const clearBtn = document.getElementById('sigClearBtn');
  const tabBtns = [...dialog.querySelectorAll('[data-sig-tab]')];
  const panels = [...dialog.querySelectorAll('[data-sig-panel]')];

  // Draw
  const drawCanvas = document.getElementById('sigDrawCanvas');
  const drawCtx = drawCanvas.getContext('2d');
  const colorInputs = [...dialog.querySelectorAll('input[name="sigColor"]')];

  // Type
  const typeInput = document.getElementById('sigTypeInput');
  const fontSelect = document.getElementById('sigFontSelect');
  const typePreview = document.getElementById('sigTypePreview');

  // Upload
  const uploadInput = document.getElementById('sigUploadInput');
  const uploadPreview = document.getElementById('sigUploadPreview');

  let activeTab = 'draw';
  let drawing = false;
  let hasDrawn = false;
  let lastPt = null;
  let uploadedData = null; // { dataUrl, width, height }
  let resolver = null;

  function getInkColor() {
    return colorInputs.find((i) => i.checked)?.value || '#111827';
  }

  function clearDraw() {
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    hasDrawn = false;
  }

  function getCanvasPoint(e) {
    const rect = drawCanvas.getBoundingClientRect();
    const scaleX = drawCanvas.width / rect.width;
    const scaleY = drawCanvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  drawCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drawCanvas.setPointerCapture(e.pointerId);
    drawing = true;
    hasDrawn = true;
    lastPt = getCanvasPoint(e);
    drawCtx.fillStyle = getInkColor();
    drawCtx.beginPath();
    drawCtx.arc(lastPt.x, lastPt.y, 1.8, 0, Math.PI * 2);
    drawCtx.fill();
  });

  drawCanvas.addEventListener('pointermove', (e) => {
    if (!drawing || !lastPt) return;
    const pt = getCanvasPoint(e);
    drawCtx.strokeStyle = getInkColor();
    drawCtx.lineWidth = 3.2;
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    drawCtx.beginPath();
    drawCtx.moveTo(lastPt.x, lastPt.y);
    drawCtx.lineTo(pt.x, pt.y);
    drawCtx.stroke();
    lastPt = pt;
  });

  const endDraw = () => {
    drawing = false;
    lastPt = null;
  };
  drawCanvas.addEventListener('pointerup', endDraw);
  drawCanvas.addEventListener('pointercancel', endDraw);

  clearBtn.addEventListener('click', () => {
    if (activeTab === 'draw') clearDraw();
    else if (activeTab === 'type') {
      typeInput.value = '';
      renderTypePreview();
    } else {
      uploadedData = null;
      uploadInput.value = '';
      uploadPreview.innerHTML = '<span>No image selected</span>';
    }
  });

  function setTab(tab) {
    activeTab = tab;
    tabBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.sigTab === tab));
    panels.forEach((p) => (p.hidden = p.dataset.sigPanel !== tab));
    if (tab === 'type') renderTypePreview();
  }

  tabBtns.forEach((b) => b.addEventListener('click', () => setTab(b.dataset.sigTab)));

  async function renderTypePreview() {
    const text = (typeInput.value || '').trim();
    const fontName = fontSelect.value;
    const color = getInkColor();
    try {
      await document.fonts.load(`48px "${fontName}"`);
    } catch {
      // Fallback if font load is pending
    }
    const ctx = typePreview.getContext('2d');
    ctx.clearRect(0, 0, typePreview.width, typePreview.height);
    if (!text) return;
    ctx.fillStyle = color;
    ctx.font = `56px "${fontName}", cursive`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, typePreview.width / 2, typePreview.height / 2);
  }

  typeInput.addEventListener('input', renderTypePreview);
  fontSelect.addEventListener('change', renderTypePreview);
  colorInputs.forEach((i) => i.addEventListener('change', () => {
    if (activeTab === 'type') renderTypePreview();
  }));

  uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        uploadedData = {
          dataUrl: reader.result,
          width: img.naturalWidth || 300,
          height: img.naturalHeight || 100,
        };
        uploadPreview.innerHTML = `<img src="${reader.result}" alt="Signature preview" />`;
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  function finish(result) {
    dialog.close();
    if (resolver) {
      const r = resolver;
      resolver = null;
      r(result);
    }
  }

  closeBtn.addEventListener('click', () => finish(null));
  cancelBtn.addEventListener('click', () => finish(null));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish(null);
  });

  applyBtn.addEventListener('click', () => {
    let result = null;
    if (activeTab === 'draw') {
      if (!hasDrawn) return finish(null);
      const trimmed = trimCanvas(drawCanvas, 8);
      if (!trimmed) return finish(null);
      const dataUrl = trimmed.toDataURL('image/png');
      result = { dataUrl, bytes: dataUrlToBytes(dataUrl), width: trimmed.width, height: trimmed.height };
    } else if (activeTab === 'type') {
      const trimmed = trimCanvas(typePreview, 8);
      if (!trimmed) return finish(null);
      const dataUrl = trimmed.toDataURL('image/png');
      result = { dataUrl, bytes: dataUrlToBytes(dataUrl), width: trimmed.width, height: trimmed.height };
    } else if (activeTab === 'upload' && uploadedData) {
      // Convert uploaded image to PNG via canvas so pdf-lib embedPng always works
      const img = uploadPreview.querySelector('img');
      if (!img) return finish(null);
      const c = document.createElement('canvas');
      c.width = uploadedData.width;
      c.height = uploadedData.height;
      c.getContext('2d').drawImage(img, 0, 0);
      const dataUrl = c.toDataURL('image/png');
      result = { dataUrl, bytes: dataUrlToBytes(dataUrl), width: c.width, height: c.height };
    }

    if (result) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
        }));
      } catch {
        // Ignore storage quota errors
      }
    }
    finish(result);
  });

  return {
    open() {
      setTab(activeTab);
      dialog.showModal();
      return new Promise((resolve) => {
        resolver = resolve;
      });
    },
    getSaved() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.dataUrl) return null;
        return {
          dataUrl: parsed.dataUrl,
          bytes: dataUrlToBytes(parsed.dataUrl),
          width: parsed.width,
          height: parsed.height,
        };
      } catch {
        return null;
      }
    },
  };
}
