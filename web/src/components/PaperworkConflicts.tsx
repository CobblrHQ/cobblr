// What a document put on a record did, said to the person who put it there.
//
// The toast says what was filled, with Undo, which takes back only what the
// paper wrote and only while it still reads that (#4523). Each field where the
// paper and the record disagree stays as the person had it, and is offered
// here: "Bill of sale says $14,300 (you have $14,000) · Use it".
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { ApiError, api, type PaperworkConflict, type PaperworkHeld, type PaperworkResult } from "../lib/api";

/** The document's name in a sentence. */
export function paperworkNoun(r: Extract<PaperworkResult, { read: true }>): string {
  return r.document === "bill-of-sale" ? "bill of sale" : "receipt";
}

/** What the toast says after a document was read onto a record. */
export function paperworkSentence(r: Extract<PaperworkResult, { read: true }>): string {
  const noun = paperworkNoun(r);
  const filled = r.filled.map((f) => f.label);
  const held = r.held?.length ?? 0;
  const what = filled.length ? `filled ${filled.join(", ")}` : held ? "nothing filled yet" : "nothing to fill, every field already had a value";
  const asked = r.conflicts.length ? ` ${r.conflicts.length === 1 ? "One field disagrees" : `${r.conflicts.length} fields disagree`}; it is below.` : "";
  const check = held ? ` ${held === 1 ? "One value" : `${held} values`} did not read clearly; check below.` : "";
  return `Read the ${noun}: ${what}.${asked}${check}`;
}

/** Tell the person, with Undo for what was filled. */
export function useAnnouncePaperwork(slug: string, record: { kind: string; id: string }, onChanged: () => void) {
  const toast = useToast();
  return (r: PaperworkResult) => {
    if (!r.read) return;
    const fills = r.filled;
    toast.success(paperworkSentence(r), {
      duration: 12000,
      ...(fills.length
        ? {
            actionLabel: "Undo",
            onAction: async () => {
              try {
                const u = await api.undoPaperwork(slug, { ...record, fills });
                onChanged();
                toast.info(u.undone.length ? "Taken back. The file stays on the record." : "Nothing to take back: those fields were changed since.");
              } catch (e) {
                toast.error(e instanceof ApiError ? e.message : "Couldn't take it back.");
              }
            },
          }
        : {}),
    });
  };
}

export function PaperworkConflicts({
  slug,
  record,
  noun,
  conflicts,
  held,
  waiting,
  onChanged,
}: {
  slug: string;
  record: { kind: string; id: string };
  /** "bill of sale", "receipt". */
  noun: string;
  conflicts: PaperworkConflict[];
  /** Values that failed their check, never written (#4633). */
  held?: PaperworkHeld[];
  /** The document AI could not read it now: said plainly. */
  waiting?: "busy" | "limit" | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState(false);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const takeHeld = useMutation({
    mutationFn: (h: PaperworkHeld & { field: string }) => {
      const said = (typed[h.field] ?? String(h.document)).trim();
      const value = typeof h.document === "number" && said !== "" && Number.isFinite(Number(said)) ? Number(said) : said;
      return api.takePaperworkValue(slug, { ...record, field: h.field, native: h.native, value });
    },
    onSuccess: (_r, h) => {
      setTaken((s) => new Set(s).add(`held:${h.field}`));
      onChanged();
      toast.success(`${h.label} set.`);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't change it."),
  });
  const take = useMutation({
    mutationFn: (c: PaperworkConflict) => api.takePaperworkValue(slug, { ...record, field: c.field, native: c.native, value: c.document }),
    onSuccess: (_r, c) => {
      setTaken((s) => new Set(s).add(c.field));
      onChanged();
      toast.success(`${c.label} is now ${c.shown_document}.`);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't change it."),
  });
  const open = conflicts.filter((c) => !taken.has(c.field));
  const doubts = (held ?? []).filter((h) => !h.field || !taken.has(`held:${h.field}`));
  if (dismissed || (open.length === 0 && doubts.length === 0 && !waiting)) return null;
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  return (
    <div data-testid="paperwork-conflicts" className="mt-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-100 space-y-1">
      {waiting && (
        <p data-testid="paperwork-waiting" className="text-xs">
          {waiting === "limit"
            ? "The AI couldn't read this now: its daily limit is used up. It reads it again when it can, or tap Read again."
            : "Every AI that reads documents is busy. It reads this again when one is free, or tap Read again."}
        </p>
      )}
      {doubts.length > 0 && (
        <div data-testid="paperwork-held" className="space-y-1">
          <div className="text-xs font-medium">Please check: these did not read clearly, so nothing was written</div>
          {doubts.map((h) => (
            <div key={`${h.check}:${h.field ?? h.label}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs">
                {h.label} read as “{h.shown_document}”
              </span>
              {h.field && (
                <>
                  <input
                    aria-label={h.label}
                    // DRAFT-OK: the page's read, offered once to correct; the record's field is empty and nothing else moves it while this is open
                    defaultValue={String(h.document)}
                    onChange={(e) => setTyped((t) => ({ ...t, [h.field!]: e.target.value }))}
                    className="min-w-0 w-40 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-1.5 py-0.5 text-xs text-content dark:text-mortar-100"
                  />
                  <button
                    type="button"
                    onClick={() => takeHeld.mutate(h as PaperworkHeld & { field: string })}
                    disabled={takeHeld.isPending}
                    className="rounded px-2 py-0.5 text-xs font-medium text-accent hover:underline disabled:opacity-50"
                  >
                    Use it
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {open.map((c) => (
        <div key={c.field} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {Noun} says {c.label} {c.shown_document} (you have {c.shown_current})
          </span>
          <button
            type="button"
            onClick={() => take.mutate(c)}
            disabled={take.isPending}
            className="rounded px-2 py-0.5 text-xs font-medium text-accent hover:underline disabled:opacity-50"
          >
            Use it
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setDismissed(true)} className="text-xs text-muted hover:underline">
        Keep mine
      </button>
    </div>
  );
}
