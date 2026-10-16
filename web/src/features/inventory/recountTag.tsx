// "Recount these…" over one group of a tag's page: a recount of everything in
// that collection carrying the tag (#6819), the same recount Cobb and the API
// start with { collection, tag }. Contributed by inventory through the
// tag-toolbar seam, so the tag page never names inventory.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ScanLine } from "lucide-react";
import { useRunAction, useToast, type TagToolbarCtx } from "@cobblr/platform-web";

export function RecountTagControl({ ctx }: { ctx: TagToolbarCtx }) {
  const navigate = useNavigate();
  const toast = useToast();
  // PRESS-ARGS: the group's collection and the tag the page is about are the whole scope.
  const runAction = useRunAction();
  const [busy, setBusy] = useState(false);
  const collection = ctx.collection ?? "inventory";
  const start = async () => {
    setBusy(true);
    try {
      const res = await runAction({ actionId: "inventory:start-recount", args: { scope: { collection, tag: ctx.tagName } } });
      const id = (res.result as { data?: { recount_id?: string } } | null)?.data?.recount_id;
      if (id) navigate(`${ctx.collection ? `/instances/${ctx.collection}` : "/inventory"}/recounts/${id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void start()}
      data-testid="recount-tag"
      title={`Scan in everything here tagged ${ctx.tagName}, then see what is missing or new`}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline disabled:opacity-60"
    >
      <ScanLine size={13} /> {busy ? "Starting…" : "Recount these…"}
    </button>
  );
}
