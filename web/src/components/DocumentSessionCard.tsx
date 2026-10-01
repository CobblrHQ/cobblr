// The document an inbox session was read from, shown as what it is: its first
// page (or the photo), its file name, and where the reading stands, in words.
//
// A dropped bill of sale that could not be read used to sit in the inbox as
// "not read yet · Oct 1" with a pencil and "+ #": nothing on the row said it
// was the PDF just dropped, and the owner could not tell it was an inbox row
// at all. The picture is there whether or not the read worked, because the
// file is kept either way; tapping it opens the original.
import { useQuery } from "@tanstack/react-query";
import { DocThumb, useImageSrc } from "@cobblr/platform-web";
import { api } from "../lib/api";

/** The file a session came from, shared by the row's title and this card. */
export function sessionFileKey(slug: string, fileId: string) {
  return ["scan-session-file", slug, fileId] as const;
}

export function useSessionFile(slug: string, fileId: string | null) {
  return useQuery({
    queryKey: sessionFileKey(slug, fileId ?? ""),
    queryFn: () => api.getFile(slug, fileId!),
    enabled: !!fileId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function DocumentSessionCard({
  slug,
  fileId,
  state,
  onOpen,
}: {
  slug: string;
  fileId: string;
  /** Where the reading stands, in words ("Couldn't read yet"). */
  state: string | null;
  onOpen: (fileId: string) => void;
}) {
  const file = useSessionFile(slug, fileId).data;
  const isPhoto = file?.kind === "image" && !!file.variants?.thumb;
  const photo = useImageSrc(isPhoto ? api.fileRawUrl(slug, fileId, "thumb") : null);
  const name = file?.filename ?? "Document";
  return (
    <div
      data-testid="document-session-card"
      className="flex items-center gap-3 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2"
    >
      {isPhoto ? (
        <button
          type="button"
          onClick={() => onOpen(fileId)}
          title={name}
          className="block h-20 w-16 shrink-0 overflow-hidden rounded border border-line dark:border-slate-700 bg-mortar-50/60 dark:bg-slate-800"
        >
          {/* photo-frame: the receipt photo a session was read from, shown whole */}
          {photo && <img src={photo} alt={`Photo of ${name}`} className="h-full w-full object-contain" />}
        </button>
      ) : (
        <DocThumb
          src={api.fileRawUrl(slug, fileId, "original")}
          filename={name}
          width={64}
          onOpen={() => onOpen(fileId)}
          className="h-20 w-16 shrink-0 rounded border border-line dark:border-slate-700"
        />
      )}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onOpen(fileId)}
          className="block max-w-full truncate text-left text-sm font-medium text-content dark:text-mortar-100 hover:text-accent"
          title={`Open ${name}`}
        >
          {name}
        </button>
        {state && (
          <div data-testid="document-session-state" className="text-xs text-muted">
            {state}
          </div>
        )}
      </div>
    </div>
  );
}
