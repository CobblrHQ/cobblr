#!/usr/bin/env tsx
/**
 * lint:no-secret-echo — a generated secret must not be printed to stdout.
 *
 * `deploy/setup.sh` used to echo the three secrets it generates so an operator
 * could copy them down. One of them is `TENANT_CREDS_ENCRYPTION_KEY`, which makes
 * every tenant database in the instance readable and CANNOT be regenerated once a
 * workspace exists. Printing it puts it in terminal scrollback, the ssh session
 * log, and any CI or agent transcript that ran the script — several places that
 * outlive the moment and none of which have permissions.
 *
 * The fix is a root-owned 0600 file the operator opens on purpose. This keeps it
 * that way: a setup script that grows a "just show me the value" convenience is
 * how the original got there.
 *
 * The rule is narrow on purpose — it flags an `echo`/`printf` that EXPANDS a
 * secret-named variable. Printing the NAME (`echo "set JWT_SECRET in .env"`) is
 * how these scripts tell an operator what to do, and is fine.
 *
 *   pnpm run lint:no-secret-echo
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;

// Scoped to the scripts that GENERATE secrets. Elsewhere in the repo a shell
// script printing a token is usually a deliberate `--print-token` affordance,
// and widening this would make it a lint people learn to route around.
const FILES = globSync("deploy/**/*.sh", { cwd: ROOT });

const SECRET_NAME = /(SECRET|PASSWORD|_KEY|TOKEN)$/;

type Finding = { file: string; line: number; text: string };
const findings: Finding[] = [];

for (const rel of FILES) {
  const lines = readFileSync(ROOT + rel, "utf8").split("\n");
  lines.forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith("#")) return;
    if (!/^(echo|printf)\b/.test(code)) return;
    // Any ${VAR} or $VAR expansion whose name looks like a secret.
    for (const m of code.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/g)) {
      const name = m[1]!;
      if (!SECRET_NAME.test(name)) continue;
      // A path or a filename that merely contains the word is not the value.
      if (/_FILE$|_PATH$|_NAME$/.test(name)) continue;
      findings.push({ file: rel, line: i + 1, text: code.slice(0, 120) });
      return;
    }
  });
}

if (findings.length) {
  console.error("[lint:no-secret-echo] ✗ generated secrets printed to stdout:\n");
  for (const f of findings) console.error(`    ${f.file}:${f.line}  ${f.text}`);
  console.error(`
  stdout is terminal scrollback, an ssh log and any transcript of the run. Write the
  value to a root-owned 0600 file and print its PATH instead — deploy/setup.sh's
  secrets-backup.txt is the pattern. Printing the variable NAME without expanding it
  is fine and is not flagged.
`);
  process.exit(1);
}

console.log(`[lint:no-secret-echo] ✓ ${FILES.length} deploy script(s) print no secret values`);
