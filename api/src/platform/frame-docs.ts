// A URL for a document that has to run inline scripts, so the browser applies
// the RESPONSE's policy instead of the page's.
//
// WHY THIS EXISTS (#3300). Three places build an iframe out of `srcdoc`: the
// member app player's custom block, the public surface's custom block, and the
// sandboxed file-preview renderer. Each embeds inline script: the author's, or
// the renderer's bundle, plus our SDK. A `srcdoc` (or `blob:`, or `data:`)
// document INHERITS the embedder's policy, and a `<meta http-equiv>` policy
// written inside it can only narrow that further. So the day the app's
// `script-src 'self'` is enforced, every one of those frames stops running --
// every custom app and every installed renderer, at once.
//
// A nonce cannot help: nonces do not cross into an inherited-policy document,
// and the frame is built client-side anyway. A hash cannot help: a custom
// block's HTML is written by the person who made the app. The way out is the
// one the spec leaves open -- serve the document from a URL, where the browser
// applies the policy on the RESPONSE.
//
// WHAT IS STORED, AND WHY THE ECHO IS SAFE. The composer stays where it is (in
// the client, one copy) and hands the finished document here; this hands back a
// one-shot URL. The document is served with:
//
//   Content-Security-Policy: sandbox allow-scripts; default-src 'none';
//                            script-src 'unsafe-inline'; style-src 'unsafe-inline';
//                            img-src data: blob:; font-src data:
//
// The CSP `sandbox` directive is the load-bearing one: it puts the document in
// an OPAQUE ORIGIN even if somebody opens the URL at the top level rather than
// in our iframe, so it can never read a token, a cookie or our DOM. Without
// `allow-forms`, `allow-popups` or `allow-top-navigation` it cannot post
// anywhere or move the tab, and with `default-src 'none'` it cannot phone home.
// It is also inert to the person who requests it: the only way to get a ticket
// is to already be able to put that HTML in an app block or a renderer, so
// echoing it back adds no capability anybody did not have.
//
// One shot, one minute, in memory, capped. A ticket is 32 random bytes; losing
// one leaks a document its holder could already see.
import { randomBytes } from "node:crypto";

export type FrameKind = "app-block" | "renderer";

interface Ticket {
  html: string;
  kind: FrameKind;
  expires: number;
}

/** A minute is longer than a frame takes to load and shorter than a person
 *  keeps a tab open. */
const TTL_MS = 60_000;
/** Enough for a page of blocks several times over; beyond that something is
 *  wrong and the oldest go rather than the process. */
const MAX_OPEN = 500;
/** A custom block or a renderer bundle is kilobytes. A megabyte is generous and
 *  keeps a mistake from becoming a memory leak. */
const MAX_BYTES = 1_000_000;

const tickets = new Map<string, Ticket>();

function sweep(now = Date.now()): void {
  for (const [id, t] of tickets) if (t.expires <= now) tickets.delete(id);
  // Oldest first if still over the cap: a flood must not evict nothing.
  while (tickets.size > MAX_OPEN) {
    const oldest = tickets.keys().next().value;
    if (oldest === undefined) break;
    tickets.delete(oldest);
  }
}

export class FrameDocTooLarge extends Error {}

/** Stash a document; returns the ticket its URL carries. */
export function putFrameDoc(html: string, kind: FrameKind): string {
  if (Buffer.byteLength(html, "utf8") > MAX_BYTES) throw new FrameDocTooLarge("frame document too large");
  sweep();
  const id = randomBytes(32).toString("base64url");
  tickets.set(id, { html, kind, expires: Date.now() + TTL_MS });
  return id;
}

/** Spend a ticket. Null for unknown, expired or already-used — the three are
 *  one answer on purpose, so a spent ticket cannot be told from a wrong one. */
export function takeFrameDoc(id: string): { html: string; kind: FrameKind } | null {
  sweep();
  const t = tickets.get(id);
  if (!t) return null;
  tickets.delete(id);
  return { html: t.html, kind: t.kind };
}

/** The policy a frame document is served with. `sandbox` first, because it is
 *  what makes the rest safe on our own origin. */
export function frameDocPolicy(kind: FrameKind): string {
  const common = [
    // No allow-same-origin: an opaque origin however the URL is opened.
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  // The renderer draws file bytes it was handed; the app block shows images the
  // app already resolved. Neither may reach the network: they get what they
  // were given.
  return [...common, kind === "renderer" ? "img-src data: blob:" : "img-src data: blob: 'self'"].join("; ");
}

/** For tests: how many tickets are open. */
export function _openFrameDocs(): number {
  sweep();
  return tickets.size;
}
