// /tags — list every tag the workspace has, what each is attached
// to, and a quick "new tag" affordance. The attach-to-entity UX
// happens module-side (Files page, parts page, etc.) — this page
// is just the registry + delete.

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pencil, Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { ApiError, api, type TagRecord } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";

interface TagAttachment {
  id: string;
  tag_id: string;
  source_module: string;
  source_type: string;
  source_id: string;
  tag_name: string;
  tag_color: string | null;
  created_at: string;
}

// Map a (source_module, source_type) to the route prefix for the
// detail page. Same convention the EntityChip uses.
// NOTE: these are the BASE (default-instance) routes. A tag attachment row
// carries only source_module / source_type / source_id — NOT the item's
// `instance` — so this page can't yet route an instance-owned item to its
// instance detail (/instances/<name>/…). Closing that needs the attachment
// payload (or a per-row resolve) to surface the item's instance; tracked as a
// deferred follow-up. Search/dashboard/QR already route correctly via the
// resolver-owned detailUrl.
function detailRoute(sourceModule: string, sourceType: string, id: string): string | null {
  const map: Record<string, string> = {
    "inventory:part": `/inventory/parts/${id}`,
    "machines:machine": `/machines/${id}`,
    "assets:asset": `/assets/${id}`,
    "projects:project": `/projects/${id}`,
    "projects:task": `/projects/tasks/${id}`,
    "purchases:order": `/purchases/${id}`,
  };
  return map[`${sourceModule}:${sourceType}`] ?? null;
}

// One tag rendered as a pill — its emoji icon (or the default tag glyph), name
// (click to see what's tagged), edit + delete.
function TagPillRow({
  t,
  onExplore,
  onEdit,
  onDelete,
}: {
  t: TagRecord;
  onExplore: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <span
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border"
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
      <button
        type="button"
        onClick={onExplore}
        className="hover:underline focus:outline-none"
        title={`Show what's tagged "${t.name}"`}
      >
        {t.name}
      </button>
      <button onClick={onEdit} className="text-faint hover:text-accent transition" title="Edit">
        <Pencil size={12} />
      </button>
      <button onClick={onDelete} className="text-faint hover:text-ember-500 transition" title="Delete">
        <Trash2 size={12} />
      </button>
    </span>
  );
}

// Every descendant id of a tag — excluded from its own parent options so you
// can't create a loop (the API guards this too).
function descendantIds(tags: TagRecord[], rootId: string): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string) => {
    for (const c of tags.filter((t) => t.parent_id === pid)) {
      if (!out.has(c.id)) {
        out.add(c.id);
        walk(c.id);
      }
    }
  };
  walk(rootId);
  return out;
}

