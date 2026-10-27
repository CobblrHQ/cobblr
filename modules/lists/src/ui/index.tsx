import { NumberStepper, subscribeWaitingWrites, editOf, fieldNeed, FieldPack, RecordFormModal, ContributedDetailPanels, CustomFieldsPanel, QueryError, useToast, useConfirm, usePageTitle, usePlatformWeb, useViewerRole } from "@cobblr/platform-web";
// lists UI — the host mounts <ListsUI /> at /lists. A grid of lists;
// clicking one opens a detail MODAL with check-off, add-item, and clear-done.
// Modals (not pages) for detail/create; toasts (not dialogs) for feedback;
// destructive deletes confirm via useConfirm. Matches house conventions.

import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { ListChecks, Plus, Trash2, X, RotateCcw, Hand, Pencil, ChevronDown } from "lucide-react";
import { ListsApi, type ListSummary, type ListItem, ListsApiError, lineQuantity, lineUnit, restockAmount, willDatePhrase } from "./api.js";
import { RunningLowOffer, useRunningLowKnown } from "./RunningLowOffer.js";
import { PickToLight } from "@cobblr/platform-web";


/** A line's small icon button: the icon's own size on a wide screen, a
 *  44 by 44 px target on a phone. In px, not rem: a finger stays the same
 *  size when the text is enlarged, and three rem targets ran past the edge. */
