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
import { currentActor } from "../lib/request-context.js";

export function linkOrigin(req: Request): string {
  return publicBaseUrl() || `${req.protocol}://${req.get("host") ?? ""}`;
}

/** A link to a page of the app for the BODY of a message, or null when this
 *  instance cannot say where it lives. A relative path in a mail is not a
 *  link (#7543): the sender names the address (public, else the one the
 *  request that began this work came in on) or leaves the link out. */
export function emailableUrl(path: string): string | null {
  if (/^https?:\/\//.test(path)) return path;
  const origin = (publicBaseUrl() || currentActor()?.linkOrigin || "").replace(/\/+$/, "");
  return origin ? `${origin}/${path.replace(/^\/+/, "")}` : null;
}

/** Said in place of a link a message cannot carry. */
export const NO_ADDRESS_NOTE = "(No link: this server has not been told its public address.)";

/** A sentence that points at a page: ends with the page's whole address, or
 *  says plainly that there is none to give. */
export function pointTo(sentence: string, url: string | null): string {
  return url ? `${sentence}:\n${url}` : `${sentence}. ${NO_ADDRESS_NOTE}`;
}
