import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, useToast } from "@cobblr/platform-web";
import { MapPin, ScanLine } from "lucide-react";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";
import { resolveSessionBatch } from "../lib/scanSession";
import { api, ApiError } from "../lib/api";

/**
 * App-wide hardware-scanner (keyboard-wedge) intake + Cobblr-QR navigation.
 *
 * A USB/Bluetooth barcode scanner is a GLOBAL input device — you expect a scan
 * to register from anywhere, not only while the Scan tab happens to be open.
 * Previously the wedge was bound only inside ScanPage, so a physical scan from
 * any other screen beeped on the device but landed nowhere and gave no feedback
 * (the "I scanned it several times and nothing showed up" bug).
 *
 * This binds the wedge at the app shell, so a scan ANYWHERE does the obviously
 * right thing:
 *   • a **Cobblr QR** (a printed bin / location / item label) → JUMP to that
 *     thing. This is the single-device "a scan is a driver" case — no
 *     second-screen pairing, no toggle. Gated by a one-time consent prompt whose
 *     answer is remembered per device+workspace (`cobblr.qrNav.<slug>` =
 *     `always` | `off`; unset ⇒ ask). Staging a bin label as a mystery inbox
 *     row was never useful; opening the bin is.
 *   • a **product barcode** → stage an inbox item with a sticky jump-to-inbox
 *     toast (never a silent drop).
 *
 * On the Scan page itself, ScanPage owns the wedge (richer optimistic phantom
 * rows + its own scan-drive routing + scan-to-file), so we stand down there to
 * avoid a double intake. Keystrokes aimed at a focused input/textarea/select
 * pass through untouched (that's `useBarcodeWedge`'s job).
 */

// A scanned Cobblr QR is the full label URL a scanner/camera reads: `…/qr/<token>`.
const QR_URL = /^https?:\/\/[^/]+\/qr\/([A-Za-z0-9_-]{16,})$/;

type QrNavPref = "always" | "off" | null;
const prefKey = (slug: string) => `cobblr.qrNav.${slug}`;
function getQrNavPref(slug: string): QrNavPref {
  const v = localStorage.getItem(prefKey(slug));
  return v === "always" || v === "off" ? v : null;
}
function setQrNavPref(slug: string, v: Exclude<QrNavPref, null>): void {
  localStorage.setItem(prefKey(slug), v);
}

/** A friendly noun for the consent prompt, from the resolved entity kind
 *  (`core-locations:location` → "location"). Generic fallback so a new kind
 *  never breaks the copy. */
function kindNoun(kind: string | undefined): string {
  const k = (kind ?? "").split(":").pop() ?? "";
  if (k === "location") return "location";
  if (k === "item" || k.endsWith("_item")) return "item";
  return k || "label";
}

interface ResolvedQr {
  path: string;
  noun: string;
}

export function GlobalScanWedge({ activeSlug }: { activeSlug: string }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  // Set when a QR resolved but we haven't been told whether to auto-jump — the
  // one-time consent prompt. Cleared by any of its three choices.
  const [ask, setAsk] = useState<ResolvedQr | null>(null);

  // ScanPage (and its camera) own the wedge while mounted. Paths are relative to
  // the /w/:slug router basename, so the scan routes are "/scan" and "/scan/*".
  const onScanRoute = loc.pathname === "/scan" || loc.pathname.startsWith("/scan/");

  const scan = useMutation({
    mutationFn: async (code: string) => {
      // Group consecutive hardware scans into a time-gap session so they land in
      // one batch (and stop being sessionless). A failed mint just means
      // un-batched — never blocks the scan.
      const batchId = await resolveSessionBatch(activeSlug, () =>
        api.createScanBatch(activeSlug).then((b) => b.id).catch(() => null),
      );
      return api.scanBarcode(activeSlug, {
        barcode: code,
        source_kind: "barcode",
        ...(batchId ? { scan_batch_id: batchId } : {}),
      });
    },
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

  function goTo(r: ResolvedQr) {
    navigate(r.path);
    toast.success(`Opened the scanned ${r.noun}`);
  }

  // Resolve a scanned Cobblr QR and act on it. Returns true when handled (so the
  // caller doesn't fall through to product-barcode intake).
  async function handleQr(token: string): Promise<void> {
    const resolved = await api.resolveQrToken(token);
    if (!resolved?.detail_path) {
      // A `…/qr/…` shaped scan that doesn't resolve is a dead or foreign label —
      // it's not a product barcode, so don't stage it. Say so instead of a
      // silent drop.
      toast.error("That QR label didn't resolve to anything here.");
      return;
    }
    if (resolved.org_slug && resolved.org_slug !== activeSlug) {
      toast.error("That label belongs to a different workspace.");
      return;
    }
    const r: ResolvedQr = { path: resolved.detail_path, noun: kindNoun(resolved.entity_kind) };
    const pref = getQrNavPref(activeSlug);
    if (pref === "always") {
      goTo(r);
    } else if (pref === "off") {
      // Respect the opt-out, but never silent: offer to open this one and turn
      // jumping back on (the recovery path from a past "No").
      toast.action(`Scanned a ${r.noun} label — auto-jump is off.`, {
        actionLabel: "Open + turn on",
        onAction: () => {
          setQrNavPref(activeSlug, "always");
          goTo(r);
        },
      });
    } else {
      setAsk(r); // first time: ask, and remember the answer
    }
  }

  useBarcodeWedge({
    enabled: !!activeSlug && !onScanRoute,
    onScan: (code) => {
      const m = QR_URL.exec(code.trim());
      if (m) {
        void handleQr(m[1] ?? "");
        return;
      }
      scan.mutate(code);
    },
  });

  return (
    <Modal open={!!ask} onClose={() => setAsk(null)} title="Jump to scanned labels?" size="sm">
      {ask && (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-cobble-50 dark:bg-cobble-900/30 p-2 shrink-0">
              {ask.noun === "location" ? (
                <MapPin size={18} className="text-accent" />
              ) : (
                <ScanLine size={18} className="text-accent" />
              )}
            </div>
            <div className="text-sm text-content dark:text-mortar-200">
              You scanned a Cobblr <strong>{ask.noun}</strong> label. Want scanned QR
              labels to jump this screen straight to what they point at? A USB or
              Bluetooth scanner then works like a remote for the app.
              <div className="mt-1 text-xs text-muted dark:text-slate-400">
                Applies on every page except the Scan inbox. You can change it later.
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
            <button
              type="button"
              onClick={() => { setQrNavPref(activeSlug, "off"); setAsk(null); }}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
            >
              No
            </button>
            <button
              type="button"
              onClick={() => { const r = ask; setAsk(null); goTo(r); }}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
            >
              Just this once
            </button>
            <button
              type="button"
              onClick={() => { const r = ask; setQrNavPref(activeSlug, "always"); setAsk(null); goTo(r); }}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-cobble-600 hover:bg-cobble-700 text-white transition"
            >
              Always jump
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
