import { createBook, escapeXml } from '../core/ir.js';
import { extractBodyHtml, extractTitle, findElements } from '../core/xml.js';
import { stripExtension } from '../core/detect.js';

function uint8ToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export async function parseHtml(bytes, filename = 'document.html') {
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const title = extractTitle(raw) || stripExtension(filename);

  let author = 'Unknown Author';
  for (const meta of findElements(raw, 'meta')) {
    if ((meta.attrs.name || '').toLowerCase() === 'author' && meta.attrs.content) {
      author = meta.attrs.content;
    }
  }

  const body = extractBodyHtml(raw);
  // Split on <h1> if multiple chapters exist
  const parts = body.split(/(?=<h1[\s>])/i).filter((p) => p.trim());
  const chapters = (parts.length ? parts : [body]).map((html, idx) => ({
    id: `chapter-${idx + 1}`,
    title: extractTitle(html) || (parts.length > 1 ? `Chapter ${idx + 1}` : title),
    html,
  }));

  return createBook({
    metadata: { title, author },
    chapters,
  });
}

export async function generateHtml(book) {
  const imageMap = new Map();
  for (const img of book.images || []) {
    const b64 = uint8ToBase64(img.data);
    imageMap.set(img.href, `data:${img.mimeType || 'image/jpeg'};base64,${b64}`);
    const baseName = img.href.split('/').pop();
    if (baseName) imageMap.set(baseName, `data:${img.mimeType || 'image/jpeg'};base64,${b64}`);
  }

  const inlineImages = (html) =>
    html.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (full, pre, src, post) => {
      const clean = src.split('#')[0].split('?')[0];
      const base = clean.split('/').pop();
      const dataUrl = imageMap.get(clean) || imageMap.get(base);
      return dataUrl ? `${pre}${dataUrl}${post}` : full;
    });

  const toc = book.chapters.length > 1
    ? `<nav class="toc"><h2>Contents</h2><ol>${book.chapters
        .map((c) => `<li><a href="#${escapeXml(c.id)}">${escapeXml(c.title)}</a></li>`)
        .join('')}</ol></nav>`
    : '';

  const sections = book.chapters
    .map(
      (c) =>
        `<section id="${escapeXml(c.id)}" class="chapter">\n${inlineImages(c.html)}\n</section>`
    )
    .join('\n<hr class="chapter-sep"/>\n');

  const html = `<!DOCTYPE html>
<html lang="${escapeXml(book.metadata.language || 'en')}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="author" content="${escapeXml(book.metadata.author)}"/>
  <title>${escapeXml(book.metadata.title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      max-width: 68ch;
      margin: 3rem auto;
      padding: 0 1.25rem;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 1.08rem;
      line-height: 1.72;
    }
    header.book-header { border-bottom: 1px solid currentColor; padding-bottom: 1.5rem; margin-bottom: 2rem; }
    header.book-header h1 { margin: 0 0 0.35rem; font-size: 2.1rem; line-height: 1.2; }
    header.book-header .author { opacity: 0.75; font-style: italic; margin: 0; }
    .toc { margin: 2rem 0; padding: 1rem 1.25rem; border: 1px solid rgba(128,128,128,0.3); border-radius: 6px; }
    .toc h2 { margin-top: 0; font-size: 1.1rem; }
    img { max-width: 100%; height: auto; display: block; margin: 1.25rem auto; }
    pre { overflow-x: auto; padding: 0.9rem; background: rgba(128,128,128,0.12); border-radius: 6px; }
    blockquote { border-left: 3px solid rgba(128,128,128,0.5); margin-left: 0; padding-left: 1rem; opacity: 0.9; }
    hr.chapter-sep { border: none; border-top: 1px solid rgba(128,128,128,0.25); margin: 3rem 0; }
  </style>
</head>
<body>
  <header class="book-header">
    <h1>${escapeXml(book.metadata.title)}</h1>
    <p class="author">${escapeXml(book.metadata.author)}</p>
  </header>
  ${toc}
  <main>
    ${sections}
  </main>
</body>
</html>`;

  return new TextEncoder().encode(html);
}
