// Local PDF conversion: the CPU helper is optional, not a single point of
// failure. Text comes from the real PDF text objects; page images are rendered
// by the same pdf.js pipeline the preview uses. Nothing leaves the device.
import type { Conversion, HelperAsset } from "./helper";
import type { PDFPageProxy } from "pdfjs-dist";

export interface LocalPdfOptions {
  maxPages?: number;
  /** Renderer of one page to JPEG base64 (without a data URL prefix). */
  renderPage?: (page: PDFPageProxy) => Promise<string | null>;
}

export async function convertPdfLocally(blob: Blob, options: LocalPdfOptions = {}): Promise<Conversion> {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { default: workerUrl } = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), useSystemFonts: true });
  const doc = await task.promise;
  const maxPages = options.maxPages ?? 30;
  const pages = Math.min(doc.numPages, maxPages);
  const texts: string[] = [], images: HelperAsset[] = [];
  const render = options.renderPage ?? (async (page: PDFPageProxy) => {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1400 / base.width, 1800 / base.height) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    await page.render({ canvas, viewport }).promise;
    const url = canvas.toDataURL("image/jpeg", 0.85);
    return url.slice(url.indexOf(",") + 1);
  });
  try {
    for (let number = 1; number <= pages; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " ").trim();
      if (text) texts.push(`Страница ${number}:\n${text}`);
      const image = await render(page);
      if (image) images.push({ label: `Страница ${number}`, mime: "image/jpeg", data: image });
    }
  } finally {
    await doc.cleanup().catch(() => undefined);
  }
  const notes = ["Извлечено локально: сервис преобразования был недоступен."];
  if (doc.numPages > pages) notes.push(`Показаны первые ${pages} страниц из ${doc.numPages}.`);
  return { kind: "pdf", text: texts.join("\n\n"), images, audio: [], notes };
}
