#!/usr/bin/env tsx
/**
 * lint:forgejo-token — a credential never reaches an HTTP header as a raw `cat`.
 *
 * A token file is human-edited, so it grows a comment header. `$(cat "$TOKEN_FILE")`
 * then produces a multi-line value and libcurl rejects the request with exit 43
 * ("bad argument"), naming neither the header nor the token. It broke the nightly
 * self-host build on 2026-08-09, and it was invisible because the same file has
 * ONE line on a workstation and SEVEN on the deploy box: the code passed every
 * local test and only failed where it ran unattended.
 *
 * Three rules:
 *   1. No `$(cat …)` (or backtick cat) inside an Authorization/token header.
 *   2. A script that reads a Forgejo token file must source scripts/lib/forgejo-token.sh.
 *   3. The helper itself must keep stripping comments/blank lines and refusing empty.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const LIB = "scripts/lib/forgejo-token.sh";
const fails: string[] = [];

const shellFiles = readdirSync(join(ROOT, "scripts"), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".sh"))
  .map((e) => `scripts/${e.name}`);

for (const rel of shellFiles) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("#")) return;
    // A header line that mentions a credential AND interpolates a raw file read.
    const isAuthHeader = /Authorization:|Api-Key|X-Auth-Token|token:/i.test(line);
    const rawRead = /\$\(\s*cat\s|`\s*cat\s/.test(line);
    if (isAuthHeader && rawRead) {
      fails.push(
        `${rel}:${i + 1} builds an auth header from a raw \`cat\` — a comment header in the\n` +
          `    credential file makes it multi-line and libcurl fails with exit 43.\n` +
          `    Use: -H "Authorization: token $(forgejo_token "$TOKEN_FILE")"\n` +
          `    ${line.trim().slice(0, 100)}`,
      );
    }
  });

  // Rule 2: reads a forgejo token file -> must use the shared reader.
  const readsForgejoToken = /forgejo-claude-ops-token|forgejo-docs-flush-token|FORGEJO_TOKEN_FILE/.test(text);
  if (readsForgejoToken && rel !== LIB) {
    const usesHelper = text.includes("forgejo_token") || text.includes(LIB);
    // Scripts that only PASS the path onward (never read it) are fine.
    const readsIt = /\$\(\s*cat\s+"?\$(TOKEN_FILE|\{TOKEN_FILE)/.test(text) || /grep -vE '\^#\|\^\$' "\$TOKEN_FILE"/.test(text);
    if (readsIt && !usesHelper) {
      fails.push(
        `${rel} reads a Forgejo token file by hand. Source ${LIB} and call forgejo_token instead,\n` +
          `    so the comment-header case is handled in one place.`,
      );
    }
  }

  // Rule 2b: CALLS forgejo_token -> must actually source the lib that defines it.
  //
  // Rule 2 above treats the mere presence of the string "forgejo_token" as evidence
  // the helper is in use, which is exactly backwards for this failure: release-daily
  // called the function and never sourced the file, so the function was undefined,
  // the command substitution produced an empty string, and the CI-green gate refused
  // every candidate with "(no token - cannot check CI, refusing)". The nightly
  // release stopped releasing and the message pointed at the credential file.
  //
  // An explicit source line is required rather than a transitive one: relying on
  // another lib to pull it in makes the dependency invisible and one refactor away
  // from this same silence.
  //
  // The check is for an actual `source` DIRECTIVE, not a mention of the path. A
  // substring test passes on a script that merely names the file in a comment or an
  // error message — which this very script does, two lines from the call, so the
  // first version of this rule reported the fixed and broken trees identically.
  if (rel !== LIB) {
    const callsHelper = text
      .split("\n")
      .some((l) => !l.trimStart().startsWith("#") && /(^|[^\w.-])forgejo_token\s/.test(l));
    // `.*` and not `\S*`: the real form is `. "$(dirname "$0")/lib/forgejo-token.sh"`,
    // which contains a space inside the command substitution. Anchoring on the leading
    // `.`/`source` is what keeps a comment or an error message from counting.
    const sourcesHelper = /^\s*(\.|source)\s+.*lib\/forgejo-token\.sh/m.test(text);
    if (callsHelper && !sourcesHelper) {
      fails.push(
        `${rel} calls forgejo_token but never sources ${LIB}, so the function is undefined\n` +
          `    and the token silently reads as empty. Add near the top:\n` +
          `        . "$(dirname "$0")/lib/forgejo-token.sh"`,
      );
    }
  }
}

// Rule 3: the helper must BEHAVE. Deliberately not a string check: grepping for
// `head -1` happily passes a helper whose pipeline has been mangled into emitting
// a broken value, which is how the original bug survived review. So run it against
// fixtures — including the deploy box's exact shape — and assert the output.
const fixtures = mkdtempSync(join(tmpdir(), "forgejo-token-"));
const cases = [
  {
    name: "commented.txt",
    body: "# what this is for\n# scopes: repo\n\n  tok_ABC123  \n# a trailing note\n",
    expect: "tok_ABC123",
    label: "a comment-headed file (the deploy box's shape) yields the bare token",
  },
  { name: "plain.txt", body: "tok_PLAIN\n", expect: "tok_PLAIN", label: "a one-line file still works" },
  { name: "crlf.txt", body: "# note\r\ntok_CRLF\r\n", expect: "tok_CRLF", label: "a CRLF file yields no carriage return" },
  { name: "empty.txt", body: "# only comments\n\n", expect: null, label: "a file with no credential FAILS loudly" },
] as const;

for (const c of cases) {
  const path = join(fixtures, c.name);
  writeFileSync(path, c.body);
  const r = spawnSync("bash", ["-c", `set -o pipefail; . "${join(ROOT, LIB)}"; forgejo_token "${path}"`], {
    encoding: "utf8",
  });
  if (c.expect === null) {
    if (r.status === 0) fails.push(`${LIB}: ${c.label} — but it exited 0 with ${JSON.stringify(r.stdout)}.`);
  } else if (r.status !== 0) {
    fails.push(`${LIB}: ${c.label} — but it exited ${r.status}. stderr: ${r.stderr.trim()}`);
  } else if (r.stdout !== c.expect) {
    fails.push(
      `${LIB}: ${c.label} — got ${JSON.stringify(r.stdout)}, expected ${JSON.stringify(c.expect)}.` +
        (/[\r\n]/.test(r.stdout) ? " It carries a newline, so libcurl rejects the header with exit 43." : ""),
    );
  }
}
rmSync(fixtures, { recursive: true, force: true });

if (fails.length) {
  console.error("lint:forgejo-token FAILED\n");
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`lint:forgejo-token OK (${shellFiles.length} shell scripts checked)`);
