// Commands whose PLAN has to be worked out, not filled in.
//
// A learned command is a template with slots: "make {label} {from} through
// {to}" binds three words and produces the same shape of writes every time.
// "Delete duplicates" cannot work that way — nobody can say in advance which
// records are duplicated, or how many, so there is no plan to bind. It has to
// go and look.
//
// That is the whole difference this file exists for, and it is worth keeping
// straight: a computed command READS the workspace at match time and returns
// the writes it would make, so the person sees exactly what is about to
// happen before anything does. It is still the deterministic path — no model
// is asked, nothing is guessed, and it works in a workspace with no AI at all.

import type { Operation } from "./learned-commands.js";
import type { WorkspaceApi } from "@cobblr/workspace-tools";
import { getTool, fetchKinds } from "@cobblr/workspace-tools";
import { rankFits, type FitTable } from "@cobblr/platform-contract/table-fit";
import { fitTablesFor } from "./table-fit-menu.js";
import { pluralise } from "@cobblr/platform-contract";

export interface ComputedPlan {
  /** What the confirm card says, in a sentence a person can check. */
  summary: string;
  /** A true thing about the plan that is not part of it: what it found and
   *  did NOT touch. "5 more tea are in other lists" belongs here, because a
   *  plan that quietly moves 2 of 7 is precise and unhelpful, and one that
   *  moves all 7 when the page held 2 is helpful and wrong. A SENTENCE, never
   *  a list: the records it counts are `also`, one bullet each on the card,
   *  and the sentence ends where that list begins (the owner, 2026-09-13,
   *  on a note that hid five records behind "and 2 more" in parentheses). */
  note?: string;
  /** Everything it touches, one per line, by what a person calls it. The
   *  summary names a few; this is the whole list, for the card to fold. */
  lines?: string[];
  operations: Operation[];
  /** What the plan saw in its scope and did NOT take, by id and kind: the
   *  records the word did not reach, every one, so the card draws each as
   *  its own record link. `why` says what kept it out when the reason is
   *  per record ("no category"). A later card can be built from these when
   *  the model names some of them as covered after all. */
  also?: Array<{ id: string; title: string; kind?: string; why?: string }>;
  /** The continuation after the list: what pressing Enter would do about
   *  the records the plan left ("Send the message and Cobb will look through
   *  them."). Its own line, so the reply card, where the message has been
   *  sent, can leave it out. */
  hint?: string;
  /** The label over the records the plan left, with their count: "Left in
   *  Inventory, could not tell (6):". A block of records under a sentence
   *  that read like a plan had the person asking why they were listed (the
   *  owner, 2026-09-13); the label says what the block is. */
  leftHeading?: string;
  /** Where the plan puts things, for that later card to put more. */
  to?: { name: string; label: string };
  /** One per destination: what goes where, with only that destination's
   *  operations (a new list's create included), so the card can offer each
   *  on its own and the whole is their sum. The flat `operations` is exactly
   *  the concatenation, in order. Always present on a plan that groups by
   *  destination, even with one group left: a card holding a section's key
   *  from before the other part ran must still be able to name it. The card
   *  draws sections only when there are two or more. */
  sections?: PlanSection[];
}

export interface PlanSection {
  /** Names the section across a re-computation of the same sentence, so a
   *  run can say which one: "into:<list>" or "new:<list>". */
  key: string;
  /** "4 into Groceries", "2 into a new Spices section". */
  heading: string;
  /** The records it moves, by id and kind, so each is a link on the card;
   *  `why` is the word that put it there when that was the table's own
   *  vocabulary rather than the person's ("seasoning"). */
  lines: Array<{ id: string; title: string; kind?: string; why?: string }>;
  operations: Operation[];
  note?: string;
}

/** The label over what a plan left, and how many. */
export function leftHeadingFor(where: string, count: number): string {
  return `Left in ${where}, could not tell (${count}):`;
}

/** The flat plan from its sections: the operations in order, the lines with
 *  the destination on each, and the parts of the summary. */
function flatten(sections: PlanSection[], labelOf: (s: PlanSection) => string): { operations: Operation[]; lines: string[] } {
  const operations: Operation[] = [];
  const lines: string[] = [];
  for (const s of sections) {
    operations.push(...s.operations);
    for (const l of s.lines) lines.push(`${l.title} → ${labelOf(s)}${l.why ? ` (${l.why})` : ""}`);
  }
  return { operations, lines };
}

export interface ComputedCommand {
  id: string;
  /** The sentences that mean it. Deliberately narrow. */
  match: RegExp;
  /** Shown in the offer strip before anything is run. */
  template: string;
  description: string;
  plan(ctx: {
    wsApi: WorkspaceApi;
    /** The records the user had selected, when they had any: the scope. */
    selectionIds?: string[];
    /** The kind the page on screen lists, when it lists one. "from this page"
     *  means this. */
    pageKind?: string;
    /** What was actually typed. "Delete duplicates" needs nothing from the
     *  sentence beyond having matched, but a command that has to know WHICH
     *  things and WHERE ("move all the tea into the Tea section") cannot work
     *  without it, and reaching around for it is how a plan ends up guessing. */
    message: string;
  }): Promise<ComputedPlan | null>;
}

interface Row {
  id: string;
  title: string;
  /** The value of whatever field this kind says means "the same place". */
  scope: string;
}

/** A listed record is `{id, title, fields:{…}}` — the columns live a level
 *  down, and the reading of a duplicate depends on getting the SCOPE right:
 *  read it wrong and every "Shelf 1" in the workspace looks like a duplicate
 *  of every other one. */
function rowOf(rec: unknown, scopeField: string): Row | null {
  const r = rec as { id?: unknown; title?: unknown; fields?: Record<string, unknown> } | null;
  const id = typeof r?.id === "string" ? r.id : null;
  const f = r?.fields ?? {};
  const title =
    typeof r?.title === "string" && r.title
      ? r.title
      : typeof f.name === "string"
        ? f.name
        : typeof f.title === "string"
          ? f.title
          : null;
  if (!id || !title) return null;
  const raw = scopeField === "workspace" ? "" : f[scopeField];
  // A record whose scope field is empty is "loose" — every loose one shares a
  // scope, which is right: two "Shelf 1"s filed nowhere are still two of them.
  return { id, title, scope: typeof raw === "string" ? raw : raw == null ? "" : String(raw) };
}

