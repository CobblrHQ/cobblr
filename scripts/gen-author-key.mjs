#!/usr/bin/env node
// Generate an ed25519 keypair for a module author. The private key
// is kept secret (1Password / hardware key / wherever the author
// likes); the public key gets embedded in the cobblr registry
// modules.json under the module's public_key_ed25519 field.
//
// Usage:
//   node scripts/gen-author-key.mjs <author-name>
//
// Outputs:
//   <author-name>.ed25519.pem      private key, PEM
//   <author-name>.ed25519.pub.b64  public key, base64-encoded DER

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const author = process.argv[2];
if (!author) {
  console.error("usage: node scripts/gen-author-key.mjs <author-name>");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const privPem = privateKey.export({ format: "pem", type: "pkcs8" });
const pubDer = publicKey.export({ format: "der", type: "spki" });
const pubB64 = pubDer.toString("base64");

writeFileSync(`${author}.ed25519.pem`, privPem);
writeFileSync(`${author}.ed25519.pub.b64`, pubB64 + "\n");

console.log(`wrote ${author}.ed25519.pem (private — KEEP SECRET, do not commit)`);
console.log(`wrote ${author}.ed25519.pub.b64 (public — paste into registry modules.json)`);
console.log("");
console.log("public key (paste into modules.json under public_key_ed25519):");
console.log(pubB64);
