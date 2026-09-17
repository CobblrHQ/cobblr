#!/usr/bin/env tsx
// A route gated by requireCapability names a capability an admin can grant: a user-invokable action in a manifest, or an entry in ENDPOINT_CAPABILITIES; otherwise a member is refused something no approval can ever give.
//
// THE BUG THIS PREVENTS. POST /parts/:id/stock-adjust gated on inventory:adjust-stock, whose action is userInvokable:false and so never grantable: a member could be refused and nobody could say yes (#3073, 2026-09-17).
//
// THE RULE. Every `requireCapability(req, res, "<id>")` in a route names a
// capability that the permissions matrix can grant, which means one of:
//   • an action declared in a module manifest WITHOUT `userInvokable: false`
//     (grantableActions reads entity_actions where user_invokable = true);
//   • an entry in ENDPOINT_CAPABILITIES (platform/capability-grants.ts), the
//     list for gates that are not actions.
// Anything else is a door only the admin tier can ever pass and that no
// approval can open, and the blocked-action sheet would have to refuse the
// ask as "nothing an admin could give you" for a thing the matrix should
// simply offer. No opt-out: gate on role instead if the door is truly
// admin-only.
//
//   npx tsx scripts/lint-capability-gates-grantable.ts   (pnpm run lint:capability-gates-grantable)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** Action ids the manifests declare as buttons a person may press, so a
 *  grant for them means something. Read once. */
function grantableActionIds(): Set<string> {
  const ids = new Set<string>();
  const modules = "modules";
  let names: string[] = [];
  try {
    names = readdirSync(modules);
  } catch {
    return ids;
  }
  for (const name of names) {
    const manifest = join(modules, name, "src", "module.ts");
    let src: string;
    try {
      src = readFileSync(manifest, "utf8");
    } catch {
      continue;
    }
    // `id:` and not `action_id:`: a wire in `contributes` names the action it
    // fires, and that is not a declaration.
    for (const m of src.matchAll(/(?<![\w$])id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/g)) {
      // The declaration runs from this id to the next one; a userInvokable:
      // false inside that window is this action's.
      const rest = src.slice(m.index + m[0].length);
      const next = rest.search(/\bid:\s*["'`][a-z0-9-]+:[a-z0-9-]+["'`]/);
      const window = next < 0 ? rest : rest.slice(0, next);
      if (!/userInvokable:\s*false/.test(window)) ids.add(m[1]!);
    }
  }
  return ids;
}

function endpointCapabilityIds(): Set<string> {
  const ids = new Set<string>();
  let src: string;
  try {
    src = readFileSync(join("api", "src", "platform", "capability-grants.ts"), "utf8");
  } catch {
    return ids;
  }
  const block = src.slice(src.indexOf("ENDPOINT_CAPABILITIES"));
  for (const m of block.matchAll(/action_id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/g)) ids.add(m[1]!);
  return ids;
}

const GRANTABLE = new Set([...grantableActionIds(), ...endpointCapabilityIds()]);

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // A usage example in a comment is not a gate.
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    for (const m of line.matchAll(/requireCapability\(\s*req\s*,\s*res\s*,\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/g)) {
      const id = m[1]!;
      if (GRANTABLE.has(id)) continue;
      out.push({
        file,
        line: i + 1,
        what: `gates on "${id}", which no admin can grant (not a user-invokable action, not in ENDPOINT_CAPABILITIES); a member refused here can never be given it`,
      });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:capability-gates-grantable - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:capability-gates-grantable OK`);
