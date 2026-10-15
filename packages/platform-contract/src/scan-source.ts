// Where an inbox session came from, said once and said truly (#4581).
//
// Three questions the scan page used to answer on every card, or with a file
// name nobody chose:
//
//   · the DOCUMENT a session was read from: a chip in the session's header
//     ("eBay email · 1 line") while it needs nothing, the full card only when
//     it needs the person (it could not be read, it read into nothing, it
//     waits on the AI). Named by what it is ("Email from eBay, Aug 12"),
//     never "emailed-receipt.txt"; a file somebody uploaded keeps its name.
//   · WHO added it: an assistant's connection, Cobb, an API token, the
//     address a receipt was forwarded from. Once, in the header; a card says
//     so only when its own source differs from its session's.
//   · where a CODE came from: "read from the email" over an emailed order,
//     never "read from photo".
//
// Pure, shared by the server that stamps and the page that says, so the two
// cannot disagree.

import type { SessionVerdict } from "@cobblr/platform-contract/scan-session";
import { sourceDisplayName } from "@cobblr/platform-contract/acquisition-source";

// ── who added it ─────────────────────────────────────────────────────────

/** How a row came in, when it was not the person's own hand:
 *   mcp       - an assistant over MCP, with the member's API token
 *   assistant - the in-app assistant (Cobb)
 *   token     - an API token with no assistant behind it (a scanner, a script)
 *   email     - a receipt forwarded by email */
export type AddedByKind = "mcp" | "assistant" | "token" | "email";

export interface AddedBy {
  kind: AddedByKind;
  /** The connection's name (the API token's), or the address an email came
   *  from. Null when nothing named it. */
  name: string | null;
}

/** The suggested_metadata key a door stamps. */
export const ADDED_BY_KEY = "added_by";

const KINDS: ReadonlySet<string> = new Set<AddedByKind>(["mcp", "assistant", "token", "email"]);

/** The request's own account of itself, as the kernel reports it. */
export interface RequestSource {
  auth_method: "session" | "api_token" | "system";
  via: string | null;
  token_name: string | null;
}

/** Who added a row, from how the request that added it was made. A person's
 *  own session is nobody worth naming: null. */
export function addedByFromRequest(src: RequestSource | null): AddedBy | null {
  if (!src) return null;
  if (src.via === "assistant") return { kind: "assistant", name: null };
  if (src.via === "mcp") return { kind: "mcp", name: src.token_name };
  if (src.auth_method === "api_token") return { kind: "token", name: src.token_name };
  return null;
}

/** Who added the row, from its metadata. A row stamped before the name was
 *  kept (`arrived_by: "assistant"`) was an assistant's, unnamed. */
export function addedByOf(meta: unknown): AddedBy | null {
  const m = (meta ?? {}) as { added_by?: unknown; arrived_by?: unknown };
  const a = m.added_by as { kind?: unknown; name?: unknown } | null | undefined;
  if (a && typeof a.kind === "string" && KINDS.has(a.kind)) {
    return { kind: a.kind as AddedByKind, name: typeof a.name === "string" && a.name.trim() ? a.name.trim() : null };
  }
  if (m.arrived_by === "assistant") return { kind: "mcp", name: null };
  return null;
}

/** The name to say: the connection's, else what it is. */
export function addedByName(a: AddedBy): string {
  switch (a.kind) {
    case "mcp":
      return a.name ?? "your assistant";
    case "assistant":
      return "Cobb";
    case "token":
      return a.name ?? "an API token";
    case "email":
      return a.name ?? "email";
  }
}

/** The header's words: "Added by Claude", "Emailed from you@example.com". */
export function addedByWords(a: AddedBy): string {
  if (a.kind === "email") return a.name ? `Emailed from ${a.name}` : "Emailed in";
  return `Added by ${addedByName(a)}`;
}

/** A card's own note, when it differs from its session: "from Claude",
 *  "from your assistant", "from Cobb", "emailed". */