/** Records sharing a title within the same scope. The FIRST one in the
 *  workspace's own order stays: it is the first one a person sees on the screen
 *  they are looking at, and the one other things have had longest to point at. */
export function duplicateGroups(rows: Row[]): Array<{ keep: Row; remove: Row[] }> {
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.scope}|${r.title.trim().toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const out: Array<{ keep: Row; remove: Row[] }> = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const [keep, ...remove] = group;
    if (keep && remove.length) out.push({ keep, remove });
  }
  return out;
}

/** "Delete 2 duplicate parts (M3 bolt), keeping the original of each." */
export function describeDuplicates(
  groups: Array<{ keep: Row; remove: Row[] }>,
  noun = "place",
): string {
  const n = groups.reduce((t, g) => t + g.remove.length, 0);
  const names = [...new Set(groups.map((g) => g.keep.title))].slice(0, 4).join(", ");
  const more = groups.length > 4 ? ` and ${groups.length - 4} more` : "";
  return `Delete ${n} duplicate ${n === 1 ? noun : pluralise(noun)} (${names}${more}), keeping the original of each.`;
}

/** Can this kind hold one of ITSELF? A place inside a place.
 *
 *  Asking instead whether its scope points at anything we know gets it
 *  catastrophically wrong: a part's scope points at a LOCATION, which we do
 *  know, so parts looked like containers and "delete empty places" offered to
 *  delete every part with nothing inside it — which is all of them. It did,
 *  too, in the first run of this. */
export function containsItsOwnKind(rows: Row[]): boolean {
  const own = new Set(rows.map((r) => r.id));
  return rows.some((r) => r.scope && own.has(r.scope));
}

/** One pass over everything a kind has said can be read as "inside something".
 *
 *  Shared by the commands below because they ask the same question from
 *  different sides: a link that points at nothing (an orphan), and a place
 *  nothing points at (an empty one).
 *
 *  `truncated` matters more than it looks: a list capped at 500 makes every
 *  record beyond it invisible, and an invisible record is indistinguishable
 *  from one that does not exist. Both readings below would then be WRONG in
 *  the dangerous direction — clearing a good link, deleting a full shelf — so
 *  a truncated scan disables them rather than guessing. */
async function scanScoped(wsApi: WorkspaceApi): Promise<{
  kinds: Array<{ id: string; noun: string; scopeField: string; rows: Row[] }>;
  ids: Set<string>;
  truncated: boolean;
} | null> {
  const kindRecs = (await fetchKinds(wsApi).catch(() => [])).filter(
    (k) => k.duplicate_scope && k.duplicate_scope !== "workspace",
  );
  if (!kindRecs.length) return null;
  const out: Array<{ id: string; noun: string; scopeField: string; rows: Row[] }> = [];
  const ids = new Set<string>();
  let truncated = false;
  for (const k of kindRecs) {
    const r = await getTool("list_records")!.execute(wsApi, { kind: k.id, limit: 500 });
    if (!r.ok) return null;
    const body = r.data as { items?: unknown[]; note?: string };
    if (body.note) truncated = true;
    const scopeField = String(k.duplicate_scope);
    const rows = (body.items ?? [])
      .map((rec) => rowOf(rec, scopeField))
      .filter((x): x is Row => !!x);
    for (const row of rows) ids.add(row.id);
    out.push({
      id: k.id,
      noun: (k.display_name ?? k.id.split(":").pop() ?? "record").toLowerCase(),
      scopeField,
      rows,
    });
  }
  return { kinds: out, ids, truncated };
}


/** Does this value MENTION the term, as a word rather than a substring?
 *
 *  Substring matching would file the "OXO Silicone Pressure Cooker STEAMER
 *  Baskets" under Tea, because "steamer" contains "tea". A move is not the
 *  place to be approximately right: it changes which list a person's things
 *  live in, and the one they never asked about is the one they will not think
 *  to look for. So words, with a plural allowed - "Teas", "Tea bags" and "Tea
 *  & Infusions" all mention tea; "Steamer" does not.
 */
export function mentionsWord(value: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < 2) return false;
  for (const w of value.toLowerCase().split(/[^a-z0-9']+/)) {
    if (!w) continue;
    if (w === t || w === `${t}s` || w === `${t}es`) return true;
    // "Groceries" for the grocery, and "teas" for the tea: a plural either
    // side, including the -y/-ies kind.
    if (t.endsWith("y") && w === `${t.slice(0, -1)}ies`) return true;
    if (t === `${w}s` || t === `${w}es` || (w.endsWith("y") && t === `${w.slice(0, -1)}ies`)) return true;
    // "teabags" is one word for two, and a person writing it means tea.
    if (w.length > t.length + 2 && w.startsWith(t)) return true;
  }
  return false;
}

/** Every string a record shows, for the match above: its title and its own
 *  field values (which is where a category like "Tea & Infusions" lives),
 *  one level down included, since a bundle's own fields sit in `metadata`. */
export function saidOf(rec: unknown): string[] {
  const r = rec as { title?: unknown; fields?: Record<string, unknown> } | null;
  const out: string[] = [];
  if (typeof r?.title === "string") out.push(r.title);
  for (const v of Object.values(r?.fields ?? {})) {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const w of Object.values(v as Record<string, unknown>)) if (typeof w === "string") out.push(w);
    }
  }
  return out;
}

/** "move all the tea from this page into the Tea section" ->
 *  { term: "tea", destination: "Tea" }.
 *
 *  The DESTINATION MUST BE CALLED A LIST - "into the Tea section", "into the
 *  Tea list". Without that word the sentence is genuinely ambiguous and this
 *  is the wrong thing to answer it: "put the Kossel Mini in the Garage" and
 *  "move the multimeter to the electronics bin" are containers, not lists, and
 *  reading them as a move between lists would file someone's printer into a
 *  list they never asked for. The chat corpus pins all three as never-offer,
 *  and caught this being too greedy the first time it was written.
 *
 *  So the bar is: they said "section" or "list", and the thing they named IS
 *  one. A bare "move the tea into Tea" is left to the model, which now has an
 *  action for it. */
