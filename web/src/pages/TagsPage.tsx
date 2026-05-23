// /tags — list every tag the workspace has, what each is attached
// to, and a quick "new tag" affordance. The attach-to-entity UX
// happens module-side (Files page, parts page, etc.) — this page
// is just the registry + delete.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { ApiError, api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm } from "@cobblr/platform-web";

export function TagsPage() {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);

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
            <span>{t.name}</span>
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