export function addedByCardWords(a: AddedBy): string {
  return a.kind === "email" ? "emailed" : `from ${addedByName(a)}`;
}

/** How it was added, for the line a tap on the header's chip opens. */
export function addedByHow(a: AddedBy): string {
  switch (a.kind) {
    case "mcp":
      return a.name ? `through the connection “${a.name}” (MCP)` : "by an assistant over MCP";
    case "assistant":
      return "by Cobb, the assistant in this app";
    case "token":
      return a.name ? `with the API token “${a.name}”` : "with an API token";
    case "email":
      return a.name ? `by email from ${a.name}` : "by email";
  }
}

function keyOf(a: AddedBy | null): string {
  return a ? `${a.kind}:${a.name ?? ""}` : "";
}

/** The session's source: an email session's sender, else what most of its
 *  rows share (the first row's on a tie). Null when that is the person. */
export function sessionAddedBy(
  items: ReadonlyArray<{ suggested_metadata?: unknown }>,
  emailFrom?: { origin: string | null; from: string | null } | null,
): AddedBy | null {
  if (emailFrom?.origin === "email") return { kind: "email", name: emailFrom.from?.trim() || null };
  const counts = new Map<string, { n: number; a: AddedBy | null }>();
  for (const it of items) {
    const a = addedByOf(it.suggested_metadata);
    const k = keyOf(a);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { n: 1, a });
  }
  let best: { n: number; a: AddedBy | null } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.a ?? null;
}

/** Does this row say who added it on its own card? Only when it differs
 *  from its session, which says it once in the header. */
export function cardSaysAddedBy(item: { suggested_metadata?: unknown }, session: AddedBy | null): AddedBy | null {
  const own = addedByOf(item.suggested_metadata);
  if (!own) return null;
  return keyOf(own) === keyOf(session) ? null : own;
}

// ── the document ─────────────────────────────────────────────────────────

/** Does the document itself need the person? Then it shows as the full
 *  card; otherwise it is the header's chip. */
export function documentNeedsPerson(v: SessionVerdict, items: ReadonlyArray<{ suggested_metadata?: unknown }>): boolean {
  if (v.kind === "failed" || v.kind === "in_flight") return true;
  if (v.kind === "read" && items.length === 0) return true;
  return items.some((i) => (i.suggested_metadata as { check_fields?: { waiting_for_ai?: unknown } } | null | undefined)?.check_fields?.waiting_for_ai === true);
}

/** File names the platform wrote itself: never a name to show. */
const SYNTHETIC_NAMES: ReadonlyArray<RegExp> = [/^emailed-receipt\.txt$/i, /^scan-photo$/i];

export function isSyntheticFileName(name: string | null | undefined): boolean {
  return !name || SYNTHETIC_NAMES.some((re) => re.test(name));
}

function shortDate(d: Date | null): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export interface SessionDocument {
  /** The batch's origin ("email" for a forwarded receipt). */
  origin: string | null;
  /** The shop, when the read found one. */
  vendor: string | null;
  /** Who the email came from, when it was emailed. */
  from: string | null;
  /** The date on the document, else when it arrived. */
  date: Date | null;
  /** The stored file's own name. */
  filename: string | null;
}

/** "Email from eBay, Aug 12". A file somebody uploaded keeps its own name. */
export function sessionDocumentName(d: SessionDocument): string {
  const when = shortDate(d.date);
  if (d.origin === "email" || (d.filename && /^emailed-receipt\.txt$/i.test(d.filename))) {
    const who = (d.vendor?.trim() && sourceDisplayName(d.vendor)) || d.from?.trim() || null;
    if (who) return when ? `Email from ${who}, ${when}` : `Email from ${who}`;
    return when ? `Emailed receipt, ${when}` : "Emailed receipt";
  }
  if (!isSyntheticFileName(d.filename)) return d.filename!;
  return when ? `Document, ${when}` : "Document";
}

