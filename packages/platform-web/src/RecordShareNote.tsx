// On a copy in a share space: "Sam changed Colour since you edited: now red"
// (docs/design-decisions/share-spaces.md §11). Your edit still waits for
// them; this says theirs moved on, so you are not surprised by what they
// decide. Says nothing on any record that is not such a copy.

import { useQuery } from "@tanstack/react-query";
import { GitCompare } from "lucide-react";
import { usePlatformWeb } from "./context";

export function RecordShareNote({ kind, id }: { kind: string; id: string }) {
  const { api, orgSlug } = usePlatformWeb();
  const q = useQuery({
    queryKey: ["copy-notes", orgSlug, kind, id],
    queryFn: () => api.copyNotes!(orgSlug, kind, id),
    enabled: !!api.copyNotes,
    staleTime: 30_000,
  });
  const notes = q.data?.notes ?? [];
  if (!notes.length) return null;
  const who = q.data?.from ?? "The person who shared this";
  return (
    <div data-testid="record-share-note" className="order-first w-full basis-full space-y-1 rounded-lg border border-line bg-subtle px-3 py-2 text-sm text-content dark:border-slate-600">
      {notes.map((n) => (
        <p key={n.field} className="flex items-baseline gap-2">
          <GitCompare size={14} className="shrink-0 text-muted" aria-hidden />
          <span>
            {who} changed {n.label} since you edited: theirs is now <span data-testid="share-note-theirs">{n.theirs ?? "(empty)"}</span>. Your edit waits for them.
          </span>
        </p>
      ))}
    </div>
  );
}
