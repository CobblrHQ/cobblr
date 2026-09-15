// The "Your photos" column of the scan card's picture strip (#3046): the
// row's OWN pictures from the one resolver (lib/rowPictures.ts), a tile
// each, the current one outlined, and never an empty column. A split child
// shows its crop and the group shot it was cut from, badged "group", with
// "crop again" beside it; an ordinary row shows its own photo and the
// photos added to it. The column used to render extra_photos alone, so a
// row without extras drew an empty labelled column on the desk, and a
// split child, whose pictures are exactly the ones a person wants to
// re-crop from, showed nothing.
import { useState } from "react";
import { ImageIcon, RotateCcw, Scissors, X } from "lucide-react";
import { useImageSrc } from "@cobblr/platform-web";
import { rowPictures, yourPictures, type RowPicture } from "../lib/rowPictures";
import type { PictureRow } from "@cobblr/platform-contract/scan-pictures";

export interface YourPhotosActions {
  /** Open the viewer on this picture. */
  onView?: (p: RowPicture) => void;
  /** Make an added photo the catalog picture. */
  onMakePrimary?: (fileId: string) => void;
  /** Remove an added photo. */
  onRemove?: (fileId: string) => void;
  /** Re-run the identify from an added photo (pending rows only). */
  onReidentify?: (fileId: string) => void;
  /** Cut the split child again from its group shot. */
  onCropAgain?: () => void;
  busy?: boolean;
}

/** The column, or null when the row has no picture of its own: the caller
 *  then draws no column and no label, on a phone and on a desk alike. */
export function ScanYourPhotos({ slug, row, actions }: { slug: string; row: PictureRow; actions: YourPhotosActions }) {
  const { pictures, src } = rowPictures(slug, row);
  const yours = yourPictures(pictures);
  if (yours.length === 0) return null;
  return (
    <div className="flex items-center gap-2" data-testid="your-photos">
      {yours.map((p) => (
        <YourPhotoTile key={p.key} picture={p} src={src(p, "thumb")} actions={actions} />
      ))}
      {/* just a vertical line */}
      <div className="w-px self-stretch shrink-0 bg-line dark:bg-slate-700 mx-1.5" />
    </div>
  );
}

function YourPhotoTile({ picture: p, src: raw, actions }: { picture: RowPicture; src: string | null; actions: YourPhotosActions }) {
  const src = useImageSrc(raw);
  const [broken, setBroken] = useState(false);
  const fileId = p.fileId ?? "";
  const canPrimary = p.role === "extra" && !!actions.onMakePrimary;
  const title =
    p.role === "group"
      ? "The group photo this was cut from"
      : p.role === "crop"
        ? p.caption
        : canPrimary
          ? "Make this the primary photo"
          : p.caption;
  return (
    <div className="relative w-20 h-20 shrink-0" data-testid={`your-photo-${p.role}`} data-current={p.current ? "" : undefined}>
      <button
        type="button"
        disabled={actions.busy}
        onClick={() => (canPrimary ? actions.onMakePrimary?.(fileId) : actions.onView?.(p))}
        title={title}
        aria-current={p.current ? "true" : undefined}
        className={`w-20 h-20 rounded-md overflow-hidden border border-line dark:border-slate-700 bg-black flex items-center justify-center disabled:opacity-50 ${p.current ? "outline outline-2 outline-offset-1 outline-accent" : ""}`}
      >
        {/* CONTAIN: this tile is how you decide WHICH of your photos should
            lead, so it has to show the whole shot rather than its middle. */}
        {src && !broken ? <img src={src} alt="" className="w-full h-full object-contain" onError={() => setBroken(true)} /> : <ImageIcon size={16} className="text-faint" />}
      </button>
      {p.role === "group" && (
        <span className="absolute top-1 left-1 rounded bg-black/60 text-white text-[10px] leading-none px-1 py-0.5 pointer-events-none">group</span>
      )}
      {p.role === "group" && actions.onCropAgain && (
        <button
          type="button"
          disabled={actions.busy}
          onClick={actions.onCropAgain}
          title="Crop again from the group photo"
          aria-label="Crop again"
          className="absolute bottom-1 right-1 rounded bg-black/60 hover:bg-cobble-600 text-white shadow-md w-6 h-6 flex items-center justify-center disabled:opacity-50"
        >
          <Scissors size={13} strokeWidth={2.5} />
        </button>
      )}
      {p.role === "extra" && actions.onRemove && (
        <button
          type="button"
          disabled={actions.busy}
          onClick={() => actions.onRemove?.(fileId)}
          title="Remove this photo"
          className="absolute top-1 right-1 rounded bg-black/60 hover:bg-ember-600 text-white shadow-md w-6 h-6 flex items-center justify-center disabled:opacity-50"
        >
          <X size={13} strokeWidth={2.5} />
        </button>
      )}
      {p.role === "extra" && actions.onReidentify && (
        <button
          type="button"
          disabled={actions.busy}
          onClick={() => actions.onReidentify?.(fileId)}
          title="Re-identify the item from this photo"
          aria-label="Re-identify from this photo"
          className="absolute bottom-1 right-1 rounded bg-black/60 hover:bg-cobble-600 text-white shadow-md w-6 h-6 flex items-center justify-center disabled:opacity-50"
        >
          <RotateCcw size={13} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}
