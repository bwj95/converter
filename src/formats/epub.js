import { unzipSync, zipSync, strToU8, strFromU8 } from '../../vendor/fflate.mjs';
import { createBook, escapeXml } from '../core/ir.js';
import { dirname, extractBodyHtml, extractTitle, findElements, findFirstText, resolvePath } from '../core/xml.js';
import { stripExtension } from '../core/detect.js';

function getZipEntry(files, targetPath) {
  if (files[targetPath]) return files[targetPath];
  const lower = targetPath.toLowerCase();
  for (const key of Object.keys(files)) {
    if (key.toLowerCase() === lower) return files[key];
  }
  return null;
}

function parseNcxTitles(ncxXml, ncxDir) {
  const map = new Map();
  for (const np of findElements(ncxXml, 'navPoint')) {
    const label = findFirstText(np.inner, 'text');
    const contentEl = findElements(np.inner, 'content')[0];
    if (label && contentEl?.attrs?.src) {
      const full = resolvePath(ncxDir, contentEl.attrs.src);
      if (!map.has(full)) map.set(full, label);
    }
  }
  return map;
}

function parseNavTitles(navXml, navDir) {
  const map = new Map();
  for (const a of findElements(navXml, 'a')) {
    const href = a.attrs.href;
    const label = a.inner.replace(/<[^>]+>/g, '').trim();
    if (href && label) {
      const full = resolvePath(navDir, href);
      if (!map.has(full)) map.set(full, label);
    }
  }
  return map;
}

export async function parseEpub(bytes, filename = 'book.epub') {
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

  // 1. Locate OPF path from META-INF/container.xml
  let opfPath = '';
  const containerBytes = getZipEntry(files, 'META-INF/container.xml');
  if (containerBytes) {
    const containerXml = strFromU8(containerBytes);
    const rootfiles = findElements(containerXml, 'rootfile');
    opfPath = rootfiles[0]?.attrs['full-path'] || '';
  }
  if (!opfPath) {
    opfPath = Object.keys(files).find((k) => k.toLowerCase().endsWith('.opf')) || '';
  }
  if (!opfPath) {
    throw new Error('Invalid EPUB: could not locate OPF package file.');
  }

  const opfBytes = getZipEntry(files, opfPath);
  if (!opfBytes) throw new Error(`Invalid EPUB: missing ${opfPath}`);
  const opfXml = strFromU8(opfBytes);
  const opfDir = dirname(opfPath);

  // 2. Metadata
  const metadata = {
    title: findFirstText(opfXml, 'title') || stripExtension(filename),
    author: findFirstText(opfXml, 'creator') || 'Unknown Author',
    language: findFirstText(opfXml, 'language') || 'en',
    publisher: findFirstText(opfXml, 'publisher') || '',
    description: findFirstText(opfXml, 'description') || '',
    identifier: findFirstText(opfXml, 'identifier') || '',
  };

  // 3. Manifest
  const manifest = new Map();
  const images = [];
  let ncxPath = '';
  let navPath = '';

  for (const item of findElements(opfXml, 'item')) {
    const id = item.attrs.id;
    const href = item.attrs.href;
    const mediaType = item.attrs['media-type'] || '';
    const props = item.attrs.properties || '';
    if (!id || !href) continue;

    const fullPath = resolvePath(opfDir, href);
    manifest.set(id, { id, href, fullPath, mediaType, props });

    if (mediaType === 'application/x-dtbncx+xml') ncxPath = fullPath;
    if (/\bnav\b/.test(props)) navPath = fullPath;

    if (mediaType.startsWith('image/')) {
      const imgData = getZipEntry(files, fullPath);
      if (imgData) {
        images.push({ id, href: fullPath, mimeType: mediaType, data: imgData });
      }
    }
  }

  // 4. TOC title map
  const tocTitles = new Map();
  if (navPath) {
    const navBytes = getZipEntry(files, navPath);
    if (navBytes) {
      for (const [k, v] of parseNavTitles(strFromU8(navBytes), dirname(navPath))) {
        tocTitles.set(k, v);
      }
    }
  }
  if (ncxPath) {
    const ncxBytes = getZipEntry(files, ncxPath);
    if (ncxBytes) {
      for (const [k, v] of parseNcxTitles(strFromU8(ncxBytes), dirname(ncxPath))) {
        if (!tocTitles.has(k)) tocTitles.set(k, v);
      }
    }
  }

  // 5. Spine chapters
  const chapters = [];
  for (const itemref of findElements(opfXml, 'itemref')) {
    const idref = itemref.attrs.idref;
    const entry = manifest.get(idref);
    if (!entry) continue;
    // Skip EPUB 3 nav document if it's purely navigation
    if (/\bnav\b/.test(entry.props) && chapters.length === 0) continue;

    const chBytes = getZipEntry(files, entry.fullPath);
    if (!chBytes) continue;

    const rawXhtml = strFromU8(chBytes);
    const chDir = dirname(entry.fullPath);
    let body = extractBodyHtml(rawXhtml);

    // Normalize relative image src paths to archive-relative paths
    body = body.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (full, pre, src, post) => {
      if (/^(https?:|data:)/i.test(src)) return full;
      return `${pre}${resolvePath(chDir, src)}${post}`;
    });

    const title =
      tocTitles.get(entry.fullPath) ||
      extractTitle(rawXhtml) ||
      `Chapter ${chapters.length + 1}`;

    chapters.push({
      id: `chapter-${chapters.length + 1}`,
      title,
      html: body,
    });
  }

  if (chapters.length === 0) {
    throw new Error('EPUB contains no readable spine chapters.');
  }

  return createBook({ metadata, chapters, images });
}

