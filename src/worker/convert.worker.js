import { convertBook, inspectBook } from '../core/convert.js';

self.onmessage = async (event) => {
  const { id, action, payload } = event.data;

  try {
    if (action === 'inspect') {
      const bytes = new Uint8Array(payload.buffer);
      const result = await inspectBook(bytes, payload.filename);
      // Strip raw Uint8Array image buffers from preview payload to keep IPC fast
      const previewBook = {
        metadata: result.book.metadata,
        chapters: result.book.chapters.map((c) => ({
          id: c.id,
          title: c.title,
          html: c.html,
        })),
      };
      self.postMessage({
        id,
        ok: true,
        result: {
          sourceFormat: result.sourceFormat,
          stats: result.stats,
          book: previewBook,
        },
      });
      return;
    }

    if (action === 'convert') {
      const bytes = new Uint8Array(payload.buffer);
      const result = await convertBook({
        bytes,
        filename: payload.filename,
        sourceFormat: payload.sourceFormat,
        targetFormat: payload.targetFormat,
        metadataOverride: payload.metadataOverride,
        options: payload.options,
        onProgress: (progress, message) => {
          self.postMessage({ id, type: 'progress', progress, message });
        },
      });

      const outBuffer = result.outputBytes.buffer;
      self.postMessage(
        {
          id,
          ok: true,
          result: {
            outputBuffer: outBuffer,
            outputName: result.outputName,
            mimeType: result.mimeType,
            sourceFormat: result.sourceFormat,
            targetFormat: result.targetFormat,
            stats: result.stats,
            metadata: result.book.metadata,
          },
        },
        [outBuffer]
      );
      return;
    }

    throw new Error(`Unknown worker action: ${action}`);
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err?.message || String(err),
    });
  }
};
