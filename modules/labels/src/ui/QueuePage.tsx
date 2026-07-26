// Labels queue page — pick a paper + label size, see a WYSIWYG
// sheet preview, print. 'Print' snapshots the queue into a batch
// and opens a print-ready window at the chosen size.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Bluetooth, Check, ChevronDown, Hash, Minus, Monitor, Pencil, Plus, Printer, RotateCcw, RotateCw, Send, Settings2, Trash2, Wifi, Zap } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { usePageTitle, useToast, Modal } from "@cobblr/platform-web";
import { useLabels } from "./context";
import { BrowsePanel } from "./BrowsePanel";
import { CodesPanel } from "./CodesPanel";
import { renderPrintSheetHtml } from "./renderPrintSheet";
import { useScreenCalibration } from "./useScreenCalibration";
import { ActualSizeControl } from "./ActualSizeControl";
import { liveQrUrl } from "../live-qr-url";
import {
  printBatchOverBluetooth,
  isWebBluetoothAvailable,
  heldPrinterName,
  setPrintProgress,
  NO_WEB_BLUETOOTH,
  type BluetoothPrinterSettings,
} from "@cobblr/platform-web";
import {
  PAPER_SIZES,
  findPaper,
  findLabelSize,
  customSizeToLayout,
  labelSizesForPaper,
  printerCapability,
  papersForPrinter,
  groupPapersByClass,
  papersOfType,
  qrSideForLabel,
  labelRotatable,
  type MediaTypeFilter,
} from "../label-sizes";
import { bleSettingsForSize } from "../ble-media";
// Serial transport for Bluetooth-CLASSIC printers a browser cannot reach over Web
// Bluetooth. Same renderer + encoder as the Bluetooth path; only the pipe differs.
import { isWebSerialAvailable, NO_WEB_SERIAL, printBatchOverSerial, ConnectPrinterModal, usePrinterStatus, describePrinterStatus, getPrinterStatus } from "@cobblr/platform-web";
import { rememberedSelection, needsRemember, byRecentlyUsed, recentSizeKeys } from "../printer-memory";
import { assessScannability } from "../print/qr-overlay";
import type { CustomLabelSize, Printable } from "./api";
import { NewSizeModal } from "./NewSizeModal";
import { AutoPrintModal } from "./AutoPrintModal";
import { PrinterConfigModal } from "./PrinterConfigModal";
import { queueToolbarMode, canRevertToStock, resolvePrintTarget } from "./queue-toolbar";

const PAPER_LS = "cobblr:label-paper";
const SIZE_LS = "cobblr:label-size";
const ROTATE_LS = "cobblr:label-rotate";
// Sentinel print target: the browser/system print dialog (⌘P), always available.
// Distinct from a printer id so a saved printer is never confused with it.
const SYSTEM_TARGET = "__system__";

function qrSvg(payload: string, ecLevel: "M" | "H" = "M"): Promise<string> {
  return QRCode.toString(payload, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: ecLevel,
  });
}

/** Data modules per side for a payload at a given EC level — the same encode the
 *  SVG uses, so the scannability read reflects the real symbol drawn. */
function qrModuleCount(payload: string, ecLevel: "M" | "H"): number {
  return QRCode.create(payload, { errorCorrectionLevel: ecLevel }).modules.size;
}

/** Print a self-contained HTML sheet from the CURRENT page — no new tab or window.
 *  Mount it in a hidden iframe, print THAT iframe (it carries its own @page size,
 *  so it prints 1:1), and clean up once the dialog resolves. srcdoc's onload fires
 *  after the inline QR SVGs have parsed, so there's no render-race timeout. */
