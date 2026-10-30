// "Scan to fill"'s box, shared by the button (FormBarcodeCapture) and the place
// the shell holds for it while that button's code loads (WorkspacePlatformWeb),
// so the two are the same size and nothing under the button moves when it
// arrives. A plain element: importing it does not bring the button's code.

export const SCAN_TO_FILL_BOX = "rounded-md border border-line dark:border-slate-700 px-3 py-2 text-sm";

export function ScanToFillPlace() {
  return <span aria-hidden="true" data-testid="scan-to-fill-place" className={"inline-block invisible " + SCAN_TO_FILL_BOX}>Scan to fill</span>;
}
