// A template's starting values, edited as the kind's own fields instead of a JSON
// box (#6755). The stored shape is unchanged: native fields at the top level and
// the person's own fields under `metadata`, exactly what NewFromTemplateFlow and
// the create endpoint already read.

export interface DefaultsField {
  /** The key it is stored under. */
  key: string;
  label: string;
  input: "text" | "number" | "boolean" | "date" | "choice";
  choices?: string[];
  /** Where it lives in `defaults`: at the top level, or under `metadata`. */
  where: "native" | "metadata";
}

interface NativeField { name: string; type: string; label?: string; role?: string; readOnly?: boolean }
interface CustomField { name: string; display_label: string; type: string; choices?: string[] | null }

const NATIVE_INPUT: Record<string, DefaultsField["input"]> = { text: "text", url: "text", number: "number", boolean: "boolean", date: "date" };
// A field that is worked out, points at another record, or is secret has no value to start with.
const CUSTOM_INPUT: Record<string, DefaultsField["input"]> = { text: "text", url: "text", number: "number", money: "number", boolean: "boolean", date: "date" };

const spelled = (name: string) => {
  const words = name.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The fields a person can give a starting value, native ones first. */
export function defaultsFields(natives: readonly NativeField[], customs: readonly CustomField[]): DefaultsField[] {
  const out: DefaultsField[] = [];
  for (const n of natives) {
    if (n.readOnly || n.role === "title" || n.role === "image" || n.name === "metadata" || n.name.endsWith("_id")) continue;
    const input = NATIVE_INPUT[n.type];
    if (input) out.push({ key: n.name, label: n.label ?? spelled(n.name), input, where: "native" });
  }
  for (const c of customs) {
    const input = CUSTOM_INPUT[c.type];
    if (!input) continue;
    const choices = c.choices?.length ? [...c.choices] : undefined;
    out.push({ key: c.name, label: c.display_label, input: choices ? "choice" : input, ...(choices ? { choices } : {}), where: "metadata" });
  }
  return out;
}

type Defaults = Record<string, unknown>;

export function readDefault(defaults: Defaults, f: DefaultsField): unknown {
  return f.where === "native" ? defaults[f.key] : (defaults.metadata as Defaults | undefined)?.[f.key];
}

/** Set one field's starting value; an empty value takes the key out, so a blank box is no default. */
export function writeDefault(defaults: Defaults, f: DefaultsField, raw: unknown): Defaults {
  let value: unknown = raw;
  if (f.input === "number") value = raw === "" || raw === null || raw === undefined || Number.isNaN(Number(raw)) ? undefined : Number(raw);
  else if (f.input === "boolean") value = raw === true ? true : undefined;
  else if (raw === "" || raw === null || raw === undefined) value = undefined;
  const set = (target: Defaults): Defaults => {
    const next = { ...target };
    if (value === undefined) delete next[f.key];
    else next[f.key] = value;
    return next;
  };
  if (f.where === "native") return set(defaults);
  const metadata = set((defaults.metadata as Defaults | undefined) ?? {});
  const { metadata: _old, ...rest } = defaults;
  return Object.keys(metadata).length ? { ...rest, metadata } : rest;
}
