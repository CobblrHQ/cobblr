// Open a Bearer-authed file by its core-files id. A plain
// <a href=".../raw"> carries no Authorization header (Cobblr auth is
// Bearer-only) and 401s: the class of bug behind the 2026-07-03 "/files is
// all broken images" report and a Design's pattern PDF that never opened
// (#3753). Enforced by scripts/lint-authed-media.ts: images use useImageSrc,
// previews use <FilePreview>, opening a file uses this (or, in a module,
// openAuthedFile from @cobblr/platform-web, which this wraps).

import { openAuthedFile as openAuthedUrl, type OpenAuthedFileOptions } from "@cobblr/platform-web";
import { api } from "./api";

/** Call from the click handler itself. A PDF opens in the browser's viewer
 *  when its type or name says so. */
export function openAuthedFile(slug: string, id: string, opts: Pick<OpenAuthedFileOptions, "mime" | "filename"> = {}): Promise<boolean> {
  return openAuthedUrl(api.fileRawUrl(slug, id, "original"), opts);
}