const LINE_TOOL = "inline-flex shrink-0 items-center justify-center rounded max-sm:h-[44px] max-sm:w-[44px]"
const restockLineKey = (it: ListItem) => JSON.stringify([it.qty, it.metadata?.source_ref?.kind, it.metadata?.source_ref?.id]);
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
  // A list's own address opens it: /lists/<id>, and /lists/items/<id> opens
  // the list that line is on. Search, a tag, a link Cobb gives and a shared
  // URL all arrive this way; the grid used to ignore the address and open
  // nothing. Opening a card writes the address, so it can be shared.
  const location = useLocation();
  const navigate = useNavigate();
  const itemInPath = /\/lists\/items\/([^/?#]+)/.exec(location.pathname)?.[1] ?? null;
  // "/lists/items" is the lines' collection, which is the lists themselves:
  // never a list called "items".
  const segment = /\/lists\/([^/?#]+)/.exec(location.pathname)?.[1] ?? null;
  const listInPath = itemInPath || segment === "items" ? null : segment;
  const lineHome = useQuery({
    queryKey: ["lists-item-home", orgSlug, itemInPath],
    queryFn: () => api.getItem(itemInPath!),
    enabled: !!itemInPath,
    retry: false,
  });
  const open = listInPath ?? lineHome.data?.list_id ?? null;
  const listsHome = location.pathname.replace(/\/lists(\/.*)?$/, "/lists");
  const setOpen = (id: string | null) => navigate(id ? `${listsHome}/${id}` : listsHome);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const lists = useQuery({
    queryKey: ["lists", orgSlug],
    queryFn: () => api.listLists(),
  });
  const offerKnown = useRunningLowKnown();

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
      <div className="flex flex-wrap gap-x-3 gap-y-2 items-baseline justify-between border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">lists</h1>
        <Link className="text-xs text-muted underline" to="/configuration/recently-deleted?kind=lists:list">Recently deleted</Link>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-cobble-600 text-white hover:bg-cobble-700"
        >
          <Plus size={14} /> New list
        </button>
      </div>

      {/* The offer above the lists answers on its own: drawn as it came, it
          pushed every list 114 px down under a finger (#7788). The lists wait
          for it and the page draws once. */}
      {lists.data && offerKnown && <RunningLowOffer lists={lists.data.items} />}
      {(lists.isLoading || (lists.data && !offerKnown)) && <div className="text-sm text-muted">Loading…</div>}
      {lists.isError && <QueryError what="your lists" onRetry={() => void lists.refetch()} />}
      {offerKnown && lists.data?.items.length === 0 && (
        <div className="text-sm text-muted italic">No lists yet. Create one - a shopping list, a to-do, a packing list.</div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {offerKnown && lists.data?.items.map((l) => (
          <ListCard key={l.id} list={l} onOpen={() => setOpen(l.id)} onDelete={async () => {
            if (await confirm({ title: `Delete "${l.title}"?`, message: "This removes the list and its items.", confirmLabel: "Delete", destructive: true })) {
              deleteList.mutate(l.id);
            }
          }} />
        ))}
      </div>

      {creating && (
        <RecordFormModal open onClose={() => setCreating(false)} title="New list">
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
        </RecordFormModal>
      )}

      {open && <ListDetailModal orgSlug={orgSlug} listId={open} focusItemId={itemInPath} api={api} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ListCard({ list, onOpen, onDelete }: { list: ListSummary; onOpen: () => void; onDelete: () => void }) {
  const canDelete = roleSatisfies(useViewerRole(), ["owner", "admin"]);
  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-3 hover:border-cobble-400 transition group">
      <div className="flex items-start justify-between">
        <button type="button" onClick={onOpen} className="text-left">
          <div className="font-medium text-content dark:text-mortar-100">{list.title}</div>
          <div className="text-xs text-muted mt-0.5">
            {list.open_count} open{list.done_count > 0 ? ` · ${list.done_count} done` : ""}
          </div>
        </button>
        {canDelete && <button title="Delete list" type="button" onClick={onDelete} className="text-slate-300 hover:text-red-500 hover-reveal transition" aria-label="Delete list">
          <Trash2 size={15} />
        </button>}
      </div>
    </div>
  );
}

function ListDetailModal({ listId, focusItemId, api, orgSlug, onClose }: { listId: string; focusItemId?: string | null; api: ListsApi; orgSlug: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  // A line's own fields (whatever a bundle or a person adds to list lines)
  // open under it; the line a link pointed at starts open. Offered only when
  // the kind has any, so a plain list stays one line per thing.
  const { api: platformApi } = usePlatformWeb();
  const itemFieldDefs = useQuery({
    queryKey: ["platform-field-defs", orgSlug, "lists:item"],
    queryFn: () => platformApi.listFieldDefs(orgSlug, "lists:item"),
    staleTime: 60_000,
  });
  const lineHasFields = (itemFieldDefs.data?.items.length ?? 0) > 0;
  const [expanded, setExpanded] = useState<string | null>(focusItemId ?? null);
  // A shared list is read by more than one person at once — someone claiming a
  // line in the store is only useful if the other phone sees it without a
  // manual reload. Polling only while the modal is open keeps that cheap.
  const detail = useQuery({
    queryKey: ["lists-detail", listId],
    queryFn: () => api.getList(listId),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const invalidate = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["lists-detail", listId] }),
    qc.invalidateQueries({ queryKey: ["lists"] }),
  ]);
  // Each item added is its own write, sent the moment it is typed: the box
  // clears at once for the next, and the item shows as waiting until it lands.
  // Offline the first add waits, and the form refused every later one while it
  // did, so only the first item of a basement list was kept (#8635). No
  // mutation scope: a scoped add waited in memory behind the first, never
  // reached the door that keeps it on the device, and a reload lost it (#8675).
  // A refused add puts its words back if the box is empty (#8570).
  const add = useMutation({
    mutationKey: ["lists-add", listId],
    mutationFn: ({ title }: { title: string; typed: string }) => api.addItem(listId, { title }),
    onSuccess: () => invalidate(),
    onError: (e, { typed }) => {
      setDraft((d) => (d.trim() ? d : typed));
      toast.error(e instanceof ListsApiError ? e.message : String(e));
    },
  });
  // What this page is adding, and what an earlier page added offline and left
  // waiting on the device: after a reload the list showed only what had landed
  // (#8675). One row each, until it lands.
  const addingHere = useMutationState({
    filters: { mutationKey: ["lists-add", listId], status: "pending" },
    select: (m) => (m.state.variables as { title: string } | undefined)?.title ?? "",
  });
  const keptAdds = useSyncExternalStore(subscribeWaitingWrites, () => JSON.stringify(api.keptAdds(listId)));
  const waitingAdds = [...(JSON.parse(keptAdds) as string[]), ...addingHere];
  const toggle = useMutation({
    mutationFn: ({ id, checked, quantity }: { id: string; checked: boolean; quantity?: number }) => api.toggleItem(id, checked, quantity),
    // Waits for the fresh list, so a line's box does not blink back to the old
    // answer between the save and the read.
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["lists-detail", listId] }), qc.invalidateQueries({ queryKey: ["lists"] })]),
    onError: (e) => toast.error(e instanceof ListsApiError ? e.message : String(e)),
  });
  // A box tapped again before its first tap has saved: what the person last
  // asked for is what shows, and the writes go one after another per line so
  // the server hears them in the order they were made (#7503). Reading the box
  // from the last fetch alone sent "checked" twice and kept the stock an undo
  // was meant to give back.
  const [wanted, setWanted] = useState<Record<string, boolean>>({});
  const lineQueue = useRef(new Map<string, Promise<unknown>>());
  const setChecked = (it: ListItem, checked: boolean, quantity?: number) => {
    setWanted((w) => ({ ...w, [it.id]: checked }));
    const run = (lineQueue.current.get(it.id) ?? Promise.resolve()).then(() =>
      toggle.mutateAsync({ id: it.id, checked, quantity }).then(
        () => undefined,
        () => undefined,
      ),
    );
    lineQueue.current.set(it.id, run);
    void run.then(() => {
      if (lineQueue.current.get(it.id) !== run) return;
      lineQueue.current.delete(it.id);
      setWanted((w) => {
        const { [it.id]: _gone, ...rest } = w;
        return rest;
      });
    });
  };
  const isChecked = (it: ListItem) => wanted[it.id] ?? it.checked;
  // The amount a line will restock when checked, per line, corrected here
  // before the check. Starts from the line's own quantity ("×3") when it has
  // one, else the wire's amount. Only lines that restock have an entry.
  const [amounts, setAmounts] = useState<Record<string, { value: number; forLine: string }>>({});
  // A saved quantity or destination replaces an earlier choice. Unchanged
  // polls and note-only edits must still keep what the shopper chose.
  useEffect(() => {
    if (!detail.data) return;
    const keys = new Map(detail.data.items.map((it) => [it.id, restockLineKey(it)]));
    setAmounts((previous) => {
      const kept = Object.entries(previous).filter(([id, choice]) => keys.get(id) === choice.forLine);
      return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept);
    });
  }, [detail.data?.items]);
  const amountFor = (it: ListItem): number | null => {
    const wired = restockAmount(it.on_check);
    if (wired == null) return null;
    const choice = amounts[it.id];
    return (choice?.forLine === restockLineKey(it) ? choice.value : null) ?? lineQuantity(it.qty) ?? wired;
  };
  const remove = useMutation({
    mutationFn: (id: string) => api.removeItem(id),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ListsApiError ? e.message : String(e)),
  });
  const claim = useMutation({
    mutationFn: ({ id, claimed }: { id: string; claimed: boolean }) => api.claimItem(id, claimed),
    onSuccess: invalidate,
    onError: (e) => {
      toast.error(e instanceof ListsApiError ? e.message : String(e));
      return invalidate();
    },
  });
  // A typo in the list's name or a line had no fix but deleting and typing it
  // again, which on a shared list also dropped who said they'd get it.
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (title: string) => api.updateList(listId, editOf(detail.data, { title })),
    onSuccess: () => { setRenaming(null); invalidate(); },
    onError: (e) => toast.error(e instanceof ListsApiError ? e.message : String(e)),
  });
  type LineEdit = { id: string; title: string; qty: string; note: string; opened: Record<string, unknown> };
  const [editing, setEditing] = useState<LineEdit | null>(null);
  const saveItem = useMutation({
    // Only what this correction changed, with what it was: a quantity another
    // shopper saved while this was open stands, or this save says it changed
    // (#7889, #7925).
    mutationFn: (e: LineEdit) => {
      const edit = editOf(e.opened, { title: e.title.trim(), qty: e.qty.trim(), note: e.note.trim() });
      return Object.keys(edit.body).length ? api.updateItem(e.id, edit) : Promise.resolve(null);
    },
    onSuccess: async () => { await invalidate(); setEditing(null); },
    onError: (e) => toast.error(e instanceof ListsApiError ? e.message : String(e)),
  });
  const setListField = useMutation({
    mutationFn: (m: Record<string, unknown>) => api.updateList(listId, editOf(detail.data, { metadata: m })),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ListsApiError ? e.message : String(e)),
  });
  const setItemField = useMutation({
    mutationFn: ({ id, m }: { id: string; m: Record<string, unknown> }) => api.updateItem(id, editOf(detail.data?.items.find((i) => i.id === id), { metadata: m })),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ListsApiError ? e.message : String(e)),
  });
  const clearDone = useMutation({
    mutationFn: () => api.clearDone(listId),
    onSuccess: (r) => { toast.success(`Cleared ${r.cleared} done`); invalidate(); },
    onError: (e) => toast.error(e instanceof ListsApiError ? e.message : String(e)),
  });

  const items = detail.data?.items ?? [];
  const doneCount = items.filter((i) => i.checked).length;

  return (
    <RecordFormModal open onClose={onClose} title={detail.data?.title ?? "List"}>
      <div className="space-y-3">
        {renaming === null ? (
          detail.data && (
            <div className="flex justify-end -mt-1">
              <button type="button" onClick={() => setRenaming(detail.data!.title)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent">
                <Pencil size={12} /> Rename list
              </button>
            </div>
          )
        ) : (
          <form
            className="flex gap-2"
            aria-label="Rename list"
            onSubmit={(e) => { e.preventDefault(); if (renaming.trim()) rename.mutate(renaming.trim()); }}
          >
            <input
              autoFocus
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              aria-label="List name"
              className="flex-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
            />
            <button type="button" onClick={() => setRenaming(null)} className="px-3 py-2 text-xs rounded text-muted hover:text-content">Cancel</button>
            <button type="submit" disabled={!renaming.trim() || rename.isPending} className="px-3 py-2 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Save</button>
          </form>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); if (!draft.trim()) return; add.mutate({ title: draft.trim(), typed: draft }); setDraft(""); }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add an item…"
            className="flex-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
          />
          <button type="submit" disabled={!draft.trim()} className="px-3 py-2 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Add</button>
        </form>

        {detail.isLoading && <div className="text-sm text-muted">Loading…</div>}
        {detail.isError && <QueryError what="this list" onRetry={() => void detail.refetch()} />}
        {items.length === 0 && waitingAdds.length === 0 && !detail.isLoading && !detail.isError && <div className="text-sm text-muted italic">Empty list.</div>}

        <PickToLight key={listId} lines={items.flatMap(it => it.metadata?.source_ref?.kind && it.metadata.source_ref.id ? [{ id: it.id, label: it.title, checked: it.checked, ref: { kind: it.metadata.source_ref.kind, id: it.metadata.source_ref.id } }] : [])} onCheck={id => toggle.mutateAsync({ id, checked: true, quantity: amountFor(items.find(it => it.id === id)!) ?? undefined })} />
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
          {items.map((it: ListItem) => editing?.id === it.id ? (
            <li key={it.id} className="px-3 py-2 text-sm">
              <form
                aria-label="Correct this line"
                className="space-y-2"
                onSubmit={(e) => { e.preventDefault(); if (editing.title.trim()) saveItem.mutate(editing); }}
              >
                <FieldPack items={[
                  {
                    need: fieldNeed("what_it_is", { control: "text", label: "What it is" }),
                    node: (
                      <input autoFocus aria-label="What it is" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} className="w-full min-w-0 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm" />
                    ),
                  },
                  {
                    need: fieldNeed("how_many", { control: "text", label: "How many" }),
                    node: (
                      <input aria-label="How many" value={editing.qty} onChange={(e) => setEditing({ ...editing, qty: e.target.value })} placeholder="how many" className="w-full min-w-0 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm" />
                    ),
                  },
                  {
                    need: fieldNeed("note", { control: "text", label: "Note", valueLength: editing.note.length }),
                    node: (
                      <input aria-label="Note" value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} placeholder="a note (the brand, the size)" className="w-full min-w-0 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm" />
                    ),
                  },
                ]} />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setEditing(null)} className="px-3 py-1.5 text-xs rounded text-muted hover:text-content">Cancel</button>
                  <button type="submit" disabled={!editing.title.trim() || saveItem.isPending} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Save</button>
                </div>
              </form>
            </li>
          ) : (
            <li key={it.id} className="px-3 py-2 text-sm group">
              <div className="flex items-center gap-[12px]">
              <input aria-label={it.title}
                type="checkbox"
                checked={isChecked(it)}
                onChange={() => setChecked(it, !isChecked(it), amountFor(it) ?? undefined)}
                className="h-4 w-4 accent-cobble-600"
              />
              <span className={`flex-1 min-w-0 ${isChecked(it) ? "line-through text-faint" : ""}`}>
                {it.title}
                {it.qty && <span className="text-xs text-muted ml-2">×{it.qty}</span>}
                {it.note && <span className="block text-xs text-muted">{it.note}</span>}
                {it.metadata?.source_ref?.kind && (
                  <span
                    className="ml-2 inline-flex items-center gap-0.5 rounded bg-emerald-50 dark:bg-emerald-900/30 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300 align-middle"
                    title="Auto-added from another record - checking off updates the source"
                  >
                    <RotateCcw size={10} /> {it.metadata.source_ref.kind.split(":")[0]}
                  </span>
                )}
                {it.claimed_by_name && !it.checked && (
                  <span
                    className="ml-2 inline-flex items-center gap-1 rounded bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 align-middle"
                    title={`${it.claimed_by_name} said they'd get this`}
                  >
                    <Hand size={10} /> {it.claimed_by_name}
                  </span>
                )}
              </span>
              {!it.checked && (!it.claimed_by || it.claimed_by_me === true) && (
                <button
                  type="button"
                  disabled={claim.isPending}
                  onClick={() => claim.mutate({ id: it.id, claimed: !it.claimed_by })}
                  className={`shrink-0 rounded px-2 py-0.5 text-[11px] transition ${
                    it.claimed_by
                      ? "text-muted hover:text-accent"
                      : "text-muted hover:text-accent hover-reveal"
                  }`}
                >
                  {it.claimed_by ? "Never mind" : "I'll get it"}
                </button>
              )}
              {/* Correct, its fields, and remove: small icons, each a finger's
                  target on a phone (44 by 44 px, side by side, never on top
                  of each other), so a tap meant for the pencil never lands on
                  remove (#6059). Held by the list walk's tapTargets check. */}
              <span data-line-tools className="flex shrink-0 items-center gap-[2px] max-sm:gap-[4px]">
                {!it.checked && (
                  <button
                    title="Correct this line"
                    type="button"
                    onClick={() => setEditing({ id: it.id, title: it.title, qty: it.qty ?? "", note: it.note ?? "", opened: { title: it.title, qty: it.qty ?? "", note: it.note ?? "" } })}
                    className={`${LINE_TOOL} text-muted dark:text-slate-400 hover:text-accent hover-reveal`}
                    aria-label="Correct this line"
                  >
                    <Pencil size={13} />
                  </button>
                )}
                {lineHasFields && (
                  <button
                    title={expanded === it.id ? "Hide this line's fields" : "Show this line's fields"}
                    type="button"
                    onClick={() => setExpanded((x) => (x === it.id ? null : it.id))}
                    className={`${LINE_TOOL} text-muted hover:text-accent`}
                    aria-label={expanded === it.id ? "Hide this line's fields" : "Show this line's fields"}
                    aria-expanded={expanded === it.id}
                  >
                    <ChevronDown size={14} className={expanded === it.id ? "rotate-180" : ""} />
                  </button>
                )}
                <button title="Remove item" type="button" onClick={() => remove.mutate(it.id)} className={`${LINE_TOOL} text-muted dark:text-slate-400 hover:text-red-500 hover-reveal`} aria-label="Remove item">
                  <X size={14} />
                </button>
              </span>
              </div>
              {/* What checking it off will DO, said before it happens, with the
                  amount correctable: the row used to restock silently, and by
                  an amount nobody could see or change (2026-09-12). The amount
                  comes from the wire the kernel says will fire; the person's
                  correction rides the check as `quantity`. Its own line under
                  the row, one sentence that wraps as a sentence: inside the
                  title's column a phone squeezed it a word wide, under the
                  claim button (#6102). */}
              {!it.checked && amountFor(it) != null && (
                <div data-restock-preview className="mt-1 pl-7 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted" title="Checking this off adds to the record it came from">
                  <NumberStepper
                    className="inline-flex shrink-0 items-center rounded border border-line dark:border-slate-700"
                    value={amountFor(it)!}
                    min={Math.min(1, amountFor(it)!)}
                    decimal
                    suffix={lineUnit(it.qty) ?? undefined}
                    label="Amount to add to stock"
                    decreaseLabel="One fewer"
                    increaseLabel="One more"
                    icons
                    iconSize={10}
                    prefix="+"
                    buttonClassName="px-1 py-0.5 hover:text-content disabled:opacity-40"
                    inputClassName="w-7 bg-transparent px-1 text-center font-medium tabular-nums text-content dark:text-mortar-100"
                    onChange={(n) => setAmounts((a) => ({ ...a, [it.id]: { value: n, forLine: restockLineKey(it) } }))}
                  />
                  <span>
                    to stock when checked
                    {willDatePhrase(it.will_date) && <span className="text-faint"> · {willDatePhrase(it.will_date)}</span>}
                  </span>
                </div>
              )}
              {expanded === it.id && (
                <CustomFieldsPanel
                  className="mt-2 pl-7"
                  entityKind="lists:item"
                  entityId={it.id}
                  values={it.metadata ?? {}}
                  onCommit={(name, value) => setItemField.mutate({ id: it.id, m: { [name]: value } })}
                />
              )}
            </li>
          ))}
          {waitingAdds.map((title, i) => (
            <li key={`waiting-${i}`} data-waiting-add="" className="flex items-center gap-[12px] px-3 py-2 text-sm text-muted dark:text-slate-400">
              <span className="min-w-0 flex-1">{title}</span>
              <span className="shrink-0 text-xs">waiting to send</span>
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

        {/* The list's own fields, as a bundle or a person defines them. */}
        <CustomFieldsPanel
          entityKind="lists:list"
          entityId={listId}
          values={detail.data?.metadata ?? {}}
          onCommit={(name, value) => setListField.mutate({ [name]: value })}
        />

        {/* Tags and discussion, contributed at every kind. A shared list is
            read by several people, so it is exactly the sort of record that
            gets talked about. */}
        <ContributedDetailPanels
          target="lists:list"
          ctx={{ slug: orgSlug, entityId: listId, entityTitle: detail.data?.title ?? "List" }}
        />
      </div>
    </RecordFormModal>
  );
}

export default ListsUI;
