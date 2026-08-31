// Register a bin the way you actually meet one: standing in front of it, phone
// in hand. Photograph it, say what is in it, done — the bin exists, with that
// photo, under that name.
//
// WHY THE NAME IS WHAT YOU SAID, VERBATIM. "toy guitars and nerf" is already
// the answer to "what is in this bin"; running it past a model to make it
// tidier would cost a round trip, a dependency on AI being configured, and the
// chance of coming back with something you did not say. Capitalisation is the
// only thing done for you.
//
// WHY THERE IS NO NEW PRINTING MACHINERY HERE. The label half was already
// built and is left exactly where it lives: a wire
// (core-locations.location.created → labels:print) queues a QR label for the
// new bin, and the queue's own auto-print policy decides what happens next —
// straight to a server printer, or through the Live box's client loop for a
// Bluetooth one. So the switch below CREATES THAT WIRE and nothing else; it is
// a connection, not a feature. Off until you turn it on, like every opt-in.
//
// One caveat worth knowing: labels:print refuses to queue when the workspace
// has no label base URL, because a QR printed by an automation with nowhere to
// point can never be fixed after printing. The sheet says so rather than
// leaving you to wonder why nothing printed.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Printer, X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type Location, type PlatformBinding } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { CameraCaptureSheet } from "../components/CameraCaptureSheet";
import { SidePanel } from "../components/SidePanel";

/** The wire that turns "a bin was created" into "a label is queued for it". */
export const BIN_LABEL_WIRE = {
  source_kind: "core-locations:location",
  action_id: "labels:print",
  trigger_type: "event" as const,
  trigger_event: "core-locations.location.created",
};

/** Find the auto-label wire among a workspace's bindings, if it has one. */
export function findBinLabelWire(bindings: PlatformBinding[]): PlatformBinding | null {
  return (
    bindings.find(
      (b) =>
        b.action_id === BIN_LABEL_WIRE.action_id &&
        b.trigger_event === BIN_LABEL_WIRE.trigger_event &&
        b.source_kind === BIN_LABEL_WIRE.source_kind,
    ) ?? null
  );
}

/** The name a phrase becomes. Verbatim, minus the things a phone adds: stray
 *  spaces, and a lowercase first letter from dictation. */
