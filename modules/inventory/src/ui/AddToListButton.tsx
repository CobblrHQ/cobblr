// "Add to list" beside a part's low badge.
//
// Low stock reached a shopping list only through a bundle's wire. Here it is
// one tap: onto the list this thing last went on, or, the first time, a choice
// of list (or a new one). It is the Lists module's own action
// (lists:add-item), so the button shows only where that action exists, which
// is where Lists is on; nothing is added until someone presses it.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListPlus } from "lucide-react";
import { Modal, undoStepsOf, usePlatformWeb, useRunAction, useToast } from "@cobblr/platform-web";

const ADD_ITEM = "lists:add-item";

type AddResult = { ok?: boolean; added?: boolean; skipped?: boolean; needs_list?: boolean; lists?: Array<{ id: string; title: string }>; summary?: string; error?: string };

export function AddToListButton({ kind, id, compact }: { kind: string; id: string; compact?: boolean }) {
  const { api, orgSlug } = usePlatformWeb();
  // PRESS-ARGS: add-item takes its title from the record; with no list it uses the one this record last went on, or answers needs_list and the button asks which.
  const runAction = useRunAction();
  const toast = useToast();
  const [choices, setChoices] = useState<Array<{ id: string; title: string }> | null>(null);
  const [newList, setNewList] = useState("");
  const [busy, setBusy] = useState(false);
  const actions = useQuery({ queryKey: ["actions-for-kind", orgSlug, kind], queryFn: () => api.listActions(orgSlug, kind), staleTime: 60_000 });
  const available = (actions.data?.items ?? []).some((a) => a.id === ADD_ITEM);
  if (!available) return null;

  async function add(args: Record<string, unknown>) {
    setBusy(true);
    try {
      const run = await runAction({ actionId: ADD_ITEM, entityKind: kind, entityId: id, args });
      const r = (run.result ?? {}) as AddResult;
      if (r.needs_list) {
        setChoices(r.lists ?? []);
        return;
      }
      setChoices(null);
      if (r.ok === false) toast.info(r.error ?? "Not added.");
      // The door already said it, with its Undo, when the action gave one.
      else if (!undoStepsOf(run.undo).length) toast.success(r.summary ?? "Added to the list.");
    } catch (e) {
      // A refusal carries the handler's answer (the host's invokeAction):
      // "which list?" comes back that way, with the lists to choose from.
      const r = (e as { result?: AddResult } | null)?.result;
      if (r?.needs_list) {
        setChoices(r.lists ?? []);
        return;
      }
      if ((e as { declined?: boolean } | null)?.declined) toast.info(e instanceof Error ? e.message : "Not added.");
      else toast.error(e instanceof Error ? e.message : "Couldn't add it to a list.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          void add({});
        }}
        className={`inline-flex items-center gap-1 rounded border border-line dark:border-slate-600 text-[10px] text-content dark:text-mortar-100 hover:border-accent disabled:opacity-50 ${compact ? "px-1 py-0.5" : "px-1.5 py-0.5"}`}
        aria-label="Add to list"
        title="Add to a shopping list"
      >
        <ListPlus size={11} /> {compact ? null : "Add to list"}
      </button>
      {choices && (
        <Modal open onClose={() => setChoices(null)} title="Which list?" size="sm">
          <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
            {choices.map((l) => (
              <button key={l.id} type="button" disabled={busy} onClick={() => void add({ listId: l.id })} className="w-full text-left rounded border border-line dark:border-slate-700 px-3 py-2 text-sm hover:border-accent">
                {l.title}
              </button>
            ))}
            <form
              className="flex gap-2 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (newList.trim()) void add({ listTitle: newList.trim() });
              }}
            >
              <input aria-label="New list" value={newList} onChange={(e) => setNewList(e.target.value)} placeholder={choices.length ? "or a new list" : "Shopping list"} className="input flex-1" />
              <button type="submit" disabled={busy || !newList.trim()} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">
                Add
              </button>
            </form>
          </div>
        </Modal>
      )}
    </>
  );
}
