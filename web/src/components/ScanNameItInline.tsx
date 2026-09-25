// The one-field "name it yourself" for a scan nothing could name: the
// desktop card's line and the scanner's result sheet share it, so a store's
// own code can be named right where it was scanned (#3017). Naming it
// re-routes the row through the matchmaker like a typed item.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type ScanInboxItem } from "../lib/api";
import { scanInboxKeys } from "../lib/scan-inbox-keys";

/** Inline "name it yourself" for a scan that couldn't be auto-identified (a bare
 *  photo with no vision provider). Naming it triggers a server re-match, so the
 *  heuristic (or AI) suggests a table + fills fields — a one-field entry instead
 *  of a dead end. Stops click propagation so typing doesn't expand the card. */
export function ScanNameItInline({
  slug,
  itemId,
  onNamed,
  autoFocus,
  guess,
}: {
  slug: string;
  itemId: string;
  onNamed?: (item: ScanInboxItem) => void;
  autoFocus?: boolean;
  /** A name the lookup found and would not assert (a web guess held for
   *  want of a second source, #2918): offered as a tap above the field,
   *  with where it came from, so the right name is never retyped by hand.
   *  The tap writes the name exactly as typing it would. */
  guess?: { value: string; source: string; prompt: string } | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const mut = useMutation({
    mutationFn: (value: string) => api.updateScanItem(slug, itemId, { name: value.trim() }),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(slug) });
      toast.success("Got it - finding the right table…");
      onNamed?.(row);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
      {guess && (
        <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-amber-700 dark:text-amber-400" data-testid="name-guess">
          <span className="font-medium">{guess.prompt}</span>
          <button
            type="button"
            disabled={mut.isPending}
            onClick={() => mut.mutate(guess.value)}
            className="rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition disabled:opacity-50"
            title={`Name it "${guess.value}": ${guess.source}`}
          >
            {guess.value}
          </button>
          <span className="text-faint">{guess.source}</span>
        </div>
      )}
      {/* Wraps rather than overflows: an input's own minimum is its
          intrinsic width, so at 320px with larger text the pair ran Identify
          past the card. Now the input asks for 8rem and Identify takes the
          next line when both cannot fit (#3705). */}
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={guess ? "Or name it yourself" : "What is this? e.g. blue worsted yarn"}
          aria-label="Name this item"
          data-name-it={itemId}
          autoFocus={autoFocus}
          className="input !py-1 text-xs min-w-0 grow basis-32"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) mut.mutate(name);
          }}
        />
        <button
          type="button"
          disabled={!name.trim() || mut.isPending}
          onClick={() => mut.mutate(name)}
          className="shrink-0 rounded bg-cobble-600 text-white text-xs font-medium px-2.5 py-1 hover:bg-cobble-700 transition disabled:opacity-50"
        >
          Identify
        </button>
      </div>
    </div>
  );
}

