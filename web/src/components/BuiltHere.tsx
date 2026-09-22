// "What you built here": the trial ledger, read back on the sandbox's ending
// page (#3254). A list a person can read, in their own words for it, net of
// what they deleted and never the demo's stock, and honest about what stays.
// The same list is the picker for bringing it along once the replay exists.
import { useEffect, useState } from "react";
import { api, type SandboxLedger } from "../lib/api";

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

export function BuiltHere({ preview }: { preview?: SandboxLedger | null }) {
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
      <h2 className="text-[11px] font-mono uppercase tracking-widest text-accent">What you built here</h2>
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
          Stays here: {ledger.left_behind.join(", ")}.
        </p>
      )}
    </section>
  );
}
