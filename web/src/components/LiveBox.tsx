// LiveBox — the Live box (docs/design-decisions/live-controls.md). A self-hiding
// surface for ongoing session modes. It renders whatever GET /orgs/:slug/live
// returns (the applicable live controls for this workspace) and nothing when that
// is empty. The toggle IS the icon: a green ring = on, a grey ring = off, click to
// flip.
//
// Two placements, chosen by the host (same split as LabelsBasket / DriveBanner):
//   • mode="sidebar" — a bare row of icon-rings in the full-sidebar foot, that
//     expands into a panel flying out to the RIGHT of the sidebar (the account-menu
//     pattern; never crushes the nav). Contained so it can never overshoot.
//   • mode="floating" — a single outlined pill (the icons that are ON) fixed
//     bottom-right; tapping it morphs into a panel whose collapse strip is at the
//     BOTTOM, the same corner you tapped to open.

import { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Bot } from "lucide-react";
import { api } from "../lib/api";
import {
  useToast, usePrintProgress, useBridgeLive, BridgePrinterCard,
  isLocalBridgePrinter, readLocalBridgeStatus, setPrinterStatus,
  type BridgeInstanceLive,
} from "@cobblr/platform-web";
import { iconForName } from "../lib/panel-icons";
import { useDrive } from "./DriveContext";
import { tabBrowserId, type DriveState } from "../hooks/useBrowserDrive";
import type { LiveControlPublic } from "@cobblr/platform-contract";

type ControlState = Record<string, unknown> | null;

/** A control is ON when its server state carries `enabled: true` (the convention
 *  for server-scoped live controls). */
function isOn(state: ControlState): boolean {
  return !!(state && (state as { enabled?: boolean }).enabled);
}

function useLive(slug: string) {
  const controlsQ = useQuery({
    queryKey: ["live", slug],
    queryFn: () => api.getLive(slug),
    enabled: !!slug,
    refetchInterval: 30_000,
  });
  const controls = controlsQ.data?.controls ?? [];
  // Fetch every server-scoped control's current state in one query (a control
  // without an endpoint — a future tab-scoped one — has no server state).
  const statesQ = useQuery({
    queryKey: ["live-states", slug, controls.map((c) => c.id).join(",")],
    enabled: !!slug && controls.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const pairs = await Promise.all(
        controls
          .filter((c) => c.endpoint)
          .map(async (c) => {
            try {
              return [c.id, await api.liveState(slug, c.endpoint!)] as const;
            } catch {
              return [c.id, null] as const;
            }
          }),
      );
      return Object.fromEntries(pairs) as Record<string, ControlState>;
    },
  });
  return { controls, states: statesQ.data ?? {} };
}

function useToggle(slug: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  return useMutation({
    mutationFn: async (args: { control: LiveControlPublic; state: ControlState }) => {
      const { control, state } = args;
      if (!control.endpoint) {
        // Tab-scoped (or endpoint-less) controls have no server flip yet — open
        // their detail so the user can act. (Scan-drive lands here until its
        // client adapter ships.)
        if (control.detail) navigate(control.detail);
        return;
      }
      // Flip `enabled`, preserving the rest of the policy (auto-print's PUT needs
      // the full body). If the server rejects it (e.g. enabling before a printer
      // + size are chosen), send the user to configure instead.
      await api.liveSet(slug, control.endpoint, { ...(state ?? {}), enabled: !isOn(state) });
    },
    onError: (_e, args) => {
      if (args.control.detail) {
        toast.info("Finish setting this up first.");
        navigate(args.control.detail);
      } else {
        toast.error("Couldn't change that.");
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["live-states", slug] });
    },
  });
}

// Drive fold-in (docs/design-decisions/live-controls.md §8, decided: active-only so
// the box stays self-hiding). The drive state comes from DriveContext (the single
// always-mounted SSE stream); an active/elsewhere session becomes a data control
// row, and an offer becomes a prompt the box raises. Nothing about "drive" is
// hardcoded into the renderer — it's just another control entry + a prompt.
const DRIVE_ID = "drive.window";
/** The drive indicator as a data control, derived from the (SSE-driven) drive
 *  state: a green ring while THIS tab is driven, a grey one while another window
 *  is. `offer` / `idle` produce no row (an offer is handled as a prompt below). */
