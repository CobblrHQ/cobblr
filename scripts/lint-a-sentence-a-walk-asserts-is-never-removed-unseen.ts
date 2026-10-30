#!/usr/bin/env tsx
// A change that removes a sentence from product source also updates every walk spec that asserts it.
//
// THE BUG THIS PREVENTS. 0ab64db325 (2026-10-15) dropped the invoice's "Choose Save as PDF in the print dialog." hint from the order page when downloads became real PDFs. e2e/walks/sales-invoice.json kept asserting it, nothing ran that spec before the merge, and the nightly tour went red on 2026-10-20 with "not on the page", five days of a failing night for a product that was right (#7626).
//
// THE RULE. Diff-scoped, like lint:changelog-names-ui: the lines this change removes from product source (web/src, packages/*/src, modules/*/src, api/src; not tests) are read against every `"text"` a walk spec in e2e/walks expects, of MIN_SENTENCE characters or more. A spec text that this change removes more often than it adds back fails, naming the spec and the file. The same change updates the spec, or puts the sentence back. A sentence that moved to another file passes: the change adds it where it went. Another file that already held it does not count (5e373c45b4, 2026-10-28: the order page lost "Payment date:" while the invoice PDF still said "Payment date", so this passed and the repair-shop walk went red that night).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A scan of every spec text against the source found half of them (721 of 1430) in no source file at all: they are data the walk seeds or text the api composes. So the rule is not "the sentence exists"; it is "this change took it away", which is only ever a statement about a sentence that was there. A sentence split across lines in the source is not matched; that is a miss, not a false alarm.
//
// PROVEN RED by scripts/lib/removed-sentences.test.ts on 0ab64db325's shape: the removed hint line against sales-invoice.json's expectation.
//
//   npx tsx scripts/lint-a-sentence-a-walk-asserts-is-never-removed-unseen.ts   (pnpm lint a-sentence-a-walk-asserts-is-never-removed-unseen)
import { execFileSync } from "node:child_process";
import { globSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addedLines, check, removedLines, type SpecText } from "./lib/removed-sentences.ts";
import { repoFiles } from "./lib/repo-files.ts";

const WALKS = "e2e/walks";
// `modules/*/src` as a plain pathspec names a path, not the files under it, so
// until 2026-10-30 this read no change under modules/ or packages/ at all and
// passed 5e373c45b4's removal of the order page's "Payment date:". The
// directories are listed from disk instead: a literal directory matches in
// every pathspec mode, where a `:(glob)` one matched nothing on CI. Each must
// hold a tracked file, or the lint refuses to answer (below).
const PRODUCT = ["web/src", "api/src", ...globSync("packages/*/src").sort(), ...globSync("modules/*/src").sort()];
const NOT_TESTS = [":(exclude)*.test.*", ":(exclude)*/__snapshots__/*"];

function tryGit(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

function findBase(): string | null {
  for (const ref of ["origin/main", "forgejo/main", "main"]) {
    const mb = tryGit(["merge-base", "HEAD", ref]);
    if (mb) return mb;
  }
  return null;
}

function specTexts(): SpecText[] {
  const out: SpecText[] = [];
  for (const name of readdirSync(WALKS)) {
    if (!name.endsWith(".json")) continue;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(WALKS, name), "utf8"));
    } catch {
      continue;
    }
    const visit = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(visit);
      else if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          if (k === "text" && typeof v === "string") out.push({ spec: `${WALKS}/${name}`, text: v });
          else visit(v);
        }
      }
    };
    visit(json);
  }
  return out;
}

const base = findBase();
if (!base) {
  console.log("[lint:a-sentence-a-walk-asserts-is-never-removed-unseen] no base ref (origin/main), skipping");
  process.exit(0);
}
const blind = [...PRODUCT.filter((spec) => repoFiles([spec]).length === 0), ...(PRODUCT.some((p) => p.startsWith("modules/")) ? [] : ["modules/*/src"])];
if (blind.length) {
  console.error(`lint:a-sentence-a-walk-asserts-is-never-removed-unseen - these pathspecs match no tracked file, so the lint would read nothing there: ${blind.join(", ")}`);
  process.exit(1);
}
const diff = tryGit(["diff", "-U0", base, "--", ...PRODUCT, ...NOT_TESTS]) ?? "";
const removed = removedLines(diff);
const violations = check(removed, addedLines(diff), specTexts());
if (violations.length) {
  console.error(`lint:a-sentence-a-walk-asserts-is-never-removed-unseen - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.spec}  expects "${v.text}", which this change removes from ${v.file}`);
  console.error("Update the walk spec to what the page says now, or put the sentence back.");
  process.exit(1);
}
console.log(`lint:a-sentence-a-walk-asserts-is-never-removed-unseen OK (${removed.length} removed line(s) read)`);
