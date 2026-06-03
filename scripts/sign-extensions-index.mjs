#!/usr/bin/env node
// Sign the cobblr-extensions index with the ROOT private key, producing a
// detached ed25519 signature the api proxy verifies (COBBLR_ROOT_PUBKEY).
//
//   COBBLR_ROOT_PRIVKEY=<base64 pkcs8> node scripts/sign-extensions-index.mjs index.json
//   node scripts/sign-extensions-index.mjs index.json --key root.key --out index.json.sig
//
// The signature is over the EXACT bytes of index.json — commit index.json
// and index.json.sig together to the cobblr-extensions repo. The private
// key is read from the env or a file path; it is never written or logged.
// See docs/modules/extension-registry.md §2.4.
import { readFileSync, writeFileSync } from "node:fs";
import { sign as cryptoSign, createPrivateKey } from "node:crypto";

const argv = process.argv.slice(2);
// Indices that are flag VALUES (the arg after --out / --key), so we don't
// mistake them for the positional <index.json>.
const flagValueIdx = new Set();
for (const f of ["--out", "--key"]) {
  const i = argv.indexOf(f);
  if (i > -1) flagValueIdx.add(i + 1);
}
const indexPath = argv.find((a, i) => !a.startsWith("--") && !flagValueIdx.has(i));
if (!indexPath) {
  console.error("usage: node sign-extensions-index.mjs <index.json> [--key <file>] [--out <sig>]");
  process.exit(1);
}
const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : `${indexPath}.sig`;

let privB64 = process.env.COBBLR_ROOT_PRIVKEY;
if (!privB64 && argv.includes("--key")) privB64 = readFileSync(argv[argv.indexOf("--key") + 1], "utf8").trim();
if (!privB64) {
  console.error("no private key: set COBBLR_ROOT_PRIVKEY (env) or pass --key <file>");
  process.exit(1);
}

const key = createPrivateKey({ key: Buffer.from(privB64, "base64"), format: "der", type: "pkcs8" });
const bytes = readFileSync(indexPath);
const sig = cryptoSign(null, bytes, key).toString("base64");
writeFileSync(out, sig + "\n");
console.log(`signed ${indexPath} (${bytes.length} bytes) → ${out}`);
