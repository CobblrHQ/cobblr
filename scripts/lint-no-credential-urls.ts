#!/usr/bin/env tsx
// A workflow or a script never puts a credential in a URL (https://user:token@host or https://${TOKEN}@host): git prints its remote, a log keeps it, and the CI log sink masks nothing; git authenticates with scripts/lib/git-auth (an http.extraHeader) instead.
//
// THE BUG THIS PREVENTS. 2026-10-04: the embed-bridge job cloned edge-bridge
// from `https://${{ secrets.BUNDLE_SYNC_TOKEN }}@…` and its script printed
// `[embed] cloning <that URL>`. Forgejo masked the secret in its own log; the
// CI log sink, which knows no secrets, stored it in 23 job logs, and the token
// had to be rotated. Five more workflows and scripts built the same kind of URL.
//
// THE RULE. In .forgejo/ and scripts/, an http(s) URL whose userinfo (the part
// before `@`) is a variable, an expression or a secret is a violation:
// `https://${TOKEN}@`, `https://ci:${CLOUD_TOKEN}@`, `https://${{ secrets.X }}@`,
// `https://x:${token()}@`. So is a literal token-shaped userinfo (20+ word
// characters). Authenticate with `git_with_token` / `git_auth_export`
// (scripts/lib/git-auth.sh) or `gitAuthEnv` (scripts/lib/git-auth.mjs).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A git credential-STORE file
// (`credential.helper=store --file=<f>`) is written in exactly this URL shape on
// purpose, mode 600, deleted after the push, and never printed or used as a
// remote (scripts/publish/push-registry.mjs, build-public-history.mjs). Such a
// line opts out with `cred-url: <why>` on it or on the line above. Database
// DSNs (`postgres://user:${PASSWORD}@`) are not http(s) and not judged: they
// are a connection string a container reads, not a remote a tool prints.
//
//   npx tsx scripts/lint-no-credential-urls.ts   (pnpm lint no-credential-urls)
import { readFileSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.ts";

const ROOTS = [".forgejo", "scripts"];
const EXT = /\.(ya?ml|sh|bash|mjs|cjs|js|ts|py)$/;
// userinfo built from an expansion: ${X}, $X, ${{ ... }}, ${fn()} in a template literal
const EXPANDED = /https?:\/\/(?:[^\s/@"'`]|\$\{\{[^}]*\}\})*?(?:\$\{\{[^}]*\}\}|\$\{[^}]*\}|\$[A-Za-z_])(?:[^\s/@"'`]|\$\{\{[^}]*\}\})*@/;
// a literal token sitting in the URL
const LITERAL = /https?:\/\/(?:[^\s/@"'`:]*:)?[A-Za-z0-9_]{20,}@/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!EXPANDED.test(line) && !LITERAL.test(line)) continue;
    if (/cred-url: \S/.test(line) || /cred-url: \S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: "a credential in a URL: authenticate with scripts/lib/git-auth (git_with_token / gitAuthEnv) instead" });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const self = "scripts/lint-no-credential-urls.ts";
  const files = repoFiles(ROOTS).filter((f) => EXT.test(f) && f !== self && !/\.test\.[cm]?[jt]s$/.test(f));
  const violations = files.flatMap((f) => check(f, readFileSync(f, "utf8")));
  if (violations.length) {
    console.error(`lint:no-credential-urls - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("A git credential-store file written on purpose opts out with `cred-url: <why>` on the line or the line above.");
    process.exit(1);
  }
  console.log(`lint:no-credential-urls OK (${files.length} files)`);
}
