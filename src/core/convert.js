import { detectFormat, stripExtension } from './detect.js';
import { FORMATS } from './registry.js';
import { getBookStats } from './ir.js';
import { parseEpub, generateEpub } from '../formats/epub.js';
import { parseMobi, generateMobi } from '../formats/mobi.js';
import { parsePdf, generatePdf } from '../formats/pdf.js';
import { parseFb2, generateFb2 } from '../formats/fb2.js';
import { parseHtml, generateHtml } from '../formats/html.js';
import { parseMarkdown, generateMarkdown } from '../formats/markdown.js';
import { parseTxt, generateTxt } from '../formats/txt.js';
import { parseDocx } from '../formats/docx.js';

const PARSERS = {
  epub: parseEpub,
  mobi: parseMobi,
  pdf: parsePdf,
  fb2: parseFb2,
  html: parseHtml,
  md: parseMarkdown,
  txt: parseTxt,
  docx: parseDocx,
};

const GENERATORS = {
  epub: generateEpub,
  mobi: generateMobi,
  pdf: generatePdf,
  fb2: generateFb2,
  html: generateHtml,
  md: generateMarkdown,
  txt: generateTxt,
};

export async function inspectBook(bytes, filename) {
  const format = detectFormat(bytes, filename);
  if (!format || !PARSERS[format]) {
    throw new Error(`Unsupported input format for "${filename}".`);
  }
  const book = await PARSERS[format](bytes, filename);
  return {
    sourceFormat: format,
    book,
    stats: getBookStats(book),
  };
}

export async function convertBook({ bytes, filename, sourceFormat, targetFormat, metadataOverride, options, onProgress }) {
  const srcFmt = sourceFormat || detectFormat(bytes, filename);
  if (!srcFmt || !PARSERS[srcFmt]) {
    throw new Error(`Unsupported input format for "${filename}".`);
  }
  if (!targetFormat || !GENERATORS[targetFormat]) {
    throw new Error(`Unsupported target format "${targetFormat}".`);
  }

  if (onProgress) onProgress(0.15, `Parsing ${FORMATS[srcFmt].label}...`);
  const book = await PARSERS[srcFmt](bytes, filename, (p, msg) => {
    if (onProgress) onProgress(0.15 + p * 0.4, msg);
  });

  if (metadataOverride) {
    book.metadata = {
      ...book.metadata,
      ...Object.fromEntries(
        Object.entries(metadataOverride).filter(([, v]) => v !== undefined && v !== '')
      ),
    };
  }

  if (onProgress) onProgress(0.6, `Generating ${FORMATS[targetFormat].label}...`);
  const outBytes = await GENERATORS[targetFormat](book, options || {}, (p, msg) => {
    if (onProgress) onProgress(0.6 + p * 0.38, msg);
  });

  const outName = `${stripExtension(filename)}${FORMATS[targetFormat].ext}`;
  if (onProgress) onProgress(1, 'Done');

  return {
    outputBytes: outBytes instanceof Uint8Array ? outBytes : new Uint8Array(outBytes),
    outputName: outName,
    mimeType: FORMATS[targetFormat].mime,
    sourceFormat: srcFmt,
    targetFormat,
    book,
    stats: getBookStats(book),
  };
}
