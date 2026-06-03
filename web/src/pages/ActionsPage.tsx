// /actions — per-org configuration of which entities each cross-
// module action appears on.
//
// Module manifests declare an action's default appliesTo predicate
// (e.g. labels:print → traits: ["physical"]). This page lets a
// workspace owner adjust that predicate per-org without touching
// the manifest — the "I want labels on tasks too" override from
// docs/architecture/traits.md §Example.
//
// Trait-based predicates render as a 6-axis checkbox grid (two
// poles per axis). Within an axis the checkboxes OR; across axes
// they AND. As the user toggles, a live preview shows which entity
// kinds the predicate would match — so the abstract trait choices
// are immediately concrete. Non-trait predicates (any / kinds /
// hasFieldRole) render read-only.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import {
  ApiError,
  api,
  type ActionAppliesTo,
  type PlatformEntityKind,
  type RegisteredAction,
} from "../lib/api";
import { traitPredicateMatches } from "../lib/trait-match";
import { TraitProfileBadge } from "../components/TraitFingerprint";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast, usePageTitle } from "@cobblr/platform-web";

// The 6 axes, in canonical order. The trait word is the label —
// it's the vocabulary, deliberately. The `hint` is a genuine
// one-line definition surfaced as a tooltip, not a synonym.
const AXES: { axis: string; poles: { trait: string; hint: string }[] }[] = [
  {
    axis: "Tangibility",
    poles: [
      { trait: "physical", hint: "Tangible — a real-world thing you could attach a QR sticker to." },
      { trait: "digital", hint: "Exists only as data — a record, config, or message." },
    ],
  },
  {
    axis: "Identity",
    poles: [
      { trait: "fungible", hint: "Interchangeable — tracked by quantity, not which specific one." },
      { trait: "unique", hint: "Individually identified — tracked per instance." },
    ],
  },
  {
    axis: "Containment",
    poles: [
      { trait: "container", hint: "Holds other entities — things point to it as their location." },
      { trait: "containable", hint: "Goes inside a container — has a location of its own." },
    ],
  },
  {
    axis: "Time",
    poles: [
      { trait: "schedulable", hint: "Time-bound — has a due date, duration, or completion time." },
      { trait: "timeless", hint: "No time-bound semantics — valid until edited or deleted." },
    ],
  },
  {
    axis: "Lifecycle",
    poles: [
      { trait: "completable", hint: "Reaches a terminal done / closed / cancelled state." },
      { trait: "indefinite", hint: "No defined endpoint — persists with its current state." },
    ],
  },
  {
    axis: "Persistence",
    poles: [
      { trait: "durable", hint: "The system keeps it indefinitely." },
      { trait: "ephemeral", hint: "The system auto-prunes it — retention window, TTL, or read-then-clear." },
    ],
  },
];

function isTraitPredicate(p: ActionAppliesTo): p is { traits: string[] } {
  return !("any" in p) && Array.isArray((p as { traits?: string[] }).traits);
}

function predicateSummary(p: ActionAppliesTo): string {
  if ("any" in p) return "every entity (universal)";
  const parts: string[] = [];
  if (p.traits?.length) parts.push(`traits: ${p.traits.join(", ")}`);
  if (p.kinds?.length) parts.push(`kinds: ${p.kinds.join(", ")}`);
  if (p.hasFieldRole) parts.push(`field role: ${p.hasFieldRole}`);
  return parts.join(" · ") || "—";
}

export function ActionsPage() {
  usePageTitle("Actions");
  const { activeSlug: slug } = useActiveOrg();
  const actions = useQuery({
    queryKey: ["registered-actions", slug],
    queryFn: () => api.listRegisteredActions(slug),
    enabled: !!slug,
  });
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
  });

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 lowercase">
          actions
        </h1>
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">
          cross-module action predicates
        </span>
      </div>

      <p className="text-sm text-content dark:text-mortar-200">
        Each cross-module action declares which entities it applies to. For
        trait-based actions you can adjust that per-axis here — e.g. broaden
        "Print label" to also cover digital entities like tasks. Within an axis
        the checkboxes are OR'd; across axes they're AND'd. The match preview
        updates live as you toggle.
      </p>

      {(actions.isLoading || kinds.isLoading) && (
        <div className="text-sm text-faint">Loading…</div>
      )}
      {actions.error && (
        <div className="text-sm text-ember-500">
          {actions.error instanceof ApiError
            ? actions.error.message
            : "Couldn't load actions."}
        </div>
      )}

      <div className="space-y-3">
        {(actions.data?.items ?? []).map((a) => (
          // Key includes the effective predicate so the card remounts
          // (and re-seeds its checkbox state) whenever a save/revert
          // changes the predicate. A plain `key={a.id}` left local
          // checkbox state stale after "revert to default" until a
          // page refresh. Unrelated refetches keep the same key —
          // in-progress edits on other cards survive.
          <ActionCard
            key={`${a.id}:${JSON.stringify(a.effective_applies_to)}`}
            action={a}
            slug={slug}
            kinds={kinds.data?.items ?? []}
          />
        ))}
      </div>
    </div>
  );
}

