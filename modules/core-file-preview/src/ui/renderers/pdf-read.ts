// Reading a PDF for the viewer: how many pages, and each page's size, from
// the bytes, with the library handed in (the browser build in the viewer,
// the legacy build under node in a test). Eval is off: a PDF is an untrusted
// upload, and pdf.js's font path is the one that has run code from a file.

export interface PdfLib {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean }): { promise: Promise<PdfDoc> };
}
export interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
export interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas?: HTMLCanvasElement }): { promise: Promise<void> };
}

/** Opens the document. The bytes are copied, because pdf.js takes
 *  ownership of the buffer it is given and the caller keeps its own. */
export async function openPdf(bytes: ArrayBuffer, lib: PdfLib): Promise<PdfDoc> {
  return lib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
}

/** The page sizes at scale 1, in order. */
export async function pageSizes(doc: PdfDoc): Promise<Array<{ width: number; height: number }>> {
  const out: Array<{ width: number; height: number }> = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const v = (await doc.getPage(n)).getViewport({ scale: 1 });
    out.push({ width: v.width, height: v.height });
  }
  return out;
}

/** The scale that fits a page to the width available, never above 2 so a
 *  small page on a wide screen is not blown up into blur. */
export function fitScale(pageWidth: number, available: number): number {
  if (!(pageWidth > 0) || !(available > 0)) return 1;
  return Math.min(2, available / pageWidth);
}

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
