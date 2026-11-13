/**
 * Format registry: metadata, extensions, MIME types, and capabilities.
 */

export const FORMATS = {
  epub: {
    id: 'epub',
    label: 'EPUB',
    ext: '.epub',
    mime: 'application/epub+zip',
    read: true,
    write: true,
    description: 'Standard open ebook format (EPUB 3)',
  },
  mobi: {
    id: 'mobi',
    label: 'MOBI',
    ext: '.mobi',
    mime: 'application/x-mobipocket-ebook',
    read: true,
    write: true,
    description: 'Kindle / Mobipocket PalmDOC ebook',
  },
  pdf: {
    id: 'pdf',
    label: 'PDF',
    ext: '.pdf',
    mime: 'application/pdf',
    read: true,
    write: true,
    description: 'Portable Document Format (paginated)',
  },
  fb2: {
    id: 'fb2',
    label: 'FB2',
    ext: '.fb2',
    mime: 'application/x-fictionbook+xml',
    read: true,
    write: true,
    description: 'FictionBook 2.0 XML ebook',
  },
  html: {
    id: 'html',
    label: 'HTML',
    ext: '.html',
    mime: 'text/html;charset=utf-8',
    read: true,
    write: true,
    description: 'Self-contained single-file web book',
  },
  md: {
    id: 'md',
    label: 'Markdown',
    ext: '.md',
    mime: 'text/markdown;charset=utf-8',
    read: true,
    write: true,
    description: 'Clean Markdown document',
  },
  txt: {
    id: 'txt',
    label: 'TXT',
    ext: '.txt',
    mime: 'text/plain;charset=utf-8',
    read: true,
    write: true,
    description: 'Plain UTF-8 text',
  },
  docx: {
    id: 'docx',
    label: 'DOCX',
    ext: '.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    read: true,
    write: false,
    description: 'Word document (converts to PDF, EPUB, etc.)',
  },
};

export const INPUT_EXTENSIONS = [
  '.docx',
  '.epub',
  '.mobi',
  '.prc',
  '.azw',
  '.pdf',
  '.fb2',
  '.html',
  '.htm',
  '.xhtml',
  '.md',
  '.markdown',
  '.txt',
];

export const OUTPUT_FORMATS = Object.values(FORMATS).filter((f) => f.write);
