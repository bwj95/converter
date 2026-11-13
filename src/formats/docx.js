import { unzipSync, strFromU8 } from '../../vendor/fflate.mjs';
import { createBook, escapeXml } from '../core/ir.js';
import { findElements, findFirstText, parseAttributes } from '../core/xml.js';
import { stripExtension } from '../core/detect.js';

function getZipEntry(files, path) {
  if (files[path]) return files[path];
  const lower = path.toLowerCase();
  for (const k of Object.keys(files)) {
    if (k.toLowerCase() === lower) return files[k];
  }
  return null;
}

function mimeForExt(name = '') {
  const l = name.toLowerCase();
  if (l.endsWith('.png')) return 'image/png';
  if (l.endsWith('.gif')) return 'image/gif';
  if (l.endsWith('.webp')) return 'image/webp';
  if (l.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

function parseRunsHtml(xml, relsMap) {
  let out = '';
  // Match hyperlinks or standalone runs in order
  const tokenRe = /<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>|<w:r\b[^>]*>([\s\S]*?)<\/w:r>/gi;
  let m;

  const renderRun = (runInner) => {
    const rPr = runInner.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/i)?.[1] || '';
    const isBold = /<w:b(?:\s+w:val="(?:true|1)"|\s*\/?>)/i.test(rPr) && !/<w:b\s+w:val="(?:false|0)"/i.test(rPr);
    const isItalic = /<w:i(?:\s+w:val="(?:true|1)"|\s*\/?>)/i.test(rPr) && !/<w:i\s+w:val="(?:false|0)"/i.test(rPr);

    // Embedded image (<a:blip r:embed="rId..."/>)
    const blip = runInner.match(/<a:blip\b[^>]*r:embed=["']([^"']+)["']/i);
    if (blip) {
      const rel = relsMap.get(blip[1]);
      if (rel?.imageHref) {
        return `<img src="${escapeXml(rel.imageHref)}" alt=""/>`;
      }
    }

    let text = '';
    const partRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/?>|<w:br\b[^>]*\/?>/gi;
    let pm;
    while ((pm = partRe.exec(runInner)) !== null) {
      if (pm[1] !== undefined) {
        text += pm[1];
      } else if (/^<w:tab/i.test(pm[0])) {
        text += '    ';
      } else {
        text += '\n';
      }
    }
    if (!text) return '';
    let html = escapeXml(text).replace(/\n/g, '<br/>');
    if (isBold) html = `<strong>${html}</strong>`;
    if (isItalic) html = `<em>${html}</em>`;
    return html;
  };

  while ((m = tokenRe.exec(xml)) !== null) {
    if (m[1] !== undefined) {
      const attrs = parseAttributes(m[1]);
      const rel = relsMap.get(attrs['r:id']);
      const innerRuns = m[2].replace(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/gi, (_, ri) => renderRun(ri));
      // Strip unmatched xml around runs inside hyperlink
      const clean = innerRuns.replace(/<[^>]+>/g, (tag) =>
        /^<\/?(strong|em|br|img)\b/i.test(tag) ? tag : ''
      );
      if (rel?.target) {
        out += `<a href="${escapeXml(rel.target)}">${clean}</a>`;
      } else {
        out += clean;
      }
    } else if (m[3] !== undefined) {
      out += renderRun(m[3]);
    }
  }
  return out;
}

function paragraphToBlock(pXml, relsMap) {
  const pPr = pXml.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i)?.[1] || '';
  const styleMatch = pPr.match(/<w:pStyle\b[^>]*w:val=["']([^"']+)["']/i);
  const style = (styleMatch?.[1] || '').toLowerCase();
  const isList = /<w:numPr\b/i.test(pPr);

  const innerHtml = parseRunsHtml(pXml, relsMap).trim();
  if (!innerHtml) return null;

  if (style === 'title') return { tag: 'h1', html: `<h1>${innerHtml}</h1>`, isHeading1: true, titleText: innerHtml.replace(/<[^>]+>/g, '') };
  if (style === 'subtitle') return { tag: 'h2', html: `<h2>${innerHtml}</h2>` };
  const hMatch = style.match(/^heading(\d)$/);
  if (hMatch) {
    const lvl = Math.min(6, Math.max(1, Number(hMatch[1])));
    return {
      tag: `h${lvl}`,
      html: `<h${lvl}>${innerHtml}</h${lvl}>`,
      isHeading1: lvl === 1,
      titleText: innerHtml.replace(/<[^>]+>/g, ''),
    };
  }
  if (style.includes('quote')) return { tag: 'blockquote', html: `<blockquote><p>${innerHtml}</p></blockquote>` };
  if (isList) return { tag: 'li', html: `<li>${innerHtml}</li>` };
  return { tag: 'p', html: `<p>${innerHtml}</p>` };
}

