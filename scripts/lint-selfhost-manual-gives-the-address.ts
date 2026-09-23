#!/usr/bin/env tsx
// Every https:// value the self-host .env example carries for a variable the
// manual documents appears in the manual too.
//
// THE BUG THIS PREVENTS. SELF_HOSTING.md told a self-hoster to sign up for a
// barcode-network key and then never said what to point COBBLR_BIDB_URL at.
// The address sat commented out in three .env examples, which is not where
// somebody reading the manual is looking, so the reader stopped at exactly the
// step they were trying to get past, with a key and nothing to use it on
// (#3425, 2026-09-22). Two community addresses had the same shape: the manual
// named the variable, the example held the address.
//
// THE RULE. For every variable in deploy/selfhost/.env.example whose example
// value starts with https://, if SELF_HOSTING.md documents that variable (its
// name appears in backticks), the manual must also contain that value. Only
// https:// values are checked, because those are project addresses that are the
// same for everybody: a secret is empty in the example and a connection string
// is a template with the reader's own password in it, and neither belongs in
// the manual. A variable the manual does not mention is not this lint's
// business, since the example is allowed to carry more than the manual covers.
//
// PROVED RED on the manual as it stood before #3425: three violations,
// COBBLR_BIDB_URL, COBBLR_DISCORD_INVITE_URL and COBBLR_FORUM_URL.
//
//   npx tsx scripts/lint-selfhost-manual-gives-the-address.ts
import { readFileSync } from "node:fs";

const EXAMPLE = "deploy/selfhost/.env.example";
const MANUAL = "SELF_HOSTING.md";

export interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The check, pure so the test can hold it to the consequence. */
export function check(example: string, manual: string): Violation[] {
  const out: Violation[] = [];
  const lines = example.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^#?\s*([A-Z][A-Z0-9_]+)=(https:\/\/\S+)/.exec(lines[i] ?? "");
    if (!m) continue;
    const [, name, value] = m as unknown as [string, string, string];
    if (!manual.includes(`\`${name}\``)) continue; // the manual does not cover it
    if (manual.includes(value)) continue;
    out.push({
      file: EXAMPLE,
      line: i + 1,
      what: `${MANUAL} documents ${name} but never gives its address (${value})`,
    });
  }
  return out;
}

if (process.argv[1]?.endsWith("lint-selfhost-manual-gives-the-address.ts")) {
  const violations = check(readFileSync(EXAMPLE, "utf8"), readFileSync(MANUAL, "utf8"));
  if (violations.length) {
    console.error(`lint:selfhost-manual-gives-the-address - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Put the address in the manual's own table, where the person configuring it is reading.");
    process.exit(1);
  }
  console.log("lint:selfhost-manual-gives-the-address OK");
}
