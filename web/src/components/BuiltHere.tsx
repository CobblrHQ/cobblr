// "What you built here": the trial ledger, read back on the sandbox's ending
// page (#3254). A list a person can read, in their own words for it, net of
// what they deleted and never the demo's stock, and honest about what stays.
// The same list, from the same read, is what the receiving side shows before
// it brings anything (CarryPage), so the two pages cannot disagree about it.
import { useEffect, useState } from "react";
import { api, type SandboxLedger } from "../lib/api";
import { countOf } from "@cobblr/platform-contract/plural";

/** Every line of the ledger as one sentence each, in the order a person would
 *  tell it: what they set up, then what they filled it with. */
export function ledgerLines(l: SandboxLedger): string[] {
  const lines: string[] = [];
  for (const b of l.bundles) lines.push(b.words);
  for (const m of l.modules) lines.push(m.words);
  for (const i of l.instances) lines.push(i.words);
  if (l.fields.length === 1) lines.push(l.fields[0]!.words);
  else if (l.fields.length > 1) lines.push(`Added ${l.fields.length} fields: ${l.fields.map((f) => f.display_label).join(", ")}`);
  if (l.automations.length === 1) lines.push(l.automations[0]!.words);
  else if (l.automations.length > 1) lines.push(`Set up ${l.automations.length} automations`);
  for (const r of l.records) lines.push(r.words);
  return lines;
}

/** The ending page's one line: "Bookshelf, Groceries · 4 items · 3 photos".
 *  The names of what they set up, then counts in the words people use, photos
 *  called photos. Null when they made nothing of their own. */
/** "A", "A and B", "A, B and C". */
function andList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export function addedSummary(l: SandboxLedger): string | null {
  const names = [...new Set([...l.bundles.map((b) => b.name), ...l.instances.map((i) => i.display_name), ...l.modules.map((m) => m.name)])];
  const items = l.records.reduce((n, r) => n + r.ids.length, 0);
  // What was set up, then what was added: "You set up Pantry and Spices, and
  // added 8 items." Photos, fields and automations are said only when there
  // is nothing bigger to say.
  const counts = items
    ? [countOf(items, "item")]
    : [
        ...[l.scans.reduce((n, s) => n + s.photo_file_ids.length, 0)].filter(Boolean).map((n) => countOf(n, "photo")),
        ...(l.fields.length ? [countOf(l.fields.length, "field")] : []),
        ...(l.automations.length ? [countOf(l.automations.length, "automation")] : []),
      ];
  const setUp = names.length ? `set up ${andList(names)}` : "";
  const added = counts.length ? `added ${andList(counts)}` : "";
  if (setUp && added) return `You ${setUp}, and ${added}.`;
  if (setUp || added) return `You ${setUp || added}.`;
  return null;
}

/** What the ending page shows of the ledger: one line, or one sentence when
 *  there is nothing. The full list (BuiltHere) is the receiving side's. */
export function AddedLine({ preview }: { preview?: SandboxLedger | null }) {
  const [ledger, setLedger] = useState<SandboxLedger | null | undefined>(preview);
  useEffect(() => {
    if (preview !== undefined) return;
    let gone = false;
    void api
      .sandboxLedger()
      .then((l) => !gone && setLedger(l))
      .catch(() => !gone && setLedger(null));
    return () => {
      gone = true;
    };
  }, [preview]);
  if (!ledger) return null;
  const summary = addedSummary(ledger);
  return (
    <p className="mt-4 text-sm text-content dark:text-mortar-100" data-testid="built-here">
      {summary ? (
        <span data-testid="built-lines">{summary}</span>
      ) : (
        <span className="text-muted" data-testid="built-nothing">
          You did not add anything of your own.
        </span>
      )}
    </p>
  );
}

export function BuiltHere({
  preview,
  heading = "What you built here",
  staysLabel = "Stays here",
}: {
  preview?: SandboxLedger | null;
  /** The receiving side reads the same list from elsewhere: "there". */
  heading?: string;
  staysLabel?: string;
}) {
  const [ledger, setLedger] = useState<SandboxLedger | null | undefined>(preview);
  useEffect(() => {
    if (preview !== undefined) return;
    // A box that cannot answer still has its doors; the list is just absent.
    let gone = false;
    void (async () => {
      try {
        const l = await api.sandboxLedger();
        if (!gone) setLedger(l);
      } catch {
        if (!gone) setLedger(null);
      }
    })();
    return () => {
      gone = true;
    };
  }, [preview]);
  if (!ledger) return null;
  const lines = ledgerLines(ledger);
  return (
    <section className="mt-6 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4" data-testid="built-here">
      <h2 className="text-[11px] uppercase tracking-widest text-accent">{heading}</h2>
      {lines.length === 0 ? (
        <p className="mt-1.5 text-sm text-muted" data-testid="built-nothing">
          Nothing of your own yet: the records here are the ones the sandbox came with.
        </p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm text-content dark:text-mortar-100" data-testid="built-lines">
          {lines.map((w) => (
            <li key={w} className="flex gap-2">
              <span aria-hidden className="text-faint">·</span>
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
      {ledger.left_behind.length > 0 && (
        <p className="mt-3 text-xs text-muted" data-testid="stays-here">
          {staysLabel}: {ledger.left_behind.join(", ")}.
        </p>
      )}
    </section>
  );
}