function driveControl(state: DriveState, byScans: boolean): LiveControlPublic | null {
  if (state !== "active" && state !== "elsewhere") return null;
  const here = state === "active";
  const who = byScans ? "Scans" : "Claude";
  const verb = byScans ? "drive" : "drives";
  const label = here ? `${who} ${verb} this screen` : `${who} ${verb} another window`;
  return { id: DRIVE_ID, module: "core", label, icon: byScans ? "scan-line" : "bot", requires: "", scope: "tab", control: "switch" };
}

const BRIDGE_ID = "client.bridge-printers";

/** The bridge's printers as a Live control.
 *
 *  Client-side, like the drive indicator above: the bridge answers on this
 *  machine, so the server has nothing to say about it. Self-hiding — no bridge
 *  running means no row at all, which is the normal case for most people and
 *  must not read as something being wrong.
 *
 *  The ring is ON when a link is held, so the Live box tells you at a glance
 *  that a printer is ready to fire without opening anything. */
function bridgeControl(live: { reachable: boolean; instances: BridgeInstanceLive[] }): LiveControlPublic | null {
  if (!live.reachable || live.instances.length === 0) return null;
  const held = live.instances.filter((i) => i.link === "connected").length;
  const printing = live.instances.some((i) => i.link === "printing");
  const label = printing
    ? "Printing"
    : held > 0
      ? `Printer connected${live.instances.length > 1 ? ` (${held} of ${live.instances.length})` : ""}`
      : "Printers on this computer";
  return { id: BRIDGE_ID, module: "core", label, icon: "printer", requires: "", scope: "tab", control: "switch" };
}

/** The offer prompt — the box asking a question. Surfaces from the indicator spot
 *  (bottom-right floating, or a right-flyout in the sidebar). Yes claims THIS tab;
 *  "not here" declines. */
function OfferPrompt({
  mode,
  byScans,
  onAccept,
  onDecline,
}: {
  mode: "sidebar" | "floating";
  byScans: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const card = (
    <div className="w-[236px] rounded-xl border border-cobble-300 dark:border-cobble-700 bg-surface dark:bg-slate-900 shadow-xl p-3 space-y-2.5">
      <div className="flex items-start gap-2">
        <Bot size={18} className="text-cobble-600 shrink-0 mt-0.5" />
        <div className="text-[13px] text-content dark:text-mortar-100">
          <strong>{byScans ? "Scans want" : "Claude wants"} to drive.</strong> Use <em>this</em> window?
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onAccept}
          className="flex-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-[13px] font-medium px-3 py-1.5"
        >
          Yes, use this
        </button>
        <button
          type="button"
          onClick={onDecline}
          className="rounded-md border border-line dark:border-slate-600 text-[13px] px-3 py-1.5 hover:bg-subtle dark:hover:bg-slate-800"
        >
          Not here
        </button>
      </div>
    </div>
  );
  if (mode === "floating") return <div className="fixed bottom-4 right-4 z-[900]">{card}</div>;
  return (
    <div className="relative">
      <div className="absolute left-full bottom-1 ml-1.5 z-[60]">{card}</div>
    </div>
  );
}

