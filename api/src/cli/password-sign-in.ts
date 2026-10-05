// Turn password (and email-link) sign-in back on, or off, from the box: the
// way back in when the instance's own sign-in provider is down or misset and
// password sign-in was turned off (#4492, platform/oidc.ts).
//
//   node dist/cli/password-sign-in.js on
//   node dist/cli/password-sign-in.js off     (same rule as the page: a
//                                              platform admin must have signed
//                                              in through a provider first)
//   node dist/cli/password-sign-in.js         (says which it is)
//
// Runs INSIDE the api container (docker exec), like view-as.

import { writeSync } from "node:fs";
import { passwordSignInOn, setPasswordSignIn } from "../platform/oidc.js";

function done(text: string, code = 0): never {
  writeSync(code ? 2 : 1, `password-sign-in: ${text}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const want = process.argv[2];
  if (!want) done(`password sign-in is ${(await passwordSignInOn()) ? "on" : "off"}.`);
  if (want !== "on" && want !== "off") done("usage: password-sign-in [on|off]", 2);
  const out = await setPasswordSignIn(want === "on");
  if (!out.ok) done(out.message, 1);
  done(`password sign-in is ${want} now.`);
}

main().catch((err) => done((err as Error).message, 1));
