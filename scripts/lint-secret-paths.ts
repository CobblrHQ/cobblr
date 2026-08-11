#!/usr/bin/env tsx
/**
 * lint:secret-paths — a credential file is located by the resolver, never by a
 * hand-written `$HOME/.<name>`.
 *
 * Credential files live in `~/.secrets/<name>` now (dir 700, files 600); they used to
 * be loose dotfiles in `$HOME`, which grew past 30 and became impossible to pick out.
 * The resolvers check the new path first and fall back to the legacy one, so files can
 * migrate one at a time — but ONLY for call sites that go through them. A script that
 * hard-codes `"$HOME/.cobblr-foo-token"` pins that file in place forever, and the
 * failure when it finally moves is a credential read that comes back empty: a 401, or
 * a webhook that posts nowhere, pointing at everything except the missing file.
 *
 * So: two rules, and behaviour fixtures for the resolvers themselves (a string check
 * would happily pass a resolver whose logic had been mangled).
 *   1. No literal home-relative path to a credential-looking dotfile, outside the
 *      resolvers that must name the legacy location.
 *   2. Both resolvers must prefer ~/.secrets, fall back to the legacy dotfile, report
 *      the PREFERRED path when neither exists, and skip comment/blank lines.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const SH = "scripts/lib/secret-file.sh";
const MJS = "scripts/lib/secret-file.mjs";
const SELF = "scripts/lint-secret-paths.ts";
// forgejo-token.sh delegates to the resolver but keeps its own name in prose.
const EXEMPT = new Set([SH, MJS, SELF]);
const SCAN_DIRS = ["scripts", "e2e", "kiosk"];
const SCAN_EXT = [".sh", ".mjs", ".ts", ".js", ".cjs"];
const fails: string[] = [];

/** A dotfile name that reads like a credential rather than ordinary config.
 *  `.secrets` itself is the DESTINATION, not a credential — naming it is the fix. */
const credentialish = (name: string) =>
  !/^secrets(\/|$)/.test(name) &&
  (/(token|key|webhook|cred|secret|passwd|password|apikey)/i.test(name) || name.endsWith(".env"));

// `$HOME/.x`, `${HOME}/.x`, `~/.x`, `${process.env.HOME}/.x`
const HOME_PATH = /(?:\$\{?HOME\}?|\$\{process\.env\.HOME\}|~)\/\.([A-Za-z0-9._-]+)/g;
// join(homedir(), ".x") and join(process.env.HOME, ".x")
const JOIN_HOME = /(?:homedir\(\)|process\.env\.HOME(?:\s*\?\?\s*"")?)\s*,\s*["'`]\.([A-Za-z0-9._-]+)["'`]/g;

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      walk(full, out);
    } else if (SCAN_EXT.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
for (const abs of files) {
  const rel = relative(ROOT, abs);
  if (EXEMPT.has(rel)) continue;
  const lines = readFileSync(abs, "utf8").split("\n");
  lines.forEach((line, i) => {
    // Comments are prose, and prose legitimately names a path to explain it (a usage
    // block, a "where this lives" note). The rule is about what the code RESOLVES.
    const t = line.trimStart();
    if (t.startsWith("#") || t.startsWith("//") || t.startsWith("*")) return;
    for (const re of [HOME_PATH, JOIN_HOME]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        const name = m[1]!;
        if (!credentialish(name)) continue;
        fails.push(
          `${rel}:${i + 1} hard-codes a credential path (\`.${name}\`), so that file can never\n` +
            `    move into ~/.secrets/. Use the resolver instead:\n` +
            `      shell:  . "$(dirname "$0")/lib/secret-file.sh"; F="$(secret_file ${name})"\n` +
            `      node:   import { secretFile } from "./lib/secret-file.mjs"  →  secretFile("${name}")\n` +
            `    ${line.trim().slice(0, 100)}`,
        );
      }
    }
  });
}

