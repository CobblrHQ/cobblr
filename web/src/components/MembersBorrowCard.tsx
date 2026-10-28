import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { runUndoSteps, undoStepsOf, useRunAction, useToast } from "@cobblr/platform-web";

/** The one-time question to an older workspace's owner: may members lend and return things? */
export function MembersBorrowCard({ slug, label }: { slug: string; label: string }) {
  const [busy, setBusy] = useState(false);
  // PRESS-ARGS: the press carries the one argument the action needs (on), and Undo returns the setting.
  const run = useRunAction();
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["attention", slug] });
  const answer = async (on: boolean) => {
    setBusy(true);
    try {
      const result = await run({ actionId: "platform:set-members-may-lend", args: { on } }, { undo: "shown-here" });
      await refresh();
      if (on) toast.action("Members can now lend and return things.", { actionLabel: "Undo", duration: 8000, onAction: async () => { await runUndoSteps((b) => run(b, { undo: "is-undo" }), undoStepsOf(result.undo)); await refresh(); } });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li data-testid="members-borrow-card" className="rounded-xl border border-line bg-surface p-3 space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-faint">Members can already take and put back stock. This lets them check a tool out and take it back; you can change it later in Members &amp; invites.</p>
      <div className="flex flex-wrap gap-2 text-xs">
        <button type="button" disabled={busy} onClick={() => void answer(true)} className="rounded-md bg-cobble-600 text-white px-3 py-1.5">Allow</button>
        <button type="button" disabled={busy} onClick={() => void answer(false)} className="rounded-md border border-line px-3 py-1.5">Keep it to people I grant</button>
      </div>
    </li>
  );
}
