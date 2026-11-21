// One-shot heal pass that only counts: pictures saved before every picture
// had to be a file in the workspace or an https address (#4115), in a machine's picture
// (machines_machines.image_path).
//
// DONE WHEN: no tenant DB holds such a picture. Check with, per tenant:
//   select count(*) from machines_machines where image_path <> '' and (image_path ~ '^\s*[\\/][\\/]' or (image_path ~* '^\s*[a-z][a-z0-9+.-]*:' and image_path !~* '^\s*https://'));
// /healthz reports the count (noteHealShim, through registerHealPass). When it
// reads 0 on prod, app, try and staging, delete this file and its onBoot call.
//
// BORN WITH: the route schemas take a picture through imagePathField and the
// entity writer through storedPicture, so a picture saved now passes the rule.
//
// WHY IT ONLY COUNTS: the picture is the person's own data, so it is neither
// rewritten nor deleted; every page draws it through useImageSrc, which shows
// the record's initial instead, until someone changes it.

import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { nonPictureCount } from "@cobblr/platform-contract/non-pictures";
import type { Kysely } from "kysely";

export function registerMachinesNonPicturesCount(): void {
  registerHealPass({
    name: "machines.count-non-pictures",
    since: "2026-11-22T00:00:00Z",
    shim: "modules/machines/src/count-non-pictures.ts",
    module: "machines",
    // Found and left: settled, so the workspace is not reopened every round.
    visit: async ({ db, since }) => ({ found: await nonPictureCount(db as Kysely<never>, "machines_machines", "image_path", since), settled: true }),
  });
}