function tableToHtml(tblXml, relsMap) {
  const rows = [];
  for (const tr of findElements(tblXml, 'tr')) {
    const cells = [];
    for (const tc of findElements(tr.inner, 'tc')) {
      const ps = findElements(tc.inner, 'p')
        .map((p) => parseRunsHtml(p.inner, relsMap).trim())
        .filter(Boolean);
      cells.push(ps.join(' '));
    }
    if (cells.some(Boolean)) {
      rows.push(`<p>${cells.join(' | ')}</p>`);
    }
  }
  return rows.join('\n');
}

export async function parseDocx(bytes, filename = 'document.docx') {
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const docBytes = getZipEntry(files, 'word/document.xml');
  if (!docBytes) {
    throw new Error('Invalid DOCX: missing word/document.xml.');
  }
  const docXml = strFromU8(docBytes);

  // Metadata from docProps/core.xml
  let title = stripExtension(filename);
  let author = 'Unknown Author';
  let language = 'en';
  const coreBytes = getZipEntry(files, 'docProps/core.xml');
  if (coreBytes) {
    const coreXml = strFromU8(coreBytes);
    title = findFirstText(coreXml, 'title') || title;
    author = findFirstText(coreXml, 'creator') || author;
    language = findFirstText(coreXml, 'language') || language;
  }

  // Relationships & media images
  const relsMap = new Map();
  const images = [];
  const relsBytes = getZipEntry(files, 'word/_rels/document.xml.rels');
  if (relsBytes) {
    const relsXml = strFromU8(relsBytes);
    for (const rel of findElements(relsXml, 'Relationship')) {
      const id = rel.attrs.id;
      const target = rel.attrs.target || '';
      const type = rel.attrs.type || '';
      if (!id || !target) continue;

      if (type.endsWith('/image')) {
        const archivePath = target.startsWith('/') ? target.slice(1) : `word/${target.replace(/^\.\//, '')}`;
        const imgBytes = getZipEntry(files, archivePath);
        if (imgBytes) {
          const href = `images/${archivePath.split('/').pop()}`;
          images.push({ id, href, mimeType: mimeForExt(href), data: imgBytes });
          relsMap.set(id, { target, imageHref: href });
        }
      } else {
        relsMap.set(id, { target });
      }
    }
  }

  // Extract body blocks (paragraphs + tables in document order)
  const bodyXml = docXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i)?.[1] || docXml;
  const blocks = [];
  const topRe = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi;
  let tm;
  while ((tm = topRe.exec(bodyXml)) !== null) {
    if (tm[1] !== undefined) {
      const tblHtml = tableToHtml(tm[1], relsMap);
      if (tblHtml) blocks.push({ tag: 'p', html: tblHtml });
    } else if (tm[2] !== undefined) {
      const b = paragraphToBlock(tm[2], relsMap);
      if (b) blocks.push(b);
    }
  }

  // Group consecutive <li> into <ul> and split chapters on Heading1
  const chapters = [];
  let curTitle = title;
  let curHtml = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      curHtml.push('</ul>');
      inList = false;
    }
  };

  const flushChapter = () => {
    closeList();
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

  for (const b of blocks) {
    if (b.isHeading1 && curHtml.length > 0) {
      flushChapter();
      curTitle = b.titleText || `Chapter ${chapters.length + 1}`;
    } else if (b.isHeading1 && chapters.length === 0 && curHtml.length === 0 && b.titleText) {
      curTitle = b.titleText;
    }

    if (b.tag === 'li') {
      if (!inList) {
        curHtml.push('<ul>');
        inList = true;
      }
      curHtml.push(b.html);
    } else {
      closeList();
      curHtml.push(b.html);
    }
  }
  flushChapter();

  if (chapters.length === 0) {
    chapters.push({ id: 'chapter-1', title, html: '<p></p>' });
  }

  return createBook({
    metadata: { title, author, language },
    chapters,
    images,
  });
}
