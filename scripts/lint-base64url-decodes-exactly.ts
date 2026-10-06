#!/usr/bin/env tsx
// A base64url decode in the api or a module reads the one canonical spelling
// of its input.
//
// THE BUG THIS PREVENTS. The receipt-email address token (#4981's audit):
// its payload was decoded and the BYTES signed, and Node's decoder ignores the
// unused bits of the last character, so four spellings of one address all
// verified. Nothing was guessable (the signature had to match), but a token
// must be one string, not a family, and the next token read this way may sit
// in front of something that compares less carefully.
//
// THE RULE. `Buffer.from(x, "base64url")` in api/src or a module's
// src goes through decodeBase64urlExact (@cobblr/platform-contract/
// base64url-exact), which answers null unless re-encoding gives back the very
// string it was handed, or carries `b64-lenient-ok: <why>` on its line or the
// line above: a list cursor (it only says where a page starts), or a payload
// whose signature was already checked over the string as given.
//
// THE BOUNDARY. base64url only: it is the alphabet tokens, refs and cursors
// are minted in here, while plain "base64" decodes carry data (a file, an
// image, a mail part) whose bytes are the point and which nobody looks up.
// Decodes only: `.toString("base64url")` is an encode and makes one spelling
// by construction. Tests, the web app and scripts are out: none
// of them checks a token a stranger sent.
//
//   npx tsx scripts/lint-base64url-decodes-exactly.ts   (pnpm lint base64url-decodes-exactly)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOTS = ["api/src", "modules"];
const REASON = /b64-lenient-ok: \S/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name === "ui" || name === "tests" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) yield p;
  }
}

function check(file: string, src: string): Violation[] {
  if (!src.includes('"base64url"')) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const lines = src.split("\n");
  const out: Violation[] = [];
  const v = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(sf) === "Buffer.from" &&
      n.arguments.length === 2 &&
      ts.isStringLiteralLike(n.arguments[1]!) &&
      n.arguments[1].text === "base64url"
    ) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      if (!REASON.test(lines[line] ?? "") && !REASON.test(lines[line - 1] ?? "")) {
        out.push({ file, line: line + 1, what: `Buffer.from(…, "base64url") reads every spelling of its last character as the same bytes` });
      }
    }
    ts.forEachChild(n, v);
  };
  v(sf);
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:base64url-decodes-exactly - ${violations.length} violation(s):`);
  for (const x of violations) console.error(`  ${x.file}:${x.line}  ${x.what}`);
  console.error(`
  A token read by decoding it opens for every spelling of its last character.
  Use decodeBase64urlExact (@cobblr/platform-contract/base64url-exact), or say on the
  line why a lenient read is right: // b64-lenient-ok: <why>.`);
  process.exit(1);
}
console.log("lint:base64url-decodes-exactly OK");