export function readMoveRequest(
  message: string,
): { term: string; terms?: string[]; destination: string; create?: true; thisPage?: true; source?: string } | null {
  // "get all the tea out of inventory and into the dedicated tea section" is
  // the sentence that reached the model and came back as a card saying only
  // "Move records into another list" (2026-09-11). Every part of it is a move
  // this reader already understood, said with other words: get/take for
  // move, "out of" for from, "and into" for into, "dedicated" for nothing.
  const m =
    /\b(?:move|put|file|shift|get|take|pull|grab|drag)\s+(?:all\s+)?(?:of\s+)?(?:the\s+|my\s+)?(?<term>[a-z0-9'&\-\/, ]{2,60}?)\s+(?:(?:from|out of)\s+(?<src>[a-z0-9'&\- ]{2,40}?)\s+(?:and\s+)?)?(?:into|in|to|under)\s+(?:the\s+)?(?<dest>[a-z0-9'&\- ]{2,40}?)\s+(?:section|list|group|tab)s?\s*$/i.exec(
      message.trim(),
    );
  // "the other grocery", "the remaining teas", "the rest of the spices": the
  // rest of them, which is not part of what they are called. And "grocery/
  // spices", "the grocery and spices": several things, each read on its own.
  const terms = (m?.groups?.term?.trim() ?? "")
    .split(/\s*(?:\/|,|&|\band\b|\bor\b|\bplus\b)\s*/i)
    .map((t) => t.replace(/^(?:the|my)\s+/i, "").replace(/^(?:other|remaining|leftover|rest of (?:the|my)?)\s+/i, "").replace(/^(?:the|my)\s+/i, "").trim())
    .filter((t) => t.length >= 2);
  const term = terms[0];
  const several = terms.length > 1 ? { terms } : {};
  // "the dedicated tea section" is the Tea section: the adjective says how the
  // person feels about the list, not what it is called.
  const rawDest = m?.groups?.dest?.trim() ?? "";
  const destination = rawDest.replace(/^(?:dedicated|separate|special|proper|new|own)\s+/i, "");
  // "from this page" / "from here" is a SCOPE, and it used to be parsed and
  // dropped: the plan then searched the whole workspace while the sentence
  // said otherwise (seen on a page that was not a list at all, 2026-09-09).
  const srcSaid = m?.groups?.src?.trim() ?? "";
  const thisPage = /^(?:this|the current)\s+(?:page|screen|list|view)$|^here$/i.test(srcSaid);
  // "out of inventory", "from the pantry": the list to look in, which is a
  // scope the way "from this page" is. It used to be parsed and dropped, so
  // "get the tea out of inventory" would have taken the tea in Pantry too.
  // "out of the pantry and put it in the Tea list": the source ends where a
  // second verb starts.
  const source = !thisPage && srcSaid ? srcSaid.replace(/^(?:the|my)\s+/i, "").split(/\s+(?:and|then)\s+/i)[0]!.trim() : "";
  const scope = { ...(thisPage ? { thisPage: true as const } : {}), ...(source ? { source } : {}) };
  if (!term || !destination) return null;
  // "move this into X" and "move it into X" name nothing to look for; the
  // model has the conversation and the screen, and this does not.
  if (/^(this|that|these|those|it|them|everything|all)$/i.test(term)) return null;
  // "into its own section", "into a new list", "into the dedicated section":
  // the list is the one FOR these things, named after them. "Tea" for the
  // tea. It may not exist yet, and the plan finds out which.
  if (/^(?:its|their|a|the)\s+(?:own|new)$/i.test(destination) || /^(?:dedicated|separate|special|proper|new|own)$/i.test(rawDest)) {
    return { term, ...several, destination: titleCase(term), create: true, ...scope };
  }
  return { term, ...several, destination, ...scope };
}

/** The one line over the list. Several things are counted here and named
 *  in the lines under it, once; a single thing is named here and gets no
 *  list. The first bubble named the five teas in the headline AND as bullets
 *  (2026-09-09); the bullets are the ones worth keeping. */
export function moveHeadline(o: {
  titles: string[];
  label: string;
  creating: boolean;
  /** The lists they are in now. */
  sources?: string[];
  /** True when the search was held to the page or the list the person named. */
  scoped?: boolean;
  /** True when the page they named held none of these, and what is offered
   *  is what exists elsewhere. */
  emptyPage?: boolean;
  /** What the scope is called: a named list ("Pantry"), or the page. */
  where?: string;
}): string {
  const n = o.titles.length;
  const what = n === 1 ? o.titles[0]! : `${n}`;
  const here = o.where ? `in ${o.where}` : "on this page";
  // Nothing here. Say that before offering anything else, or the offer reads
  // as an answer to a question nobody asked.
  if (o.emptyPage) {
    return o.creating
      ? `None ${here}. Create a ${o.label} section and move the ${what} elsewhere into it?`
      : `None ${here}. Move the ${what} elsewhere into ${o.label}?`;
  }
  // Where from, said once: the page when that is what was searched, the one
  // list when there is one, and "every list" when the search was wider than
  // the sentence asked for. Silence about scope is how "from this page" ended
  // up meaning the whole workspace.
  const src = o.sources ?? [];
  const from = o.scoped
    ? ` from ${o.where ?? "this page"}`
    : src.length === 1
      ? ` from ${src[0]}`
      : src.length > 1
        ? ` from every list`
        : "";
  return o.creating
    ? `Create a ${o.label} section and move ${what}${from} into it.`
    : `Move ${what}${from} into ${o.label}.`;
}

/** What the plan found and is NOT touching. Empty when there is nothing to
 *  add: a plan that took everything it found needs no footnote. */
