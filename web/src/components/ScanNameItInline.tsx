// The one-field "name it yourself" for a scan nothing could name: the
// desktop card's line and the scanner's result sheet share it, so a store's
// own code can be named right where it was scanned (#3017). Naming it
// re-routes the row through the matchmaker like a typed item.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type ScanInboxItem } from "../lib/api";

/** Inline "name it yourself" for a scan that couldn't be auto-identified (a bare
 *  photo with no vision provider). Naming it triggers a server re-match, so the
 *  heuristic (or AI) suggests a table + fills fields — a one-field entry instead
 *  of a dead end. Stops click propagation so typing doesn't expand the card. */
export function ScanNameItInline({ slug, itemId, onNamed, autoFocus }: { slug: string; itemId: string; onNamed?: (item: ScanInboxItem) => void; autoFocus?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const mut = useMutation({
    mutationFn: () => api.updateScanItem(slug, itemId, { name: name.trim() }),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      toast.success("Got it - finding the right table…");
      onNamed?.(row);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <div className="mt-1.5 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="What is this? e.g. blue worsted yarn"
        aria-label="Name this item"
        autoFocus={autoFocus}
        className="input !py-1 text-xs flex-1"
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) mut.mutate();
        }}
      />
      <button
        type="button"
        disabled={!name.trim() || mut.isPending}
        onClick={() => mut.mutate()}
        className="shrink-0 rounded bg-cobble-600 text-white text-xs font-medium px-2.5 py-1 hover:bg-cobble-700 transition disabled:opacity-50"
      >
        Identify
      </button>
    </div>
  );
}

