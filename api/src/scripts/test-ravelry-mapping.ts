// Smoke-test the Ravelry importer's field mapping against REAL Ravelry data,
// read-only — fetches the authed user's stash + projects and runs the same
// mappers the import route uses, printing the mapped output for eyeballing.
// No DB, no writes to Ravelry. Validates a713b84c before claiming "it's live".
//
// Run:
//   creds from ~/.ravelry-readonly-key.txt (line1=access_key, line2=personal_key)
//   cd api && npx tsx src/scripts/test-ravelry-mapping.ts [maxItems]
//
// The mappers live in routes/ravelry-import.ts but aren't exported (they're
// internal to the route). To avoid changing the route's surface just for a
// test, this script re-imports the client and re-declares the mapping by
// importing the route module's helpers via a thin re-export shim below.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  currentUser,
  stashAll,
  projectsAll,
  type RavelryCreds,
} from "../platform/ravelry.js";
import { mapStashForTest, mapProjectForTest } from "../routes/ravelry-import.js";

function loadCreds(): RavelryCreds {
  const path = join(homedir(), ".ravelry-readonly-key.txt");
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const [accessKey, personalKey] = lines;
  if (!accessKey || !personalKey) {
    console.error(`Need 2 non-comment lines in ${path} (access_key, personal_key).`);
    process.exit(1);
  }
  return { access_key: accessKey, personal_key: personalKey };
}

async function main() {
  const max = Number(process.argv[2] ?? 8);
  const creds = loadCreds();

  const me = await currentUser(creds);
  if (!me) {
    console.error("currentUser returned null — creds rejected by Ravelry.");
    process.exit(1);
  }
  console.log(`✓ connected as ${me.username}\n`);

  console.log(`── STASH → yarn (first ${max}) ──`);
  let n = 0;
  for await (const entry of stashAll(creds, me.username)) {
    const m = mapStashForTest(entry);
    console.log(JSON.stringify({ ravelry_id: entry.id, ...m }, null, 2));
    if (++n >= max) break;
  }
  console.log(`(${n} stash entries shown)\n`);

  console.log(`── PROJECTS → designs (first ${max}) ──`);
  let p = 0;
  for await (const proj of projectsAll(creds, me.username)) {
    const m = mapProjectForTest(proj, me.username);
    console.log(JSON.stringify({ ravelry_id: proj.id, ...m }, null, 2));
    if (++p >= max) break;
  }
  console.log(`(${p} projects shown)`);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
