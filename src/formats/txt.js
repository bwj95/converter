import { createBook, textToHtml } from '../core/ir.js';
import { stripExtension } from '../core/detect.js';

const CHAPTER_HEADING_RE = /^(?:chapter|part|book|section)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b.*$/i;

export async function parseTxt(bytes, filename = 'document.txt') {
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const fallbackTitle = stripExtension(filename);

  const chapters = [];
  let currentTitle = fallbackTitle;
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const prevBlank = i === 0 || lines[i - 1].trim() === '';
    const nextBlank = i === lines.length - 1 || lines[i + 1].trim() === '';

    if (prevBlank && nextBlank && trimmed.length > 0 && trimmed.length < 100 && CHAPTER_HEADING_RE.test(trimmed)) {
      const body = currentLines.join('\n').trim();
      if (body) {
        chapters.push({
          id: `chapter-${chapters.length + 1}`,
          title: currentTitle,
          text: body,
          html: textToHtml(body),
        });
      }
      currentTitle = trimmed;
      currentLines = [];
      continue;
    }

    currentLines.push(lines[i]);
  }

  const remaining = currentLines.join('\n').trim();
  if (remaining || chapters.length === 0) {
    chapters.push({
      id: `chapter-${chapters.length + 1}`,
      title: chapters.length === 0 ? fallbackTitle : currentTitle,
      text: remaining,
      html: textToHtml(remaining),
    });
  }

  return createBook({
    metadata: { title: fallbackTitle },
    chapters,
  });
}

export async function generateTxt(book) {
  const parts = [];
  parts.push(book.metadata.title);
  if (book.metadata.author && book.metadata.author !== 'Unknown Author') {
    parts.push(`by ${book.metadata.author}`);
  }
  parts.push('='.repeat(Math.min(60, Math.max(20, book.metadata.title.length))));
  parts.push('');

  for (const ch of book.chapters) {
    if (book.chapters.length > 1 || ch.title !== book.metadata.title) {
      parts.push(ch.title);
      parts.push('-'.repeat(Math.min(50, Math.max(8, ch.title.length))));
      parts.push('');
    }
    parts.push((ch.text || '').trim());
    parts.push('');
    parts.push('');
  }

  return new TextEncoder().encode(parts.join('\n').trimEnd() + '\n');
}
