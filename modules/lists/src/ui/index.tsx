// lists UI — the host mounts <ListsUI /> at /lists. A grid of lists;
// clicking one opens a detail MODAL with check-off, add-item, and clear-done.
// Modals (not pages) for detail/create; toasts (not dialogs) for feedback;
// destructive deletes confirm via useConfirm. Matches house conventions.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { ListChecks, Plus, Trash2, X, RotateCcw } from "lucide-react";
import { ListsApi, type ListSummary, type ListItem, ListsApiError } from "./api.js";

export const navItems = [{ label: "Lists", path: "/lists", icon: ListChecks }];

interface Props {
  orgSlug: string;
  getToken: () => string | null;
}

export function ListsUI({ orgSlug, getToken }: Props) {
  usePageTitle("Lists");
  const api = new ListsApi(orgSlug, getToken);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState<string | null>(null); // open list id
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const lists = useQuery({
    queryKey: ["lists", orgSlug],
    queryFn: () => api.listLists(),
  });

  const createList = useMutation({
    mutationFn: (title: string) => api.createList({ title }),
    onSuccess: () => {
      toast.success("List created");
      setCreating(false);
      setNewTitle("");
      void qc.invalidateQueries({ queryKey: ["lists", orgSlug] });
    },
    onError: (e) => toast.error(e instanceof ListsApiError ? e.message : String(e)),
  });

  const deleteList = useMutation({
    mutationFn: (id: string) => api.deleteList(id),
    onSuccess: () => {
      toast.success("List deleted");
      void qc.invalidateQueries({ queryKey: ["lists", orgSlug] });
    },
    onError: (e) => toast.error(e instanceof ListsApiError ? e.message : String(e)),
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-baseline justify-between border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">lists</h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-cobble-600 text-white hover:bg-cobble-700"
        >
          <Plus size={14} /> New list
        </button>
      </div>

      {lists.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {lists.data?.items.length === 0 && (
        <div className="text-sm text-muted italic">No lists yet. Create one — a shopping list, a to-do, a packing list.</div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {lists.data?.items.map((l) => (
          <ListCard key={l.id} list={l} onOpen={() => setOpen(l.id)} onDelete={async () => {
            if (await confirm({ title: `Delete "${l.title}"?`, message: "This removes the list and its items.", confirmLabel: "Delete", destructive: true })) {
              deleteList.mutate(l.id);
            }
          }} />
        ))}
      </div>

      {creating && (
        <Modal open onClose={() => setCreating(false)} title="New list">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (newTitle.trim()) createList.mutate(newTitle.trim());
            }}
          >
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Shopping list"
              className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className="px-3 py-1.5 text-xs rounded bg-subtle dark:bg-slate-800">Cancel</button>
              <button type="submit" disabled={!newTitle.trim() || createList.isPending} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Create</button>
            </div>
          </form>
        </Modal>
      )}

      {open && <ListDetailModal listId={open} api={api} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ListCard({ list, onOpen, onDelete }: { list: ListSummary; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-3 hover:border-cobble-400 transition group">
      <div className="flex items-start justify-between">
        <button type="button" onClick={onOpen} className="text-left">
          <div className="font-medium text-content dark:text-mortar-100">{list.title}</div>
          <div className="text-xs text-muted mt-0.5">
            {list.open_count} open{list.done_count > 0 ? ` · ${list.done_count} done` : ""}
          </div>
        </button>
        <button type="button" onClick={onDelete} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition" aria-label="Delete list">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

function ListDetailModal({ listId, api, onClose }: { listId: string; api: ListsApi; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const detail = useQuery({ queryKey: ["lists-detail", listId], queryFn: () => api.getList(listId) });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["lists-detail", listId] });
    void qc.invalidateQueries({ queryKey: ["lists"] }); // refresh counts on the grid
  };
  const add = useMutation({
    mutationFn: (title: string) => api.addItem(listId, { title }),
    onSuccess: () => { setDraft(""); invalidate(); },
    onError: (e) => toast.error(e instanceof ListsApiError ? e.message : String(e)),
  });
  const toggle = useMutation({
    mutationFn: ({ id, checked }: { id: string; checked: boolean }) => api.toggleItem(id, checked),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.removeItem(id), onSuccess: invalidate });
  const clearDone = useMutation({
    mutationFn: () => api.clearDone(listId),
    onSuccess: (r) => { toast.success(`Cleared ${r.cleared} done`); invalidate(); },
  });

  const items = detail.data?.items ?? [];
  const doneCount = items.filter((i) => i.checked).length;

  return (
    <Modal open onClose={onClose} title={detail.data?.title ?? "List"} size="md">
      <div className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); if (draft.trim()) add.mutate(draft.trim()); }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add an item…"
            className="flex-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
          />
          <button type="submit" disabled={!draft.trim() || add.isPending} className="px-3 py-2 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Add</button>
        </form>

        {detail.isLoading && <div className="text-sm text-muted">Loading…</div>}
        {items.length === 0 && !detail.isLoading && <div className="text-sm text-muted italic">Empty list.</div>}

        <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
          {items.map((it: ListItem) => (
            <li key={it.id} className="flex items-center gap-3 px-3 py-2 text-sm group">
              <input
                type="checkbox"
                checked={it.checked}
                onChange={() => toggle.mutate({ id: it.id, checked: !it.checked })}
                className="h-4 w-4 accent-cobble-600"
              />
              <span className={`flex-1 ${it.checked ? "line-through text-faint" : ""}`}>
                {it.title}
                {it.qty && <span className="text-xs text-muted ml-2">×{it.qty}</span>}
                {it.metadata?.source_ref?.kind === "inventory:part" && (
                  <span
                    className="ml-2 inline-flex items-center gap-0.5 rounded bg-emerald-50 dark:bg-emerald-900/30 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300 align-middle"
                    title="Auto-added from inventory — checking off restocks it"
                  >
                    <RotateCcw size={10} /> inventory
                  </span>
                )}
              </span>
              <button type="button" onClick={() => remove.mutate(it.id)} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100" aria-label="Remove item">
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>

        {doneCount > 0 && (
          <div className="flex justify-end">
            <button type="button" onClick={() => clearDone.mutate()} className="text-xs text-muted hover:text-accent">
              Clear {doneCount} done
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default ListsUI;
