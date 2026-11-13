/**
 * Canonical Intermediate Representation (IR) for ebooks & documents.
 * Every parser produces a Book IR; every generator consumes a Book IR.
 */

export function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function unescapeXml(str = '') {
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

export function slugify(str = 'book') {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'book';
}

/**
 * Convert HTML fragment into clean, readable plain text preserving paragraph breaks.
 */
export function htmlToText(html = '') {
  if (!html) return '';
  let s = String(html);
  // Remove script/style blocks completely
  s = s.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Block elements -> newlines
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr|section|article)>/gi, '\n\n');
  s = s.replace(/<(hr)\s*\/?>/gi, '\n---\n\n');
  s = s.replace(/<li[^>]*>/gi, '• ');
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, '');
  s = unescapeXml(s);
  // Normalize whitespace
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * Convert plain text into clean HTML paragraphs.
 */
export function textToHtml(text = '') {
  const normalized = String(text).replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '<p></p>';
  return normalized
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      const lines = trimmed.split('\n').map((l) => escapeXml(l.trim())).join('<br/>');
      return `<p>${lines}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Extract structured blocks (headings, paragraphs, list items, quotes) from HTML
 * for generators like PDF and Markdown that need block-level layout.
 */
export function htmlToBlocks(html = '') {
  const blocks = [];
  if (!html) return blocks;

  const cleaned = String(html)
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\r\n?/g, '\n');

  const blockRegex = /<(h[1-6]|p|blockquote|pre|li|hr)([^>]*)>([\s\S]*?)<\/\1>|<hr\s*\/?>/gi;
  let lastIndex = 0;
  let match;

  while ((match = blockRegex.exec(cleaned)) !== null) {
    // Capture any loose text between matched block tags
    if (match.index > lastIndex) {
      const loose = htmlToText(cleaned.slice(lastIndex, match.index));
      if (loose) {
        for (const para of loose.split(/\n{2,}/)) {
          if (para.trim()) blocks.push({ type: 'p', text: para.trim() });
        }
      }
    }
    lastIndex = blockRegex.lastIndex;

    if (!match[1]) {
      blocks.push({ type: 'hr', text: '' });
      continue;
    }

    const tag = match[1].toLowerCase();
    const inner = match[3] || '';
    const text = htmlToText(inner);
    if (!text && tag !== 'hr') continue;

    if (tag.startsWith('h')) {
      blocks.push({ type: tag, level: Number(tag[1]), text });
    } else if (tag === 'blockquote') {
      blocks.push({ type: 'quote', text });
    } else if (tag === 'pre') {
      blocks.push({ type: 'code', text: unescapeXml(inner.replace(/<[^>]+>/g, '')) });
    } else if (tag === 'li') {
      blocks.push({ type: 'li', text });
    } else {
      blocks.push({ type: 'p', text });
    }
  }

  if (lastIndex < cleaned.length) {
    const tail = htmlToText(cleaned.slice(lastIndex));
    if (tail) {
      for (const para of tail.split(/\n{2,}/)) {
        if (para.trim()) blocks.push({ type: 'p', text: para.trim() });
      }
    }
  }

  return blocks;
}

export function createBook(partial = {}) {
  const meta = partial.metadata || {};
  const chapters = (partial.chapters || []).map((ch, idx) => {
    const html = ch.html ?? textToHtml(ch.text || '');
    const text = ch.text ?? htmlToText(html);
    return {
      id: ch.id || `chapter-${idx + 1}`,
      title: ch.title || `Chapter ${idx + 1}`,
      html,
      text,
    };
  });

  return {
    metadata: {
      title: meta.title || 'Untitled Book',
      author: meta.author || 'Unknown Author',
      language: meta.language || 'en',
      publisher: meta.publisher || '',
      description: meta.description || '',
      identifier: meta.identifier || `urn:uuid:${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`,
      date: meta.date || new Date().toISOString().slice(0, 10),
    },
    chapters,
    images: partial.images || [],
    coverId: partial.coverId || null,
  };
}

export function getBookStats(book) {
  const words = book.chapters.reduce((sum, ch) => {
    const w = (ch.text || '').trim().split(/\s+/).filter(Boolean).length;
    return sum + w;
  }, 0);
  return {
    chapters: book.chapters.length,
    words,
    images: (book.images || []).length,
  };
}
