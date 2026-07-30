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
import { TraitScopePicker } from "../components/TraitScopePicker";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast, usePageTitle } from "@cobblr/platform-web";


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
    <div className="space-y-5">
      <p className="text-sm text-content dark:text-mortar-200">
        Each cross-module action declares which entities it applies to. For
        trait-based actions you can adjust that per-axis here - e.g. broaden
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

      {/* Tunable first (the author, 2026-07-03: the ONE editable action was buried
          under twenty "nothing to edit" rows) — then the fixed-scope registry
          under an explicit heading, each row saying WHERE its scope comes
          from instead of a shrug. */}
      {(() => {
        const items = actions.data?.items ?? [];
        const tunable = items.filter((a) => isTraitPredicate(a.effective_applies_to));
        const fixed = items.filter((a) => !isTraitPredicate(a.effective_applies_to));
        const card = (a: (typeof items)[number]) => (
          // Key includes the effective predicate so the card remounts
          // (and re-seeds its checkbox state) whenever a save/revert
          // changes the predicate (stale-state bug otherwise).
          <ActionCard
            key={`${a.id}:${JSON.stringify(a.effective_applies_to)}`}
            action={a}
            slug={slug}
            kinds={kinds.data?.items ?? []}
          />
        );
        return (
          <>
            <div className="space-y-3">
              <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
                // tunable - trait-based, adjust per axis
              </div>
              {tunable.length === 0 ? (
                <p className="text-sm text-faint dark:text-slate-500">
                  No trait-based actions registered.
                </p>
              ) : (
                tunable.map(card)
              )}
            </div>
            <div className="space-y-3 pt-4">
              <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
                // fixed scope - declared by each module, shown for reference
              </div>
              <p className="text-xs text-faint dark:text-slate-500">
                These actions' scope is part of their module's code: either a
                precise kind list (module-internal verbs) or deliberately
                universal (wire-driven shapes that locate their subject from
                the event or args, plus "add to list" which genuinely applies
                to anything). Nothing to tune - listed so the full action
                vocabulary is visible in one place.
              </p>
              {fixed.map(card)}
            </div>
          </>
        );
      })()}
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
              Fixed in <span className="font-mono">{action.module_name}</span>'s manifest
              {"any" in action.effective_applies_to
                ? " — deliberately universal (a wire-driven shape that locates its subject from the event/args, or a verb that genuinely applies to anything)"
                : " — a precise, module-internal kind list"}
              . Matches {action.matched_kinds.length} kind
              {action.matched_kinds.length === 1 ? "" : "s"}.
            </div>
          </div>
        )}

        {editable && (
          <>
            <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
              applies to entities matching
            </div>
            <TraitScopePicker
              value={[...selected]}
              onChange={(next) => setSelected(new Set(next))}
              kinds={kinds}
              previewVerb={dirty ? "would match" : "matches"}
              emptyHint="matches nothing — pick at least one trait, or revert"
            />

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
