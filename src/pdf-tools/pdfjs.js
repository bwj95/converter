import * as pdfjsLib from '../../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).href;

export { pdfjsLib };

/**
 * Open a PDF for rendering. pdf.js transfers (detaches) the buffer it is
 * given to its worker, so always hand it a copy and keep the original for pdf-lib.
 */
export function openPdf(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}

/**
 * Render a page into a *fresh* canvas (pdf.js refuses concurrent renders on
 * one canvas, so swapping in a new element sidesteps cancel bookkeeping).
 */
export async function renderPageCanvas(page, { scale, rotation } = {}) {
  const viewport = page.getViewport({ scale, rotation: rotation ?? page.rotate });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, viewport };
}
