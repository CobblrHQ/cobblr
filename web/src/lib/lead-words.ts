// A lead word ("from", "sold by") never ends a line apart from what it
// introduces: on a phone a receipt line's subtitle wrapped after "from", so
// each title ended in a dangling "from" with the shop on the next line (#6004).

/** "from" + the shop, the lead word glued to the shop's first word. */
export function leadWords(lead: string, value: string): string {
  const v = value.trim();
  return `${lead.trim().replace(/\s+/g, " ")} ${v}`;
}
