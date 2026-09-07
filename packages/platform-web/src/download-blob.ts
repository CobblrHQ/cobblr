// Hand a file to the browser to save. ONE copy of this, on purpose.
//
// It was hand-rolled nine times across the tree — create an object URL, make an
// anchor, click it, revoke — each with its own revoke timing, and several
// revoking synchronously, which Safari can honour before the download starts
// and quietly save nothing. A fix to any of them (that timing, an iOS fallback,
// a filename guard) had to be found and applied nine times. scripts/capabilities.ts
// carries the row that refuses a tenth.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke LATER: the click only queues the download, and a URL reclaimed before
  // the browser opens it is a silent no-op (observed on Safari).
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
