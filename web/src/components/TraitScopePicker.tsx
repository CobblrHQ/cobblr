// The ONE trait-predicate picker. "Which entities does this apply to?" is the
// same question whether you're aiming an ACTION (labels:print → physical things)
// or a FIELD ("origin", on everything physical I own) — so it's the same control,
// not two that drift apart.
//
// A 6-axis checkbox grid, two poles per axis. Within an axis the checkboxes OR
// ("physical OR digital"); across axes they AND ("physical AND unique"). That's
// the matcher's real semantics (platform/actions.ts matchAction), surfaced
// literally rather than explained in a tooltip. A live preview lists the entity
// kinds the current selection matches, so an abstract trait choice is
// immediately concrete — and "matches nothing" is visible before you save it.
//
// Presets are the fast path: a chip sets the whole fingerprint in one click
// ("physical things"), and the grid stays right there to adjust it. The chips are
// a shortcut into the vocabulary, never a replacement for it — the earlier
// version of the Fields page offered ONLY two canned scopes, which quietly told
// users the other four axes didn't exist.

import { useMemo } from "react";
import type { PlatformEntityKind } from "../lib/api";
import { traitPredicateMatches } from "../lib/trait-match";
import { TraitProfileBadge } from "./TraitFingerprint";

// The 6 axes, in canonical order. The trait word IS the label — it's the
// vocabulary, deliberately. The `hint` is a genuine one-line definition surfaced
// as a tooltip, not a synonym.
export const TRAIT_AXES: { axis: string; poles: { trait: string; hint: string }[] }[] = [
  {
    axis: "Tangibility",
    poles: [
      { trait: "physical", hint: "Tangible, a real-world thing you could attach a QR sticker to." },
      { trait: "digital", hint: "Exists only as data: a record, config, or message." },
    ],
  },
  {
    axis: "Identity",
    poles: [
      { trait: "fungible", hint: "Interchangeable: tracked by quantity, not which specific one." },
      { trait: "unique", hint: "Individually identified, tracked per instance." },
    ],
  },
  {
    axis: "Containment",
    poles: [
      { trait: "container", hint: "Holds other things: a place, a bin, a box." },
      { trait: "containable", hint: "Can live inside something else." },
    ],
  },
  {
    axis: "Time",
    poles: [
      { trait: "schedulable", hint: "Has a when: a due date, a window, a slot." },
      { trait: "timeless", hint: "Just exists; no inherent date." },
    ],
  },
  {
    axis: "Lifecycle",
    poles: [
      { trait: "completable", hint: "Can be finished: it has a done state." },
      { trait: "indefinite", hint: "Has no natural end; it just persists." },
    ],
  },
  {
    axis: "Persistence",
    poles: [
      { trait: "durable", hint: "Kept until you delete it." },
      { trait: "ephemeral", hint: "Expected to age out or be pruned." },
    ],
  },
];

/** A named shortcut into the vocabulary. Sets the whole selection in one click.
 *  `group` splits the two KINDS of shortcut, which are genuinely different:
 *    broad   — one or two axes, deliberately loose ("anything physical")
 *    profile — a full 6-axis fingerprint, the same named shapes a module declares
 *              its own kinds AS ("every owned-thing"). Narrower, and exact. */
export interface TraitPreset {
  key: string;
  label: string;
  hint: string;
  traits: string[];
  group?: "broad" | "profile";
}

interface Props {
  /** Currently selected trait words (flat — axis grouping is derived). */
  value: string[];
  onChange: (next: string[]) => void;
  /** Every kind in the workspace, for the live match preview. */
  kinds: PlatformEntityKind[];
  /** Optional one-click fingerprints shown above the grid. */
  presets?: TraitPreset[];
  /** Wording for the preview header ("would match" while unsaved). */
  previewVerb?: string;
  /** What the preview counts, when it's not entity kinds. */
  emptyHint?: string;
}

