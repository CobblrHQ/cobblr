// Turn a composed iframe document into a URL the browser will apply its OWN
// policy to (#3300).
//
// An iframe built from `srcdoc` inherits the embedding page's
// Content-Security-Policy, and a `<meta>` policy inside it can only narrow that
// further. So the day the app's `script-src 'self'` is enforced, every custom
// app block and every installed file renderer stops running, because each of
// them is inline script by nature: the author's, or the renderer's bundle. A
// nonce cannot cross into an inherited-policy document and a hash cannot pin
// HTML somebody else writes.
//
// Serving the document from a URL is the way out the spec leaves open. These
// two calls hand the finished document to the api and get back a one-shot URL,
// served under a strict sandboxed policy of its own (see
// api/src/platform/frame-docs.ts). The composer stays where it is: one copy,
// in the component that knows what the document should say.
import { api } from "./api";

export type FrameKind = "app-block" | "renderer";

/** For a signed-in page. */
export async function frameDocUrl(html: string, kind: FrameKind): Promise<string> {
  const r = await api.createFrameDoc(html, kind);
  return r.url;
}

/** For the public surface, which has no session: the surface token is the
 *  gate, exactly as it is for the page itself. */
export async function publicFrameDocUrl(surfaceToken: string, html: string): Promise<string> {
  const res = await fetch(`/api/v1/public/${encodeURIComponent(surfaceToken)}/frame-docs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ html, kind: "app-block" }),
  });
  if (!res.ok) throw new Error(`frame document refused (${res.status})`);
  const d = (await res.json()) as { url: string };
  return d.url;
}
