// A PDF's first page as a small picture, for a document's thumbnail
// (<DocThumb>). Drawn in the browser by pdf.js from the stored file, at view
// time: nothing is stored and no server draws anything, so every door a PDF
// arrives by (a paste, a drop, an upload, an email) gets one. Eval is off, as
// in the viewer (pdf-read.ts).
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { openPdf, type PdfLib } from "./pdf-read";

/** Page 1 at `width` CSS pixels (drawn at twice that for a sharp tile), as a
 *  data URL, or null when the PDF cannot be drawn (encrypted, corrupt). */
export default async function pdfFirstPage(bytes: ArrayBuffer, width: number): Promise<string | null> {
  const pdfjs = (await import("pdfjs-dist")) as unknown as PdfLib & { GlobalWorkerOptions: { workerSrc: string } };
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await openPdf(bytes, pdfjs);
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width * 2) / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    void doc.destroy();
  }
}
