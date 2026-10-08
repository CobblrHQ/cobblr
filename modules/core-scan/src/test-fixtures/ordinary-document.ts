export function ordinaryPdf(label = "Pattern", sizeBytes = 0): Buffer {
  return textPdf(`Knitting pattern: ${label}`, sizeBytes);
}

export function textPdf(label: string, sizeBytes = 0): Buffer {
  const text = label.replace(/[^\x20-\x7e]/g, " ").replace(/[\\()]/g, "\\$&");
  const stream = `BT /F1 14 Tf 30 150 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
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
