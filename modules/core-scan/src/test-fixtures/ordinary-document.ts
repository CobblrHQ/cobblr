export function titlePatternPdf(): Buffer {
  return textPdf([
    "Baby Turtles | EN-053 | Crochet pattern",
    "Materials",
    "Yarn: 60 m of worsted weight acrylic yarn.",
    "Hook: 3.5 mm crochet hook.",
    "Notions: 4 safety eyes, size 6 mm.",
    "Baby Turtles | EN-053 | Crochet pattern",
  ]);
}

export function ordinaryPdf(label = "Pattern", sizeBytes = 0): Buffer {
  return textPdf(`Knitting pattern: ${label}`, sizeBytes);
}

export function textPdf(label: string | readonly string[], sizeBytes = 0): Buffer {
  const multiline = typeof label !== "string";
  const lines = (typeof label === "string" ? [label] : label)
    .map((line) => line.replace(/[^\x20-\x7e]/g, " ").replace(/[\\()]/g, "\\$&"));
  const stream = multiline
    ? `BT /F1 12 Tf 18 TL 30 750 Td ${lines.map((line) => `(${line}) Tj`).join(" T* ")} ET`
    : `BT /F1 14 Tf 30 150 Td (${lines[0]}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${multiline ? "612 792" : "300 200"}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let body = "%PDF-1.4\n"; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const finish = (xref: number) => `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pdf = Buffer.from(body + finish(Buffer.byteLength(body)));
  if (sizeBytes <= pdf.length) return pdf;
  let tail = finish(sizeBytes);
  for (let pass = 0; pass < 3; pass++) tail = finish(sizeBytes - Buffer.byteLength(tail));
  const padded = Buffer.alloc(sizeBytes, 0x20);
  Buffer.from(body).copy(padded);
  Buffer.from(tail).copy(padded, sizeBytes - Buffer.byteLength(tail));
  return padded;
}

export function imagePdf(jpeg: Buffer, width: number, height: number, textLayer = ""): Buffer {
  const words = textLayer.replace(/[\\()]/g, "\\$&");
  const stream = `q 650 0 0 500 0 0 cm /Image1 Do Q${words ? ` BT /F1 12 Tf 10 485 Td (${words}) Tj ET` : ""}`;
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 650 500] /Resources << /XObject << /Image1 5 0 R >> /Font << /F1 6 0 R >> >> /Contents 4 0 R >>"),
    Buffer.from(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")]; const offsets: number[] = []; let offset = parts[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(offset); const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]); parts.push(part); offset += part.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** A PDF of many pages, each with its own text layer, and optionally a JPEG
 *  drawn full-page on some of them: a tiled print-at-home pattern, or the same
 *  with one page that is a scan (#9360). */
export function pagedPdf(pages: ReadonlyArray<{ text: string; jpeg?: { bytes: Buffer; width: number; height: number } }>): Buffer {
  const objects: Buffer[] = [];
  const add = (b: Buffer) => { objects.push(b); return objects.length; };
  const catalog = add(Buffer.alloc(0));
  const pagesObj = add(Buffer.alloc(0));
  const font = add(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  const kids: number[] = [];
  for (const p of pages) {
    const words = p.text.replace(/[^\x20-\x7e]/g, " ").replace(/[\\()]/g, "\\$&");
    const image = p.jpeg ? add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${p.jpeg.width} /Height ${p.jpeg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.bytes.length} >>\nstream\n`), p.jpeg.bytes, Buffer.from("\nendstream")])) : 0;
    const stream = `${image ? "q 612 0 0 792 0 0 cm /Im1 Do Q " : ""}BT /F1 12 Tf 40 750 Td (${words}) Tj ET 0.5 w 40 40 m 572 40 l 572 700 l 40 700 l h S`;
    const content = add(Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`));
    const res = `<< /Font << /F1 ${font} 0 R >>${image ? ` /XObject << /Im1 ${image} 0 R >>` : ""} >>`;
    kids.push(add(Buffer.from(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents ${content} 0 R >>`)));
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  objects[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  const parts = [Buffer.from("%PDF-1.4\n")]; const offsets: number[] = []; let offset = parts[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(offset); const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]); parts.push(part); offset += part.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(parts);
}
