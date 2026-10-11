import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useRunAction, useToast } from "@cobblr/platform-web";
import type { TidyCandidate } from "@cobblr/platform-contract";
import { api } from "../lib/api";
import { useBundleDetail } from "./useBundleDetail";

export function TidySuggestionCard({ slug, suggestion }: { slug: string; suggestion: { id: string; candidate: TidyCandidate } }) {
  const { id, candidate: c } = suggestion;
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  // PRESS-ARGS: the reviewed candidate carries the writer action and all its arguments; Undo returns its complete inverse.
  const run = useRunAction();
  const bundleDetail = useBundleDetail(slug);
  const toast = useToast(), navigate = useNavigate(), qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["attention", slug] });
  const decide = async (decision: "later" | "never" | "done") => {
    setBusy(true);
    try { await api.decideTidySuggestion(slug, id, decision); await refresh(); }
    catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  };
  const hasAction = !!c.action.action_id || !!c.action.steps?.length;
  const apply = async () => {
    if (!hasAction) { if (c.action.bundle_id) bundleDetail.open(c.action.bundle_id); else navigate(c.action.route); return; }
    setBusy(true);
    const undo: Array<{ action_id: string; args?: Record<string, unknown> }> = [];
    try {
      const steps = c.action.steps ?? [{ action_id: c.action.action_id!, args: c.action.args ?? {} }];
      for (const step of steps) {
        const result = await run({ actionId: step.action_id, args: step.args }, { undo: "shown-here" });
        undo.unshift(...((Array.isArray(result.undo) ? result.undo : result.undo ? [result.undo] : []) as typeof undo));
      }
      await api.decideTidySuggestion(slug, id, "done");
      await refresh();
      if (undo.length) toast.action("Moved the things you reviewed.", { actionLabel: "Undo", duration: 8000, onAction: async () => { for (const step of undo) await run({ actionId: step.action_id, args: step.args ?? {} }, { undo: "is-undo" }); await refresh(); } });
      else toast.success("Done.");
    } catch (err) {
      try { for (const step of undo) await run({ actionId: step.action_id, args: step.args ?? {} }, { undo: "is-undo" }); }
      catch (rollback) { toast.error(`Some moves could not be undone: ${(rollback as Error).message}`); }
      toast.error((err as Error).message);
    }
    finally { setBusy(false); }
  };
  return <li className="rounded-xl border border-line bg-surface p-3 space-y-2">
    <p className="text-sm font-medium">{c.why}</p>
    <div className="flex flex-wrap gap-2 text-xs">
      <button type="button" disabled={busy} onClick={() => setOpen(!open)} className="rounded-md border border-line px-3 py-1.5">Do it</button>
      <button type="button" disabled={busy} onClick={() => void decide("later")} className="rounded-md border border-line px-3 py-1.5">Not now</button>
      <button type="button" disabled={busy} onClick={() => void decide("never")} className="rounded-md border border-line px-3 py-1.5">Never suggest this</button>
    </div>
    {open && <div className="space-y-2">
      <p className="text-xs text-faint">{hasAction ? "Review these things before moving them." : "Review the things this suggestion concerns."}</p>
      <ul className="max-h-64 overflow-y-auto text-sm list-disc pl-5">{c.records.map((r) => <li key={`${r.kind}:${r.id}`}>{r.url ? <Link to={r.url} className="underline">{r.name}</Link> : r.name}</li>)}</ul>
      <div className="flex flex-wrap gap-3 items-center"><button type="button" disabled={busy} onClick={() => void apply()} className="rounded-md bg-cobble-600 text-white px-3 py-1.5 text-sm">{hasAction ? "Move all" : "Open"}</button>{!c.action.bundle_id && <Link to={c.action.route} className="text-xs underline">Open collection</Link>}</div>
    </div>}
    {bundleDetail.element}
  </li>;
}
