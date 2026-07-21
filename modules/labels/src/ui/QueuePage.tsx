// Labels queue page — pick a paper + label size, see a WYSIWYG
// sheet preview, print. 'Print' snapshots the queue into a batch
// and opens a print-ready window at the chosen size.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Hash, Minus, Plus, Printer, Send, Trash2, Zap } from "lucide-react";
import { usePageTitle, useToast, Modal } from "@cobblr/platform-web";
import { useLabels } from "./context";
import { BrowsePanel } from "./BrowsePanel";
import { CodesPanel } from "./CodesPanel";
import { renderPrintSheetHtml } from "./renderPrintSheet";
import { liveQrUrl } from "../live-qr-url";
import {
  printBatchOverBluetooth,
  isWebBluetoothAvailable,
  NO_WEB_BLUETOOTH,
  type BluetoothPrinterSettings,
} from "@cobblr/platform-web";
import {
  PAPER_SIZES,
  findPaper,
  labelSizesForPaper,
} from "../label-sizes";
import type { CustomLabelSize, Printable } from "./api";
import { NewSizeModal } from "./NewSizeModal";
import { AutoPrintModal } from "./AutoPrintModal";

const PAPER_LS = "cobblr:label-paper";
const SIZE_LS = "cobblr:label-size";

function qrSvg(payload: string, ecLevel: "M" | "H" = "M"): Promise<string> {
  return QRCode.toString(payload, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: ecLevel,
  });
}

