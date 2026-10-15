// A picker of kinds of thing says each in the words the person uses ("Part",
// "Bookshelf"), never its id (`inventory:part`). The id is added only to tell
// apart two kinds that share a name, so no choice is ambiguous (#6737).
export function kindOptionLabels(kinds: ReadonlyArray<{ id: string; display_name: string }>): Map<string, string> {
  const uses = new Map<string, number>();
  for (const k of kinds) uses.set(k.display_name, (uses.get(k.display_name) ?? 0) + 1);
  return new Map(kinds.map((k) => [k.id, (uses.get(k.display_name) ?? 0) > 1 ? `${k.display_name} (${k.id})` : k.display_name]));
}
