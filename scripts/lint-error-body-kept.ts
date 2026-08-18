#!/usr/bin/env tsx
// Guard: an HTTP client must not throw away the body of an error it cannot parse.
//
// The bug (2026-08-18). Every client wrapper in the repo did this:
//
//     try { parsed = await res.json(); }
//     catch { throw new ApiError(res.status, "non_json", `Non-JSON response (${res.status})`); }
//
// `res.json()` CONSUMES the body, so by the time the catch runs the response is
// drained and the only thing left to say is the status. The user saw
// "Non-JSON response (502)" — a sentence about the transport, not the failure —
// and the actual reason (a relay that timed out, a gateway's plain-text "Bad
// Gateway", an upstream note) was gone. Diagnosing ONE of those took hours of
// proxy, container and relay logs to recover a sentence the response had been
// carrying all along.
//
// The class: **an error path that destroys its own diagnostic.** It is not that
// the request failed; it is that the failure erased the evidence, so every
// occurrence costs a fresh investigation.
//
// The rule: in a client wrapper, read the body as TEXT first, then parse the
// text. That keeps the raw body available for the error message.
//
//     const raw = await res.text();
//     try { parsed = JSON.parse(raw); }
//     catch { throw new ApiError(res.status, "non_json", describeUnreadableBody(res.status, raw)); }
//
// `describeUnreadableBody` (@cobblr/platform-web) is the shared message.
//
//   cd <repo> && npx tsx scripts/lint-error-body-kept.ts
//
// Escape hatch: `// ERROR-BODY-OK: <reason>` on the offending line.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The files that define the app's HTTP error surface. */
function clientFiles(): string[] {
  const out: string[] = [];
  const web = join("web", "src", "lib", "api.ts");
  if (existsSync(web)) out.push(web);
  const modsDir = "modules";
  if (existsSync(modsDir)) {
    for (const m of readdirSync(modsDir)) {
      const p = join(modsDir, m, "src", "ui", "api.ts");
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

const offenders: string[] = [];
// The anti-pattern is narrow and specific: res.json() inside a try whose catch
// raises the "non_json" user-facing error. A plain success-path res.json(), or
// a `res.json().catch(() => null)` that already tolerates failure, is fine —
// neither one turns a body into a lost diagnostic.
const PATTERN =
  /try\s*\{[^{}]*await\s+res\.json\(\)[\s\S]{0,200}?\}\s*catch[^{]*\{[\s\S]{0,300}?"non_json"/g;

for (const f of clientFiles()) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(PATTERN)) {
    const line = src.slice(0, m.index ?? 0).split("\n").length;
    const snippet = src.slice(0, (m.index ?? 0) + m[0].length).split("\n");
    if (snippet.some((l) => /ERROR-BODY-OK:/.test(l) && snippet.indexOf(l) >= line - 1)) continue;
    offenders.push(`${f}:${line}  res.json() in a try whose catch throws "non_json"`);
  }
}

if (offenders.length > 0) {
  console.error(
    `✗ error-body-kept lint: ${offenders.length} client wrapper(s) parse the body with res.json().\n`,
  );
  for (const o of offenders) console.error(`  ${o}`);
  console.error(`
res.json() CONSUMES the response, so a parse failure leaves nothing to quote and
the user gets a message about the transport ("Non-JSON response (502)") instead
of the reason. Read TEXT first, then parse it:

    const raw = await res.text();
    try { parsed = JSON.parse(raw); }
    catch { throw new XApiError(res.status, "non_json", describeUnreadableBody(res.status, raw)); }

describeUnreadableBody comes from @cobblr/platform-web and is the shared wording.
Genuinely fine as-is? Add  // ERROR-BODY-OK: <reason>  on the line.`);
  process.exit(1);
}

console.log(
  `✓ error-body-kept lint: all ${clientFiles().length} client wrapper(s) keep the body for the error message.`,
);