export function QueuePage() {
  usePageTitle("Labels");
  const { api, orgSlug } = useLabels();
  const toast = useToast();
  const qc = useQueryClient();
  // Shared key with BasketWidget + Dashboard's LabelsTile so the
  // three consumers de-dupe in flight.
  const list = useQuery({
    queryKey: ["labels-queue", orgSlug],
    queryFn: () => api.listQueue(),
    enabled: !!orgSlug,
  });
  // Current auto-print policy, to reflect on/off on the toolbar button.
  const autoflush = useQuery({
    queryKey: ["labels-autoflush", orgSlug],
    queryFn: () => api.getAutoflush(),
    enabled: !!orgSlug,
  });
  const [autoPrintOpen, setAutoPrintOpen] = useState(false);

  // Paper + label-size selection, persisted so a workshop keeps its
  // printer setup between visits.
  const [btProgress, setBtProgress] = useState<{ done: number; total: number } | null>(null);
  const [paperKey, setPaperKey] = useState(
    () => localStorage.getItem(PAPER_LS) ?? PAPER_SIZES[0]!.key,
  );
  const [pickedSize, setPickedSize] = useState(
    () => localStorage.getItem(SIZE_LS) ?? "",
  );
  const [codesOpen, setCodesOpen] = useState(false);
  const [newSizeOpen, setNewSizeOpen] = useState(false);
  // Workspace-defined sizes (dimensions in; grid derived server-side).
  const customSizes = useQuery({
    queryKey: ["labels-custom-sizes", orgSlug],
    queryFn: () => api.listCustomSizes(),
    enabled: !!orgSlug,
  });
  const customList = customSizes.data?.items ?? [];
  const sizesForPaper = labelSizesForPaper(paperKey);

  // Effective label size: a custom pick (custom:<id>), else the user's built-in
  // pick if valid for the current paper, else that paper's first size. Derived
  // during render, so paper, label <select>, and preview never disagree.
  const pickedCustom = pickedSize.startsWith("custom:")
    ? customList.find((c) => `custom:${c.id}` === pickedSize)
    : undefined;
  const builtin = pickedCustom
    ? undefined
    : (sizesForPaper.find((s) => s.key === pickedSize) ?? sizesForPaper[0]);
  // The (LabelSize, PaperSize) the preview/render use, from either source.
  const size = pickedCustom
    ? { cols: pickedCustom.cols, rows: pickedCustom.rows, label: pickedCustom.name }
    : builtin;
  const sizeKey = pickedCustom ? pickedSize : (builtin?.key ?? "");
  const paper = pickedCustom
    ? { width_in: pickedCustom.media_w, height_in: pickedCustom.media_h }
    : builtin
      ? findPaper(builtin.paper)
      : undefined;
  useEffect(() => localStorage.setItem(PAPER_LS, paperKey), [paperKey]);
  useEffect(() => {
    if (sizeKey) localStorage.setItem(SIZE_LS, sizeKey);
  }, [sizeKey]);

  const items = list.data?.items ?? [];
  const total = items.reduce((acc, i) => acc + i.qty, 0);

  // One printable per copy — mirrors how the server expands the
  // batch — so the preview's sheet count matches the real print.
  const expanded = useMemo(
    () => items.flatMap((it) => Array.from({ length: it.qty }, () => it)),
    [items],
  );
  // The workspace's current custom label base URL. Queued rows store the URL
  // resolved at queue time; rebuild against this so the preview + row reflect a
  // base-URL change with no re-queue (see liveUrl).
  const qrBase = useQuery({
    queryKey: ["labels-qr-base", orgSlug],
    queryFn: () => api.qrLabelBaseUrl(),
  });
  const liveUrl = (payload: string) => liveQrUrl(payload, qrBase.data ?? null);

  // Get-or-assign a code per queued entity — shown as a chip on each row and
  // baked into the preview + print. Idempotent; best-effort (empty on failure).
  const codes = useQuery({
    queryKey: ["labels-codes", orgSlug, items.map((i) => i.entity_id).join(",")],
    queryFn: async (): Promise<Record<string, string>> => {
      const refs = Array.from(
        new Map(
          items.map((it) => [it.entity_id, { kind: `${it.module_name}:${it.entity_type}`, id: it.entity_id }]),
        ).values(),
      );
      try {
        return (await api.assignCodes(refs)).codes;
      } catch {
        return {};
      }
    },
    enabled: items.length > 0,
  });

  // Per-kind "draw the code in the QR center" flag (default true) — the preview
  // must mirror the print, which suppresses the overlay for opted-out kinds.
  const kinds = useMemo(
    () => [...new Set(items.map((i) => `${i.module_name}:${i.entity_type}`))],
    [items],
  );
  const overlayCfg = useQuery({
    queryKey: ["labels-overlay-center", orgSlug, kinds.join(",")],
    queryFn: async (): Promise<Record<string, boolean>> => {
      const entries = await Promise.all(
        kinds.map(async (k) => [k, (await api.getCodeConfig(k)).overlay_center] as const),
      );
      return Object.fromEntries(entries);
    },
    enabled: kinds.length > 0,
  });

  const previewQr = useQuery({
    queryKey: [
      "labels-preview-qr",
      qrBase.data ?? "",
      expanded.map((e) => e.id).join(","),
      codes.data ? "c" : "0",
      overlayCfg.data ? Object.entries(overlayCfg.data).map(([k, v]) => `${k}:${v ? 1 : 0}`).join(",") : "o",
    ],
    queryFn: async (): Promise<Printable[]> => {
      const codeMap = codes.data ?? {};
      const overlayMap = overlayCfg.data ?? {};
      // A QR carrying a center code is rendered at EC=H so the pill stays scannable.
      const cache = new Map<string, string>();
      const svgFor = async (payload: string, hasCode: boolean) => {
        const key = `${payload}|${hasCode ? "H" : "M"}`;
        if (!cache.has(key)) cache.set(key, await qrSvg(payload, hasCode ? "H" : "M"));
        return cache.get(key)!;
      };
      return Promise.all(
        expanded.map(async (it) => {
          const overlayOn = overlayMap[`${it.module_name}:${it.entity_type}`] ?? true;
          const code = overlayOn ? codeMap[it.entity_id] : undefined;
          return {
            description: it.description,
            qr_svg: await svgFor(liveUrl(it.qr_payload), !!code),
            center_code: code,
          };
        }),
      );
    },
    enabled: expanded.length > 0 && !qrBase.isLoading && !codes.isLoading && !overlayCfg.isLoading,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeFromQueue(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["labels-queue"] }),
  });

  const setQty = useMutation({
    mutationFn: ({ id, qty }: { id: string; qty: number }) => api.updateQueueQty(id, qty),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["labels-queue"] }),
  });

  const print = useMutation({
    mutationFn: () => api.print(),
    onSuccess: (r) => {
      const html = renderPrintSheetHtml(r.printables, sizeKey, { customSizes: customList });
      const w = window.open("", "_blank");
      if (w) {
        w.document.write(html);
        w.document.close();
        setTimeout(() => w.print(), 350);
      }
      void qc.invalidateQueries({ queryKey: ["labels-queue"] });
    },
  });

  // Direct-to-printer: render the queue to a PDF (labels) → dispatch via the
  // configured printer (core-print). No browser print dialog. core-print uses
  // the proven print path (pdf-lib render + the `ipp` lib to CUPS).
  const sendToPrinter = useMutation({
    mutationFn: async () => {
      const { items: printers } = await api.listPrinters();
      if (!printers.length) {
        throw new Error("No printer configured — add one at Configuration → Printers.");
      }
      const printer = printers.find((p) => p.is_default) ?? printers[0]!;

      // A Bluetooth printer has no network address, so the SERVER cannot reach it
      // (its driver throws by construction). This queue prints it from the
      // browser instead: one connection for the whole batch, then every row's own
      // payload and description. The device chooser needs a user gesture, which
      // this click is — and the session is reused across rows so it prompts once,
      // not once per label.
      if (printer.driver === "browser-bluetooth") {
        if (!isWebBluetoothAvailable()) throw new Error(NO_WEB_BLUETOOTH);
        const settings = (printer.settings ?? {}) as unknown as BluetoothPrinterSettings;
        if (!settings.widthDots) {
          throw new Error(`${printer.name} has no width set — open Configuration → Printers and set the media width.`);
        }
        const batch = items.map((it) => ({
          id: it.id,
          qrPayload: liveUrl(it.qr_payload),   // the minted scan URL, never a guess
          caption: it.description || undefined,
          copies: it.qty,
        }));
        const res = await printBatchOverBluetooth(batch, settings, (done, total) => setBtProgress({ done, total }));
        setBtProgress(null);
        // The server never saw this job, so tell it what reached paper: history,
        // frozen codes, and those rows out of the queue. Only the rows that
        // actually printed — a jam at row 7 leaves 8 onward queued to retry.
        // Recorded even if this call fails, because the labels physically exist;
        // a failure here means a stale queue, not a lost print, so it is surfaced
        // separately rather than turning a successful print into an error.
        let recordError: string | null = null;
        if (res.printed.length > 0) {
          try {
            await api.recordPrinted(res.printed.map((p) => p.id).filter((id): id is string => !!id));
          } catch (e) {
            recordError = e instanceof Error ? e.message : String(e);
          }
        }
        return { printer, bluetooth: res, recordError, warnings: [] as { code: string }[] };
      }

      const { pdf_base64, warnings } = await api.renderPdf(sizeKey);
      const job = await api.printToPrinter(printer.id, {
        document_base64: pdf_base64,
        content_type: "application/pdf",
        filename: "labels.pdf",
        job_name: "labels",
      });
      return { printer, job, warnings: warnings ?? [] };
    },
    onSuccess: (r) => {
      if ("bluetooth" in r && r.bluetooth) {
        const { printed, failed, deviceName, reconnected } = r.bluetooth;
        const n = printed.reduce((acc, i) => acc + Math.max(1, i.copies ?? 1), 0);
        if (failed.length === 0) {
          toast.success(`Printed ${n} label${n === 1 ? "" : "s"} to ${deviceName}${reconnected ? "" : " (device remembered for next time)"}`);
        } else {
          // Paper is already spent on the successes, so report exactly which rows
          // failed rather than a blanket error.
          toast.error(`Printed ${n}, failed ${failed.length}: ${failed.map((f) => f.item.caption ?? f.item.id ?? "?").slice(0, 3).join(", ")}`);
        }
        if ("recordError" in r && r.recordError) {
          toast.error("Labels printed, but the queue could not be updated. Refresh before printing again so you don't print twice.");
        }
        // Printed rows are gone server-side; failed ones stay for a retry.
        void qc.invalidateQueries({ queryKey: ["labels-queue"] });
        return;
      }
      const { printer, job, warnings } = r as { printer: { name: string }; job: { jobId: string; state: string }; warnings: { code: string }[] };
      toast.success(`Sent to ${printer.name} — job ${job.jobId} (${job.state})`);
      if (warnings.length) {
        const codes = warnings.map((w) => w.code).join(", ");
        toast.error(`Heads up: code${warnings.length === 1 ? "" : "s"} ${codes} may be too long to scan reliably. Shorten the prefix or use a larger label.`);
      }
    },
    onError: (e) => { setBtProgress(null); toast.error((e as Error).message); },
  });

  const perSheetCount = size ? size.cols * size.rows : 0;
  const sheets = perSheetCount > 0 ? Math.ceil(Math.max(total, 0) / perSheetCount) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3 flex-wrap">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">labels</h1>
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">
          {items.length} item{items.length === 1 ? "" : "s"} · {total} label{total === 1 ? "" : "s"}
          {size ? ` · ${sheets} sheet${sheets === 1 ? "" : "s"}` : ""}
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">paper</span>
          <select
            value={paperKey}
            onChange={(e) => setPaperKey(e.target.value)}
            className="input !w-auto !py-1 text-xs"
          >
            {PAPER_SIZES.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">label</span>
          <select
            value={sizeKey}
            onChange={(e) => {
              if (e.target.value === "__new__") setNewSizeOpen(true);
              else setPickedSize(e.target.value);
            }}
            className="input !w-72 !py-1 text-xs"
          >
            {sizesForPaper.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
            {customList.length > 0 && (
              <optgroup label="Your sizes">
                {customList.map((c) => (
                  <option key={c.id} value={`custom:${c.id}`}>
                    {c.name} · {c.per_sheet} up
                  </option>
                ))}
              </optgroup>
            )}
            <option value="__new__">＋ New label size…</option>
          </select>
        </label>
        <button
          onClick={() => sendToPrinter.mutate()}
          disabled={sendToPrinter.isPending || items.length === 0 || !size}
          className="rounded-md border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
          title="Render + send straight to a configured printer (CUPS) — no print dialog"
        >
          <Send size={14} />
          {btProgress ? `Printing ${btProgress.done}/${btProgress.total}…` : sendToPrinter.isPending ? "…" : "Send to printer"}
        </button>
        <button
          onClick={() => print.mutate()}
          disabled={print.isPending || items.length === 0 || !size}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
          title="Open a browser print sheet (⌘P)"
        >
          <Printer size={14} />
          {print.isPending ? "…" : `Print ${total}`}
        </button>
        <button
          onClick={() => setCodesOpen(true)}
          className="rounded-md border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
          title="Find an item by code, rename a prefix, or change what codes group by"
        >
          <Hash size={14} />
          Codes
        </button>
        <button
          onClick={() => setAutoPrintOpen(true)}
          className={`rounded-md border text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 ${
            autoflush.data?.enabled
              ? "border-cobble-500 text-cobble-700 dark:text-cobble-300 bg-cobble-50 dark:bg-cobble-900/30"
              : "border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200"
          }`}
          title="Print labels automatically as they are added, to a network printer"
        >
          <Zap size={14} />
          {autoflush.data?.enabled ? "Auto-print: on" : "Auto-print"}
        </button>
      </div>

      {list.isLoading && <div className="text-sm text-faint dark:text-slate-500">loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-faint dark:text-slate-500">
          Queue is empty — pick items below, or add labels from any module that supports them.
        </div>
      )}

      {/* Find things to label — tabbed by the kinds that support labels. */}
      <BrowsePanel />

      {/* The queue and its live preview, kept together as the review-then-print
          unit. Side by side on a wide desktop (preview to the right); stacked on
          anything narrower or portrait. */}
      {items.length > 0 && (
        <div className="flex flex-col xl:flex-row xl:items-start gap-4">
          <div className="xl:flex-1 xl:min-w-0 space-y-2">
            <ul className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-700">
              {items.map((it) => (
                <li key={it.id} className="px-4 py-3 space-y-1.5 text-sm">
                  {/* Line 1 — identity + controls. */}
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-[10px] text-faint dark:text-slate-500 shrink-0">
                      {it.module_name}/{it.entity_type}
                    </span>
                    <span className="text-content dark:text-mortar-100 flex-1 min-w-0 truncate">{it.description}</span>
                    {codes.data?.[it.entity_id] && (
                      <span
                        className="font-mono text-[11px] font-bold shrink-0 px-1.5 py-0.5 rounded bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100"
                        title="This item's label code"
                      >
                        {codes.data[it.entity_id]}
                      </span>
                    )}
                    <div className="flex items-center gap-1 shrink-0" title="Copies to print">
                      <button
                        onClick={() => setQty.mutate({ id: it.id, qty: Math.max(1, it.qty - 1) })}
                        disabled={it.qty <= 1 || setQty.isPending}
                        className="w-5 h-5 grid place-items-center rounded border border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:text-content dark:hover:text-mortar-100 disabled:opacity-30 disabled:cursor-not-allowed transition"
                        aria-label="Fewer copies"
                      >
                        <Minus size={11} />
                      </button>
                      <span className="font-mono text-xs text-muted dark:text-slate-400 w-7 text-center tabular-nums">
                        ×{it.qty}
                      </span>
                      <button
                        onClick={() => setQty.mutate({ id: it.id, qty: Math.min(99, it.qty + 1) })}
                        disabled={it.qty >= 99 || setQty.isPending}
                        className="w-5 h-5 grid place-items-center rounded border border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:text-content dark:hover:text-mortar-100 disabled:opacity-30 disabled:cursor-not-allowed transition"
                        aria-label="More copies"
                      >
                        <Plus size={11} />
                      </button>
                    </div>
                    <button
                      onClick={() => remove.mutate(it.id)}
                      className="text-faint dark:text-slate-600 hover:text-ember-500 transition shrink-0"
                      title="Remove from queue"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {/* Line 2 — the full scan URL on its own row, no longer clipped. */}
                  <div
                    className="font-mono text-[10px] text-faint dark:text-slate-500 break-all"
                    title={liveUrl(it.qr_payload)}
                  >
                    {liveUrl(it.qr_payload)}
                  </div>
                </li>
              ))}
            </ul>

            <p className="text-[11px] text-faint dark:text-slate-500">
              Live preview. These codes follow your current QR settings and update
              if you change the label base URL. Use{" "}
              <span className="text-muted dark:text-slate-400">Print</span> or{" "}
              <span className="text-muted dark:text-slate-400">Send to printer</span>{" "}
              to bake the current address onto physical labels.
            </p>
          </div>

          <div className="xl:flex-1 xl:min-w-0 overflow-x-auto">
            <SheetPreview
              sizeKey={sizeKey}
              printables={previewQr.data ?? []}
              paperW={paper?.width_in ?? 8.5}
              paperH={paper?.height_in ?? 11}
              customSizes={customList}
            />
          </div>
        </div>
      )}

      <Modal
        open={codesOpen}
        onClose={() => setCodesOpen(false)}
        title="Label codes"
        subtitle="Find an item by code · rename a prefix · change grouping"
      >
        <CodesPanel />
      </Modal>

      <NewSizeModal
        open={newSizeOpen}
        onClose={() => setNewSizeOpen(false)}
        onCreated={(created) => setPickedSize(`custom:${created.id}`)}
      />

      <AutoPrintModal open={autoPrintOpen} onClose={() => setAutoPrintOpen(false)} />
    </div>
  );
}

