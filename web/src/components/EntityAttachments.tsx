// Inline attachment panel for any entity-detail page. Shows the
// tags + files currently attached to (kind, id), plus affordances
// to add more — without dropping out to the Tags / Files pages.
//
// Backend already supports the (source_module, source_type,
// source_id) polymorphic shape on both core-tags_assignments and
// core_files_attachments; this is the matching UI primitive.

import { useRef, useState } from "react";
import { openAuthedFile } from "../lib/authed-file";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Plus, Star, Tag as TagIcon, Trash2, Upload, X } from "lucide-react";
import { ApiError, api, type PaperworkConflict, type TagRecord } from "../lib/api";
import { PaperworkConflicts, paperworkNoun, useAnnouncePaperwork } from "./PaperworkConflicts";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, EntityPhoto, usePasteImage, SelectableTile, PhotoSourceBadge } from "@cobblr/platform-web";
import type { PhotoSource } from "@cobblr/platform-contract/photo-source";
import { isImageAttachment, recordPhotos } from "@cobblr/platform-contract/record-photos";
import { FilePreview, DocThumb, canPreviewFile, useFilePreviewRegistry } from "@cobblr/platform-web";
import { ImageLightbox } from "./ImageLightbox";
import { DiscussionPreview } from "./DiscussionTab";
import { LinksSection } from "../features/links/LinksSection";

interface Props {
  /** Entity kind id, e.g. "inventory:part". */
  kind: string;
  /** Tenant-DB UUID of the entity. */
  entityId: string;
  /** The table the record is in (`3d-printers:item`), so the links it
   *  declares are offered first. Defaults to `kind`. */
  collection?: string;
  /** Refresh the host page and its related views after a photo changes. */
  onRecordChanged?: () => void;
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

export function EntityAttachments({ kind, entityId, collection, onRecordChanged, compact = false, omit = [] }: Props) {
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
          onRecordChanged={onRecordChanged}
        />
      )}
      {shows("pairings") && <LinksSection kind={kind} entityId={entityId} collection={collection} compact={compact} />}
    </div>
  );
}

/** Shared small dashed add-pill used by the compact empty states. */
/** A document the paperwork reader can read: a PDF, a spreadsheet export or
 *  plain text. Anything else (a model, a G-code file) is only kept. */
const READABLE_DOCUMENT = /application\/pdf|text\/|csv|\.(pdf|csv|txt)\b/i;

/** A PDF by its stored type (which the store sets from the bytes) or its name. */
function isPdfAttachment(att: { mime_type: string; filename: string }): boolean {
  return att.mime_type === "application/pdf" || /\.pdf$/i.test(att.filename);
}

const ADD_PILL =
  "inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-dashed border-line dark:border-slate-600 text-muted hover:border-cobble-500 hover:text-accent transition";

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
        <h3 className="text-[10px] uppercase tracking-widest text-accent mb-2">
          tags
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
              aria-label="Detach"
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
            className="text-[10px] uppercase tracking-widest text-faint hover:text-accent transition"
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

