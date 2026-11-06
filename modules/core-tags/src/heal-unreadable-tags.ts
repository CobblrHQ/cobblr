// One-shot heal: a tag has a name to read.
//
// DONE WHEN: no core_tags_tags row made before `since` is changed by repairedTagName. Check prod, staging and dev, then
// delete this file and its onBoot call.
//
// BORN WITH: tags.ts and action-handlers.ts refuse a name with nothing to read, so a tag made now is already right.
//
// WHY IT EXISTS: the API could save a tag named with only spaces, which became "" and drew a chip with nothing on it, or
// across two lines.

import { canBeAName } from "@cobblr/platform-contract/readable-text";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { Kysely } from "kysely";
import type { CoreTagsDB } from "./db.js";
import { updateTag } from "./tag-writes.js";

/** The name this tag should have, or null when its own is fine. `taken` holds every tag's name in lower case, as tag names are unique ignoring case. */
export function repairedTagName(name: string, taken: ReadonlySet<string>): string | null {
  if (canBeAName(name)) return null;
  const line = name.replace(/\p{Cc}+/gu, " ").trim();
  const base = canBeAName(line) ? line : "Unnamed tag";
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export async function healUnreadableTags(db: Kysely<CoreTagsDB>, orgId: string, since: Date): Promise<number> {
  const rows = await db.selectFrom("core_tags_tags").select(["id", "name", "created_at"]).execute();
  const taken = new Set(rows.map((row) => row.name.toLowerCase()));
  let healed = 0;
  for (const row of rows) {
    if (new Date(row.created_at as unknown as string) >= since) continue;
    const name = repairedTagName(row.name, taken);
    if (name === null) continue;
    await updateTag(db, { orgId, userId: null }, row.id, { name });
    taken.add(name.toLowerCase());
    healed++;
  }
  return healed;
}

export function registerUnreadableTagsHeal(): void {
  registerHealPass({
    name: "core-tags.unreadable-tags",
    since: "2026-11-06T18:00:00Z",
    shim: "modules/core-tags/src/heal-unreadable-tags.ts",
    module: "core-tags",
    visit: ({ db, orgId, since }) => healUnreadableTags(db as Kysely<CoreTagsDB>, orgId, since),
  });
}
