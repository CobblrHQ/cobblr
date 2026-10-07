/** A state field on an inventory record, as its table declares it. */
export interface StateFieldDef {
  name: string;
  choices: string[] | null;
}

/** What `inventory:set-status` writes. `status` is the long-standing free-text
 *  state; any other field must be one the record's table declares (`def`), and
 *  a field with choices takes only one of them, spelt the way the table spells
 *  it ("Built" becomes "built" for the Lego lifecycle). A member granted the
 *  action can change a set's state, never invent a field or a value. */
export function stateWrite(
  field: string,
  value: string,
  def: StateFieldDef | null,
): { ok: true; field: string; value: string } | { ok: false; error: string } {
  if (!/^[a-z][a-z0-9_]*$/.test(field)) return { ok: false, error: `"${field}" is not a field name` };
  if (field === "status") return { ok: true, field, value };
  if (!def) return { ok: false, error: `This table has no ${field} field` };
  if (!def.choices?.length) return { ok: true, field, value };
  const match = def.choices.find((c) => c.toLowerCase() === value.toLowerCase());
  return match ? { ok: true, field, value: match } : { ok: false, error: `${value} is not one of ${def.choices.join(", ")}` };
}
