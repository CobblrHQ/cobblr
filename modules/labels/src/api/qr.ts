// QR rendering. Uses the `qrcode` package to emit an SVG string the
// UI can drop into the DOM. SVG > PNG here because labels print at
// arbitrary sizes and we want crisp QRs regardless of zoom.

import QRCode from "qrcode";

export async function qrSvg(payload: string, opts: { margin?: number } = {}): Promise<string> {
  return QRCode.toString(payload, {
    type: "svg",
    margin: opts.margin ?? 1,
    errorCorrectionLevel: "M",
  });
}
