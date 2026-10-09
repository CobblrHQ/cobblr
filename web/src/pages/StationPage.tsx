// /station/:slug/:address — a Station: a tablet or counter screen that a
// barcode scanner drives (#4640, docs/modules/station-screen.md).
//
// One scan, one big card. Something you already have shows its photo, its
// place and "You have 3", with +1 · Used one · Set total… · Move to…, each
// applied straight to the record's stock (no inbox detour). Something new is
// handed to the scan intake and shown at the same scale: its photo, its name,
// how many and one big Add, with More for the scan inbox's whole card. A Cobblr label opens its record.
//
// Opening the address is the setup: a tablet that has never been here shows a
// code to approve from a signed-in phone, then keeps a token that reaches only
// this station. Kiosk display by default (no app frame, the screen kept
// awake); `?kiosk=0` shows a frame for setting it up from a computer.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Check, Minus, MoreHorizontal, Plus, Hash, MapPin, Undo2, WifiOff, X } from "lucide-react";
import {
  DEFAULT_STATION_ADDRESS,
  STATION_ACTIONS,
  isStationAddress,
  oneTapOp,
  type StationAction,
  type StationLookup,
  type StationRecord,
  type StationSettings,
  type StationStockOp,
} from "@cobblr/platform-contract/station-screen";
import { api, ApiError, getToken, type Location, type ScanInboxItem, type OrgMembership, type StationRecordAction } from "../lib/api";
import { askBeforePress, pressAnswersToArgs } from "@cobblr/platform-contract/action-args";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";
import { AskBeforeRun, DragInput, OverlayLayer, SearchInput, useEscapeToClose, useLater, SegmentedChoice, type Asking, WorkspaceLink } from "@cobblr/platform-web";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";
import { FixedActiveOrgProvider } from "../auth/ActiveOrgContext";
import { WorkspacePlatformWeb } from "../WorkspacePlatformWeb";
import { InboxCard } from "./ScanInboxCard";
import { StationPhoto } from "./StationNewFace";
import {
  flushQueue,
  isRepeatScan,
  loadQueue,
  newRequestId,
  saveQueue,
  stationScanOf,
  type QueuedMove,
} from "../lib/station-screen";
import { lastStation, readStationToken, rememberStation, saveStationToken, setStationTokenOverride } from "../lib/station-token";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A request that never reached the server (no network), as opposed to one
 *  the server answered with a no. */
const unreachable = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 502;

// ── The route ──────────────────────────────────────────────────────────────

export function StationPage() {
  const { slug = "", address: raw } = useParams();
  const address = raw ?? DEFAULT_STATION_ADDRESS;
  const [params] = useSearchParams();
  const kiosk = params.get("kiosk") !== "0";
  // The device's own token, when this tablet was approved; else the person
  // signed in on this browser, when they are a member of the workspace.
  const [deviceToken, setDeviceToken] = useState(() => readStationToken(slug, address));
  const personToken = useMemo(() => getToken(), []);

  useEffect(() => {
    if (isStationAddress(address)) rememberStation(slug, address);
  }, [slug, address]);
  useStationManifest();

  if (!isStationAddress(address)) {
    return <Shell kiosk={false}><Centered title="Not a station address" body={`"${address}" can't be a station's address: use lowercase words and dashes, like pantry or garage-bench.`} /></Shell>;
  }
  if (deviceToken) {
    return (
      <DeviceStation
        slug={slug}
        address={address}
        token={deviceToken}
        kiosk={kiosk}
        onForget={() => {
          saveStationToken(slug, address, null);
          setDeviceToken(null);
        }}
      />
    );
  }
  return (
    <PersonOrApproval
      slug={slug}
      address={address}
      kiosk={kiosk}
      personToken={personToken}
      onApproved={(t) => {
        saveStationToken(slug, address, t);
        setDeviceToken(t);
      }}
    />
  );
}

/** `/station` on an installed station app: back to the station it opened. */
export function StationHome() {
  const last = lastStation();
  if (last) return <Navigate to={`/station/${last.slug}/${last.address}`} replace />;
  return (
    <Shell kiosk={false}>
      <Centered
        title="Open a station"
        body="A station is a page for a tablet and a barcode scanner. Make one in Cobblr under Configuration → Devices → Stations, then open its address on this tablet."
      />
    </Shell>
  );
}

/** The tablet's token is the tab's token while the station is open. */
function DeviceStation({ slug, address, token, kiosk, onForget }: { slug: string; address: string; token: string; kiosk: boolean; onForget: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setStationTokenOverride(token);
    setReady(true);
    return () => setStationTokenOverride(null);
  }, [token]);
  if (!ready) return <Shell kiosk={kiosk}><Centered title="Opening…" /></Shell>;
  return <StationLoader slug={slug} address={address} kiosk={kiosk} device onForget={onForget} />;
}

/** No device token: a signed-in member opens it as themselves; anyone else
 *  (signed out, another workspace's person, or a guest, whom a station's own
 *  routes refuse) sees the approval code without asking for the station. */
