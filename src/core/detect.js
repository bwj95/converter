/**
 * Detect ebook/document format using magic bytes first, falling back to extension.
 */

export function detectFormat(bytes, filename = '') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  // 1. PDF: "%PDF-"
  if (u8.length >= 5 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46 && u8[4] === 0x2d) {
    return 'pdf';
  }

  // 2. MOBI / PRC: PalmDB header has "BOOKMOBI" or "TEXtREAd" at offset 60
  if (u8.length >= 68) {
    const typeCreator = String.fromCharCode(...u8.slice(60, 68));
    if (typeCreator === 'BOOKMOBI' || typeCreator === 'TEXtREAd') {
      return 'mobi';
    }
  }

  // 3. ZIP-based (DOCX or EPUB): PK\x03\x04
  if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) {
    if (filename.toLowerCase().endsWith('.docx')) return 'docx';
    const zipText = new TextDecoder('ascii', { fatal: false }).decode(u8.slice(0, Math.min(u8.length, 4096)));
    if (zipText.includes('word/document.xml') || zipText.includes('[Content_Types].xml')) {
      return 'docx';
    }
    return 'epub';
  }

  // 4. Text-based sniffing (first 2KB)
  const headText = new TextDecoder('utf-8', { fatal: false }).decode(u8.slice(0, 2048)).trimStart();
  if (/<FictionBook[\s>]/i.test(headText)) {
    return 'fb2';
  }
  if (/^<!doctype\s+html/i.test(headText) || /^<html[\s>]/i.test(headText)) {
    return 'html';
  }

  // 5. Fallback to extension
  const lower = filename.toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.epub')) return 'epub';
  if (lower.endsWith('.mobi') || lower.endsWith('.prc') || lower.endsWith('.azw')) return 'mobi';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.fb2')) return 'fb2';
  if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.xhtml')) return 'html';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.txt')) return 'txt';

  return null;
}

export function stripExtension(filename = 'book') {
  return filename.replace(/\.[^.]+$/, '') || 'book';
}
