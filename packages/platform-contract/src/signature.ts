// The one ed25519 check: does this signature, by this public key, cover these
// bytes? Server-side only (it needs node:crypto).
//
// It was written four times: the registry index, the runtime sandbox install,
// the file-preview renderers and the image-build installer. Two stripped the
// registry's `ed25519:` prefix inside, two left it to the caller; two returned
// false on a malformed key and two threw, which at the sandbox install door
// turned a bad key into a 500 instead of "the signature did not verify". They
// agreed on every signature the registry writes today, which is the whole
// reason nobody saw the difference. A signature check is the last place a
// spelling difference should live (#3421, #3499).
//
// The image-build installer (scripts/install-registry-modules.mjs) runs as
// plain node before anything is built, so it keeps its own copy;
// scripts/signature-verdicts-agree.test.ts holds the two to the same verdict.
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/** The registry writes a signature as `ed25519:<base64>`; a bare base64 is
 *  accepted too. */
const PREFIX = "ed25519:";

/** True when `signature` verifies `data` under `publicKeyB64` (base64 DER
 *  SubjectPublicKeyInfo). False for anything else, a malformed key or signature
 *  included: this never throws, so a caller's refusal is always "did not
 *  verify", never an error that reads like something else. */
export function verifyEd25519(publicKeyB64: string, data: Uint8Array | string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    const sig = Buffer.from(signature.startsWith(PREFIX) ? signature.slice(PREFIX.length) : signature, "base64");
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    return cryptoVerify(null, bytes, key, sig);
  } catch {
    return false;
  }
}