/** Scaled WYSIWYG preview of the first sheet — renders the exact
 *  print HTML inside an iframe sized in real inches, then CSS-scales
 *  it to fit a large preview box below the queue. */
function SheetPreview({
  sizeKey,
  printables,
  paperW,
  paperH,
  customSizes,
}: {
  sizeKey: string;
  printables: Printable[];
  paperW: number;
  paperH: number;
  customSizes: CustomLabelSize[];
}) {
  // Fit the real-inch sheet to the ACTUAL column width, not a fixed 660px — in
  // the half-width side-by-side layout the column is narrower than that, so a
  // fixed width overflowed and clipped the 2nd label tile. Measure the padded
  // box with a ResizeObserver and scale the whole first sheet to fit it (still
  // capped in height so a tall Letter sheet doesn't run off the page).
  const MAX_H = 820;
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setBoxW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const natW = paperW * 96;
  const natH = paperH * 96;
  // Until the first measurement lands, fall back to natW so nothing over-scales.
  const availW = boxW > 0 ? boxW : natW;
  const scale = Math.min(availW / natW, MAX_H / natH);
  const html = renderPrintSheetHtml(printables, sizeKey, { previewOnly: true, customSizes });

  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
        // sheet preview <span className="text-faint dark:text-slate-500">— {paperW}″ × {paperH}″, first sheet</span>
      </div>
      <div
        ref={boxRef}
        className="rounded-xl border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 p-5 flex justify-center"
      >
        <div
          className="rounded-lg border border-line dark:border-slate-700 bg-surface overflow-hidden shadow-md"
          style={{ width: natW * scale, height: natH * scale }}
        >
          <iframe
            title="label sheet preview"
            srcDoc={html}
            scrolling="no"
            style={{
              width: natW,
              height: natH,
              border: 0,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          />
        </div>
      </div>
    </div>
  );
}
