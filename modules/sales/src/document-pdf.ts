import { PDFDocument, StandardFonts } from "pdf-lib";
import { documentText, type SalesDocument, type DocumentPayment } from "./invoice.js";

export async function documentPdf(document: SalesDocument, payment: DocumentPayment = { paid: false, paid_on: null }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${document.kind === "quote" ? "Quote" : "Invoice"} ${document.number}`);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage([595.28, 841.89]);
  let y = page.getHeight() - 48;
  if (document.logo) {
    const bytes = Buffer.from(document.logo.base64, "base64");
    const image = document.logo.mime === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const size = image.scaleToFit(140, 65);
    page.drawImage(image, { x: 48, y: y - size.height, ...size });
    y -= size.height + 22;
  }
  // Keep unsupported characters visible as Unicode escapes, as the insurance PDF does.
  const printable = (s: string) => [...s].map(c => { try { font.encodeText(c); return c; } catch { return `\\u{${c.codePointAt(0)!.toString(16)}}`; } }).join("");
  const draw = (text: string, size: number) => {
    if (y < 48) { page = pdf.addPage([595.28, 841.89]); y = page.getHeight() - 48; }
    page.drawText(text, { x: 48, y, font, size });
    y -= size + 7;
  };
  for (const [index, row] of documentText(document, payment).split("\n").entries()) {
    const size = index < 2 ? 16 : 10;
    let line = "";
    for (const c of printable(row)) {
      if (font.widthOfTextAtSize(line + c, size) > page.getWidth() - 96) { draw(line, size); line = ""; }
      line += c;
    }
    draw(line, size);
  }
  return pdf.save();
}