export async function generateEpub(book) {
  const uid = book.metadata.identifier || `urn:uuid:${Date.now()}`;
  const lang = book.metadata.language || 'en';
  const title = book.metadata.title || 'Untitled Book';
  const author = book.metadata.author || 'Unknown Author';

  const entries = {};
  // mimetype MUST be first and uncompressed
  entries['mimetype'] = [strToU8('application/epub+zip'), { level: 0 }];

  entries['META-INF/container.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  entries['OEBPS/styles.css'] = strToU8(`body {
  font-family: Georgia, serif;
  line-height: 1.6;
  margin: 5%;
}
h1, h2, h3 { line-height: 1.25; }
img { max-width: 100%; height: auto; }
pre { white-space: pre-wrap; }
blockquote { border-left: 3px solid #999; margin-left: 0; padding-left: 1em; }`);

  const manifestItems = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="styles.css" media-type="text/css"/>`,
  ];
  const spineItems = [];
  const navLinks = [];
  const ncxNavPoints = [];

  // Images
  const imageHrefMap = new Map();
  (book.images || []).forEach((img, idx) => {
    const base = (img.href || `img-${idx}`).split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_');
    const rel = `images/${idx + 1}-${base}`;
    entries[`OEBPS/${rel}`] = img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data);
    imageHrefMap.set(img.href, rel);
    imageHrefMap.set(base, rel);
    manifestItems.push(
      `<item id="img-${idx + 1}" href="${escapeXml(rel)}" media-type="${escapeXml(img.mimeType || 'image/jpeg')}"/>`
    );
  });

  // Chapters
  book.chapters.forEach((ch, idx) => {
    const fileName = `chapter-${idx + 1}.xhtml`;
    const chTitle = ch.title || `Chapter ${idx + 1}`;

    let bodyHtml = (ch.html || '').replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (full, pre, src, post) => {
      const clean = src.split('#')[0].split('?')[0];
      const base = clean.split('/').pop();
      const mapped = imageHrefMap.get(clean) || imageHrefMap.get(base);
      return mapped ? `${pre}${mapped}${post}` : full;
    });

    // Ensure basic XHTML self-closing tags for br/hr/img
    bodyHtml = bodyHtml
      .replace(/<br\s*>/gi, '<br/>')
      .replace(/<hr\s*>/gi, '<hr/>')
      .replace(/<img([^>]*?)(?<!\/)>/gi, '<img$1/>');

    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(chTitle)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
${bodyHtml}
</body>
</html>`;

    entries[`OEBPS/${fileName}`] = strToU8(xhtml);
    manifestItems.push(`<item id="ch-${idx + 1}" href="${fileName}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="ch-${idx + 1}"/>`);
    navLinks.push(`      <li><a href="${fileName}">${escapeXml(chTitle)}</a></li>`);
    ncxNavPoints.push(`    <navPoint id="navPoint-${idx + 1}" playOrder="${idx + 1}">
      <navLabel><text>${escapeXml(chTitle)}</text></navLabel>
      <content src="${fileName}"/>
    </navPoint>`);
  });

  entries['OEBPS/nav.xhtml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${navLinks.join('\n')}
    </ol>
  </nav>
</body>
</html>`);

  entries['OEBPS/toc.ncx'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(uid)}"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${ncxNavPoints.join('\n')}
  </navMap>
</ncx>`);

  entries['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(uid)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>${escapeXml(lang)}</dc:language>
    ${book.metadata.publisher ? `<dc:publisher>${escapeXml(book.metadata.publisher)}</dc:publisher>` : ''}
    ${book.metadata.description ? `<dc:description>${escapeXml(book.metadata.description)}</dc:description>` : ''}
    <meta property="dcterms:modified">${new Date().toISOString().slice(0, 19)}Z</meta>
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join('\n    ')}
  </spine>
</package>`);

  return zipSync(entries, { level: 6 });
}
