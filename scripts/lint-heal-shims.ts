// Guard: a one-shot boot heal shim must state its own retirement condition.
// The class: HISTORICAL DATA MIGRATION passes accrete in boot() because nothing
// records when each one is safe to delete — the two lens shims sat a month past
// their completed cutover before anyone checked. Every one-shot shim (a
// `migrate-*`/`backfill-*` file under api/src/platform, or any api/src file
// carrying the HISTORICAL DATA MIGRATION marker) must carry one of:
//   `DONE WHEN:` — the checkable condition under which the file gets deleted;
//   `PERMANENT RECONCILE` — an explicit declaration that it never terminates.
//
// A stated condition that nothing evaluates is a note, not a condition: the
// lens shims had theirs written down too, in effect, and still sat a month.
// So the same rule has a second half (#3453). Every file whose header opens a
// line with `// DONE WHEN:` (kernel or module) must RECORD what each pass
// found, by calling `noteHealShim` with its own repo path, so /healthz on
// every deployment answers the condition and `scripts/heal-shim-status.mjs`
// reads all of them at once. A shim whose condition is not a count of what
// its pass finds (a soak window, a contract migration) says so instead, with
// `NOT RECORDED: <why>`. And every path a `noteHealShim` call names must be a
// file that still carries `DONE WHEN:`, so a rename cannot leave a deployment
// reporting a shim nobody can find.
//
// Run: npx tsx scripts/lint-heal-shims.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "api", "src");
const MODULES = join(ROOT, "modules");

const files: string[] = [];
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts")) files.push(p);
  }
};
walk(SRC);
const moduleFiles: string[] = [];
for (const m of readdirSync(MODULES, { withFileTypes: true })) {
  if (!m.isDirectory()) continue;
  const before = files.length;
  try {
    walk(join(MODULES, m.name, "src"));
  } catch {
    /* a module without src/ has no shims */
  }
  moduleFiles.push(...files.splice(before));
}

const failures: string[] = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  const base = f.split("/").pop() ?? "";
  const isShimByName =
    rel.startsWith("api/src/platform/") && /^(migrate|backfill)-.+\.ts$/.test(base);
  const src = readFileSync(f, "utf8");
  const isShimByMarker = src.includes("HISTORICAL DATA MIGRATION");
  if (!isShimByName && !isShimByMarker) continue;
  if (src.includes("DONE WHEN:") || src.includes("PERMANENT RECONCILE")) continue;
  failures.push(
    `${rel}: heal shim without a stated retirement condition — add a "DONE WHEN:" header (the checkable condition under which this file gets deleted) or "PERMANENT RECONCILE" if it genuinely never terminates`,
  );
}

// The second half: a stated condition is a recorded one.
const headerStates = (src: string) => src.split("\n").slice(0, 60).some((l) => l.startsWith("// DONE WHEN:"));
const recordedKeys = new Map<string, string>(); // key -> the file that names it
const NOTE_CALL = /noteHealShim\(\s*(?:"([^"]+)"|([A-Z_]+))/g;
// A registered heal pass (platform-contract heal-pass.ts) records through the
// kernel's walk: its `shim:` is the key.
const HEAL_PASS = /registerHealPass\(\{[^}]*?\bshim:\s*"([^"]+)"/g;
for (const f of [...files, ...moduleFiles]) {
  const rel = relative(ROOT, f);
  if (rel.endsWith(".test.ts")) continue;
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(NOTE_CALL)) {
    let key = m[1];
    if (!key && m[2]) key = new RegExp(`const ${m[2]} = "([^"]+)"`).exec(src)?.[1];
    if (key) recordedKeys.set(key, rel);
  }
  for (const m of src.matchAll(HEAL_PASS)) if (m[1]) recordedKeys.set(m[1], rel);
}
for (const f of [...files, ...moduleFiles]) {
  const rel = relative(ROOT, f);
  if (rel.endsWith(".test.ts")) continue;
  const src = readFileSync(f, "utf8");
  if (!headerStates(src)) continue;
  if (/^\/\/ NOT RECORDED: \S/m.test(src)) continue;
  if (recordedKeys.get(rel) === rel) continue;
  failures.push(
    `${rel}: states DONE WHEN but never records whether it is true — call noteHealShim("${rel}", <found>, <failed>) after each whole pass (platform().health.noteHealShim from a module), so /healthz answers it on every deployment; or say "// NOT RECORDED: <why>" if the condition is not a count of what the pass finds`,
  );
}
for (const [key, by] of recordedKeys) {
  let states = false;
  try {
    states = headerStates(readFileSync(join(ROOT, key), "utf8"));
  } catch {
    /* no such file */
  }
  if (!states) failures.push(`${by}: records heal shim "${key}", which is not a file carrying DONE WHEN (renamed, or retired without its recording)`);
}

if (failures.length) {
  console.error(`[lint:heal-shims] ${failures.length} heal-shim problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`[lint:heal-shims] OK — every heal shim states DONE WHEN / PERMANENT RECONCILE, and every DONE WHEN is recorded (${recordedKeys.size})`);
