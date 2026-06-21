import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";
import { api, ApiError } from "../lib/api";

/**
 * App-wide hardware-scanner (keyboard-wedge) intake.
 *
 * A USB/Bluetooth barcode scanner is a GLOBAL input device — you expect a scan
 * to register from anywhere, not only while the Scan tab happens to be open.
 * Previously the wedge was bound only inside ScanPage, so a physical scan from
 * any other screen beeped on the device but landed nowhere and gave no feedback
 * (the "I scanned it several times and nothing showed up" bug).
 *
 * This binds the wedge at the app shell, so a scan ANYWHERE stages an inbox item
 * and ALWAYS gives feedback: a sticky toast with a jump-to-inbox action on
 * success, or a loud error toast on failure — never a silent drop.
 *
 * On the Scan page itself, ScanPage owns the wedge (richer optimistic phantom
 * rows + scan-drive routing), so we stand down there to avoid a double intake.
 * Keystrokes aimed at a focused input/textarea/select pass through untouched
 * (that's `useBarcodeWedge`'s job) — scanning INTO the UPC field still works.
 */
export function GlobalScanWedge({ activeSlug }: { activeSlug: string }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();

  // ScanPage (and its camera) own the wedge while mounted. Paths are relative to
  // the /w/:slug router basename, so the scan routes are "/scan" and "/scan/*".
  const onScanRoute = loc.pathname === "/scan" || loc.pathname.startsWith("/scan/");

  const scan = useMutation({
    mutationFn: (code: string) =>
      api.scanBarcode(activeSlug, { barcode: code, source_kind: "barcode" }),
    onSuccess: (item) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      const name = item.suggested_name ?? `barcode ${item.barcode_text ?? ""}`.trim();
      toast.action(`Scanned ${name} → added to the scan inbox.`, {
        actionLabel: "View inbox",
        onAction: () => navigate("/scan"),
      });
    },
    onError: (e) =>
      toast.error(`Scan failed — ${e instanceof ApiError ? e.message : String(e)}`),
  });

  useBarcodeWedge({
    enabled: !!activeSlug && !onScanRoute,
    onScan: (code) => scan.mutate(code),
  });

  return null;
}
