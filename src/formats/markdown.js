import { createBook, escapeXml, htmlToBlocks } from '../core/ir.js';
import { stripExtension } from '../core/detect.js';

function inlineMdToHtml(str) {
  let s = escapeXml(str);
  // Inline code first
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold + italic
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

function mdBlockToHtml(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line.trim())) {
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(escapeXml(lines[i]));
        i++;
      }
      i++;
      out.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(line.trim())) {
      out.push('<hr/>');
      i++;
      continue;
    }

    // Heading
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const lvl = hMatch[1].length;
      out.push(`<h${lvl}>${inlineMdToHtml(hMatch[2].trim())}</h${lvl}>`);
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(inlineMdToHtml(lines[i].replace(/^>\s?/, '')));
        i++;
      }
      out.push(`<blockquote><p>${quoteLines.join('<br/>')}</p></blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMdToHtml(lines[i].replace(/^[-*+]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inlineMdToHtml(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Paragraph
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|>\s?|[-*+]\s|\d+\.\s|(?:---|\*\*\*|___)\s*$)/.test(lines[i])
    ) {
      paraLines.push(inlineMdToHtml(lines[i].trim()));
      i++;
    }
    out.push(`<p>${paraLines.join(' ')}</p>`);
  }

  return out.join('\n');
}

export async function parseMarkdown(bytes, filename = 'document.md') {
  let raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\r\n?/g, '\n');
  const metadata = { title: stripExtension(filename) };

  // Optional YAML frontmatter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    raw = raw.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split('\n')) {
      const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const val = kv[2].trim().replace(/^["']|["']$/g, '');
      if (key === 'title') metadata.title = val;
      if (key === 'author') metadata.author = val;
      if (key === 'language' || key === 'lang') metadata.language = val;
      if (key === 'publisher') metadata.publisher = val;
    }
  }

  // Split into chapters on H1 (# )
  const lines = raw.split('\n');
  const sections = [];
  let curTitle = metadata.title;
  let curLines = [];
  let inCode = false;

  for (const line of lines) {
    if (/^```/.test(line.trim())) inCode = !inCode;
    const h1 = !inCode && line.match(/^#\s+(.+)$/);
    if (h1) {
      if (curLines.join('\n').trim()) {
        sections.push({ title: curTitle, md: curLines.join('\n') });
      }
      curTitle = h1[1].trim();
      curLines = [line];
    } else {
      curLines.push(line);
    }
  }
  if (curLines.join('\n').trim() || sections.length === 0) {
    sections.push({ title: curTitle, md: curLines.join('\n') });
  }

  // If first H1 was the book title and there's only 1 section, keep metadata.title synced
  if (sections.length === 1 && sections[0].title && metadata.title === stripExtension(filename)) {
    metadata.title = sections[0].title;
  }

  const chapters = sections.map((sec, idx) => ({
    id: `chapter-${idx + 1}`,
    title: sec.title || `Chapter ${idx + 1}`,
    html: mdBlockToHtml(sec.md),
  }));

  return createBook({ metadata, chapters });
}

export async function generateMarkdown(book) {
  const out = [];
  out.push('---');
  out.push(`title: "${(book.metadata.title || '').replace(/"/g, '\\"')}"`);
  out.push(`author: "${(book.metadata.author || '').replace(/"/g, '\\"')}"`);
  out.push(`language: "${book.metadata.language || 'en'}"`);
  out.push('---');
  out.push('');

  for (const ch of book.chapters) {
    const blocks = htmlToBlocks(ch.html);
    const hasH1 = blocks.some((b) => b.type === 'h1');
    if (!hasH1 && ch.title) {
      out.push(`# ${ch.title}`);
      out.push('');
    }
    for (const b of blocks) {
      if (b.type.startsWith('h')) {
        out.push(`${'#'.repeat(b.level || 2)} ${b.text}`);
        out.push('');
      } else if (b.type === 'quote') {
        out.push(b.text.split('\n').map((l) => `> ${l}`).join('\n'));
        out.push('');
      } else if (b.type === 'code') {
        out.push('```');
        out.push(b.text);
        out.push('```');
        out.push('');
      } else if (b.type === 'li') {
        out.push(`- ${b.text}`);
      } else if (b.type === 'hr') {
        out.push('---');
        out.push('');
      } else {
        out.push(b.text);
        out.push('');
      }
    }
    out.push('');
  }

  return new TextEncoder().encode(out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
}
