import { RecordActionItem } from "./RecordActionContributions";
// "Send back to <them>": a thing taken from someone through a share, on its
// own page while it can still go back (#4684, docs/design-decisions/share-spaces.md §6).
// The hand-over is one thing with one owner, so the way back is the
// receiver's Send back, which returns it on both sides at once; it used to be
// only in Settings, Sharing. Nothing when the record was not handed over.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { usePlatformWeb } from "./context";
import { useConfirm } from "./ConfirmContext";
import { useToast } from "./ToastContext";

export function RecordSendBack({ kind, id }: { kind: string; id: string }) {
  const { api, orgSlug } = usePlatformWeb();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ["received-from", orgSlug, kind, id],
    queryFn: () => api.receivedFrom!(orgSlug, kind, id),
    enabled: !!api.receivedFrom && !!api.sendBackShareOffer && !!orgSlug,
    staleTime: 60_000,
  });
  const got = q.data?.received;
  if (!got) return null;
  const who = got.from ?? "them";
  const send = async () => {
    if (!(await confirm({ title: `Send it back to ${who}?`, message: `It goes back to ${who}, and leaves your things here.`, confirmLabel: "Send back" }))) return;
    setBusy(true);
    try {
      await api.sendBackShareOffer!(orgSlug, got.offer_id);
      toast.success(`Sent back to ${who}.`);
      await q.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <RecordActionItem id="record:send-back" group="share" label={`Send back to ${who}`} description="Return this thing to the person who gave it to you."><button
      type="button"
      disabled={busy}
      onClick={() => void send()}
      data-testid="record-send-back"
      title={`Taken from ${who}; it can go back until ${new Date(got.until).toLocaleDateString()}`}
      className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent disabled:opacity-50 dark:border-slate-600"
    >
      <Undo2 size={12} aria-hidden /> Send back to {who}
    </button></RecordActionItem>
  );
}
