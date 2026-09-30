// Deleting a place from any page: the dialog says what goes with it, and the
// toast after it offers Undo, which puts back every place and every thing
// where it was. One copy, so the tree's bulk delete and a place's own page
// cannot say two different things about the same delete.
import { countOf } from "@cobblr/platform-contract/plural";
import { api } from "./api";

export interface WhatGoes {
  places: number;
  things: number;
}

/** The dialog's words, from what the server says would go. */
export function deleteDialogMessage(goes: WhatGoes, several = false): string {
  const it = several ? "them" : "it";
  const parts: string[] = [];
  if (goes.places === 1) parts.push(`The place inside ${it} goes too.`);
  else if (goes.places > 1) parts.push(`The ${countOf(goes.places, "place")} inside ${it} go too.`);
  if (goes.things > 0) {
    const where = goes.places > 0 ? "in there" : "here";
    parts.push(
      `${countOf(goes.things, "thing")} kept ${where} ${goes.things === 1 ? "stays" : "stay"} in your workspace with no place set.`,
    );
  }
  if (parts.length === 0) parts.push("Nothing is kept here.");
  parts.push("You can undo this straight after.");
  return parts.join(" ");
}

/** What the toast says once it is gone. */
export function deletedSentence(name: string, goes: WhatGoes): string {
  const also = [
    goes.places > 0 ? countOf(goes.places, "place") : null,
    goes.things > 0 ? `${countOf(goes.things, "thing")} taken out` : null,
  ].filter(Boolean);
  return also.length ? `Deleted ${name}, with ${also.join(" and ")}.` : `Deleted ${name}.`;
}

/** What the toast says once Undo has put it back. */
export function restoredSentence(r: { name: string; things: number; leftWhereTheyAre: number }): string {
  const moved =
    r.leftWhereTheyAre > 0
      ? ` ${countOf(r.leftWhereTheyAre, "thing")} ${r.leftWhereTheyAre === 1 ? "was" : "were"} put somewhere else since, so ${r.leftWhereTheyAre === 1 ? "it stays" : "they stay"} there.`
      : "";
  return `Put ${r.name} back${r.things > 0 ? `, with ${countOf(r.things, "thing")} where ${r.things === 1 ? "it was" : "they were"}` : ""}.${moved}`;
}

/** Undo several deletes at once (the tree's bulk delete). */
export async function restorePlaces(slug: string, ids: string[]) {
  const out = [];
  for (const id of ids) out.push(await api.restoreDeletedLocation(slug, id));
  return out;
}
