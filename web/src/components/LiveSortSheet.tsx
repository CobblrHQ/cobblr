// Live Sort — the bench-station rig (docs/product/put-away.md §3.2, §4).
//
// A full-screen put-away session: scan a thing (hardware wedge, or type a
// code), the session answers with a DIRECTIVE ("→ Bin 1 · Fasteners", with
// its sibling evidence), you put it there and confirm with SPACEBAR (or the
// big button). Override = pick a different bin. Undo chip after every
// confirm. The intake rides the normal /scan pipeline with a short
// enrichment budget — routing needs a coarse name, not a finished record;
// full enrichment keeps running detached and unrouteable items degrade to
// the catch-all bin ("Unsorted"), never a guess.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Check,
  Loader2,
  MapPin,
  PartyPopper,
  RotateCcw,
  SkipForward,
  X,
} from "lucide-react";
import { useToast, OverlayFlag } from "@cobblr/platform-web";
import { api, ApiError, type LiveSortEntry } from "../lib/api";
import { qrTokenFromUrl } from "@cobblr/platform-contract/qr-token";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";
import { isLocationQrTarget } from "../lib/scanFiling";
import { LocationTreePicker } from "./LocationTreePicker";

type Phase = "starting" | "ready" | "routing" | "directive" | "ended";

interface Summary {
  sorted: number;
  stragglers: number;
  by_bin: Array<{ location_id: string; location_name: string; count: number }>;
}

/** How long to give the inline enrichment race per scan. Routing needs a
 *  coarse name; anything slower degrades to catch-all and enrichment keeps
 *  running detached (the item re-routes if scanned again). */
const ENRICH_BUDGET_MS = 3_000;
/** One extra beat for a bare item — enrichment often lands just after the
 *  race; a single re-route turns "Unsorted" into a real bin. */
const REROUTE_AFTER_MS = 2_500;