function PersonOrApproval({ slug, address, kiosk, personToken, onApproved }: { slug: string; address: string; kiosk: boolean; personToken: string | null; onApproved: (token: string) => void }) {
  const me = useQuery({ queryKey: ["station-me", !!personToken], queryFn: () => api.me(), enabled: !!personToken, retry: false, staleTime: 60_000 });
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role ?? null;
  const mayUse = !!role && role !== "guest";
  const asPerson = useQuery({
    queryKey: ["station-person", slug, address, !!personToken],
    queryFn: () => api.stationScreen(slug, address),
    enabled: !!personToken && mayUse,
    retry: false,
  });
  if (personToken && (me.isLoading || (mayUse && asPerson.isLoading))) return <Shell kiosk={kiosk}><Centered title="Opening…" /></Shell>;
  if (personToken && mayUse && asPerson.data) return <StationLoader slug={slug} address={address} kiosk={kiosk} device={false} onForget={() => {}} />;
  return <ApprovalView slug={slug} address={address} onApproved={onApproved} />;
}

// ── Approve this screen ────────────────────────────────────────────────────

function ApprovalView({ slug, address, onApproved }: { slug: string; address: string; onApproved: (token: string) => void }) {
  const [ask, setAsk] = useState<{ request_id: string; poll_key: string; code: string } | null>(null);
  const [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement | null>(null);

  const start = useCallback(async () => {
    setError("");
    try {
      setAsk(await api.stationRequest(slug, address));
    } catch (e) {
      setError(errText(e));
    }
  }, [slug, address]);

  useEffect(() => {
    void start();
  }, [start]);

  const approveUrl = ask ? `${window.location.origin}/w/${slug}/configuration/devices?tab=stations&approve=${ask.code}` : "";
  useEffect(() => {
    if (!approveUrl || !canvas.current) return;
    void QRCode.toCanvas(canvas.current, approveUrl, { width: 220, margin: 4 });
  }, [approveUrl]);

  useEffect(() => {
    if (!ask) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await api.stationPoll(ask.request_id, ask.poll_key);
        if (r.status === "approved" && r.token) return onApproved(r.token);
        if (r.status === "gone") return void start();
      } catch {
        // quiet: the network blinked; the next tick asks again, and the code stays on screen.
      }
      if (!stop) t = window.setTimeout(tick, 2000);
    };
    let t = window.setTimeout(tick, 2000);
    return () => {
      stop = true;
      window.clearTimeout(t);
    };
  }, [ask, onApproved, start]);

  return (
    <Shell kiosk>
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-4 py-10 text-center" data-testid="station-approve">
        <h1 className="text-3xl font-semibold">Approve this screen</h1>
        <p className="max-w-xl text-lg text-muted">
          To make this tablet{" "}
          {address === DEFAULT_STATION_ADDRESS ? (
            "this workspace's station"
          ) : (
            <>
              the <b className="text-content dark:text-mortar-100">{address}</b>
              {/(^|-)station$/.test(address) ? "" : " station"}
            </>
          )}
          , approve it from a phone or computer that is signed in to this workspace: scan the code, or open Configuration → Devices → Stations and type it.
        </p>
        {ask ? (
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:gap-10">
            <div className="font-mono text-6xl font-bold tracking-[0.2em] max-sm:text-5xl" data-testid="station-code" aria-label={`Code ${ask.code.split("").join(" ")}`}>
              {ask.code}
            </div>
            {/* White in both themes: a phone's camera reads dark on light. */}
            <canvas ref={canvas} className="rounded-lg bg-white dark:bg-white" aria-label="QR code to approve this screen" />
          </div>
        ) : (
          !error && <p className="text-muted">Asking for a code…</p>
        )}
        {error && (
          <p className="text-red-700 dark:text-red-300">
            {error}{" "}
            <button type="button" className="underline" onClick={() => void start()}>
              Try again
            </button>
          </p>
        )}
        <p className="text-sm text-muted">The code works once, for 15 minutes. Nothing is typed on this screen.</p>
      </div>
    </Shell>
  );
}

// ── The station ────────────────────────────────────────────────────────────

function StationLoader({ slug, address, kiosk, device, onForget }: { slug: string; address: string; kiosk: boolean; device: boolean; onForget: () => void }) {
  const screen = useQuery({ queryKey: ["station-screen", slug, address], queryFn: () => api.stationScreen(slug, address), retry: 1 });
  if (screen.isPending) return <Shell kiosk={kiosk}><Centered title="Opening…" /></Shell>;
  if (screen.error) {
    const gone = screen.error instanceof ApiError && (screen.error.status === 401 || screen.error.status === 403);
    return (
      <Shell kiosk={kiosk}>
        <Centered
          title={gone ? "This screen was stopped" : "The station did not open"}
          body={gone ? "Its approval was taken away in Configuration → Devices. Approve it again to use it." : errText(screen.error)}
          action={gone && device ? <BigButton onClick={onForget}>Approve again</BigButton> : undefined}
        />
      </Shell>
    );
  }
  const org: OrgMembership = { id: "", name: screen.data.label, slug, role: device ? "member" : "admin" };
  return (
    <FixedActiveOrgProvider org={org}>
      {/* The workspace's own platform context: the inbox card a new thing
          shows needs it, and the station is drawn outside the shell. */}
      <WorkspacePlatformWeb orgSlug={slug} role={org.role} appMode={false}>
        <Station slug={slug} address={address} kiosk={kiosk} device={device} label={screen.data.label} settings={screen.data.settings} hasPin={screen.data.has_pin} onForget={onForget} />
      </WorkspacePlatformWeb>
    </FixedActiveOrgProvider>
  );
}

