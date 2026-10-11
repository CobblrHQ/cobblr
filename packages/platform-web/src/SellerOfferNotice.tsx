// "You buy from Detroit Axle through eBay and Amazon. Track sellers as their
// own field?", on the record where the seller notes are written (#4518).
//
// Asked once per workspace and kind (the server keeps the answer, and tells
// the person once by notification the first time it is due); an owner's or an
// admin's question, since it reshapes the kind's fields. Yes and no go through
// the platform's own actions, so the assistant reaches the same doors.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { usePlatformWeb } from "./context";
import { useRunAction } from "./run-action";
import { useToast } from "./ToastContext";

export function SellerOfferNotice({ kind }: { kind: string }) {
  const { api, orgSlug, role } = usePlatformWeb();
  const qc = useQueryClient();
  const toast = useToast();
  // PRESS-ARGS: both answers take the kind alone, and the undo steps carry their own.
  const run = useRunAction();
  const mayAnswer = !!role && roleSatisfies(role, ["owner", "admin"]);
  const q = useQuery({
    queryKey: ["seller-offer", orgSlug, kind],
    queryFn: () => api.sellerOffer!(orgSlug, kind),
    enabled: mayAnswer && !!api.sellerOffer,
    staleTime: 10 * 60_000,
  });
  const offer = q.data?.offer ?? null;
  if (!offer) return null;

  const answer = async (actionId: string) => {
    const out = await run({ actionId, entityKind: "", entityId: "", args: { entity_kind: kind } }, { undo: "shown-here" });
    const r = out.result as { ok?: boolean; summary?: string; error?: string } | null;
    void qc.invalidateQueries({ queryKey: ["seller-offer", orgSlug] });
    void qc.invalidateQueries({ queryKey: ["platform-field-defs", orgSlug] });
    if (!r?.ok) return void toast.error(r?.error ?? "That did not happen.");
    const steps = (Array.isArray(out.undo) ? out.undo : out.undo ? [out.undo] : []) as Array<{ action_id: string; args?: Record<string, unknown> }>;
    if (!steps.length) return void toast.success(r.summary ?? "Done.");
    toast.action(r.summary ?? "Done.", {
      actionLabel: "Undo",
      onAction: async () => {
        for (const st of steps) await run({ actionId: st.action_id, entityKind: "", entityId: "", args: st.args ?? {} }, { undo: "is-undo" });
        void qc.invalidateQueries({ queryKey: ["platform-field-defs", orgSlug] });
        void qc.invalidateQueries({ queryKey: ["seller-offer", orgSlug] });
      },
    });
  };

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/60 px-3 py-2 text-xs text-content dark:text-mortar-100" data-testid="seller-offer">
      You buy from <strong>{offer.seller}</strong>{" "}
      {offer.places.length > 1 ? `through ${offer.places.join(" and ")}` : `${offer.times} times on ${offer.places[0]}`}. Track sellers as their own field, so
      everything from one seller is a filter?
      <span className="mt-1.5 flex flex-wrap gap-2">
        <button type="button" onClick={() => void answer("platform:track-sellers")} className="rounded-md bg-cobble-600 px-2.5 py-1 font-medium text-white hover:bg-cobble-500">
          Track sellers
        </button>
        <button type="button" onClick={() => void answer("platform:decline-seller-field")} className="rounded-md px-2.5 py-1 text-muted hover:text-content">
          Keep them as notes
        </button>
      </span>
    </div>
  );
}
