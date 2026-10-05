// The address a link we SEND somewhere starts with.
//
// A link in an email (sign in, reset a password, verify, confirm or undo a
// change of address, an invite) carries a token that is the account. Built
// from the request's Host header, whoever triggers the email chooses where
// the token goes: ask for a reset of someone else's account with a forged
// Host, and their click hands the token to the forger's server. The
// configured public address is the instance's own word for where it lives,
// so it wins whenever it is set; the request's host is only the fallback of
// an instance that never said (a laptop, a test rig).
//
// lint:links-use-the-public-address holds every other read of the request's
// host in the api to this file, or to a line that says why it is safe.
import type { Request } from "express";
import { publicBaseUrl } from "./public-url.js";

export function linkOrigin(req: Request): string {
  return publicBaseUrl() || `${req.protocol}://${req.get("host") ?? ""}`;
}
