// What Ask Cobb says when its no-AI path cannot answer a message. A message
// the route refused is not one it failed to reach: a 2,550-character request
// was answered "I couldn't reach the assistant just now", the box emptied, and
// the person was told to connect AI for a limit that has nothing to do with AI
// (#7599). Only a request that never got an answer is "couldn't reach".
import { BASICS_MESSAGE_MAX } from "@cobblr/platform-contract/basics-limits";
import { ApiError } from "./api";

export const BASIC_UNREACHABLE =
  "I couldn't reach the assistant just now. For anything about your workspace, connect AI using the link at the top.";

const n = (v: number) => v.toLocaleString("en-US");

/** Why a message cannot be sent to the no-AI path as it is, or null. */
export function tooLongForBasics(text: string): string | null {
  return text.length > BASICS_MESSAGE_MAX
    ? `Without AI I read up to ${n(BASICS_MESSAGE_MAX)} characters, and this is ${n(text.length)}. Shorten it and send it again; it is still in the box.`
    : null;
}

/** The reply for a no-AI request that failed: the server's own words when it
 *  answered, "couldn't reach" only when nothing did. */
export function basicFailureReply(e: unknown): string {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && e.message ? e.message : BASIC_UNREACHABLE;
}
