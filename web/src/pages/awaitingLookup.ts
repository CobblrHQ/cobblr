// What an item still waiting on its lookup says (#3852).
//
// "Awaiting lookup…" with nothing after it read as stuck: two pasted
// screenshots sat under it and the person could not tell a slow AI from a
// broken one, or whether pressing anything would help. So after a few
// seconds the line says why it is still waiting and offers the two ways out,
// in the words the provider layer already classifies (a busy AI answers
// later, #3834; a row with a queued re-run is retried by itself).

import { useEffect, useState } from "react";
import type { ScanInboxItem } from "../lib/api";

/** How long a lookup waits before it says why. A photo is usually named in
 *  two to six seconds; past this it is worth a sentence. */
export const AWAITING_SAYS_WHY_AFTER_MS = 8_000;

/** A photo the hosted identify queued while every engine it has was busy. */
export const HOSTED_QUEUED_LINE = "Identifying, back shortly. Every AI was busy, so this one is queued and lands here by itself.";

export interface AwaitingWords {
  /** The line under the name. */
  line: string;
  /** Offer "Try again" and "Name it yourself" beside the line. */
  offerWaysOut: boolean;
}

type Waiting = Pick<ScanInboxItem, "created_at" | "source_kind" | "barcode_text" | "suggested_metadata">;

export function awaitingWords(item: Waiting, now: number, opts: { identifyAvailable?: boolean } = {}): AwaitingWords {
  // The hosted identify accepted the photo and answers when an engine is
  // back (barcode-intelligence #43): not a failure, so it never reads as one.
  if ((item.suggested_metadata as { hosted_identify_job?: unknown } | null)?.hosted_identify_job) {
    return { line: HOSTED_QUEUED_LINE, offerWaysOut: true };
  }
  const queued = (item.suggested_metadata as { ai_rerun_queued?: { next_at?: string } } | null)?.ai_rerun_queued;
  if (queued) {
    return { line: "The AI was busy, so this waits for it to come back. It tries again by itself.", offerWaysOut: true };
  }
  const age = now - Date.parse(item.created_at);
  if (!(age >= AWAITING_SAYS_WHY_AFTER_MS)) return { line: "Awaiting lookup…", offerWaysOut: false };
  const code = !!item.barcode_text || item.source_kind === "barcode";
  if (code) return { line: "Still looking this code up. The catalogs can be slow to answer.", offerWaysOut: true };
  if (opts.identifyAvailable === false) {
    return { line: "Nothing here can read a picture yet, so this waits for a name.", offerWaysOut: true };
  }
  return { line: "Still reading the picture. The AI is slow to answer right now.", offerWaysOut: true };
}

/** awaitingWords, kept current while the row waits: it ticks until the
 *  line has something to say and then stops. Null when the row is not
 *  waiting, so a settled row costs no timer. */
export function useAwaitingWords(item: Waiting, waiting: boolean, opts: { identifyAvailable?: boolean } = {}): AwaitingWords | null {
  const [now, setNow] = useState(() => Date.now());
  const words = waiting ? awaitingWords(item, now, opts) : null;
  const ticking = !!words && !words.offerWaysOut;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return words;
}
