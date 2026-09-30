// JSON Schema 2020-12 for Services: a capability's input is checked before
// anything is sent, and every answer against its output schema, so a result
// that does not fit is a failed job naming the service, never data in a
// workspace (services.md §3).

import Ajv2020Module from "ajv/dist/2020.js";

type AjvInstance = { compile(schema: object): ValidateFn };
type ValidateFn = ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };

const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as new (opts: object) => AjvInstance;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const compiled = new Map<string, ValidateFn>();

/** Check `value` against `schema`, which may `$ref` its manifest's `$defs`. */
export function validateAgainst(schema: Record<string, unknown>, defs: Record<string, unknown> | undefined, value: unknown): { ok: true } | { ok: false; errors: string[] } {
  const root = defs && !schema.$defs ? { ...schema, $defs: defs } : schema;
  const key = JSON.stringify(root);
  let fn = compiled.get(key);
  if (!fn) {
    try {
      fn = ajv.compile(root);
    } catch (err) {
      return { ok: false, errors: [`the schema itself is not valid: ${(err as Error).message.slice(0, 200)}`] };
    }
    if (compiled.size > 500) compiled.clear();
    compiled.set(key, fn);
  }
  if (fn(value)) return { ok: true };
  return { ok: false, errors: (fn.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "(input)"} ${e.message ?? "is not valid"}`) };
}
