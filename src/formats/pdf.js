import * as pdfjsLib from '../../vendor/pdf.min.mjs';
import { PDFDocument, StandardFonts, rgb } from '../../vendor/pdf-lib.mjs';
import { createBook, escapeXml, htmlToBlocks } from '../core/ir.js';
import { stripExtension } from '../core/detect.js';

// Configure PDF.js worker path relative to this module
try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).href;
} catch {
  // Fallback if import.meta.url is unavailable
}

const PAGE_SIZES = {
  trade: [432, 648],   // 6 x 9 in
  a4: [595.28, 841.89],
  letter: [612, 792],
  kindle: [360, 480],  // 5 x 6.67 in e-reader friendly
};

const MARGINS = {
  compact: 36,
  standard: 54,
  wide: 72,
};

/**
 * Sanitize Unicode text for PDF StandardFonts (WinAnsi encoding) so symbols like
 * em-dash, curly quotes, ellipsis, or bullets never throw encoding errors.
 */
function toWinAnsiSafe(str = '') {
  return String(str)
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '--')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '*')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

export async function parsePdf(bytes, filename = 'document.pdf', onProgress) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const inWorker = typeof window === 'undefined';

  const loadingTask = pdfjsLib.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableAutoFetch: true,
    // Avoid nested workers when running inside our conversion Web Worker
    ...(inWorker ? { worker: null } : {}),
  });

  const pdf = await loadingTask.promise;
  let title = stripExtension(filename);
  let author = 'Unknown Author';

  try {
    const meta = await pdf.getMetadata();
    if (meta?.info?.Title) title = String(meta.info.Title).trim() || title;
    if (meta?.info?.Author) author = String(meta.info.Author).trim() || author;
  } catch {
    // Metadata optional
  }

  const pageBlocks = [];
  const fontSizes = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    if (onProgress) onProgress(p / pdf.numPages, `Reading PDF page ${p}/${pdf.numPages}`);
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    // Group items into visual lines by Y coordinate
    const lines = [];
    let currentLine = null;

    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5]);
      const h = Math.round(Math.abs(item.transform[0]) || Math.abs(item.transform[3]) || 11);
      if (h > 0) fontSizes.push(h);

      if (!currentLine || Math.abs(currentLine.y - y) > 3) {
        if (currentLine) lines.push(currentLine);
        currentLine = { y, height: h, text: item.str };
      } else {
        const needsSpace =
          currentLine.text &&
          !currentLine.text.endsWith(' ') &&
          !item.str.startsWith(' ');
        currentLine.text += (needsSpace ? ' ' : '') + item.str;
        currentLine.height = Math.max(currentLine.height, h);
      }
    }
    if (currentLine) lines.push(currentLine);

    pageBlocks.push({ pageNum: p, lines });
  }

  // Estimate body font size (median)
  fontSizes.sort((a, b) => a - b);
  const bodySize = fontSizes.length ? fontSizes[Math.floor(fontSizes.length * 0.5)] : 11;

  // Reconstruct chapters & paragraphs
  const chapters = [];
  let curTitle = title;
  let curHtml = [];

  const flushChapter = () => {
    const html = curHtml.join('\n').trim();
    if (html) {
      chapters.push({
        id: `chapter-${chapters.length + 1}`,
        title: curTitle,
        html,
      });
    }
    curHtml = [];
  };

  for (const page of pageBlocks) {
    let paraBuf = [];
    const flushPara = () => {
      if (paraBuf.length) {
        curHtml.push(`<p>${escapeXml(paraBuf.join(' '))}</p>`);
        paraBuf = [];
      }
    };

    for (const line of page.lines) {
      const t = line.text.trim();
      if (!t) {
        flushPara();
        continue;
      }

      const isLargeHeading = line.height >= bodySize * 1.35 && t.length < 120;
      const isChapterLine = /^(?:chapter|part|section)\s+(?:\d+|[ivxlcdm]+)\b/i.test(t) && t.length < 100;

      if (isLargeHeading || isChapterLine) {
        flushPara();
        if (curHtml.length > 0 && (isChapterLine || line.height >= bodySize * 1.5)) {
          flushChapter();
          curTitle = t;
        }
        curHtml.push(`<h1>${escapeXml(t)}</h1>`);
      } else {
        paraBuf.push(t);
        if (/[.!?]["')\]]?$/.test(t) && t.length < 75) {
          flushPara();
        }
      }
    }
    flushPara();
  }
  flushChapter();

  if (chapters.length === 0) {
    chapters.push({ id: 'chapter-1', title, html: '<p>(No extractable text found in PDF.)</p>' });
  }

  return createBook({
    metadata: { title, author },
    chapters,
  });
}

