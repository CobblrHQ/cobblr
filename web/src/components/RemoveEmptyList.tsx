// A list made from a module, with nothing filed in it yet, can be taken away
// from its own page. Asking Cobb to "create Mugs and file these" makes one in
// a sentence (#4574); one made by mistake, or emptied, goes the same way it
// came: one press, and Undo makes it again. A list that holds anything is
// never offered this, since removing it would take the records too.

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useRunAction, useToast } from "@cobblr/platform-web";
import type { ModuleInstance } from "../lib/api";

type Undo = Array<{ action_id: string; args?: Record<string, unknown> }>;

export function RemoveEmptyList({ slug, inst }: { slug: string; inst: ModuleInstance }) {
  // Only a list made from a module, known to hold nothing, gets the offer; a
  // count the module could not give is not "empty".
  if (inst.is_default || inst.item_count !== 0) return null;
  return <RemoveStrip slug={slug} inst={inst} />;
}

function RemoveStrip({ slug, inst }: { slug: string; inst: ModuleInstance }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  // PRESS-ARGS: the one press carries the list by its short name, the only argument remove-list takes; its undo steps carry their own.
  const run = useRunAction();
  const name = inst.display_name || inst.instance_name;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["instances", slug] });
    void qc.invalidateQueries({ queryKey: ["nav-modules", slug] });
  };
  const remove = async () => {
    const out = await run({ actionId: "platform:remove-list", entityKind: "", entityId: "", args: { list: inst.instance_name } });
    const r = out.result as { ok?: boolean; summary?: string; error?: string } | null;
    refresh();
    if (!r?.ok) {
      toast.error(r?.error ?? "The list was not removed.");
      return;
    }
    const steps = (Array.isArray(out.undo) ? out.undo : out.undo ? [out.undo] : []) as Undo;
    navigate("/");
    toast.action(r.summary ?? `Removed the ${name} list.`, {
      actionLabel: "Undo",
      onAction: async () => {
        for (const st of steps) await run({ actionId: st.action_id, entityKind: "", entityId: "", args: st.args ?? {} });
        refresh();
      },
    });
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-2 text-xs text-muted dark:text-slate-400"
      data-testid="remove-empty-list"
    >
      <span>Nothing is filed in {name} yet.</span>
      <button
        type="button"
        onClick={() => void remove()}
        className="rounded-md border border-line dark:border-slate-600 px-2 py-0.5 font-medium text-content dark:text-mortar-200 hover:border-accent hover:text-accent transition"
      >
        Remove this list
      </button>
    </div>
  );
}
