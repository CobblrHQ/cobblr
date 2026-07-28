// /configuration/print — Printers. Configure a print manager (CUPS) once, then
// any module or you can send documents to it. We hand the manager a discrete
// job; we never live-drive the device (coordinate-not-control). Direct on the
// LAN for self-hosted; the same connection rides the edge-bridge from cloud.

import { useState } from "react";
import { isEdgeManagerUrl, edgeInstanceOf } from "@cobblr/platform-contract/edge-bridge-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Printer as PrinterIcon, Wifi, Send, Pencil, Star, Bluetooth, Activity } from "lucide-react";
import { ApiError, api, type Printer, type PrinterInput } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, usePageTitle, printLabelOverBluetooth, connectPrinter, closePrinter, isWebBluetoothAvailable, NO_WEB_BLUETOOTH, readSerialPrinterStatus, ConnectPrinterModal, setPrinterStatus, clearPrinterStatus, type SerialPrinterIdentity, type BluetoothPrinterSettings, isLocalBridgePrinter, testLocalBridge, printerDisplayName, describeReportedMedia, usePrinterStatus, PrinterReadout } from "@cobblr/platform-web";
import { mmToDots, dotsToMm, mmToInch, thermalFootprint, matchProfile, type FeedType } from "@cobblr/thermal-print";

