#!/usr/bin/env node
// ed25519 sign a tarball. Author-side tool — modules publishing to
// the cobblr registry sign their release tarballs with this, then
// embed the resulting signature (and public key) in the registry's
// modules.json. Image-build verifies before extracting.
//
// Usage:
//   node scripts/sign-tarball.mjs <tarball> <private-key-pem>
//
// Outputs (to stdout, one per line):
//   sha256:<hex>
//   signature:<base64>
//
// Also writes <tarball>.sig containing just the base64 signature.

import { createHash, sign as cryptoSign, createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [, , tarballPath, keyPath] = process.argv;
if (!tarballPath || !keyPath) {
  console.error("usage: node scripts/sign-tarball.mjs <tarball> <private-key.pem>");
  process.exit(1);
}

const tarball = readFileSync(tarballPath);
const sha = createHash("sha256").update(tarball).digest("hex");

const keyPem = readFileSync(keyPath, "utf-8");
const privKey = createPrivateKey({ key: keyPem, format: "pem" });
if (privKey.asymmetricKeyType !== "ed25519") {
  console.error(`expected ed25519 private key, got ${privKey.asymmetricKeyType}`);
  process.exit(1);
}

const sig = cryptoSign(null, tarball, privKey);
const sigB64 = sig.toString("base64");

console.log(`sha256:${sha}`);
console.log(`signature:${sigB64}`);
writeFileSync(`${tarballPath}.sig`, sigB64 + "\n");
