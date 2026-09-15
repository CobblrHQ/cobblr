// The ONE image picker and the ONE intake behind it, rendered by the scan
// inbox and by the home dashboard's Photos tile (#3042).
//
// The owner: "I often take pictures with my phone camera, like of a label on
// a computer monitor/TV, and later need to upload them to Cobblr. Right now
// the best/only way is to go to the scan inbox and then use the photo
// selector there. I need an additional faster way." The picker was the
// inbox's own hidden input, and the upload behind it (one session for the
// selection, one photo scan per file, the identify running server-side) was
// the inbox's own function; a second door would have meant a second copy of
// both, and the two would drift. So the input is one component with one
// `accept` and `multiple`, and the intake is one hook: what a drop, a paste,
// the inbox's button and the dashboard's tile hand it, it routes the same
// way (images as photos, a PDF or CSV as a receipt, the ask only for a
// workspace with no AI that can look at an image; UploadKindSheet).
//
// Two session shapes, because the two doors mean different things: the
// inbox clusters its uploads into the standing upload session ("inbox");
// the dashboard's tile mints a FRESH session for each selection and hands
// its id back, so the page can open the inbox with exactly those photos in
// view.

import { forwardRef, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { resolveSessionBatch } from "../lib/scanSession";
import { classifyFiles } from "../pages/omniIntake";
import { UploadKindSheet } from "./UploadKindSheet";

/** What the picker takes: a picture, or a receipt as a PDF or a CSV. One
 *  string, so no door can accept less than another. */
export const SCAN_PICKER_ACCEPT = "image/*,application/pdf,.csv,text/csv";

/** The hidden file input every door opens with `.click()`. Multi-select;
 *  resets itself so the same file can be picked twice in a row. */
export const ScanPickerInput = forwardRef<HTMLInputElement, { onFiles: (files: File[]) => void; testId?: string }>(function ScanPickerInput(
  { onFiles, testId },
  ref,
) {
  return (
    <input
      ref={ref}
      type="file"
      accept={SCAN_PICKER_ACCEPT}
      multiple
      className="hidden"
      data-testid={testId ?? "scan-photo-picker"}
      onChange={(e) => {
        const fs = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (fs.length) onFiles(fs);
      }}
    />
  );
});

export interface ScanIntakeOptions {
  /** The session the photos join. "inbox": the standing upload session (or
   *  the `?batch=` the page is scoped to); "fresh": a new session for this
   *  selection, minted here. */
  session: "inbox" | "fresh";
  /** The `?batch=` the inbox is scoped to, when it is: uploads join it. */
  batchId?: string | null;
  /** `identify_available` from /ai-status, for the one case that asks. */
  identifyAvailable?: boolean;
  /** Called once the whole selection is in, with the session it landed in
   *  (null when the batch could not be minted) and how many made it. */
  onDone?: (result: { batchId: string | null; ok: number }) => void;
}

export interface ScanIntake {
  /** Hand it what a person picked, dropped or pasted; it routes by type. */
  takeFiles: (files: File[]) => void;
  uploadPhotos: (files: File[]) => Promise<void>;
  uploadReceipt: (file: File) => Promise<void>;
  /** A stored receipt file through the parser, with the duplicate offer. */
  importReceiptFile: (fileId: string, force: boolean) => Promise<void>;
  uploading: boolean;
  /** {done,total} across a multi-photo selection; null when idle or single. */
  uploadProgress: { done: number; total: number } | null;
  /** The "a photo, or a receipt?" ask, mounted by the caller wherever its
   *  sheets go; renders nothing while the workspace can look at an image. */
  sheet: ReactNode;
}

export function useScanIntake(slug: string, opts: ScanIntakeOptions): ScanIntake {
  const qc = useQueryClient();
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  // Images the door was handed and has not routed yet (#2882).
  const [askKindFor, setAskKindFor] = useState<File[]>([]);
  // The same selection arriving twice must not become two sessions: the
  // handler is bound to more than one element on the inbox, and a
  // double-tapped tile costs the same duplicate (reported 2026-08-19).
  const lastTakeRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });

  async function uploadPhotos(files: File[]) {
    if (files.length === 0) return;
    const multi = files.length > 1;
    setUploading(true);
    if (multi) setUploadProgress({ done: 0, total: files.length });
    let ok = 0;
    let sessionBatch: string | null = null;
    try {
      // One session for the whole selection, resolved ONCE up front, so N
      // photos never scatter into N sessions or race to mint N batches.
      // "inbox": a photo added at the desk joins the standing upload
      // session, not the shelf-walk the camera is in the middle of
      // (reported 2026-08-30). "fresh": this selection is its own session.
      sessionBatch =
        opts.session === "fresh"
          ? await api.createScanBatch(slug).then((b) => b.id).catch(() => null)
          : (opts.batchId ??
            (await resolveSessionBatch(
              slug,
              () => api.createScanBatch(slug).then((b) => b.id).catch(() => null),
              Date.now(),
              "inbox",
            )));
      for (const file of files) {
        try {
          const rec = await api.uploadFile(slug, file);
          await api.scanBarcode(slug, {
            source_kind: "photo",
            image_file_id: rec.id,
            scan_batch_id: sessionBatch ?? undefined,
          });
          ok++;
          // Reveal each as it lands, so a long selection fills in progressively.
          invalidate();
        } catch (e) {
          toast.error(`${file.name}: ${e instanceof ApiError ? e.message : String(e)}`);
        }
        if (multi) setUploadProgress({ done: ok, total: files.length });
      }
      if (ok === 1) toast.success("Photo added - AI is identifying it");
      else if (ok > 1) toast.success(`${ok} photos added as one batch - AI is identifying them`);
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
    opts.onDone?.({ batchId: sessionBatch, ok });
  }

  // A receipt PDF/photo → core-ai pulls out the line items → one inbox row
  // per item, each triaged into a part below like any other scan.
  async function importReceiptFile(fileId: string, force: boolean) {
    const out = await api.scanReceipt(slug, fileId, { origin: "upload", force });
    if (out.duplicate) {
      const ex = out.existing;
      // Already imported this exact receipt (same vendor + order #). Offer to
      // import it anyway rather than silently duplicating every line.
      toast.action(
        `You already imported this receipt${ex.order_ref ? ` (#${ex.order_ref})` : ""}${ex.vendor ? ` from ${ex.vendor}` : ""} - ${ex.item_count} item${ex.item_count === 1 ? "" : "s"} already in your inbox.`,
        {
          actionLabel: "Import anyway",
          duration: 10000,
          onAction: () => void importReceiptFile(fileId, true),
        },
      );
      return;
    }
    const n = out.receipt.item_count;
    const from = out.receipt.vendor ? ` from ${out.receipt.vendor}` : "";
    const found = `${force ? "Imported" : "Found"} ${n} item${n === 1 ? "" : "s"}${from}`;
    // Lines that do not add up to what was charged are the dangerous kind of
    // nearly-right: each one looks plausible on its own. Say both numbers and
    // let the reader judge, rather than a cheerful count that hides a dropped
    // line or a coupon that never got applied.
    if (out.receipt.lines_reconcile === false && out.receipt.total != null) {
      toast.info(
        `${found}, but they add up to ${out.receipt.lines_total.toFixed(2)} and the receipt says ` +
          `${out.receipt.total.toFixed(2)}. Check for a discount, or a line that did not come through.`,
        { duration: 12000 },
      );
    } else {
      toast.success(`${found} - review below`);
    }
    invalidate();
  }

  async function uploadReceipt(file: File) {
    setUploading(true);
    try {
      const rec = await api.uploadFile(slug, file);
      await importReceiptFile(rec.id, false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  const takeFiles = (files: File[]) => {
    const intent = classifyFiles(files);
    if (!intent) return;
    // Name + size + mtime identifies a file well enough for a window this
    // short, and a second later the same file is a deliberate re-add.
    const key = files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join("|");
    const now = Date.now();
    if (key === lastTakeRef.current.key && now - lastTakeRef.current.at < 1000) return;
    lastTakeRef.current = { key, at: now };
    if (intent.kind === "photos") setAskKindFor(intent.files);
    else void uploadReceipt(intent.file);
  };

  const sheet = (
    <UploadKindSheet
      files={askKindFor}
      identifyAvailable={opts.identifyAvailable}
      onPhotos={(files) => void uploadPhotos(files)}
      onReceipt={(file) => void uploadReceipt(file)}
      onClose={() => setAskKindFor([])}
    />
  );

  return { takeFiles, uploadPhotos, uploadReceipt, importReceiptFile, uploading, uploadProgress, sheet };
}
