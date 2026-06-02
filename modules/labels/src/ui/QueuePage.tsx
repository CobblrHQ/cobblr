// Labels queue page — pick a paper + label size, see a WYSIWYG
// sheet preview, print. 'Print' snapshots the queue into a batch
// and opens a print-ready window at the chosen size.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Printer, Trash2 } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { useLabels } from "./context";
import { renderPrintSheetHtml } from "./renderPrintSheet";
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
  const previewQr = useQuery({
    queryKey: ["labels-preview-qr", expanded.map((e) => e.id).join(",")],
    queryFn: async (): Promise<Printable[]> => {
      const cache = new Map<string, string>();
      for (const it of expanded) {
        if (!cache.has(it.qr_payload)) cache.set(it.qr_payload, await qrSvg(it.qr_payload));
      }
      return expanded.map((it) => ({
        description: it.description,
        qr_svg: cache.get(it.qr_payload)!,
      }));
    },
    enabled: expanded.length > 0,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeFromQueue(id),
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

  const sheets = size ? Math.ceil(Math.max(total, 0) / perSheet(size)) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3 flex-wrap">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 lowercase">labels</h1>
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
          onClick={() => print.mutate()}
          disabled={print.isPending || items.length === 0 || !size}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
        >
          <Printer size={14} />
          {print.isPending ? "…" : `Print ${total}`}
        </button>
      </div>

      {list.isLoading && <div className="text-sm text-faint dark:text-slate-500">loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="border-2 border-dashed border-line dark:border-slate-700 rounded-xl p-12 text-center text-faint dark:text-slate-500">
          Queue is empty. Add labels from any module that supports them (e.g. inventory parts).
        </div>
      )}

      {items.length > 0 && (
        <>
          <ul className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-700">
            {items.map((it) => (
              <li key={it.id} className="px-4 py-3 flex items-baseline gap-3 text-sm">
                <span className="font-mono text-[10px] text-faint dark:text-slate-500 shrink-0">
                  {it.module_name}/{it.entity_type}
                </span>
                <span className="text-content dark:text-mortar-100 flex-1 truncate">{it.description}</span>
                <span className="font-mono text-xs text-muted dark:text-slate-400 shrink-0">×{it.qty}</span>
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

          <SheetPreview
            sizeKey={sizeKey}
            printables={previewQr.data ?? []}
            paperW={paper?.width_in ?? 8.5}
            paperH={paper?.height_in ?? 11}
          />
        </>
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
