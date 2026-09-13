// What a plan saw and left alone, on the card that offers it: a sentence
// when there is one to say ("2 of the 7 tea are on this page; the other 5
// stay where they are"), then the block of records it could not place under
// a label that says what the block is and how many ("Left in Inventory,
// could not tell (6):"), each record the same chip a reply draws, then what
// sending the message would do about them. The offer strip and the reply
// card both draw this, so the two can never say it differently.
//
// The block is a disclosure. Open by default when it is short (8 or fewer);
// past that it opens on a press into a scrollable list, so a page of four
// hundred does not become a card of four hundred. The continuation sits
// under the label either way: what Enter does about them is worth knowing
// before the list is opened. A sentence over an unlabelled list had the
// person asking why the records were listed at all (the owner, 2026-09-13,
// #2947 then #2976).

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ChatRefChip } from "./ChatRefChip";

export interface PlanNoteRecord {
  id: string;
  title: string;
  kind?: string;
  /** What kept it out, when the label does not already say. */
  why?: string;
}

/** The block opens on its own up to this many; past it, on a press. */
export const OPEN_BY_DEFAULT_UP_TO = 8;

export function PlanNote({
  note,
  leftHeading,
  also,
  hint,
  tone = "neutral",
  slug,
  routeFor,
  onGo,
}: {
  note?: string;
  leftHeading?: string;
  also?: PlanNoteRecord[];
  hint?: string;
  tone?: "neutral" | "green";
  slug: string;
  routeFor: (kind: string, id: string) => string | null;
  onGo: (to: string) => void;
}) {
  const count = also?.length ?? 0;
  const [open, setOpen] = useState(count <= OPEN_BY_DEFAULT_UP_TO);
  if (!note && !count && !hint) return null;
  const faint = tone === "green" ? "text-emerald-700/80 dark:text-emerald-400/70" : "text-muted dark:text-slate-400";
  const text = tone === "green" ? "text-emerald-800 dark:text-emerald-300" : "text-content dark:text-mortar-200";
  const heading = leftHeading ?? (count ? `Left where they are (${count}):` : undefined);
  return (
    <div className="mt-1 min-w-0">
      {note && <div className={`text-[11px] ${faint} break-words`}>{note}</div>}
      {count > 0 && heading && (
        <section aria-label={heading} className="min-w-0">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className={`inline-flex items-center gap-1 text-[11px] font-medium ${text} hover:underline underline-offset-2`}
          >
            {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            {heading}
          </button>
          {hint && <div className={`text-[11px] ${faint} break-words`}>{hint}</div>}
          {open && (
            <ul className={`mt-0.5 text-xs ${text} space-y-0.5 ${count > OPEN_BY_DEFAULT_UP_TO ? "max-h-56 overflow-y-auto pr-1" : ""}`} aria-label="Records the plan leaves alone">
              {also!.map((r) => {
                const href = r.kind ? routeFor(r.kind, r.id) : null;
                return (
                  <li key={r.id} className="flex gap-1.5 min-w-0">
                    <span className={`shrink-0 ${faint}`}>•</span>
                    <span className="min-w-0 break-words">
                      {href ? (
                        <ChatRefChip slug={slug} href={href} onGo={onGo}>
                          {r.title}
                        </ChatRefChip>
                      ) : (
                        r.title
                      )}
                      {r.why && <span className={faint}> · {r.why}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {!count && hint && <div className={`text-[11px] ${faint} break-words`}>{hint}</div>}
    </div>
  );
}
