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

export interface ComputedPlan {
  /** What the confirm card says, in a sentence a person can check. */
  summary: string;
  operations: Operation[];
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
  return `Delete ${n} duplicate ${n === 1 ? noun : `${noun}s`} (${names}${more}), keeping the original of each.`;
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

export const COMPUTED_COMMANDS: ComputedCommand[] = [
  {
    id: "duplicates",
    // "delete duplicates", "remove the duplicates", "clean up duplicates".
    match: /\b(delete|remove|clean\s*up|clear|get\s+rid\s+of)\s+(the\s+)?duplicates?\b/i,
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