export function LiveSortSheet({ slug, onClose }: { slug: string; onClose: () => void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("starting");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [current, setCurrent] = useState<LiveSortEntry | null>(null);
  const [tape, setTape] = useState<LiveSortEntry[]>([]);
  const [lastConfirmed, setLastConfirmed] = useState<LiveSortEntry | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manual, setManual] = useState("");
  const [binsOpen, setBinsOpen] = useState(false);
  const [binCount, setBinCount] = useState(5);
  const [withCatchAll, setWithCatchAll] = useState(true);
  const [binsBusy, setBinsBusy] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const sessionRef = useRef<string | null>(null);
  const rerouteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start (or resume) the live session + a scan batch for this sitting.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await api.startPutaway(slug, {});
        if (cancelled) return;
        sessionRef.current = s.session_id;
        const confirmed = (s.entries ?? []).filter((e) => e.status === "confirmed");
        setTape(confirmed.slice(-30).reverse());
        if (s.resumed && confirmed.length > 0) {
          toast.info(`Resumed your sort session — ${confirmed.length} already sorted.`);
        }
        const b = await api.createScanBatch(slug).catch(() => null);
        if (!cancelled && b) setBatchId(b.id);
        if (!cancelled) setPhase("ready");
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Couldn't start the sort session.");
        onClose();
      }
    })();
    return () => {
      cancelled = true;
      if (rerouteTimer.current) clearTimeout(rerouteTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const routeIntaken = useCallback(
    async (inboxItemId: string) => {
      const sid = sessionRef.current;
      if (!sid) return;
      const r = await api.putawayScan(slug, sid, { inbox_item_id: inboxItemId });
      if (r.already_placed) {
        toast.info(
          `Already lives in ${r.already_placed.location_name ?? "a bin"}${
            r.already_placed.name ? ` — ${r.already_placed.name}` : ""
          }. Re-find, not a re-sort.`,
        );
        setPhase("ready");
        return;
      }
      if (!r.entry) {
        setPhase("ready");
        return;
      }
      setCurrent(r.entry);
      setPhase("directive");
      // A bare item that fell to catch-all often gets its name a beat later —
      // one silent re-route upgrades the directive in place.
      if (!r.entry.name && r.entry.status === "proposed") {
        if (rerouteTimer.current) clearTimeout(rerouteTimer.current);
        const entryItem = r.entry.inbox_item_id;
        rerouteTimer.current = setTimeout(() => {
          void api
            .putawayScan(slug, sid, { inbox_item_id: entryItem })
            .then((again) => {
              if (
                again.entry &&
                phaseRef.current === "directive" &&
                sessionRef.current === sid
              ) {
                setCurrent((cur) =>
                  cur && cur.inbox_item_id === entryItem ? again.entry! : cur,
                );
              }
            })
            .catch(() => {});
        }, REROUTE_AFTER_MS);
      }
    },
    [slug, toast],
  );

  const handleCode = useCallback(
    (code: string) => {
      if (!sessionRef.current) return;
      if (phaseRef.current === "routing" || phaseRef.current === "ended") return;
      // A directive is pending: a scanned LOCATION label means "this bin
      // instead" — confirm the current item into it (retarget, one gesture).
      const qrToken = qrTokenFromUrl(code);
      if (qrToken) {
        void (async () => {
          const resolved = await api.resolveQrToken(qrToken).catch(() => null);
          if (isLocationQrTarget(resolved)) {
            if (phaseRef.current === "directive") confirmCurrent(resolved.entity_id);
            else toast.info("Scan an item first - a bin label confirms the current item into it.");
          } else {
            toast.error("That QR isn't a bin label.");
          }
        })();
        return;
      }
      setPhase("routing");
      void (async () => {
        try {
          const item = await api.scanBarcode(slug, {
            barcode: code,
            source_kind: "barcode",
            enrich_ms: ENRICH_BUDGET_MS,
            scan_batch_id: batchId ?? undefined,
          });
          await routeIntaken(item.id);
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : "Scan failed — try again.");
          setPhase(phaseRef.current === "ended" ? "ended" : "ready");
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, batchId, routeIntaken],
  );

  useBarcodeWedge({ enabled: phase !== "ended", onScan: handleCode });

  const confirmCurrent = useCallback(
    (overrideLocationId?: string) => {
      const sid = sessionRef.current;
      const entry = current;
      if (!sid || !entry || entry.status !== "proposed") return;
      const dest = overrideLocationId ?? entry.directive.location_id;
      if (!dest) {
        setPickerOpen(true);
        return;
      }
      void api
        .putawayConfirm(slug, sid, {
          entry_id: entry.id,
          ...(overrideLocationId ? { location_id: overrideLocationId } : {}),
        })
        .then((r) => {
          setTape((t) => [r.entry, ...t].slice(0, 30));
          setLastConfirmed(r.entry);
          setCurrent(null);
          setPickerOpen(false);
          setPhase("ready");
        })
        .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't confirm."));
    },
    [slug, current, toast],
  );
  const confirmRef = useRef(confirmCurrent);
  confirmRef.current = confirmCurrent;

  const skipCurrent = () => {
    if (current) skippedRef.current.add(current.id);
    setCurrent(null);
    setPickerOpen(false);
    setPhase("ready");
  };

  const undoLast = () => {
    const sid = sessionRef.current;
    if (!sid || !lastConfirmed) return;
    void api
      .putawayUndo(slug, sid, { entry_id: lastConfirmed.id })
      .then((r) => {
        setTape((t) => t.filter((e) => e.id !== r.entry.id));
        setLastConfirmed(null);
        toast.success("Undone - it's back to unsorted.");
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't undo."));
  };

  const setupBins = () => {
    const sid = sessionRef.current;
    if (!sid || binsBusy) return;
    setBinsBusy(true);
    void api
      .setupPutawayBins(slug, sid, { count: binCount, include_catch_all: withCatchAll })
      .then((r) => {
        const names = r.created.map((c) => c.name);
        const range =
          names.length > 1 ? `${names[0]}–${names[names.length - 1]}` : (names[0] ?? "no new bins");
        toast.success(
          `Created ${range}${r.catch_all_location_id && withCatchAll ? " + an Unsorted catch-all" : ""}. Number your containers with a marker to match — QR labels can come later.`,
        );
        setBinsOpen(false);
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Couldn't create bins."))
      .finally(() => setBinsBusy(false));
  };

  // PAIRED DISPLAY (Phase 3): the session is per-user server state, so a
  // phone scanning in Sort mode and this sheet are the SAME session. Poll it
  // while idle or showing a directive: a directive minted elsewhere shows up
  // here in wall type, and a confirm from either device reconciles both.
  const currentRef = useRef<LiveSortEntry | null>(null);
  currentRef.current = current;
  // Entries skipped on THIS device — the poll must not re-adopt them.
  const skippedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (phase !== "ready" && phase !== "directive") return;
    const t = setInterval(() => {
      const sid = sessionRef.current;
      if (!sid) return;
      void api
        .getPutawayCurrent(slug)
        .then(({ session }) => {
          if (!session || session.session_id !== sid) return;
          if (phaseRef.current !== "ready" && phaseRef.current !== "directive") return;
          const entries = session.entries ?? [];
          const confirmed = entries.filter((e) => e.status === "confirmed");
          setTape([...confirmed].reverse().slice(0, 30));
          const cur = currentRef.current;
          if (cur) {
            const server = entries.find((e) => e.id === cur.id);
            if (server?.status === "confirmed") {
              // Confirmed from the other device — advance here too.
              setLastConfirmed(server);
              setCurrent(null);
              setPickerOpen(false);
              setPhase("ready");
              return;
            }
            if (server && server.directive.kind !== cur.directive.kind) {
              setCurrent(server); // a re-route (enrichment landed) upgraded it
            }
            return;
          }
          // Idle here + a directive pending anywhere → display it.
          const proposed = [...entries]
            .reverse()
            .find((e) => e.status === "proposed" && !skippedRef.current.has(e.id));
          if (proposed) {
            setCurrent(proposed);
            setPhase("directive");
          }
        })
        .catch(() => {});
    }, 2_500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, slug]);

  // SPACEBAR = confirm (the Cataloging Bench binding). Never steals from an
  // input; Escape closes the picker or skips.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target;
      if (
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      )
        return;
      if (ev.code === "Space" && phaseRef.current === "directive") {
        ev.preventDefault();
        confirmRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const endSession = () => {
    const sid = sessionRef.current;
    if (!sid) {
      onClose();
      return;
    }
    void api
      .endPutaway(slug, sid)
      .then((r) => {
        setSummary({
          sorted: r.sorted ?? 0,
          stragglers: r.stragglers ?? 0,
          by_bin: r.by_bin ?? [],
        });
        setPhase("ended");
      })
      .catch(() => onClose());
  };

  const sortedCount = tape.length;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] bg-surface dark:bg-slate-950 flex flex-col"
      data-testid="live-sort-sheet"
    >
      <OverlayFlag />
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-line dark:border-slate-800 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-muted">Live Sort · {sortedCount} sorted this session</div>
          <div className="text-lg font-semibold text-content">
            Scan a thing - we'll tell you where it goes.
          </div>
        </div>
        {lastConfirmed && (
          <button
            type="button"
            onClick={undoLast}
            className="inline-flex items-center gap-1.5 rounded-full border border-line dark:border-slate-700 px-3 py-1.5 text-xs text-muted hover:text-content transition"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Undo {lastConfirmed.name ?? "last"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setBinsOpen((v) => !v)}
          title="No bins yet? Create numbered bins - mark your containers 1, 2, 3… with a marker; QR labels can come later"
          className="rounded border border-line dark:border-slate-700 px-3 py-1.5 text-sm text-muted hover:text-content transition"
        >
          Set up bins
        </button>
        <button
          type="button"
          onClick={endSession}
          className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition"
        >
          End session
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close (session stays resumable)"
          className="rounded p-2 text-muted hover:bg-subtle dark:hover:bg-slate-800 transition"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Bins setup — the zero-hardware on-ramp: numbered bins now, QR later. */}
      {binsOpen && (
        <div className="border-b border-line dark:border-slate-800 px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted">
            Grab a marker and number your containers. Cobblr creates matching{" "}
            <span className="text-content font-medium">Bin N</span> locations; the first item of a
            new family <span className="text-content font-medium">names its bin</span> as you sort.
          </span>
          <label className="inline-flex items-center gap-2 text-muted">
            bins:
            <input
              type="number"
              min={1}
              max={20}
              value={binCount}
              onChange={(e) => setBinCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
              className="w-16 rounded border border-line dark:border-slate-700 bg-transparent px-2 py-1 text-content"
            />
          </label>
          <label className="inline-flex items-center gap-1.5 text-muted">
            <input
              type="checkbox"
              checked={withCatchAll}
              onChange={(e) => setWithCatchAll(e.target.checked)}
            />
            add an "Unsorted" catch-all
          </label>
          <button
            type="button"
            onClick={setupBins}
            disabled={binsBusy}
            className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
            data-testid="live-sort-create-bins"
          >
            {binsBusy ? "Creating…" : "Create bins"}
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {phase === "starting" && (
          <div className="flex items-center justify-center gap-2 py-24 text-muted">
            <Loader2 className="h-5 w-5 animate-spin" /> Starting your sort session…
          </div>
        )}

        {phase === "ended" && summary && (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <PartyPopper className="h-10 w-10 text-accent" />
            <div className="text-2xl font-semibold text-content">
              {summary.sorted} item{summary.sorted === 1 ? "" : "s"} sorted into{" "}
              {summary.by_bin.length} bin{summary.by_bin.length === 1 ? "" : "s"}.
            </div>
            {summary.by_bin.length > 0 && (
              <ul className="text-sm text-muted space-y-1">
                {summary.by_bin.map((b) => (
                  <li key={b.location_id}>
                    <span className="text-content font-medium">{b.location_name}</span> · {b.count}
                  </li>
                ))}
              </ul>
            )}
            {summary.stragglers > 0 && (
              <p className="text-sm text-muted">
                {summary.stragglers} item{summary.stragglers === 1 ? "" : "s"} for review - they're
                waiting in the scan inbox.
              </p>
            )}
            <button
              type="button"
              onClick={onClose}
              className="mt-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2 transition"
            >
              Done
            </button>
          </div>
        )}

        {(phase === "ready" || phase === "routing") && (
          <div className="flex flex-col items-center gap-4 py-16 text-center">
            {phase === "routing" ? (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-accent" />
                <div className="text-xl text-muted">Finding it a home…</div>
              </>
            ) : (
              <>
                <div className="text-5xl">📦</div>
                <div className="text-2xl font-semibold text-content">Ready - scan the next item.</div>
                <p className="text-sm text-muted max-w-md">
                  Hardware scanner, or type a code below. When the directive shows, put the item
                  there and hit <kbd className="rounded border border-line dark:border-slate-700 px-1.5 py-0.5 text-xs">space</kbd> (or the button) to confirm.
                  Already-scanned things work too: re-scan one and it gets routed, not duplicated.
                </p>
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (manual.trim().length >= 4) {
                      handleCode(manual.trim());
                      setManual("");
                    }
                  }}
                >
                  <input
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    placeholder="…or type a UPC"
                    className="rounded border border-line dark:border-slate-700 bg-transparent px-3 py-2 text-sm text-content w-56"
                  />
                  <button
                    type="submit"
                    className="rounded border border-line dark:border-slate-700 px-3 py-2 text-sm text-muted hover:text-content transition"
                  >
                    Route it
                  </button>
                </form>
              </>
            )}
          </div>
        )}

        {phase === "directive" && current && (
          <div className="flex flex-col items-center gap-5 py-10 text-center">
            <div className="text-lg text-muted">
              {current.name ?? "Unidentified item"}
              {current.quantity > 1 && <span className="text-faint"> ×{current.quantity}</span>}
            </div>
            {current.directive.kind === "bin" ? (
              <>
                <div className="flex items-center justify-center gap-3 text-4xl md:text-6xl font-bold text-content">
                  <ArrowRight className="h-10 w-10 md:h-14 md:w-14 text-accent shrink-0" />
                  <span className="inline-flex items-center gap-2 text-accent">
                    <MapPin className="h-8 w-8 md:h-12 md:w-12 shrink-0" />
                    {current.directive.location_name}
                  </span>
                </div>
                {current.directive.location_path &&
                  current.directive.location_path !== current.directive.location_name && (
                    <div className="text-sm text-faint">{current.directive.location_path}</div>
                  )}
                <div className="text-sm text-muted">
                  {current.directive.via === "sticky"
                    ? "Same as the last one."
                    : `${current.directive.sibling_count} similar item${
                        current.directive.sibling_count === 1 ? "" : "s"
                      } already live here${
                        current.directive.sample_names.length
                          ? ` — ${current.directive.sample_names.slice(0, 3).join(", ")}`
                          : ""
                      }.`}
                </div>
              </>
            ) : current.directive.kind === "bind-offer" ? (
              <>
                <div className="flex items-center justify-center gap-3 text-4xl md:text-6xl font-bold text-content">
                  <ArrowRight className="h-10 w-10 md:h-14 md:w-14 text-accent shrink-0" />
                  <span className="inline-flex items-center gap-2 text-accent">
                    <MapPin className="h-8 w-8 md:h-12 md:w-12 shrink-0" />
                    {current.directive.location_name}
                  </span>
                </div>
                <div className="text-base text-content">
                  This starts your{" "}
                  <span className="font-semibold text-accent">{current.directive.proposed_name}</span>{" "}
                  bin - confirming names it{" "}
                  <span className="font-medium">
                    "{current.directive.location_name} · {current.directive.proposed_name}"
                  </span>
                  . The number on the container stays right.
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-center gap-3 text-4xl md:text-5xl font-bold text-content">
                  <ArrowRight className="h-10 w-10 text-amber-500 shrink-0" />
                  <span className="text-amber-600 dark:text-amber-400">
                    {current.directive.location_name ?? "Unsorted bin"}
                  </span>
                </div>
                <div className="text-sm text-muted max-w-md">
                  No confident match yet - park it in the catch-all and it stays findable; it'll be
                  in the inbox for review.
                </div>
              </>
            )}

            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => confirmCurrent()}
                className="inline-flex items-center gap-2 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-lg font-semibold px-6 py-3 transition"
                data-testid="live-sort-confirm"
              >
                <Check className="h-5 w-5" />
                Done, next
                <span className="text-white/60 text-xs font-normal">(space)</span>
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                className="rounded-lg border border-line dark:border-slate-700 px-4 py-3 text-sm text-muted hover:text-content transition"
              >
                Different bin…
              </button>
              <button
                type="button"
                onClick={skipCurrent}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line dark:border-slate-700 px-4 py-3 text-sm text-muted hover:text-content transition"
              >
                <SkipForward className="h-4 w-4" /> Skip
              </button>
            </div>
            {pickerOpen && (
              <div className="w-72">
                <LocationTreePicker
                  value={null}
                  onChange={(v) => {
                    if (v) confirmCurrent(v);
                  }}
                  placeholder="pick the bin it went into"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* The tape — what this session already sorted. */}
      {tape.length > 0 && phase !== "ended" && (
        <div className="border-t border-line dark:border-slate-800 px-4 py-2 text-xs text-faint overflow-x-auto whitespace-nowrap">
          {tape
            .slice(0, 12)
            .map((e) => `${e.name ?? "item"} → ${e.confirmed_location_name ?? "?"}`)
            .join(" · ")}
        </div>
      )}
    </div>,
    document.body,
  );
}
