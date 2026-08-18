#!/usr/bin/env tsx
// Guard: a kind must not advertise a SERVER-OWNED column as a writable field.
//
// The bug (2026-08-18). `core-locations:location` declared
// `{ name: "position", type: "number" }`. Nothing said the value is maintained
// by the module, so every surface that describes a kind for writing — the AI
// tool registry, and a person reading the field list — treated it as settable.
// Ask Cobb duly set position 0-11 across twelve racks. The writer's allowlist
// does not include `position`, so it dropped it, and because `updated_at` is
// bumped unconditionally every one of those twelve calls returned 200 with a
// fresh timestamp. Twelve successful updates, nothing moved. It was caught only
// because the assistant read the records back afterwards.
//
// The class: **a declaration that invites a write the writer will refuse.** The
// silence is the damage — a rejected write is a bug report, a discarded one is a
// story about how the product does not work.
//
// The rule: a field named after a column the server maintains must carry
// `readOnly: true`. Then the tool registry marks it read-only, form builders
// skip it, and the writer's refusal agrees with what was advertised.
//
//   cd <repo> && npx tsx scripts/lint-server-owned-fields.ts
//
// Escape hatch: none. If a module genuinely lets callers set one of these, it is
// not server-owned — rename the field, or add it to WRITABLE_EXCEPTIONS below
// with the module and a reason.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Columns whose value the server maintains. A kind may still DECLARE these so
 *  the field can be read and talked about; it must mark them readOnly. */
const SERVER_OWNED = ["position", "depth", "created_at", "updated_at", "org_id"];

/** `<module>:<field>` pairs a module genuinely lets callers set. Empty on
 *  purpose — add one only with a reason, never to silence a finding. */
const WRITABLE_EXCEPTIONS = new Set<string>([]);

const offenders: string[] = [];
const modsDir = "modules";

for (const mod of existsSync(modsDir) ? readdirSync(modsDir) : []) {
  const f = join(modsDir, mod, "src", "module.ts");
  if (!existsSync(f)) continue;
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    // { name: "position", type: "number" }  — one field declaration per line is
    // the house style in every manifest.
    const m = line.match(/\{\s*name:\s*["'`]([a-z0-9_]+)["'`][^}]*\}/i);
    if (!m) return;
    const field = m[1]!;
    if (!SERVER_OWNED.includes(field)) return;
    if (/readOnly:\s*true/.test(m[0])) return;
    if (WRITABLE_EXCEPTIONS.has(`${mod}:${field}`)) return;
    offenders.push(`${f}:${i + 1}  ${field} is server-owned but declared writable`);
  });
}

if (offenders.length > 0) {
  console.error(
    `✗ server-owned-fields lint: ${offenders.length} field(s) invite a write that will be discarded.\n`,
  );
  for (const o of offenders) console.error(`  ${o}`);
  console.error(`
A kind that declares one of [${SERVER_OWNED.join(", ")}] without \`readOnly: true\`
tells every writer-facing surface the value is settable. The module's own writer
does not apply it, and because updated_at is bumped anyway the call returns 200 —
so the write looks applied and is not. Add \`readOnly: true\` to the declaration.

If callers really may set it, it is not server-owned: rename the field, or add
"<module>:<field>" to WRITABLE_EXCEPTIONS in this script with a reason.`);
  process.exit(1);
}

console.log(`✓ server-owned-fields lint: no kind advertises a server-owned column as writable.`);
