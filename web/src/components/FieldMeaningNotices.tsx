// The two questions the Fields page asks about a kind's fields, once each
// (#4518):
//
// - Two fields on one kind that mean one thing ("Store" and "Acquired from"):
//   keep one. Its partner's values move into it where it is empty, and the one
//   let go is hidden. Never merged on its own; undoable.
// - A seller noted beside where things came from often enough, or through
//   enough places, to be worth a field of its own: track sellers, or keep
//   them as notes (never asked again for that kind).
//
// Both answer through the platform's own actions, so the assistant reaches
// the same doors (platform:settle-same-meaning, platform:track-sellers).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useRunAction, useToast } from "@cobblr/platform-web";
import { api, type PlatformEntityKind } from "../lib/api";

type Undo = Array<{ action_id: string; args?: Record<string, unknown> }>;

export function FieldMeaningNotices({ slug, kinds }: { slug: string; kinds: PlatformEntityKind[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  // PRESS-ARGS: every press here carries the kind and the fields it names, and the undo steps carry their own.
  const run = useRunAction();
  const [params] = useSearchParams();
  const offerKind = params.get("kind");
  const nameOf = (kind: string) => {
    const k = kinds.find((x) => x.id === kind);
    return k ? (k.display_name_plural ?? k.display_name).toLowerCase() : "this kind";
  };

  const overlaps = useQuery({ queryKey: ["same-meaning", slug], queryFn: () => api.sameMeaningFields(slug), enabled: !!slug });
  const seller = useQuery({
    queryKey: ["seller-offer", slug, offerKind],
    queryFn: () => api.sellerOffer(slug, offerKind!),
    enabled: !!slug && !!offerKind,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["same-meaning", slug] });
    void qc.invalidateQueries({ queryKey: ["seller-offer", slug] });
    void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
    void qc.invalidateQueries({ queryKey: ["platform-field-defs", slug] });
  };

  const press = async (actionId: string, args: Record<string, unknown>) => {
    const out = await run({ actionId, entityKind: "", entityId: "", args }, { undo: "shown-here" });
    const r = out.result as { ok?: boolean; summary?: string; error?: string } | null;
    refresh();
    if (!r?.ok) {
      toast.error(r?.error ?? "That did not happen.");
      return;
    }
    const steps = (Array.isArray(out.undo) ? out.undo : out.undo ? [out.undo] : []) as Undo;
    if (steps.length === 0) {
      toast.success(r.summary ?? "Done.");
      return;
    }
    toast.action(r.summary ?? "Done.", {
      actionLabel: "Undo",
      onAction: async () => {
        for (const st of steps) await run({ actionId: st.action_id, entityKind: "", entityId: "", args: st.args ?? {} }, { undo: "is-undo" });
        refresh();
      },
    });
  };

  const groups = overlaps.data?.items ?? [];
  const offer = seller.data?.offer ?? null;
  if (groups.length === 0 && !offer) return null;

  return (
    <div className="space-y-3" data-testid="field-meaning-notices">
      {groups.map((g) => (
        <div key={`${g.entity_kind} ${g.role}`} className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-content dark:text-mortar-100">
          <p>
            On {nameOf(g.entity_kind)}, {g.fields.map((f) => `"${f.label}"`).join(" and ")} all mean {g.role_label.toLowerCase()}. Keep one: the
            other&apos;s values move into it where it is empty, and the other is hidden.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {g.fields.map((keep) => {
              const drop = g.fields.find((f) => f.name !== keep.name && f.source === "custom");
              if (!drop) return null;
              return (
                <button
                  key={keep.name}
                  type="button"
                  onClick={() => void press("platform:settle-same-meaning", { entity_kind: g.entity_kind, keep: keep.name, drop: drop.name })}
                  className="rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2.5 py-1 text-xs font-medium hover:border-accent"
                >
                  Keep {keep.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {offer && (
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 text-sm text-content dark:text-mortar-100" data-testid="seller-offer">
          <p>
            You buy from <strong>{offer.seller}</strong>{" "}
            {offer.places.length > 1 ? `through ${offer.places.join(" and ")}` : `${offer.times} times on ${offer.places[0]}`}. Track sellers as their own field on{" "}
            {nameOf(offer.entity_kind)}? Then everything from one seller is a filter, and every seller noted beside &quot;{offer.host.label}&quot; moves into it.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void press("platform:track-sellers", { entity_kind: offer.entity_kind })}
              className="rounded-md bg-cobble-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-cobble-500"
            >
              Track sellers
            </button>
            <button
              type="button"
              onClick={() => void press("platform:decline-seller-field", { entity_kind: offer.entity_kind })}
              className="rounded-md px-2.5 py-1 text-xs text-muted hover:text-content"
            >
              Keep them as notes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
