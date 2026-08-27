#!/usr/bin/env tsx
// lint:csp-frame-ancestors — the two anti-clickjacking headers nginx sends for
// the SPA must agree, and must let the app frame ITSELF.
//
// docker/nginx.conf sends `X-Frame-Options: SAMEORIGIN` (old browsers) and a
// `Content-Security-Policy` with `frame-ancestors` (everything else). When
// they disagree, the browser applies the CSP one and the X-Frame-Options line
// is a comment. The first CSP shipped with `frame-ancestors 'none'`, which
// refuses same-origin framing too: every page of the app embedded by the app
// itself landed on chrome-error://chromewebdata/ (a black rectangle), while
// the header beside it still said "same origin is fine". The guided-tour phone
// stage is a same-origin iframe of /scan and recorded a black phone screen for
// three takes before anyone read the response headers.
//
// So: X-Frame-Options SAMEORIGIN ⇔ frame-ancestors 'self'. Both CSP maps
// (enforced and report-only) carry the same frame-ancestors value, so a later
// promotion of the report-only policy cannot re-tighten it by accident.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "docker/nginx.conf";
// Comments explain the directives and therefore name them; only directives count.
const conf = readFileSync(join(ROOT, FILE), "utf8")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

const failures: string[] = [];

const xfo = new Set([...conf.matchAll(/add_header\s+X-Frame-Options\s+"([^"]+)"/g)].map((m) => m[1]!.toUpperCase()));
const frameAncestors = [...conf.matchAll(/frame-ancestors\s+([^;"]+)/g)].map((m) => m[1]!.trim());

if (xfo.size === 0) failures.push(`${FILE}: no X-Frame-Options header — old browsers get no clickjacking protection.`);
if (xfo.size > 1) failures.push(`${FILE}: X-Frame-Options is set to more than one value (${[...xfo].join(", ")}); one location block drifted.`);
if (frameAncestors.length === 0) failures.push(`${FILE}: no frame-ancestors directive in the CSP maps.`);

const distinct = new Set(frameAncestors);
if (distinct.size > 1) {
  failures.push(
    `${FILE}: the enforced and report-only CSP maps disagree on frame-ancestors (${[...distinct].join(" vs ")}); promoting report-only would change who may frame the app.`,
  );
}

const wantSelf = xfo.has("SAMEORIGIN");
for (const fa of distinct) {
  const tokens = fa.split(/\s+/);
  if (wantSelf && !tokens.includes("'self'")) {
    failures.push(
      `${FILE}: X-Frame-Options says SAMEORIGIN but the CSP says \`frame-ancestors ${fa}\` — the CSP wins, so the app can no longer frame itself (label previews, the guided-tour phone stage) and every such frame renders as a black chrome-error:// page. Use 'self'.`,
    );
  }
  if (!wantSelf && tokens.includes("'self'")) {
    failures.push(`${FILE}: the CSP allows same-origin framing but X-Frame-Options (${[...xfo].join(",")}) does not — pick one and make both say it.`);
  }
}

if (failures.length) {
  console.error(`[lint:csp-frame-ancestors] ✗ ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[lint:csp-frame-ancestors] ✓ X-Frame-Options and frame-ancestors agree, and the app may frame itself");
