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

function hexToPdfColor(hex) {
  if (!hex) return null;
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return null;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
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

/**
 * Wrap styled inline runs into visual lines while preserving per-word
 * bold/italic/underline/color.
 */
function wrapRichRuns(runs, fontSet, size, maxWidth, forceBold = false) {
  const tokens = [];
  for (const r of runs) {
    const bold = forceBold || Boolean(r.bold);
    const italic = Boolean(r.italic);
    const font = bold && italic
      ? fontSet.boldItalic
      : bold
        ? fontSet.bold
        : italic
          ? fontSet.italic
          : fontSet.regular;
    const color = hexToPdfColor(r.color);
    const safe = toWinAnsiSafe(r.text || '');
    const parts = safe.split(/(\n|\s+)/);
    for (const p of parts) {
      if (!p) continue;
      if (p === '\n') {
        tokens.push({ newline: true });
      } else {
        tokens.push({ text: p, isSpace: /^\s+$/.test(p), font, color, underline: Boolean(r.underline) });
      }
    }
  }

  const lines = [];
  let current = [];
  let currentW = 0;

  const pushLine = () => {
    while (current.length && current[current.length - 1].isSpace) current.pop();
    lines.push(current);
    current = [];
    currentW = 0;
  };

  for (const tok of tokens) {
    if (tok.newline) {
      pushLine();
      continue;
    }
    if (tok.isSpace && current.length === 0) continue;
    const w = tok.font.widthOfTextAtSize(tok.text, size);
    if (current.length > 0 && !tok.isSpace && currentW + w > maxWidth) {
      pushLine();
    }
    if (tok.isSpace && current.length === 0) continue;
    current.push({ ...tok, width: w });
    currentW += w;
  }
  if (current.length > 0 || lines.length === 0) pushLine();
  return lines;
}

export async function generatePdf(book, options = {}, onProgress) {
  const pageDims = PAGE_SIZES[options.pageSize || 'trade'] || PAGE_SIZES.trade;
  const margin = MARGINS[options.marginPreset || 'standard'] || MARGINS.standard;
  const baseSize = Number(options.fontSize) || 11;
  const showPageNumbers = options.showPageNumbers !== false;
  const family = options.fontFamily || 'serif';
  const isDoc = Boolean(book.metadata.isDocument);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(toWinAnsiSafe(book.metadata.title || 'Untitled Book'));
  pdfDoc.setAuthor(toWinAnsiSafe(book.metadata.author || 'Unknown Author'));
  pdfDoc.setCreator('Converter (Browser Ebook Tool)');

  let fontSet;
  if (family === 'sans') {
    fontSet = {
      regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
      bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
      italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
      boldItalic: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique),
    };
  } else if (family === 'mono') {
    fontSet = {
      regular: await pdfDoc.embedFont(StandardFonts.Courier),
      bold: await pdfDoc.embedFont(StandardFonts.CourierBold),
      italic: await pdfDoc.embedFont(StandardFonts.CourierOblique),
      boldItalic: await pdfDoc.embedFont(StandardFonts.CourierBoldOblique),
    };
  } else {
    fontSet = {
      regular: await pdfDoc.embedFont(StandardFonts.TimesRoman),
      bold: await pdfDoc.embedFont(StandardFonts.TimesRomanBold),
      italic: await pdfDoc.embedFont(StandardFonts.TimesRomanItalic),
      boldItalic: await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic),
    };
  }

  const [pageW, pageH] = pageDims;
  const contentW = pageW - margin * 2;
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.42, 0.42, 0.46);
  const borderCol = rgb(0.75, 0.75, 0.78);

  // Only add a dedicated ebook cover/title page for multi-chapter books, not Word/single docs
  if (!isDoc) {
    const titlePage = pdfDoc.addPage([pageW, pageH]);
    const titleLines = wrapText(book.metadata.title || 'Untitled Book', fontSet.bold, baseSize * 2, contentW);
    let ty = pageH * 0.62;
    for (const line of titleLines) {
      const w = fontSet.bold.widthOfTextAtSize(line, baseSize * 2);
      titlePage.drawText(line, {
        x: Math.max(margin, (pageW - w) / 2),
        y: ty,
        size: baseSize * 2,
        font: fontSet.bold,
        color: ink,
      });
      ty -= baseSize * 2.5;
    }
    const authorText = toWinAnsiSafe(book.metadata.author || '');
    if (authorText && authorText !== 'Unknown Author') {
      const aw = fontSet.regular.widthOfTextAtSize(authorText, baseSize * 1.15);
      titlePage.drawText(authorText, {
        x: Math.max(margin, (pageW - aw) / 2),
        y: ty - 14,
        size: baseSize * 1.15,
        font: fontSet.regular,
        color: muted,
      });
    }
  }

  // Pre-build image lookup map
  const imageMap = new Map();
  for (const img of book.images || []) {
    imageMap.set(img.href, img);
    const base = (img.href || '').split('/').pop();
    if (base) imageMap.set(base, img);
  }
  const embeddedImages = new Map();

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

    if (!page || !isDoc) newPage();
    const blocks = htmlToBlocks(ch.html);
    const hasHeading = blocks.some((b) => b.type === 'h1' || b.type === 'h2');

    if (!isDoc && !hasHeading && ch.title) {
      blocks.unshift({ type: 'h1', level: 1, text: ch.title, runs: [{ text: ch.title, bold: true }] });
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

      if (block.type === 'img') {
        const cleanSrc = (block.src || '').split('#')[0].split('?')[0];
        const asset = imageMap.get(cleanSrc) || imageMap.get(cleanSrc.split('/').pop());
        if (!asset) continue;
        try {
          let pdfImg = embeddedImages.get(asset.href);
          if (!pdfImg) {
            const bytes = asset.data instanceof Uint8Array ? asset.data : new Uint8Array(asset.data);
            const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
            pdfImg = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
            embeddedImages.set(asset.href, pdfImg);
          }
          const maxH = pageH - margin * 2 - 20;
          const scale = Math.min(1, contentW / pdfImg.width, maxH / pdfImg.height);
          const w = pdfImg.width * scale;
          const h = pdfImg.height * scale;
          ensureSpace(h + 8);
          const x = block.align === 'center' ? margin + (contentW - w) / 2 : margin;
          page.drawImage(pdfImg, { x, y: y - h, width: w, height: h });
          y -= h + 10;
        } catch {
          // Skip unsupported image encoding (e.g. WebP/EMF inside DOCX)
        }
        continue;
      }

      if (block.type === 'table' && block.rows?.length) {
        const cols = Math.max(...block.rows.map((r) => r.length));
        const colW = contentW / Math.max(1, cols);
        const cellSize = Math.max(8.5, baseSize - 1);
        const cellLH = cellSize * 1.35;
        const pad = 5;

        for (const row of block.rows) {
          const wrappedCells = row.map((cell) => wrapText(cell, fontSet.regular, cellSize, colW - pad * 2));
          const maxLines = Math.max(1, ...wrappedCells.map((l) => l.length));
          const rowH = maxLines * cellLH + pad * 2;
          ensureSpace(rowH + 4);

          for (let c = 0; c < cols; c++) {
            const cx = margin + c * colW;
            page.drawRectangle({
              x: cx,
              y: y - rowH,
              width: colW,
              height: rowH,
              borderColor: borderCol,
              borderWidth: 0.6,
            });
            const lines = wrappedCells[c] || [''];
            lines.forEach((line, li) => {
              page.drawText(line, {
                x: cx + pad,
                y: y - pad - cellSize - li * cellLH,
                size: cellSize,
                font: fontSet.regular,
                color: ink,
              });
            });
          }
          y -= rowH;
        }
        y -= 10;
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
      const indent = block.type === 'quote' || block.type === 'li' ? 16 : 0;

      if (isHeading) y -= 6;
      const runs = block.runs?.length
        ? (block.type === 'li' ? [{ text: '* ', bold: false }, ...block.runs] : block.runs)
        : [{ text: block.type === 'li' ? `* ${block.text}` : block.text }];

      const lines = wrapRichRuns(runs, fontSet, size, contentW - indent, isHeading);
      const defaultCol = block.type === 'quote' ? muted : ink;

      for (const segs of lines) {
        ensureSpace(lineHeight);
        const lineW = segs.reduce((s, seg) => s + seg.width, 0);
        let x = margin + indent;
        if (block.align === 'center') x = margin + Math.max(0, (contentW - lineW) / 2);
        else if (block.align === 'right') x = margin + Math.max(0, contentW - lineW);

        for (const seg of segs) {
          const col = seg.color || defaultCol;
          page.drawText(seg.text, { x, y, size, font: seg.font, color: col });
          if (seg.underline && !seg.isSpace) {
            page.drawLine({
              start: { x, y: y - 1.5 },
              end: { x: x + seg.width, y: y - 1.5 },
              thickness: 0.6,
              color: col,
            });
          }
          x += seg.width;
        }
        y -= lineHeight;
      }
      y -= isHeading ? 8 : 6;
    }
  }

  // Page numbers (skip ebook cover page, or start at 1 for documents)
  if (showPageNumbers) {
    const pages = pdfDoc.getPages();
    const startIdx = isDoc ? 0 : 1;
    for (let i = startIdx; i < pages.length; i++) {
      const p = pages[i];
      const label = String(isDoc ? i + 1 : i);
      const w = fontSet.regular.widthOfTextAtSize(label, 9);
      p.drawText(label, {
        x: (pageW - w) / 2,
        y: Math.max(18, margin * 0.48),
        size: 9,
        font: fontSet.regular,
        color: muted,
      });
    }
  }

  return await pdfDoc.save();
}
