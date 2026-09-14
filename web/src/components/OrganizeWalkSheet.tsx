// Guided Organize Phase 2 — the put-away walk (docs/product/guided-organize.md).
//
// Turns what was accepted into the hands-busy loop the active bin already
// supports, one bin at a time: the destination auto-becomes the active
// filing bin, each member is a checklist row, and scanning an item's barcode
// (hardware wedge — no input focus needed) checks it off; a tap does the same
// for unscannables.
//
// The queue is the api's (POST /putaway/start): every accepted group still to
// place, from EVERY plan in play, with anything accepted that cannot be
// walked named and its reason shown. This sheet used to read one plan's
// groups; a person accepted towels, the page re-planned around the bin that
// accept had made, they accepted scissors on the new plan, and the walk
// listed scissors alone and said "All put away" with the towels still on the
// counter (#2897). Placement is a fact about the item (placed_at), so a
// reload, another plan and the resume chip all read the same ticks.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, ChevronRight, Circle, MapPin, PartyPopper, X } from "lucide-react";
import { useToast, OverlayLayer } from "@cobblr/platform-web";
import { api, type PutawayLeftOut, type PutawayWalkGroup, type ScanInboxItem } from "../lib/api";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";

interface Walk {
  session_id: string;
  groups: PutawayWalkGroup[];
  left_out: PutawayLeftOut[];
  item_names: Record<string, string>;
  item_quantities: Record<string, number>;
  item_barcodes: Record<string, string>;
}