export function FilesSection({
  sourceModule,
  sourceType,
  sourceId,
  onRecordChanged,
  compact = false,
}: {
  sourceModule: string;
  sourceType: string;
  sourceId: string;
  compact?: boolean;
  onRecordChanged?: () => void;
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
        /** The record's main photo: an attached file, a file never attached
         *  (set before photos were kept), or an outside address. */
        main?: { image_path: string; file_id: string | null; attached: boolean; filename: string | null; photo_source: PhotoSource | null } | null;
        items: Array<{
          id: string;
          file_id: string;
          filename: string;
          mime_type: string;
          kind: string;
          role: string | null;
          photo_source?: PhotoSource | null;
        }>;
      };
    },
    enabled: !!activeSlug,
  });

  const [paperwork, setPaperwork] = useState<{ noun: string; conflicts: PaperworkConflict[] } | null>(null);
  const record = { kind: `${sourceModule}:${sourceType}`, id: sourceId };
  // Whatever shows this record's fields reads them again.
  const refreshFields = () => {
    refreshRecord();
    void qc.invalidateQueries({ predicate: (q) => JSON.stringify(q.queryKey).includes(sourceId) });
  };
  const announcePaperwork = useAnnouncePaperwork(activeSlug, record, refreshFields);

  const uploadAndAttach = useMutation({
    mutationFn: async (file: File) => {
      // Snapshot BEFORE the upload: does the entity already have a photo?
      const hadImage = !!list.data?.main || (list.data?.items ?? []).some((i) => i.kind === "image");
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
            // By type, never by asking: a picture is one of the record's
            // photos, anything else (a bill of sale, a manual) is a file.
            role: file.type.startsWith("image/") ? "gallery" : null,
          }),
        },
      );
      if (!res.ok) throw new Error(`attach failed ${res.status}`);
      // A document is read for what it says about this record (a bill of
      // sale's price, date, seller; a vehicle's VIN): its empty fields are
      // filled and any disagreement is asked about (#4523). A manual or a
      // card that is not a sale is just kept: the reader says so and no model
      // is asked about it.
      if (!file.type.startsWith("image/") && READABLE_DOCUMENT.test(`${file.type} ${file.name}`)) {
        const reading = toast.info(`Reading ${file.name}…`);
        try {
          const r = await api.attachPaperwork(activeSlug, { file_id: f.id, kind: `${sourceModule}:${sourceType}`, id: sourceId });
          toast.dismiss(reading);
          if (r.read) {
            announcePaperwork(r);
            setPaperwork(r.conflicts.length ? { noun: paperworkNoun(r), conflicts: r.conflicts } : null);
            refreshFields();
          }
        } catch {
          toast.dismiss(reading);
        }
      }
      // The FIRST photo on an entity auto-becomes its cover — uploading a photo
      // should "just show" without a separate Set-as-cover tap (beta feedback,
      // "uploaded a yarn photo, it did not retain"). Best-effort: a failure here
      // never fails the upload, and we only claim the cover when there isn't one.
      if (file.type.startsWith("image/") && !hadImage) {
        try {
          await api.setMainPhoto(activeSlug, { entity_kind: `${sourceModule}:${sourceType}`, entity_id: sourceId, file_id: f.id });
        } catch (e) {
          // The photo is attached; only the cover did not take. Say so, or the
          // person sees no cover and thinks the upload was lost.
          toast.error(`The photo is attached, but it could not be made the cover. ${e instanceof Error ? e.message : ""} Use Set as cover on it.`.replace(/\s+/g, " ").trim());
        }
      }
      return f;
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["file-attachments", activeSlug, sourceType, sourceId],
      });
      refreshRecord();
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

  // Anything pasted onto the record is attached, the way a chosen file is
  // (the input takes any file): a picture to its photos, a PDF to its files,
  // through the one paste door (usePasteImage), which also decides between
  // this list and a photo box on the same page by where the person was.
  const sectionRef = useRef<HTMLElement>(null);
  usePasteImage(() => sectionRef.current ?? fileInput.current?.parentElement ?? null, {
    onFiles: (files) => void uploadFiles(files),
    accept: "*",
    multiple: true,
  });

  const items = list.data?.items ?? [];
  // Re-evaluate canPreviewFile when the host gate toggles renderers
  // (e.g. a machine domain gets enabled mid-session).
  useFilePreviewRegistry();
  // A non-image file open in the preview modal (STL / G-code / SVG / …).
  const [preview, setPreview] = useState<{ file_id: string; filename: string } | null>(null);
  // Which image is open in the full-screen lightbox (index into the image
  // attachments), or null when closed. The lightbox pages across ALL images on
  // the entity, so it navigates this filtered list, not the mixed grid.
  const main = list.data?.main ?? null;
  // The record's photos in one row with its files (#4515): the main photo
  // first (starred, outlined), even one set before photos were kept and so
  // never attached; then every other picture; then the files, which wrap to
  // a row of their own only when the photos fill this one.
  const photos = recordPhotos(list.data).map((p) => ({
    ...p,
    src: p.fileId ? api.fileRawUrl(activeSlug, p.fileId, "thumb") : (p.imagePath ?? ""),
    attachmentId: p.attachment?.id ?? null,
  }));
  const otherFiles = items.filter((a) => !isImageAttachment(a));
  const [lightbox, setLightbox] = useState<number | null>(null);
  const makeMain = useMutation({
    mutationFn: (fileId: string) => api.setMainPhoto(activeSlug, { entity_kind: `${sourceModule}:${sourceType}`, entity_id: sourceId, file_id: fileId }),
    onSuccess: (r) => {
      refreshRecord();
      const previous = r.previous_image_path;
      toast.action("Main photo changed.", {
        actionLabel: "Undo",
        duration: 10_000,
        onAction: async () => {
          try {
            await api.setMainPhoto(activeSlug, { entity_kind: `${sourceModule}:${sourceType}`, entity_id: sourceId, image_path: previous });
            refreshRecord();
          } catch (e) {
            toast.error(`Couldn't put it back: ${(e as Error).message}`);
          }
        },
      });
    },
    onError: (e) => toast.error(`Couldn't change the main photo: ${(e as Error).message}`),
  });
  function refreshRecord() {
    onRecordChanged?.();
    void qc.invalidateQueries({ queryKey: ["file-attachments", activeSlug, sourceType, sourceId] });
    // The record's page shows its main photo too; we do not know which page
    // the person came from, so every list and detail that might.
    void qc.invalidateQueries({ queryKey: [sourceType + "s"] });
    void qc.invalidateQueries({ queryKey: ["assets"] });
    void qc.invalidateQueries({ queryKey: ["machines"] });
    void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    void qc.invalidateQueries({ queryKey: ["inventory-part"] });
    void qc.invalidateQueries({ queryKey: ["image-options", activeSlug] });
  }

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

  const uploadStatus = uploadAndAttach.isPending && uploadAndAttach.variables ? (
    <span role="status" className="block mt-2 text-xs text-muted break-all">
      Adding {uploadAndAttach.variables.name}…
    </span>
  ) : null;

  // Compact + empty → a small "+ File" pill (no header, no big dropzone). Grows
  // into the full grid below once a file is attached.
  if (compact && items.length === 0 && !main) {
    return (
      <>
        <button onClick={() => fileInput.current?.click()} disabled={uploadAndAttach.isPending} className={`${ADD_PILL} disabled:opacity-50`}>
          <Upload size={10} /> File
        </button>
        <input ref={fileInput} type="file" multiple disabled={uploadAndAttach.isPending} className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
        {uploadStatus}
      </>
    );
  }

  return (
    <section
      ref={sectionRef}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={
        "rounded-lg transition " +
        (compact ? "w-full " : "") +
        (dragOver
          ? "outline-dashed outline-1 outline-offset-4 outline-cobble-400 bg-cobble-50/30 dark:bg-cobble-900/10"
          : "")
      }
    >
      {!compact && (
        <h3 className="text-[10px] uppercase tracking-widest text-accent mb-2 flex items-center gap-2">
          photos and files
          {dragOver && (
            <span className="text-accent font-normal normal-case tracking-normal">
              drop to upload
            </span>
          )}
        </h3>
      )}
      <div data-testid="photo-strip" className="flex flex-wrap gap-2">
        {photos.map((ph, i) => (
          <SelectableTile
            key={ph.key}
            data-testid={ph.isMain ? "main-photo-tile" : "photo-tile"}
            selected={ph.isMain}
            selectedLabel="Main photo"
            onClick={() => setLightbox(i)}
            title={`See ${ph.filename}`}
            aria-label={`See ${ph.filename}`}
            faceClassName="bg-subtle dark:bg-slate-800"
            topLeft={<PhotoSourceBadge source={ph.source} />}
            topRight={
              ph.isMain ? (
                <span title="Main photo" aria-label="Main photo" className="rounded bg-black/60 p-1 text-amber-300">
                  <Star size={10} fill="currentColor" />
                </span>
              ) : (
                ph.fileId && (
                  <button
                    type="button"
                    onClick={() => makeMain.mutate(ph.fileId!)}
                    disabled={makeMain.isPending}
                    title="Make this the main photo"
                    aria-label={`Make ${ph.filename} the main photo`}
                    className="rounded bg-black/60 p-1 text-white hover:bg-cobble-600 transition disabled:opacity-50"
                  >
                    <Star size={10} />
                  </button>
                )
              )
            }
            bottomRight={
              !ph.isMain &&
              ph.attachmentId && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Detach photo?",
                      message: `${ph.filename} will stay in your file library, just unlinked from this record.`,
                      confirmLabel: "Detach",
                      destructive: true,
                    });
                    if (ok) detach.mutate(ph.attachmentId!);
                  }}
                  className="rounded bg-black/60 p-1 text-white hover:bg-ember-600 transition"
                  title="Detach"
                  aria-label={`Detach ${ph.filename}`}
                >
                  <Trash2 size={10} />
                </button>
              )
            }
          >
            <EntityPhoto src={ph.src} alt={ph.filename} fill placeholder="…" />
          </SelectableTile>
        ))}
        {otherFiles.map((att) =>
          isPdfAttachment(att) ? (
            // A PDF shows its first page, drawn from the file; tapping it
            // opens the PDF reader (#4523). One tile for a document
            // everywhere: the inbox shows the same.
            <DocThumb
              key={att.id}
              src={api.fileRawUrl(activeSlug, att.file_id, "original")}
              filename={att.filename}
              width={80}
              onOpen={() => setPreview({ file_id: att.file_id, filename: /\.pdf$/i.test(att.filename) ? att.filename : `${att.filename}.pdf` })}
              className="w-20 h-20 shrink-0 rounded border border-line dark:border-slate-700 hover:border-cobble-500 transition"
            />
          ) : canPreviewFile(att.filename, att.mime_type) ? (
            // Previewable model/job file (STL / G-code / SVG / …) — click
            // to render it (core-file-preview, via the FilePreview seam).
            <button
              key={att.id}
              type="button"
              onClick={() => setPreview({ file_id: att.file_id, filename: att.filename })}
              className="w-20 h-20 shrink-0 flex flex-col items-center justify-center text-xs text-muted border border-line dark:border-slate-700 rounded hover:border-cobble-500 hover:text-accent transition p-2 text-center group"
              title={`Preview ${att.filename}`}
            >
              <Eye size={14} className="mb-1 text-faint group-hover:text-accent" />
              <div className="text-[10px] uppercase">
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
              className="w-20 h-20 shrink-0 flex flex-col items-center justify-center text-xs text-muted border border-line dark:border-slate-700 rounded hover:border-cobble-500 transition p-2 text-center"
              title={att.filename}
            >
              <div className="text-[10px] uppercase">
                {att.mime_type.split("/")[1] ?? "file"}
              </div>
              <div className="truncate w-full mt-1">{att.filename}</div>
            </button>
          ),
        )}
        <button
          onClick={() => fileInput.current?.click()}
          disabled={uploadAndAttach.isPending}
          className="w-20 h-20 shrink-0 flex flex-col items-center justify-center gap-1 text-xs text-muted border border-dashed border-line dark:border-slate-600 rounded hover:border-cobble-500 hover:text-accent transition disabled:opacity-50"
        >
          <Upload size={14} />
          <span>Add</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          disabled={uploadAndAttach.isPending}
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>
      {uploadStatus}
      {paperwork && (
        <PaperworkConflicts slug={activeSlug} record={record} noun={paperwork.noun} conflicts={paperwork.conflicts} onChanged={refreshFields} />
      )}

      {preview && (
        <Modal open onClose={() => setPreview(null)} title={preview.filename} size="lg">
          <FilePreview
            src={api.fileRawUrl(activeSlug, preview.file_id, "original")}
            filename={preview.filename}
          />
        </Modal>
      )}

      {lightbox !== null && photos[lightbox] && (
        <ImageLightbox
          items={photos.map((ph) => ({
            key: ph.key,
            caption: ph.filename,
            ...(ph.fileId ? { file: { slug: activeSlug, fileId: ph.fileId } } : { url: ph.src }),
          }))}
          index={lightbox}
          onIndex={setLightbox}
          onClose={() => setLightbox(null)}
        />
      )}
    </section>
  );
}
