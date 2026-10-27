import { useCan } from "../lib/can";
import { fieldNeed, FieldPack, RecordFormModal, DragInput, SearchInput, useToast, useConfirm, usePageTitle, editOf } from "@cobblr/platform-web";
// /tags — list every tag the workspace has, what each is attached
// to, and a quick "new tag" affordance. The attach-to-entity UX
// happens module-side (Files page, parts page, etc.) — this page
// is just the registry + delete.

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Pin, Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { ApiError, api, type TagRecord } from "../lib/api";
import { useHideEmpty } from "../lib/useHideEmpty";
import { EditTagModal } from "../components/EditTagModal";
import { useActiveOrg } from "../auth/ActiveOrgContext";



// A pill's buttons are 12 px icons. On a phone that was the whole tap target,
// three of them side by side on every tag; they get a finger's room there and
// stay compact where a pointer can aim.
const PILL_BUTTON = "inline-flex items-center justify-center w-8 h-8 -my-1.5 sm:w-5 sm:h-5 sm:my-0 rounded-full transition";

// One tag rendered as a pill — its emoji icon (or the default tag glyph), name
// (click to see what's tagged), edit + delete.
function TagPillRow({
  t,
  onEdit,
  onDelete,
  onTogglePin,
  path,
}: {
  t: TagRecord;
  /** The tag's parents, shown when a search lifts it out of its tree. */
  path?: string;
  onEdit: () => void;
  onDelete?: () => void;
  onTogglePin: () => void;
}) {
  // Wraps inside the screen's width: one row of name, count, pin, edit and
  // delete ran 40 px past a phone at 200% text and took Delete with it (#6881).
  return (
    <span
      className="inline-flex flex-wrap max-w-full items-center gap-x-2 gap-y-1 px-3 py-1.5 rounded-2xl text-sm border"
      style={{
        borderColor: t.color ?? undefined,
        background: t.color ? `${t.color}22` : undefined,
      }}
    >
      {t.icon ? (
        <span className="leading-none">{t.icon}</span>
      ) : (
        <TagIcon size={12} style={{ color: t.color ?? undefined }} />
      )}
      <Link to={`/tags/${t.id}`} className="min-w-0 [overflow-wrap:anywhere] hover:underline focus:outline-none" title={`Show what's tagged "${t.name}"`}>
        {path && <span className="text-faint">{path} › </span>}
        {t.name}
      </Link>
      {/* How much it is used, so a tidy-up can start from the tags nothing
          carries and a merge can tell which name is the one people use. */}
      <span className="text-xs text-muted dark:text-slate-400 tabular-nums" title={`On ${t.uses ?? 0} ${(t.uses ?? 0) === 1 ? "thing" : "things"}`}>
        {t.uses ?? 0}
      </span>
      {/* The escape hatch for the automatic ordering. A pinned tag stays at
          the front of every chip row and never folds behind "+N", however long
          ago it was last used — so a rule that reads a workspace wrongly is
          always overridable by the person who knows better. */}
      <button
        onClick={onTogglePin}
        className={
          PILL_BUTTON + " " +
          (t.pinned ? "text-amber-500" : "text-faint hover:text-accent")
        }
        title={
          t.pinned
            ? "Pinned: always shown first. Click to unpin."
            : "Pin: keep this tag at the front and never fold it away"
        }
        aria-pressed={!!t.pinned}
        aria-label={t.pinned ? `Unpin ${t.name}` : `Pin ${t.name}`}
      >
        <Pin size={12} />
      </button>
      <button onClick={onEdit} className={`${PILL_BUTTON} text-faint hover:text-accent`} title="Edit" aria-label={`Edit ${t.name}`}>
        <Pencil size={12} />
      </button>
      {onDelete && <button onClick={onDelete} className={`${PILL_BUTTON} text-faint hover:text-ember-500`} title="Delete" aria-label={`Delete ${t.name}`}>
        <Trash2 size={12} />
      </button>}
    </span>
  );
}

// Every descendant id of a tag — excluded from its own parent options so you
// can't create a loop (the API guards this too).

