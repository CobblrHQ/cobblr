// /tags — list every tag the workspace has, what each is attached
// to, and a quick "new tag" affordance. The attach-to-entity UX
// happens module-side (Files page, parts page, etc.) — this page
// is just the registry + delete.

import { useState } from "react";
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
function detailRoute(sourceModule: string, sourceType: string, id: string): string | null {
  const map: Record<string, string> = {
    "inventory:part": `/inventory/parts/${id}`,
    "machines:machine": `/machines/${id}`,
    "assets:asset": `/assets/${id}`,
    "projects:project": `/projects/projects/${id}`,
    "projects:task": `/projects/tasks/${id}`,
    "purchases:order": `/purchases/${id}`,
  };
  return map[`${sourceModule}:${sourceType}`] ?? null;
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

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">Tags</h1>
        <span className="text-sm text-slate-500 dark:text-slate-400">
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

      {list.isLoading && <div className="text-sm text-slate-500">Loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-slate-500 dark:text-slate-400 italic">
          No tags yet. Tags get created on demand when you attach one to an
          entity, or you can pre-define them here.
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {items.map((t) => (
          <span
            key={t.id}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border"
            style={{
              borderColor: t.color ?? undefined,
              background: t.color ? `${t.color}22` : undefined,
            }}
          >
            <TagIcon size={12} style={{ color: t.color ?? undefined }} />
            <button
              type="button"
              onClick={() => setExploring(t)}
              className="hover:underline focus:outline-none"
              title={`Show what's tagged "${t.name}"`}
            >
              {t.name}
            </button>
            <button
              onClick={() => setEditing(t)}
              className="text-slate-400 hover:text-cobble-600 transition"
              title="Rename / recolor"
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={async () => {
                const ok = await confirm({
                  title: "Delete tag?",
                  message: `${t.name} — all attachments will also be removed (cascade).`,
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (ok) del.mutate(t.id);
              }}
              className="text-slate-400 hover:text-ember-500 transition"
              title="Delete"
            >
              <Trash2 size={12} />
            </button>
          </span>
        ))}
      </div>

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
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => api.updateTag(slug, tag.id, { name: name.trim(), color }),
    onSuccess: () => {
      toast.success("Tag updated — change applies everywhere it's attached");
      onSaved();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't save"),
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
          <div className="text-xs text-slate-500 mb-1">Name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
            autoFocus
          />
        </label>
        <label className="flex items-center gap-3 text-sm">
          <span className="text-xs text-slate-500">Color</span>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-12 border border-slate-300 dark:border-slate-600 rounded"
          />
          <span className="font-mono text-xs">{color}</span>
        </label>
        <p className="text-[11px] text-slate-400">
          Renaming updates the tag everywhere it's attached — it's the same tag,
          not a copy.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
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
        <div className="text-sm text-slate-500">Loading…</div>
      )}
      {!list.isLoading && items.length === 0 && (
        <div className="text-sm text-slate-500 italic py-4 text-center">
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
                className="flex items-center justify-between gap-2 border border-slate-200 dark:border-slate-700 rounded-md px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-mono text-[11px] text-slate-400 dark:text-slate-500">
                    {label}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 truncate">
                    {a.source_id}
                  </div>
                </div>
                {route ? (
                  <Link
                    to={route}
                    onClick={onClose}
                    className="text-cobble-600 hover:text-cobble-700 inline-flex items-center gap-1 text-xs"
                  >
                    open <ExternalLink size={11} />
                  </Link>
                ) : (
                  <span className="text-[10px] text-slate-400 italic">
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
          className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
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
  const toast = useToast();

  return (
    <Modal open onClose={onClose} title="New tag">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          try {
            await api.createTag(slug, { name: name.trim(), color });
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
          <div className="text-xs text-slate-500 mb-1">Name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. urgent"
            className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
            autoFocus
          />
        </label>
        <label className="flex items-center gap-3 text-sm">
          <span className="text-xs text-slate-500">Color</span>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-12 border border-slate-300 dark:border-slate-600 rounded"
          />
          <span className="font-mono text-xs">{color}</span>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
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
