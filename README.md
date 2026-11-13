# Converter — Browser Ebook & Document Converter

A 100% client-side, zero-backend ebook and document converter that runs entirely in your browser using ES Modules and Web Workers.

Convert between **EPUB**, **MOBI**, **PDF**, **FB2**, **HTML**, **Markdown**, and **TXT** with zero uploads, zero server costs, and no build step required.

## Features

- **100% Local & Private**: All parsing and generation runs inside a browser Web Worker. Files never leave your device.
- **7 Formats (Read & Write)**:
  - **EPUB** (`.epub`) — EPUB 2/3 reader & EPUB 3 writer (with `nav.xhtml`, `toc.ncx`, and embedded images)
  - **MOBI** (`.mobi`, `.prc`) — Native PalmDB + PalmDOC LZ77 + MOBI6 + EXTH metadata codec (DRM-free)
  - **PDF** (`.pdf`) — Text & structure extraction via PDF.js; paginated ebook PDF export via `pdf-lib` (custom page sizes, fonts, margins, page numbers)
  - **FB2** (`.fb2`) — FictionBook 2.0 XML with embedded base64 images
  - **HTML** (`.html`, `.htm`) — Self-contained single-file web book with inline CSS & base64 images
  - **Markdown** (`.md`) — Frontmatter + GFM-style headings, lists, blockquotes, and code blocks
  - **TXT** (`.txt`) — Smart chapter heading detection and clean plain-text formatting
- **Batch Queue & ZIP Export**: Drop multiple files, convert all at once, and download individually or as a single `.zip`.
- **Book Inspector & Metadata Editor**: Preview parsed chapters and edit Title, Author, Language, and Publisher before exporting.
- **Zero Build Step**: Pure ES Modules + vendored MIT/Apache-2.0 browser libraries in `vendor/`.

## Running Locally

Because browsers restrict ES Modules and Web Workers over `file://`, serve the directory with any static HTTP server:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Hosting on GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, select **Deploy from a branch** → `main` / `/ (root)`.
4. Save — your converter will be live at `https://<username>.github.io/<repo>/`.

## Architecture

```
Input File ─▶ Format Sniffer (src/core/detect.js)
           ─▶ Format Parser  (src/formats/*.js)
           ─▶ Canonical Book IR (metadata, chapters[], images[])
           ─▶ Format Generator (src/formats/*.js)
           ─▶ Output Blob (inside src/worker/convert.worker.js)
```

## Third-Party Libraries (Vendored)

- [`fflate`](https://github.com/101arrowz/fflate) — MIT License
- [`pdf-lib`](https://github.com/Hopding/pdf-lib) — MIT License
- [`pdfjs-dist`](https://github.com/mozilla/pdf.js) — Apache-2.0 License