type View =
  | { kind: "ready" }
  | { kind: "looking"; code: string }
  | { kind: "record"; record: StationRecord; countable: boolean }
  | { kind: "outside"; title: string }
  | { kind: "new"; item: ScanInboxItem }
  | { kind: "error"; message: string };

interface LastMove {
  request_id: string;
  words: string;
  queued: boolean;
  at: number;
  /** A record action's run (Lend, Log service), undone at its own door. */
  action?: boolean;
  /** False when the run handed back no way to undo it. */
  undoable?: boolean;
}

function Station(props: { slug: string; address: string; kiosk: boolean; device: boolean; label: string; settings: StationSettings; hasPin: boolean; onForget: () => void }) {
  const { slug, address, settings } = props;
  const qc = useQueryClient();
  const [view, setView] = useState<View>({ kind: "ready" });
  const [last, setLast] = useState<LastMove | null>(null);
  const [flash, setFlash] = useState<"ok" | "bad" | null>(null);
  const [keypad, setKeypad] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [mover, setMover] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [queue, setQueue] = useState<QueuedMove[]>(() => loadQueue(slug, address, Date.now()));
  const lastScan = useRef<{ code: string; at: number } | null>(null);
  const touchedAt = useRef(Date.now());

  const menu = useQuery({ queryKey: ["station-menu", slug], queryFn: () => api.scanMenu(slug).then((r) => r.items), staleTime: 5 * 60_000 });
  const places = useQuery({ queryKey: ["core-locations", slug], queryFn: () => api.listLocations(slug).then((r) => r.items), staleTime: 60_000 });

  useWakeLock();
  useStationTheme(settings.theme);

  const later = useLater();
  const signal = useCallback(
    (ok: boolean) => {
      if (settings.flash) {
        setFlash(ok ? "ok" : "bad");
        later.after("flash", 450, () => setFlash(null));
      }
      if (settings.sound) beep(ok);
    },
    [settings.flash, settings.sound, later],
  );

  // Back to "Ready to scan" after the station's quiet time, unless a keypad
  // or a picker is open (somebody is mid-answer).
  useEffect(() => {
    const id = window.setInterval(() => {
      if (view.kind === "ready" || keypad || mover || settingsOpen) return;
      if (Date.now() - touchedAt.current > settings.reset_seconds * 1000) {
        setView({ kind: "ready" });
        setLast(null);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [view.kind, keypad, mover, settingsOpen, settings.reset_seconds]);

  // ── Moving stock, with the offline queue ────────────────────────────────
  const persistQueue = useCallback(
    (q: QueuedMove[]) => {
      setQueue(q);
      saveQueue(slug, address, q);
    },
    [slug, address],
  );

  const count = useCallback(
    async (record: StationRecord, op: StationStockOp, value?: number) => {
      const request_id = newRequestId();
      const words = op === "add" ? `Added ${value ?? 1}` : op === "use" ? `Used ${value ?? 1}` : `Set to ${value}`;
      try {
        const moved = await api.stationCount(slug, address, { request_id, kind: record.kind, entity_id: record.id, op, ...(value !== undefined ? { value } : {}) });
        setView((v) => (v.kind === "record" && v.record.id === record.id ? { ...v, record: { ...v.record, qty: moved.qty } } : v));
        setLast({ request_id, words: moved.note ? `${words}. ${moved.note}` : words, queued: false, at: Date.now() });
        signal(true);
      } catch (e) {
        if (unreachable(e)) {
          const q = [...loadQueue(slug, address, Date.now()), { request_id, kind: record.kind, entity_id: record.id, op, ...(value !== undefined ? { value } : {}), title: record.title, at: Date.now() }];
          persistQueue(q);
          setLast({ request_id, words: `${words} (waiting to sync)`, queued: true, at: Date.now() });
          signal(true);
          return;
        }
        setView({ kind: "error", message: errText(e) });
        signal(false);
      }
    },
    [slug, address, signal, persistQueue],
  );

  const flush = useCallback(async () => {
    const q = loadQueue(slug, address, Date.now());
    if (!q.length) return;
    const r = await flushQueue(
      q,
      async (m) => void (await api.stationCount(slug, address, { request_id: m.request_id, kind: m.kind, entity_id: m.entity_id, op: m.op, ...(m.value !== undefined ? { value: m.value } : {}) })),
      unreachable,
    );
    persistQueue(r.waiting);
    if (r.refused.length) setView({ kind: "error", message: `${r.refused.length} waiting ${r.refused.length === 1 ? "change was" : "changes were"} refused: ${r.refused[0]!.why}` });
  }, [slug, address, persistQueue]);

  useEffect(() => {
    void flush();
    const on = () => void flush();
    window.addEventListener("online", on);
    const id = window.setInterval(on, 15_000);
    return () => {
      window.removeEventListener("online", on);
      window.clearInterval(id);
    };
  }, [flush]);

  // A known thing's own record actions (Lend, Log service): only what this
  // station offers, which is what Undo can take back (#4640).
  const recordKind = view.kind === "record" ? view.record.kind : null;
  const recordActions = useQuery({
    queryKey: ["station-actions", slug, address, recordKind],
    queryFn: () => api.stationActions(slug, address, recordKind!).then((r) => r.items),
    enabled: !!recordKind,
    staleTime: 5 * 60_000,
  });
  const runRecordAction = useCallback(
    (record: StationRecord, a: StationRecordAction) => {
      const go = async (args: Record<string, unknown>) => {
        const request_id = newRequestId();
        try {
          const r = await api.stationActionRun(slug, address, { request_id, action_id: a.id, kind: record.kind, entity_id: record.id, args });
          setLast({ request_id, words: r.summary || `${a.label}: ${record.title}`, queued: false, at: Date.now(), action: true, undoable: r.undoable });
          signal(true);
        } catch (e) {
          setView({ kind: "error", message: unreachable(e) ? "No connection. Try it again when the network is back." : errText(e) });
          signal(false);
        }
      };
      const ask = askBeforePress(a.args_schema, null);
      if (!ask.length) return void go({});
      setAsking({
        label: a.label,
        ask,
        submit: (answers) => {
          setAsking(null);
          touchedAt.current = Date.now();
          void go(pressAnswersToArgs(ask, answers));
        },
        cancel: () => setAsking(null),
      });
    },
    [slug, address, signal],
  );

  const undo = useCallback(async () => {
    if (!last) return;
    if (last.action) {
      try {
        await api.stationActionUndo(slug, address, last.request_id);
        setLast(null);
      } catch (e) {
        setView({ kind: "error", message: errText(e) });
      }
      return;
    }
    if (last.queued) {
      persistQueue(loadQueue(slug, address, Date.now()).filter((m) => m.request_id !== last.request_id));
      setLast(null);
      return;
    }
    try {
      const r = await api.stationUndo(slug, address, last.request_id);
      setView((v) => (v.kind === "record" ? { ...v, record: { ...v.record, qty: r.qty ?? v.record.qty } } : v));
      setLast(null);
    } catch (e) {
      setView({ kind: "error", message: errText(e) });
    }
  }, [last, slug, address, persistQueue]);

  // ── One scan ────────────────────────────────────────────────────────────
  const onScan = useCallback(
    async (raw: string) => {
      touchedAt.current = Date.now();
      const now = Date.now();
      if (isRepeatScan(lastScan.current, raw, now, settings.count_repeats)) return;
      lastScan.current = { code: raw, at: now };
      setKeypad(false);
      setMover(false);
      setLast(null);
      const scan = stationScanOf(raw);
      if (scan.kind === "ignore") return;
      setView({ kind: "looking", code: raw });
      let found: StationLookup;
      try {
        if (scan.kind === "label") {
          const r = await api.resolveQrToken(scan.token);
          if (!r?.entity_kind || !r.entity_id || (r.org_slug && r.org_slug !== slug)) {
            setView({ kind: "error", message: "That label is not one of this workspace's." });
            return signal(false);
          }
          found = await api.stationLookup(slug, address, { record: { kind: r.entity_kind, id: r.entity_id } });
        } else {
          found = await api.stationLookup(slug, address, { code: scan.code });
        }
      } catch (e) {
        setView({ kind: "error", message: unreachable(e) ? "No connection. Scan it again when the network is back." : errText(e) });
        return signal(false);
      }
      if (found.found === "record") {
        setView({ kind: "record", record: found.record, countable: found.countable });
        const op = oneTapOp(settings.action);
        if (op && found.countable) await count(found.record, op);
        else signal(true);
        return;
      }
      if (found.found === "outside") {
        setView({ kind: "outside", title: found.title });
        return signal(false);
      }
      if (scan.kind === "label") {
        setView({ kind: "error", message: "That label's record is gone." });
        return signal(false);
      }
      // Something new: the scan inbox's own intake, then its own card.
      try {
        const item = await api.scanBarcode(slug, { barcode: scan.code, ...(settings.new_location_id ? { target_location_id: settings.new_location_id } : {}) });
        setView({ kind: "new", item });
        signal(true);
      } catch (e) {
        setView({ kind: "error", message: errText(e) });
        signal(false);
      }
    },
    [slug, address, settings.action, settings.count_repeats, settings.new_location_id, count, signal],
  );

  useBarcodeWedge({ enabled: !keypad && !settingsOpen && !asking, onScan: (c) => void onScan(c) });

  // A bridge's scanner: codes it posted for this station, taken in order.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      if (document.visibilityState === "visible") {
        try {
          const r = await api.stationNextScan(slug, address);
          if (r.code) await onScan(r.code);
        } catch {
          // quiet: no network; the next tick asks again, and the header's waiting count says the rest.
        }
      }
      if (!stop) t = window.setTimeout(tick, 1500);
    };
    let t = window.setTimeout(tick, 1500);
    return () => {
      stop = true;
      window.clearTimeout(t);
    };
  }, [slug, address, onScan]);

  // A new thing's card fills in as the identify finishes in the background.
  const newId = view.kind === "new" ? view.item.id : null;
  useEffect(() => {
    if (!newId) return;
    let n = 0;
    const id = window.setInterval(async () => {
      if (++n > 30) return window.clearInterval(id);
      try {
        const item = await api.getScanItem(slug, newId);
        setView((v) => (v.kind === "new" && v.item.id === newId ? { kind: "new", item } : v));
      } catch {
        // quiet: the card already shows the item; the next tick asks again.
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [newId, slug]);

  return (
    <Shell kiosk={props.kiosk} large={settings.large_text}>
      <div
        className={`relative flex min-h-screen flex-col transition-colors duration-200 ${flash === "ok" ? "bg-moss-100 dark:bg-moss-900/40" : flash === "bad" ? "bg-red-100 dark:bg-red-950/50" : ""}`}
        onPointerDown={() => (touchedAt.current = Date.now())}
        data-testid="station"
      >
        <header className="flex items-center justify-between gap-3 px-4 pt-3 sm:px-6">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-muted">{props.label}</div>
            {settings.action !== "ask" && (
              <div className="text-xs text-muted">One-tap: {settings.action === "add-one" ? "every scan adds 1" : "every scan uses 1"}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {queue.length > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" data-testid="station-waiting">
                <WifiOff size={14} /> {queue.length} waiting to sync
              </span>
            )}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="rounded-full p-2.5 text-muted hover:bg-black/5 dark:hover:bg-white/10"
              aria-label="Station settings"
              title="Station settings"
            >
              <MoreHorizontal size={22} />
            </button>
          </div>
        </header>

        <main id={MAIN_ID} tabIndex={-1} className="flex flex-1 items-start justify-center px-4 pb-8 pt-4 outline-none sm:items-center sm:px-6">
          {view.kind === "ready" && <Ready label={props.label} last={last} onUndo={undo} />}
          {view.kind === "looking" && <Centered title="Looking it up…" body={view.code} />}
          {view.kind === "error" && <Notice tone="bad" title={view.message} onDismiss={() => setView({ kind: "ready" })} />}
          {view.kind === "outside" && (
            <Notice tone="bad" title={`${view.title} isn't kept at ${props.label}.`} body="Scan it at its own station, or change which collections this station keeps in its settings." onDismiss={() => setView({ kind: "ready" })} />
          )}
          {view.kind === "record" && (
            <RecordCard
              record={view.record}
              countable={view.countable}
              last={last}
              onCount={(op, value) => {
                touchedAt.current = Date.now();
                void count(view.record, op, value);
              }}
              onUndo={undo}
              onSetTotal={() => setKeypad(true)}
              onMove={() => setMover(true)}
              actions={recordActions.data ?? []}
              onAction={(a) => {
                touchedAt.current = Date.now();
                runRecordAction(view.record, a);
              }}
              onDone={() => setView({ kind: "ready" })}
            />
          )}
          {view.kind === "new" && (
            <div className="w-full max-w-3xl space-y-4" data-testid="station-new">
              <InboxCard
                item={view.item}
                pageTarget={null}
                menu={menu.data ?? null}
                hasLocations={(places.data?.length ?? 0) > 0}
                defaultExpanded
                station={{
                  onFiled: () => {
                    setView({ kind: "ready" });
                    signal(true);
                  },
                }}
              />
              <div className="flex justify-end">
                <BigButton tone="plain" onClick={() => setView({ kind: "ready" })}>
                  Not now
                </BigButton>
              </div>
            </div>
          )}
        </main>

        {keypad && view.kind === "record" && (
          <Keypad
            title={`How many ${view.record.title} are there?`}
            start={view.record.qty ?? 0}
            onCancel={() => setKeypad(false)}
            onDone={(n) => {
              setKeypad(false);
              void count(view.record, "total", n);
            }}
          />
        )}
        {mover && view.kind === "record" && (
          <PlacePicker
            places={places.data ?? []}
            onCancel={() => setMover(false)}
            onPick={async (loc) => {
              setMover(false);
              try {
                await api.stationMove(slug, address, { kind: view.record.kind, entity_id: view.record.id, location_id: loc.id });
                setView({ kind: "record", record: { ...view.record, location_id: loc.id, location_name: loc.name }, countable: view.countable });
                signal(true);
              } catch (e) {
                setView({ kind: "error", message: errText(e) });
                signal(false);
              }
            }}
          />
        )}
        <AskBeforeRun asking={asking} />
        {settingsOpen && (
          <SettingsSheet
            slug={slug}
            address={address}
            device={props.device}
            hasPin={props.hasPin}
            label={props.label}
            settings={settings}
            menu={menu.data ?? []}
            places={places.data ?? []}
            onClose={() => setSettingsOpen(false)}
            onSaved={() => void qc.invalidateQueries({ queryKey: ["station-screen", slug, address] })}
            onForget={props.onForget}
          />
        )}
      </div>
    </Shell>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function Ready({ label, last, onUndo }: { label: string; last: LastMove | null; onUndo: () => void }) {
  return (
    <div className="flex flex-col items-center gap-6 py-16 text-center" data-testid="station-ready">
      <div className="text-5xl font-semibold max-sm:text-4xl">Ready to scan</div>
      <p className="max-w-md text-lg text-muted">Scan a barcode or a Cobblr label with the scanner. {label} shows what it is.</p>
      {last && <UndoBar last={last} onUndo={onUndo} />}
    </div>
  );
}

function UndoBar({ last, onUndo }: { last: LastMove; onUndo: () => void }) {
  return (
    <div className="inline-flex items-center gap-3 rounded-full bg-moss-100 px-4 py-2 text-lg text-moss-900 dark:bg-moss-900/40 dark:text-moss-100" role="status" data-testid="station-last">
      <Check size={20} /> {last.words}
      {last.undoable !== false && <button type="button" onClick={onUndo} className="inline-flex items-center gap-1 rounded-full px-3 py-1 font-medium underline-offset-2 hover:underline">
        <Undo2 size={18} /> Undo
      </button>}
    </div>
  );
}

function RecordCard(props: {
  /** The record's own actions this station offers (Lend, Log service). */
  actions: StationRecordAction[];
  onAction: (a: StationRecordAction) => void;
  record: StationRecord;
  countable: boolean;
  last: LastMove | null;
  onCount: (op: StationStockOp, value?: number) => void;
  onUndo: () => void;
  onSetTotal: () => void;
  onMove: () => void;
  onDone: () => void;
}) {
  const r = props.record;
  return (
    <div className="w-full max-w-4xl" data-testid="station-record">
      <div className="flex gap-5 max-sm:flex-col">
        <div className="w-40 shrink-0 max-sm:w-28">
          <StationPhoto src={r.image_path} alt={r.title} />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <h1 className="text-3xl font-semibold leading-tight max-sm:text-2xl">{r.title}</h1>
          {r.location_name && (
            <div className="inline-flex items-center gap-1.5 text-lg text-muted">
              <MapPin size={18} /> {r.location_name}
            </div>
          )}
          {props.countable && (
            <div className="text-4xl font-bold" data-testid="station-qty">
              You have {r.qty ?? 0}
            </div>
          )}
        </div>
      </div>
      {props.last && (
        <div className="mt-5">
          <UndoBar last={props.last} onUndo={props.onUndo} />
        </div>
      )}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {props.countable && (
          <>
            <BigButton onClick={() => props.onCount("add")}>
              <Plus size={26} /> +1
            </BigButton>
            <BigButton onClick={() => props.onCount("use")} disabled={(r.qty ?? 0) <= 0}>
              <Minus size={26} /> Used one
            </BigButton>
            <BigButton tone="plain" onClick={props.onSetTotal}>
              <Hash size={22} /> Set total…
            </BigButton>
          </>
        )}
        <BigButton tone="plain" onClick={props.onMove}>
          <MapPin size={22} /> Move to…
        </BigButton>
      </div>
      {props.actions.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="station-record-actions">
          {props.actions.map((a) => (
            <BigButton key={a.id} tone="plain" onClick={() => props.onAction(a)}>
              {a.label}
            </BigButton>
          ))}
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={props.onDone} className="px-3 py-2 text-lg text-muted underline-offset-2 hover:underline">
          Done
        </button>
      </div>
    </div>
  );
}

function Keypad({ title, start, onCancel, onDone }: { title: string; start: number; onCancel: () => void; onDone: (n: number) => void }) {
  const [v, setV] = useState(String(start));
  const press = (k: string) => setV((cur) => (k === "back" ? cur.slice(0, -1) : cur === "0" ? k : (cur + k).slice(0, 6)));
  return (
    <Overlay onCancel={onCancel} label={title}>
      <div className="text-xl font-medium">{title}</div>
      <div className="my-4 rounded-xl bg-black/5 py-4 text-center text-5xl font-bold dark:bg-white/10" data-testid="station-keypad-value">
        {v || "0"}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "back", "0", "ok"].map((k) =>
          k === "ok" ? (
            <BigButton key={k} onClick={() => onDone(Number(v || 0))}>
              Set
            </BigButton>
          ) : (
            <BigButton key={k} tone="plain" onClick={() => press(k)} label={k === "back" ? "Delete a digit" : undefined}>
              {k === "back" ? "⌫" : k}
            </BigButton>
          ),
        )}
      </div>
    </Overlay>
  );
}

function PlacePicker({ places, onCancel, onPick }: { places: Location[]; onCancel: () => void; onPick: (l: Location) => void }) {
  const [q, setQ] = useState("");
  const shown = places.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return (
    <Overlay onCancel={onCancel} label="Move to">
      <div className="text-xl font-medium">Move to…</div>
      <div className="my-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search places" aria-label="Search places" size="lg" />
      </div>
      <div className="max-h-[50vh] space-y-2 overflow-y-auto">
        {shown.map((p) => (
          <button key={p.id} type="button" onClick={() => onPick(p)} className="block w-full rounded-xl border border-line px-4 py-3 text-left text-lg hover:border-cobble-400 dark:border-slate-600" style={{ paddingLeft: `${1 + Math.min(p.depth, 4) * 0.75}rem` }}>
            {p.name}
          </button>
        ))}
        {!shown.length && <p className="text-muted">No place by that name.</p>}
      </div>
    </Overlay>
  );
}

function SettingsSheet(props: {
  slug: string;
  address: string;
  device: boolean;
  hasPin: boolean;
  label: string;
  settings: StationSettings;
  menu: Array<{ kind: string; label: string }>;
  places: Location[];
  onClose: () => void;
  onSaved: () => void;
  onForget: () => void;
}) {
  const [pin, setPin] = useState("");
  const [unlocked, setUnlocked] = useState(!props.device);
  const [draft, setDraft] = useState<StationSettings>(props.settings);
  const [label, setLabel] = useState(props.label);
  const [newPin, setNewPin] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof StationSettings>(k: K, v: StationSettings[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.saveStationScreen(props.slug, props.address, {
        label,
        settings: draft,
        ...(props.device ? { pin } : newPin ? { new_pin: newPin } : {}),
      });
      props.onSaved();
      props.onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };
  const actionWords: Record<StationAction, string> = { ask: "Ask: show the buttons", "add-one": "One-tap: every scan adds 1", "use-one": "One-tap: every scan uses 1" };
  return (
    <Overlay onCancel={props.onClose} label="Station settings" wide>
      <div className="flex items-center justify-between">
        <div className="text-xl font-medium">{props.label} settings</div>
        <button type="button" onClick={props.onClose} className="rounded-full p-2 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Close">
          <X size={20} />
        </button>
      </div>
      {!unlocked ? (
        <div className="mt-4 space-y-3">
          <p className="text-muted">{props.hasPin ? "Type the owner PIN to change this station." : "This station has no PIN. Change its settings from a signed-in phone or computer, where an owner can also set a PIN."}</p>
          {props.hasPin && (
            <div className="flex gap-2">
              <input inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} className="w-40 rounded-xl border border-line px-4 py-3 text-2xl tracking-widest dark:border-slate-600 dark:bg-slate-800" aria-label="Owner PIN" />
              <BigButton onClick={() => setUnlocked(pin.length >= 4)}>Unlock</BigButton>
            </div>
          )}
          <button type="button" onClick={props.onForget} className="text-sm text-muted underline">
            Stop using this tablet as the station
          </button>
        </div>
      ) : (
        <div className="mt-4 max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <Field label="Name">
            <input value={label} onChange={(e) => setLabel(e.target.value)} className="w-full rounded-xl border border-line px-3 py-2 text-lg dark:border-slate-600 dark:bg-slate-800" />
          </Field>
          <Field label="When a scan is something you have">
            <div className="grid gap-2">
              <SegmentedChoice
                label="When a scan is something you have"
                value={draft.action}
                onChange={(a) => set("action", a)}
                options={STATION_ACTIONS.map((a) => ({ value: a, label: actionWords[a] }))}
              />
              {draft.action !== "ask" && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={draft.count_repeats} onChange={(e) => set("count_repeats", e.target.checked)} /> Count a second scan of the same thing within 2 seconds
                </label>
              )}
            </div>
          </Field>
          <Field label="New things go to">
            <div className="grid gap-2 sm:grid-cols-2">
              <select value={draft.new_kind ?? ""} onChange={(e) => set("new_kind", e.target.value || null)} className="rounded-xl border border-line px-3 py-2 dark:border-slate-600 dark:bg-slate-800" aria-label="Collection for new things">
                <option value="">Wherever the scan inbox routes them</option>
                {props.menu.map((m) => (
                  <option key={m.kind} value={m.kind}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select value={draft.new_location_id ?? ""} onChange={(e) => set("new_location_id", e.target.value || null)} className="rounded-xl border border-line px-3 py-2 dark:border-slate-600 dark:bg-slate-800" aria-label="Place for new things">
                <option value="">No place</option>
                {props.places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </Field>
          <Field label="Collections this station keeps">
            <div className="flex flex-wrap gap-2">
              {props.menu.map((m) => {
                const on = draft.collections.includes(m.kind);
                return (
                  <button
                    key={m.kind}
                    type="button"
                    onClick={() => set("collections", on ? draft.collections.filter((k) => k !== m.kind) : [...draft.collections, m.kind])}
                    className={`rounded-full border px-3 py-1.5 ${on ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-900/30" : "border-line dark:border-slate-600"}`}
                    aria-pressed={on}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-sm text-muted">{draft.collections.length ? "Only these." : "None picked: every collection."}</p>
          </Field>
          <Field label={`Back to Ready after ${draft.reset_seconds} seconds with no touch`}>
            <DragInput control="range" min={3} max={60} value={draft.reset_seconds} onPreview={(v) => set("reset_seconds", Number(v))} onCommit={(v) => set("reset_seconds", Number(v))} className="w-full" aria-label="Seconds before Ready" />
          </Field>
          <Field label="Signals">
            <label className="mr-4 inline-flex items-center gap-2">
              <input type="checkbox" checked={draft.sound} onChange={(e) => set("sound", e.target.checked)} /> Sound
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={draft.flash} onChange={(e) => set("flash", e.target.checked)} /> Flash
            </label>
          </Field>
          <Field label="Display">
            <select value={draft.theme} onChange={(e) => set("theme", e.target.value as StationSettings["theme"])} className="mr-3 rounded-xl border border-line px-3 py-2 dark:border-slate-600 dark:bg-slate-800" aria-label="Theme">
              <option value="system">Follow the tablet</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={draft.large_text} onChange={(e) => set("large_text", e.target.checked)} /> Large text
            </label>
          </Field>
          {!props.device && (
            <Field label={props.hasPin ? "Change the owner PIN" : "Owner PIN (lets the tablet change these)"}>
              <input inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="4 to 8 digits" className="w-48 rounded-xl border border-line px-3 py-2 dark:border-slate-600 dark:bg-slate-800" aria-label="New PIN" />
            </Field>
          )}
          {error && <p className="text-red-700 dark:text-red-300">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            {props.device ? (
              <button type="button" onClick={props.onForget} className="text-sm text-muted underline">
                Stop using this tablet as the station
              </button>
            ) : (
              <WorkspaceLink slug={props.slug} to={`/configuration/devices?tab=stations`} className="text-sm text-muted underline">
                Approved screens
              </WorkspaceLink>
            )}
            <BigButton onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </BigButton>
          </div>
        </div>
      )}
    </Overlay>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium text-muted">{label}</div>
      {children}
    </div>
  );
}

function Overlay({ children, onCancel, label, wide }: { children: ReactNode; onCancel: () => void; label: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscapeToClose(true, ref, onCancel);
  return (
    <OverlayLayer ref={ref} className="z-50 flex items-end justify-center bg-black/40 sm:items-center" role="dialog" aria-modal="true" aria-label={label} onClick={onCancel}>
      <div className={`w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-t-2xl bg-surface p-5 shadow-xl dark:bg-slate-900 sm:rounded-2xl`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </OverlayLayer>
  );
}

function Notice({ tone, title, body, onDismiss }: { tone: "bad" | "ok"; title: string; body?: string; onDismiss: () => void }) {
  return (
    <div className={`w-full max-w-2xl rounded-2xl border p-6 ${tone === "bad" ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40" : "border-moss-300 bg-moss-50 dark:bg-moss-900/30"}`} role="alert">
      <div className="text-2xl font-semibold">{title}</div>
      {body && <p className="mt-2 text-lg text-muted">{body}</p>}
      <div className="mt-4 flex justify-end">
        <BigButton tone="plain" onClick={onDismiss}>
          OK
        </BigButton>
      </div>
    </div>
  );
}

function BigButton({ children, onClick, tone = "solid", disabled, label }: { children: ReactNode; onClick: () => void; tone?: "solid" | "plain"; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`inline-flex min-h-[64px] items-center justify-center gap-2 rounded-2xl px-5 text-xl font-semibold transition disabled:opacity-40 ${
        tone === "solid" ? "bg-cobble-600 text-white hover:bg-cobble-700" : "border border-line bg-surface text-content hover:border-cobble-400 dark:border-slate-600 dark:bg-slate-800 dark:text-mortar-100"
      }`}
    >
      {children}
    </button>
  );
}

function Centered({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-3 px-4 text-center">
      <div className="text-3xl font-semibold">{title}</div>
      {body && <p className="text-lg text-muted">{body}</p>}
      {action}
    </div>
  );
}

/** The kiosk frame: the whole screen, the station's own type size. */
function Shell({ children, kiosk, large }: { children: ReactNode; kiosk: boolean; large?: boolean }) {
  return (
    <div className={`min-h-screen bg-canvas text-content dark:bg-slate-950 dark:text-mortar-100 ${large ? "text-[118%]" : ""}`}>
      <SkipToContent />
      {!kiosk && (
        <div className="border-b border-line px-4 py-2 text-sm text-muted dark:border-slate-800">
          Station · shown with a frame for setting it up (open it without <code>?kiosk=0</code> on the tablet)
        </div>
      )}
      {children}
    </div>
  );
}

// ── The device ─────────────────────────────────────────────────────────────

/** Installed from here, the app is the Station: it opens at /station (back
 *  to this station) full screen, not at the workspace's home. */
function useStationManifest() {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) return;
    const was = link.href;
    link.href = "/station.webmanifest";
    return () => void (link.href = was);
  }, []);
}

/** Keep the screen on while the station is open; a tablet that says no is
 *  left to its own sleep setting. */
function useWakeLock() {
  useEffect(() => {
    let stopped = false;
    let lock: WakeLockSentinel | undefined;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || !navigator.wakeLock) return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (stopped) await next.release();
        else lock = next;
      } catch {
        // The tablet can refuse to stay awake (battery saver).
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
    };
  }, []);
}

/** The station's own light or dark, over the app's, while it is open. */
function useStationTheme(theme: StationSettings["theme"]) {
  useEffect(() => {
    if (theme === "system") return;
    const root = document.documentElement;
    const had = root.classList.contains("dark");
    root.classList.toggle("dark", theme === "dark");
    return () => void root.classList.toggle("dark", had);
  }, [theme]);
}

let audio: AudioContext | null = null;
/** A short tone: high for done, low for a no. */
function beep(ok: boolean) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.09 : 0.25));
  } catch {
    // No sound on this device.
  }
}