export function moveNote(o: {
  term: string;
  here: number;
  elsewhere: number;
  emptyPage: boolean;
  sources?: string[];
  /** What the scope is called: a named list ("Pantry"), or the page. */
  where?: string;
}): string {
  const total = o.here + o.elsewhere;
  const here = o.where ? `in ${o.where}` : "on this page";
  if (o.emptyPage) {
    // The lists they are in, said as a clause: a parenthesis holding a comma
    // list is the shape this note gave up.
    const srcs = o.sources ?? [];
    const where = srcs.length ? `, in ${srcs.length > 1 ? `${srcs.slice(0, -1).join(", ")} and ${srcs[srcs.length - 1]}` : srcs[0]}` : "";
    return `No ${o.term} ${here}. There ${o.elsewhere === 1 ? "is 1" : `are ${o.elsewhere}`} elsewhere${where}.`;
  }
  const parts: string[] = [];
  if (o.elsewhere > 0) {
    parts.push(
      `${o.here} of the ${total} ${o.term} in this workspace ${o.here === 1 ? "is" : "are"} ${here}; ` +
        `the other ${o.elsewhere} ${o.elsewhere === 1 ? "stays where it is" : "stay where they are"}.`,
    );
  }
  // What the word did not reach is not a sentence here: those records are the
  // plan's own labelled block ("Left in Inventory, could not tell (6):"), one
  // chip each, with the continuation under its label.
  return parts.join(" ");
}

/** The continuation under the list of what a plan left: what Enter does. */
export const LOOK_THROUGH_HINT = "Send the message and Cobb will look through them.";

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** What each module's DEFAULT list is called, by module name. Empty when the
 *  workspace cannot say, and the caller falls back to the module's own name. */
async function defaultInstanceNames(wsApi: WorkspaceApi): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const r = await wsApi.request("GET", "/instances");
    const items = ((r as { body?: { items?: unknown[] } }).body?.items ?? []) as Array<{
      module_name?: unknown;
      display_name?: unknown;
      is_default?: unknown;
    }>;
    for (const i of items) {
      if (i.is_default !== true) continue;
      if (typeof i.module_name === "string" && typeof i.display_name === "string") out.set(i.module_name, i.display_name);
    }
  } catch {
    /* the fallback below is a good enough name */
  }
  return out;
}

/** The name to print for the list a record is in. */
export function listNameOf(
  k: { id: string; display_name?: string | null; instance_name?: string | null; module_name?: string | null },
  defaults: Map<string, string>,
): string {
  // A named list already IS what a person calls it.
  if (k.instance_name) return k.display_name ?? k.instance_name;
  const mod = k.module_name ?? "";
  return defaults.get(mod) ?? titleCase(mod.replace(/^core-/, "").replace(/-/g, " ")) ?? k.id;
}

/** What a new list is called internally, from what a person called it. The
 *  kernel derives the same when the name is left blank; it is sent so the
 *  move that follows can name the list before the kernel has said. */
