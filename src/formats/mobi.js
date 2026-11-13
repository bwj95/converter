import { createBook, escapeXml } from '../core/ir.js';
import { extractBodyHtml, extractTitle } from '../core/xml.js';
import { stripExtension } from '../core/detect.js';

const PALM_EPOCH_OFFSET = 2082844800;

function readU16(u8, off) {
  return (u8[off] << 8) | u8[off + 1];
}

function readU32(u8, off) {
  return ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]) >>> 0;
}

function writeU16(arr, off, val) {
  arr[off] = (val >>> 8) & 0xff;
  arr[off + 1] = val & 0xff;
}

function writeU32(arr, off, val) {
  arr[off] = (val >>> 24) & 0xff;
  arr[off + 1] = (val >>> 16) & 0xff;
  arr[off + 2] = (val >>> 8) & 0xff;
  arr[off + 3] = val & 0xff;
}

function decompressPalmDoc(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const b = src[i++];
    if (b === 0x00) {
      out.push(0);
    } else if (b <= 0x08) {
      for (let j = 0; j < b && i < src.length; j++) {
        out.push(src[i++]);
      }
    } else if (b <= 0x7f) {
      out.push(b);
    } else if (b <= 0xbf) {
      if (i >= src.length) break;
      const b2 = src[i++];
      const pair = (b << 8) | b2;
      const dist = (pair >> 3) & 0x07ff;
      const len = (pair & 0x07) + 3;
      const start = out.length - dist;
      for (let j = 0; j < len; j++) {
        out.push(start + j >= 0 ? out[start + j] : 0x20);
      }
    } else {
      out.push(0x20);
      out.push(b ^ 0x80);
    }
  }
  return new Uint8Array(out);
}

function compressPalmDoc(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    // Try backreference in 2047-byte window (max len 10)
    let bestDist = 0;
    let bestLen = 0;
    const minStart = Math.max(0, i - 2047);
    const maxLen = Math.min(10, src.length - i);

    if (maxLen >= 3) {
      for (let pos = i - 1; pos >= minStart; pos--) {
        if (src[pos] !== src[i]) continue;
        let len = 1;
        while (len < maxLen && src[pos + len] === src[i + len]) {
          len++;
        }
        if (len > bestLen) {
          bestLen = len;
          bestDist = i - pos;
          if (bestLen === 10) break;
        }
      }
    }

    if (bestLen >= 3) {
      const pair = 0x8000 | (bestDist << 3) | (bestLen - 3);
      out.push((pair >> 8) & 0xff, pair & 0xff);
      i += bestLen;
      continue;
    }

    // Space + ASCII char optimization
    if (src[i] === 0x20 && i + 1 < src.length && src[i + 1] >= 0x40 && src[i + 1] <= 0x7f) {
      out.push(src[i + 1] ^ 0x80);
      i += 2;
      continue;
    }

    // Literal byte
    const b = src[i];
    if (b === 0x00 || (b >= 0x09 && b <= 0x7f)) {
      out.push(b);
      i++;
    } else {
      // Collect up to 8 high/control bytes
      const chunk = [];
      while (i < src.length && chunk.length < 8) {
        const c = src[i];
        if (c === 0x00 || (c >= 0x09 && c <= 0x7f)) break;
        chunk.push(c);
        i++;
      }
      out.push(chunk.length);
      for (const c of chunk) out.push(c);
    }
  }
  return new Uint8Array(out);
}

