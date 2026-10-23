// What a refused request body says: the field and what it must be, never
// "Bad request body" (#7592).
//
// A 161-character part name came back as "Bad request body" and the form
// showed exactly that, so the person had to guess which field to change,
// while the reply's details already said `path: ["name"], maximum: 160`.
// Every route that answers `invalid_body` builds its message here, from the
// same zod issues it sends as `details`, so every client that shows the
// server's message (the web, a module's own client, Cobb, the MCP server)
// says what to change. lint:invalid-body-says-what keeps "Bad request body"
// out of the routes.

/** A zod (v3) issue, as much of it as a sentence needs. */
export interface BodyIssue {
  path: ReadonlyArray<string | number>;
  code: string;
  message: string;
  maximum?: number | bigint;
  minimum?: number | bigint;
  inclusive?: boolean;
  type?: unknown;
  expected?: unknown;
  received?: unknown;
  options?: ReadonlyArray<unknown>;
  keys?: ReadonlyArray<unknown>;
}

/** "unit_price" → "Unit price"; items.2.name → "Item 3 name". */
export function fieldWords(path: ReadonlyArray<string | number>): string {
  const words = path
    .map((p, i) => (typeof p === "number" ? String(p + 1) : (i < path.length - 1 && typeof path[i + 1] === "number" ? p.replace(/s$/, "") : p).replace(/_id$/, "").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()))
    .join(" ")
    .trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "The request";
}

const countOf = (n: number | bigint, one: string) => `${n} ${one}${Number(n) === 1 ? "" : "s"}`;

/** One issue as a sentence a person can act on. */
export function issueSentence(issue: BodyIssue): string {
  const field = fieldWords(issue.path);
  const n = (v: number | bigint | undefined) => (v === undefined ? "" : String(v));
  switch (issue.code) {
    case "too_big":
      if (issue.type === "string") return `${field} can be at most ${countOf(issue.maximum ?? 0, "character")}.`;
      if (issue.type === "array") return `${field} can have at most ${countOf(issue.maximum ?? 0, "entry").replace("entrys", "entries")}.`;
      return `${field} can be at most ${n(issue.maximum)}.`;
    case "too_small":
      if (issue.type === "string") return Number(issue.minimum) <= 1 ? `${field} can't be empty.` : `${field} needs at least ${countOf(issue.minimum ?? 0, "character")}.`;
      if (issue.type === "array") return Number(issue.minimum) <= 1 ? `${field} needs at least one entry.` : `${field} needs at least ${n(issue.minimum)} entries.`;
      return issue.inclusive === false ? `${field} must be more than ${n(issue.minimum)}.` : `${field} must be at least ${n(issue.minimum)}.`;
    case "invalid_type":
      if (issue.expected === "integer") return `${field} must be a whole number.`;
      return issue.received === "undefined" ? `${field} is missing.` : `${field} must be ${issue.expected === "string" ? "text" : `a ${String(issue.expected)}`}.`;
    case "invalid_enum_value":
      return issue.options?.length ? `${field} must be one of: ${issue.options.join(", ")}.` : `${field} is not one of the choices.`;
    case "unrecognized_keys":
      return `${issue.keys?.length === 1 ? `"${issue.keys[0]}" is` : `${(issue.keys ?? []).map((k) => `"${k}"`).join(", ")} are`} not something this can take.`;
    default:
      return `${field}: ${issue.message.replace(/\.$/, "")}.`;
  }
}

/** The message for a 400 `invalid_body`: the first problem as a sentence,
 *  and how many more there are. Unknown issues still name their field. */
export function invalidBodyMessage(issues: ReadonlyArray<BodyIssue> | null | undefined): string {
  const list = issues ?? [];
  if (!list.length) return "The request was not in the shape this expects.";
  const first = issueSentence(list[0]!);
  return list.length === 1 ? first : `${first} (and ${countOf(list.length - 1, "other problem")})`;
}

/** Does a refusal's details name this field (its first path step)? A form
 *  says the message beside that field instead of below the form. */
export function refusesField(details: unknown, field: string): boolean {
  return Array.isArray(details) && details.some((d) => Array.isArray((d as BodyIssue | null)?.path) && (d as BodyIssue).path[0] === field);
}