// ── Rule 2: the resolvers must behave ────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "secret-paths-"));
const secrets = join(tmp, "secrets");
const home = join(tmp, "home");
mkdirSync(secrets);
mkdirSync(home);
writeFileSync(join(secrets, "in-new"), "# header\n\nNEWVALUE\n");
writeFileSync(join(home, ".in-old"), "# header\nOLDVALUE\n");

const shOut = (name: string, fn: "secret_file" | "secret_value") =>
  spawnSync("bash", ["-c", `. "${join(ROOT, SH)}"; ${fn} ${name}`], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, COBBLR_SECRETS_DIR: secrets },
  });

const nodeOut = (expr: string) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", `import {secretFile,readSecret} from "${join(ROOT, MJS)}";console.log(${expr})`], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, COBBLR_SECRETS_DIR: secrets },
  });

const cases: Array<{ label: string; got: string; want: string }> = [
  { label: "shell: prefers ~/.secrets", got: shOut("in-new", "secret_file").stdout, want: join(secrets, "in-new") },
  { label: "shell: falls back to the legacy dotfile", got: shOut("in-old", "secret_file").stdout, want: join(home, ".in-old") },
  { label: "shell: names the PREFERRED path when neither exists", got: shOut("nowhere-token", "secret_file").stdout, want: join(secrets, "nowhere-token") },
  { label: "shell: skips the comment header", got: shOut("in-new", "secret_value").stdout, want: "NEWVALUE" },
  { label: "shell: reads the legacy file's value", got: shOut("in-old", "secret_value").stdout, want: "OLDVALUE" },
  { label: "node: prefers ~/.secrets", got: nodeOut(`secretFile("in-new")`).stdout.trim(), want: join(secrets, "in-new") },
  { label: "node: falls back to the legacy dotfile", got: nodeOut(`secretFile("in-old")`).stdout.trim(), want: join(home, ".in-old") },
  { label: "node: names the PREFERRED path when neither exists", got: nodeOut(`secretFile("nowhere-token")`).stdout.trim(), want: join(secrets, "nowhere-token") },
  { label: "node: skips the comment header", got: nodeOut(`readSecret("in-new")`).stdout.trim(), want: "NEWVALUE" },
  { label: "node: a missing file reads as empty, not a throw", got: nodeOut(`JSON.stringify(readSecret("nowhere-token"))`).stdout.trim(), want: `""` },
];
for (const c of cases) {
  if (c.got !== c.want) fails.push(`${c.label} — got ${JSON.stringify(c.got)}, expected ${JSON.stringify(c.want)}`);
}

// A leading dot on the name must not produce `~/.secrets/.name` — call sites carry the
// dot in prose and it is an easy thing to pass through.
if (shOut(".in-new", "secret_file").stdout !== join(secrets, "in-new")) {
  fails.push("shell: a leading dot on the name is not stripped");
}
if (nodeOut(`secretFile(".in-new")`).stdout.trim() !== join(secrets, "in-new")) {
  fails.push("node: a leading dot on the name is not stripped");
}

// An empty credential is an ERROR in shell (it becomes an auth header) and "" in node
// (an unset webhook is normal). Both must be non-silent in their own way.
writeFileSync(join(secrets, "only-comments-token"), "# nothing here\n\n");
if (shOut("only-comments-token", "secret_value").status === 0) {
  fails.push("shell: secret_value exits 0 on a comments-only file — an empty auth header 401s puzzlingly");
}

rmSync(tmp, { recursive: true, force: true });

// The directory itself must be private. A 755 ~/.secrets is worse than the loose
// dotfiles it replaced, because it collects every credential in one readable place.
try {
  const home = process.env.HOME;
  if (home) {
    const dir = join(home, ".secrets");
    const mode = statSync(dir).mode & 0o777;
    if (mode & 0o077) {
      fails.push(`~/.secrets is mode ${mode.toString(8)} — should be 700 (chmod 700 ~/.secrets)`);
    }
  }
} catch {
  /* no ~/.secrets on this machine (CI) — nothing to check */
}

if (fails.length) {
  console.error("lint:secret-paths FAILED\n");
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`lint:secret-paths OK (${files.length} files, both resolvers exercised)`);
