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

function parseStylesMap(files) {
  const map = new Map();
  const stylesBytes = getZipEntry(files, 'word/styles.xml');
  if (!stylesBytes) return map;
  const xml = strFromU8(stylesBytes);
  for (const st of findElements(xml, 'style')) {
    const id = st.attrs['w:styleid'] || st.attrs.styleid;
    if (!id) continue;
    const nameMatch = st.inner.match(/<w:name\b[^>]*w:val=["']([^"']+)["']/i);
    if (nameMatch) {
      map.set(id.toLowerCase(), nameMatch[1].toLowerCase());
    }
  }
  return map;
}

function parseRunsHtml(xml, relsMap) {
  let out = '';
  const tokenRe = /<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>|<w:r\b[^>]*>([\s\S]*?)<\/w:r>/gi;
  let m;

  const renderRun = (runInner) => {
    const rPr = runInner.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/i)?.[1] || '';
    const isBold = /<w:b(?:\s+w:val="(?:true|1)"|\s*\/?>)/i.test(rPr) && !/<w:b\s+w:val="(?:false|0)"/i.test(rPr);
    const isItalic = /<w:i(?:\s+w:val="(?:true|1)"|\s*\/?>)/i.test(rPr) && !/<w:i\s+w:val="(?:false|0)"/i.test(rPr);
    const isUnderline = /<w:u\b/i.test(rPr) && !/<w:u\b[^>]*w:val=["']none["']/i.test(rPr);
    const colorMatch = rPr.match(/<w:color\b[^>]*w:val=["']([0-9a-fA-F]{6})["']/i);
    const color = colorMatch && colorMatch[1].toLowerCase() !== '000000' && colorMatch[1].toLowerCase() !== 'auto'
      ? `#${colorMatch[1]}`
      : null;

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
    if (color) html = `<span style="color:${color}">${html}</span>`;
    if (isUnderline) html = `<u>${html}</u>`;
    if (isBold) html = `<strong>${html}</strong>`;
    if (isItalic) html = `<em>${html}</em>`;
    return html;
  };

  while ((m = tokenRe.exec(xml)) !== null) {
    if (m[1] !== undefined) {
      const attrs = parseAttributes(m[1]);
      const rel = relsMap.get(attrs['r:id']);
      const innerRuns = m[2].replace(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/gi, (_, ri) => renderRun(ri));
      const clean = innerRuns.replace(/<[^>]+>/g, (tag) =>
        /^<\/?(strong|em|u|span|br|img)\b/i.test(tag) ? tag : ''
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

function paragraphToBlock(pXml, relsMap, stylesMap) {
  const pPr = pXml.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i)?.[1] || '';
  const styleId = (pPr.match(/<w:pStyle\b[^>]*w:val=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
  const styleName = stylesMap.get(styleId) || styleId;
  const isList = /<w:numPr\b/i.test(pPr);

  const jcMatch = pPr.match(/<w:jc\b[^>]*w:val=["'](left|center|right|both|distribute)["']/i);
  const align = jcMatch ? (jcMatch[1].toLowerCase() === 'both' ? 'justify' : jcMatch[1].toLowerCase()) : '';
  const styleAttr = align && align !== 'left' ? ` style="text-align:${align}"` : '';

  const innerHtml = parseRunsHtml(pXml, relsMap).trim();
  if (!innerHtml) return null;

  if (styleName === 'title') {
    return { tag: 'h1', html: `<h1${styleAttr}>${innerHtml}</h1>` };
  }
  if (styleName === 'subtitle') {
    return { tag: 'h2', html: `<h2${styleAttr}>${innerHtml}</h2>` };
  }
  const hMatch = styleName.match(/^heading\s*(\d)$/);
  if (hMatch) {
    const lvl = Math.min(6, Math.max(1, Number(hMatch[1])));
    return { tag: `h${lvl}`, html: `<h${lvl}${styleAttr}>${innerHtml}</h${lvl}>` };
  }

  // Heuristic: short bold paragraph with large explicit font size (>= 15pt / w:sz >= 30)
  const szMatch = pXml.match(/<w:sz\b[^>]*w:val=["'](\d+)["']/i);
  const plainLen = innerHtml.replace(/<[^>]+>/g, '').trim().length;
  if (szMatch && Number(szMatch[1]) >= 30 && plainLen > 0 && plainLen < 120) {
    const lvl = Number(szMatch[1]) >= 40 ? 1 : 2;
    return { tag: `h${lvl}`, html: `<h${lvl}${styleAttr}>${innerHtml}</h${lvl}>` };
  }

  if (styleName.includes('quote')) {
    return { tag: 'blockquote', html: `<blockquote${styleAttr}><p>${innerHtml}</p></blockquote>` };
  }
  if (isList) {
    return { tag: 'li', html: `<li>${innerHtml}</li>` };
  }
  return { tag: 'p', html: `<p${styleAttr}>${innerHtml}</p>` };
}

function tableToHtml(tblXml, relsMap) {
  const rows = [];
  for (const tr of findElements(tblXml, 'tr')) {
    const cells = [];
    for (const tc of findElements(tr.inner, 'tc')) {
      const ps = findElements(tc.inner, 'p')
        .map((p) => parseRunsHtml(p.inner, relsMap).trim())
        .filter(Boolean);
      cells.push(`<td>${ps.join('<br/>')}</td>`);
    }
    if (cells.length) {
      rows.push(`<tr>${cells.join('')}</tr>`);
    }
  }
  return rows.length ? `<table>${rows.join('')}</table>` : '';
}

export async function parseDocx(bytes, filename = 'document.docx') {
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const docBytes = getZipEntry(files, 'word/document.xml');
  if (!docBytes) {
    throw new Error('Invalid DOCX: missing word/document.xml.');
  }
  const docXml = strFromU8(docBytes);
  const stylesMap = parseStylesMap(files);

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
      if (tblHtml) blocks.push({ tag: 'table', html: tblHtml });
    } else if (tm[2] !== undefined) {
      const b = paragraphToBlock(tm[2], relsMap, stylesMap);
      if (b) blocks.push(b);
    }
  }

  // Assemble HTML with proper <ul> wrapping
  const htmlParts = [];
  let inList = false;
  for (const b of blocks) {
    if (b.tag === 'li') {
      if (!inList) {
        htmlParts.push('<ul>');
        inList = true;
      }
      htmlParts.push(b.html);
    } else {
      if (inList) {
        htmlParts.push('</ul>');
        inList = false;
      }
      htmlParts.push(b.html);
    }
  }
  if (inList) htmlParts.push('</ul>');

  const fullHtml = htmlParts.join('\n').trim() || '<p></p>';

  return createBook({
    metadata: { title, author, language, isDocument: true },
    chapters: [{ id: 'chapter-1', title, html: fullHtml }],
    images,
  });
}
