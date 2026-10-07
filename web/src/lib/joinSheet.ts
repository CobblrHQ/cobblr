// The sheet a club tapes to its closet wall: the workspace's name, the join
// link's QR, and one line on what happens next (#3801). Its own window, so
// the browser prints the sheet and nothing of the app around it.

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The words on the sheet, apart from the page, so they can be read in a test. */
export function joinSheetText(workspace: string): { title: string; line: string } {
  return {
    title: `Scan to join ${workspace}`,
    line: "Then scan the label on anything you take, and press −1.",
  };
}

export async function printJoinSheet(opts: { url: string; workspace: string }): Promise<boolean> {
  const { default: QRCode } = await import("qrcode");
  const qr = await QRCode.toDataURL(opts.url, { margin: 1, errorCorrectionLevel: "M", width: 640 });
  const w = window.open("", "_blank", "noopener=no");
  if (!w) return false;
  const t = joinSheetText(opts.workspace);
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.title)}</title>
<style>
  @page { size: auto; margin: 16mm; }
  body { font-family: system-ui, sans-serif; text-align: center; color: #1c1917; }
  h1 { font-size: 34px; margin: 8mm 0 6mm; }
  img { width: 120mm; max-width: 90vw; height: auto; image-rendering: pixelated; }
  p { font-size: 20px; margin: 6mm auto 0; max-width: 150mm; }
  .url { font-size: 12px; color: #57534e; word-break: break-all; margin-top: 8mm; }
</style></head><body>
  <h1>${esc(t.title)}</h1>
  <img src="${qr}" alt="QR code to join ${esc(opts.workspace)}" />
  <p>${esc(t.line)}</p>
  <div class="url">${esc(opts.url)}</div>
  <script>window.onload = () => { window.focus(); window.print(); };</script>
</body></html>`);
  w.document.close();
  return true;
}
