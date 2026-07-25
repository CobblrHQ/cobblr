// /configuration/print — Printers. Configure a print manager (CUPS) once, then
// any module or you can send documents to it. We hand the manager a discrete
// job; we never live-drive the device (coordinate-not-control). Direct on the
// LAN for self-hosted; the same connection rides the edge-bridge from cloud.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Printer as PrinterIcon, Wifi, Send, Pencil, Star, Bluetooth } from "lucide-react";
import { ApiError, api, type Printer, type PrinterInput } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, usePageTitle, printLabelOverBluetooth, connectPrinter, closePrinter, pairBluetoothPrinter, isWebBluetoothAvailable, NO_WEB_BLUETOOTH, type BluetoothPrinterSettings } from "@cobblr/platform-web";
import { mmToDots, dotsToMm, mmToInch, thermalFootprint, matchProfile, type FeedType } from "@cobblr/thermal-print";

import { EdgeConnectField, type EdgeConnectValue } from "../components/EdgeConnectField";

/** UTF-8-safe base64 — btoa() alone throws on non-Latin1 chars (em dash, etc.). */
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function PrintPage() {
  usePageTitle("Printers");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Printer | "new" | null>(null);
  const [newDriver, setNewDriver] = useState<string | null>(null);
  const [btBusy, setBtBusy] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  /** Bluetooth printers are driven from THIS browser — the server has no route to
   *  them — so the test print runs here rather than through the print API. */
  const printBluetoothTest = async (p: Printer) => {
    if (!isWebBluetoothAvailable()) {
      toast.error(NO_WEB_BLUETOOTH);
      return;
    }
    setBtBusy(p.id);
    try {
      const settings = (p.settings ?? {}) as unknown as BluetoothPrinterSettings;
      // A deliberate self-test label, not a record's label: printing YOUR labels
      // happens from the labels queue, which has the payloads. This proves the
      // connection, dialect and calibration end to end.
      const r = await printLabelOverBluetooth(
        { qrPayload: `${window.location.origin}/`, caption: "COBBLR TEST" },
        settings,
      );
      toast.success(`Test label printed to ${r.deviceName} (${r.bytes} bytes)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBtBusy(null);
    }
  };

  const list = useQuery({
    queryKey: ["printers", activeSlug],
    queryFn: () => api.listPrinters(activeSlug),
    enabled: !!activeSlug,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["printers", activeSlug] });

  const test = useMutation({
    mutationFn: (id: string) => api.testPrinter(activeSlug, id),
    onSuccess: (r) => toast[r.ok ? "success" : "error"](r.ok ? "Reachable" : `Failed: ${r.error ?? "unknown"}`),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const printTest = useMutation({
    mutationFn: (id: string) =>
      api.printToPrinter(activeSlug, id, {
        document_base64: toBase64("Cobblr — core-print test page\n"),
        content_type: "text/plain",
        filename: "cobblr-test.txt",
        job_name: "cobblr-test",
      }),
    onSuccess: (r) => toast.success(`Sent — job ${r.jobId} (${r.state})`),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deletePrinter(activeSlug, id),
    onSuccess: () => {
      toast.success("Printer removed");
      void invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const items = list.data?.items ?? [];

  // Connect a Bluetooth printer right here: pair, auto-detect from its known
  // profile, and save it — no form. An unrecognised model drops into the manual
  // add form (pre-set to Bluetooth) instead.
  // showAll: the chooser is filtered to known printers by default, but a printer
  // that advertises neither a known service nor a known name would then be
  // unpairable — so the UI offers an explicit unfiltered retry.
  const connectBluetooth = async (showAll = false) => {
    if (!isWebBluetoothAvailable()) {
      toast.error(NO_WEB_BLUETOOTH);
      return;
    }
    setConnecting(true);
    try {
      const { deviceName, profile, settings } = await pairBluetoothPrinter({ showAllDevices: showAll });
      if (!profile || !settings) {
        toast.error(`Paired "${deviceName}", but it isn't a model we know yet. Fill in the fields to finish.`);
        setNewDriver("browser-bluetooth");
        setEditing("new");
        return;
      }
      await api.createPrinter(activeSlug, {
        name: profile.label,
        driver: "browser-bluetooth",
        base_url: "",
        queue: "",
        settings: settings as unknown as Record<string, unknown>,
        is_default: items.length === 0,
      });
      toast.success(`${profile.label} connected.`);
      void invalidate();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Printers</h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} printer{items.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => { setNewDriver(null); setEditing("new"); }}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> Add printer
        </button>
      </div>

      <p className="text-sm text-muted dark:text-slate-400 max-w-2xl">
        Connect a printer to print labels and documents. Cobblr works with{" "}
        <b>Bluetooth label printers</b> (printed straight from this browser, no server or app),{" "}
        <b>network printers</b> on a CUPS/IPP manager, and printers reached through an{" "}
        <b>on-site edge bridge</b>. It hands the manager a job and tracks it; it never drives the device.
      </p>

      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {!list.isLoading && items.length === 0 && (
        <div className="grid sm:grid-cols-2 gap-3 max-w-2xl">
          <div className="rounded-xl border border-line dark:border-slate-700 hover:border-accent bg-surface dark:bg-slate-900 p-4 transition">
            {/* onClick must WRAP the call: passing the handler directly hands React's
                MouseEvent in as the first argument, which is truthy and would make
                every pairing use the unfiltered chooser. */}
            <button onClick={() => void connectBluetooth()} disabled={connecting} className="text-left w-full disabled:opacity-60">
              <div className="flex items-center gap-2 mb-1">
                <Bluetooth size={16} className="text-accent" />
                <span className="font-medium text-content dark:text-mortar-100">{connecting ? "Pairing…" : "Bluetooth label printer"}</span>
              </div>
              <p className="text-xs text-muted dark:text-slate-400">
                A thermal label printer over Bluetooth (Phomemo, POLONO, and similar). Click to pair and auto-detect its settings. Prints from this browser (Chrome or Edge, desktop or Android).
              </p>
            </button>
            {/* The chooser lists PRINTERS, not every Bluetooth object in range. A
                printer advertising neither a known service nor a known name would be
                invisible there, so offer the unfiltered list explicitly. */}
            <button
              onClick={() => void connectBluetooth(true)}
              disabled={connecting}
              className="mt-2 text-xs text-accent hover:underline disabled:opacity-60"
            >
              Don&apos;t see your printer? Show all Bluetooth devices
            </button>
          </div>
          <button
            onClick={() => { setNewDriver("cups"); setEditing("new"); }}
            className="text-left rounded-xl border border-line dark:border-slate-700 hover:border-accent bg-surface dark:bg-slate-900 p-4 transition"
          >
            <div className="flex items-center gap-2 mb-1">
              <Wifi size={16} className="text-accent" />
              <span className="font-medium text-content dark:text-mortar-100">Network printer</span>
            </div>
            <p className="text-xs text-muted dark:text-slate-400">
              A printer on a CUPS/IPP manager on your network, or through an on-site edge bridge on a hosted Cobblr. Cobblr sends it whole print jobs.
            </p>
          </button>
        </div>
      )}

      <div className="grid gap-3">
        {items.map((p) => (
          <div key={p.id} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
            <div className="flex items-center gap-2 flex-wrap">
              <PrinterIcon size={16} className="text-accent" />
              <span className="font-medium text-content dark:text-mortar-100">{p.name}</span>
              {p.is_default && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-cobble-100 dark:bg-cobble-900/30 text-accent">
                  <Star size={10} /> default
                </span>
              )}
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-subtle dark:bg-slate-800 text-muted dark:text-slate-400">
                {p.driver}
              </span>
              {/* A network printer with no declared type/width is assumed an 8.5" sheet
                  printer by the size funnel — fine for an inkjet, wrong for a thermal
                  roll. Nudge the user to set it (one click into edit) rather than
                  silently mis-funnel an existing printer. */}
              {p.driver !== "browser-bluetooth" && !(p.settings as Record<string, unknown> | undefined)?.printerKind && (
                <button
                  onClick={() => setEditing(p)}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:brightness-105 transition"
                  title="Set this printer's type and max width so label sizes funnel correctly"
                >
                  Set type
                </button>
              )}
              <div className="flex-1" />
              {p.driver === "browser-bluetooth" ? (
                <button
                  onClick={() => printBluetoothTest(p)}
                  disabled={!!btBusy}
                  className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-2.5 py-1 text-xs transition"
                  title="Connect over Bluetooth and print a test QR label from this browser"
                >
                  <Send size={13} /> {btBusy?.startsWith(p.id) ? (btBusy.split(":")[1] ?? "working") + "…" : "Print test"}
                </button>
              ) : (
                <>
                  <button onClick={() => test.mutate(p.id)} disabled={test.isPending} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-2.5 py-1 text-xs transition" title="Reachability check">
                    <Wifi size={13} /> Test
                  </button>
                  <button onClick={() => printTest.mutate(p.id)} disabled={printTest.isPending} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-2.5 py-1 text-xs transition" title="Send a test page">
                    <Send size={13} /> Print test
                  </button>
                </>
              )}
              <button onClick={() => setEditing(p)} className="p-1.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition" title="Edit">
                <Pencil size={14} />
              </button>
              <button
                onClick={async () => {
                  if (await confirm({ title: `Remove ${p.name}?`, message: "This deletes the printer connection.", confirmLabel: "Remove", destructive: true })) {
                    del.mutate(p.id);
                  }
                }}
                className="p-1.5 rounded hover:bg-ember-100 dark:hover:bg-ember-900/30 text-ember-600 transition"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="mt-2 text-xs text-muted dark:text-slate-400 font-mono">
              {p.driver === "browser-bluetooth" ? (
                (() => {
                  const s = (p.settings ?? {}) as Record<string, unknown>;
                  const w = Number(s.widthDots) || 0;
                  return `${String(s.protocol ?? "tspl").toUpperCase()}${w ? ` · ${w} dots · ≈${dotsToMm(w).toFixed(0)}mm wide` : ""}`;
                })()
              ) : (
                <>
                  {p.base_url} · queue <span className="text-content dark:text-mortar-200">{p.queue}</span>
                  {p.has_credentials && " · 🔒 auth set"}
                </>
              )}
            </div>
            {p.notes && <div className="mt-1 text-xs text-muted dark:text-slate-400">{p.notes}</div>}
          </div>
        ))}
      </div>

      {editing && (
        <PrinterModal
          slug={activeSlug}
          printer={editing === "new" ? null : editing}
          initialDriver={newDriver ?? undefined}
          existingPrinters={items.filter((p) => p.driver === "browser-bluetooth" && (editing === "new" || p.id !== editing.id))}
          onClose={() => { setNewDriver(null); setEditing(null); }}
          onSaved={() => {
            void invalidate();
            setNewDriver(null);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function PrinterModal({
  slug,
  printer,
  initialDriver,
  existingPrinters,
  onClose,
  onSaved,
}: {
  slug: string;
  printer: Printer | null;
  initialDriver?: string;
  existingPrinters?: Printer[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  // Is this a hosted (managed) Cobblr? A hosted box can't reach a LAN printer
  // directly, so it offers the edge-bridge path; a self-hosted one just uses a URL.
  const authCfg = useQuery({ queryKey: ["auth-config"], queryFn: () => api.authConfig(), staleTime: 5 * 60_000 });
  const hosted = !!authCfg.data?.hosted;
  const [name, setName] = useState(printer?.name ?? "");
  const [driver, setDriver] = useState(printer?.driver ?? initialDriver ?? "cups");
  // How Cobblr reaches the manager: a direct URL, or a cobblr-edge:// bridge route.
  const [conn, setConn] = useState<EdgeConnectValue>(() => {
    const url = printer?.base_url ?? "";
    if (/^cobblr-edge:/i.test(url)) {
      const bridge = (/^cobblr-edge:\/\/(.*)$/i.exec(url)?.[1] ?? "").replace(/^\/+|\/+$/g, "") || null;
      return { mode: "edge", base_url: url, bridge };
    }
    return { mode: "direct", base_url: url, bridge: null };
  });
  const [queue, setQueue] = useState(printer?.queue ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // A network manager (CUPS/edge) can't report the printer's kind or media width,
  // so the user declares it. This is exactly what the label-size funnel reads to
  // offer only the sizes this printer can feed (a sheet printer never lists a
  // thermal roll; nothing wider than the max is shown). Bluetooth gets it free from
  // the matched profile; a network printer declares it here.
  const net0 = (printer?.settings ?? {}) as Record<string, unknown>;
  const [netKind, setNetKind] = useState<"inkjet-laser" | "thermal">(net0.printerKind === "thermal" ? "thermal" : "inkjet-laser");
  const [netMaxIn, setNetMaxIn] = useState(
    String(net0.maxWidthMm ? Number((Number(net0.maxWidthMm) / 25.4).toFixed(2)) : net0.printerKind === "thermal" ? 4 : 8.5),
  );
  const [isDefault, setIsDefault] = useState(printer?.is_default ?? false);
  const [notes, setNotes] = useState(printer?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const bt0 = (printer?.settings ?? {}) as Record<string, unknown>;
  // Media is the D3 source. An existing printer stored only widthDots, so
  // reconstruct its width in mm (dotsToMm) to prefill — editing then migrates it
  // to the media model on save. The 40mm/320-dot round-trip holds (see 1c-A).
  const media0 = (bt0.media ?? null) as { widthMm?: number; heightMm?: number; feed?: FeedType; gapMm?: number } | null;
  const initWmm = media0?.widthMm ?? Number(dotsToMm(Number(bt0.widthDots ?? 320)).toFixed(1));
  const [btProtocol, setBtProtocol] = useState(String(bt0.protocol ?? "tspl"));
  const [btMediaWmm, setBtMediaWmm] = useState(String(initWmm));
  const [btFeed, setBtFeed] = useState<FeedType>(media0?.feed ?? ((Number(bt0.gapMm) || 0) > 0 ? "die-cut" : "continuous"));
  const [btHeightMm, setBtHeightMm] = useState(String(bt0.labelHeightMm ?? media0?.heightMm ?? 30));
  const [btGapMm, setBtGapMm] = useState(String(bt0.gapMm ?? media0?.gapMm ?? 2));
  const [btDirection, setBtDirection] = useState(String(bt0.direction ?? 0));
  const [btTopMargin, setBtTopMargin] = useState(String(bt0.topMarginDots ?? 0));
  // "Labels across": how many faces fit ACROSS the loaded media (n-up). Reconstruct
  // it from a stored media/label pair on edit; default 1 (one label per feed).
  const label0 = (bt0.label ?? null) as { widthMm?: number } | null;
  const initAcross = media0?.widthMm && label0?.widthMm ? Math.max(1, Math.round(media0.widthMm / label0.widthMm)) : 1;
  const [btAcross, setBtAcross] = useState(String(initAcross));
  const isBluetooth = driver === "browser-bluetooth";
  // Derived, shown live and stored on save — the raster path + any pre-D3 reader
  // still get widthDots/labelHeightMm/gapMm; media/label are the source of truth.
  const btMediaW = Number(btMediaWmm) || 0;
  const btLabelH = Number(btHeightMm) || 0;
  const btDerivedWidthDots = mmToDots(btMediaW);
  // mediaTiles reserves the inter-face gap, so a face is (mediaW - (n-1)*gap)/n.
  const btAcrossN = Math.max(1, Math.min(8, Math.round(Number(btAcross) || 1)));
  // Faces pack across the media, so each is a clean 1/N of the width with its own
  // margins built in (the die-cut gap is the feed space, not between faces).
  const btFaceW = btMediaW / btAcrossN;

  // Reuse a media layout from a printer the workspace already set up — "you did
  // this before". describeLayout labels the option; reuseLayout reads it back in.
  const describeLayout = (p: Printer): string => {
    const s = (p.settings ?? {}) as Record<string, unknown>;
    const m = (s.media ?? null) as { widthMm?: number; heightMm?: number } | null;
    const l = (s.label ?? null) as { widthMm?: number } | null;
    const w = m?.widthMm ?? (s.widthDots ? Math.round(dotsToMm(Number(s.widthDots))) : 0);
    const h = Math.round(Number(m?.heightMm ?? s.labelHeightMm ?? 0));
    const across = m?.widthMm && l?.widthMm ? Math.max(1, Math.round(m.widthMm / l.widthMm)) : 1;
    return `${p.name}: ${w}×${h}${across > 1 ? `, ${across}-up` : ""}`;
  };
  const reuseLayout = (p: Printer) => {
    const s = (p.settings ?? {}) as Record<string, unknown>;
    const m = (s.media ?? null) as { widthMm?: number; heightMm?: number; feed?: FeedType; gapMm?: number } | null;
    const l = (s.label ?? null) as { widthMm?: number } | null;
    const w = m?.widthMm ?? (s.widthDots ? Number(dotsToMm(Number(s.widthDots)).toFixed(1)) : 0);
    if (w) setBtMediaWmm(String(w));
    const h = m?.heightMm ?? s.labelHeightMm;
    if (h != null) setBtHeightMm(String(h));
    if (m?.feed) setBtFeed(m.feed);
    if (m?.gapMm != null) setBtGapMm(String(m.gapMm));
    if (s.protocol) setBtProtocol(String(s.protocol));
    setBtAcross(String(m?.widthMm && l?.widthMm ? Math.max(1, Math.round(m.widthMm / l.widthMm)) : 1));
  };
  const [detecting, setDetecting] = useState(false);

  // Pair a Bluetooth printer and fill the fields from its known profile, so a user
  // never has to know its dialect, width, or orientation. We pair only to read the
  // advertised name (width here is a throwaway — pairing ignores it), match a
  // bundled profile, then close the session; the real print re-opens the
  // now-granted device with no chooser. Values stay editable and the save path
  // derives the footprint exactly as a hand-entered printer does.
  const autoDetect = async () => {
    if (!isWebBluetoothAvailable()) {
      toast.error(NO_WEB_BLUETOOTH);
      return;
    }
    setDetecting(true);
    try {
      const session = await connectPrinter({ protocol: "tspl", widthDots: 320 });
      const detected = matchProfile(session.deviceName);
      closePrinter(session);
      setDriver("browser-bluetooth");
      if (!detected) {
        toast.error(`Paired "${session.deviceName}", but it is not a model we know yet. Set the fields below by hand, or run the self-test.`);
        return;
      }
      if (!name.trim()) setName(detected.label);
      setBtProtocol(detected.protocol);
      setBtMediaWmm(String(Number(dotsToMm(detected.defaultWidthDots).toFixed(1))));
      setBtDirection(String(detected.direction ?? 0));
      setBtTopMargin(String(detected.topMarginDots ?? 0));
      const feed: FeedType = detected.defaults.media === "continuous" ? "continuous" : "die-cut";
      setBtFeed(feed);
      if (detected.pitchMm) {
        const gap = feed === "die-cut" ? 2 : 0;
        setBtHeightMm(String(Number((detected.pitchMm - gap).toFixed(1))));
        setBtGapMm(String(gap));
      }
      toast.success(`Detected ${detected.label} — review and save.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  };

  const save = async () => {
    const baseUrl = conn.base_url.trim();
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    // A Bluetooth printer has no manager URL and no queue — the browser holds the
    // radio — so its own settings are what must be valid.
    if (isBluetooth) {
      if (btMediaW < 1 || btDerivedWidthDots < 8) {
        toast.error("Media width is required in mm (about 40 mm for a common roll)");
        return;
      }
    } else if (!baseUrl || !queue.trim()) {
      toast.error(conn.mode === "edge" ? "Name and queue are required (pick a bridge)" : "Name, manager URL, and queue are required");
      return;
    }
    setBusy(true);
    const creds = username || password ? { username: username || undefined, password: password || undefined } : undefined;
    const body: PrinterInput = {
      name: name.trim(),
      driver,
      base_url: baseUrl,
      queue: queue.trim(),
      is_default: isDefault,
      notes: notes.trim() || undefined,
      ...(creds ? { credentials: creds } : {}),
      ...(isBluetooth
        ? {
            settings: (() => {
              // media+label are the source; the footprint is DERIVED so the raster
              // path and any pre-D3 reader keep working (see spec D3).
              const media = { widthMm: btMediaW, heightMm: btLabelH || btMediaW, feed: btFeed, gapMm: btFeed === "die-cut" ? Number(btGapMm) || 0 : 0 };
              // "Labels across" narrows the face so N fit per media; mediaTiles tiles it.
              const label = { widthMm: btAcrossN > 1 ? Number(btFaceW.toFixed(2)) : media.widthMm, heightMm: media.heightMm };
              const fp = thermalFootprint(media, label);
              return {
                protocol: btProtocol,
                widthDots: fp.widthDots,
                labelHeightMm: btLabelH || undefined,
                gapMm: fp.gapMm,
                direction: Number(btDirection) === 1 ? 1 : 0,
                topMarginDots: Number(btTopMargin) || 0,
                media,
                label,
              };
            })(),
          }
        : {
            // Network printer capability the size funnel reads (kind + max width).
            settings: {
              ...(printer?.settings ?? {}),
              printerKind: netKind,
              maxWidthMm: Math.round((Number(netMaxIn) || (netKind === "thermal" ? 4 : 8.5)) * 25.4),
            },
          }),
    };
    try {
      if (printer) await api.updatePrinter(slug, printer.id, body);
      else await api.createPrinter(slug, body);
      toast.success(printer ? "Printer saved" : "Printer added");
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";

  return (
    <Modal open onClose={onClose} title={printer ? `Edit ${printer.name}` : "Add printer"}>
      <div className="space-y-3">
        <label className="block">
          <div className="text-xs text-muted mb-1">Name</div>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Rollo (shop)" autoFocus />
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Driver</div>
          <select className={field} value={driver} onChange={(e) => setDriver(e.target.value)}>
            {/* Exactly DRIVER_KINDS (core-print/drivers/registry.ts), enforced by
                lint:print-driver-options. Routing via a bridge is a TRANSPORT,
                chosen by the cobblr-edge:// manager URL in EdgeConnectField below,
                not a driver: an "edge" option here 400s on save. */}
            <option value="cups">CUPS (IPP)</option>
            <option value="browser-bluetooth">Bluetooth label printer (prints from this browser)</option>
            <option value="mock">Mock (test)</option>
          </select>
        </label>
        {isBluetooth ? (
          <div className="space-y-3 rounded border border-line dark:border-slate-600 p-3">
            <div className="text-[11px] text-faint">
              This printer is driven from <b>this browser</b> over Bluetooth — the server cannot reach it.
              Needs Chrome or Edge on desktop/Android; iOS has no Web Bluetooth. Values below come from the
              printer&rsquo;s calibration; run the self-test if you don&rsquo;t know them.
            </div>
            <button
              type="button"
              onClick={autoDetect}
              disabled={detecting}
              className="w-full rounded border border-accent/60 bg-accent/5 hover:bg-accent/10 text-accent text-sm font-medium px-3 py-2 transition flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <Bluetooth size={14} /> {detecting ? "Pairing…" : "Pair & auto-detect"}
            </button>
            <div className="text-[11px] text-faint text-center">
              Pairs your printer and fills these in from its known profile. Or set them by hand below.
            </div>
            {existingPrinters && existingPrinters.length > 0 && (
              <label className="block">
                <div className="text-xs text-muted mb-1">Reuse a layout you set up before</div>
                <select
                  className={field}
                  value=""
                  onChange={(e) => {
                    const p = existingPrinters.find((x) => x.id === e.target.value);
                    if (p) reuseLayout(p);
                  }}
                >
                  <option value="">Choose a saved layout…</option>
                  {existingPrinters.map((p) => (
                    <option key={p.id} value={p.id}>{describeLayout(p)}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <div className="text-xs text-muted mb-1">Command dialect</div>
                <select className={field} value={btProtocol} onChange={(e) => setBtProtocol(e.target.value)}>
                  <option value="tspl">TSPL (most label printers)</option>
                  <option value="phomemo">ESC/POS raster (Phomemo M-series)</option>
                </select>
              </label>
              <label className="block">
                <div className="text-xs text-muted mb-1">Media width (mm)</div>
                <input className={field} type="number" step="0.1" value={btMediaWmm} onChange={(e) => setBtMediaWmm(e.target.value)} placeholder="40" />
                <div className="text-[11px] text-faint mt-1">{btDerivedWidthDots} dots &middot; &asymp; {mmToInch(btMediaW).toFixed(2)} in</div>
              </label>
            </div>
            {btProtocol === "tspl" && (
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <div className="text-xs text-muted mb-1">Feed</div>
                  <select className={field} value={btFeed} onChange={(e) => setBtFeed(e.target.value as FeedType)}>
                    <option value="continuous">Continuous roll</option>
                    <option value="die-cut">Die-cut labels (gap)</option>
                    <option value="sheet">Sheet</option>
                  </select>
                </label>
                <label className="block">
                  <div className="text-xs text-muted mb-1">Label height (mm)</div>
                  <input className={field} type="number" value={btHeightMm} onChange={(e) => setBtHeightMm(e.target.value)} />
                  <div className="text-[11px] text-faint mt-1">&asymp; {mmToInch(btLabelH).toFixed(2)} in</div>
                </label>
                {btFeed === "die-cut" && (
                  <label className="block">
                    <div className="text-xs text-muted mb-1">Gap (mm)</div>
                    <input className={field} type="number" step="0.01" value={btGapMm} onChange={(e) => setBtGapMm(e.target.value)} />
                    <div className="text-[11px] text-faint mt-1">Wrong value drifts each label off the edge.</div>
                  </label>
                )}
                <label className="block">
                  <div className="text-xs text-muted mb-1">Orientation</div>
                  <select className={field} value={btDirection} onChange={(e) => setBtDirection(e.target.value)}>
                    <option value="0">Normal</option>
                    <option value="1">Rotated 180°</option>
                  </select>
                </label>
                <label className="block">
                  <div className="text-xs text-muted mb-1">Top margin (dots)</div>
                  <input className={field} type="number" min={0} value={btTopMargin} onChange={(e) => setBtTopMargin(e.target.value)} />
                  <div className="text-[11px] text-faint mt-1">
                    The dead zone at the top of the label your printer physically can&apos;t print in.
                    Printing too low? Lower this and the whole print moves up
                    {Number(btTopMargin) > 0 ? ` (${(Number(btTopMargin) / 8).toFixed(1)} mm today)` : ""}. 8 dots = 1 mm.
                  </div>
                </label>
                <label className="block">
                  <div className="text-xs text-muted mb-1">Labels across</div>
                  <input className={field} type="number" min={1} max={8} value={btAcross} onChange={(e) => setBtAcross(e.target.value)} />
                  <div className="text-[11px] text-faint mt-1">
                    {btAcrossN > 1 ? `${btAcrossN} labels of ${Number(btFaceW.toFixed(1))}mm across the ${btMediaW || "?"}mm media` : "one label per feed"}
                  </div>
                </label>
              </div>
            )}
          </div>
        ) : (
        <>
        <div className="block">
          <EdgeConnectField slug={slug} hosted={hosted} value={conn} onChange={setConn} />
        </div>
        <label className="block">
          <div className="text-xs text-muted mb-1">Queue / printer name</div>
          <input className={field + " font-mono"} value={queue} onChange={(e) => setQueue(e.target.value)} placeholder="Rollo" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <div className="text-xs text-muted mb-1">Username (optional)</div>
            <input className={field} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Password (optional)</div>
            <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={printer?.has_credentials ? "•••• (unchanged)" : ""} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <div className="text-xs text-muted mb-1">Printer type</div>
            <select
              className={field}
              value={netKind}
              onChange={(e) => {
                const k = e.target.value as "inkjet-laser" | "thermal";
                setNetKind(k);
                // Snap the width to the kind's usual max if it's still the other default.
                if (k === "thermal" && (netMaxIn === "8.5" || netMaxIn === "")) setNetMaxIn("4");
                if (k === "inkjet-laser" && (netMaxIn === "4" || netMaxIn === "")) setNetMaxIn("8.5");
              }}
            >
              <option value="inkjet-laser">Inkjet / laser (sheets)</option>
              <option value="thermal">Thermal label / roll</option>
            </select>
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Max width (in)</div>
            <input className={field} type="number" step="0.1" min={1} value={netMaxIn} onChange={(e) => setNetMaxIn(e.target.value)} placeholder={netKind === "thermal" ? "4" : "8.5"} />
            <div className="text-[11px] text-faint mt-1">Widest media it feeds. Sizes wider than this aren&rsquo;t offered.</div>
          </label>
        </div>
        </>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Default printer
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Notes (optional)</div>
          <input className={field} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600 hover:border-accent transition">Cancel</button>
          <button onClick={save} disabled={busy} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white transition disabled:opacity-50">
            {busy ? "Saving…" : printer ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