export function OrganizeWalkSheet({
  slug,
  planId,
  itemsById,
  onClose,
  setFileBin,
}: {
  slug: string;
  /** The plan just applied (or the one the resume chip named). The queue the
   *  api returns spans every plan in play; this one comes first. */
  planId: string;
  itemsById: Map<string, ScanInboxItem>;
  onClose: () => void;
  /** The scan page's active-bin setter — each group's destination becomes the
   *  active filing bin while you're standing at it. */
  setFileBin: (locationId: string) => void;
}) {
  const toast = useToast();
  const [walk, setWalk] = useState<Walk | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Set<string>>(() => new Set());

  // Start/resume the session on mount; idempotent per plan. The response is
  // the authoritative queue and placed list.
  useEffect(() => {
    let cancelled = false;
    void api
      .startPutaway(slug, { plan_id: planId })
      .then((r) => {
        if (cancelled) return;
        setWalk({
          session_id: r.session_id,
          groups: r.groups ?? [],
          left_out: r.left_out ?? [],
          item_names: r.item_names ?? {},
          item_quantities: r.item_quantities ?? {},
          item_barcodes: r.item_barcodes ?? {},
        });
        // UNION server progress with any ticks made while starting — neither
        // a resume nor a fast first tap may lose a checkmark.
        setPlaced((prev) => {
          const server = r.placed_item_ids ?? [];
          const merged = new Set([...prev, ...server]);
          if (merged.size > server.length) {
            void api.setPutawayState(slug, r.session_id, { placed_item_ids: [...merged] }).catch(() => {});
          }
          return merged;
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFailed(e instanceof Error ? e.message : "Couldn't start the walk.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  const groups = useMemo(() => walk?.groups ?? [], [walk]);

  // The current group = the first with anything left to place.
  const currentIdx = groups.findIndex((g) => g.item_ids.some((id) => !placed.has(id)));
  const done = walk !== null && currentIdx === -1;
  const current = currentIdx === -1 ? null : groups[currentIdx]!;

  // Standing at a new group → its bin becomes the active filing bin.
  const lastBinRef = useRef<string | null>(null);
  useEffect(() => {
    if (current && lastBinRef.current !== current.location_id) {
      lastBinRef.current = current.location_id;
      setFileBin(current.location_id);
    }
    // setFileBin is a stable page-level setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.location_id]);

  // Persist progress on every change (small payload, no debounce needed).
  const save = (next: Set<string>) => {
    const sid = walk?.session_id;
    if (!sid) return; // session still starting — the next toggle catches up
    void api.setPutawayState(slug, sid, { placed_item_ids: [...next] }).catch(() => {
      /* best-effort — the walk keeps working; a reload just loses ticks */
    });
  };
  const toggle = (id: string) => {
    setPlaced((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      save(next);
      return next;
    });
  };

  // Hardware wedge: a scanned barcode checks its item off in the CURRENT group.
  // Names and barcodes come with the queue: a filed item has left the inbox
  // list the page holds, and the walk is read by name.
  const nameOf = (id: string) => itemsById.get(id)?.suggested_name ?? walk?.item_names[id] ?? "(item)";
  const qtyOf = (id: string) => itemsById.get(id)?.quantity ?? walk?.item_quantities[id] ?? 1;
  const barcodeOf = (id: string) => itemsById.get(id)?.barcode_text ?? walk?.item_barcodes[id] ?? null;
  useBarcodeWedge({
    enabled: !done && !!current,
    onScan: (code) => {
      if (!current) return;
      const hit = current.item_ids.find((id) => !placed.has(id) && barcodeOf(id) === code);
      if (hit) {
        toggle(hit);
        toast.success(`✓ ${nameOf(hit)} placed`);
      } else {
        toast.error("That scan isn't in this group - check the list.");
      }
    },
  });

  const totalItems = groups.reduce((n, g) => n + g.item_ids.length, 0);
  const placedCount = groups.reduce((n, g) => n + g.item_ids.filter((id) => placed.has(id)).length, 0);
  const leftOut = walk?.left_out ?? [];
  const nothingToWalk = totalItems === 0 && leftOut.length > 0;

  return createPortal(
    <OverlayLayer
      className="z-[70] bg-surface dark:bg-slate-950 flex flex-col"
      data-testid="organize-walk-sheet"
    >
      <div className="flex items-center gap-3 border-b border-line dark:border-slate-800 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-muted">
            Put-away walk · {placedCount}/{totalItems} placed
          </div>
          {!walk ? (
            <div className="text-lg font-semibold text-content">{failed ?? "Loading the walk…"}</div>
          ) : current ? (
            <div className="flex items-center gap-2 text-lg font-semibold text-content truncate">
              <span className="text-muted font-normal text-sm shrink-0">
                Group {currentIdx + 1} of {groups.length}:
              </span>
              {current.label}
              <ChevronRight className="h-4 w-4 text-faint shrink-0" />
              <span className="inline-flex items-center gap-1 text-accent truncate">
                <MapPin className="h-4 w-4 shrink-0" />
                {current.location_path || current.location_name}
              </span>
            </div>
          ) : (
            <div className="text-lg font-semibold text-content">{nothingToWalk ? "Nothing to walk yet" : "All put away"}</div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the walk"
          className="rounded p-2 text-muted hover:bg-subtle dark:hover:bg-slate-800 transition"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {done ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <PartyPopper className="h-10 w-10 text-accent" />
            <div className="text-xl font-semibold text-content">
              {nothingToWalk ? "Nothing is ready to put away." : "Everything's in its place."}
            </div>
            <p className="text-sm text-muted">
              {totalItems} item{totalItems === 1 ? "" : "s"} across {groups.length} bin
              {groups.length === 1 ? "" : "s"}.
            </p>
            {leftOut.length > 0 && <LeftOutList leftOut={leftOut} />}
            <button
              type="button"
              onClick={() => {
                const sid = walk?.session_id;
                if (sid) void api.endPutaway(slug, sid).catch(() => {});
                onClose();
              }}
              className="mt-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2 transition"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {current && (
              <>
                <p className="text-sm text-muted">
                  This bin is now your <span className="font-medium text-content">active filing bin</span>.
                  Scan each item as you drop it in - or tap it off the list.
                </p>
                <ul className="space-y-2">
                  {current.item_ids.map((id) => {
                    const isPlaced = placed.has(id);
                    const qty = qtyOf(id);
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => toggle(id)}
                          className={`w-full flex items-center gap-3 rounded-lg border px-3 py-3 text-left transition ${
                            isPlaced
                              ? "border-emerald-500/40 bg-emerald-50/50 dark:bg-emerald-900/10"
                              : "border-line dark:border-slate-700 hover:border-accent/60"
                          }`}
                        >
                          {isPlaced ? (
                            <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <Circle className="h-6 w-6 shrink-0 text-faint" />
                          )}
                          <span
                            className={`flex-1 truncate text-base ${isPlaced ? "text-muted line-through" : "text-content"}`}
                          >
                            {nameOf(id)}
                          </span>
                          {qty > 1 && <span className="text-sm text-faint shrink-0">×{qty}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {/* The groups still ahead — a glanceable route. */}
            {currentIdx >= 0 && groups.length > currentIdx + 1 && (
              <div className="pt-2 text-xs text-faint">
                Up next:{" "}
                {groups
                  .slice(currentIdx + 1)
                  .map((g) => `${g.label} → ${g.location_name}`)
                  .join(" · ")}
              </div>
            )}
            {leftOut.length > 0 && <LeftOutList leftOut={leftOut} />}
          </div>
        )}
      </div>
    </OverlayLayer>,
    document.body,
  );
}

/** What was accepted and is NOT in this walk, each with its reason: the walk
 *  says what it left out rather than reporting a narrower job as the whole. */
function LeftOutList({ leftOut }: { leftOut: PutawayLeftOut[] }) {
  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-50/50 dark:bg-amber-900/10 px-3 py-2 text-left text-xs text-amber-800 dark:text-amber-300"
      data-testid="walk-left-out"
    >
      <div className="font-medium">Not in this walk</div>
      <ul className="mt-1 space-y-0.5">
        {leftOut.map((l) => (
          <li key={`${l.plan_id}:${l.group_id}`}>
            {l.label}: {l.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