function sniffImageMime(u8) {
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
  if (u8.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
  if (u8.length >= 3 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image/gif';
  return null;
}

export async function parseMobi(bytes, filename = 'book.mobi') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 96) throw new Error('Invalid MOBI file: too small.');

  const dbName = new TextDecoder('ascii').decode(u8.slice(0, 32)).replace(/\0+$/, '').trim();
  const numRecords = readU16(u8, 76);
  if (numRecords < 2) throw new Error('Invalid MOBI file: missing records.');

  const offsets = [];
  for (let i = 0; i < numRecords; i++) {
    offsets.push(readU32(u8, 78 + i * 8));
  }
  const getRecord = (idx) => {
    const start = offsets[idx];
    const end = idx + 1 < numRecords ? offsets[idx + 1] : u8.length;
    return u8.slice(start, end);
  };

  const rec0 = getRecord(0);
  const compression = readU16(rec0, 0);
  const textRecordCount = readU16(rec0, 8);
  const encryption = readU16(rec0, 12);

  if (encryption !== 0) {
    throw new Error('DRM-encrypted MOBI files are not supported.');
  }
  if (compression === 17480) {
    throw new Error('HUFF/CDIC compressed MOBI is not supported yet (only uncompressed and PalmDOC LZ77).');
  }

  let encoding = 'utf-8';
  let title = dbName || stripExtension(filename);
  let author = 'Unknown Author';
  let publisher = '';
  let description = '';
  let language = 'en';
  let firstImageIndex = textRecordCount + 1;

  // Check MOBI header
  if (rec0.length >= 132 && String.fromCharCode(...rec0.slice(16, 20)) === 'MOBI') {
    const mobiHeaderLen = readU32(rec0, 20);
    const encCode = readU32(rec0, 28);
    encoding = encCode === 1252 ? 'windows-1252' : 'utf-8';

    const fullNameOffset = readU32(rec0, 84);
    const fullNameLen = readU32(rec0, 88);
    if (fullNameLen > 0 && fullNameOffset + fullNameLen <= rec0.length) {
      title = new TextDecoder(encoding, { fatal: false }).decode(
        rec0.slice(fullNameOffset, fullNameOffset + fullNameLen)
      ) || title;
    }

    if (mobiHeaderLen >= 96) {
      const imgIdx = readU32(rec0, 108);
      if (imgIdx > 0 && imgIdx < numRecords) firstImageIndex = imgIdx;
    }

    const exthFlags = readU32(rec0, 128);
    const exthStart = 16 + mobiHeaderLen;
    if ((exthFlags & 0x40) !== 0 && exthStart + 12 <= rec0.length) {
      if (String.fromCharCode(...rec0.slice(exthStart, exthStart + 4)) === 'EXTH') {
        const exthCount = readU32(rec0, exthStart + 8);
        let pos = exthStart + 12;
        const decoder = new TextDecoder(encoding, { fatal: false });
        for (let r = 0; r < exthCount && pos + 8 <= rec0.length; r++) {
          const type = readU32(rec0, pos);
          const len = readU32(rec0, pos + 4);
          if (len < 8 || pos + len > rec0.length) break;
          const valBytes = rec0.slice(pos + 8, pos + len);
          if (type === 100) author = decoder.decode(valBytes).trim() || author;
          else if (type === 101) publisher = decoder.decode(valBytes).trim();
          else if (type === 103) description = decoder.decode(valBytes).trim();
          else if (type === 503) title = decoder.decode(valBytes).trim() || title;
          else if (type === 524) language = decoder.decode(valBytes).trim() || language;
          pos += len;
        }
      }
    }
  }

  // Decompress text records
  const chunks = [];
  let totalLen = 0;
  for (let i = 1; i <= textRecordCount && i < numRecords; i++) {
    const rec = getRecord(i);
    const dec = compression === 2 ? decompressPalmDoc(rec) : rec;
    chunks.push(dec);
    totalLen += dec.length;
  }

  const allTextBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    allTextBytes.set(c, offset);
    offset += c.length;
  }

  const rawHtml = new TextDecoder(encoding, { fatal: false }).decode(allTextBytes);

  // Extract images
  const images = [];
  for (let i = firstImageIndex; i < numRecords; i++) {
    const rec = getRecord(i);
    const mime = sniffImageMime(rec);
    if (mime) {
      const idx = images.length + 1;
      const ext = mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : 'jpg';
      images.push({
        id: `img-${idx}`,
        href: `images/img-${idx}.${ext}`,
        mimeType: mime,
        data: rec,
      });
    }
  }

  // Rewrite recindex="00001" references if any
  let body = extractBodyHtml(rawHtml);
  body = body.replace(/(<img\b[^>]*?)\brecindex=["'](\d+)["']([^>]*>)/gi, (full, pre, idxStr, post) => {
    const imgIdx = parseInt(idxStr, 10) - 1;
    const img = images[imgIdx];
    return img ? `${pre}src="${img.href}"${post}` : full;
  });

  // Split chapters on <mbp:pagebreak/> or <h1>
  let parts = body.split(/<mbp:pagebreak\s*\/?>/gi).filter((p) => p.trim());
  if (parts.length <= 1) {
    const h1Parts = body.split(/(?=<h1[\s>])/i).filter((p) => p.trim());
    if (h1Parts.length > 1) parts = h1Parts;
  }

  const chapters = (parts.length ? parts : [body]).map((html, idx) => ({
    id: `chapter-${idx + 1}`,
    title: extractTitle(html) || (parts.length > 1 ? `Chapter ${idx + 1}` : title),
    html,
  }));

  return createBook({
    metadata: { title, author, language, publisher, description },
    chapters,
    images,
  });
}

function buildExthRecord(type, str) {
  const data = new TextEncoder().encode(str);
  const buf = new Uint8Array(8 + data.length);
  writeU32(buf, 0, type);
  writeU32(buf, 4, 8 + data.length);
  buf.set(data, 8);
  return buf;
}

