import { createOrganizer } from './organize.js';
import { createAnnotator } from './annotate.js';

export function initPdfTools() {
  const subTabs = [...document.querySelectorAll('[data-pdf-subtab]')];
  const subPanels = [...document.querySelectorAll('[data-pdf-panel]')];

  function setSubTab(name) {
    subTabs.forEach((b) => {
      const active = b.dataset.pdfSubtab === name;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    subPanels.forEach((p) => {
      p.hidden = p.dataset.pdfPanel !== name;
    });
  }

  subTabs.forEach((b) => b.addEventListener('click', () => setSubTab(b.dataset.pdfSubtab)));

  const annotator = createAnnotator();
  const organizer = createOrganizer({
    onSendToEditor: async (bytes, name) => {
      setSubTab('edit');
      await annotator.loadPdf(bytes, name);
    },
  });

  setSubTab('organize');
  return { organizer, annotator, setSubTab };
}
