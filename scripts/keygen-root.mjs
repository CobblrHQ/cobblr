#!/usr/bin/env node
// Generate the Cobblr extension-registry ROOT signing key (ed25519).
//
//   node scripts/keygen-root.mjs
//
// Prints the PUBLIC key (set it as COBBLR_ROOT_PUBKEY on the api deploy)
// and the PRIVATE key (store it in your secret manager — 1Password, a CI
// secret, a hardware key — and NEVER commit it). The private key is the
// only thing that can mint a trusted official index; treat it accordingly.
// See docs/modules/extension-registry.md §2.4.
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

console.log("# Cobblr extension-registry ROOT key (ed25519)\n");
console.log("# PUBLIC — bake into the api deploy so the proxy can verify the official index:");
console.log(`COBBLR_ROOT_PUBKEY=${pub}\n`);
console.log("# PRIVATE — store in your secret manager; NEVER commit. Feed to");
console.log("# scripts/sign-extensions-index.mjs via COBBLR_ROOT_PRIVKEY (env) or --key <file>:");
console.log(`COBBLR_ROOT_PRIVKEY=${priv}`);