import { EdgeConnectField, type EdgeConnectValue } from "../components/EdgeConnectField";
import { PrinterStatusChip } from "../components/PrinterStatusChip";

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
  // Live readings, keyed by printer. Held in component state rather than saved:
  // the roll gets swapped and the battery drains, so a persisted reading would
  // go stale silently, which is worse than showing nothing.
  const [serialStatus, setSerialStatus] = useState<Record<string, SerialPrinterIdentity | "reading">>({});
  const [newDriver, setNewDriver] = useState<string | null>(null);
  const [btBusy, setBtBusy] = useState<string | null>(null);
  // Raised when a pairing failure tells us the printer is Bluetooth Classic, so
  // the serial route gets offered instead of the user having to know it exists.
  const [connectOpen, setConnectOpen] = useState(false);

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
    // A bridge on THIS machine is unreachable from the server (127.0.0.1 there is
    // a different computer), so the browser runs the identical check itself —
    // same shared client, same protocol, different transport.
    mutationFn: (p: Printer) =>
      isLocalBridgePrinter(p.settings)
        ? testLocalBridge((p.settings as { bridge: Parameters<typeof testLocalBridge>[0] }).bridge)
        : api.testPrinter(activeSlug, p.id),
    onSuccess: (r) => {
      if (!r.ok) {
        toast.error(`Failed: ${r.error ?? "unknown"}`);
        return;
      }
      // Prefer what the PRINTER said over a bare "Reachable" — the loaded roll
      // and battery are the answer to the question someone is actually asking.
      toast.success(r.detail ? `Connected: ${r.detail}` : "Connected");
    },
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

  // Connecting lives in ConnectPrinterModal (platform-web): one door, and the
  // Bluetooth-vs-serial split stays our problem instead of the user's.

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Printers</h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} printer{items.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        {/* These MUST NOT live only in the empty state. They used to, so once a
            workspace had a single printer there was no way left to pair a second
            one or to reach the serial route at all — the only remaining button
            opened the manual form. */}
        {/* ONE button. Which browser API reaches the printer is our problem, not
            a choice to hand the user — see ConnectPrinterModal's header. */}
        <button
          onClick={() => setConnectOpen(true)}
          className="inline-flex items-center gap-2 rounded border border-line dark:border-slate-600 hover:border-accent px-3 py-1.5 text-sm transition"
          title="Find your label printer and set it up automatically"
        >
          <Bluetooth size={14} /> Connect a printer
        </button>
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
            <button onClick={() => setConnectOpen(true)} className="text-left w-full">
              <div className="flex items-center gap-2 mb-1">
                <Bluetooth size={16} className="text-accent" />
                <span className="font-medium text-content dark:text-mortar-100">Bluetooth label printer</span>
              </div>
              <p className="text-xs text-muted dark:text-slate-400">
                A thermal label printer over Bluetooth (Phomemo, POLONO, and similar). Click to pair and auto-detect its settings. Prints from this browser (Chrome or Edge, desktop or Android).
              </p>
            </button>
            {/* The "can't find it" paths live inside the modal now, in the order a
                person would actually try them. */}
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

      <ConnectPrinterModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        createPrinter={async (input) => {
          const created = await api.createPrinter(activeSlug, {
            name: input.name,
            driver: input.driver,
            // A bridge printer routes by its manager URL; a browser-driven one
            // has no network address at all, hence the empty default.
            base_url: input.base_url ?? "",
            queue: "",
            settings: input.settings,
            is_default: items.length === 0,
          });
          void invalidate();
          return (created as { id?: string } | undefined)?.id;
        }}
        onNeedsManualSetup={(driver) => { setNewDriver(driver); setEditing("new"); }}
        onConnected={(name) => toast.success(`${name} connected.`)}
      />

      <div className="grid gap-3">
        {items.map((p) => (
          <div key={p.id} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
            <div className="flex items-center gap-2 flex-wrap">
              <PrinterIcon size={16} className="text-accent" />
              <span className="font-medium text-content dark:text-mortar-100">{printerDisplayName(p.name)}</span>
              {p.is_default && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-cobble-100 dark:bg-cobble-900/30 text-accent">
                  <Star size={10} /> default
                </span>
              )}
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-subtle dark:bg-slate-800 text-muted dark:text-slate-400">
                {/* browser-bluetooth and browser-serial are two ways WE reach the
                    same class of device; to the owner both are just Bluetooth. */}
                {p.driver === "browser-bluetooth" || p.driver === "browser-serial" ? "bluetooth" : p.driver}
              </span>
              {/* A network printer with no declared type/width is assumed an 8.5" sheet
                  printer by the size funnel — fine for an inkjet, wrong for a thermal
                  roll. Nudge the user to set it (one click into edit) rather than
                  silently mis-funnel an existing printer. */}
              {p.driver !== "browser-bluetooth" && p.driver !== "browser-serial" && !(p.settings as Record<string, unknown> | undefined)?.printerKind && (
                <button
                  onClick={() => setEditing(p)}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:brightness-105 transition"
                  title="Set this printer's type and max width so label sizes funnel correctly"
                >
                  Set type
                </button>
              )}
              <div className="flex-1" />
              {/* bluetooth-only: this test print drives a GATT session directly;
                  a serial printer uses the Check button beside it instead. */}
              {p.driver === "browser-bluetooth" ? (
                <button
                  onClick={() => printBluetoothTest(p)}
                  disabled={!!btBusy}
                  className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-2.5 py-1 text-xs transition"
                  title="Connect over Bluetooth and print a test QR label from this browser"
                >
                  <Send size={13} /> {btBusy?.startsWith(p.id) ? (btBusy.split(":")[1] ?? "working") + "…" : "Print test"}
                </button>
              ) : p.driver === "browser-serial" ? (
                <button
                  onClick={async () => {
                    setSerialStatus((s) => ({ ...s, [p.id]: "reading" }));
                    try {
                      const reading = await readSerialPrinterStatus();
                      setSerialStatus((s) => ({ ...s, [p.id]: reading }));
                      setPrinterStatus(p.id, {
                        widthMm: reading.widthMm, heightMm: reading.heightMm,
                        battery: reading.battery, responded: reading.responded,
                      });
                    } catch (e) {
                      setSerialStatus((s) => { const n = { ...s }; delete n[p.id]; return n; });
                      toast.error(e instanceof Error ? e.message : String(e));
                    }
                  }}
                  disabled={serialStatus[p.id] === "reading"}
                  className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-2.5 py-1 text-xs transition"
                  title="Ask the printer which roll is loaded and how its battery is doing"
                >
                  <Activity size={13} /> {serialStatus[p.id] === "reading" ? "Asking…" : "Check"}
                </button>
              ) : (
                <>
                  <button onClick={() => test.mutate(p)} disabled={test.isPending} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-2.5 py-1 text-xs transition" title="Connect and read the printer status">
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
                    clearPrinterStatus(p.id);
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
              {/* Serial belongs with Bluetooth here, not with network: it has no
                  base_url or queue, so the network branch rendered "· queue" with
                  two blanks either side. */}
              {p.driver === "browser-bluetooth" || p.driver === "browser-serial" ? (
                (() => {
                  const s = (p.settings ?? {}) as Record<string, unknown>;
                  const w = Number(s.widthDots) || 0;
                  return `${String(s.protocol ?? "tspl").toUpperCase()}${w ? ` · ${w} dots · ≈${dotsToMm(w).toFixed(0)}mm wide` : ""}`;
                })()
              ) : (
                <>
                  {p.base_url}
                  {/* A bridged printer routes by INSTANCE and has no queue; the
                      unconditional "· queue" left a dangling label with nothing
                      after it. */}
                  {p.queue ? <> · queue <span className="text-content dark:text-mortar-200">{p.queue}</span></> : null}
                  {p.has_credentials && " · 🔒 auth set"}
                </>
              )}
            </div>
            <PrinterReports printer={p} />
            {(() => {
              const st = serialStatus[p.id];
              if (!st || st === "reading") return null;
              // Silent entirely — distinct from "answered, but has no coded roll",
              // which the chip reports itself.
              if (!st.responded) {
                return <div className="mt-1.5 text-[11px] text-muted dark:text-slate-400">This printer did not answer. Power-cycle it; if that is not enough, remove the pairing and pair it again.</div>;
              }
              if (!st.widthMm && !st.battery) {
                return <div className="mt-1.5 text-[11px] text-muted dark:text-slate-400">It answered, but reported nothing usable.</div>;
              }
              return (
                <div className="mt-1.5">
                  <PrinterStatusChip widthMm={st.widthMm} heightMm={st.heightMm} battery={st.battery} />
                </div>
              );
            })()}
            {p.notes && <div className="mt-1 text-xs text-muted dark:text-slate-400">{p.notes}</div>}
          </div>
        ))}
      </div>

      {editing && (
        <PrinterModal
          slug={activeSlug}
          printer={editing === "new" ? null : editing}
          initialDriver={newDriver ?? undefined}
          // bluetooth-only: same-model binding keys off Web Bluetooth device ids,
          // which a serial port has no equivalent of.
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

/** What a printer reports about itself, on its row in settings.
 *
 *  Deliberately does NOT probe. This page lists every printer, and asking each
 *  one costs a real session per device — one per pairing on the Bluetooth
 *  Classic hardware — plus a consent click on some. The roll comes from what
 *  was stored the last time something did ask; the battery only from a reading
 *  taken in this tab, since a stored battery level would come back confidently
 *  wrong. Test / Check are how you ask on purpose. */
function PrinterReports({ printer }: { printer: Printer }) {
  const live = usePrinterStatus(printer.id);
  const storedRoll = describeReportedMedia(printer.settings as Record<string, unknown> | undefined);
  const hasLive = !!live?.responded && (!!live.widthMm || !!live.battery);
  if (!hasLive && !storedRoll) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted dark:text-slate-400">
      {hasLive ? (
        <>Printer reports: <PrinterReadout reading={live} className="text-content dark:text-mortar-200" /></>
      ) : (
        <>Last reported loaded: <span className="text-content dark:text-mortar-200">{storedRoll}</span></>
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
    if (isEdgeManagerUrl(url)) {
      const bridge = edgeInstanceOf(url);
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
  // Edge-bridge routing (settings.bridge): which INSTANCE on the bridge, and —
  // for a bridge on this very computer — where the browser reaches it directly.
  const br0 = ((printer?.settings ?? {}) as { bridge?: Record<string, unknown> }).bridge ?? {};
  const [brInstance, setBrInstance] = useState(String(br0.instance ?? ""));
  const [brLocalUrl, setBrLocalUrl] = useState(String(br0.bridgeUrl ?? ""));
  const [brToken, setBrToken] = useState(String(br0.token ?? ""));
  const [brName, setBrName] = useState(String(br0.bridgeName ?? ""));
  const [brWidthMm, setBrWidthMm] = useState(String(br0.widthDots ? Number(dotsToMm(Number(br0.widthDots)).toFixed(1)) : 40));
  const [brHeightMm, setBrHeightMm] = useState(String(br0.labelHeightMm ?? 30));
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
  const [btTearOff, setBtTearOff] = useState(Boolean(bt0.tearOff));
  // Serial printers are thermal label printers too: same TSPL settings, same
  // form fields, just a different pipe. Gating on Bluetooth alone sent a serial
  // printer down the NETWORK branch, where it was asked for a manager URL and
  // queue it does not have and quietly lost its media settings on save.
  const isBrowserThermal = driver === "browser-bluetooth" || driver === "browser-serial";
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
    if (isBrowserThermal) {
      if (btMediaW < 1 || btDerivedWidthDots < 8) {
        toast.error("Media width is required in mm (about 40 mm for a common roll)");
        return;
      }
    } else if (!baseUrl || (!queue.trim() && !(conn.mode === "edge" && brInstance.trim()))) {
      // On a bridge, the INSTANCE routes the job (the bridge serves /<id>/), so a
      // CUPS queue name is not required — a thermal instance has no queue at all.
      toast.error(conn.mode === "edge" ? "Name and a bridge instance (or queue) are required" : "Name, manager URL, and queue are required");
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
      ...(isBrowserThermal
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
                tearOff: btTearOff,
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
              ...(conn.mode === "edge" && (brInstance.trim() || brLocalUrl.trim())
                ? {
                    bridge: {
                      instance: brInstance.trim() || undefined,
                      bridgeUrl: brLocalUrl.trim() || undefined,
                      token: brToken.trim() || undefined,
                      bridgeName: brName.trim() || undefined,
                      widthDots: mmToDots(Number(brWidthMm) || 40),
                      labelHeightMm: Number(brHeightMm) || 30,
                    },
                  }
                : {}),
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
            <option value="browser-serial">Bluetooth label printer, paired in your computer (prints from this browser)</option>
            <option value="mock">Mock (test)</option>
          </select>
        </label>
        {isBrowserThermal ? (
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
                <label className="flex items-start gap-2 sm:col-span-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={btTearOff}
                    onChange={(e) => setBtTearOff(e.target.checked)}
                  />
                  <span>
                    <span className="text-xs text-muted">Don&apos;t feed to the tear bar</span>
                    <span className="block text-[11px] text-faint mt-0.5">
                      Turn this on if a blank label comes out between prints. Printers push the
                      finished label out to be torn off, then pull it back before the next one — but
                      a roll with no code in it leaves the printer guessing, so it feeds forward and
                      never comes back.
                    </span>
                  </span>
                </label>
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
        {conn.mode === "edge" && (
          <div className="space-y-2 rounded border border-line dark:border-slate-600 p-3">
            <div className="text-[11px] text-faint">
              The bridge serves each printer under an <b>instance</b> id from its config
              (e.g. <code>labels</code>). If the bridge runs <b>on this computer</b>, add its
              address and this browser prints to it directly — no pairing to the cloud needed.
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <div className="text-xs text-muted mb-1">Instance on the bridge</div>
                <input className={field + " font-mono"} value={brInstance} onChange={(e) => setBrInstance(e.target.value)} placeholder="labels" />
              </label>
              <label className="block">
                <div className="text-xs text-muted mb-1">Named bridge (optional)</div>
                <input className={field + " font-mono"} value={brName} onChange={(e) => setBrName(e.target.value)} placeholder="workspace default" />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <div className="text-xs text-muted mb-1">Bridge on this computer (optional)</div>
                <input className={field + " font-mono"} value={brLocalUrl} onChange={(e) => setBrLocalUrl(e.target.value)} placeholder="http://127.0.0.1:8077" />
              </label>
              <label className="block">
                <div className="text-xs text-muted mb-1">Instance token (optional)</div>
                <input className={field} type="password" value={brToken} onChange={(e) => setBrToken(e.target.value)} autoComplete="off" />
              </label>
            </div>
            {brLocalUrl.trim() !== "" && (
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <div className="text-xs text-muted mb-1">Label width (mm)</div>
                  <input className={field} inputMode="decimal" value={brWidthMm} onChange={(e) => setBrWidthMm(e.target.value)} />
                </label>
                <label className="block">
                  <div className="text-xs text-muted mb-1">Label height (mm)</div>
                  <input className={field} inputMode="decimal" value={brHeightMm} onChange={(e) => setBrHeightMm(e.target.value)} />
                </label>
              </div>
            )}
          </div>
        )}
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
