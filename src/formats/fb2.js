import { createBook, escapeXml, htmlToBlocks } from '../core/ir.js';
import { findElements, findFirstText } from '../core/xml.js';
import { stripExtension } from '../core/detect.js';

function base64ToUint8(b64) {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function uint8ToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function fb2InnerToHtml(xml) {
  return xml
    .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, (_, t) => `<h1>${t.replace(/<\/?p[^>]*>/gi, ' ').trim()}</h1>`)
    .replace(/<subtitle[^>]*>([\s\S]*?)<\/subtitle>/gi, '<h2>$1</h2>')
    .replace(/<empty-line\s*\/?>/gi, '<br/>')
    .replace(/<emphasis>/gi, '<em>')
    .replace(/<\/emphasis>/gi, '</em>')
    .replace(/<cite>/gi, '<blockquote>')
    .replace(/<\/cite>/gi, '</blockquote>')
    .replace(/<image\b[^>]*href=["']#?([^"']+)["'][^>]*\/?>/gi, '<img src="$1" alt=""/>')
    .trim();
}

export async function parseFb2(bytes, filename = 'book.fb2') {
  const xml = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const titleInfo = findElements(xml, 'title-info')[0]?.inner || xml;

  const title = findFirstText(titleInfo, 'book-title') || stripExtension(filename);
  const firstName = findFirstText(titleInfo, 'first-name');
  const lastName = findFirstText(titleInfo, 'last-name');
  const author = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown Author';
  const language = findFirstText(titleInfo, 'lang') || 'en';
  const description = findFirstText(titleInfo, 'annotation');

  const images = [];
  for (const bin of findElements(xml, 'binary')) {
    const id = bin.attrs.id;
    const mimeType = bin.attrs['content-type'] || 'image/jpeg';
    if (id && bin.inner) {
      try {
        images.push({ id, href: id, mimeType, data: base64ToUint8(bin.inner) });
      } catch {
        // Skip malformed base64 binary
      }
    }
  }

  const bodyEl = findElements(xml, 'body')[0]?.inner || '';
  const sections = findElements(bodyEl, 'section');
  const chapters = (sections.length ? sections : [{ inner: bodyEl }]).map((sec, idx) => {
    const chTitle = findFirstText(sec.inner, 'title') || `Chapter ${idx + 1}`;
    return {
      id: `chapter-${idx + 1}`,
      title: chTitle,
      html: fb2InnerToHtml(sec.inner),
    };
  });

  return createBook({
    metadata: { title, author, language, description },
    chapters,
    images,
  });
}

export async function generateFb2(book) {
  const nameParts = (book.metadata.author || 'Unknown Author').trim().split(/\s+/);
  const firstName = nameParts[0] || 'Unknown';
  const lastName = nameParts.slice(1).join(' ') || '';

  const sectionsXml = book.chapters
    .map((ch) => {
      const blocks = htmlToBlocks(ch.html);
      const body = blocks
        .map((b) => {
          if (b.type === 'h1') return `<title><p>${escapeXml(b.text)}</p></title>`;
          if (b.type.startsWith('h')) return `<subtitle>${escapeXml(b.text)}</subtitle>`;
          if (b.type === 'quote') return `<cite><p>${escapeXml(b.text)}</p></cite>`;
          if (b.type === 'hr') return '<empty-line/>';
          return `<p>${escapeXml(b.text)}</p>`;
        })
        .join('\n      ');
      const hasTitle = blocks.some((b) => b.type === 'h1');
      const titleTag = hasTitle ? '' : `<title><p>${escapeXml(ch.title)}</p></title>\n      `;
      return `    <section>\n      ${titleTag}${body}\n    </section>`;
    })
    .join('\n');

  const binariesXml = (book.images || [])
    .map((img, i) => {
      const id = escapeXml(img.href?.split('/').pop() || img.id || `img-${i}`);
      const mime = escapeXml(img.mimeType || 'image/jpeg');
      return `  <binary id="${id}" content-type="${mime}">${uint8ToBase64(img.data)}</binary>`;
    })
    .join('\n');

  const fb2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <genre>prose</genre>
      <author>
        <first-name>${escapeXml(firstName)}</first-name>
        <last-name>${escapeXml(lastName)}</last-name>
      </author>
      <book-title>${escapeXml(book.metadata.title)}</book-title>
      <lang>${escapeXml(book.metadata.language || 'en')}</lang>
    </title-info>
    <document-info>
      <program-used>Converter (Browser Ebook Tool)</program-used>
      <date>${escapeXml(book.metadata.date)}</date>
      <id>${escapeXml(book.metadata.identifier)}</id>
      <version>1.0</version>
    </document-info>
  </description>
  <body>
${sectionsXml}
  </body>
${binariesXml}
</FictionBook>`;

  return new TextEncoder().encode(fb2);
}