/** What kind of document it is, in a word or two, for the chip. */
export function documentKindWords(d: {
  origin: string | null;
  vendor: string | null;
  billOfSale: boolean;
  source: "scanned-pdf" | "pdf" | "photo" | "text" | null;
}): string {
  if (d.billOfSale) return "Bill of sale";
  if (d.origin === "email") return d.vendor?.trim() ? `${sourceDisplayName(d.vendor)} email` : "Email";
  switch (d.source) {
    case "scanned-pdf":
      return "Scanned PDF";
    case "pdf":
      return "PDF";
    case "photo":
      return "Receipt photo";
    default:
      return "Receipt";
  }
}

/** The chip: "eBay email · 1 line". */
export function documentChipWords(kind: string, lines: number): string {
  return `${kind} · ${lines === 1 ? "1 line" : `${lines} lines`}`;
}

// ── where a code came from ───────────────────────────────────────────────

/** The values a door stamps as `barcode_source`; a scan stamps nothing. */
export type CodeSource = "ai-photo" | "receipt" | "user";

/** Where the row's code came from. A receipt line stamped before receipt
 *  codes had their own value says "ai-photo" with no photo on the row: it
 *  was read off the receipt, and is said so. */
export function codeSourceOf(row: { source_kind?: string | null; image_file_id?: string | null; suggested_metadata?: unknown }): CodeSource | null {
  const m = (row.suggested_metadata ?? {}) as { barcode_source?: unknown; source?: unknown };
  const s = m.barcode_source;
  if (s === "ai-photo") {
    const receiptLine = row.source_kind === "receipt" || m.source === "receipt";
    return receiptLine && !row.image_file_id ? "receipt" : "ai-photo";
  }
  if (s === "receipt" || s === "user") return s;
  return null;
}

/** How to say where a code came from, or nothing for a scan or a typed one. */
export function codeSourceNote(source: CodeSource | null | undefined, opts: { emailed?: boolean } = {}): string | null {
  if (source === "ai-photo") return "read from photo";
  if (source === "receipt") return opts.emailed ? "read from the email" : "read from the receipt";
  return null;
}

// ── which door ───────────────────────────────────────────────────────────

/** The doors a row enters the inbox through (core-scan intake.ts intakeRow). */
export type IntakeDoor = "scan" | "note" | "receipt" | "split" | "import" | "assistant";

/** The suggested_metadata key intake stamps the door under. */
export const INTAKE_DOOR_KEY = "intake_door";

/** Whether a row through this door was typed into the dashboard's "What do
 *  you want to do?" panel, the only rows that panel lists. Every door says,
 *  so a new door has to pick a side. The note door is shared: the panel's
 *  typed add and an assistant's add over MCP both use it, which the row's
 *  added-by stamp tells apart (typedInThePanel). */
export const TYPED_IN_THE_PANEL: Readonly<Record<IntakeDoor, boolean>> = {
  note: true,
  scan: false,
  receipt: false,
  split: false,
  import: false,
  assistant: false,
};

/** Was this row typed into the dashboard's panel by a person? Only those
 *  belong in its "What you've added"; everything else (an assistant's add
 *  over MCP, a share, an offer, an import) lives in the scan inbox alone.
 *  The owner's eight printers, added by Claude over MCP, were listed in the
 *  panel as typed there and held it open (#6565). A row from before the
 *  door was stamped is read from what it does carry: who added it, and the
 *  intake shape every door but import stamps. */
export function typedInThePanel(row: { source_kind?: string | null; suggested_metadata?: unknown }): boolean {
  if (row.source_kind !== "note") return false;
  if (addedByOf(row.suggested_metadata)) return false;
  const m = (row.suggested_metadata ?? {}) as { intake_door?: unknown; intake_shape?: unknown };
  if (typeof m.intake_door === "string") return TYPED_IN_THE_PANEL[m.intake_door as IntakeDoor] === true;
  return typeof m.intake_shape === "string" && m.intake_shape !== "import";
}
