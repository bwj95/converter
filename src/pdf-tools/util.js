/**
 * Shared helpers for the PDF Tools tab (main thread only).
 */

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function readFileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

export function downloadBytes(bytes, filename, mime = 'application/pdf') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function isPdfBytes(u8) {
  return u8.length > 4 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46;
}

export function ensurePdfName(name, fallback = 'document.pdf') {
  const clean = (name || '').trim() || fallback;
  return /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`;
}

/**
 * pdf-lib's standard fonts only speak WinAnsi. Map common typographic
 * characters down and replace anything else so drawText never throws.
 */
export function toWinAnsiSafe(str = '') {
  return String(str)
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '--')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '*')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');
}

export function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function friendlyPdfError(err) {
  const msg = err?.message || String(err);
  if (err?.name === 'PasswordException' || /encrypt|password/i.test(msg)) {
    return 'This PDF is password-protected or encrypted. Remove the password first, then try again.';
  }
  if (/Invalid PDF|No PDF header|InvalidPDFException/i.test(msg) || err?.name === 'InvalidPDFException') {
    return 'This file does not look like a valid PDF.';
  }
  return msg;
}

/** Read the EXIF orientation tag from a JPEG (1 = upright). */
export function jpegOrientation(u8) {
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return 1;
  let off = 2;
  while (off + 4 < u8.length) {
    if (u8[off] !== 0xff) return 1;
    const marker = u8[off + 1];
    const len = (u8[off + 2] << 8) | u8[off + 3];
    if (marker === 0xe1 && String.fromCharCode(...u8.subarray(off + 4, off + 8)) === 'Exif') {
      const tiff = off + 10;
      const little = u8[tiff] === 0x49;
      const r16 = (o) => (little ? u8[o] | (u8[o + 1] << 8) : (u8[o] << 8) | u8[o + 1]);
      const r32 = (o) =>
        (little
          ? u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)
          : (u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
      const ifd = tiff + r32(tiff + 4);
      const count = r16(ifd);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (r16(entry) === 0x0112) return r16(entry + 8);
      }
      return 1;
    }
    if (marker === 0xda) return 1; // start of scan: no EXIF before image data
    off += 2 + len;
  }
  return 1;
}

function canvasToBytes(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) return reject(new Error('Could not encode image.'));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      mime,
      quality
    );
  });
}

/**
 * Turn any browser-decodable image into PNG/JPEG bytes pdf-lib can embed,
 * with EXIF rotation baked in (pdf-lib embeds JPEGs raw, so a sideways phone
 * photo would stay sideways in the PDF otherwise).
 */
export async function normalizeImage(bytes, mimeHint = '') {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeHint || undefined }));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;

  if (isPng) return { bytes, mime: 'image/png', width: bitmap.width, height: bitmap.height, bitmap };
  if (isJpeg && jpegOrientation(bytes) === 1) {
    return { bytes, mime: 'image/jpeg', width: bitmap.width, height: bitmap.height, bitmap };
  }

  // Re-encode: rotated JPEGs stay JPEG, everything else (webp/gif/bmp) becomes PNG.
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const mime = isJpeg ? 'image/jpeg' : 'image/png';
  const out = await canvasToBytes(canvas, mime, 0.92);
  return { bytes: out, mime, width: bitmap.width, height: bitmap.height, bitmap };
}

/** Crop a canvas to the bounding box of its non-transparent pixels. */
export function trimCanvas(canvas, pad = 6) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // nothing drawn
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image.'));
    img.src = src;
  });
}
