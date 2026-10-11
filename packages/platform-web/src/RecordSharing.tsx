import { RecordActionItem } from "./RecordActionContributions";
// Who a record is shared with, on its own page (docs/design-decisions/share-spaces.md §9).
//
// When this workspace shares its things with someone, a record says which
// shares hold it ("Shared with Vince", with Stop sharing). An owner or admin
// gets "Share…", the one share page (#5365) where someone new can be invited
// too; a member gets "Share with…" for the others. Both run the kernel's actions
// (platform:share-with / platform:stop-sharing), the same the assistant uses,
// and each undoes the other. Placed once by the platform, on every record.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { useFlowHost, usePlatformWeb } from "./context";
import { useRunAction } from "./run-action";
import { useToast } from "./ToastContext";

export function RecordSharing({ kind, id, className }: { kind: string; id: string; className?: string }) {
  const { api, orgSlug, role } = usePlatformWeb();
  const { openFlow } = useFlowHost();
  // PRESS-ARGS: who is the one argument a person chooses here; the kind and the id are the page's record.
  const runAction = useRunAction();
  const toast = useToast();
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ["record-shares", orgSlug, kind, id],
    queryFn: () => api.recordShares!(orgSlug, kind, id),
    enabled: !!api.recordShares,
    staleTime: 30_000,
  });
  const targets = q.data?.targets ?? [];
  const manager = roleSatisfies(role, ["owner", "admin"]) && q.data?.can_share === true;
  if (!targets.length && !manager) return null;
  const inIds = new Set((q.data?.shared_with ?? []).map((t) => t.link_id));
  const others = targets.filter((t) => !inIds.has(t.link_id));

  const run = async (actionId: "platform:share-with" | "platform:stop-sharing", linkId: string) => {
    setBusy(true);
    try {
      const r = await runAction({ actionId, entityKind: kind, entityId: id, args: { entity_kind: kind, ids: [id], with: linkId } }, { undo: "shown-here" });
      const res = r.result as { ok?: boolean; error?: string; summary?: string } | null;
      if (!res?.ok) throw new Error(res?.error ?? "That did not go through.");
      const back = actionId === "platform:share-with" ? "platform:stop-sharing" : "platform:share-with";
      toast.success(res.summary ?? "Done.", {
        actionLabel: "Undo",
        onAction: async () => {
          await runAction({ actionId: back, entityKind: kind, entityId: id, args: { entity_kind: kind, ids: [id], with: linkId } }, { undo: "is-undo" });
          await q.refetch();
        },
      });
      setChoosing(false);
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chip = "inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent dark:border-slate-600 disabled:opacity-50";
  return (
    <>
      {(q.data?.shared_with ?? []).map((t) => (
        <RecordActionItem key={t.link_id} id={`record:stop-sharing:${t.link_id}`} group="share" label={`Stop sharing with ${t.to}`} description="Remove this record from their share." badge={t.to}><span data-testid="record-shared-with" className={`order-last inline-flex items-center gap-1 rounded border border-line bg-subtle px-2 py-1 text-xs text-content dark:border-slate-600 ${className ?? ""}`}>
          <Share2 size={12} aria-hidden className="text-muted" />
          Shared with {t.to}
          <button type="button" disabled={busy} data-testid="record-stop-sharing" onClick={() => void run("platform:stop-sharing", t.link_id)} className="ml-1 text-muted underline-offset-2 hover:text-accent hover:underline">
            Stop
          </button>
        </span></RecordActionItem>
      ))}
      {manager &&
        <RecordActionItem id="record:share-with" group="share" label="Share…" description="Share this record with someone, or invite someone new by email."><button
            type="button"
            data-testid="record-share-with"
            onClick={() => openFlow("platform:share-list", { kind, ids: [id] })}
            className={`order-last ${chip} ${className ?? ""}`}
          >
            <Share2 size={12} aria-hidden />
            Share…
          </button></RecordActionItem>}
      {!manager && others.length > 0 &&
        <RecordActionItem id="record:share-with" group="share" label="Share with…" description="Choose someone who can see this record.">{(choosing && others.length > 1 ? (
          <span className={`order-last inline-flex flex-wrap items-center gap-1 ${className ?? ""}`}>
            {others.map((t) => (
              <button key={t.link_id} type="button" disabled={busy} data-testid="record-share-with-who" onClick={() => void run("platform:share-with", t.link_id)} className={chip}>
                {t.to}
              </button>
            ))}
          </span>
        ) : (
          <button
            type="button"
            disabled={busy}
            data-testid="record-share-with"
            onClick={() => (others.length === 1 ? void run("platform:share-with", others[0]!.link_id) : setChoosing(true))}
            className={`order-last ${chip} ${className ?? ""}`}
          >
            <Share2 size={12} aria-hidden />
            {others.length === 1 ? `Share with ${others[0]!.to}` : "Share with…"}
          </button>
        ))}</RecordActionItem>}
    </>
  );
}
