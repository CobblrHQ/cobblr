// Inline attachment panel for any entity-detail page. Shows the
// tags + files currently attached to (kind, id), plus affordances
// to add more — without dropping out to the Tags / Files pages.
//
// Backend already supports the (source_module, source_type,
// source_id) polymorphic shape on both core-tags_assignments and
// core_files_attachments; this is the matching UI primitive.

import { useEffect, useRef, useState } from "react";
import { openAuthedFile } from "../lib/authed-file";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, ImageIcon, Plus, Tag as TagIcon, Trash2, Upload, X } from "lucide-react";
import { ApiError, api, type TagRecord } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, EntityPhoto } from "@cobblr/platform-web";
import { FilePreview, canPreviewFile, useFilePreviewRegistry } from "@cobblr/platform-web";
import { ImageLightbox } from "./ImageLightbox";
import { DiscussionPreview } from "./DiscussionTab";
import { clipboardImageFiles } from "./pastedImage";
import { LinksSection } from "../features/links/LinksSection";

interface Props {
  /** Entity kind id, e.g. "inventory:part". */
  kind: string;
  /** Tenant-DB UUID of the entity. */
  entityId: string;
  /** The table the record is in (`3d-printers:item`), so the links it
   *  declares are offered first. Defaults to `kind`. */
  collection?: string;
  /** Compact mode: an EMPTY section collapses to a small "+ Tag / + File /
   *  + Link" add-pill (no header, no big dropzone) and only grows into the full
   *  section once it has content — so a detail modal opens without a wall of
   *  empty attachment boxes. Default off (unchanged for existing callers). */
  compact?: boolean;
  /** Side-cars this page already gets another way.
   *
   *  Tags and discussion are also contributed as universal detail PANELS, so a
   *  page that renders <ContributedDetailPanels> as well as this component
   *  would show each of them twice. `lint:sidecar-once` fails the build on a
   *  page that renders both and does not say which half it is dropping. */
  omit?: Array<"tags" | "discussion" | "files" | "pairings">;
}

export function EntityAttachments({ kind, entityId, collection, compact = false, omit = [] }: Props) {
  const [moduleName, sourceType] = kind.split(":");
  if (!moduleName || !sourceType) return null;
  const shows = (part: NonNullable<Props["omit"]>[number]) => !omit.includes(part);
  return (
    <div className={compact ? "flex flex-wrap items-start gap-2" : "space-y-4"}>
      {shows("tags") && (
        <TagsSection
          sourceModule={moduleName}
          sourceType={sourceType}
          sourceId={entityId}
          compact={compact}
        />
      )}
      {shows("discussion") && (
        <DiscussionPreview
          sourceModule={moduleName}
          sourceType={sourceType}
          sourceId={entityId}
          compact={compact}
        />
      )}
      {shows("files") && (
        <FilesSection
          sourceModule={moduleName}
          sourceType={sourceType}
          sourceId={entityId}
          compact={compact}
        />
      )}
      {shows("pairings") && <LinksSection kind={kind} entityId={entityId} collection={collection} compact={compact} />}
    </div>
  );
}

/** Shared small dashed add-pill used by the compact empty states. */
const ADD_PILL =
  "inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-dashed border-line dark:border-slate-600 text-muted hover:border-cobble-500 hover:text-accent transition";

/** Best-effort PATCH the entity's image_path to a given URL.
 *  Convention: `/orgs/<slug>/modules/<module>/<type>s/<id>` is the
 *  CRUD route for every user-facing entity kind (part, machine,
 *  asset, project, task, order). Pluralizing with +s is reliable
 *  for the current set of kinds; if a future kind ends in '-y'
 *  this helper would need adjustment. */
async function setEntityImagePath(
  slug: string,
  sourceModule: string,
  sourceType: string,
  sourceId: string,
  imagePath: string,
): Promise<void> {
  const path = `/orgs/${slug}/modules/${sourceModule}/${sourceType}s/${sourceId}`;
  await api.request("PATCH", path, { image_path: imagePath });
}

// ──────────────── Tags ──────────────────────────────────────────────

