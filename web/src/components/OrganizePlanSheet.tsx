// Guided Organize — the plan review sheet (docs/product/guided-organize.md).
//
// Opened from the scan inbox's bulk toolbar: sends the selection to
// POST /organize/plan and renders the proposed groups. Each group shows its
// members, a destination with EVIDENCE ("14 similar items already live here"),
// and applies only on an explicit Accept — per group or all at once. A
// destination can be overridden with the location tree picker; "unassigned"
// groups need one before Accept enables. Nothing files until accepted.

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, FolderPlus, MapPin, Sparkles, Wand2 } from "lucide-react";
import { Modal, useImageSrc, useToast } from "@cobblr/platform-web";
import {
  api,
  type OrganizeGroup,
  type OrganizePlanResponse,
  type ScanInboxItem,
} from "../lib/api";
import { LocationTreePicker } from "./LocationTreePicker";

function ItemThumb({ slug, item }: { slug: string; item: ScanInboxItem | undefined }) {
  const fileId = item?.catalog_image_file_id ?? item?.image_file_id ?? null;
  const src = useImageSrc(
    fileId ? `/api/v1/orgs/${slug}/modules/core-files/files/${fileId}/raw?variant=thumb` : null,
  );
  if (!src) {
    return <div className="h-8 w-8 shrink-0 rounded bg-subtle dark:bg-slate-800" />;
  }
  return <img src={src} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />;
}

function DestinationChip({ group }: { group: OrganizeGroup }) {
  const d = group.destination;
  if (d.kind === "existing") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-cobble-50 dark:bg-cobble-900/40 text-accent px-2.5 py-1 text-xs font-medium">
        <MapPin className="h-3.5 w-3.5" />
        {d.location_path || d.location_name}
      </span>
    );
  }
  if (d.kind === "new") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-accent/60 text-accent px-2.5 py-1 text-xs font-medium">
        <FolderPlus className="h-3.5 w-3.5" />
        New bin: {d.name}
        {d.parent_name ? <span className="text-muted">in {d.parent_name}</span> : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-subtle dark:bg-slate-800 text-muted px-2.5 py-1 text-xs">
      Needs a destination
    </span>
  );
}

