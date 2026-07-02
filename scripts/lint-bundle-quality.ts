// The bundle quality bar (the author: "ship 100s of these over time, VETTED — quality
// over quantity"). Every catalog bundle in bundles/*.json must carry the data
// that makes it DISCOVERABLE and CAPTURE-ROUTABLE, or it doesn't ship:
//
//   · id / name / version / description        (identity)
//   · every provides_instance: display_name + item_noun
//     (item_noun is the capture-first menu's routing vocabulary — a skin
//      without one degrades the whole matcher, see what-to-do-funnel.md)
//   · every provides_instance: at least one field, and at least one field
//     with `choices` OR instance scan_keywords
//     (choices ARE the heuristic's extraction vocabulary; a skin with no
//      choices and no keywords is unreachable without AI)
//
// Legacy field_defs-only bundles (no provides_instances) are exempt from the
// instance checks but still need identity. Run: npx tsx scripts/lint-bundle-quality.ts
import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "bundles");
const problems: string[] = [];
let checked = 0;

for (const f of fs.readdirSync(dir).sort()) {
  if (!f.endsWith(".json")) continue;
  let m: Record<string, unknown>;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
    m = (raw.manifest ?? raw) as Record<string, unknown>;
  } catch {
    problems.push(`${f}: unparseable JSON`);
    continue;
  }
  const id = String(m.id ?? "");
  if (!id.startsWith("cobblr.")) continue; // local/test manifests aren't catalog
  checked++;
  const where = (msg: string) => problems.push(`${f} (${id}): ${msg}`);
  if (!m.name) where("missing name");
  if (!m.version) where("missing version");
  if (!m.description || String(m.description).length < 20) where("missing/too-short description");
  const pis = Array.isArray(m.provides_instances) ? (m.provides_instances as Array<Record<string, unknown>>) : [];
  for (const pi of pis) {
    const label = String(pi.instance_name ?? "?");
    if (!pi.display_name) where(`instance ${label}: missing display_name`);
    if (!pi.item_noun) where(`instance ${label}: missing item_noun (capture routing vocabulary)`);
    const fds = Array.isArray(pi.field_defs) ? (pi.field_defs as Array<Record<string, unknown>>) : [];
    if (fds.length === 0) where(`instance ${label}: no field_defs (a skin IS its fields)`);
    const hasChoices = fds.some((d) => Array.isArray(d.choices) && (d.choices as unknown[]).length > 0);
    const hasKeywords = Array.isArray(pi.scan_keywords) && (pi.scan_keywords as unknown[]).length > 0;
    if (fds.length > 0 && !hasChoices && !hasKeywords)
      where(`instance ${label}: no field choices AND no scan_keywords — heuristically unreachable without AI`);
  }
}

if (problems.length) {
  console.error(`lint-bundle-quality: ${problems.length} problem(s) across ${checked} bundles:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`lint-bundle-quality: ${checked} bundles pass the quality bar.`);