export function TagsPage() {
  usePageTitle("Tags");
  const { activeSlug } = useActiveOrg();
  const mayMerge = !!useCan("core-tags:merge");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<TagRecord | null>(null);
  const [find, setFind] = useState("");
  const [hideEmpty, setHideEmpty] = useHideEmpty("tags");

  const list = useQuery({
    queryKey: ["tags", activeSlug],
    queryFn: () => api.listTags(activeSlug),
    enabled: !!activeSlug,
  });

  const canDelete = useCan("core-tags:delete-tag");
  const del = useMutation({
    mutationFn: (id: string) => api.deleteTag(activeSlug, id),
    onSuccess: (gone, id) => {
      const refresh = () => {
        void qc.invalidateQueries({ queryKey: ["tags", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["tag-attachments"] });
      };
      refresh();
      toast.action(`Deleted the tag ${gone.name}.`, {
        actionLabel: "Undo",
        onAction: async () => {
          try {
            const back = await api.restoreTag(activeSlug, id);
            refresh();
            toast.success(`Put ${back.name} back on ${back.assignments} ${back.assignments === 1 ? "record" : "records"}.`);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        },
      });
    },
    // A member refused opens the blocked-action sheet by itself (api.ts).
    onError: (e: unknown) => {
      if (e instanceof ApiError && e.blocked) return;
      toast.error(`Couldn't delete that tag: ${e instanceof ApiError ? e.message : String(e)}`);
    },
  });

  const pin = useMutation({
    mutationFn: (t: TagRecord) => api.updateTag(activeSlug, t.id, editOf(t, { pinned: !t.pinned })),
    onSuccess: (_r, t) => {
      toast.success(t.pinned ? `Unpinned ${t.name}` : `Pinned ${t.name}`);
      void qc.invalidateQueries({ queryKey: ["tags", activeSlug] });
      // Every chip row shows ranked tags, so a pin changes them all.
      void qc.invalidateQueries({ queryKey: ["tag-attachments"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const allItems = list.data?.items ?? [];
  const items = hideEmpty ? allItems.filter((t) => (t.uses ?? 0) > 0) : allItems;
  const hiddenCount = allItems.length - items.length;

  // Group into a tree by parent_id (a parent_id pointing at a missing tag is
  // treated as top-level, so nothing is ever hidden).
  const ids = new Set(items.map((t) => t.id));
  const allById = new Map(allItems.map((t) => [t.id, t]));
  const byParent = new Map<string | null, TagRecord[]>();
  for (const t of items) {
    let key = t.parent_id;
    const seen = new Set([t.id]);
    while (key && !ids.has(key) && !seen.has(key)) {
      seen.add(key);
      key = allById.get(key)?.parent_id ?? null;
    }
    if (key && (!ids.has(key) || seen.has(key))) key = null;
    const arr = byParent.get(key) ?? [];
    arr.push(t);
    byParent.set(key, arr);
  }
  const onDelete = async (t: TagRecord) => {
    const ok = await confirm({
      title: "Delete tag?",
      message: `${t.name} comes off every record that carries it (the records stay), and any tags inside it move to the top level. You can undo this straight after.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) del.mutate(t.id);
  };
  const byId = new Map(items.map((t) => [t.id, t]));
  const pathOf = (t: TagRecord): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let p = t.parent_id ? byId.get(t.parent_id) : undefined; p && !seen.has(p.id); p = p.parent_id ? byId.get(p.parent_id) : undefined) {
      seen.add(p.id);
      names.unshift(p.name);
    }
    return names.join(" › ");
  };
  const needle = find.trim().toLowerCase();
  const found = needle ? items.filter((t) => t.name.toLowerCase().includes(needle)) : [];
  const renderNodes = (parentId: string | null, depth: number): ReactNode[] =>
    (byParent.get(parentId) ?? []).map((t) => (
      <div key={t.id} style={{ marginLeft: depth * 18 }} className="space-y-1.5">
        <TagPillRow
          t={t}
          onEdit={() => setEditing(t)}
          onDelete={canDelete ? () => void onDelete(t) : undefined}
          onTogglePin={() => pin.mutate(t)}
        />
        {renderNodes(t.id, depth + 1)}
      </div>
    ));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Tags</h1>
        <Link className="text-xs text-muted underline" to="/configuration/recently-deleted?kind=core-tags:tag">Recently deleted</Link>
        <span className="text-sm text-muted dark:text-slate-400">
          {needle ? `${found.length} of ${items.length}` : items.length} {items.length === 1 ? "tag" : "tags"}
        </span>
        <div className="flex-1" />
        <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
          Hide empty
        </label>
        {hideEmpty && <span className="text-sm text-muted" role="status">{hiddenCount} empty hidden</span>}
        {allItems.length > 0 && (
          <SearchInput value={find} onChange={setFind} placeholder="find a tag…" aria-label="Find a tag" wrapperClassName="w-44 max-sm:w-full max-sm:order-last" />
        )}
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> New tag
        </button>
      </div>

      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {allItems.length === 0 && !list.isLoading && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          No tags yet. Tags get created on demand when you attach one to an
          entity, or you can pre-define them here.
        </div>
      )}

      {needle ? (
        found.length ? (
          <div className="space-y-1.5">
            {found.map((t) => (
              <div key={t.id}>
                <TagPillRow t={t} path={pathOf(t) || undefined} onEdit={() => setEditing(t)} onDelete={canDelete ? () => void onDelete(t) : undefined} onTogglePin={() => pin.mutate(t)} />
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted dark:text-slate-400 italic">No tag is called anything like "{find.trim()}".</div>
        )
      ) : (
        <div className="space-y-1.5">{renderNodes(null, 0)}</div>
      )}

      {createOpen && (
        <CreateTagModal
          slug={activeSlug}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ["tags", activeSlug] });
            setCreateOpen(false);
          }}
        />
      )}

      {editing && (
        <EditTagModal
          mayMerge={mayMerge}
          slug={activeSlug}
          tag={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["tags", activeSlug] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}



function CreateTagModal({
  slug,
  onClose,
  onCreated,
}: {
  slug: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#888888");
  const [icon, setIcon] = useState("");
  const [parentId, setParentId] = useState("");
  const toast = useToast();
  const allTags = useQuery({ queryKey: ["tags", slug], queryFn: () => api.listTags(slug) });
  const parentOptions = allTags.data?.items ?? [];

  return (
    <RecordFormModal open onClose={onClose} title="New tag">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          try {
            await api.createTag(slug, {
              name: name.trim(),
              color,
              icon: icon.trim() || null,
              parent_id: parentId || null,
            });
            toast.success("Tag created");
            onCreated();
          } catch (err) {
            const msg = err instanceof ApiError ? err.message : String(err);
            toast.error(msg);
          }
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. urgent"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
        </label>
        <label className="flex items-center gap-3 text-sm">
          <span className="text-xs text-muted">Color</span>
          <DragInput
            control="color"
            value={color}
            onPreview={setColor}
            onCommit={setColor}
            className="h-8 w-12 border border-line dark:border-slate-600 rounded"
          />
          <span className="font-mono text-xs">{color}</span>
        </label>
        <FieldPack items={[
          {
            need: fieldNeed("icon", { control: "text", label: "Icon" }),
            node: (
              <label className="flex items-center gap-3 text-sm">
                <span className="text-xs text-muted">Icon</span>
                <input
                  type="text"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="🏷️"
                  maxLength={8}
                  className="w-14 px-2 py-1 text-sm text-center border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
                />
                <span className="text-[11px] text-faint">an emoji</span>
              </label>
            ),
          },
          parentOptions.length > 0 ? {
            need: fieldNeed("parentId", { control: "choice", label: "Parent tag (optional - for grouping)" }),
            node: (
              <label className="block">
                <div className="text-xs text-muted mb-1">Parent tag (optional - for grouping)</div>
                <select
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                  className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
                >
                  <option value=""> - none (top-level) - </option>
                  {parentOptions.map((t) => (
                    <option key={t.id} value={t.id}>{t.icon ? `${t.icon} ` : ""}{t.name}</option>
                  ))}
                </select>
              </label>
            ),
          } : null,
        ]} />
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            Create
          </button>
        </div>
      </form>
    </RecordFormModal>
  );
}
