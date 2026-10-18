// A scan row's History in plain words (#6100): what each step did, what it
// changed the name from and to, and the before-state Put back restores. One
// reader for the card and the assistant, so both say the same thing.
import { confidenceInWords } from "@cobblr/platform-contract/scan-copy";

/** One History entry as the row stores it (core-scan services/scan-history.ts). */
export interface ScanHistoryEntryStored {
  action: string;
  at: string;
  note?: string;
  /** The before-state this step recorded; Put back restores it. */
  revision?: string;
  /** The name before this step. Present only on steps that recorded one. */
  before_name?: string | null;
  /** The brand and the confidence before this step (#6210), when recorded. */
  before_brand?: string | null;
  before_confidence?: string | number | null;
  ai_answered?: boolean;
}

export interface ScanHistoryLine {
  at: string;
  words: string;
  /** How many presses this line stands for (repeats that changed nothing). */
  times: number;
  /** The before-state to put back, when this step recorded one. */
  revision?: string;
  /** False when the step left the name as it was; null when it cannot be told. */
  changed: boolean | null;
  /** The newest step in the line asked an AI that did not answer. */
  noAnswer: boolean;
}

const ACTION_WORDS: Record<string, string> = {
  rerun: "Looked up again",
  replay: "Replayed without AI",
  "rerun-hint": "Looked up again with your hint",
  hint: "Read your hint",
  wrong: "Marked wrong and looked up again",
  enrich: "Asked for more detail",
  barcode: "Barcode corrected",
  "confirm-guess": "Confirmed the first look",
  "reject-guess": "Said the first look was wrong",
  "crop-again": "Cut it again from the group photo",
  confirm: "Locked into the barcode database",
  combine: "Combined similar items",
  uncombine: "Separated combined items",
  split: "Split into separate items",
  unsplit: "Put the split items back together",
  attached: "Filed",
  broken: "Marked broken: a repair is in its service log",
  unconfirm: "Unfiled",
  "undo-rerun": "Undid the lookup",
  "put-back": "Put back",
  "store-code": "Named again from its photo: a shop's own barcode",
  "prose-name": "Cleared a photo read that described it instead of naming it",
  "label-name": "Named from the biggest words on its label",
  "label-cleared": "Cleared a name read off its label that could not be trusted",
};

/** Notes that only repeat what the name change already says. */
const NOTE_SAID_BY_CHANGE = new Set(["undo-rerun", "put-back", "store-code"]);

function stepWords(e: ScanHistoryEntryStored): string {
  const label = ACTION_WORDS[e.action] ?? e.action;
  if (!e.note || NOTE_SAID_BY_CHANGE.has(e.action)) return label;
  return e.action === "barcode" ? `${label} to ${e.note}` : `${label}: "${e.note}"`;
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** The row as it stands now: what the newest step's after is. */
export interface ScanRowNow {
  name: string | null;
  brand?: string | null;
  confidence?: string | number | null;
}

interface Seen {
  name: string | null;
  brand?: string | null;
  confidence?: string | number | null;
}

function seenBefore(e: ScanHistoryEntryStored): Seen {
  return {
    name: e.before_name ?? null,
    ...("before_brand" in e ? { brand: e.before_brand ?? null } : {}),
    ...("before_confidence" in e ? { confidence: e.before_confidence ?? null } : {}),
  };
}

/** What a step changed, in words: every part that differs, name first. Parts
 *  a step did not record (an older entry) are not compared. */
function changesBetween(before: Seen, after: Seen): string[] {
  const parts: string[] = [];
  if (before.name !== after.name) {
    parts.push(!before.name ? `named ${after.name}` : !after.name ? `the name ${before.name} was cleared` : `name changed from ${before.name} to ${after.name}`);
  }
  if ("brand" in before && "brand" in after && (before.brand ?? null) !== (after.brand ?? null)) {
    parts.push(!before.brand ? `brand set to ${after.brand}` : !after.brand ? `the brand ${before.brand} was cleared` : `brand changed from ${before.brand} to ${after.brand}`);
  }
  if ("confidence" in before && "confidence" in after) {
    const b = confidenceInWords(before.confidence ?? null)?.replace(/ confidence$/, "");
    const a = confidenceInWords(after.confidence ?? null)?.replace(/ confidence$/, "");
    if (b && a && b !== a) parts.push(`confidence changed from ${b} to ${a}`);
  }
  return parts;
}

/** The History, newest first, one line per step. Steps that share a
 *  before-state (a corrected barcode and the lookup it set off) are one line;
 *  repeats that changed nothing are one line with a count. */
export function scanHistoryLines(history: readonly ScanHistoryEntryStored[] | null | undefined, current: string | null | ScanRowNow): ScanHistoryLine[] {
  const now: Seen = typeof current === "object" && current !== null ? current : { name: current };
  if (!Array.isArray(history) || history.length === 0) return [];
  // Oldest first: steps sharing a revision fold into one, read in the order
  // they happened, with the later step's words first (it is what the person did).
  const groups: ScanHistoryEntryStored[][] = [];
  for (const e of history) {
    const last = groups.at(-1);
    if (last && e.revision && last[0]!.revision === e.revision) last.push(e);
    else groups.push([e]);
  }
  const lines: ScanHistoryLine[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const newest = g.at(-1)!;
    const ordered = [...g].reverse();
    const words = ordered.map((e, j) => (j === 0 ? stepWords(e) : lowerFirst(stepWords(e)))).join(", ");
    const recorded = "before_name" in g[0]!;
    let changed: boolean | null = null;
    let said = words;
    if (recorded) {
      const next = groups.slice(i + 1).find((n) => "before_name" in n[0]!);
      const parts = changesBetween(seenBefore(g[0]!), next ? seenBefore(next[0]!) : now);
      changed = parts.length > 0;
      said = `${words}: ${parts.length ? parts.join("; ") : "nothing changed"}`;
    }
    lines.push({
      at: newest.at,
      words: said,
      times: 1,
      ...(g[0]!.revision ? { revision: g[0]!.revision } : {}),
      changed,
      noAnswer: newest.ai_answered === false,
    });
  }
  // Newest first, and a repeat that changed nothing joins the line before it.
  // The kept revision is the OLDEST of the run: it is what the row was before
  // any of the presses.
  const out: ScanHistoryLine[] = [];
  for (const line of lines) {
    const prev = out.at(-1);
    if (prev && prev.words === line.words && line.changed !== true) {
      prev.times += 1;
      prev.at = line.at;
      if (line.revision) prev.revision = line.revision;
      prev.noAnswer = prev.noAnswer || line.noAnswer;
      continue;
    }
    out.push({ ...line });
  }
  return out.reverse();
}

/** The before-state the row's newest step recorded: what Undo on the toast
 *  that announced it puts back. */
export function latestRevision(row: { suggested_metadata?: unknown } | null | undefined): string | null {
  const history = (row?.suggested_metadata as { history?: ScanHistoryEntryStored[] } | null | undefined)?.history;
  const newest = Array.isArray(history) ? history.at(-1) : undefined;
  return newest?.revision ?? null;
}
