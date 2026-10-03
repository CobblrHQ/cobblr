import { joinNavRow, splitNavRow, type NavSplitRow } from "./nav-order";

type Collection = { name: string; displayName: string };
export function runNavRowCommand(slug: string, text: string, collections: Collection[], rows: NavSplitRow[]): string | null {
  const join = /^(?:please\s+)?put (.+?) (?:on|in) one (?:line|row)[.!]?$/i.exec(text.trim());
  if (join) {
    const names = join[1]!.split(/\s+and\s+|\s*[,|]\s*/i).map((s) => s.trim().toLowerCase());
    if (names.length < 2 || names.length > 3) return "Choose two or three collections for one row.";
    const matched = names.map((name) => collections.filter((c) => c.displayName.toLowerCase() === name));
    if (matched.some((matches) => matches.length !== 1)) return "I need the exact collection names to join their navigation rows.";
    const members = matched.map((matches) => matches[0]!);
    if (new Set(members.map((m) => m.name)).size !== members.length) return "Choose different collections for the row.";
    const existing = rows.find((r) => r.members.length === members.length && members.every((m) => r.members.includes(m.name)));
    joinNavRow(slug, { key: existing?.key ?? `personal:${members.map((m) => m.name).join(":")}`, label: existing?.label ?? "", members: members.map((m) => m.name) });
    return `${members.map((m) => m.displayName).join(" and ")} now share one navigation row on this device.`;
  }
  const split = /^(?:please\s+)?split (.+?)(?: navigation)?(?: row)?[.!]?$/i.exec(text.trim());
  if (!split) return null;
  const wanted = split[1]!.toLowerCase();
  const matches = rows.filter((r) => r.label.toLowerCase() === wanted || r.members.some((name) => collections.some((c) => c.name === name && c.displayName.toLowerCase() === wanted)));
  if (matches.length !== 1) return "Name the joined navigation row you want to split.";
  splitNavRow(slug, matches[0]!.members);
  return "Those collections now have separate navigation rows on this device.";
}
