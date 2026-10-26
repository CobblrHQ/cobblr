import { fieldNeed, FieldPack, RecordFormModal, DragInput, useConfirm, useToast, editOf } from "@cobblr/platform-web";
// Edit a tag: its name, colour, icon and parent, or merge it into another.
// Shared by the tags list and a tag's own page.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, api, type TagRecord } from "../lib/api";

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

export function EditTagModal({
  slug,
  tag,
  onClose,
  onSaved,
  onMerged,
  mayMerge = false,
  onUndone,
}: {
  slug: string;
  tag: TagRecord;
  onClose: () => void;
  onSaved: () => void;
  /** After a merge this tag is gone: go to the one it became. */
  onMerged?: (intoId: string) => void;
  /** The viewer may merge tags (the page asks the gate). */
  mayMerge?: boolean;
  /** After Undo on a merge, the tag is back. */
  onUndone?: (id: string) => void;
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
      api.updateTag(slug, tag.id, editOf(tag, {
        name: name.trim(),
        color,
        icon: icon.trim() || null,
        parent_id: parentId || null,
      })),
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
      toast.action(`Merged ${tag.name} into ${r.merged_into.name}: ${n} ${n === 1 ? "record" : "records"} moved.`, {
        actionLabel: "Undo",
        onAction: async () => {
          try {
            const back = await api.restoreTag(slug, tag.id);
            toast.success(`Put ${back.name} back on ${back.assignments} ${back.assignments === 1 ? "record" : "records"}.`);
            onUndone?.(tag.id);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        },
      });
      if (onMerged) onMerged(r.merged_into.id);
      else onSaved();
    },
    // A refusal that can be asked for opens the blocked-action sheet itself.
    onError: (e: unknown) => {
      if (e instanceof ApiError && e.blocked) return;
      toast.error(e instanceof ApiError ? e.message : "Couldn't merge");
    },
  });

  return (
    <RecordFormModal open onClose={onClose} title={`Edit: ${tag.name}`}>
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
          {
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
          },
        ]} />
        <p className="text-[11px] text-faint">
          Renaming updates the tag everywhere it's attached - it's the same tag,
          not a copy.
        </p>
        {mayMerge && otherTags.length > 0 && (
          <div className="border-t border-line dark:border-slate-700 pt-3">
            <div className="text-xs text-muted mb-1">Merge into another tag</div>
            <div className="flex items-center gap-2">
              <select aria-label="Merge into another tag"
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
                    message: `Every record carrying ${tag.name} will carry ${target?.name} instead, and ${tag.name} goes. You can undo this straight after.`,
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
    </RecordFormModal>
  );
}
