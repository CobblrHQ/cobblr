// A model that says the tool call instead of making it.
//
// Some models with tool support answer a request to DO something by writing out
// what they would call, in prose, with the arguments in a fenced JSON block.
// Measured on a real box (2026-08-25): granite3.3:8b answered "add a part called
// Brass Widget, quantity 4" with
//
//     To add a part called Brass Widget... you would use the create_record
//     function. Here's how you can do it:
//     ```json
//     { "kind": "inventory:part", "fields": { "name": "Brass Widget", "quantity": 4 } }
//     ```
//
// which is exactly right, and arrived as text. command-r7b does the same for
// actions. Both scored 1/8 on a bench that only reads `tool_calls`, and both
// would have been useless in the app for the same reason.
//
// Cobb already has a text protocol for models that cannot call tools at all
// (the Move shape), so the machinery to act on a JSON reply exists — it just
// insists on a `type` field these models have no reason to write. They write
// the TOOL's shape, because that is what they were given. So: when a reply's
// JSON has no `type` but has the unmistakable shape of one of our tools, read
// it as the move it plainly is.
//
// The risk is a model ILLUSTRATING rather than asking, and the containment is
// the one the Move path already has: a write arrives as a proposal the person
// confirms. An extra card to cancel is a smaller cost than a model that can
// only ever describe.

export interface ToolShapedMove {
  type: "create" | "action";
  entity_kind?: string;
  fields?: Record<string, unknown>;
  action_id?: string;
  args?: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Read a tool-shaped JSON object as a move, or null when it is not one.
 *
 * Deliberately narrow: it recognises the two tools whose arguments are
 * unambiguous on their own, and nothing else. A blob with a stray `kind` in it
 * is not a create — the shape has to be the whole object.
 */
export function inferMoveFromToolShape(raw: unknown): ToolShapedMove | null {
  if (!isObj(raw)) return null;
  // Already a Move: not ours to interpret.
  if (typeof raw.type === "string") return null;

  // invoke_action: { action_id, args?, entity_kind?, entity_id? }
  if (typeof raw.action_id === "string" && raw.action_id.includes(":")) {
    return {
      type: "action",
      action_id: raw.action_id,
      ...(isObj(raw.args) ? { args: raw.args } : {}),
      ...(typeof raw.entity_kind === "string" ? { entity_kind: raw.entity_kind } : {}),
    };
  }

  // create_record: { kind, fields } — the tool's own parameter names. An
  // `entity_kind` spelling is accepted too, since a model that has seen both
  // the tool and the Move shape mixes them.
  const kind = typeof raw.kind === "string" ? raw.kind : typeof raw.entity_kind === "string" ? raw.entity_kind : null;
  if (kind && kind.includes(":") && isObj(raw.fields) && Object.keys(raw.fields).length > 0) {
    return { type: "create", entity_kind: kind, fields: raw.fields };
  }
  return null;
}

/** The first JSON object in a reply — fenced or bare. A model that explains and
 *  then shows the call puts the JSON after the prose, so this does not assume
 *  the reply starts with it. */
export function jsonBlockIn(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const s = c.indexOf("{");
    const e = c.lastIndexOf("}");
    if (s === -1 || e <= s) continue;
    try {
      return JSON.parse(c.slice(s, e + 1));
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
