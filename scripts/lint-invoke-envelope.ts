#!/usr/bin/env tsx
// Two ways an integration test lies about passing, both caught here.
//
// 1. A test that invokes an action must read the RESULT, not the envelope.
// 2. A request path must carry the /api/v1 the helper does not add.
//
// POST /actions/invoke answers `{ ok: true, result: <what the handler returned> }`.
// The outer `ok` only means "dispatched": a handler that refuses returns
// `{ ok: false, error }` INSIDE `result`, and the envelope is `ok: true` all the
// same. So `expect(res.ok).toBe(false)` written against the raw response is an
// assertion that can never fail, and a refusal nobody implemented passes as
// tested. Three of them shipped in one file (field-actions, 2026-08-24) and only
// showed up because the happy-path assertions in the same file failed too.
//
// The rule: a test file that posts to /actions/invoke must unwrap it — either
// through invokeAction() in api/tests/helpers.ts (which returns the inner
// result) or by reading `.result` itself. A file that does neither and then
// asserts on `.ok` is the bug.
//
//   cd <repo> && npx tsx scripts/lint-invoke-envelope.ts

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join("api", "tests");
const problems: string[] = [];

for (const f of readdirSync(DIR)) {
  if (!f.endsWith(".test.ts")) continue;
  const src = readFileSync(join(DIR, f), "utf8");
  if (!src.includes("actions/invoke")) continue;
  // Unwrapped one way or the other: nothing to say.
  if (src.includes("invokeAction") || /\.result\b/.test(src)) continue;
  const asserts = [...src.matchAll(/expect\(([\w.]+)\)\.toBe(?:Falsy)?\(?(?:false)?\)?/g)];
  const onOk = asserts.filter((m) => m[1]!.endsWith(".ok"));
  if (onOk.length) {
    problems.push(
      `  ${join(DIR, f)}\n      posts to /actions/invoke and asserts on .ok without ever reading .result`,
    );
  }
}

// ── 2. request paths ────────────────────────────────────────────────────────
// http(session, path) fetches BASE + path verbatim: `org()` builds the /api/v1
// prefix, and a hand-written literal has to carry it. `http(s, "/orgs")` is a
// 404 that reads like a missing route, six minutes into a CI run (2026-08-24).
for (const f of readdirSync(DIR)) {
  if (!f.endsWith(".test.ts")) continue;
  const src = readFileSync(join(DIR, f), "utf8");
  for (const m of src.matchAll(/\bhttp(?:<[^>]*>)?\(\s*\w+\s*,\s*"(\/[^"]*)"/g)) {
    const path = m[1]!;
    if (path.startsWith("/api/v1")) continue;
    problems.push(
      `  ${join(DIR, f)}\n      http(…, "${path}") — a request path needs the /api/v1 prefix (or org(session, …), which adds it)`,
    );
  }
}

if (problems.length) {
  console.error(
    `✗ invoke-envelope lint: ${problems.length} problem(s) in the api integration tests.\n\n` +
      problems.join("\n") +
      "\n\nThe envelope's ok is always true when the action was dispatched — the handler's\n" +
      "refusal is inside `result`. Use invokeAction(session, id, args) from api/tests/helpers.ts,\n" +
      "which returns the inner result, so `expect(res.ok).toBe(false)` means what it reads like.\n",
  );
  process.exit(1);
}
console.log(
  "✓ invoke-envelope lint: action-invoking tests read the result, and request paths carry /api/v1",
);
