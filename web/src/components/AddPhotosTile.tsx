// The home dashboard's Photos tile: the scan inbox's image picker, one tap
// from the first screen (#3042).
//
// The owner takes pictures of labels on a phone and later wants them in the
// scan inbox; the only door was home → scan inbox → the picker. This tile
// opens that same picker (components/ScanPhotoPicker.tsx, the one input and
// the one intake the inbox renders) from the dashboard: pick the photos,
// they land as ONE new scan session with identify running, and the page
// goes to the inbox with that session in view. The PWA's "Add photos"
// shortcut lands on the inbox with the same door held out (?pick=photos).
import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ImagePlus, Loader2 } from "lucide-react";
import { useAiStatus } from "./AiStatusNotice";
import { ScanPickerInput, useScanIntake } from "./ScanPhotoPicker";

export function AddPhotosTile({ slug, className, compact }: { slug: string; className?: string; /** The short label for a row of buttons ("Photos"), the tile's own otherwise. */ compact?: boolean }) {
  const navigate = useNavigate();
  const aiStatus = useAiStatus();
  const pickerRef = useRef<HTMLInputElement>(null);
  const intake = useScanIntake(slug, {
    session: "fresh",
    identifyAvailable: aiStatus?.identify_available,
    // The selection is in: open the inbox on exactly that session. A batch
    // that could not be minted still landed its photos; the inbox shows them
    // in the standing group.
    onDone: ({ batchId, ok }) => {
      if (ok > 0) navigate(batchId ? `/scan?batch=${batchId}` : "/scan");
    },
  });
  const label = intake.uploading
    ? intake.uploadProgress
      ? `Adding ${intake.uploadProgress.done}/${intake.uploadProgress.total}…`
      : "Adding…"
    : compact
      ? "Photos"
      : "Add photos";
  return (
    <>
      <button
        type="button"
        onClick={() => pickerRef.current?.click()}
        disabled={intake.uploading}
        data-testid={compact ? "add-photos-button" : "add-photos-tile"}
        aria-label="Add photos"
        title="Pick photos from this device; they land in the scan inbox as one session and get identified"
        className={
          className ??
          "flex items-center justify-between gap-2 rounded-xl border border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30 px-4 py-3 text-sm font-medium text-content dark:text-mortar-100 hover:border-accent active:scale-[0.99] transition disabled:opacity-60"
        }
      >
        {compact && (intake.uploading ? <Loader2 size={15} className="animate-spin shrink-0" /> : <ImagePlus size={15} className="shrink-0" />)}
        <span className="truncate">{label}</span>
        {!compact && (intake.uploading ? <Loader2 size={16} className="animate-spin text-accent shrink-0" /> : <ImagePlus size={16} className="text-accent shrink-0" />)}
      </button>
      <ScanPickerInput ref={pickerRef} onFiles={intake.takeFiles} testId={compact ? "add-photos-button-picker" : "add-photos-picker"} />
      {intake.sheet}
    </>
  );
}
