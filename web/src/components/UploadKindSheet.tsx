// "A photo, or a receipt?" for an image handed to the inbox's one upload door,
// asked ONLY when no AI here can look at an image.
//
// The inbox's promise is "upload anything and it figures out what it is". The
// intake runs an identify on every image server-side, and that step tells a
// photographed receipt from a photographed product and sends the receipt to
// the receipt parser itself (core-scan's receipt-photo.ts). #2845 put this
// question in front of every upload because nothing CLIENT-side can tell the
// two apart (docs/design-decisions/receipt-from-a-photo.md, measured); true,
// and the wrong door: the platform can, and the ask moved its decision onto
// the person on every upload (#2882). So this component decides, not the
// page: while an image-capable AI exists (`identify_available`, hosted,
// workspace or personal) the images go straight through as photos and the
// sheet never mounts; only a workspace with none is asked, and told why. A
// PDF or CSV is only ever a receipt and never reaches here; the menu's
// explicit "Upload a receipt photo" door stays for a person who wants to
// force it, and a card's "Read as a receipt" repairs a missed verdict.
import { useEffect, useState } from "react";
import { Camera, ReceiptText } from "lucide-react";
import { Modal } from "@cobblr/platform-web";

export type UploadKind = "photo" | "receipt";
const REMEMBER_KEY = "cobblr.scan.uploadKind";

/** The last answer this session, or null the first time. */
export function rememberedUploadKind(): UploadKind | null {
  try {
    const v = sessionStorage.getItem(REMEMBER_KEY);
    return v === "photo" || v === "receipt" ? v : null;
  } catch {
    return null;
  }
}
export function rememberUploadKind(kind: UploadKind): void {
  try {
    sessionStorage.setItem(REMEMBER_KEY, kind);
  } catch {
    /* a private window; the question is asked again, which is fine */
  }
}

/** Does the door have to ask? Only when the workspace has been told, in so
 *  many words, that nothing can look at an image. Unknown (the status still
 *  loading) is not "no": the intake handles the no-AI case with a nameless
 *  card that says so, which costs less than a wrong question. */
export function uploadDoorMustAsk(identifyAvailable: boolean | undefined): boolean {
  return identifyAvailable === false;
}

export function UploadKindSheet({
  files,
  identifyAvailable,
  onPhotos,
  onReceipt,
  onClose,
}: {
  /** The images to route; empty means nothing pending. */
  files: File[];
  /** `identify_available` from /ai-status: an AI that can look at an image
   *  exists for this person here. */
  identifyAvailable: boolean | undefined;
  onPhotos: (files: File[]) => void;
  /** Called once per image: each receipt is its own session. */
  onReceipt: (file: File) => void;
  onClose: () => void;
}) {
  const pending = files.length > 0;
  const ask = pending && uploadDoorMustAsk(identifyAvailable);
  // The platform can look: the images go in as photos and the identify
  // verdict routes a receipt on the server. No sheet, no tap.
  useEffect(() => {
    if (pending && !ask) {
      onPhotos(files);
      onClose();
    }
  }, [files, ask]);
  const [preferred, setPreferred] = useState<UploadKind>("photo");
  useEffect(() => {
    if (ask) setPreferred(rememberedUploadKind() ?? "photo");
  }, [ask]);
  if (!ask) return null;
  const choose = (kind: UploadKind) => {
    rememberUploadKind(kind);
    if (kind === "photo") onPhotos(files);
    else for (const f of files) onReceipt(f);
    onClose();
  };
  const n = files.length;
  const noun = n === 1 ? "this image" : `these ${n} images`;
  const btn = (primary: boolean) =>
    `flex-1 min-w-0 flex flex-col items-center gap-1.5 rounded-xl border px-3 py-4 text-sm font-medium transition ${
      primary
        ? "border-cobble-600 bg-cobble-600 text-white hover:bg-cobble-700"
        : "border-line dark:border-slate-700 text-content hover:bg-subtle dark:hover:bg-slate-800/70"
    }`;
  return (
    <Modal
      open
      onClose={onClose}
      title={`What is ${noun}?`}
      subtitle="Nothing here can look at an image yet"
      size="sm"
    >
      <p className="mb-3 text-xs text-muted">
        So the inbox cannot tell a receipt from a photo of something on its own. Connect an AI provider (Configuration → AI, or your own under
        Account) and it works this out itself.
      </p>
      <div className="flex gap-3">
        <button type="button" autoFocus={preferred === "photo"} onClick={() => choose("photo")} className={btn(preferred === "photo")} data-testid="upload-kind-photo">
          <Camera size={22} />
          A photo of something
          <span className="text-[11px] font-normal opacity-80">named and filed as one item</span>
        </button>
        <button type="button" autoFocus={preferred === "receipt"} onClick={() => choose("receipt")} className={btn(preferred === "receipt")} data-testid="upload-kind-receipt">
          <ReceiptText size={22} />
          A receipt
          <span className="text-[11px] font-normal opacity-80">split into its lines, reviewed before filing</span>
        </button>
      </div>
      <p className="mt-3 text-[11px] text-muted">Your last answer is preselected for the rest of this session.</p>
    </Modal>
  );
}
