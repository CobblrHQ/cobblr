// Guided Organize — the plan review sheet (docs/product/guided-organize.md).
//
// Opened from the scan inbox's bulk toolbar (and the put-away front door):
// sends the selection to POST /organize/plan and renders the proposed groups.
// Each group shows its members, a destination with EVIDENCE ("14 similar
// items already live here"), and applies only on an explicit Accept — per
// group or all at once. Nothing files until accepted. The human has the
// last word EVERYWHERE:
//   - destination override (location picker) and inline RENAME of a proposed
//     new bin (your vocabulary beats the model's — and becomes evidence);
//   - per-item SPLIT ("not related") — excluded at apply, keeps triage;
//   - rows open the REAL inbox triage card (via onOpenItem) to fix a wrong
//     identification in place; identity edits mark the plan STALE;
//   - a hint box + Re-plan re-runs the plan with your ground truth folded in
//     (already-applied groups stay filed; the remainder regroups).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, FolderPlus, MapPin, Pencil, RotateCcw, Sparkles, Wand2, X } from "lucide-react";
import { Modal, useImageSrc, useToast } from "@cobblr/platform-web";
import {
  api,
  type OrganizeGroup,
  type OrganizePlanResponse,
  type ScanInboxItem,
} from "../lib/api";
import { LocationTreePicker } from "./LocationTreePicker";

// Unaccepted tweaks per plan (splits, renames, overrides, the typed hint),
// keyed by plan_id — the server's draft cache returns the SAME plan on
// reopen, and this returns the same working state on top of it. In-memory on
// purpose: it matches the draft's lifetime and never outlives the tab.
const planUiState = new Map<
  string,
  {
    overrides: Map<string, string>;
    splitOut: Map<string, Set<string>>;
    renames: Map<string, string>;
  }
>();
const PLAN_UI_STATE_CAP = 10;

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

