import type { UploadMiddleware, UploadOptions } from "./upload.js";
import { platform } from "@cobblr/platform-contract/platform-runtime";

/** A route's upload middleware through the one upload door
 *  (platform().http.upload), built on its first request so a module can
 *  declare its router before the platform is set. */
export function uploadOne(opts: UploadOptions): UploadMiddleware {
  let door: UploadMiddleware | null = null;
  return (req, res, next) => {
    door ??= platform().http.upload(opts);
    door(req, res, next);
  };
}