// scan.drive is tab-scoped (docs/design-decisions/live-controls.md §6): its state
// lives in localStorage, not a server endpoint. This adapter mirrors the ScanPage
// useScanDrive on/off + Open/Print mode + grant/claim so the Live box can drive the
// same "this window follows scans" opt-in from anywhere.
const SCAN_DRIVE_ID = "core-scan.scan-drive";
type ScanDispo = "navigate" | "print";
function useScanDriveControl(slug: string) {
  const qc = useQueryClient();
  const [on, setOnState] = useState(false);
  const [mode, setModeState] = useState<ScanDispo>("navigate");
  const raised = useRef(false);
  const bid = useRef(tabBrowserId());

  useEffect(() => {
    if (!slug) return;
    setOnState(localStorage.getItem(`cobblr.scanDrive.${slug}`) === "1");
    setModeState(localStorage.getItem(`cobblr.scanDriveMode.${slug}`) === "print" ? "print" : "navigate");
  }, [slug]);

  // Claim this tab as the driven one while opted in, so scans route here.
  useEffect(() => {
    if (!on || !slug) return;
    const claim = () => {
      void api.driveTabAccept(slug, bid.current).catch(() => {});
      void qc.invalidateQueries({ queryKey: ["drive-status", slug] });
    };
    claim();
    const iv = setInterval(claim, 1500);
    return () => clearInterval(iv);
  }, [on, slug, qc]);

  const toggle = () => {
    if (!slug) return;
    if (on) {
      setOnState(false);
      localStorage.removeItem(`cobblr.scanDrive.${slug}`);
      void api.driveTabRelease(slug, bid.current).catch(() => {});
      if (raised.current) {
        raised.current = false;
        void api.setDriveGrant(slug, "off").finally(() => qc.invalidateQueries({ queryKey: ["drive-grant", slug] }));
      }
      return;
    }
    // Raise the grant only if it's off (don't downgrade a Claude grant).
    void api
      .driveGrant(slug)
      .then((g) => {
        if (g.mode === "off") {
          raised.current = true;
          return api.setDriveGrant(slug, "navigate");
        }
        return null;
      })
      .catch(() => null)
      .finally(() => {
        void qc.invalidateQueries({ queryKey: ["drive-grant", slug] });
        setOnState(true);
        localStorage.setItem(`cobblr.scanDrive.${slug}`, "1");
      });
  };

  const setMode = (m: ScanDispo) => {
    if (!slug) return;
    setModeState(m);
    localStorage.setItem(`cobblr.scanDriveMode.${slug}`, m);
  };

  return { on, mode, toggle, setMode };
}

// ── the icon-ring toggle ──────────────────────────────────────────
function Ring({
  control,
  on,
  size = 34,
  onClick,
  badge = 0,
}: {
  control: LiveControlPublic;
  on: boolean;
  size?: number;
  onClick?: (e: React.MouseEvent) => void;
  /** A taskbar-style count over the icon (labels still to print); 0 hides it. */
  badge?: number;
}) {
  const Icon = iconForName(control.icon);
  return (
    <button
      type="button"
      title={badge > 0 ? `${badge} to print` : control.label}
      aria-pressed={on}
      onClick={onClick}
      style={{ width: size, height: size }}
      className={
        "relative shrink-0 grid place-items-center rounded-full border-2 transition " +
        (onClick ? "cursor-pointer hover:brightness-110 " : "cursor-default ") +
        (on
          ? "border-[#6B8E4E] bg-[#6B8E4E]/15 text-[#4f6c39] dark:text-[#a9c48c]"
          : "border-slate-400 dark:border-slate-600 bg-transparent text-muted dark:text-slate-400")
      }
    >
      <Icon size={Math.round(size * 0.48)} />
      {badge > 0 && <CountBadge n={badge} />}
    </button>
  );
}

/** The little job-count bubble on the printer icon while a batch streams out —
 *  the print-manager-in-the-taskbar cue. */
function CountBadge({ n }: { n: number }) {
  return (
    <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-[3px] grid place-items-center rounded-full bg-cobble-600 text-white text-[9px] font-semibold leading-none tabular-nums shadow ring-1 ring-surface dark:ring-slate-900">
      {n > 99 ? "99+" : n}
    </span>
  );
}

