// The box you type a thing into, with the other two ways in beside it
// (photos you already took, and the camera or a paired phone). The
// dashboard's "Just add it" and the palette's "Add a thing" sheet are this.
import { useState } from "react";
import { Link } from "react-router-dom";
import { Camera, Loader2, Plus } from "lucide-react";
import { AddPhotosTile } from "./AddPhotosTile";
import { PairPhoneButton } from "./PairPhoneButton";
import { useIsTouch } from "../lib/useIsTouch";
import type { useAddByWords } from "../lib/useAddByWords";

const SIDE = "shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-1.5 text-sm font-medium text-content dark:text-mortar-100 hover:border-cobble-300 dark:hover:border-cobble-700 transition";

export function FreeformAdd({
  slug,
  placeholder,
  add,
  autoFocus,
  onAdded,
}: {
  slug: string;
  placeholder: string;
  add: ReturnType<typeof useAddByWords>;
  autoFocus?: boolean;
  onAdded?: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const isTouch = useIsTouch();
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    add.mutate(t, {
      onSuccess: () => {
        setText("");
        onAdded?.(t);
      },
    });
  };
  return (
    <>
      <div className="relative mb-2">
        <Plus size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          aria-label="What have you got?"
          autoFocus={autoFocus}
          className="input !pl-8 !py-1.5 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!text.trim() || add.isPending}
          onClick={submit}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-cobble-300 dark:border-cobble-700 bg-surface dark:bg-slate-900 text-content dark:text-mortar-100 text-sm font-medium px-3 py-1.5 hover:border-cobble-400 transition disabled:opacity-50"
        >
          {add.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add it
        </button>
        {/* Photos already taken: the scan inbox's picker, right here beside
            the camera (#3042). One tap, the same intake. */}
        <AddPhotosTile slug={slug} className={`${SIDE} disabled:opacity-60`} compact />
        {isTouch ? (
          <Link data-tour="capture-scan" to="/scan/camera" title="Scan a barcode or snap a photo" className={SIDE}>
            <Camera size={15} /> Scan
          </Link>
        ) : (
          <PairPhoneButton dataTour="capture-scan" className={SIDE} />
        )}
      </div>
    </>
  );
}
