export async function decodeBarcodeImage(file: File): Promise<string | null> {
  // A page that cannot open an image has nothing to decode: answered before
  // the decoder (about 120 KB) is fetched at all.
  if (typeof createImageBitmap !== "function") return null;
  const { createBarcodeReader, decodeCanvasSmart } = await import("./barcodeDecode");
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return decodeCanvasSmart(createBarcodeReader(), canvas, document.createElement("canvas")).text;
  } finally { image.close(); }
}
