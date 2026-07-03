// Open/download a Bearer-authed file from a browser event. A plain
// <a href=".../raw"> carries no Authorization header (Cobblr auth is
// Bearer-only) and 401s — the class of bug behind the 2026-07-03 "/files is
// all broken images" report. Enforced by scripts/lint-authed-media.ts:
// images use useImageSrc, previews use <FilePreview>, downloads use this.

import { api } from "./api";

/** Fetch the file with the token, hand the browser an object URL, open it in
 *  a new tab. Revokes after a grace period. */
export async function openAuthedFile(slug: string, id: string): Promise<void> {
  const token = localStorage.getItem("cobblr.token");
  const res = await fetch(api.fileRawUrl(slug, id, "original"), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
