// "We think it's X - is that right?" The first look, put to the person.
//
// Mounted by the capture drawer ONLY. The question is for the moment you are
// still holding the thing: "yes it's this" and you move on. By the time an
// item is in the inbox the full read has run, and asking again there is too
// late and beside the point; a wrong read is corrected with the card's own
// tools (re-run with a hint, a better photo). It used to be mounted on the
// inbox card as well (2026-09-08: "by the time it's in the scan inbox, it's
// too late"). It never blocks anything.
//
// What the two answers do lives on the server (services/glance.ts); this only
// asks, and on "no" offers one line to say what it is instead.

import { useState } from "react";
import { Check, X } from "lucide-react";
import type { ScanInboxItem } from "../lib/api";

export interface GlanceOnItem {
  name: string;
  category: string | null;
  confidence: number;
  /** Where the guess came from, because the honest explanation differs: a
   *  barcode's name is the catalog's answer, a photo's is a one-second look. */
  source: "barcode" | "photo";
}

/** What the question is FOR, in a sentence, per source. Shown as the row's
 *  title so hovering anywhere on it says what Yes and No do. The old row had a
 *  bare "?" that read as a help icon and explained nothing (2026-09-08). */
export function glanceExplanation(g: Pick<GlanceOnItem, "source">): string {
  return g.source === "barcode"
    ? "This is the catalog's name for the barcode. Yes keeps it and marks it verified; No lets you say what it really is."
    : "A one-second first look at the photo. Yes settles the name and the full read fills in the rest; No lets you say what it is and rules this guess out. Ignore it and the full read runs anyway.";
}

/** The pending question on an item, or null when there is none to ask: no
 *  first look, already answered, or a name has landed since. */
export function pendingGlance(item: Pick<ScanInboxItem, "suggested_name" | "suggested_metadata" | "barcode_text">): GlanceOnItem | null {
  const m = (item.suggested_metadata ?? {}) as { glance?: GlanceOnItem; glance_answer?: string; guess_confirmed?: boolean };
  // A barcode card's guess is its catalog entry: ask about the name it has.
  if (item.barcode_text) {
    if (!item.suggested_name || m.guess_confirmed) return null;
    return { name: item.suggested_name, category: null, confidence: 1, source: "barcode" };
  }
  if (!m.glance || m.glance_answer || item.suggested_name) return null;
  return { ...m.glance, source: "photo" };
}

export function GlanceQuestion({
  glance,
  busy,
  onAnswer,
  dark,
}: {
  glance: GlanceOnItem;
  busy?: boolean;
  onAnswer: (answer: "yes" | "no", hint?: string) => void;
  /** The capture drawer sits on the camera's dark glass. */
  dark?: boolean;
}) {
  const [saying, setSaying] = useState(false);
  const [hint, setHint] = useState("");
  const text = dark ? "text-white" : "text-content dark:text-mortar-100";
  const faint = dark ? "text-white/60" : "text-muted dark:text-slate-400";
  const btn = dark
    ? "border-white/25 text-white hover:bg-white/10"
    : "border-line dark:border-slate-600 text-content hover:bg-subtle dark:hover:bg-slate-800";
  if (saying) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onAnswer("no", hint.trim() || undefined);
        }}
        className="flex items-center gap-1.5 mt-1"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          placeholder="what is it? (optional)"
          className={`flex-1 min-w-0 rounded px-2 py-1 text-xs border ${dark ? "border-white/25 bg-white/10 text-white placeholder:text-white/40" : "border-line dark:border-slate-600 bg-surface dark:bg-slate-900"}`}
        />
        <button type="submit" disabled={busy} className={`shrink-0 rounded border px-2 py-1 text-[11px] font-medium ${btn} disabled:opacity-50`}>
          Not that
        </button>
      </form>
    );
  }
  return (
    <div
      className="flex items-center gap-1.5 mt-1 min-w-0"
      onClick={(e) => e.stopPropagation()}
      title={glanceExplanation(glance)}
    >
      <span className={`text-[11px] ${faint} shrink-0`}>Is it</span>
      {/* The question mark lives INSIDE the name, so it can never be left
          standing on its own. As three spans, a long name truncated and the
          "?" sat beside the buttons looking like a help icon with no help in
          it - "what is this even for?" (2026-09-08). The full name, with its
          mark, is the span's title. */}
      <span className={`text-[12px] font-medium truncate ${text}`} title={`${glance.name}?`}>
        {glance.name}
        <span className={`text-[11px] font-normal ${faint}`}>?</span>
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => onAnswer("yes")}
        aria-label={`Yes, it is ${glance.name}`}
        className={`ml-auto shrink-0 inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium ${btn} disabled:opacity-50`}
      >
        <Check size={11} /> Yes
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setSaying(true)}
        aria-label={`No, it is not ${glance.name}`}
        className={`shrink-0 inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium ${btn} disabled:opacity-50`}
      >
        <X size={11} /> No
      </button>
    </div>
  );
}
