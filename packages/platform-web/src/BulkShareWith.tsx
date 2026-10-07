// "Share with…" in a list's selection bar: put the ticked things in a share
// with someone (docs/design-decisions/share-spaces.md §9). Shown only when
// this workspace shares its things with someone.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { countOf } from "@cobblr/platform-contract/plural";
import { usePlatformWeb } from "./context";
import { FooterActionPopover } from "./FooterActionPopover";
import { useRunAction } from "./run-action";
import { useToast } from "./ToastContext";

export function BulkShareWith({ kind, ids, noun = "thing", onDone }: { kind: string; ids: string[]; noun?: string; onDone?: () => void }) {
  const { api, orgSlug } = usePlatformWeb();
  // PRESS-ARGS: the panel names who (the one argument a person chooses); the kind and the ticked ids are the selection itself.
  const runAction = useRunAction();
  const toast = useToast();
  const shares = useQuery({ queryKey: ["record-shares", orgSlug], queryFn: () => api.recordShares!(orgSlug), enabled: !!api.recordShares, staleTime: 60_000 });
  const targets = shares.data?.targets ?? [];
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  if (targets.length === 0) return null;
  const chosen = to || targets[0]!.link_id;
  const who = targets.find((t) => t.link_id === chosen)?.to ?? "them";
  return (
    <FooterActionPopover label="Share with…" icon={<Share2 size={12} />} title="Share these with someone" width={320} data-testid="bulk-share-with">
      {(close) => (
        <div className="space-y-3 p-3">
          {targets.length > 1 && (
            <select aria-label="With" value={chosen} onChange={(e) => setTo(e.target.value)} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm text-content dark:border-slate-600">
              {targets.map((t) => (
                <option key={t.link_id} value={t.link_id}>
                  {t.to}
                </option>
              ))}
            </select>
          )}
          <p className="text-sm text-content">
            A copy of {countOf(ids.length, noun)} appears in {who}'s shared workspace and keeps in step with yours.
          </p>
          <button
            type="button"
            disabled={busy}
            data-testid="bulk-share-with-send"
            onClick={async () => {
              setBusy(true);
              try {
                const r = await runAction({ actionId: "platform:share-with", entityKind: kind, entityId: ids[0] ?? "", args: { entity_kind: kind, ids, with: chosen } });
                const res = r.result as { ok?: boolean; error?: string; summary?: string } | null;
                if (!res?.ok) throw new Error(res?.error ?? "That did not go through.");
                toast.success(res.summary ?? "Shared.");
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
            {busy ? "Sharing…" : `Share with ${who}`}
          </button>
        </div>
      )}
    </FooterActionPopover>
  );
}