export function TraitScopePicker({
  value,
  onChange,
  kinds,
  presets,
  previewVerb = "matches",
  emptyHint = "matches nothing — pick at least one trait",
}: Props) {
  const selected = useMemo(() => new Set(value), [value]);

  const matches = useMemo(
    () => kinds.filter((k) => traitPredicateMatches(value, k)),
    [value, kinds],
  );

  function toggle(trait: string) {
    const next = new Set(selected);
    if (next.has(trait)) next.delete(trait);
    else next.add(trait);
    onChange([...next]);
  }

  const sameAs = (traits: string[]) =>
    traits.length === selected.size && traits.every((t) => selected.has(t));

  const broad = (presets ?? []).filter((p) => p.group !== "profile");
  const profiles = (presets ?? []).filter((p) => p.group === "profile");

  function Chip({ p, wide }: { p: TraitPreset; wide?: boolean }) {
    const active = sameAs(p.traits);
    return (
      <button
        type="button"
        title={p.hint}
        // Clicking the active chip CLEARS it. A chip is a shortcut into the grid,
        // so it has to be un-pickable the same way a checkbox is.
        onClick={() => onChange(active ? [] : [...p.traits])}
        className={`text-xs px-2 py-1 rounded-full border transition ${
          wide ? "w-full text-left" : ""
        } ${
          active
            ? "border-cobble-500 bg-cobble-600/15 text-accent"
            : "border-line dark:border-slate-700 text-muted hover:border-cobble-500/60"
        }`}
      >
        {p.label}
      </button>
    );
  }

  return (
    <div className="space-y-2">
      {/* Build it by hand on the left, or take a named shape on the right. Same
          thing said two ways: a shape just SETS the grid, so you can start from
          one and adjust it. Neither is a separate mechanism. */}
      <div className="flex flex-col md:flex-row gap-4">
        <div className="flex-1 min-w-0 space-y-2">
          {broad.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mr-1">
                start from
              </span>
              {broad.map((p) => (
                <Chip key={p.key} p={p} />
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            {TRAIT_AXES.map(({ axis, poles }) => (
              <div key={axis} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="w-24 shrink-0 text-[11px] font-mono uppercase tracking-wide text-faint dark:text-slate-500">
                  {axis}
                </span>
                {poles.map((pole) => (
                  <label
                    key={pole.trait}
                    title={pole.hint}
                    className="flex items-center gap-1.5 cursor-pointer select-none w-36"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(pole.trait)}
                      onChange={() => toggle(pole.trait)}
                      className="accent-cobble-500"
                    />
                    <span className="text-content dark:text-mortar-100">{pole.trait}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>

          <div className="text-[10px] text-faint dark:text-slate-500">
            Within a row, ticks are OR'd. Across rows, they're AND'd - so{" "}
            <span className="font-mono">physical + unique</span> means "physical things
            tracked one by one", which excludes parts (those are physical but fungible).
          </div>
        </div>

        {profiles.length > 0 && (
          <div className="md:w-52 shrink-0 md:border-l md:border-line md:dark:border-slate-700 md:pl-4">
            <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">
              or a known shape
            </div>
            <div className="flex flex-col gap-1.5">
              {profiles.map((p) => (
                <Chip key={p.key} p={p} wide />
              ))}
            </div>
            <div className="mt-2 text-[10px] text-faint dark:text-slate-600 leading-relaxed">
              The shapes modules declare their own kinds as. Picking one ticks the
              grid, so you can start from a shape and adjust.
            </div>
          </div>
        )}
      </div>

      {/* Live preview — the abstract choice, made concrete. */}
      <div className="rounded-md bg-subtle dark:bg-slate-800/50 px-3 py-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
          {previewVerb} {matches.length} entity kind{matches.length === 1 ? "" : "s"}
        </div>
        {matches.length > 0 ? (
          <div className="space-y-1.5">
            {matches.map((k) => (
              <div key={k.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface dark:bg-slate-900 border border-line dark:border-slate-700 text-content dark:text-mortar-200">
                  {k.id}
                </span>
                <TraitProfileBadge profile={k.profile} traits={k.traits} />
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[10px] font-mono text-ember-500">{emptyHint}</div>
        )}
      </div>
    </div>
  );
}
