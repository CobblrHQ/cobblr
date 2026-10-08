import { lazy, Suspense, useState } from "react";
import type { BarcodeCaptureProps } from "@cobblr/platform-web";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";

const ScanOneSheet = lazy(() => import("./ScanOneSheet").then((m) => ({ default: m.ScanOneSheet })));

export function FormBarcodeCapture({ scope, onCode }: BarcodeCaptureProps) {
  const [open, setOpen] = useState(false);
  useBarcodeWedge({ onScan: onCode, formScope: scope });
  return <>
    <button type="button" className="rounded-md border border-line dark:border-slate-700 px-3 py-2 text-sm" onClick={() => setOpen(true)}>Scan to fill</button>
    {open && <Suspense fallback={null}>
      <ScanOneSheet open={open} title="Scan to fill" hint="Aim at the barcode on the item or its box." onClose={() => setOpen(false)} onCode={(code) => { setOpen(false); onCode(code); }} />
    </Suspense>}
  </>;
}
