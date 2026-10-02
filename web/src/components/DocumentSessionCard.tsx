// The document an inbox session was read from, shown as what it is: its first
// page (or the photo), its name, and where the reading stands, in words.
//
// Two sizes, one rule (platform-contract scan-source, #4581): a document that
// needs the person (it could not be read, it read into nothing, it waits on
// the AI) is the full card under the header; one that needs nothing is a chip
// IN the header ("eBay email · 1 line") that opens the same viewer. A card
// for a read email above its one item spent the screen on nothing.
//
// A dropped bill of sale that could not be read used to sit in the inbox as
// "not read yet · Oct 1" with a pencil and "+ #": nothing on the row said it
// was the PDF just dropped, and the owner could not tell it was an inbox row
// at all. The picture is there whether or not the read worked, because the
// file is kept either way; tapping it opens the original.
import { useQuery } from "@tanstack/react-query";
import { Bot, FileText, KeyRound, Mail } from "lucide-react";
import type { AddedBy } from "@cobblr/platform-contract/scan-source";
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
  name,
  state,
  onOpen,
}: {
  slug: string;
  fileId: string;
  /** What the document is ("Email from eBay, Aug 12"), never a file name
   *  the platform made up (sessionDocumentName). */
  name: string;
  /** Where the reading stands, in words ("Couldn't read yet"). */
  state: string | null;
  onOpen: (fileId: string) => void;
}) {
  const file = useSessionFile(slug, fileId).data;
  const isPhoto = file?.kind === "image" && !!file.variants?.thumb;
  const photo = useImageSrc(isPhoto ? api.fileRawUrl(slug, fileId, "thumb") : null);
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

/** The document as a chip in the session's header: a tiny first page for a
 *  PDF or a photo, a page icon otherwise, and what it is with its lines. The
 *  words stand down on a phone; the picture is still the tap. */
export function SessionDocumentChip({
  slug,
  fileId,
  name,
  words,
  onOpen,
}: {
  slug: string;
  fileId: string;
  name: string;
  /** "eBay email · 1 line" (documentChipWords). */
  words: string;
  onOpen: (fileId: string) => void;
}) {
  const file = useSessionFile(slug, fileId).data;
  const isPhoto = file?.kind === "image" && !!file.variants?.thumb;
  const isPdf = file?.mime_type === "application/pdf";
  const photo = useImageSrc(isPhoto ? api.fileRawUrl(slug, fileId, "thumb") : null);
  return (
    <button
      type="button"
      data-testid="session-document-chip"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(fileId);
      }}
      title={`Open ${name}`}
      aria-label={`Open ${name}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-1.5 py-0.5 text-muted hover:text-accent hover:border-accent transition max-sm:border-0 max-sm:bg-transparent max-sm:px-0.5"
    >
      {isPhoto && photo ? (
        // photo-frame: the receipt photo the session was read from, tiny
        <img src={photo} alt="" className="h-4 w-3 shrink-0 rounded-sm object-cover" />
      ) : isPdf ? (
        <span className="h-4 w-3 shrink-0 overflow-hidden rounded-sm border border-line dark:border-slate-700">
          <DocThumb src={api.fileRawUrl(slug, fileId, "original")} filename={name} width={24} className="h-full w-full" />
        </span>
      ) : (
        <FileText size={12} aria-hidden className="shrink-0" />
      )}
      <span className="whitespace-nowrap max-sm:hidden">{words}</span>
    </button>
  );
}

/** Who added a session, once, in its header ("Added by Claude"). A tap says
 *  when and through which connection. */
export function SessionAddedByChip({ by, words, open, onToggle }: { by: AddedBy; words: string; open: boolean; onToggle: () => void }) {
  const Icon = by.kind === "email" ? Mail : by.kind === "token" ? KeyRound : Bot;
  return (
    <button
      type="button"
      data-testid="session-added-by"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={open}
      title={words}
      className="inline-flex min-w-0 shrink-[100000] items-center gap-1 text-cobble-700 dark:text-cobble-300 hover:text-accent transition"
    >
      <Icon size={12} aria-hidden className="shrink-0" />
      <span className="truncate max-sm:hidden">{words}</span>
    </button>
  );
}