export async function generateMobi(book) {
  const title = book.metadata.title || 'Untitled Book';
  const author = book.metadata.author || 'Unknown Author';
  const language = book.metadata.language || 'en';

  // Assemble Mobipocket HTML
  const chapterHtml = book.chapters
    .map((ch) => {
      const hasH1 = /<h1[\s>]/i.test(ch.html);
      const heading = hasH1 ? '' : `<h1>${escapeXml(ch.title)}</h1>\n`;
      return `${heading}${ch.html}`;
    })
    .join('\n<mbp:pagebreak/>\n');

  const fullHtml = `<html><head><title>${escapeXml(title)}</title></head><body>\n${chapterHtml}\n</body></html>`;
  const textBytes = new TextEncoder().encode(fullHtml);

  // Split into 4096-byte uncompressed chunks and compress each
  const RECORD_SIZE = 4096;
  const textRecords = [];
  for (let i = 0; i < textBytes.length; i += RECORD_SIZE) {
    const slice = textBytes.subarray(i, Math.min(i + RECORD_SIZE, textBytes.length));
    textRecords.push(compressPalmDoc(slice));
  }
  if (textRecords.length === 0) textRecords.push(new Uint8Array(0));

  // Build EXTH header
  const exthRecords = [
    buildExthRecord(100, author),
    buildExthRecord(503, title),
    buildExthRecord(524, language),
  ];
  if (book.metadata.publisher) exthRecords.push(buildExthRecord(101, book.metadata.publisher));
  if (book.metadata.description) exthRecords.push(buildExthRecord(103, book.metadata.description));

  const exthBodyLen = exthRecords.reduce((s, r) => s + r.length, 0);
  const exthPad = (4 - ((12 + exthBodyLen) % 4)) % 4;
  const exthTotalLen = 12 + exthBodyLen + exthPad;
  const exth = new Uint8Array(exthTotalLen);
  exth.set(new TextEncoder().encode('EXTH'), 0);
  writeU32(exth, 4, exthTotalLen);
  writeU32(exth, 8, exthRecords.length);
  let ePos = 12;
  for (const r of exthRecords) {
    exth.set(r, ePos);
    ePos += r.length;
  }

  const titleBytes = new TextEncoder().encode(title);
  const MOBI_HEADER_LEN = 232;
  const fullNameOffset = 16 + MOBI_HEADER_LEN + exthTotalLen;
  const rec0Len = fullNameOffset + titleBytes.length + 2;
  const rec0 = new Uint8Array(rec0Len);

  // PalmDOC header (16 bytes)
  writeU16(rec0, 0, 2); // compression = PalmDOC LZ77
  writeU32(rec0, 4, textBytes.length);
  writeU16(rec0, 8, textRecords.length);
  writeU16(rec0, 10, RECORD_SIZE);
  writeU16(rec0, 12, 0); // no encryption

  // MOBI header (232 bytes at offset 16)
  rec0.set(new TextEncoder().encode('MOBI'), 16);
  writeU32(rec0, 20, MOBI_HEADER_LEN);
  writeU32(rec0, 24, 2); // Mobipocket Book
  writeU32(rec0, 28, 65001); // UTF-8
  writeU32(rec0, 32, Math.floor(Math.random() * 0xffffffff));
  writeU32(rec0, 36, 6); // file version 6
  for (let off = 40; off <= 76; off += 4) writeU32(rec0, off, 0xffffffff);
  writeU32(rec0, 80, textRecords.length + 1); // first non-book index
  writeU32(rec0, 84, fullNameOffset);
  writeU32(rec0, 88, titleBytes.length);
  writeU32(rec0, 92, 9); // English locale
  writeU32(rec0, 104, 6);
  const firstImageIdx = textRecords.length + 1;
  writeU32(rec0, 108, firstImageIdx);
  writeU32(rec0, 128, 0x40); // EXTH present

  rec0.set(exth, 16 + MOBI_HEADER_LEN);
  rec0.set(titleBytes, fullNameOffset);

  const imageRecords = (book.images || []).map((img) =>
    img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data)
  );

  // EOF marker record
  const eofRec = new Uint8Array([0xe9, 0x8e, 0x0d, 0x0a]);
  const allRecords = [rec0, ...textRecords, ...imageRecords, eofRec];

  // Assemble PalmDB container
  const headerSize = 78 + allRecords.length * 8 + 2;
  const totalBytes = headerSize + allRecords.reduce((s, r) => s + r.length, 0);
  const out = new Uint8Array(totalBytes);

  const dbNameBytes = new TextEncoder().encode(title.replace(/[^\x20-\x7e]/g, '_')).slice(0, 31);
  out.set(dbNameBytes, 0);
  const nowPalm = Math.floor(Date.now() / 1000) + PALM_EPOCH_OFFSET;
  writeU32(out, 36, nowPalm);
  writeU32(out, 40, nowPalm);
  out.set(new TextEncoder().encode('BOOKMOBI'), 60);
  writeU16(out, 76, allRecords.length);

  let dataOffset = headerSize;
  for (let i = 0; i < allRecords.length; i++) {
    const entryOff = 78 + i * 8;
    writeU32(out, entryOff, dataOffset);
    writeU32(out, entryOff + 4, i);
    out.set(allRecords[i], dataOffset);
    dataOffset += allRecords[i].length;
  }

  return out;
}
