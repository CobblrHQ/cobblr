// Guided Organize Phase 2 — the put-away walk (docs/product/guided-organize.md).
//
// Turns an applied plan into the hands-busy loop the active bin already
// supports, one group at a time: the destination auto-becomes the active
// filing bin, each member is a checklist row, and scanning an item's barcode
// (hardware wedge — no input focus needed) checks it off; a tap does the same
// for unscannables. Progress persists on the plan row (walk-state), so a
// reload resumes mid-walk. Bookkeeping only: the filing itself happened at
// apply time.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, ChevronRight, Circle, MapPin, PartyPopper, X } from "lucide-react";
import { useToast, OverlayFlag } from "@cobblr/platform-web";
import { api, type OrganizeStoredPlan, type ScanInboxItem } from "../lib/api";
import { useBarcodeWedge } from "../lib/useBarcodeWedge";

interface WalkGroup {
  id: string;
  label: string;
  item_ids: string[];
  location_id: string;
  location_name: string;
  location_path: string;
}

export function OrganizeWalkSheet({
  slug,
  plan,
  itemsById,
  onClose,
  setFileBin,
}: {
  slug: string;
  plan: OrganizeStoredPlan;
  itemsById: Map<string, ScanInboxItem>;
  onClose: () => void;
  /** The scan page's active-bin setter — each group's destination becomes the
   *  active filing bin while you're standing at it. */
  setFileBin: (locationId: string) => void;
}) {
  const toast = useToast();

  // Only applied groups with a real (resolved) destination are walkable.
  const groups = useMemo<WalkGroup[]>(() => {
    const applied = new Set(plan.applied_group_ids);
    return plan.groups
      .filter((g) => applied.has(g.id) && g.destination.kind === "existing")
      .map((g) => {
        const d = g.destination as { location_id: string; location_name: string; location_path: string };
        return {
          id: g.id,
          label: g.label,
          item_ids: g.item_ids,
          location_id: d.location_id,
          location_name: d.location_name,
          location_path: d.location_path,
        };
      });
  }, [plan]);

  const [placed, setPlaced] = useState<Set<string>>(
    () => new Set(plan.walk_state.placed_item_ids ?? []),
  );

  // Progress lives on a put-away SESSION (the shared execution engine —
  // docs/product/put-away.md §2.2). Start/resume it on mount; idempotent per
  // plan, and the response carries the authoritative placed list (a walk that
  // predates sessions gets its legacy walk_state imported server-side).
  const sessionIdRef = useRef<string | null>(plan.putaway_session_id ?? null);
  useEffect(() => {
    let cancelled = false;
    void api
      .startPutaway(slug, { plan_id: plan.plan_id })
      .then((r) => {
        if (cancelled) return;
        sessionIdRef.current = r.session_id;
        // UNION server progress with any ticks made while starting — neither
        // a resume nor a fast first tap may lose a checkmark.
        setPlaced((prev) => {
          const server = r.placed_item_ids ?? [];
          const merged = new Set([...prev, ...server]);
          if (merged.size > server.length) {
            void api
              .setPutawayState(slug, r.session_id, { placed_item_ids: [...merged] })
              .catch(() => {});
          }
          return merged;
        });
      })
      .catch(() => {
        /* best-effort — the walk keeps working; saves no-op until a session exists */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.plan_id]);

  // The current group = the first with anything left to place.
  const currentIdx = groups.findIndex((g) => g.item_ids.some((id) => !placed.has(id)));
  const done = currentIdx === -1;
  const current = done ? null : groups[currentIdx]!;

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
    const sid = sessionIdRef.current;
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
  // Inbox items match on their row's barcode; entity plans carry a barcode map
  // in the payload.
  const nameOf = (id: string) =>
    itemsById.get(id)?.suggested_name ?? plan.item_names?.[id] ?? "(item)";
  const barcodeOf = (id: string) =>
    itemsById.get(id)?.barcode_text ?? plan.item_barcodes?.[id] ?? null;
  useBarcodeWedge({
    enabled: !done,
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
  const placedCount = groups.reduce(
    (n, g) => n + g.item_ids.filter((id) => placed.has(id)).length,
    0,
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[70] bg-surface dark:bg-slate-950 flex flex-col"
      data-testid="organize-walk-sheet"
    >
      <OverlayFlag />
      <div className="flex items-center gap-3 border-b border-line dark:border-slate-800 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-muted">
            Put-away walk · {placedCount}/{totalItems} placed
          </div>
          {current ? (
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
            <div className="text-lg font-semibold text-content">All put away</div>
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
            <div className="text-xl font-semibold text-content">Everything's in its place.</div>
            <p className="text-sm text-muted">
              {totalItems} item{totalItems === 1 ? "" : "s"} across {groups.length} bin
              {groups.length === 1 ? "" : "s"}.
            </p>
            <button
              type="button"
              onClick={() => {
                const sid = sessionIdRef.current;
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
                    const item = itemsById.get(id);
                    const isPlaced = placed.has(id);
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
                            {item?.suggested_name ?? plan.item_names?.[id] ?? "(item)"}
                          </span>
                          {item && item.quantity > 1 && (
                            <span className="text-sm text-faint shrink-0">×{item.quantity}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {/* The groups still ahead — a glanceable route. */}
            {groups.length > currentIdx + 1 && (
              <div className="pt-2 text-xs text-faint">
                Up next:{" "}
                {groups
                  .slice(currentIdx + 1)
                  .map((g) => `${g.label} → ${g.location_name}`)
                  .join(" · ")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
