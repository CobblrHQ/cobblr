// How a titled work's title READS, answered once, for whoever is asking.
//
// A book carries its title in more than one form (the original, a
// translation, a transliteration: `metadata.title_variants`, written by the
// scan's identify pass and kept on the record at filing). Which form a
// person sees is their own preference (`title_pref`, "Titles in another
// language" under Appearance), and the inbox already composed its rows with
// it on the way out (core-scan's withTitle). A filed record showed the
// stored name, in whichever script the source used, so an item page, a
// search result and the assistant each read the same book differently from
// the inbox (#3061). The composition now happens here, in the entity
// pipeline every generic surface reads (lookup, list, search, the mention
// resolver, the assistant's tools), from the request's own actor, so there
// is one author of "how does this title read" and the web reads a served
// row as served.
//
// A wire firing on a timer or a boot pass has no actor and gets the stored
// title: a format is a person's preference, and there is nobody to format
// for. The stored name is never changed; nothing is invented (the formatter
// falls back to the form that exists).
import type { ResolvedEntity } from "@cobblr/platform-contract";
import { asTitleFormat, formatTitleVariants, titleVariantsOf, type TitleVariants } from "@cobblr/platform-contract/display-identity";
import { currentActor } from "../lib/request-context.js";

/** The entity's variants, from its record metadata, or null. */
export function entityTitleVariants(entity: Pick<ResolvedEntity, "fields">): TitleVariants | null {
  const meta = (entity.fields as { metadata?: unknown } | undefined)?.metadata;
  return meta && typeof meta === "object" ? titleVariantsOf(meta) : null;
}

/** The entity with its title composed for the request's actor, and its
 *  variants beside it. Unchanged when it carries none, or when nobody is
 *  asking. */
export function applyServedTitle<T extends ResolvedEntity>(entity: T): T & { title_variants?: TitleVariants } {
  const variants = entityTitleVariants(entity);
  if (!variants) return entity;
  const actor = currentActor();
  if (!actor) return { ...entity, title_variants: variants };
  const title = formatTitleVariants(variants, asTitleFormat(actor.titlePref ?? null));
  return { ...entity, title_variants: variants, ...(title ? { title } : {}) };
}

/** A FLAT module row (a parts list row, an instance item) with its served
 *  `title` beside its stored `name`, for the request's actor. The name is
 *  never touched: nothing composed is ever writable (#3060, normalise at
 *  display and never at rest, because display is reversible and a write is
 *  not), and the edit form keeps writing `name`. Unchanged when the row
 *  carries no forms, or when nobody is asking. */
export function withServedTitle<T extends Record<string, unknown>>(row: T): T & { title?: string } {
  const meta = row.metadata;
  const variants = meta && typeof meta === "object" ? titleVariantsOf(meta) : null;
  if (!variants) return row;
  const actor = currentActor();
  if (!actor) return row;
  const title = formatTitleVariants(variants, asTitleFormat(actor.titlePref ?? null));
  return title ? { ...row, title } : row;
}