function DestinationChip({
  group,
  onRename,
  onPick,
}: {
  group: OrganizeGroup & { renamed?: string };
  /** New-bin chips edit their name IN PLACE — the chip is the control. */
  onRename?: () => void;
  /** Existing/unassigned chips open the location picker on click. */
  onPick?: () => void;
}) {
  const d = group.destination;
  if (d.kind === "existing") {
    // An evidence-backed pick reads confident; an AI guess reads amber — the
    // difference between "your resistors live here" and "the model thinks so".
    return (
      <button
        type="button"
        onClick={onPick}
        disabled={!onPick}
        title={onPick ? "Click to file this group somewhere else" : undefined}
        className={`${
          group.ai_guess
            ? "inline-flex items-center gap-1.5 rounded-full bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-2.5 py-1 text-xs font-medium"
            : "inline-flex items-center gap-1.5 rounded-full bg-cobble-50 dark:bg-cobble-900/40 text-accent px-2.5 py-1 text-xs font-medium"
        } ${onPick ? "hover:opacity-80 transition" : ""}`}
      >
        <MapPin className="h-3.5 w-3.5" />
        {d.location_path || d.location_name}
        {group.ai_guess ? <span className="font-normal">(AI suggestion)</span> : null}
      </button>
    );
  }
  if (d.kind === "new") {
    return (
      <button
        type="button"
        onClick={onRename}
        disabled={!onRename}
        title={onRename ? "Click to rename the new bin — your word for it beats the AI's" : undefined}
        className={`inline-flex items-center gap-1.5 rounded-full border border-dashed border-accent/60 text-accent px-2.5 py-1 text-xs font-medium ${
          onRename ? "hover:bg-cobble-50 dark:hover:bg-cobble-900/30 transition" : ""
        }`}
      >
        <FolderPlus className="h-3.5 w-3.5" />
        New bin: {group.renamed ?? d.name}
        {d.parent_name ? <span className="text-muted">in {d.parent_name}</span> : null}
        {onRename && <Pencil className="h-3 w-3 opacity-60" />}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={!onPick}
      title={onPick ? "Click to pick where this group goes" : undefined}
      className={`inline-flex items-center rounded-full bg-subtle dark:bg-slate-800 text-muted px-2.5 py-1 text-xs ${
        onPick ? "hover:text-content border border-transparent hover:border-line transition" : ""
      }`}
    >
      Needs a destination
    </button>
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
  renderItemCard,
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
  scope?: "unplaced" | "pending";
  /** Render the REAL inbox card INLINE under a row (accordion) so a wrong
   *  identification is fixable without leaving the plan — no modal stacking.
   *  The page owns the card; the sheet owns the accordion. Only meaningful
   *  for inbox subjects. */
  renderItemCard?: (itemId: string) => ReactNode;
}) {
  const toast = useToast();
  const [plan, setPlan] = useState<OrganizePlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Map<string, string>>(new Map()); // group → location_id
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Items split out per group ("not related") — excluded at apply-time.
  const [splitOut, setSplitOut] = useState<Map<string, Set<string>>>(new Map());
  // Inline renames of PROPOSED new bins (your vocabulary beats the model's).
  const [renames, setRenames] = useState<Map<string, string>>(new Map());
  const [renaming, setRenaming] = useState<string | null>(null);
  // Ground truth for a re-plan.
  const [hint, setHint] = useState("");
  // The one item whose fixer accordion is open.
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  // Re-planning keeps the CURRENT plan on screen (dimmed) — a hint must never
  // blank the modal while the model thinks.
  const [replanning, setReplanning] = useState(false);
  // Cobb changed the workspace while this plan was up (created locations,
  // renamed things) — the draft can't see census changes, so nudge a fresh
  // re-plan.
  const [cobbTouched, setCobbTouched] = useState(false);
  useEffect(() => {
    const onChanged = () => setCobbTouched(true);
    window.addEventListener("cobblr:workspace-changed", onChanged);
    return () => window.removeEventListener("cobblr:workspace-changed", onChanged);
  }, []);

  const runPlan = (withHint?: string, opts?: { fresh?: boolean; clearHint?: boolean }) => {
    const initial = plan === null;
    setError(null);
    if (initial) setLoading(true);
    else setReplanning(true); // keep the old plan rendered, dimmed
    api
      .organizePlan(slug, {
        ...(scope ? { scope } : { item_ids: itemIds }),
        ...(withHint?.trim() ? { hint: withHint.trim() } : {}),
        ...(opts?.fresh ? { fresh: true } : {}),
        ...(opts?.clearHint ? { clear_hint: true } : {}),
      })
      .then((p) => {
        setPlan(p);
        setApplied(new Set(p.applied_group_ids ?? []));
        setPickerFor(null);
        setRenaming(null);
        setExpandedItem(null);
        setCobbTouched(false);
        const saved = planUiState.get(p.plan_id);
        setOverrides(saved ? new Map(saved.overrides) : new Map());
        setSplitOut(
          saved ? new Map([...saved.splitOut].map(([k, v]) => [k, new Set(v)])) : new Map(),
        );
        setRenames(saved ? new Map(saved.renames) : new Map());
        // A processed hint doesn't linger in the box (the author) — its result
        // IS the plan, and the plan line carries the provenance.
        setHint("");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Planning failed"))
      .finally(() => {
        setLoading(false);
        setReplanning(false);
      });
  };

  useEffect(() => {
    if (!open) return;
    setHint("");
    setPlan(null);
    setApplied(new Set());
    setOverrides(new Map());
    setSplitOut(new Map());
    setRenames(new Map());
    runPlan();
    // Plan only when the sheet (re)opens — the selection is frozen at open;
    // Re-plan is an explicit button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Persist the working state per plan (see planUiState above).
  useEffect(() => {
    if (!plan) return;
    planUiState.set(plan.plan_id, {
      overrides: new Map(overrides),
      splitOut: new Map([...splitOut].map(([k, v]) => [k, new Set(v)])),
      renames: new Map(renames),
    });
    if (planUiState.size > PLAN_UI_STATE_CAP) {
      const oldest = planUiState.keys().next().value;
      if (oldest) planUiState.delete(oldest);
    }
  }, [plan, overrides, splitOut, renames]);

  // AUTO-ADOPT: while this sheet is open, a NEWER standing plan (Cobb's
  // replan_putaway, or a re-plan from another tab) replaces the one on
  // screen — Cobb closes its own loop; the user never has to click Re-plan
  // after the assistant acts. scope:"pending" only (the standing-draft
  // surface); never mid-action.
  useEffect(() => {
    if (scope !== "pending" || !open) return;
    const t = setInterval(() => {
      if (busy || loading || replanning) return;
      void api
        .getLatestOrganizePlan(slug)
        .then(({ plan: latest }) => {
          if (!latest || !plan) return;
          if (latest.plan_id === plan.plan_id) return;
          if ((latest.applied_group_ids ?? []).length > 0) return; // mid-walk plan, not a draft
          setPlan({
            plan_id: latest.plan_id,
            expires_at: latest.expires_at,
            groups: latest.groups,
            already_filed_item_ids: latest.already_filed_item_ids ?? [],
            needs_review_item_ids: latest.needs_review_item_ids ?? [],
            census_truncated: latest.census_truncated ?? false,
            source: latest.source ?? "ai",
            draft_hinted: (latest as { draft_hinted?: boolean }).draft_hinted,
            item_names: latest.item_names,
          } as OrganizePlanResponse);
          setApplied(new Set(latest.applied_group_ids ?? []));
          setOverrides(new Map());
          setSplitOut(new Map());
          setRenames(new Map());
          setPickerFor(null);
          setRenaming(null);
          setExpandedItem(null);
          setCobbTouched(false);
          toast.info("Plan updated — re-routed against your latest changes.");
        })
        .catch(() => {});
    }, 8_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, open, plan?.plan_id, busy, loading, replanning]);

  // STALE detection: an item edited through the embedded triage card (renamed,
  // re-identified) no longer matches what this plan grouped on. Compare what
  // the plan captured against the live rows the page passes down.
  const stale = useMemo(() => {
    if (!plan) return false;
    for (const g of plan.groups) {
      if (applied.has(g.id)) continue;
      for (const id of g.item_ids) {
        const captured = plan.item_names?.[id];
        const live = itemsById.get(id)?.suggested_name;
        if (captured && live && captured !== live) return true;
      }
    }
    return false;
  }, [plan, itemsById, applied]);

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
          .map((gid) => {
            const g = plan.groups.find((x) => x.id === gid);
            const excluded = [...(splitOut.get(gid) ?? [])];
            const rename = renames.get(gid)?.trim();
            const o: {
              group_id: string;
              location_id?: string;
              new_location?: { name: string; parent_id?: string | null };
              exclude_item_ids?: string[];
            } = { group_id: gid };
            if (overrides.has(gid)) o.location_id = overrides.get(gid)!;
            else if (rename && g?.destination.kind === "new" && rename !== g.destination.name) {
              o.new_location = { name: rename, parent_id: g.destination.parent_id };
            }
            if (excluded.length > 0) o.exclude_item_ids = excluded;
            return o;
          })
          .filter((o) => o.location_id || o.new_location || o.exclude_item_ids),
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
    <Modal
      open={open}
      onClose={onClose}
      title={
        scope === "pending"
          ? "Put away your scanned backlog"
          : scope === "unplaced"
            ? "Organize what you track"
            : "Organize this batch"
      }
      size="content"
    >
      {loading && (
        <div className="flex items-center gap-2 py-8 justify-center text-muted text-sm">
          <Wand2 className="h-4 w-4 animate-pulse" />
          Planning where everything should go…
        </div>
      )}
      {error && <div className="py-6 text-center text-sm text-bad">{error}</div>}

      {plan && replanning && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/40 bg-cobble-50/60 dark:bg-cobble-900/20 px-3 py-2 text-xs text-accent">
          <Wand2 className="h-3.5 w-3.5 animate-pulse" />
          Re-planning{hint.trim() ? " with your hint" : ""}… the current plan stays visible until
          the new one lands.
        </div>
      )}
      {plan && (
        <div className={`space-y-3 ${replanning ? "opacity-50 pointer-events-none" : ""}`}>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {plan.source === "ai" ? (
              <span className="inline-flex items-center gap-1 text-accent">
                <Sparkles className="h-3.5 w-3.5" /> AI plan
                {plan.draft_hinted && plan.hint_text && (
                  <span className="inline-flex items-center gap-1 text-muted">
                    · guided by your hint "{plan.hint_text}"
                    <button
                      type="button"
                      onClick={() => runPlan(undefined, { fresh: true, clearHint: true })}
                      title="Stop applying this hint and re-plan without it"
                      className="text-faint hover:text-content underline decoration-dotted"
                    >
                      clear
                    </button>
                  </span>
                )}
              </span>
            ) : (
              <span title="No AI provider — grouped by where similar items already live.">
                Similarity plan (no AI)
              </span>
            )}
            {plan.already_filed_item_ids.length > 0 && !plan.groups.some((g) => g.ready) && (
              <span>{plan.already_filed_item_ids.length} already filed (untouched)</span>
            )}
            {plan.needs_review_item_ids.length > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                {plan.needs_review_item_ids.length} need identifying first — excluded
              </span>
            )}
            {plan.census_truncated && <span>Large workspace: planned against the busiest bins.</span>}
          </div>

          {cobbTouched && !replanning && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 px-3 py-2 text-xs text-content dark:text-mortar-100">
              Cobb changed your workspace — re-plan to route against it.
              <button
                type="button"
                onClick={() => runPlan(hint, { fresh: true })}
                className="rounded bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-2 py-1 transition"
              >
                Re-plan
              </button>
            </div>
          )}
          {stale && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              You changed items since this plan was made — the groups below may not fit anymore.
              <button
                type="button"
                onClick={() => runPlan(hint, { fresh: true })}
                className="rounded bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-2 py-1 transition"
              >
                Re-plan
              </button>
            </div>
          )}

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
                  <span className="text-xs text-faint">
                    {g.item_ids.length} item{g.item_ids.length === 1 ? "" : "s"}
                  </span>
                  <span className="flex-1" />
                  {override ? (
                    <button
                      type="button"
                      onClick={() => setPickerFor((p) => (p === g.id ? null : g.id))}
                      title="Click to change where this group files"
                      className="inline-flex items-center gap-1.5 rounded-full bg-cobble-50 dark:bg-cobble-900/40 text-accent px-2.5 py-1 text-xs font-medium hover:opacity-80 transition"
                    >
                      <MapPin className="h-3.5 w-3.5" /> your pick
                    </button>
                  ) : renaming === g.id && g.destination.kind === "new" ? (
                    <form
                      className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-accent/60 px-2.5 py-0.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setRenaming(null);
                      }}
                    >
                      <FolderPlus className="h-3.5 w-3.5 text-accent shrink-0" />
                      <input
                        autoFocus
                        value={renames.get(g.id) ?? g.destination.name}
                        onChange={(e) =>
                          setRenames((prev) => new Map(prev).set(g.id, e.target.value))
                        }
                        onBlur={() => setRenaming(null)}
                        onFocus={(e) => e.target.select()}
                        maxLength={120}
                        className="w-44 bg-transparent text-xs font-medium text-accent outline-none"
                        aria-label="Name the new bin"
                      />
                    </form>
                  ) : (
                    <DestinationChip
                      group={{ ...g, renamed: renames.get(g.id) }}
                      onRename={!isApplied ? () => setRenaming(g.id) : undefined}
                      onPick={
                        !isApplied
                          ? () => setPickerFor((p) => (p === g.id ? null : g.id))
                          : undefined
                      }
                    />
                  )}
                  {g.ready ? (
                    <span
                      className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs font-medium"
                      title="Already set — it's in the put-away walk; nothing to accept"
                    >
                      <CheckCircle2 className="h-4 w-4" /> All set — just put them away
                    </span>
                  ) : isApplied ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                      <CheckCircle2 className="h-4 w-4" /> Filed
                    </span>
                  ) : (
                    <>
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
                {pickerFor === g.id && !isApplied && (
                  <div className="mt-2 rounded-lg border border-accent/40 bg-subtle/40 dark:bg-slate-900/40 p-2">
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
                {g.size_warning && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    ⚠ {g.size_warning}
                  </p>
                )}
                {g.ai_guess && !override && !isApplied && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    Nothing similar lives there yet — this is the AI's suggestion, not a match.
                    Accept if it fits, or Change…
                  </p>
                )}
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
                <ul className="mt-2 space-y-1">
                  {g.item_ids.map((id) => {
                    const item = itemsById.get(id);
                    const isSplit = splitOut.get(g.id)?.has(id) ?? false;
                    return (
                      <li key={id} className="flex flex-wrap items-center text-sm text-content">
                        <div
                          role={renderItemCard && item ? "button" : undefined}
                          tabIndex={renderItemCard && item ? 0 : undefined}
                          onClick={
                            renderItemCard && item
                              ? () => setExpandedItem((cur) => (cur === id ? null : id))
                              : undefined
                          }
                          onKeyDown={
                            renderItemCard && item
                              ? (e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    setExpandedItem((cur) => (cur === id ? null : id));
                                  }
                                }
                              : undefined
                          }
                          title={
                            renderItemCard && item
                              ? "Expand to fix a wrong name, photo, or identification — right here, no new window"
                              : undefined
                          }
                          className={`min-w-0 flex-1 flex items-center gap-2 rounded px-1 -mx-1 py-0.5 ${
                            renderItemCard && item
                              ? "cursor-pointer hover:bg-subtle dark:hover:bg-slate-800/60 transition"
                              : ""
                          }`}
                        >
                          <ItemThumb slug={slug} item={item} />
                          <span className={`truncate ${isSplit ? "line-through text-faint" : ""}`}>
                            {item?.suggested_name ?? plan.item_names?.[id] ?? "(unidentified)"}
                          </span>
                          {item && item.quantity > 1 && (
                            <span className="text-xs text-faint">×{item.quantity}</span>
                          )}
                          <span className="flex-1" />
                          {renderItemCard && item && (
                            <ChevronDown
                              size={14}
                              className={`shrink-0 text-faint transition ${expandedItem === id ? "rotate-180" : ""}`}
                            />
                          )}
                        </div>
                        {!isApplied &&
                          !g.ready &&
                          (isSplit ? (
                            <button
                              type="button"
                              onClick={() =>
                                setSplitOut((prev) => {
                                  const next = new Map(prev);
                                  const set = new Set(next.get(g.id));
                                  set.delete(id);
                                  if (set.size === 0) next.delete(g.id);
                                  else next.set(g.id, set);
                                  return next;
                                })
                              }
                              title="Put it back in the group"
                              className="inline-flex items-center gap-1 text-xs text-muted hover:text-content transition shrink-0"
                            >
                              <RotateCcw className="h-3 w-3" /> undo
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                setSplitOut((prev) => {
                                  const next = new Map(prev);
                                  const set = new Set(next.get(g.id));
                                  set.add(id);
                                  next.set(g.id, set);
                                  return next;
                                })
                              }
                              title="Not related — leave it out of this group (it stays in the inbox)"
                              className="text-faint hover:text-content transition shrink-0"
                              aria-label="Split this item out of the group"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          ))}
                        {expandedItem === id && renderItemCard && item && (
                          <div className="w-full basis-full mt-1 rounded-lg border border-accent/30 bg-subtle/50 dark:bg-slate-900/60 p-2">
                            {renderItemCard(id)}
                            <div className="mt-1 text-right">
                              <button
                                type="button"
                                onClick={() => setExpandedItem(null)}
                                className="text-xs text-accent hover:underline"
                              >
                                Done fixing — collapse
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {(splitOut.get(g.id)?.size ?? 0) > 0 && !isApplied && (
                  <p className="mt-1 text-xs text-muted">
                    {splitOut.get(g.id)!.size} split out — they stay in the inbox for their own
                    triage. Disagree with the whole grouping? Say why below and Re-plan.
                  </p>
                )}
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <div className="flex min-w-0 flex-1 basis-72 items-stretch">
              <input
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && hint.trim()) runPlan(hint, { fresh: true });
                }}
                placeholder='Tell the planner something… ("these are camping gear" / "I have a supply closet")'
                maxLength={500}
                className="min-w-0 flex-1 rounded-l border border-r-0 border-line dark:border-slate-700 bg-transparent px-2.5 py-1.5 text-xs text-content"
              />
              <button
                type="button"
                disabled={busy || loading || replanning || (!hint.trim() && !stale && !cobbTouched)}
                onClick={() => runPlan(hint, { fresh: true })}
                title="Re-plan the un-accepted groups with your hint folded in (accepted groups stay filed)"
                className="rounded-r border border-accent/60 text-accent text-xs font-medium px-2.5 py-1.5 hover:bg-cobble-50 dark:hover:bg-cobble-900/30 transition disabled:opacity-50 shrink-0"
              >
                Re-plan
              </button>
            </div>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("cobblr:open-chat", {
                    detail: {
                      seed:
                        "Describe the places in your home — Cobb sees this plan, creates the locations with your confirmation, then re-plans for you.",
                    },
                  }),
                )
              }
              title="More than a one-liner? Cobb can see this plan, talk your home through with you, create the places you describe, and re-plan for you"
              className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline shrink-0"
            >
              <Sparkles className="h-3.5 w-3.5" /> or tell Cobb instead
            </button>
            <span className="flex-1" />
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
              {busy
                ? "Filing…"
                : `Accept all ${applicable.length} group${applicable.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
