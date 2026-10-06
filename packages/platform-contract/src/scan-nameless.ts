// Why a scan card has no name, and what it says about it: chosen from what
// the record carries, never guessed (#4933).
//
// "The AI could not read this one." was the card's DEFAULT: any nameless
// barcode row whose lookup had settled said it, with a Retry, whether or not
// an AI had been asked. An Amazon sticker's row carried no failure at all,
// the owner rescanned a sharp photo, and the card said the same thing again,
// so the message looked like an outage. A failure sentence is a claim about
// the record. So the reason is a code taken from the record, the words are a
// map from that code with an exhaustive switch (a new reason without words
// does not typecheck), and a row with no recorded reason says the neutral,
// true thing, "Not named yet", with its next step.
//
// lint:scan-failure-copy-from-reasons refuses a sentence on the scan and
// inbox surfaces that claims a failure ("couldn't", "could not", "didn't
// answer", "failed") unless it comes from the contract.

import { identifyFailureWords, identifyNeverTried, type IdentifyFailure } from "@cobblr/platform-contract/scan-fallback";

export type NamelessReason =
  /** A receipt whose lines could not be read (recorded on the session). */
  | "receipt-unread"
  /** Nothing here can identify a photo (the AI status says so). */
  | "no-identify"
  /** A code the server classified as one no catalog looks up (code_type). */
  | "classified-code"
  /** The model looked and saw no one item (identify_failure no_item). */
  | "no-item"
  /** A code no catalog knew; a web guess held back, or the lookup ran out
   *  (held_reason, or the lookup's own note). */
  | "unresolved-code"
  /** The model was asked and failed (identify_failure, recorded). */
  | "ai-failed"
  /** Nothing recorded says why: not named yet, and that is all it is. */
  | "not-named-yet";

/** The reason, from what the record carries. "ai-failed" only with a
 *  recorded failure: its absence is not evidence that the AI failed. */
export function namelessReason(
  status: { identify_available?: boolean } | null | undefined,
  classifiedCode: boolean,
  failure?: IdentifyFailure | null,
  unresolvedCode = false,
  receiptUnread = false,
): NamelessReason {
  if (receiptUnread) return "receipt-unread";
  if (classifiedCode) return "classified-code";
  if (unresolvedCode) return "unresolved-code";
  // Only a KNOWN "nothing here can identify a photo" earns the setup words.
  if (status && status.identify_available === false) return "no-identify";
  if (failure?.code === "no_item") return "no-item";
  if (failure && identifyNeverTried(failure)) return "no-identify";
  if (failure?.code === "ai_unavailable" || failure?.code === "no_answer") return "ai-failed";
  return "not-named-yet";
}

export const NOT_NAMED_YET = "Not named yet.";

/** The table match threw (match_failed on the record): that it failed is
 *  recorded, why is not, so the words say only the first. */
export const MATCH_FAILED_WORDS = "Matching failed. Try it again.";

/** A run on the item's history whose entry records ai_answered: false. */
export const RUN_NO_ANSWER_WORDS = "the AI didn’t answer";

/** The way forward a card offers beside the line. */
export type NamelessAction = "set-up-ai" | "read-as-receipt" | "identify-again" | "identify" | null;

export interface NamelessWords {
  /** The desk card's line before the name box. */
  line: string;
  /** What the line's button does, and its words. */
  action: NamelessAction;
  actionLabel: string | null;
  /** The phone row's line under the note, with its button, or null. */
  remedy: { text: string; recovery: "retry" | "connect" } | null;
}

/** What a nameless card says, for each reason. `noun` is what the card
 *  calls the thing (photo, barcode, item). The unresolved-code words read
 *  the two facts the record holds about the lookup. */
export function namelessWords(
  reason: NamelessReason,
  opts: { noun: string; failure?: IdentifyFailure | null; classifiedLine?: string | null; heldGuess?: boolean; lookupGaveUp?: boolean },
): NamelessWords {
  const { noun, failure } = opts;
  switch (reason) {
    case "receipt-unread":
      return { line: "Its lines could not be read yet.", action: null, actionLabel: null, remedy: null };
    case "no-identify":
      return { line: `No AI to read this ${noun} yet - or name it:`, action: "set-up-ai", actionLabel: "set it up", remedy: null };
    case "classified-code":
      return { line: opts.classifiedLine ?? "Name it:", action: null, actionLabel: null, remedy: null };
    case "no-item":
      return { line: `Name this ${noun}, or`, action: "read-as-receipt", actionLabel: "read it as a receipt", remedy: null };
    case "unresolved-code":
      return {
        line: opts.heldGuess
          ? `No catalog knows this ${noun}. Take the guess, or name it:`
          : opts.lookupGaveUp
            ? `The lookup ran out for this ${noun} - name it:`
            : `Nothing found for this ${noun} - name it:`,
        action: null,
        actionLabel: null,
        remedy: null,
      };
    case "ai-failed": {
      const words = failure ? identifyFailureWords(failure) : null;
      const remedy = words?.connect ? { text: words.detail, recovery: "connect" as const } : words?.retry ? { text: words.detail, recovery: "retry" as const } : null;
      return { line: `, or name this ${noun}:`, action: "identify-again", actionLabel: "Identify it again", remedy };
    }
    case "not-named-yet":
      return { line: `${NOT_NAMED_YET} Name this ${noun}, or`, action: "identify", actionLabel: "identify it", remedy: { text: `${NOT_NAMED_YET} Identify it, or name it.`, recovery: "retry" } };
    default: {
      const never: never = reason;
      throw new Error(`no words for ${String(never)}`);
    }
  }
}

/** Whether the card's line already says the whole thing, so the note need
 *  not repeat it under it (#3322). */
export function headingSaysItAll(why: NamelessReason): boolean {
  return why === "no-identify" || why === "classified-code" || why === "receipt-unread";
}
