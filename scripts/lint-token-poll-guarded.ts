#!/usr/bin/env tsx
// A walk that polls localStorage for the session token after signup goes through tokenInBrowser(): an evaluate caught in the post-signup document replacement throws, and unguarded it kills the run with no scoreboard.
//
// THE BUG THIS PREVENTS. Every walk polls for the token the app writes after
// signup, and the poll races the app's own post-signup navigation: signup
// lands on a bare URL, the app replaces the document to reach /w/<slug>, and a
// page.evaluate caught in that window throws "Execution context was destroyed,
// most likely because of a navigation". Nothing caught it, so the walk died
// with a node stack trace and no scoreboard at all. It killed bramble on the
// dev rig, which then passed twice in a row with nothing changed: what an
// unguarded race looks like (#3456). Twenty-six files carried it, written
// three ways (spaced, minified, and on a page called `p`), which is why a
// search for one spelling reported "none left" while four remained.
//
// AND THE READ ON THE NEXT LINE. Twelve walks then read the workspace slug the
// same way (`cobblr.activeOrgSlug`), inside the same window. Once the token
// poll stopped dying there, that read did: public-board passed 6/6 unconverted
// and died on the slug read converted. So it is held here too, and the answer
// is slugFromApi(), which asks /me with no page involved.
//
// THE RULE. In e2e/ and kiosk/, a `.evaluate(() => localStorage.getItem(
// "cobblr.token"))` goes through tokenInBrowser() (e2e/prod-look.mjs) or
// carries its own `.catch(...)`, and a read of "cobblr.activeOrgSlug" goes
// through slugFromApi() or carries its own `.catch(...)`.
// Whitespace-insensitive, any page variable.
//
// PROVED RED 2026-09-22 against main: 34 unguarded reads (the token polls
// left after the first five were fixed, and the slug reads beside them);
// green once they went through the two helpers.
//
//   npx tsx scripts/lint-token-poll-guarded.ts   (pnpm run lint:token-poll-guarded)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["e2e", "kiosk"];
const HELPER = join("e2e", "prod-look.mjs");
const POLL = /\w+\.evaluate\(\s*\(\)\s*=>\s*localStorage\.getItem\(\s*["']cobblr\.(token|activeOrgSlug)["']\s*\)\s*\)(\s*\.catch\()?/g;

const violations: { file: string; line: number; text: string }[] = [];
for (const root of ROOTS) {
  let names: string[] = [];
  try { names = readdirSync(root); } catch { continue; }
  // `.git` skipped by name: a fetch writes <branch>.lock into it mid-walk.
  for (const name of names.filter((n) => n !== ".git" && /\.(mjs|js)$/.test(n))) {
    const file = join(root, name);
    if (file === HELPER) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(POLL)) {
        if (m[2]) continue; // it carries its own .catch
        violations.push({ file, line: i + 1, text: line.trim().slice(0, 110) });
      }
    });
  }
}

if (violations.length) {
  console.error(`lint:token-poll-guarded - ${violations.length} unguarded post-signup localStorage read(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  console.error(
    "An evaluate caught in the post-signup document replacement throws and ends the walk with no scoreboard.\n" +
      "Use: token = await tokenInBrowser(page), slug = await slugFromApi(API, token)   (e2e/prod-look.mjs).",
  );
  process.exit(1);
}
console.log("lint:token-poll-guarded OK (every post-signup token and slug read survives the redirect)");