export function TagsSection({
  sourceModule,
  sourceType,
  sourceId,
  compact = false,
}: {
  sourceModule: string;
  sourceType: string;
  sourceId: string;
  compact?: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showQuiet, setShowQuiet] = useState(false);

  const attached = useQuery({
    queryKey: ["tag-attachments", activeSlug, sourceType, sourceId],
    queryFn: () =>
      api.listTagAttachments(activeSlug, {
        source_module: sourceModule,
        source_type: sourceType,
        source_id: sourceId,
      }),
    enabled: !!activeSlug,
  });

  const detach = useMutation({
    mutationFn: (id: string) => api.detachTag(activeSlug, id),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["tag-attachments", activeSlug, sourceType, sourceId],
      });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const items = attached.data?.items ?? [];
  // The server ranks these (core-tags src/relevance.ts): pinned first, then by
  // how broadly and how recently the tag is used. A tag that is both OLD and
  // NARROW comes back `quiet` — a spent event tag like "3DPrintopia 2026",
  // worth keeping as history and not worth reading on every printer forever.
  // It folds behind "+N" rather than disappearing: one click brings it back,
  // and the button says why it was folded.
  const quiet = items.filter((a) => a.quiet);
  const shown = showQuiet ? items : items.filter((a) => !a.quiet);

  return (
    <section>
      {!compact && (
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
          // tags
        </h3>
      )}
      <div className="flex flex-wrap gap-2 items-center">
        {shown.map((a) => (
          <span
            key={a.id}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border"
            style={{
              borderColor: a.tag_color ?? undefined,
              background: a.tag_color ? `${a.tag_color}22` : undefined,
            }}
          >
            <TagIcon size={10} style={{ color: a.tag_color ?? undefined }} />
            <span>{a.tag_name}</span>
            <button
              onClick={() => detach.mutate(a.id)}
              className="text-faint hover:text-ember-500 transition"
              title="Detach"
            >
              <X size={10} />
            </button>
          </span>
        ))}
        {quiet.length > 0 && !showQuiet && (
          <button
            onClick={() => setShowQuiet(true)}
            // The reason, per tag, on hover. A count alone ("+3") tells you
            // something was hidden but not what or why, which is the part that
            // makes an automatic rule feel arbitrary.
            title={quiet.map((a) => a.quiet_reason ?? a.tag_name).join("\n")}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-dashed border-line dark:border-slate-600 text-faint dark:text-slate-500 hover:border-cobble-500 hover:text-accent transition"
          >
            +{quiet.length}
          </button>
        )}
        {showQuiet && quiet.length > 0 && (
          <button
            onClick={() => setShowQuiet(false)}
            className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-accent transition"
          >
            fewer
          </button>
        )}
        <button
          onClick={() => setPickerOpen(true)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-dashed border-line dark:border-slate-600 text-muted hover:border-cobble-500 hover:text-accent transition"
        >
          <Plus size={10} /> Tag
        </button>
      </div>
      {pickerOpen && (
        <TagPickerModal
          slug={activeSlug}
          existing={new Set(items.map((a) => a.tag_id))}
          sourceModule={sourceModule}
          sourceType={sourceType}
          sourceId={sourceId}
          onClose={() => setPickerOpen(false)}
          onAttached={() => {
            void qc.invalidateQueries({
              queryKey: ["tag-attachments", activeSlug, sourceType, sourceId],
            });
            setPickerOpen(false);
          }}
        />
      )}
    </section>
  );
}

function TagPickerModal({
  slug,
  existing,
  sourceModule,
  sourceType,
  sourceId,
  onClose,
  onAttached,
}: {
  slug: string;
  existing: Set<string>;
  sourceModule: string;
  sourceType: string;
  sourceId: string;
  onClose: () => void;
  onAttached: () => void;
}) {
  const tags = useQuery({
    queryKey: ["tags", slug],
    queryFn: () => api.listTags(slug),
    enabled: !!slug,
  });
  const [newTag, setNewTag] = useState("");
  const toast = useToast();

  async function attach(tag: TagRecord | { name: string }) {
    try {
      await api.attachTag(slug, {
        ...("id" in tag ? { tag_id: tag.id } : { tag_name: tag.name }),
        source_module: sourceModule,
        source_type: sourceType,
        source_id: sourceId,
      });
      toast.success("Tagged");
      onAttached();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  }

  const available = (tags.data?.items ?? []).filter((t) => !existing.has(t.id));

  return (
    <Modal open onClose={onClose} title="Add a tag">
      <div className="space-y-3">
        {available.length > 0 && (
          <>
            <div className="text-xs text-muted">Existing</div>
            <div className="flex flex-wrap gap-2">
              {available.map((t) => (
                <button
                  key={t.id}
                  onClick={() => void attach(t)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border hover:border-cobble-500"
                  style={{
                    borderColor: t.color ?? undefined,
                    background: t.color ? `${t.color}22` : undefined,
                  }}
                >
                  <TagIcon size={10} style={{ color: t.color ?? undefined }} />
                  {t.name}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="border-t border-line dark:border-slate-700 pt-3">
          <div className="text-xs text-muted mb-1">Or create new</div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!newTag.trim()) return;
              void attach({ name: newTag.trim() });
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="urgent, perennial, technic…"
              className="flex-1 px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              autoFocus
            />
            <button
              type="submit"
              disabled={!newTag.trim()}
              className="px-3 py-1 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
            >
              Add
            </button>
          </form>
        </div>
      </div>
    </Modal>
  );
}

// ──────────────── Files ─────────────────────────────────────────────

function FilesSection({
  sourceModule,
  sourceType,
  sourceId,
  compact = false,
}: {
  sourceModule: string;
  sourceType: string;
  sourceId: string;
  compact?: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);

  const list = useQuery({
    queryKey: ["file-attachments", activeSlug, sourceType, sourceId],
    queryFn: async () => {
      // No direct API helper for "files attached to this entity" —
      // use the core-files attachments list endpoint inline.
      const res = await fetch(
        `/api/v1/orgs/${activeSlug}/modules/core-files/attachments?source_module=${encodeURIComponent(sourceModule)}&source_type=${encodeURIComponent(sourceType)}&source_id=${encodeURIComponent(sourceId)}`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("cobblr.token") ?? ""}`,
          },
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as {
        items: Array<{
          id: string;
          file_id: string;
          filename: string;
          mime_type: string;
          kind: string;
          role: string | null;
        }>;
      };
    },
    enabled: !!activeSlug,
  });

  const uploadAndAttach = useMutation({
    mutationFn: async (file: File) => {
      // Snapshot BEFORE the upload: does the entity already have a photo?
      const hadImage = (list.data?.items ?? []).some((i) => i.kind === "image");
      const f = await api.uploadFile(activeSlug, file);
      // Then attach to this entity.
      const res = await fetch(
        `/api/v1/orgs/${activeSlug}/modules/core-files/attachments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("cobblr.token") ?? ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            file_id: f.id,
            source_module: sourceModule,
            source_type: sourceType,
            source_id: sourceId,
            role: "gallery",
          }),
        },
      );
      if (!res.ok) throw new Error(`attach failed ${res.status}`);
      // The FIRST photo on an entity auto-becomes its cover — uploading a photo
      // should "just show" without a separate Set-as-cover tap (beta feedback,
      // "uploaded a yarn photo, it did not retain"). Best-effort: a failure here
      // never fails the upload, and we only claim the cover when there isn't one.
      if (file.type.startsWith("image/") && !hadImage) {
        try {
          await setEntityImagePath(
            activeSlug,
            sourceModule,
            sourceType,
            sourceId,
            api.fileRawUrl(activeSlug, f.id, "medium"),
          );
        } catch {
          /* gallery attachment already succeeded — cover is a bonus */
        }
      }
      return f;
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["file-attachments", activeSlug, sourceType, sourceId],
      });
      // Bust the entity's list/detail queries so a freshly auto-set cover renders.
      void qc.invalidateQueries({ queryKey: [sourceType + "s"] });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
      void qc.invalidateQueries({ queryKey: ["assets"] });
      void qc.invalidateQueries({ queryKey: ["machines"] });
    },
    onError: (e) => toast.error(`Upload failed: ${(e as Error).message}`),
  });

  const detach = useMutation({
    mutationFn: async (attachmentId: string) => {
      const res = await fetch(
        `/api/v1/orgs/${activeSlug}/modules/core-files/attachments/${attachmentId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("cobblr.token") ?? ""}`,
          },
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
        throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["file-attachments", activeSlug, sourceType, sourceId],
      });
    },
    onError: (e) => toast.error(`Couldn't remove that file: ${(e as Error).message}`),
  });

  async function uploadFiles(files: File[]) {
    for (const f of files) {
      try {
        await uploadAndAttach.mutateAsync(f);
      } catch {
        /* toast already fired */
      }
    }
  }
  async function handleFiles(files: FileList | null) {
    if (!files) return;
    await uploadFiles(Array.from(files));
    if (fileInput.current) fileInput.current.value = "";
  }

  // Clipboard paste: take a screenshot (Print Screen / Cmd-Shift-4) and Ctrl/Cmd-V
  // anywhere on the page to attach it — no need to save it to a file first. We
  // listen on the window so the user doesn't have to focus the panel, but bail
  // when they're typing in a text field so a normal text paste isn't hijacked.
  // `pasteUploadRef` keeps the once-bound listener calling the latest uploader.
  const pasteUploadRef = useRef<(files: File[]) => void>(() => {});
  pasteUploadRef.current = (files) => void uploadFiles(files);
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      const imgs = clipboardImageFiles(e.clipboardData);
      if (imgs.length === 0) return;
      e.preventDefault();
      pasteUploadRef.current(imgs);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const items = list.data?.items ?? [];
  // Re-evaluate canPreviewFile when the host gate toggles renderers
  // (e.g. a machine domain gets enabled mid-session).
  useFilePreviewRegistry();
  // A non-image file open in the preview modal (STL / G-code / SVG / …).
  const [preview, setPreview] = useState<{ file_id: string; filename: string } | null>(null);
  // Which image is open in the full-screen lightbox (index into the image
  // attachments), or null when closed. The lightbox pages across ALL images on
  // the entity, so it navigates this filtered list, not the mixed grid.
  const imageAtts = items.filter((a) => a.kind === "image");
  const [lightbox, setLightbox] = useState<number | null>(null);

  // Drag-and-drop: drop anywhere on the section to upload. We track
  // `dragOver` so the grid can highlight as a drop target instead of
  // just silently accepting files. A nested counter would be nicer
  // for handling enter/leave on children but flat is fine here —
  // pointer-events: none on the overlay keeps child drags from
  // toggling the counter.
  const [dragOver, setDragOver] = useState(false);
  function onDragEnter(e: React.DragEvent) {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragOver(true);
    }
  }
  function onDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }
  function onDragLeave(e: React.DragEvent) {
    // Only clear when the drag leaves the section entirely (not
    // when crossing internal boundaries). currentTarget contains
    // relatedTarget = still inside.
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      void handleFiles(e.dataTransfer.files);
    }
  }

  // Compact + empty → a small "+ File" pill (no header, no big dropzone). Grows
  // into the full grid below once a file is attached.
  if (compact && items.length === 0) {
    return (
      <>
        <button onClick={() => fileInput.current?.click()} className={ADD_PILL}>
          <Upload size={10} /> File
        </button>
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
      </>
    );
  }

  return (
    <section
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={
        "rounded-lg transition " +
        (compact ? "w-full " : "") +
        (dragOver
          ? "ring-2 ring-cobble-400 ring-offset-2 dark:ring-offset-slate-900 bg-cobble-50/30 dark:bg-cobble-900/10"
          : "")
      }
    >
      {!compact && (
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2 flex items-center gap-2">
          // files
          {dragOver && (
            <span className="text-accent font-normal normal-case tracking-normal">
              drop to upload
            </span>
          )}
        </h3>
      )}
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
        {items.map((att) =>
          att.kind === "image" ? (
            <AttachmentThumb
              key={att.id}
              attachmentId={att.id}
              fileId={att.file_id}
              filename={att.filename}
              slug={activeSlug}
              onOpen={() => setLightbox(imageAtts.findIndex((i) => i.id === att.id))}
              onSetAsCover={async () => {
                try {
                  await setEntityImagePath(
                    activeSlug,
                    sourceModule,
                    sourceType,
                    sourceId,
                    api.fileRawUrl(activeSlug, att.file_id, "medium"),
                  );
                  toast.success("Set as cover image");
                  // Invalidate the entity's list/detail queries so
                  // pages re-render with the new image_path. Cast a
                  // wide net since we don't know which page the user
                  // came from.
                  void qc.invalidateQueries({ queryKey: [sourceType + "s"] });
                  void qc.invalidateQueries({ queryKey: ["assets"] });
                  void qc.invalidateQueries({ queryKey: ["machines"] });
                  void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
                } catch (err) {
                  toast.error(`Couldn't set as cover: ${(err as Error).message}`);
                }
              }}
              onDetach={async () => {
                const ok = await confirm({
                  title: "Detach file?",
                  message: `${att.filename} will stay in your file library, just unlinked from this entity.`,
                  confirmLabel: "Detach",
                  destructive: true,
                });
                if (ok) detach.mutate(att.id);
              }}
            />
          ) : canPreviewFile(att.filename) ? (
            // Previewable model/job file (STL / G-code / SVG / …) — click
            // to render it (core-file-preview, via the FilePreview seam).
            <button
              key={att.id}
              type="button"
              onClick={() => setPreview({ file_id: att.file_id, filename: att.filename })}
              className="aspect-square flex flex-col items-center justify-center text-xs text-muted border border-line dark:border-slate-700 rounded hover:border-cobble-500 hover:text-accent transition p-2 text-center group"
              title={`Preview ${att.filename}`}
            >
              <Eye size={14} className="mb-1 text-faint group-hover:text-accent" />
              <div className="font-mono text-[10px] uppercase">
                {att.mime_type.split("/")[1] ?? att.filename.split(".").pop() ?? "file"}
              </div>
              <div className="truncate w-full mt-0.5">{att.filename}</div>
            </button>
          ) : (
            <button
              key={att.id}
              type="button"
              // Bearer-only auth: a plain href 401s (lint-authed-media).
              onClick={() => void openAuthedFile(activeSlug, att.file_id, { mime: att.mime_type, filename: att.filename })}
              className="aspect-square flex flex-col items-center justify-center text-xs text-muted border border-line dark:border-slate-700 rounded hover:border-cobble-500 transition p-2 text-center"
              title={att.filename}
            >
              <div className="font-mono text-[10px] uppercase">
                {att.mime_type.split("/")[1] ?? "file"}
              </div>
              <div className="truncate w-full mt-1">{att.filename}</div>
            </button>
          ),
        )}
        <button
          onClick={() => fileInput.current?.click()}
          className="aspect-square flex flex-col items-center justify-center gap-1 text-xs text-muted border border-dashed border-line dark:border-slate-600 rounded hover:border-cobble-500 hover:text-accent transition"
        >
          <Upload size={14} />
          <span>Add</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>

      {preview && (
        <Modal open onClose={() => setPreview(null)} title={preview.filename} size="lg">
          <FilePreview
            src={api.fileRawUrl(activeSlug, preview.file_id, "original")}
            filename={preview.filename}
          />
        </Modal>
      )}

      {lightbox !== null && imageAtts[lightbox] && (
        <ImageLightbox
          items={imageAtts.map((a) => ({
            key: a.id,
            caption: a.filename,
            file: { slug: activeSlug, fileId: a.file_id },
          }))}
          index={lightbox}
          onIndex={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}
    </section>
  );
}

// ──────────────── Pairings (D4) ─────────────────────────────────────
// Polymorphic "this entity is linked to that one" without firing a
// wire. UI-driven only; wires that subscribe to entity_pairings can
// observe the link, but the link itself is just data.

// Image attachment thumbnail with hover affordances:
//   - Set as cover (camera/image icon)  → PATCH the entity image_path
//   - Detach (trash icon)               → DELETE the attachment row
//
// The image itself routes through useImageSrc so the Bearer token
// is sent (the file-raw endpoint requires it; <img src> alone fails).
function AttachmentThumb({
  attachmentId,
  fileId,
  filename,
  slug,
  onOpen,
  onSetAsCover,
  onDetach,
}: {
  attachmentId: string;
  fileId: string;
  filename: string;
  slug: string;
  onOpen: () => void;
  onSetAsCover: () => void;
  onDetach: () => void;
}) {
  const url = api.fileRawUrl(slug, fileId, "thumb");
  void attachmentId;
  return (
    <div className="group relative aspect-square rounded overflow-hidden border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800">
      <button type="button" onClick={onOpen} className="absolute inset-0 cursor-zoom-in" title="Click to enlarge">
        <EntityPhoto src={url} alt={filename} fill placeholder="…" />
      </button>
      <div className="absolute top-1 right-1 flex gap-1 hover-reveal transition">
        <button
          onClick={onSetAsCover}
          className="p-1 rounded bg-black/40 text-white hover:bg-cobble-600 transition"
          title="Set as cover image"
        >
          <ImageIcon size={10} />
        </button>
        <button
          onClick={onDetach}
          className="p-1 rounded bg-black/40 text-white hover:bg-ember-600 transition"
          title="Detach"
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  );
}