export function OrganizePlanSheet({
  slug,
  itemIds,
  itemsById,
  open,
  onClose,
  onApplied,
  onStartWalk,
  scope,
}: {
  slug: string;
  itemIds: string[];
  itemsById: Map<string, ScanInboxItem>;
  open: boolean;
  onClose: () => void;
  /** Fired after any successful apply, with the item ids that were filed. */
  onApplied: (filedItemIds: string[]) => void;
  /** Phase 2: open the put-away walk over the just-applied groups. */
  onStartWalk?: () => void;
  /** Phase 3: "unplaced" plans over committed entities with no location
   *  (itemIds is ignored; names come from the plan payload). */
  scope?: "unplaced";
}) {
  const toast = useToast();
  const [plan, setPlan] = useState<OrganizePlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Map<string, string>>(new Map()); // group → location_id
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setError(null);
    setApplied(new Set());
    setOverrides(new Map());
    setPickerFor(null);
    setLoading(true);
    api
      .organizePlan(slug, scope === "unplaced" ? { scope } : { item_ids: itemIds })
      .then(setPlan)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Planning failed"))
      .finally(() => setLoading(false));
    // Re-plan only when the sheet (re)opens — the selection is frozen at open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applicable = useMemo(
    () =>
      (plan?.groups ?? []).filter(
        (g) =>
          !applied.has(g.id) && (g.destination.kind !== "unassigned" || overrides.has(g.id)),
      ),
    [plan, applied, overrides],
  );

  const apply = async (groupIds: string[]) => {
    if (!plan || groupIds.length === 0) return;
    setBusy(true);
    try {
      const res = await api.organizeApply(slug, {
        plan_id: plan.plan_id,
        group_ids: groupIds,
        overrides: groupIds
          .filter((gid) => overrides.has(gid))
          .map((gid) => ({ group_id: gid, location_id: overrides.get(gid)! })),
      });
      setApplied((prev) => new Set([...prev, ...res.applied_group_ids]));
      if (res.created_locations.length > 0) {
        toast.success(
          `Created ${res.created_locations.map((l) => l.name).join(", ")} and filed ${res.filed_item_ids.length} item(s)`,
        );
      } else if (res.filed_item_ids.length > 0) {
        toast.success(`Filed ${res.filed_item_ids.length} item(s)`);
      }
      for (const s of res.skipped) toast.error(`A group was skipped: ${s.reason}`);
      if (res.filed_item_ids.length > 0) onApplied(res.filed_item_ids);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Organize this batch" size="lg">
      {loading && (
        <div className="flex items-center gap-2 py-8 justify-center text-muted text-sm">
          <Wand2 className="h-4 w-4 animate-pulse" />
          Planning where everything should go…
        </div>
      )}
      {error && <div className="py-6 text-center text-sm text-bad">{error}</div>}

      {plan && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {plan.source === "ai" ? (
              <span className="inline-flex items-center gap-1 text-accent">
                <Sparkles className="h-3.5 w-3.5" /> AI plan
              </span>
            ) : (
              <span title="No AI provider — grouped by where similar items already live.">
                Similarity plan (no AI)
              </span>
            )}
            {plan.already_filed_item_ids.length > 0 && (
              <span>{plan.already_filed_item_ids.length} already filed (untouched)</span>
            )}
            {plan.needs_review_item_ids.length > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                {plan.needs_review_item_ids.length} need identifying first — excluded
              </span>
            )}
            {plan.census_truncated && <span>Large workspace: planned against the busiest bins.</span>}
          </div>

          {plan.groups.map((g) => {
            const isApplied = applied.has(g.id);
            const override = overrides.get(g.id);
            const canApply = !isApplied && (g.destination.kind !== "unassigned" || !!override);
            return (
              <div
                key={g.id}
                className={`rounded-lg border border-line dark:border-slate-700 p-3 ${isApplied ? "opacity-60" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-content">{g.label}</span>
                  <span className="text-xs text-faint">{g.item_ids.length} item(s)</span>
                  <span className="flex-1" />
                  {override ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-cobble-50 dark:bg-cobble-900/40 text-accent px-2.5 py-1 text-xs font-medium">
                      <MapPin className="h-3.5 w-3.5" /> your pick
                    </span>
                  ) : (
                    <DestinationChip group={g} />
                  )}
                  {isApplied ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                      <CheckCircle2 className="h-4 w-4" /> Filed
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => setPickerFor((p) => (p === g.id ? null : g.id))}
                        className="text-xs text-accent hover:underline"
                      >
                        Change…
                      </button>
                      <button
                        type="button"
                        disabled={busy || !canApply}
                        onClick={() => void apply([g.id])}
                        className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-2.5 py-1 transition disabled:opacity-50"
                      >
                        Accept
                      </button>
                    </>
                  )}
                </div>
                {(g.rationale || g.evidence) && (
                  <p className="mt-1 text-xs text-muted">
                    {g.rationale}
                    {g.evidence && (
                      <span className="text-faint">
                        {" "}
                        ({g.evidence.sibling_count} similar already there
                        {g.evidence.sample_names.length > 0
                          ? `: ${g.evidence.sample_names.slice(0, 2).join(", ")}`
                          : ""}
                        )
                      </span>
                    )}
                  </p>
                )}
                {pickerFor === g.id && !isApplied && (
                  <div className="mt-2">
                    <LocationTreePicker
                      value={override ?? null}
                      onChange={(v) => {
                        if (v) {
                          setOverrides((prev) => new Map(prev).set(g.id, v));
                          setPickerFor(null);
                        }
                      }}
                      label="File this group into"
                    />
                  </div>
                )}
                <ul className="mt-2 space-y-1">
                  {g.item_ids.map((id) => {
                    const item = itemsById.get(id);
                    return (
                      <li key={id} className="flex items-center gap-2 text-sm text-content">
                        <ItemThumb slug={slug} item={item} />
                        <span className="truncate">
                          {item?.suggested_name ?? plan.item_names?.[id] ?? "(unidentified)"}
                        </span>
                        {item && item.quantity > 1 && (
                          <span className="text-xs text-faint">×{item.quantity}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-line dark:border-slate-700 text-sm px-3 py-1.5 text-content hover:bg-subtle dark:hover:bg-slate-800 transition"
            >
              {applied.size > 0 ? "Done" : "Cancel"}
            </button>
            {applied.size > 0 && onStartWalk && (
              <button
                type="button"
                disabled={busy}
                onClick={onStartWalk}
                title="Walk the accepted groups bin by bin — scan or tap each item as you put it away"
                className="rounded border border-accent/60 text-accent text-sm font-medium px-3 py-1.5 hover:bg-cobble-50 dark:hover:bg-cobble-900/30 transition disabled:opacity-50"
              >
                Start put-away walk →
              </button>
            )}
            <button
              type="button"
              disabled={busy || applicable.length === 0}
              onClick={() => void apply(applicable.map((g) => g.id))}
              className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
            >
              {busy ? "Filing…" : `Accept all (${applicable.length})`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