// ── a control row in the expanded panel ───────────────────────────
function Row({
  control,
  on,
  onToggle,
  segment,
  badge = 0,
  detail,
}: {
  control: LiveControlPublic;
  on: boolean;
  onToggle: () => void;
  segment?: { value: string; onChange: (v: string) => void };
  badge?: number;
  /** A control's OWN expanded view, revealed under its ring — the same shape as
   *  the segment strip below, for a control whose detail is richer than options. */
  detail?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const opts = control.segment ?? [];
  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-2">
      <div className="flex items-center gap-2.5">
        <Ring control={control} on={on} size={32} onClick={() => onToggle()} badge={badge} />
        <span className="font-semibold text-[12.5px] leading-tight text-content dark:text-mortar-100">
          {control.label}
        </span>
      </div>
      {on && control.control === "switch-segment" && segment && opts.length > 0 && (
        <div className="mt-2 ml-[42px] inline-flex rounded-md border border-line dark:border-slate-700 overflow-hidden">
          {opts.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => segment.onChange(o.value)}
              className={
                "px-2.5 py-0.5 text-[11px] transition " +
                (segment.value === o.value
                  ? "bg-cobble-600 text-white"
                  : "text-muted dark:text-slate-400 hover:text-content dark:hover:text-mortar-100")
              }
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {detail && <div className="mt-2 flex flex-col gap-1.5">{detail}</div>}
      {on && control.detail && (
        <button
          type="button"
          onClick={() => navigate(control.detail!)}
          className="mt-1.5 ml-[42px] block text-[10.5px] text-muted dark:text-slate-400 hover:text-accent"
        >
          configure ›
        </button>
      )}
    </div>
  );
}

function Panel({
  controls,
  states,
  onToggle,
  footerAtBottom,
  onClose,
  segmentState,
  badgeFor,
  detailFor,
}: {
  controls: LiveControlPublic[];
  states: Record<string, ControlState>;
  onToggle: (c: LiveControlPublic) => void;
  footerAtBottom?: boolean;
  onClose: () => void;
  segmentState?: (c: LiveControlPublic) => { value: string; onChange: (v: string) => void } | undefined;
  badgeFor?: (c: LiveControlPublic) => number;
  /** Rendered under a control that owns its own expanded view. */
  detailFor?: (c: LiveControlPublic) => React.ReactNode;
}) {
  const onIcons = controls.filter((c) => isOn(states[c.id] ?? null));
  const header = (
    <button
      type="button"
      onClick={onClose}
      className={
        "flex items-center gap-2 w-full px-2.5 py-1.5 text-[12px] font-semibold text-content dark:text-mortar-100 cursor-pointer bg-cobble-50 dark:bg-cobble-900/30 " +
        (footerAtBottom ? "border-t border-line dark:border-slate-700" : "border-b border-line dark:border-slate-700")
      }
    >
      <span>Live</span>
      {footerAtBottom &&
        onIcons.map((c) => {
          const Icon = iconForName(c.icon);
          return <Icon key={c.id} size={13} className="text-[#6B8E4E]" />;
        })}
      <span className="flex-1" />
      <ChevronDown size={15} className="text-muted" />
    </button>
  );
  const body = (
    <div className="p-2 flex flex-col gap-2">
      {controls.map((c) => (
        <Row
          key={c.id}
          control={c}
          on={isOn(states[c.id] ?? null)}
          onToggle={() => onToggle(c)}
          segment={segmentState ? segmentState(c) : undefined}
          badge={badgeFor ? badgeFor(c) : 0}
          detail={detailFor ? detailFor(c) : undefined}
        />
      ))}
    </div>
  );
  return (
    <div className="w-[236px] rounded-xl border border-cobble-300 dark:border-cobble-700 bg-surface dark:bg-slate-900 overflow-hidden shadow-xl">
      {footerAtBottom ? (
        <>
          {body}
          {header}
        </>
      ) : (
        <>
          {header}
          {body}
        </>
      )}
    </div>
  );
}

export function LiveBox({ mode, slug }: { mode: "sidebar" | "floating"; slug: string | undefined }) {
  const [open, setOpen] = useState(false);
  // The sidebar flyout is PORTALED to <body> and fixed-positioned: rendered in
  // place (absolute left-full) it flew out past the sidebar's overflow-hidden
  // edge and got clipped, so the menu "never opened" (the author, 2026-07-30). rowRef
  // anchors it to the right of the icon row.
  const rowRef = useRef<HTMLDivElement>(null);
  const [flyoutPos, setFlyoutPos] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || mode !== "sidebar" || !rowRef.current) {
      setFlyoutPos(null);
      return;
    }
    const set = () => {
      const r = rowRef.current?.getBoundingClientRect();
      if (r) setFlyoutPos({ left: r.right + 8, bottom: window.innerHeight - r.bottom });
    };
    set();
    window.addEventListener("resize", set);
    return () => window.removeEventListener("resize", set);
  }, [open, mode]);
  const { controls: serverControls, states: serverStates } = useLive(slug ?? "");
  const toggle = useToggle(slug ?? "");
  const drive = useDrive();
  const scanDrive = useScanDriveControl(slug ?? "");
  // Labels still to print in the batch in flight (BLE), for the taskbar-style count
  // on the printer icon. The print path publishes this; it's live only while a
  // browser-driven batch runs. Anchored to the "printer"-icon control (auto-print).
  const printProgress = usePrintProgress();
  const toast = useToast();
  // The local bridge, polled only while the panel is OPEN. Its state is worth
  // knowing while someone is looking at it; a closed box has no reason to be
  // asking anything, and this is the surface that follows you across every page.
  const bridge = useBridgeLive(open ? 15_000 : 0);
  // Which Cobblr printer row each bridge instance belongs to, so the card can
  // show the roll/battery this workspace has already read from it.
  const printersQ = useQuery({
    queryKey: ["live-printers", slug],
    queryFn: () => api.listPrinters(slug!),
    enabled: !!slug && open,
    staleTime: 60_000,
  });
  const rowForInstance = (instance: string) =>
    (printersQ.data?.items ?? []).find(
      (p) => (p.settings as { bridge?: { instance?: string } } | undefined)?.bridge?.instance === instance,
    );
  const printing = printProgress ? Math.max(0, printProgress.total - printProgress.done) : 0;
  // The batch count belongs to the control the batch runs through — auto-print,
  // which is browser-driven. The bridge row shares the printer icon but not the
  // job, and showing the same badge twice reads as two runs.
  const badgeFor = (c: LiveControlPublic) => (c.icon === "printer" && c.id !== BRIDGE_ID ? printing : 0);

  // Fold the drive indicator in as a DATA control (green ring while this tab is
  // driven, grey while another window is); an offer is a prompt, handled below.
  const dc = driveControl(drive.state, drive.byScans);
  const bc = bridgeControl(bridge);
  const controls = [dc, bc, ...serverControls].filter((c): c is LiveControlPublic => !!c);
  // Tab-scoped controls carry their on/off from a client adapter, not the server:
  // scan.drive from localStorage, drive from the SSE state.
  const states: Record<string, ControlState> = {
    ...serverStates,
    [SCAN_DRIVE_ID]: { enabled: scanDrive.on },
    ...(dc ? { [DRIVE_ID]: { enabled: drive.state === "active" } } : {}),
    // ON = the bridge is holding a link, so a print fires immediately.
    ...(bc ? { [BRIDGE_ID]: { enabled: bridge.instances.some((i) => i.link === "connected" || i.link === "printing") } } : {}),
  };

  const fire = (c: LiveControlPublic) => {
    if (c.id === DRIVE_ID) {
      if (drive.state === "active") drive.release(); // disconnect this window
      return;
    }
    if (c.id === SCAN_DRIVE_ID) {
      scanDrive.toggle();
      return;
    }
    if (c.id === BRIDGE_ID) {
      // Not a toggle. One ring cannot mean "connect" across several printers,
      // and guessing which one would be worse than asking — the card below
      // carries a button per printer. Clicking the ring opens the panel.
      setOpen(true);
      return;
    }
    toggle.mutate({ control: c, state: states[c.id] ?? null });
  };

  /** Ask a printer what it has loaded, and put the answer where every surface
   *  reads it — the same store the Labels chip and the settings row use. */
  const checkPrinter = async (inst: BridgeInstanceLive) => {
    const row = rowForInstance(inst.instance);
    if (!row || !isLocalBridgePrinter(row.settings)) return;
    const r = await readLocalBridgeStatus((row.settings as { bridge: Parameters<typeof readLocalBridgeStatus>[0] }).bridge);
    if (r.responded) setPrinterStatus(row.id, r);
    else toast.info(`${inst.name} did not report what it has loaded.`);
  };

  const detailFor = (c: LiveControlPublic) =>
    c.id !== BRIDGE_ID ? undefined : (
      <>
        {bridge.instances.map((inst) => (
          <BridgePrinterCard
            key={inst.instance}
            printer={inst}
            printerId={rowForInstance(inst.instance)?.id}
            onChanged={bridge.refresh}
            onCheck={() => void checkPrinter(inst)}
          />
        ))}
      </>
    );

  const segmentState = (c: LiveControlPublic) =>
    c.id === SCAN_DRIVE_ID
      ? { value: scanDrive.mode, onChange: (v: string) => scanDrive.setMode(v as ScanDispo) }
      : undefined;

  if (!slug) return null;
  // An offer is a question the box asks — it surfaces even with no other controls.
  if (drive.state === "offer") {
    return <OfferPrompt mode={mode} byScans={drive.byScans} onAccept={drive.accept} onDecline={drive.release} />;
  }
  if (controls.length === 0) return null; // self-hiding

  const onIcons = controls.filter((c) => isOn(states[c.id] ?? null));
  // The collapsed pill normally shows the ON controls. While a batch prints, add
  // the printer icon even if auto-print is off (a manual queue print) — a taskbar
  // surfaces an active job whether or not you armed anything.
  const printerControl = printing > 0 ? controls.find((c) => c.icon === "printer") : undefined;
  const pillIcons =
    printerControl && !onIcons.some((c) => c.id === printerControl.id) ? [printerControl, ...onIcons] : onIcons;

  if (mode === "sidebar") {
    // Nothing is actually LIVE — no armed control, no batch printing — so this is
    // just a dormant toggle, not an "ongoing session mode". Don't spend a whole
    // sidebar row on a single idle status icon (the author, 2026-07-26); it reappears the
    // moment auto-print is armed or a job runs. The controls stay armable from
    // their own surfaces (e.g. the Labels page's Auto-print button). An OFFER has
    // already returned above and is unaffected.
    if (onIcons.length === 0 && printing === 0) return null;
    // Bare ring row in the sidebar foot; expands into a right-flyout panel that
    // is PORTALED to <body> so the sidebar's overflow-hidden can't clip it.
    return (
      <div className="relative" ref={rowRef}>
        <div className="flex items-center gap-2.5 overflow-hidden px-0.5 py-1">
          {controls.map((c) => (
            <Ring key={c.id} control={c} on={isOn(states[c.id] ?? null)} size={28} onClick={() => fire(c)} badge={badgeFor(c)} />
          ))}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            title={open ? "Collapse" : "Expand"}
            className="ml-auto shrink-0 text-content dark:text-mortar-100 hover:text-accent p-1"
          >
            {/* Same chevron affordance as the account menu (UserMenu): points up
                to open, flips down to collapse — not the confusing expand-arrows. */}
            <ChevronDown size={16} className={"transition " + (open ? "" : "rotate-180")} />
          </button>
        </div>
        {open && flyoutPos &&
          createPortal(
            <div className="fixed z-[900]" style={{ left: flyoutPos.left, bottom: flyoutPos.bottom }}>
              <Panel controls={controls} states={states} onToggle={fire} segmentState={segmentState} badgeFor={badgeFor} detailFor={detailFor} onClose={() => setOpen(false)} />
            </div>,
            document.body,
          )}
      </div>
    );
  }

  // floating (mobile + top-bar mode): a single outlined pill that morphs to a panel
  // whose collapse strip is at the bottom (same corner).
  return (
    <div className="fixed bottom-4 right-4 z-[900] flex flex-col items-end">
      {open ? (
        <Panel controls={controls} states={states} onToggle={fire} segmentState={segmentState} badgeFor={badgeFor} detailFor={detailFor} footerAtBottom onClose={() => setOpen(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={printing > 0 ? `${printing} to print` : "Live controls"}
          className="inline-flex items-center gap-2.5 rounded-full border-[1.5px] border-cobble-300 dark:border-cobble-600 bg-surface dark:bg-slate-900 px-4 py-2 shadow-lg hover:brightness-105"
        >
          {pillIcons.length > 0 ? (
            pillIcons.map((c) => {
              const Icon = iconForName(c.icon);
              const n = badgeFor(c);
              return (
                <span key={c.id} className="relative inline-flex">
                  <Icon size={17} className="text-content dark:text-mortar-100" />
                  {n > 0 && <CountBadge n={n} />}
                </span>
              );
            })
          ) : (
            <span className="text-[12px] font-semibold text-muted dark:text-slate-400">Live</span>
          )}
        </button>
      )}
    </div>
  );
}
