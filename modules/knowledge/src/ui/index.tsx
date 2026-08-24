// knowledge UI — the host mounts <KnowledgeUI /> at /knowledge. A list of
// entries (bordered cards) with a create/edit MODAL that uses the shared
// Markdown editor (KB phase 1). Modals for detail/edit, toasts for feedback,
// useConfirm for destructive deletes — house conventions.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ContributedDetailPanels,
  Modal,
  Markdown,
  MarkdownEditor,
  QrCode,
  stripMarkdown,
  useImageSrc,
  useToast,
  useConfirm,
  usePageTitle,
} from "@cobblr/platform-web";
import { BookOpen, Plus, Pin, PinOff, Trash2, Search, ImagePlus, X } from "lucide-react";
import { KnowledgeApi, type Entry, type EntryInput, KnowledgeApiError } from "./api.js";

export const navItems = [{ label: "Knowledge Base", path: "/knowledge", icon: BookOpen }];

const KINDS = ["note", "reference", "SOP", "prompt", "paper"];

interface Props {
  orgSlug: string;
  getToken: () => string | null;
}

export function KnowledgeUI({ orgSlug, getToken }: Props) {
  usePageTitle("Knowledge Base");
  const api = useMemo(() => new KnowledgeApi(orgSlug, getToken), [orgSlug, getToken]);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const [q, setQ] = useState("");
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<Entry | "new" | null>(null);

  const key = ["knowledge", orgSlug];
  const entries = useQuery({ queryKey: key, queryFn: () => api.listEntries() });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteEntry(id),
    onSuccess: () => {
      toast.success("Entry deleted");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(e instanceof KnowledgeApiError ? e.message : String(e)),
  });

  const togglePin = useMutation({
    mutationFn: (e: Entry) => api.updateEntry(e.id, { pinned: !e.pinned }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(e instanceof KnowledgeApiError ? e.message : String(e)),
  });

  const items = (entries.data?.items ?? []).filter((e) => {
    if (kindFilter && e.kind !== kindFilter) return false;
    if (q.trim()) {
      const hay = `${e.title} ${e.body ?? ""}`.toLowerCase();
      if (!hay.includes(q.trim().toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-baseline justify-between border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          knowledge base
        </h1>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-cobble-600 text-white hover:bg-cobble-700"
        >
          <Plus size={14} /> New entry
        </button>
      </div>

      {/* Search + category filter chips (in-vault organisation) */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search entries…"
            className="input w-full pl-8"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          <Chip active={kindFilter === null} onClick={() => setKindFilter(null)}>
            All
          </Chip>
          {KINDS.map((k) => (
            <Chip key={k} active={kindFilter === k} onClick={() => setKindFilter(k)}>
              {k}
            </Chip>
          ))}
        </div>
      </div>

      {entries.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {!entries.isLoading && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-line dark:border-slate-700 p-6 text-center text-sm text-muted italic">
          {q || kindFilter ? "No entries match." : "No entries yet — capture a note, an SOP, a reference, a prompt."}
        </div>
      )}

      <div className="space-y-2">
        {items.map((e) => (
          <div
            key={e.id}
            className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900/40 hover:border-accent transition"
          >
            <div className="flex items-start gap-3 p-3">
              <button
                type="button"
                title={e.pinned ? "Unpin" : "Pin to Quick Access"}
                onClick={() => togglePin.mutate(e)}
                className={"mt-0.5 shrink-0 " + (e.pinned ? "text-accent" : "text-faint hover:text-content")}
              >
                {e.pinned ? <Pin size={16} /> : <PinOff size={16} />}
              </button>
              <EntryThumb path={e.image_path} />
              <button type="button" onClick={() => setEditing(e)} className="flex-1 text-left min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-content dark:text-mortar-100 truncate">{e.title}</span>
                  {e.kind && (
                    <span className="shrink-0 rounded-full bg-subtle dark:bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                      {e.kind}
                    </span>
                  )}
                </div>
                {e.body && (
                  <p className="mt-0.5 text-xs text-muted line-clamp-1">{stripMarkdown(e.body)}</p>
                )}
              </button>
              <button
                type="button"
                title="Delete"
                onClick={async () => {
                  if (await confirm({ title: "Delete entry?", message: e.title, confirmLabel: "Delete", destructive: true }))
                    del.mutate(e.id);
                }}
                className="mt-0.5 shrink-0 text-faint hover:text-ember-500"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <EntryEditor
          api={api}
          orgSlug={orgSlug}
          entry={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: key });
          }}
        />
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full px-2.5 py-1 text-[11px] font-medium border transition " +
        (active
          ? "border-accent bg-accent/10 text-accent"
          : "border-line dark:border-slate-700 text-muted hover:text-content")
      }
    >
      {children}
    </button>
  );
}

function EntryThumb({ path }: { path: string | null }) {
  const src = useImageSrc(path);
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      className="mt-0.5 h-9 w-9 shrink-0 rounded object-cover border border-line dark:border-slate-700"
    />
  );
}

function EntryEditor({
  api,
  entry,
  orgSlug,
  onClose,
  onSaved,
}: {
  api: KnowledgeApi;
  entry: Entry | null;
  orgSlug: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(entry?.title ?? "");
  const [kind, setKind] = useState(entry?.kind ?? "");
  const [code, setCode] = useState(entry?.code ?? "");
  const [pinned, setPinned] = useState(entry?.pinned ?? false);
  const [body, setBody] = useState(entry?.body ?? "");
  const [preview, setPreview] = useState(false);
  const [imagePath, setImagePath] = useState(entry?.image_path ?? null);
  const imageSrc = useImageSrc(imagePath);

  const uploadImage = useMutation({
    mutationFn: (file: File) => {
      if (!entry) throw new KnowledgeApiError(0, "no_entry", "Save the entry first, then add an image.");
      return api.uploadImage(entry.id, file);
    },
    onSuccess: (r) => {
      setImagePath(r.image_path);
      toast.success("Image added");
    },
    onError: (e) => toast.error(e instanceof KnowledgeApiError ? e.message : String(e)),
  });

  const save = useMutation({
    mutationFn: () => {
      const input: EntryInput = {
        title: title.trim(),
        body: body || null,
        kind: kind || null,
        code: code || null,
        pinned,
        image_path: imagePath,
      };
      return entry ? api.updateEntry(entry.id, input) : api.createEntry(input);
    },
    onSuccess: () => {
      toast.success(entry ? "Saved" : "Entry created");
      onSaved();
    },
    onError: (e) => toast.error(e instanceof KnowledgeApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title={entry ? "Edit entry" : "New entry"} size="lg">
      <div className="space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="input w-full text-lg font-medium"
          autoFocus
        />
        <div className="flex flex-wrap items-center gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="input">
            <option value=""> - category - </option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-content dark:text-mortar-200 cursor-pointer">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="accent-cobble-500" />
            <Pin size={13} /> Pin
          </label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="code (optional)"
            className="input w-32"
          />
          {code.trim() && (
            <div className="flex items-center gap-2" title="Scannable QR of this code">
              <QrCode value={code.trim()} size={56} />
            </div>
          )}
        </div>

        {/* Image — e.g. a scanner CONFIG-barcode screenshot (store it, don't
            regenerate — exact Code-128 must be scanned from the image). */}
        <div>
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint">Image</span>
          {imageSrc ? (
            <div className="mt-1 relative inline-block">
              <img
                src={imageSrc}
                alt="entry"
                className="max-h-48 rounded border border-line dark:border-slate-700"
              />
              <button
                type="button"
                title="Remove image"
                onClick={() => setImagePath(null)}
                className="absolute -top-2 -right-2 grid h-6 w-6 place-items-center rounded-full border border-line dark:border-slate-600 bg-surface dark:bg-slate-800 text-muted hover:text-ember-500"
              >
                <X size={13} />
              </button>
            </div>
          ) : entry ? (
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-sm text-accent hover:underline">
              <ImagePlus size={15} />
              {uploadImage.isPending ? "Uploading…" : "Add an image (e.g. a barcode screenshot)"}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadImage.mutate(f);
                }}
              />
            </label>
          ) : (
            <p className="mt-1 text-xs text-faint">Save the entry first, then add an image.</p>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-widest text-faint">Body</span>
            {entry && (
              <button
                type="button"
                onClick={() => setPreview((p) => !p)}
                className="text-[11px] text-accent hover:underline"
              >
                {preview ? "Edit" : "Preview"}
              </button>
            )}
          </div>
          {preview ? (
            <div className="rounded-md border border-line dark:border-slate-700 px-3 py-2 min-h-[10rem]">
              {body.trim() ? <Markdown>{body}</Markdown> : <span className="text-sm text-faint">Empty.</span>}
            </div>
          ) : (
            <MarkdownEditor value={body} onChange={setBody} minRows={10} ariaLabel="Entry body" />
          )}
        </div>

        {/* Only once the entry EXISTS. There is nothing to tag or talk about
            while it is still being typed, and a conversation attached to a
            record that may never be saved would have nowhere to live. */}
        {entry && (
          <ContributedDetailPanels
            target="knowledge:entry"
            ctx={{ slug: orgSlug, entityId: entry.id, entityTitle: entry.title }}
          />
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600 text-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={!title.trim() || save.isPending}
            onClick={() => save.mutate()}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : entry ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default KnowledgeUI;
