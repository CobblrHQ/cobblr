// "Give to…" in a list's selection bar: offer the ticked things to someone a
// share links this workspace to (docs/design-decisions/share-spaces.md §6).
// Shown only when there is someone to give to.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { countOf } from "@cobblr/platform-contract";
import { usePlatformWeb } from "./context";
import { FooterActionPopover } from "./FooterActionPopover";
import { useRunAction } from "./run-action";
import { useToast } from "./ToastContext";

export function BulkGiveTo({ kind, ids, noun = "thing", onDone }: { kind: string; ids: string[]; noun?: string; onDone?: () => void }) {
  const { api, orgSlug } = usePlatformWeb();
  // PRESS-ARGS: the panel names who (the one argument a person chooses); the kind and the ticked ids are the selection itself.
  const runAction = useRunAction();
  const toast = useToast();
  const shares = useQuery({ queryKey: ["share-offers", orgSlug], queryFn: () => api.listShareOffers!(orgSlug), enabled: !!api.listShareOffers, staleTime: 60_000 });
  const targets = shares.data?.targets ?? [];
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  if (targets.length === 0) return null;
  const chosen = to || targets[0]!.link_id;
  const who = targets.find((t) => t.link_id === chosen)?.to ?? "them";
  return (
    <FooterActionPopover label="Give to…" icon={<Gift size={12} />} title="Offer these to someone you share with" width={320} data-testid="bulk-give-to">
      {(close) => (
        <div className="space-y-3 p-3">
          {targets.length > 1 && (
            <select aria-label="To" value={chosen} onChange={(e) => setTo(e.target.value)} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm text-content dark:border-slate-600">
              {targets.map((t) => (
                <option key={t.link_id} value={t.link_id}>
                  {t.to}
                </option>
              ))}
            </select>
          )}
          <p className="text-sm text-content">
            {countOf(ids.length, noun)} arrive in {who}'s scan inbox. Each they take is marked given away to them here.
          </p>
          <button
            type="button"
            disabled={busy}
            data-testid="bulk-give-to-send"
            onClick={async () => {
              setBusy(true);
              try {
                const r = await runAction({ actionId: "platform:offer-to", entityKind: kind, entityId: ids[0] ?? "", args: { entity_kind: kind, ids, to: chosen } });
                const res = r.result as { ok?: boolean; error?: string; summary?: string } | null;
                if (!res?.ok) throw new Error(res?.error ?? "That did not go through.");
                toast.success(res.summary ?? "Offered.");
                close();
                onDone?.();
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            className="w-full rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? "Offering…" : `Offer to ${who}`}
          </button>
        </div>
      )}
    </FooterActionPopover>
  );
}
