// Labels queue page — pick a paper + label size, see a WYSIWYG
// sheet preview, print. 'Print' snapshots the queue into a batch
// and opens a print-ready window at the chosen size.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Minus, Plus, Printer, Send, Trash2 } from "lucide-react";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { useLabels } from "./context";
import { BrowsePanel } from "./BrowsePanel";
import { renderPrintSheetHtml } from "./renderPrintSheet";
import { liveQrUrl } from "../live-qr-url";
import {
  PAPER_SIZES,
  findPaper,
  labelSizesForPaper,
  perSheet,
} from "./sizes";
import type { Printable } from "./api";

const PAPER_LS = "cobblr:label-paper";
const SIZE_LS = "cobblr:label-size";

function qrSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
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

  // Paper + label-size selection, persisted so a workshop keeps its
  // printer setup between visits.
  const [paperKey, setPaperKey] = useState(
    () => localStorage.getItem(PAPER_LS) ?? PAPER_SIZES[0]!.key,
  );
  const [pickedSize, setPickedSize] = useState(
    () => localStorage.getItem(SIZE_LS) ?? "",
  );
  const sizesForPaper = labelSizesForPaper(paperKey);
  // Effective label size: the user's pick if it's valid for the
  // current paper, else that paper's first size. Derived during
  // render — so paper, label <select>, and preview never disagree,
  // not even for the one frame a useEffect-based correction leaves.
  const size = sizesForPaper.find((s) => s.key === pickedSize) ?? sizesForPaper[0];
  const sizeKey = size?.key ?? "";
  const paper = size ? findPaper(size.paper) : undefined;
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
  const previewQr = useQuery({
    queryKey: ["labels-preview-qr", qrBase.data ?? "", expanded.map((e) => e.id).join(",")],
    queryFn: async (): Promise<Printable[]> => {
      const cache = new Map<string, string>();
      for (const it of expanded) {
        const u = liveUrl(it.qr_payload);
        if (!cache.has(u)) cache.set(u, await qrSvg(u));
      }
      return expanded.map((it) => ({
        description: it.description,
        qr_svg: cache.get(liveUrl(it.qr_payload))!,
      }));
    },
    enabled: expanded.length > 0 && !qrBase.isLoading,
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
      const html = renderPrintSheetHtml(r.printables, sizeKey);
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
      const { pdf_base64 } = await api.renderPdf(sizeKey);
      const job = await api.printToPrinter(printer.id, {
        document_base64: pdf_base64,
        content_type: "application/pdf",
        filename: "labels.pdf",
        job_name: "labels",
      });
      return { printer, job };
    },
    onSuccess: ({ printer, job }) =>
      toast.success(`Sent to ${printer.name} — job ${job.jobId} (${job.state})`),
    onError: (e) => toast.error((e as Error).message),
  });

  const sheets = size ? Math.ceil(Math.max(total, 0) / perSheet(size)) : 0;

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
            onChange={(e) => setPickedSize(e.target.value)}
            className="input !w-72 !py-1 text-xs"
          >
            {sizesForPaper.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </label>
        <button
          onClick={() => sendToPrinter.mutate()}
          disabled={sendToPrinter.isPending || items.length === 0 || !size}
          className="rounded-md border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
          title="Render + send straight to a configured printer (CUPS) — no print dialog"
        >
          <Send size={14} />
          {sendToPrinter.isPending ? "…" : "Send to printer"}
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
                <li key={it.id} className="px-4 py-3 flex items-baseline gap-3 text-sm">
                  <span className="font-mono text-[10px] text-faint dark:text-slate-500 shrink-0">
                    {it.module_name}/{it.entity_type}
                  </span>
                  <span className="text-content dark:text-mortar-100 shrink-0 max-w-[16rem] truncate">{it.description}</span>
                  <span
                    className="font-mono text-[10px] text-faint dark:text-slate-500 flex-1 min-w-0 truncate"
                    title={liveUrl(it.qr_payload)}
                  >
                    {liveUrl(it.qr_payload)}
                  </span>
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
                    className="text-faint dark:text-slate-600 hover:text-ember-500 transition"
                    title="Remove from queue"
                  >
                    <Trash2 size={14} />
                  </button>
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
            />
          </div>
        </div>
      )}
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
}: {
  sizeKey: string;
  printables: Printable[];
  paperW: number;
  paperH: number;
}) {
  // Scale the real-inch sheet to fit within a generous box, keeping
  // aspect ratio — wide rolls and tall Letter sheets both fill it.
  const MAX_W = 660;
  const MAX_H = 820;
  const natW = paperW * 96;
  const natH = paperH * 96;
  const scale = Math.min(MAX_W / natW, MAX_H / natH);
  const html = renderPrintSheetHtml(printables, sizeKey, { previewOnly: true });

  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
        // sheet preview <span className="text-faint dark:text-slate-500">— {paperW}″ × {paperH}″, first sheet</span>
      </div>
      <div className="rounded-xl border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 p-5 flex justify-center">
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
