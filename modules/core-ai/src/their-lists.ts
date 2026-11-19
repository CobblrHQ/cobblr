// The lists a built-in answer names are this workspace's own (#4115).
//
// "Use + New at the top of the relevant list (Parts, Printers, Orders…)" was
// written once for every workspace. A newcomer's fresh one has none of the
// three, and the first thing Cobb ever told them sent them looking for pages
// that are not there. So a built-in answer says {lists} where it would name
// lists, and the answer is filled in when it is given, from the lists this
// workspace has that a person can add to. With none, the brackets go.

export const LISTS_TOKEN = "{lists}";

/** How many lists an answer names: enough to point, short enough to read. */
const NAMED = 3;

export interface ListKind {
  id: string;
  display_name?: string | null;
  display_name_plural?: string | null;
  can_create?: boolean | null;
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** The lists a person can add to here, as they are called: the one the
 *  message names first ("add a part" → Parts), then the workspace's own (a
 *  module it turned on), then the ones every workspace is born with. */
export function addableLists(kinds: readonly ListKind[], message = ""): string[] {
  const said = words(message);
  const named = kinds
    .filter((k) => k.can_create === true)
    .map((k) => {
      const name = (k.display_name_plural || k.display_name || "").trim();
      const own = [...words(name), ...words(k.display_name ?? "")];
      return { name, asked: own.some((w) => said.has(w)), core: k.id.startsWith("core-") };
    })
    .filter((k) => k.name);
  const rank = (k: { asked: boolean; core: boolean }) => (k.asked ? 0 : k.core ? 2 : 1);
  const seen = new Set<string>();
  return [...named]
    .sort((a, b) => rank(a) - rank(b))
    .map((k) => k.name)
    .filter((n) => (seen.has(n.toLowerCase()) ? false : (seen.add(n.toLowerCase()), true)));
}

/** A built-in answer with {lists} filled in from this workspace's lists. */
export function withTheirLists(reply: string, lists: readonly string[]): string {
  if (!reply.includes(LISTS_TOKEN)) return reply;
  const shown = lists.slice(0, NAMED);
  const said = shown.length ? ` (${shown.join(", ")}${lists.length > NAMED ? "…" : ""})` : "";
  return reply.split(` ${LISTS_TOKEN}`).join(said).split(LISTS_TOKEN).join(said.trim());
}
