// Thin web-app adapter for the shared platform-web ContentsPanel. The real,
// generic implementation now lives in @cobblr/platform-web so module UIs (e.g.
// inventory's part detail) can use the exact same panel — a module can't import
// from web/src. This adapter just supplies the web app's auth token so existing
// callers keep their `<ContentsPanel slug container title />` shape.

import { ContentsPanel as SharedContentsPanel } from "@cobblr/platform-web";
import { getToken } from "../lib/api";

export function ContentsPanel(props: {
  slug: string;
  container: { kind: string; id: string };
  title?: string;
  scanIntoHref?: string;
}) {
  return <SharedContentsPanel {...props} getToken={getToken} />;
}