export function TagsPage() {
  usePageTitle("Tags");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [exploring, setExploring] = useState<TagRecord | null>(null);
  const [editing, setEditing] = useState<TagRecord | null>(null);

  const list = useQuery({
    queryKey: ["tags", activeSlug],
    queryFn: () => api.listTags(activeSlug),
    enabled: !!activeSlug,
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteTag(activeSlug, id),
    onSuccess: () => {
      toast.success("Tag deleted");
      void qc.invalidateQueries({ queryKey: ["tags", activeSlug] });
    },
  });

  const items = list.data?.items ?? [];

  // Group into a tree by parent_id (a parent_id pointing at a missing tag is
  // treated as top-level, so nothing is ever hidden).
  const ids = new Set(items.map((t) => t.id));
  const byParent = new Map<string | null, TagRecord[]>();
  for (const t of items) {
    const key = t.parent_id && ids.has(t.parent_id) ? t.parent_id : null;
    const arr = byParent.get(key) ?? [];
    arr.push(t);
    byParent.set(key, arr);
  }
  const onDelete = async (t: TagRecord) => {
    const ok = await confirm({
      title: "Delete tag?",
      message: `${t.name} — its attachments are removed (cascade); any child tags become top-level.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) del.mutate(t.id);
  };
  const renderNodes = (parentId: string | null, depth: number): ReactNode[] =>
    (byParent.get(parentId) ?? []).map((t) => (
      <div key={t.id} style={{ marginLeft: depth * 18 }} className="space-y-1.5">
        <TagPillRow
          t={t}
          onExplore={() => setExploring(t)}
          onEdit={() => setEditing(t)}
          onDelete={() => void onDelete(t)}
        />
        {renderNodes(t.id, depth + 1)}
      </div>
    ));

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Tags</h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} {items.length === 1 ? "tag" : "tags"}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> New tag
        </button>
      </div>

      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          No tags yet. Tags get created on demand when you attach one to an
          entity, or you can pre-define them here.
        </div>
      )}

      <div className="space-y-1.5">{renderNodes(null, 0)}</div>

      {exploring && (
        <TagAttachmentsModal
          slug={activeSlug}
          tag={exploring}
          onClose={() => setExploring(null)}
        />
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

function EditTagModal({
  slug,
  tag,
  onClose,
  onSaved,
}: {
  slug: string;
  tag: TagRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color ?? "#888888");
  const [icon, setIcon] = useState(tag.icon ?? "");
  const [parentId, setParentId] = useState(tag.parent_id ?? "");
  const [mergeInto, setMergeInto] = useState("");
  const toast = useToast();
  const confirm = useConfirm();
  const save = useMutation({
    mutationFn: () =>
      api.updateTag(slug, tag.id, {
        name: name.trim(),
        color,
        icon: icon.trim() || null,
        parent_id: parentId || null,
      }),
    onSuccess: () => {
      toast.success("Tag updated - change applies everywhere it's attached");
      onSaved();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't save"),
  });
  // Other tags this one can be merged into.
  const allTags = useQuery({ queryKey: ["tags", slug], queryFn: () => api.listTags(slug) });
  const allItems = allTags.data?.items ?? [];
  const otherTags = allItems.filter((t) => t.id !== tag.id);
  // Valid parents = anything that isn't this tag or one of its descendants
  // (else you'd create a loop; the API guards this too).
  const noParent = descendantIds(allItems, tag.id);
  const parentOptions = otherTags.filter((t) => !noParent.has(t.id));
  const merge = useMutation({
    mutationFn: (into: string) => api.mergeTag(slug, tag.id, into),
    onSuccess: (r) => {
      const n = r.moved_assignments;
      toast.success(`Merged into "${r.merged_into.name}" — moved ${n} attachment${n === 1 ? "" : "s"}`);
      onSaved();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't merge"),
  });

  return (
    <Modal open onClose={onClose} title={`Edit — ${tag.name}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
        </label>
        <label className="flex items-center gap-3 text-sm">
          <span className="text-xs text-muted">Color</span>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-12 border border-line dark:border-slate-600 rounded"
          />
          <span className="font-mono text-xs">{color}</span>
        </label>
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
        <p className="text-[11px] text-faint">
          Renaming updates the tag everywhere it's attached - it's the same tag,
          not a copy.
        </p>
        {otherTags.length > 0 && (
          <div className="border-t border-line dark:border-slate-700 pt-3">
            <div className="text-xs text-muted mb-1">Merge into another tag</div>
            <div className="flex items-center gap-2">
              <select
                value={mergeInto}
                onChange={(e) => setMergeInto(e.target.value)}
                className="flex-1 px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              >
                <option value=""> - choose a tag - </option>
                {otherTags.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={!mergeInto || merge.isPending}
                onClick={() => {
                  const target = otherTags.find((t) => t.id === mergeInto);
                  void confirm({
                    title: "Merge tag",
                    message: `Move every attachment from "${tag.name}" to "${target?.name}", then delete "${tag.name}". This can't be undone.`,
                    confirmLabel: "Merge",
                  }).then((ok) => {
                    if (ok) merge.mutate(mergeInto);
                  });
                }}
                className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600 text-content hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50"
              >
                Merge
              </button>
            </div>
          </div>
        )}
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
            disabled={!name.trim() || save.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TagAttachmentsModal({
  slug,
  tag,
  onClose,
}: {
  slug: string;
  tag: TagRecord;
  onClose: () => void;
}) {
  const list = useQuery({
    queryKey: ["tag-attachments", slug, tag.id],
    queryFn: async () => {
      const token = localStorage.getItem("cobblr.token") ?? "";
      const res = await fetch(
        `/api/v1/orgs/${slug}/modules/core-tags/attachments?tag_id=${encodeURIComponent(tag.id)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { items: TagAttachment[] };
    },
  });

  const items = list.data?.items ?? [];

  return (
    <Modal open onClose={onClose} title={`Tagged "${tag.name}"`} size="md">
      {list.isLoading && (
        <div className="text-sm text-muted">Loading…</div>
      )}
      {!list.isLoading && items.length === 0 && (
        <div className="text-sm text-muted italic py-4 text-center">
          Nothing's tagged with this yet. Attach the tag from any
          entity's detail page.
        </div>
      )}
      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((a) => {
            const route = detailRoute(a.source_module, a.source_type, a.source_id);
            const label = `${a.source_module}:${a.source_type}`;
            return (
              <li
                key={a.id}
                className="flex items-center justify-between gap-2 border border-line dark:border-slate-700 rounded-md px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-mono text-[11px] text-faint dark:text-slate-500">
                    {label}
                  </div>
                  <div className="text-[10px] font-mono text-faint dark:text-slate-500 truncate">
                    {a.source_id}
                  </div>
                </div>
                {route ? (
                  <Link
                    to={route}
                    onClick={onClose}
                    className="text-accent hover:text-accent inline-flex items-center gap-1 text-xs"
                  >
                    open <ExternalLink size={11} />
                  </Link>
                ) : (
                  <span className="text-[10px] text-faint italic">
                    no detail route
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex justify-end pt-3">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
        >
          Close
        </button>
      </div>
    </Modal>
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
    <Modal open onClose={onClose} title="New tag">
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
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-12 border border-line dark:border-slate-600 rounded"
          />
          <span className="font-mono text-xs">{color}</span>
        </label>
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
        {parentOptions.length > 0 && (
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
        )}
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
    </Modal>
  );
}