function ActionCard({
  action,
  slug,
  kinds,
}: {
  action: RegisteredAction;
  slug: string;
  kinds: PlatformEntityKind[];
}) {
  const qc = useQueryClient();
  const toast = useToast();

  const editable = isTraitPredicate(action.effective_applies_to);

  // Seeded once on mount. The parent keys this card on the effective
  // predicate, so a save/revert that changes the predicate remounts
  // the card and re-seeds this from the fresh value — no stale state.
  const initialSelected = useMemo(() => {
    const p = action.effective_applies_to;
    return new Set(isTraitPredicate(p) ? p.traits : []);
  }, [action.effective_applies_to]);
  const [selected, setSelected] = useState<Set<string>>(initialSelected);

  const dirty = useMemo(() => {
    if (selected.size !== initialSelected.size) return true;
    for (const t of selected) if (!initialSelected.has(t)) return true;
    return false;
  }, [selected, initialSelected]);

  // Live preview: which entity kinds the *current* checkbox state
  // would match. Recomputed client-side so toggling is instant.
  const previewMatches = useMemo(() => {
    if (!editable) return action.matched_kinds;
    const sel = [...selected];
    return kinds.filter((k) => traitPredicateMatches(sel, k)).map((k) => k.id);
  }, [selected, kinds, editable, action.matched_kinds]);

  const save = useMutation({
    mutationFn: () =>
      api.setActionPredicate(slug, action.id, { traits: [...selected] }),
    onSuccess: () => {
      toast.success(`Updated ${action.label}.`);
      void qc.invalidateQueries({ queryKey: ["registered-actions", slug] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't save."),
  });
  const revert = useMutation({
    mutationFn: () => api.revertActionPredicate(slug, action.id),
    onSuccess: () => {
      toast.success(`Reverted ${action.label} to its default.`);
      void qc.invalidateQueries({ queryKey: ["registered-actions", slug] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't revert."),
  });

  function toggle(trait: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trait)) next.delete(trait);
      else next.add(trait);
      return next;
    });
  }

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900">
      <div className="px-4 py-3 border-b border-line dark:border-slate-700 flex items-baseline gap-2 flex-wrap">
        <span className="font-medium text-content dark:text-mortar-100">
          {action.label}
        </span>
        <span className="text-[10px] font-mono text-faint">{action.id}</span>
        {action.overridden && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-accent dark:text-cobble-300 border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5">
            overridden
          </span>
        )}
      </div>

      <div className="px-4 py-3 space-y-3">
        {action.description && (
          <div className="text-xs text-content dark:text-mortar-200">
            {action.description}
          </div>
        )}

        {!editable && (
          <div className="text-xs text-muted dark:text-slate-400">
            Predicate:{" "}
            <span className="font-mono">
              {predicateSummary(action.effective_applies_to)}
            </span>
            <div className="text-[10px] text-faint mt-1">
              Not a trait-based predicate — not editable here. Matches{" "}
              {action.matched_kinds.length} kind
              {action.matched_kinds.length === 1 ? "" : "s"}.
            </div>
          </div>
        )}

        {editable && (
          <>
            <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
              applies to entities matching
            </div>
            <div className="space-y-1.5">
              {AXES.map(({ axis, poles }) => (
                <div key={axis} className="flex items-center gap-3 text-sm">
                  <span className="w-28 shrink-0 text-[11px] font-mono uppercase tracking-wide text-faint dark:text-slate-500">
                    {axis}
                  </span>
                  {poles.map((pole) => (
                    <label
                      key={pole.trait}
                      title={pole.hint}
                      className="flex items-center gap-1.5 cursor-pointer select-none w-44"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(pole.trait)}
                        onChange={() => toggle(pole.trait)}
                        className="accent-cobble-500"
                      />
                      <span className="text-content dark:text-mortar-100">
                        {pole.trait}
                      </span>
                    </label>
                  ))}
                </div>
              ))}
            </div>

            {/* Live match preview */}
            <div className="rounded-md bg-subtle dark:bg-slate-800/50 px-3 py-2">
              <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                {dirty ? "would match" : "matches"} {previewMatches.length}{" "}
                entity kind{previewMatches.length === 1 ? "" : "s"}
                {dirty && (
                  <span className="text-accent"> · unsaved</span>
                )}
              </div>
              {previewMatches.length > 0 ? (
                <div className="space-y-1.5">
                  {previewMatches.map((kid) => {
                    const k = kinds.find((x) => x.id === kid);
                    return (
                      <div key={kid} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface dark:bg-slate-900 border border-line dark:border-slate-700 text-content dark:text-mortar-200">
                          {kid}
                        </span>
                        {k && (
                          <TraitProfileBadge profile={k.profile} traits={k.traits} />
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-[10px] font-mono text-ember-500">
                  matches nothing — pick at least one trait, or revert
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => save.mutate()}
                disabled={!dirty || selected.size === 0 || save.isPending}
                className="text-[10px] font-mono uppercase tracking-widest px-3 py-1.5 rounded border border-cobble-300 dark:border-cobble-700 text-accent dark:text-cobble-300 hover:bg-subtle dark:hover:bg-slate-800 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                save
              </button>
              {action.overridden && (
                <button
                  onClick={() => revert.mutate()}
                  disabled={revert.isPending}
                  className="text-[10px] font-mono uppercase tracking-widest px-3 py-1.5 rounded text-faint hover:text-ember-500 transition flex items-center gap-1"
                >
                  <RotateCcw size={11} />
                  revert to default
                </button>
              )}
              <span className="text-[10px] font-mono text-faint ml-auto">
                default: {predicateSummary(action.default_applies_to)}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