function printHtmlViaIframe(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  iframe.srcdoc = html;
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) {
      iframe.remove();
      return;
    }
    // Chrome fires onafterprint on both accept AND cancel; a long fallback covers
    // browsers that don't, so a cancelled dialog never leaks the iframe.
    const cleanup = () => iframe.remove();
    win.onafterprint = cleanup;
    setTimeout(cleanup, 120_000);
    win.focus();
    win.print();
  };
  document.body.appendChild(iframe);
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
  const [printerConfigOpen, setPrinterConfigOpen] = useState(false);
  const [confirmForget, setConfirmForget] = useState<{ id: string; name: string } | null>(null);
  const navigate = useNavigate();

  // The printer this page prints to — the workspace default (or the only one).
  // It decides the whole toolbar: a Bluetooth roll hides the sheet paper/size
  // pickers (they mean nothing to it), and having no printer at all turns the
  // toolbar into a "connect a printer" call to action instead of dead buttons.
  const printersQ = useQuery({
    queryKey: ["labels-printers", orgSlug],
    queryFn: () => api.listPrinters(),
    enabled: !!orgSlug,
  });
  const printers = printersQ.data?.items ?? [];
  const hasPrinter = printers.length > 0;
  // The print target for THIS session: the saved default, but switchable to System
  // print (⌘P) or any OTHER saved printer without changing the default or forgetting
  // anything. null = follow the saved default; SYSTEM_TARGET = system print.
  // EVERYTHING below (funnel, buttons, bleLive, the print routing) follows
  // `defaultPrinter`, so switching targets needs no change anywhere but here.
  const [pickedTarget, setPickedTarget] = useState<string | null>(null);
  const defaultPrinter = resolvePrintTarget(pickedTarget, printers, SYSTEM_TARGET);
  /** What to say under a printer in the picker. A remembered roll/battery reading
   *  beats any transport word — it is what the person actually wants to know
   *  before pressing print. Falls back to connection state, and never claims
   *  "not connected" for a serial printer, whose link is opened on demand and
   *  therefore has no tracked state to report. */
  const printerSub = (p: { id: string; driver: string }, live: boolean): string => {
    const known = describePrinterStatus(getPrinterStatus(p.id));
    if (known) return known;
    // bluetooth-only: BLE is the only transport with a live session we track.
    if (p.driver === "browser-bluetooth") return live ? "Bluetooth · connected" : "Bluetooth · not connected";
    if (p.driver === "browser-serial") return "Bluetooth";
    return "Network";
  };

  const isBleDefault =
    defaultPrinter?.driver === "browser-bluetooth" || defaultPrinter?.driver === "browser-serial";
  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  // One source of truth for which toolbar parts show. The sheet/label pickers and
  // the browser Print button share `sheetControls`/`browserPrint` so they can never
  // be gated apart again (the regression: no printer hid the pickers but kept Print,
  // so system-printing to a normal printer had no way to pick sheet + label size).
  const toolbar = queueToolbarMode(defaultPrinter);
  // Funnel the paper options to what the default printer can feed (its kind + max
  // width) — the same rule as the auto-print modal, so the platform is consistent.
  const cap = defaultPrinter ? printerCapability(defaultPrinter.driver, defaultPrinter.settings) : null;
  const funnelPapers = cap ? papersForPrinter(cap) : PAPER_SIZES;
  // When a printer's capability isn't narrowing the list (system print, no printer),
  // let the user say what they're printing on — roll vs sheet — to filter down to,
  // say, a 50×30 roll. With a printer connected, its capability already filtered, so
  // this passes everything through. The picker then groups into the same sections.
  const [mediaType, setMediaType] = useState<MediaTypeFilter>("all");
  const visiblePapers = papersOfType(funnelPapers, toolbar.connectCtas ? mediaType : "all");
  const paperGroups = groupPapersByClass(visiblePapers);

  // Live "is the Bluetooth printer connected in this tab" flag — a held BLE
  // session is per-tab and drops when idle, so poll the in-memory handle rather
  // than trust a stale render.
  const [btConnected, setBtConnected] = useState<string | null>(() => heldPrinterName());
  useEffect(() => {
    const t = setInterval(() => setBtConnected(heldPrinterName()), 1500);
    return () => clearInterval(t);
  }, []);
  const bleLive = isBleDefault && btConnected === defaultPrinter?.name;

  // Connecting a printer lives in ConnectPrinterModal (platform-web): one door,
  // no transport choice pushed onto the user.
  const [connectOpen, setConnectOpen] = useState(false);
  // Re-render the picker when any printer reports in.
  usePrinterStatus(defaultPrinter?.id ?? null);

  // Paper + label-size selection, persisted so a workshop keeps its
  // printer setup between visits.
  const [btProgress, setBtProgress] = useState<{ done: number; total: number } | null>(null);
  const [paperKey, setPaperKey] = useState(
    () => localStorage.getItem(PAPER_LS) ?? PAPER_SIZES[0]!.key,
  );
  const [pickedSize, setPickedSize] = useState(
    () => localStorage.getItem(SIZE_LS) ?? "",
  );
  // Turn the label content 90° (portrait from a landscape face). Remembered, but
  // only ever APPLIED to a non-square size (see effectiveRotate) so it can't
  // silently rotate a square where the toggle is hidden.
  const [rotate, setRotate] = useState(() => localStorage.getItem(ROTATE_LS) === "1");
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
  // Media history: the sizes this workspace actually prints, newest first. Only
  // those valid for the CURRENT paper are offered — a recent size the loaded media
  // cannot feed would just be an invalid pick. Restricted to built-ins because a
  // custom size already has its own "Your sizes" group below.
  const recentSizes = useMemo(() => {
    const keys = recentSizeKeys(printers);
    return keys
      .map((k) => sizesForPaper.find((s) => s.key === k))
      .filter((s): s is NonNullable<typeof s> => !!s);
  }, [printers, sizesForPaper]);

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
  // A clean media name for the preview header ("Label roll — 50 × 30 mm"), never
  // raw float inches like 1.9685039370078740″.
  const mediaLabel = pickedCustom ? pickedCustom.name : builtin ? (findPaper(builtin.paper)?.label ?? "") : "";
  // Rotate is only OFFERED for a LANDSCAPE face (turning it portrait is the whole
  // point) and only APPLIED when offered — so a remembered "on" never silently
  // rotates a size where it doesn't belong (a 2-up 50×30 has portrait 25×30 cells;
  // rotating those overflowed the label). Both the preview and ⌘P read
  // effectiveRotate.
  const faceWH = pickedCustom
    ? { w: pickedCustom.label_w, h: pickedCustom.label_h }
    : builtin
      ? { w: builtin.label_w, h: builtin.label_h }
      : null;
  const canRotate = !!faceWH && labelRotatable(faceWH.w, faceWH.h);
  const effectiveRotate = rotate && canRotate;
  useEffect(() => localStorage.setItem(ROTATE_LS, rotate ? "1" : "0"), [rotate]);
  useEffect(() => localStorage.setItem(PAPER_LS, paperKey), [paperKey]);
  // Snap the paper to one the default printer can feed (a persisted 4×6 must not
  // stick on a 2" printer).
  useEffect(() => {
    if (visiblePapers.length && !visiblePapers.some((p) => p.key === paperKey)) {
      setPaperKey(visiblePapers[0]!.key);
    }
  }, [visiblePapers, paperKey]);
  useEffect(() => {
    if (sizeKey) localStorage.setItem(SIZE_LS, sizeKey);
  }, [sizeKey]);

  // ── the loaded size lives with the PRINTER, not this browser ───────────────
  // localStorage only remembers on the machine you set it from, so printing from a
  // laptop and then a phone (or a new computer) started from defaults, and each
  // printer forgot the stock actually loaded in it. The printer row already
  // persists in the workspace, so the fact "the PM220S has 40x30 loaded" belongs
  // there — which is also what makes the printer panel's read-only size truthful
  // rather than a mirror of a browser value.
  //
  // localStorage stays as the fallback: System print has no printer to remember on.
  const restoredFor = useRef<string | null>(null);
  // Set on restore, consumed by the write effect: React runs both effects in the
  // SAME commit when the target printer changes, so the write effect still sees the
  // PREVIOUS printer's sizeKey and would stamp it onto the new printer before the
  // restore's setState lands. Skipping exactly one write closes that gap.
  const skipWriteOnce = useRef(false);
  useEffect(() => {
    const p = defaultPrinter;
    if (!p) return;
    if (restoredFor.current === p.id) return; // already restored; a refetch is not a switch
    restoredFor.current = p.id;
    skipWriteOnce.current = true;
    const remembered = rememberedSelection(p.settings as Record<string, unknown> | undefined);
    if (remembered.paperKey) setPaperKey(remembered.paperKey);
    if (remembered.sizeKey) setPickedSize(remembered.sizeKey);
    if (remembered.rotate !== undefined) setRotate(remembered.rotate);
  }, [defaultPrinter]);

  // Write the pick back to the printer. Gated on the restore having run for THIS
  // printer, or the first render would stamp this browser's localStorage over what
  // the printer already remembered. The equality check stops the refetch that
  // follows an update from looping.
  useEffect(() => {
    const p = defaultPrinter;
    if (!p || !sizeKey || restoredFor.current !== p.id) return;
    if (skipWriteOnce.current) { skipWriteOnce.current = false; return; }
    const st = (p.settings ?? {}) as Record<string, unknown>;
    if (!needsRemember(st, { sizeKey, paperKey, rotate })) return;
    // Best-effort: a remembered size is a convenience and must never block printing.
    void api
      .updatePrinter(p.id, {
        settings: { ...st, lastSizeKey: sizeKey, lastPaperKey: paperKey, lastRotate: rotate, lastUsedAt: new Date().toISOString() },
      })
      .catch(() => {});
  }, [defaultPrinter, sizeKey, paperKey, rotate, api]);

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
      // Include the description, not just the id — the printed caption IS the
      // description, so a rename must bust this cache or the preview goes stale
      // (it did: the rename showed only after a manual refresh).
      expanded.map((e) => `${e.id}:${e.description}`).join(","),
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
          const payload = liveUrl(it.qr_payload);
          return {
            description: it.description,
            qr_svg: await svgFor(payload, !!code),
            center_code: code,
            qr_modules: qrModuleCount(payload, code ? "H" : "M"),
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

  const rename = useMutation({
    mutationFn: ({ id, description }: { id: string; description: string }) => api.renameQueueItem(id, description),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["labels-queue"] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't rename"),
  });

  // Forget a saved printer (the deliberate, destructive one — behind a confirm, not
  // the same as switching to System print). Drops the session target back to the
  // default so the toolbar never points at a printer that no longer exists.
  const forget = useMutation({
    mutationFn: (id: string) => api.deletePrinter(id),
    onSuccess: () => {
      setPickedTarget(null);
      setConfirmForget(null);
      void qc.invalidateQueries({ queryKey: ["labels-printers", orgSlug] });
      toast.success("Printer forgotten");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't forget the printer"),
  });

  // Browser (⌘P) print. Prints from THIS page via a hidden iframe (no separate
  // tab), using the SAME client-built printables the preview shows, and does NOT
  // touch the queue yet. Like the Rollo path, raise a "mark printed" toast and
  // only record + clear the batch once the user confirms the paper looks right;
  // until then the queue and preview stay exactly as they were. (Was: api.print()
  // snapshotted + cleared the queue before the dialog even opened, so cancelling
  // still lost the labels — the author, 2026-07-23.)
  const doBrowserPrint = () => {
    const printables = previewQr.data ?? [];
    if (!printables.length) return;
    printHtmlViaIframe(renderPrintSheetHtml(printables, sizeKey, { customSizes: customList, rotate: effectiveRotate }));
    const itemIds = items.map((it) => it.id);
    const count = itemIds.length;
    toast.action(`Printing ${count} label${count === 1 ? "" : "s"}. Mark printed once the paper looks right?`, {
      actionLabel: "Mark printed",
      onAction: async () => {
        try {
          await api.recordPrinted(itemIds);
          void qc.invalidateQueries({ queryKey: ["labels-queue"] });
          toast.success("Batch recorded");
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Couldn't record the batch");
        }
      },
    });
  };

  // Direct-to-printer: render the queue to a PDF (labels) → dispatch via the
  // configured printer (core-print). No browser print dialog. core-print uses
  // the proven print path (pdf-lib render + the `ipp` lib to CUPS).
  const sendToPrinter = useMutation({
    mutationFn: async () => {
      const { items: printers } = await api.listPrinters();
      if (!printers.length) {
        throw new Error("No printer configured — add one at Configuration → Printers.");
      }
      // The ACTIVE target (the toolbar selector), not blindly the saved default —
      // so "Print to X" prints to whichever printer the selector shows.
      const printer =
        printers.find((p) => p.id === defaultPrinter?.id) ??
        printers.find((p) => p.is_default) ??
        printers[0]!;

      // A Bluetooth printer has no network address, so the SERVER cannot reach it
      // (its driver throws by construction). This queue prints it from the
      // browser instead: one connection for the whole batch, then every row's own
      // payload and description. The device chooser needs a user gesture, which
      // this click is — and the session is reused across rows so it prompts once,
      // not once per label.
      // Both browser-driven transports resolve settings identically — the media
      // geometry is a property of the label, not of the wire.
      const serialDriver = printer.driver === "browser-serial";
      if (printer.driver === "browser-bluetooth" || serialDriver) {
        if (serialDriver) {
          if (!isWebSerialAvailable()) throw new Error(NO_WEB_SERIAL);
        } else if (!isWebBluetoothAvailable()) throw new Error(NO_WEB_BLUETOOTH);
        const stored = (printer.settings ?? {}) as unknown as BluetoothPrinterSettings;
        // The media/label you pick in the toolbar drives the print (the author's fix),
        // keeping the printer's protocol + calibration; fall back to the stored
        // media if no size resolves.
        const labelDims = pickedCustom
          ? { label_w: pickedCustom.label_w, label_h: pickedCustom.label_h }
          : builtin
            ? { label_w: builtin.label_w, label_h: builtin.label_h }
            : null;
        const settings = paper && labelDims ? bleSettingsForSize(stored, paper, labelDims) : stored;
        if (!settings.widthDots) {
          throw new Error(`${printer.name} has no media set — pick a label size, or set one in Configuration → Printers.`);
        }
        const batch = items.map((it) => ({
          id: it.id,
          qrPayload: liveUrl(it.qr_payload),   // the minted scan URL, never a guess
          caption: it.description || undefined,
          centerCode: codes.data?.[it.entity_id] || undefined,  // the QR-centre badge, as on screen
          copies: it.qty,
        }));
        // The ONE branch that cares about transport. Serial has no device id to
        // bind (the OS owns the port), so it reports the printer's own name.
        const res = serialDriver
          ? await printBatchOverSerial(batch, settings, (done, total) => setBtProgress({ done, total }))
              .then((r) => ({ ...r, deviceName: printer.name, deviceId: "", reconnected: false }))
          : await printBatchOverBluetooth(batch, settings, (done, total) => setBtProgress({ done, total }));
        setBtProgress(null);
        // Bind this row to the physical unit it just printed on. Without this only
        // NEWLY paired printers would ever carry a device id, and every printer
        // paired before today would stay ambiguous against a same-model twin.
        // Best-effort: a binding is a convenience and must never fail a print.
        if (defaultPrinter && res.deviceId) {
          const st = (defaultPrinter.settings ?? {}) as Record<string, unknown>;
          if (st.deviceId !== res.deviceId) {
            void api.updatePrinter(defaultPrinter.id, { settings: { ...st, deviceId: res.deviceId } }).catch(() => {});
          }
        }
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
        // Snapshots of the rows that PRINTED (and were therefore cleared from the
        // queue), so "Didn't come out right?" can put them BACK rather than only
        // reprint the same thing. Same fields addToQueue needs; the qr_payload is
        // the already-minted token, so returning reuses it (no re-mint).
        const printedIds = new Set(res.printed.map((p) => p.id).filter(Boolean));
        const printedItems = items
          .filter((it) => printedIds.has(it.id))
          .map((it) => ({
            module_name: it.module_name,
            entity_type: it.entity_type,
            entity_id: it.entity_id,
            qr_payload: it.qr_payload,
            description: it.description,
            qty: it.qty,
          }));
        return { printer, bluetooth: res, batch, settings, printedItems, recordError, warnings: [] as { code: string }[] };
      }

      // A network send is one job, not a per-label stream, so there's nothing to
      // count down — but publish a transient count so the Live-box printer icon
      // shows the job the same way a taskbar does. Cleared in onSettled.
      const netTotal = items.reduce((n, it) => n + it.qty, 0);
      setPrintProgress({ done: 0, total: netTotal, deviceName: printer.name });
      const { pdf_base64, warnings } = await api.renderPdf(sizeKey);
      const job = await api.printToPrinter(printer.id, {
        document_base64: pdf_base64,
        content_type: "application/pdf",
        filename: "labels.pdf",
        job_name: "labels",
      });
      // Hold the queue — the async confirm records + clears once it looks right.
      return { printer, job, itemIds: items.map((it) => it.id), warnings: warnings ?? [] };
    },
    onSuccess: (r) => {
      if ("bluetooth" in r && r.bluetooth) {
        const { printed, failed, deviceName } = r.bluetooth;
        const n = printed.reduce((acc, i) => acc + Math.max(1, i.copies ?? 1), 0);
        // Live BLE printing must NOT block for a "did it look good?" confirm (the author).
        // The labels are already recorded + cleared; this is a non-blocking UNDO to
        // the side. When it came out wrong you don't want to reprint the SAME thing —
        // you want the rows BACK so you can fix the size and try again. So the action
        // returns them to the queue (reusing their tokens), not a blind reprint.
        const returnToQueue = async () => {
          try {
            await Promise.all((r.printedItems ?? []).map((it) => api.addToQueue(it)));
            void qc.invalidateQueries({ queryKey: ["labels-queue"] });
            toast.success(`${r.printedItems?.length ?? 0} back in the queue`);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't return them to the queue");
          }
        };
        if (failed.length === 0) {
          toast.action(`Printed ${n} to ${deviceName}. Didn't come out right?`, { actionLabel: "Return to queue", onAction: returnToQueue });
        } else {
          toast.action(`Printed ${n}, ${failed.length} failed.`, { actionLabel: "Return to queue", onAction: returnToQueue });
        }
        if ("recordError" in r && r.recordError) {
          toast.error("Labels printed, but the queue could not be updated. Refresh before printing again so you don't print twice.");
        }
        // Printed rows are gone server-side; failed ones stay for a retry.
        void qc.invalidateQueries({ queryKey: ["labels-queue"] });
        return;
      }
      const nr = r as { printer: { name: string }; job: { jobId: string; state: string }; itemIds: string[]; warnings: { code: string }[] };
      if (nr.warnings.length) {
        const codes = nr.warnings.map((w) => w.code).join(", ");
        toast.error(`Heads up: code${nr.warnings.length === 1 ? "" : "s"} ${codes} may be too long to scan reliably. Shorten the prefix or use a larger label.`);
      }
      // Async print: dispatched, not yet confirmed on paper. Hold the queue and
      // raise a non-blocking action-toast; "Mark batch printed" records + clears
      // those items once the physical output looks right.
      const count = nr.itemIds.length;
      toast.action(`Sent ${count} to ${nr.printer.name}. Mark printed once it looks right?`, {
        actionLabel: "Mark batch printed",
        onAction: async () => {
          try {
            await api.recordPrinted(nr.itemIds);
            void qc.invalidateQueries({ queryKey: ["labels-queue"] });
            toast.success("Batch recorded");
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't record the batch");
          }
        },
      });
    },
    onError: (e) => {
      setBtProgress(null);
      // The queue is held (nothing recorded), so a failed dispatch is one tap to retry.
      toast.action((e as Error).message, { actionLabel: "Reprint", onAction: () => sendToPrinter.mutate() });
    },
    // Clear the Live-box count pip (the network path sets it; BLE self-clears).
    onSettled: () => setPrintProgress(null),
  });

  const perSheetCount = size ? size.cols * size.rows : 0;
  const sheets = perSheetCount > 0 ? Math.ceil(Math.max(total, 0) / perSheetCount) : 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2 border-b border-line dark:border-slate-700 pb-3">
        {/* Main row: identity + the action buttons. The sheet/label size pickers
            live on their own thin row below (they wrapped ugly inline). */}
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">labels</h1>
          <span className="text-[10px] font-mono text-faint dark:text-slate-500">
            {items.length} item{items.length === 1 ? "" : "s"} · {total} label{total === 1 ? "" : "s"}
            {!isBleDefault && size ? ` · ${sheets} sheet${sheets === 1 ? "" : "s"}` : ""}
          </span>
        </div>
        <div className="flex-1" />

        {/* Printer-first: the toolbar leads with WHICH printer this prints to.
            No printer → connect CTAs, but the sheet pickers + system Print stay
            (you can print to your OS printer without configuring one here). A
            Bluetooth roll hides the sheet paper/size pickers (it prints one label
            at a time from its own media); network + no-printer keep them. */}
        {!hasPrinter ? (
          <>
            <button
              onClick={() => setConnectOpen(true)}
              className="rounded-md border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
              title="Find your label printer and set it up automatically — no forms, no leaving this page"
            >
              <Bluetooth size={14} /> Connect a printer
            </button>
            <button
              onClick={() => navigate("/configuration/print")}
              className="rounded-md border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
              title="Set up a network (CUPS) printer or an on-site edge bridge"
            >
              <Wifi size={14} /> Network printer
            </button>
          </>
        ) : (
          // Print-target selector: which printer this prints to, OR System print
          // (⌘P). The active target drives the whole toolbar — media funnel, print
          // button, preview — so switching to System print unlocks all media and
          // needs no "forget" (PM220S stays saved). See §defaultPrinter above.
          <div className="relative">
            {targetMenuOpen && (
              <button aria-hidden tabIndex={-1} className="fixed inset-0 z-10 cursor-default" onClick={() => setTargetMenuOpen(false)} />
            )}
            <button
              onClick={() => setTargetMenuOpen((v) => !v)}
              className="relative z-20 rounded-md border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 text-sm px-2.5 py-2 transition flex items-center gap-1.5"
              title="Where to print — a saved printer, or the system print dialog (⌘P)"
            >
              {defaultPrinter ? (
                isBleDefault ? (
                  <Bluetooth size={14} className={bleLive ? "text-emerald-500" : "text-faint"} />
                ) : (
                  <Wifi size={14} className="text-faint" />
                )
              ) : (
                <Monitor size={14} className="text-faint" />
              )}
              <span className="font-medium max-w-[10rem] truncate">{defaultPrinter ? defaultPrinter.name : "System print"}</span>
              {isBleDefault && (
                <span
                  className={`w-1.5 h-1.5 rounded-full ${bleLive ? "bg-emerald-500" : "bg-slate-400 dark:bg-slate-600"}`}
                  title={bleLive ? "Connected in this tab" : "Not connected — printing will pair it"}
                />
              )}
              <ChevronDown size={13} className="text-faint" />
            </button>
            {targetMenuOpen && (
              <div className="absolute right-0 z-20 mt-1.5 min-w-[252px] rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-xl p-1.5">
                <TargetItem
                  icon={<Monitor size={15} />}
                  title="System print"
                  sub="Browser ⌘P · any media"
                  active={!defaultPrinter}
                  onClick={() => { setPickedTarget(SYSTEM_TARGET); setTargetMenuOpen(false); }}
                />
                {byRecentlyUsed(printers).map((p) => {
                  const ble = p.driver === "browser-bluetooth" || p.driver === "browser-serial";
                  const live = ble && btConnected === p.name;
                  return (
                    <TargetItem
                      key={p.id}
                      icon={ble ? <Bluetooth size={15} /> : <Wifi size={15} />}
                      title={p.name}
                      sub={printerSub(p, live)}
                      active={defaultPrinter?.id === p.id}
                      onClick={() => { setPickedTarget(p.id); setTargetMenuOpen(false); }}
                    />
                  );
                })}
                <div className="h-px bg-line dark:bg-slate-700 my-1.5 mx-1" />
                {/* ONE entry. Bluetooth-vs-serial is our transport split, not a
                    distinction the user can make: both are "my Bluetooth label
                    printer" to them. The modal tries the common path and offers
                    the other as "look again" if the printer is not found. */}
                <TargetItem
                  icon={<Plus size={15} className="text-accent" />}
                  title="Connect a printer…"
                  onClick={() => { setTargetMenuOpen(false); setConnectOpen(true); }}
                />
                <TargetItem
                  icon={<Settings2 size={15} />}
                  title="All printer settings…"
                  onClick={() => { setTargetMenuOpen(false); navigate("/configuration/print"); }}
                />
                {defaultPrinter && (
                  <TargetItem
                    icon={<Settings2 size={15} />}
                    title={`${defaultPrinter.name} settings…`}
                    onClick={() => { setTargetMenuOpen(false); if (isBleDefault) setPrinterConfigOpen(true); else navigate("/configuration/print"); }}
                  />
                )}
                {defaultPrinter && (
                  <TargetItem
                    icon={<Trash2 size={15} />}
                    title={`Forget ${defaultPrinter.name}…`}
                    danger
                    onClick={() => { setTargetMenuOpen(false); setConfirmForget({ id: defaultPrinter.id, name: defaultPrinter.name }); }}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {toolbar.configuredPrint && (
          <button
            onClick={() => sendToPrinter.mutate()}
            disabled={sendToPrinter.isPending || items.length === 0 || (!isBleDefault && !size)}
            className="rounded-md border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
            title={isBleDefault ? `Print the queue to ${defaultPrinter!.name} over Bluetooth` : "Render + send straight to the printer (CUPS) — no print dialog"}
          >
            {isBleDefault ? <Bluetooth size={14} /> : <Send size={14} />}
            {btProgress
              ? `Printing ${btProgress.done}/${btProgress.total}…`
              : sendToPrinter.isPending
                ? "…"
                : isBleDefault
                  ? `Print to ${defaultPrinter!.name}`
                  : "Send to printer"}
          </button>
        )}

        {toolbar.browserPrint && (
          <button
            onClick={doBrowserPrint}
            disabled={items.length === 0 || !size}
            className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5 disabled:opacity-50"
            title="Print here with the browser dialog (⌘P) — no new tab"
          >
            <Printer size={14} />
            {`Print ${total}`}
          </button>
        )}
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
          title="Print labels automatically as they are added, to your default printer"
        >
          <Zap size={14} />
          {autoflush.data?.enabled ? "Auto-print: on" : "Auto-print"}
        </button>
        </div>

        {/* Thin second row: the sheet + label size pickers (sheet-output only). */}
        {toolbar.sheetControls && (
          <div className="flex items-center gap-3 flex-wrap">
            {/* "What are you printing on?" — only when no printer's capability is
                filtering (system print). Lets you narrow to a roll and reach 50×30. */}
            {toolbar.connectCtas && (
              <label className="flex items-center gap-1.5">
                <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">printing on</span>
                <select
                  value={mediaType}
                  onChange={(e) => setMediaType(e.target.value as MediaTypeFilter)}
                  className="input !w-auto !py-1 text-xs"
                >
                  <option value="all">Anything</option>
                  <option value="roll">Label roll</option>
                  <option value="sheet">Sheet</option>
                </select>
              </label>
            )}
            <label className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">media</span>
              <select
                value={paperKey}
                onChange={(e) => {
                  if (e.target.value === "__newsize__") setNewSizeOpen(true);
                  else setPaperKey(e.target.value);
                }}
                className="input !w-auto !py-1 text-xs"
              >
                {paperGroups.map((g) => (
                  <optgroup key={g.class} label={g.label}>
                    {g.papers.map((p) => (
                      <option key={p.key} value={p.key}>{p.label}</option>
                    ))}
                  </optgroup>
                ))}
                <option value="__newsize__">＋ Custom size…</option>
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
                {recentSizes.length > 0 && (
                  <optgroup label="Recently used">
                    {recentSizes.map((s) => (
                      <option key={`recent-${s.key}`} value={s.key}>{s.label}</option>
                    ))}
                  </optgroup>
                )}
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
            {canRotate && (
              <label
                className="flex items-center gap-1.5"
                title="Turn the label content 90°, so a landscape face (like 50 × 30 mm) prints portrait. The media itself is unchanged."
              >
                <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">turn</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={rotate}
                  onClick={() => setRotate((v) => !v)}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition ${
                    rotate
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-slate-300 text-muted dark:border-slate-700 dark:text-slate-400"
                  }`}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  90°
                </button>
              </label>
            )}
          </div>
        )}
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
                      {it.kind_label ?? `${it.module_name}/${it.entity_type}`}
                    </span>
                    <EditableLabel
                      value={it.description}
                      stockName={it.stock_title ?? undefined}
                      onSave={(v) => rename.mutate({ id: it.id, description: v })}
                    />
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
              mediaLabel={mediaLabel}
              customSizes={customList}
              rotate={effectiveRotate}
            />
          </div>
        </div>
      )}

      <Modal
        open={codesOpen}
        onClose={() => setCodesOpen(false)}
        title="Label codes"
        subtitle="Find by code · optionally show it in the QR"
        cobb={{ opener: "You're looking at your label codes. I can rename a list's prefix, remove a list's code entirely to free that letter, or toggle whether a list's code shows inside its QR (per list, so your 3D printers can differ from your CNC). Which list, and what would you like?" }}
      >
        <CodesPanel />
      </Modal>

      <NewSizeModal
        open={newSizeOpen}
        onClose={() => setNewSizeOpen(false)}
        onCreated={(created) => setPickedSize(`custom:${created.id}`)}
      />

      <AutoPrintModal open={autoPrintOpen} onClose={() => setAutoPrintOpen(false)} />
      {defaultPrinter && isBleDefault && (
        <PrinterConfigModal
          printer={defaultPrinter}
          // The size comes FROM the toolbar rather than being re-entered in the
          // modal: bleSettingsForSize overrides the printer's stored media from
          // this pick on every print, so any field there would have been inert.
          loadedSizeLabel={mediaLabel || undefined}
          open={printerConfigOpen}
          onClose={() => setPrinterConfigOpen(false)}
        />
      )}
      <ConnectPrinterModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        createPrinter={async (input) => {
          const created = await api.createPrinter({
            name: input.name,
            driver: input.driver,
            settings: input.settings,
            is_default: true,
          });
          await qc.invalidateQueries({ queryKey: ["labels-printers", orgSlug] });
          return (created as { id?: string } | undefined)?.id;
        }}
        onNeedsManualSetup={() => navigate("/configuration/print")}
        onConnected={(name) => toast.success(`${name} connected — you're ready to print.`)}
      />
      <Modal
        open={!!confirmForget}
        onClose={() => setConfirmForget(null)}
        title="Forget this printer?"
        subtitle={confirmForget?.name}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted dark:text-slate-400">
            Removes <b className="text-content dark:text-mortar-100">{confirmForget?.name}</b> from this workspace.
            You can pair or add it again later. To just print somewhere else for now, pick{" "}
            <b className="text-content dark:text-mortar-100">System print</b> instead — no need to forget.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmForget(null)}
              className="px-3 py-1.5 rounded-md text-sm border border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => confirmForget && forget.mutate(confirmForget.id)}
              disabled={forget.isPending}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-rose-600 hover:bg-rose-700 text-white disabled:opacity-50"
            >
              {forget.isPending ? "Forgetting…" : "Forget printer"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** One row in the print-target dropdown: an icon, a title + optional sub-label, and
 *  a check when it's the active target. `danger` tints a destructive row (Forget). */
function TargetItem({
  icon,
  title,
  sub,
  active,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  sub?: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-left transition hover:bg-subtle dark:hover:bg-slate-800 ${danger ? "text-rose-600 dark:text-rose-400" : "text-content dark:text-mortar-100"}`}
    >
      <span className={`shrink-0 ${danger ? "" : "text-faint"}`}>{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block truncate">{title}</span>
        {sub && <span className="block text-[11px] text-faint dark:text-slate-500">{sub}</span>}
      </span>
      {active && <Check size={15} className="text-accent shrink-0" />}
    </button>
  );
}

/** The queued item's printed caption, click-to-edit. A long entity title
 *  (e.g. "2002 Honda Odyssey Minivan EX") can be trimmed to a short name that
 *  fits the label without wrapping — the abbreviation IS the fit, no ellipsis.
 *  Enter or blur saves; Escape cancels. */
function EditableLabel({
  value,
  stockName,
  onSave,
}: {
  value: string;
  /** The entity's stock system name — the revert target. When the caption has
   *  been trimmed away from it, revert restores it. Absent when unresolved. */
  stockName?: string;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // A trimmed caption can be put back to the entity's system name. Only when we
  // know that name AND the caption differs from it (nothing to revert otherwise).
  const canRevert = canRevertToStock(value, stockName);
  if (!editing) {
    return (
      <span className="group/name flex items-center gap-1.5 flex-1 min-w-0">
        <button
          type="button"
          onClick={() => { setDraft(value); setEditing(true); }}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left text-content dark:text-mortar-100"
          title="Click to rename this label"
        >
          <span className="truncate group-hover/name:underline decoration-dotted underline-offset-2">
            {value || <span className="text-faint italic">no name</span>}
          </span>
          <Pencil size={12} className="shrink-0 text-faint opacity-60 group-hover/name:opacity-100 group-hover/name:text-accent transition" />
        </button>
        {/* One-tap revert to the system name, without entering edit mode. Shown
            only when the caption differs from the stock name. */}
        {canRevert && (
          <button
            type="button"
            title={`Revert to the system name "${stockName}"`}
            aria-label={`Revert to the system name "${stockName}"`}
            onClick={() => onSave(stockName!)}
            className="shrink-0 p-1 rounded text-faint hover:text-accent transition"
          >
            <RotateCcw size={13} />
          </button>
        )}
      </span>
    );
  }
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v !== value) onSave(v);
  };
  return (
    <span className="flex items-center gap-1 flex-1 min-w-0">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        maxLength={200}
        className="input !py-0.5 !px-1.5 text-sm flex-1 min-w-0"
      />
      {/* Revert the draft to the entity's SYSTEM name (not the last-saved caption:
          Escape already restores that + closes). mouseDown+preventDefault keeps the
          input focused (a blur would commit) so the reset sticks; disabled when
          there's no stock name or the draft already equals it. */}
      <button
        type="button"
        title={stockName ? `Revert to the system name "${stockName}"` : "No system name to revert to"}
        aria-label="Revert to the system name"
        onMouseDown={(e) => { e.preventDefault(); if (stockName) setDraft(stockName); }}
        disabled={!canRevertToStock(draft, stockName)}
        className="shrink-0 p-1 rounded text-faint hover:text-accent disabled:opacity-30 disabled:cursor-default transition"
      >
        <RotateCcw size={13} />
      </button>
    </span>
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
  mediaLabel,
  customSizes,
  rotate,
}: {
  sizeKey: string;
  printables: Printable[];
  paperW: number;
  paperH: number;
  mediaLabel: string;
  customSizes: CustomLabelSize[];
  rotate: boolean;
}) {
  // ONE scale for the whole preview, so sizes stay comparable: a 2" label is bigger
  // than a 1.5", and a 2" single equals a 2" cell of a 4×6. But it must also be
  // READABLE — a fixed 60px/in left a 50×30 label unreadably tiny. So the scale is
  // anchored to the box: a REFERENCE_IN-wide medium fills the preview width, and
  // everything scales from there (same factor for every size, big enough to read;
  // a full sheet like Letter is wider than that and simply scrolls). "Actual size"
  // swaps in the display's calibrated px/inch for a true-to-life ruler check.
  const MAX_H = 820;
  const REFERENCE_IN = 4; // a 4" roll fills the preview width; smaller media scale down proportionally
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
  const cal = useScreenCalibration();
  const [actual, setActual] = useState(false);

  const natW = paperW * 96; // the sheet HTML is authored at 96px/inch
  const natH = paperH * 96;
  const actualScale = (cal.pxPerMm * 25.4) / 96;
  // px-per-inch = boxW / REFERENCE_IN, ÷96 to scale the 96dpi HTML. Falls back to a
  // sane width until the box is measured.
  const previewScale = (boxW > 0 ? boxW : 640) / (REFERENCE_IN * 96);
  const scale = actual ? actualScale : previewScale;
  const html = renderPrintSheetHtml(printables, sizeKey, { previewOnly: true, customSizes, rotate });

  // Physical scannability of the printed QR at THIS size — the "is it too small
  // to read?" sanity check. mm-per-module is a property of the printed inches, so
  // it is honest whether or not "actual size" is on. Worst case across the sheet
  // (most modules ⇒ smallest module ⇒ hardest to scan) so the read is not
  // optimistic. Hidden until the module counts are known / the size resolves.
  const resolvedSize = useMemo(() => {
    if (sizeKey.startsWith("custom:")) {
      const row = customSizes.find((c) => c.id === sizeKey.slice("custom:".length));
      return row ? customSizeToLayout(row).size : null;
    }
    return findLabelSize(sizeKey) ?? null;
  }, [sizeKey, customSizes]);
  const maxModules = printables.reduce((m, p) => Math.max(m, p.qr_modules ?? 0), 0);
  const scan = resolvedSize && maxModules > 0 ? assessScannability(qrSideForLabel(resolvedSize), maxModules) : null;

  // Multi-sheet: a queue often needs more than one sheet (2 labels of a 1-up
  // die-cut roll = 2 sheets). The default view is a wrapping STRIP of small
  // per-sheet thumbnails so it matches what actually comes out; "actual size"
  // drops back to the first sheet at true physical size for the ruler check.
  // Bounded (CAP) so a huge queue can't spawn hundreds of iframes.
  const per = resolvedSize ? resolvedSize.cols * resolvedSize.rows : 0;
  const sheetCount = per > 0 ? Math.max(1, Math.ceil(printables.length / per)) : 1;
  const CAP = 12;
  const shownSheets = Math.min(sheetCount, CAP);
  const sheetHtml = useMemo(
    () =>
      Array.from({ length: per > 0 ? shownSheets : 1 }, (_, i) =>
        renderPrintSheetHtml(per > 0 ? printables.slice(i * per, (i + 1) * per) : printables, sizeKey, {
          previewOnly: true,
          customSizes,
          rotate,
        }),
      ),
    [printables, per, shownSheets, sizeKey, customSizes, rotate],
  );

  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
        // sheet preview <span className="text-faint dark:text-slate-500">{mediaLabel ? `${mediaLabel} · ` : ""}{actual ? "first sheet, actual size" : sheetCount > 1 ? `${sheetCount} sheets` : "1 sheet"}</span>
        {scan && (
          <span
            className="normal-case tracking-normal text-faint dark:text-slate-500"
            title={`QR prints about ${scan.moduleMm.toFixed(2)} mm per module — ${scan.label}. Under ~0.2 mm a phone can't read it; 0.3 mm and up is comfortable. This is the physical printed size, independent of screen zoom.`}
          >
            {" · "}
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full align-middle ${
                scan.rating === "good" ? "bg-emerald-500" : scan.rating === "tight" ? "bg-amber-500" : "bg-red-500"
              }`}
            />{" "}
            <span
              className={
                scan.rating === "good"
                  ? ""
                  : scan.rating === "tight"
                    ? "text-amber-600 dark:text-amber-500"
                    : "text-red-600 dark:text-red-400"
              }
            >
              QR {scan.moduleMm.toFixed(2)} mm/module{scan.rating !== "good" ? ` · ${scan.label}` : ""}
            </span>
          </span>
        )}
      </div>
      <div
        ref={boxRef}
        className={`rounded-xl border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 p-5 flex overflow-auto ${
          actual ? "justify-start" : "flex-wrap gap-3 content-start justify-start"
        }`}
        style={{ maxHeight: MAX_H }}
      >
        {actual ? (
          <div
            className="rounded-lg border border-line dark:border-slate-700 bg-surface overflow-hidden shadow-md shrink-0"
            style={{ width: natW * scale, height: natH * scale }}
          >
            <iframe
              title="label sheet preview"
              srcDoc={html}
              scrolling="no"
              style={{ width: natW, height: natH, border: 0, transform: `scale(${scale})`, transformOrigin: "top left" }}
            />
          </div>
        ) : (
          <>
            {/* Every thumbnail at the SAME scale, so a 2" sheet is visibly bigger
                than a 1.5" one and a 2" cell of a 4×6 matches a 2" single. */}
            {sheetHtml.map((h, i) => (
              // Sheet number goes BELOW the thumbnail, not over it — an absolute
              // badge sat on the label's title and hid it.
              <div key={i} className="shrink-0 flex flex-col items-center gap-1">
                <div
                  className="rounded-md border border-line dark:border-slate-700 bg-surface overflow-hidden shadow-sm"
                  style={{ width: natW * scale, height: natH * scale }}
                >
                  <iframe
                    title={`sheet ${i + 1}`}
                    srcDoc={h}
                    scrolling="no"
                    style={{ width: natW, height: natH, border: 0, transform: `scale(${scale})`, transformOrigin: "top left" }}
                  />
                </div>
                {sheetCount > 1 && <span className="text-[9px] font-mono text-faint dark:text-slate-500 leading-none">{i + 1}</span>}
              </div>
            ))}
            {sheetCount > CAP && (
              <div
                className="grid place-items-center rounded-md border border-dashed border-line dark:border-slate-700 text-[11px] text-faint dark:text-slate-500 shrink-0"
                style={{ width: natW * scale, height: natH * scale }}
              >
                +{sheetCount - CAP} more
              </div>
            )}
          </>
        )}
      </div>
      <ActualSizeControl actual={actual} onToggle={() => setActual((v) => !v)} cal={cal} />
    </div>
  );
}