export function binNameFrom(caption: string): string {
  const t = caption.replace(/\s+/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : "";
}

export function NewBinSheet({
  open,
  onClose,
  parentId = null,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Where the bin lives, when the caller knows (a room's page). */
  parentId?: string | null;
  onCreated?: (bin: Location) => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [shooting, setShooting] = useState(false);
  const [photo, setPhoto] = useState<{ url: string; preview: string } | null>(null);
  const [caption, setCaption] = useState("");
  const captionRef = useRef<HTMLInputElement>(null);

  const bindings = useQuery({
    queryKey: ["bindings", activeSlug],
    queryFn: () => api.listBindings(activeSlug),
    enabled: !!activeSlug && open,
  });
  const wire = findBinLabelWire(bindings.data?.items ?? []);

  // Opening the sheet goes straight to the camera: the photo is the reason you
  // are here, and a sheet that opens on an empty form makes you press twice.
  useEffect(() => {
    if (open && !photo) setShooting(true);
  }, [open, photo]);

  useEffect(() => {
    if (!open) {
      setPhoto(null);
      setCaption("");
      setShooting(false);
    }
  }, [open]);

  const upload = useMutation({
    mutationFn: async (blob: Blob) => {
      const file = new File([blob], `bin-${Date.now()}.jpg`, { type: blob.type || "image/jpeg" });
      const rec = await api.uploadFile(activeSlug, file);
      return { url: api.fileRawUrl(activeSlug, rec.id, "medium"), preview: URL.createObjectURL(blob) };
    },
    onSuccess: (p) => {
      setPhoto(p);
      setShooting(false);
      // The phrase is the next thing you do, so put the cursor there. On a
      // phone that also puts the keyboard's mic one tap away, which is as
      // close to "just say it" as a browser gets on iOS.
      requestAnimationFrame(() => captionRef.current?.focus());
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't upload that photo."),
  });

  const create = useMutation({
    mutationFn: async () => {
      const name = binNameFrom(caption);
      return api.createLocation(activeSlug, {
        name,
        kind: "container",
        parent_id: parentId,
        ...(photo ? { image_path: photo.url } : {}),
      });
    },
    onSuccess: (bin) => {
      void qc.invalidateQueries({ queryKey: ["locations", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["labels-queue", activeSlug] });
      toast.success(wire ? `${bin.name} created. Its label is queued.` : `${bin.name} created.`);
      onCreated?.(bin);
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't create that bin."),
  });

  const toggleWire = useMutation({
    mutationFn: async () => {
      if (wire) return api.deleteBinding(activeSlug, wire.id);
      return api.createBinding(activeSlug, BIN_LABEL_WIRE);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["bindings", activeSlug] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't change that setting."),
  });

  if (!open) return null;
  const name = binNameFrom(caption);

  return (
    <>
      <CameraCaptureSheet
        open={shooting}
        title="Photograph the bin"
        busy={upload.isPending}
        onCapture={(blob) => upload.mutate(blob)}
        onClose={() => {
          setShooting(false);
          if (!photo) onClose();
        }}
      />
      {!shooting && (
        <SidePanel width="sm:w-[min(100vw,440px)]">
          <header className="flex items-center justify-between px-4 py-3 border-b border-line dark:border-slate-700 shrink-0">
            <div className="text-sm font-semibold text-content dark:text-mortar-100">New bin</div>
            <button type="button" onClick={onClose} className="text-faint hover:text-content" aria-label="Close">
              <X size={18} />
            </button>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {photo && (
              <button
                type="button"
                onClick={() => setShooting(true)}
                className="block w-full rounded-lg overflow-hidden border border-line dark:border-slate-700"
                title="Take it again"
              >
                <img src={photo.preview} alt="the bin" className="w-full max-h-56 object-cover" />
              </button>
            )}
            <label className="block">
              <span className="text-[10px] font-mono uppercase tracking-widest text-accent block mb-1">
                what is in it
              </span>
              <input
                ref={captionRef}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name && !create.isPending) create.mutate();
                }}
                placeholder="toy guitars and nerf"
                enterKeyHint="done"
                data-testid="new-bin-caption"
                className="w-full rounded-lg border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-base sm:text-sm"
              />
              <span className="mt-1 block text-[11px] text-faint dark:text-slate-500">
                This is the bin's name, exactly as you say it.
              </span>
            </label>

            <button
              type="button"
              onClick={() => toggleWire.mutate()}
              disabled={toggleWire.isPending || bindings.isLoading}
              data-testid="new-bin-autolabel"
              aria-pressed={!!wire}
              className="w-full flex items-start gap-3 rounded-lg border border-line dark:border-slate-700 px-3 py-2.5 text-left hover:border-cobble-300 transition disabled:opacity-50"
            >
              <span
                className={
                  "mt-0.5 h-4 w-4 shrink-0 rounded border flex items-center justify-center " +
                  (wire ? "bg-cobble-600 border-cobble-600 text-white" : "border-line dark:border-slate-600")
                }
              >
                {wire && <Check size={12} />}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm text-content dark:text-mortar-100">
                  <Printer size={13} className="text-accent" /> Print a label for every new bin
                </span>
                <span className="block text-[11px] text-muted dark:text-slate-400 mt-0.5">
                  Queues a QR label as soon as a bin is created. Your label queue's auto-print
                  setting decides whether it prints straight away.
                </span>
              </span>
            </button>
          </div>
          <div className="border-t border-line dark:border-slate-700 p-3 shrink-0 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShooting(true)}
              className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-content transition"
            >
              <Camera size={13} /> {photo ? "retake" : "photo"}
            </button>
            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={!name || create.isPending}
              data-testid="new-bin-create"
              className="ml-auto rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-4 py-2 text-sm transition disabled:opacity-50"
            >
              {create.isPending ? "creating…" : "Create bin"}
            </button>
          </div>
        </SidePanel>
      )}
    </>
  );
}