function instanceSlug(displayName: string): string {
  return displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** "sort the rest of inventory into the right sections" -> { source:
 *  "inventory" }; "file everything on this page into the correct lists" ->
 *  { thisPage: true }. The list to sort is the one the sentence names, or the
 *  page; with neither, the plan looks for a list named anywhere in it. */
export function readSortRequest(message: string): { source?: string; thisPage?: true } | null {
  const m = message.trim();
  if (!SORT_MATCH.test(m)) return null;
  const src = /\b(?:in|from|out of|on|of)\s+(?:the\s+|my\s+)?(?<src>[a-z][a-z0-9'&\- ]{1,30}?)\s+(?:into|to|where)\b/i.exec(m)?.groups?.src?.trim() ?? "";
  if (/^(?:this|the current)\s+(?:page|screen|list|view)$|^here$/i.test(src)) return { thisPage: true };
  if (src && !/^(?:everything|the rest|rest|these|it|them|all)$/i.test(src)) return { source: src };
  const bare = /\b(?:sort|organi[sz]e|tidy(?:\s+up)?)\s+(?:the\s+|my\s+)?(?<list>[a-z][a-z0-9'&\- ]{1,30}?)\s+into\b/i.exec(m)?.groups?.list?.trim();
  return bare && !/^(?:everything|the rest|rest|these|it|them|all)$/i.test(bare) ? { source: bare } : {};
}

// A COLLECTIVE subject ("everything", "the rest", "the other items") going to
// the RIGHT/own places, or "where it belongs"; or plainly sorting a list into
// sections. "move the tea into its own section" has no collective subject and
// stays the single move; "sort the parts by name" is an order, not a sort
// into lists.
const SORT_MATCH =
  /\b(?:everything|the rest|rest of|all of (?:it|them|this|these)|what'?s left|the other (?:items|things|stuff|ones)|the others)\b[\s\S]{0,40}?\b(?:into|to)\s+(?:the\s+|their\s+|its\s+)?(?:right|correct|proper|matching|own)\s+(?:sections?|lists?|places?|spots?|locations?)\b|\bwhere (?:it|they|things|everything) belongs?\b|\b(?:sort|organi[sz]e|tidy(?:\s+up)?)\s+(?:the\s+|my\s+)?[a-z][a-z0-9'&\- ]{1,30}?\s+into\s+(?:sections|lists)\b/i;

export const COMPUTED_COMMANDS: ComputedCommand[] = [
  {
    id: "sort-into-lists",
    match: SORT_MATCH,
    template: "sort a list into sections",
    description: "Move each record in a list into the section its category names, and give a category with no section one of its own.",
    async plan({ wsApi, message, pageKind }) {
      const said = readSortRequest(message);
      if (!said) return null;
      const kinds = await fetchKinds(wsApi).catch(() => []);
      const listNames = await defaultInstanceNames(wsApi);
      // The list to sort: the page, the one named, or one named anywhere in
      // the sentence. It has to be a list of a module that HAS lists.
      const listed = new Set(kinds.filter((k) => !!k.instance_name).map((k) => k.module_name)); // registry-filter-ok: the modules that have lists, whose primary kinds count as lists too
      const candidates = kinds.filter((k) => listed.has(k.module_name));
      const byName = (name: string) =>
        candidates.find(
          (k) =>
            (k.instance_name ?? "").toLowerCase() === name.toLowerCase() ||
            mentionsWord(listNameOf(k, listNames), name) ||
            mentionsWord(k.display_name ?? "", name),
        );
      const scope = said.thisPage
        ? candidates.find((k) => k.id === pageKind)
        : said.source
          ? byName(said.source)
          : (candidates.find((k) => k.id === pageKind) ?? candidates.find((k) => mentionsWord(message, listNameOf(k, listNames))));
      if (!scope) return null;
      const where = listNameOf(scope, listNames);
      const fromInstance = scope.instance_name ?? scope.module_name ?? "";
      // registry-filter-ok: the SECTIONS a category can name are the module's named lists; the primary kind is the list being sorted, or a category nobody files things under
      const sections = kinds.filter((k) => k.module_name === scope.module_name && !!k.instance_name && k.id !== scope.id);
      const r = await getTool("list_records")!.execute(wsApi, { kind: scope.id, limit: 500 });
      if (!r.ok) return null;
      type Rec = { id: string; title: string; category: string | null };
      const recs: Rec[] = [];
      for (const rec of ((r.data as { items?: unknown[] })?.items ?? [])) {
        const row = rec as { id?: unknown; title?: unknown; fields?: Record<string, unknown> };
        if (typeof row.id !== "string") continue;
        const cat = row.fields?.category_name;
        recs.push({ id: row.id, title: typeof row.title === "string" ? row.title : row.id, category: typeof cat === "string" && cat.trim() ? cat.trim() : null });
      }
      // Group by what each is filed under. A category that names an existing
      // section moves there; one with enough for a section of its own gets
      // one (the promote-category action: the list is created and the records
      // moved, and folding it back is its undo); one alone in its category,
      // or with none, is named and left.
      const byCategory = new Map<string, Rec[]>();
      for (const rec of recs) if (rec.category) byCategory.set(rec.category, [...(byCategory.get(rec.category) ?? []), rec]);
      const moves = new Map<string, { dest: (typeof sections)[number]; recs: Rec[] }>();
      const promotions: Array<{ category: string; recs: Rec[] }> = [];
      const alone: Rec[] = [];
      for (const [category, group] of byCategory) {
        const dest = sections.find(
          (k) => mentionsWord(listNameOf(k, listNames), category) || mentionsWord(category, listNameOf(k, listNames)) || (k.instance_name ?? "") === instanceSlug(category),
        );
        if (dest) {
          const cur = moves.get(dest.id) ?? { dest, recs: [] };
          cur.recs.push(...group);
          moves.set(dest.id, cur);
        } else if (group.length >= 2) promotions.push({ category, recs: group });
        else alone.push(...group);
      }
      const uncategorised = recs.filter((x) => !x.category);
      if (!moves.size && !promotions.length) return null;
      const planSections: PlanSection[] = [];
      const labels = new Map<string, string>();
      const parts: string[] = [];
      for (const { dest, recs: group } of moves.values()) {
        const label = listNameOf(dest, listNames);
        const key = `into:${dest.instance_name!}`;
        labels.set(key, label);
        planSections.push({
          key,
          heading: `${group.length} into ${label}`,
          lines: group.map((x) => ({ id: x.id, title: x.title, kind: scope.id })),
          operations: [{ tool: "action", entity_kind: "", action_id: "platform:move-records", payload: { ids: group.map((x) => x.id), to: dest.instance_name! } }],
        });
        parts.push(`${group.length} into ${label}`);
      }
      for (const { category, recs: group } of promotions) {
        const label = titleCase(category);
        const key = `new:${instanceSlug(category)}`;
        labels.set(key, `${label} (new section)`);
        planSections.push({
          key,
          heading: `${group.length} into a new ${label} section`,
          lines: group.map((x) => ({ id: x.id, title: x.title, kind: scope.id })),
          operations: [{ tool: "action", entity_kind: "", action_id: "platform:promote-category", payload: { from: fromInstance, category, display_name: label } }],
        });
        parts.push(`${group.length} into a new ${label} section`);
      }
      const { operations, lines } = flatten(planSections, (s) => labels.get(s.key) ?? "");
      const moved = operations.length ? lines.length : 0;
      const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] ?? "");
      // The records it left are the card's own labelled block, each with its
      // reason, none hidden in a parenthesis.
      const leftRecs = [
        ...alone.map((x) => ({ id: x.id, title: x.title, kind: scope.id, why: "alone in its category" })),
        ...uncategorised.map((x) => ({ id: x.id, title: x.title, kind: scope.id, why: "no category" })),
      ];
      return {
        summary: `Sort ${moved} from ${where}: ${list(parts)}.`,
        lines,
        ...(leftRecs.length ? { leftHeading: leftHeadingFor(where, leftRecs.length), also: leftRecs, hint: LOOK_THROUGH_HINT } : {}),
        ...(planSections.length ? { sections: planSections } : {}),
        operations,
      };
    },
  },
  {
    id: "move-into-list",
    // The sentence that started this: "move all the tea from this page into
    // the Tea section". Reported twice, with screenshots, because the model
    // had no right answer to reach for - once it created a second copy of two
    // items and said it had moved them, once it proposed deleting them
    // (2026-09-08). Neither was reachable: moving between lists flips a column
    // no write tool can touch. Now there is an action for it, and this plans
    // it without a model at all.
    // The offer strip shows this before anything is planned, so the match has
    // to be as narrow as the parse: a destination the person CALLED a list.
    match: /\b(move|put|file|shift|get|take|pull|grab|drag)\b[\s\S]{0,60}\b(?:into|in|to|under)\s+(?:the\s+)?[a-z0-9'&\- ]{2,40}?\s+(?:section|list|group|tab)s?\b/i,
    template: "move things into another list",
    description: "Move records that already exist from one list into another, keeping their photos, history and labels.",
    async plan({ wsApi, selectionIds, message, pageKind }) {
      const said = readMoveRequest(message);
      if (!said) return null;
      const kinds = await fetchKinds(wsApi).catch(() => []);
      // Several things, each into its own section ("grocery/ spices ... into
      // the dedicated sections"): one destination per thing, found or made
      // below. One thing, or several into one named list: one destination.
      const terms = said.terms ?? [said.term];
      const termWord = terms.join(" or ");
      const each = !!said.terms && !!said.create;
      const listFor = (name: string) =>
        kinds.find(
          (k) =>
            !!k.instance_name &&
            (mentionsWord(k.display_name ?? "", name) || (k.instance_name ?? "").toLowerCase() === name.toLowerCase()),
        );
      // The destination has to BE a list. "Put the drill in Bin 4" reads the
      // same and means a container, which is a different action entirely - so
      // this asks the workspace rather than the sentence, and falls through
      // when the answer is no.
      const dest = each ? undefined : listFor(said.destination);
      // "into its own section" with no such list yet: it will be created,
      // from whichever module the things being moved belong to. The list is
      // found from the records, not guessed: they are looked for in every
      // list, and the plan only stands when they all live under one module.
      const creating = !each && !dest && said.create;
      if (!each && !dest?.instance_name && !creating) return null;
      // Its siblings: the other lists of the same module, which is where the
      // things being moved actually are.
      // Where the things could be. With a destination, its module's other
      // lists (the module's own primary list included: the tea in Inventory
      // is as movable as the tea in Pantry). Without one, every list of
      // every module that has lists at all, primary included - the first
      // live run asked for chamomile "in its own section" while the
      // chamomile sat in Inventory itself, found nothing in Pantry and Tea,
      // and offered nothing (2026-09-09). A module with no lists yet is
      // left to the model, which can create the first one.
      const listed = new Set(kinds.filter((k) => !!k.instance_name).map((k) => k.module_name)); // registry-filter-ok: names the modules that have lists, to include their primary kinds below
      // What each list is CALLED. A named list carries its own display name;
      // a module's primary kind carries the singular noun of a record instead
      // ("Part"), so "(in Part)" is what a person was told the tea was in. The
      // default instance is what they actually see in the nav ("Inventory"),
      // so it is asked for, with the module's own name as the fallback.
      const listNames = await defaultInstanceNames(wsApi);
      const everywhere = dest
        ? kinds.filter((k) => k.module_name === dest.module_name && k.id !== dest.id)
        : kinds.filter((k) => listed.has(k.module_name));
      // THE PAGE COMES FIRST, and the rest is still worth knowing. Every list
      // is read, and the split happens after: what is on the page the person
      // named, and what is not. Reading only the page would make "none here"
      // indistinguishable from "nothing anywhere", and reading only the whole
      // workspace is how "from this page" came to mean all of it.
      // A page counts as a page whenever the workspace knows the kind it lists,
      // not only when that kind is one of the lists being searched. A page of
      // locations holds no tea, and saying so is the answer; treating it as
      // "no page at all" silently widened the search to the whole workspace,
      // which is the thing this was written to stop.
      // THE SCOPE: the page, when the sentence said "this page"; the list it
      // named, when it named one ("out of inventory"); nothing otherwise.
      const pageIsAList = !!said.thisPage && !!pageKind && kinds.some((k) => k.id === pageKind);
      const namedList = said.source
        ? everywhere.find(
            (k) =>
              (k.instance_name ?? "").toLowerCase() === said.source!.toLowerCase() ||
              mentionsWord(listNameOf(k, listNames), said.source!) ||
              mentionsWord(k.display_name ?? "", said.source!),
          )
        : undefined;
      const scopeKind = pageIsAList ? pageKind! : namedList?.id;
      const where = namedList && !pageIsAList ? listNameOf(namedList, listNames) : undefined;
      // What each named destination IS, by the rule the scan floor routes
      // with: its noun, the words its bundle declared, its category axis. A
      // record is matched to a term by that vocabulary in its NAME, or by the
      // literal word (the person's own term in its name or category). When
      // it fits several, the narrower table wins: Spices over Groceries.
      const destKinds = terms.map((t) => (each ? listFor(t) : dest)).filter((k): k is NonNullable<typeof k> => !!k);
      const fitTables = destKinds.length ? await fitTablesFor(wsApi, destKinds).catch(() => new Map<string, FitTable>()) : new Map<string, FitTable>();
      const destTables = terms.flatMap((term) => {
        const k = each ? listFor(term) : dest;
        const table = k ? fitTables.get(k.id) : undefined;
        return table ? [{ ...table, term }] : [];
      });
      const found: Array<{ id: string; title: string; module: string; from: string; kind: string; term: string; why?: string }> = [];
      // Everything on the page, matched or not, so the offer can name what it
      // is leaving there.
      const onPage: Array<{ id: string; title: string; kind: string }> = [];
      for (const k of everywhere) {
        const r = await getTool("list_records")!.execute(wsApi, { kind: k.id, limit: 500 });
        if (!r.ok) continue;
        for (const rec of ((r.data as { items?: unknown[] })?.items ?? [])) {
          const row = rec as { id?: unknown; title?: unknown };
          const id = typeof row.id === "string" ? row.id : null;
          if (!id) continue;
          if (selectionIds?.length && !selectionIds.includes(id)) continue;
          if (scopeKind && k.id === scopeKind) onPage.push({ id, title: typeof row.title === "string" ? row.title : id, kind: k.id });
          const what = saidOf(rec);
          const literal = terms.find((t) => what.some((v) => mentionsWord(v, t)));
          const fields = ((rec as { fields?: Record<string, unknown> }).fields ?? {}) as Record<string, unknown>;
          const title = typeof row.title === "string" ? row.title : id;
          const fits = destTables.length
            ? rankFits(
                {
                  name: title,
                  category: typeof fields.category_name === "string" ? fields.category_name : null,
                  description: typeof fields.description === "string" ? fields.description : null,
                },
                destTables,
                "named",
              )
            : [];
          const best = fits[0];
          const hit = best?.table.term ?? literal;
          if (!hit) continue;
          // A thing already in its own section is home, not elsewhere.
          if (each && listFor(hit)?.id === k.id) continue;
          // The word that put it there, when that was the table's vocabulary
          // and not the person's term; and what it beat, when it fit two.
          const word = best ? (best.evidence.nameHits[0] ?? best.table.noun) : undefined;
          const overWhat = best && fits.length > 1 ? fits.slice(1).map((f) => f.table.label) : literal && best && literal !== best.table.term ? [destTables.find((d) => d.term === literal)?.label ?? literal] : [];
          const why = best && word && !mentionsWord(word, hit) ? `${word}${overWhat.length ? `, over ${overWhat.join(" and ")}` : ""}` : undefined;
          found.push({
            id,
            title,
            module: k.module_name ?? "",
            from: listNameOf(k, listNames),
            kind: k.id,
            term: hit,
            ...(why ? { why } : {}),
          });
        }
      }
      if (!found.length) return null;
      // What is on the page, and what is not. With no page scope stated (or a
      // page that is not a list at all) everything found is in scope, and the
      // headline says where it looked.
      const here = scopeKind ? found.filter((x) => x.kind === scopeKind) : found;
      const elsewhere = scopeKind ? found.filter((x) => x.kind !== scopeKind) : [];
      // Some here: move exactly those, and say what was left where it is.
      // None here: say so first, then offer the ones that do exist, named -
      // a dead end that knows the answer is worse than no dead end.
      const emptyPage = !!scopeKind && here.length === 0;
      const moving = emptyPage ? elsewhere : here;
      const scoped = !!scopeKind && !emptyPage;
      if (!moving.length) return null;
      const modules = [...new Set(moving.map((x) => x.module))];
      // Things from two modules cannot share one new list; say nothing rather
      // than pick one and quietly leave the rest behind.
      if (creating && modules.length !== 1) return null;
      const label = dest ? (dest.display_name ?? dest.instance_name!) : said.destination;
      const toName = dest ? dest.instance_name! : instanceSlug(said.destination);
      const move: Operation = {
        tool: "action",
        entity_kind: "",
        action_id: "platform:move-records",
        payload: { ids: moving.map((x) => x.id), to: toName },
      };
      const titles = moving.map((x) => x.title);
      const reasoned = (x: (typeof moving)[number], base: string): string => (x.why ? `${base} (${x.why})` : base);
      const sources = [...new Set(moving.map((x) => x.from))];
      // Where they came from, on every line, when they did not all come from
      // one place. A person who said "from this page" and got things from
      // three lists can see that at a glance instead of finding out after.
      // Where each one is, whenever that is not already obvious: several
      // lists, or a plan the person did not think they were asking for.
      const named = sources.length > 1 || emptyPage ? moving.map((x) => reasoned(x, `${x.title} (in ${x.from})`)) : moving.map((x) => reasoned(x, x.title));
      const left = scoped ? onPage.filter((p) => !here.some((h) => h.id === p.id)) : [];
      const note = moveNote({ term: termWord, here: here.length, elsewhere: elsewhere.length, emptyPage, sources, ...(where ? { where } : {}) });
      // The block of what it left: its label with the count, and the
      // continuation under it, only when there is one.
      const hint = left.length ? { leftHeading: leftHeadingFor(where ?? "this page", left.length), hint: LOOK_THROUGH_HINT } : {};
      if (each) {
        // One group per thing, in the order they were said: the list called
        // that, or a new one named after it. Made lists need one module.
        type Group = { label: string; toName: string; creating: boolean; module: string; recs: typeof moving };
        const groups: Group[] = [];
        const missing: string[] = [];
        for (const t of terms) {
          const recs = moving.filter((x) => x.term === t);
          if (!recs.length) {
            missing.push(t);
            continue;
          }
          const existing = listFor(t);
          const mods = [...new Set(recs.map((x) => x.module))];
          if (!existing && mods.length !== 1) return null;
          groups.push({
            label: existing ? (existing.display_name ?? existing.instance_name!) : titleCase(t),
            toName: existing ? existing.instance_name! : instanceSlug(t),
            creating: !existing,
            module: mods[0]!,
            recs,
          });
        }
        if (!groups.length) return null;
        const sections: PlanSection[] = [];
        const labels = new Map<string, string>();
        const parts: string[] = [];
        for (const g of groups) {
          const key = `${g.creating ? "new" : "into"}:${g.toName}`;
          labels.set(key, `${g.label}${g.creating ? " (new section)" : ""}`);
          sections.push({
            key,
            heading: g.creating ? `${g.recs.length} into a new ${g.label} section` : `${g.recs.length} into ${g.label}`,
            lines: g.recs.map((x) => ({ id: x.id, title: x.title, kind: x.kind, ...(x.why ? { why: x.why } : {}) })),
            operations: [
              ...(g.creating
                ? [{ tool: "action" as const, entity_kind: "", action_id: "platform:create-instance", payload: { module_name: g.module, display_name: g.label, instance_name: g.toName } }]
                : []),
              { tool: "action", entity_kind: "", action_id: "platform:move-records", payload: { ids: g.recs.map((x) => x.id), to: g.toName } },
            ],
          });
          parts.push(g.creating ? `${g.recs.length} into a new ${g.label} section` : `${g.recs.length} into ${g.label}`);
        }
        const { operations, lines } = flatten(sections, (s) => labels.get(s.key) ?? "");
        const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] ?? "");
        const from = scoped ? ` from ${where ?? "this page"}` : sources.length === 1 ? ` from ${sources[0]}` : sources.length > 1 ? " from every list" : "";
        const none = missing.length ? `No ${missing.join(" or ")} ${where ? `in ${where}` : "on this page"}. ` : "";
        return {
          summary: `${emptyPage ? "None here. " : ""}Move ${moving.length}${from}: ${list(parts)}.`,
          ...(none || note ? { note: `${none}${note}`.trim() } : {}),
          ...(left.length ? { also: left } : {}),
          ...hint,
          ...(sections.length ? { sections } : {}),
          lines,
          operations,
        };
      }
      if (creating) {
        return {
          summary: moveHeadline({ titles, label, creating: true, sources, scoped, emptyPage, ...(where ? { where } : {}) }),
          ...(note ? { note } : {}),
          ...(left.length ? { also: left } : {}),
          ...hint,
          to: { name: toName, label },
          lines: [`New section: ${label}`, ...named],
          operations: [
            {
              tool: "action",
              entity_kind: "",
              action_id: "platform:create-instance",
              payload: { module_name: modules[0]!, display_name: label, instance_name: toName },
            },
            move,
          ],
        };
      }
      return {
        summary: moveHeadline({ titles, label, creating: false, sources, scoped, emptyPage, ...(where ? { where } : {}) }),
        ...(note ? { note } : {}),
        ...(left.length ? { also: left } : {}),
        ...hint,
        to: { name: toName, label },
        // One thing is named in the headline; a list of several is named
        // once, in the lines, not twice. When none were on the page, the list
        // is the answer to "do you mean these?" and is always worth showing.
        ...(titles.length > 1 || emptyPage ? { lines: named } : {}),
        operations: [move],
      };
    },
  },
  {
    id: "duplicates",
    // "delete duplicates", "remove the duplicates", "clean up duplicates" —
    // but NOT "delete the duplicate rack": "duplicate" followed by a noun names
    // ONE record, and sweeping the whole workspace when someone pointed at one
    // thing is an interception, not a favour (chat corpus, 2026-08-25).
    match: /\b(delete|remove|clean\s*up|clear|get\s+rid\s+of)\s+(the\s+)?(duplicates|duplicate\s+\w+s)\b|\b(delete|remove|clean\s*up|clear|get\s+rid\s+of)\s+duplicate\b(?!\s+\w)/i,
    template: "delete duplicates",
    description: "Find places with the same name in the same spot and remove the extra ones.",
    async plan({ wsApi, selectionIds }) {
      // Every kind that has SAID how to read "the same place" for itself. A
      // kind that has not is left alone: two assets called "Drill" are usually
      // two drills, and guessing otherwise is the guess that deletes work.
      const kinds = (await fetchKinds(wsApi).catch(() => [])).filter((k) => k.duplicate_scope);
      const operations: Operation[] = [];
      const parts: string[] = [];
      for (const k of kinds) {
        const r = await getTool("list_records")!.execute(wsApi, { kind: k.id, limit: 500 });
        if (!r.ok) continue;
        const scopeField = String(k.duplicate_scope);
        const rows = ((r.data as { items?: unknown[] })?.items ?? [])
          .map((rec) => rowOf(rec, scopeField))
          .filter((x): x is Row => !!x);
        // A selection SCOPES it: pointing at Rack 1 and saying "delete
        // duplicates" means the ones in there, not every duplicate you own.
        const scoped = selectionIds?.length
          ? rows.filter((i) => selectionIds.includes(i.id) || selectionIds.includes(i.scope))
          : rows;
        const groups = duplicateGroups(scoped);
        if (!groups.length) continue;
        const noun = (k.display_name ?? k.id.split(":").pop() ?? "record").toLowerCase();
        parts.push(describeDuplicates(groups, noun));
        for (const g of groups) {
          for (const dupe of g.remove) {
            operations.push({ tool: "delete", entity_kind: k.id, entity_id: dupe.id, payload: {} });
          }
        }
      }
      if (!operations.length) return null;
      return { summary: parts.join(" "), operations };
    }
  },
  {
    id: "orphans",
    // Not "clean up": this clears a FIELD on records a person may care about,
    // and the sentence should say so.
    // "orphans" and "orphaned records" both mean this; "fix broken links" is
    // the phrase people who do not think in database terms actually type.
    match: /\b(fix|clear|clean\s*up|find)\s+(the\s+)?(broken|dead|orphan(ed)?)\s+(links?|references?|locations?|records?)\b|\borphan(s|ed)?\b/i,
    template: "fix broken links",
    description: "Find records filed in a place that no longer exists, and clear the dead link.",
    async plan({ wsApi, selectionIds }) {
      const scan = await scanScoped(wsApi);
      // A capped list cannot tell "gone" from "not read yet", and clearing a
      // good link is a real loss. Say nothing rather than guess.
      if (!scan || scan.truncated) return null;
      const operations: Operation[] = [];
      const names: string[] = [];
      for (const k of scan.kinds) {
        for (const row of k.rows) {
          if (!row.scope || scan.ids.has(row.scope)) continue;
          if (selectionIds?.length && !selectionIds.includes(row.id)) continue;
          operations.push({
            tool: "update",
            entity_kind: k.id,
            entity_id: row.id,
            payload: { [k.scopeField]: null },
          });
          names.push(row.title);
        }
      }
      if (!operations.length) return null;
      const shown = names.slice(0, 4).join(", ");
      const more = names.length > 4 ? ` and ${names.length - 4} more` : "";
      return {
        // "Clear the dead location on 1 record" is how a developer says it.
        // The app says "thing" and "place" everywhere else, so this does too.
        summary:
          names.length === 1
            ? `${shown} is filed in a place that has been deleted. Forget where it says it lives; the thing itself stays.`
            : `${names.length} things are filed in places that have been deleted (${shown}${more}). Forget where they say they live; the things themselves stay.`,
        operations,
      };
    },
  },
  {
    id: "empty-places",
    // "Empty" must be SAID. Everything numbered in a run is empty the moment
    // it is made, and a person who just created sixty shelves has not asked
    // for them back.
    match: /\b(delete|remove|clear|clean\s*up|get\s+rid\s+of)\s+(the\s+)?empty\s+\w+/i,
    template: "delete empty places",
    description: "Find places with nothing inside them and nothing filed in them.",
    async plan({ wsApi, selectionIds }) {
      const scan = await scanScoped(wsApi);
      if (!scan || scan.truncated) return null;
      // Anything that is somebody's scope is not empty, whatever kind it is:
      // a rack holding shelves, a bin holding parts.
      const occupied = new Set<string>();
      for (const k of scan.kinds) for (const row of k.rows) if (row.scope) occupied.add(row.scope);
      const operations: Operation[] = [];
      const names: string[] = [];
      for (const k of scan.kinds) {
        // Only a kind that can CONTAIN one of ITSELF — a place inside a place.
        //
        // Checking "does its scope point at anything we know" is not the same
        // question and gets this catastrophically wrong: a part's scope points
        // at a location, which we do know, so parts looked like containers and
        // "delete empty places" offered to delete every part that had nothing
        // inside it. Which is all of them.
        if (!containsItsOwnKind(k.rows)) continue;
        for (const row of k.rows) {
          if (occupied.has(row.id)) continue;
          if (selectionIds?.length && !selectionIds.includes(row.id) && !selectionIds.includes(row.scope)) continue;
          operations.push({ tool: "delete", entity_kind: k.id, entity_id: row.id, payload: {} });
          names.push(row.title);
        }
      }
      if (!operations.length) return null;
      const shown = names.slice(0, 4).join(", ");
      const more = names.length > 4 ? ` and ${names.length - 4} more` : "";
      return {
        summary: `Delete ${names.length} empty place${names.length === 1 ? "" : "s"} (${shown}${more}). Nothing is inside ${names.length === 1 ? "it" : "them"}.`,
        operations,
      };
    },
  },
];

export function computedCommandFor(message: string): ComputedCommand | null {
  return COMPUTED_COMMANDS.find((c) => c.match.test(message)) ?? null;
}