function wrapText(text, font, size, maxWidth) {
  const safe = toWinAnsiSafe(text);
  const words = safe.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let current = words[0];

  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

export async function generatePdf(book, options = {}, onProgress) {
  const pageDims = PAGE_SIZES[options.pageSize || 'trade'] || PAGE_SIZES.trade;
  const margin = MARGINS[options.marginPreset || 'standard'] || MARGINS.standard;
  const baseSize = Number(options.fontSize) || 11;
  const showPageNumbers = options.showPageNumbers !== false;
  const family = options.fontFamily || 'serif';

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(toWinAnsiSafe(book.metadata.title || 'Untitled Book'));
  pdfDoc.setAuthor(toWinAnsiSafe(book.metadata.author || 'Unknown Author'));
  pdfDoc.setCreator('Converter (Browser Ebook Tool)');

  let regularFont;
  let boldFont;
  if (family === 'sans') {
    regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  } else if (family === 'mono') {
    regularFont = await pdfDoc.embedFont(StandardFonts.Courier);
    boldFont = await pdfDoc.embedFont(StandardFonts.CourierBold);
  } else {
    regularFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    boldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  }

  const [pageW, pageH] = pageDims;
  const contentW = pageW - margin * 2;
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.42, 0.42, 0.46);

  // Title page
  const titlePage = pdfDoc.addPage([pageW, pageH]);
  const titleLines = wrapText(book.metadata.title || 'Untitled Book', boldFont, baseSize * 2, contentW);
  let ty = pageH * 0.62;
  for (const line of titleLines) {
    const w = boldFont.widthOfTextAtSize(line, baseSize * 2);
    titlePage.drawText(line, {
      x: Math.max(margin, (pageW - w) / 2),
      y: ty,
      size: baseSize * 2,
      font: boldFont,
      color: ink,
    });
    ty -= baseSize * 2.5;
  }
  const authorText = toWinAnsiSafe(book.metadata.author || '');
  if (authorText && authorText !== 'Unknown Author') {
    const aw = regularFont.widthOfTextAtSize(authorText, baseSize * 1.15);
    titlePage.drawText(authorText, {
      x: Math.max(margin, (pageW - aw) / 2),
      y: ty - 14,
      size: baseSize * 1.15,
      font: regularFont,
      color: muted,
    });
  }

  let page = null;
  let y = 0;

  const newPage = () => {
    page = pdfDoc.addPage([pageW, pageH]);
    y = pageH - margin;
  };

  const ensureSpace = (needed) => {
    if (!page || y - needed < margin + 12) {
      newPage();
    }
  };

  const totalChapters = book.chapters.length || 1;
  for (let ci = 0; ci < book.chapters.length; ci++) {
    const ch = book.chapters[ci];
    if (onProgress) onProgress((ci + 1) / totalChapters, `Rendering chapter ${ci + 1}/${totalChapters}`);

    newPage();
    const blocks = htmlToBlocks(ch.html);
    const hasHeading = blocks.some((b) => b.type === 'h1' || b.type === 'h2');

    if (!hasHeading && ch.title) {
      blocks.unshift({ type: 'h1', level: 1, text: ch.title });
    }

    for (const block of blocks) {
      if (block.type === 'hr') {
        ensureSpace(20);
        y -= 10;
        page.drawLine({
          start: { x: margin + contentW * 0.3, y },
          end: { x: margin + contentW * 0.7, y },
          thickness: 0.75,
          color: muted,
        });
        y -= 14;
        continue;
      }

      const isHeading = block.type.startsWith('h');
      const size = isHeading
        ? block.level === 1
          ? baseSize * 1.55
          : baseSize * 1.25
        : block.type === 'code'
          ? Math.max(8.5, baseSize - 1.5)
          : baseSize;
      const lineHeight = size * 1.42;
      const font = isHeading ? boldFont : regularFont;
      const indent = block.type === 'quote' || block.type === 'li' ? 16 : 0;
      const text = block.type === 'li' ? `* ${block.text}` : block.text;

      if (isHeading) y -= 6;
      const lines = wrapText(text, font, size, contentW - indent);
      for (const line of lines) {
        ensureSpace(lineHeight);
        page.drawText(line, {
          x: margin + indent,
          y,
          size,
          font,
          color: block.type === 'quote' ? muted : ink,
        });
        y -= lineHeight;
      }
      y -= isHeading ? 8 : 6;
    }
  }

  // Page numbers (skip title page)
  if (showPageNumbers) {
    const pages = pdfDoc.getPages();
    for (let i = 1; i < pages.length; i++) {
      const p = pages[i];
      const label = String(i);
      const w = regularFont.widthOfTextAtSize(label, 9);
      p.drawText(label, {
        x: (pageW - w) / 2,
        y: Math.max(18, margin * 0.48),
        size: 9,
        font: regularFont,
        color: muted,
      });
    }
  }

  return await pdfDoc.save();
}
