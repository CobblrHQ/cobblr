// One-shot heal: publish the open action for library pairings made before an
// outside pairing result had a presentation.
//
// DONE WHEN: no entity_pairings row with relationship_kind = 'library-item'
// lacks metadata.result where its tenant's matching core_documents_linked row
// has open_url. Check prod, staging and dev, then delete this file and its
// onBoot call.
//
// BORN WITH: service.ts passes libraryPairingPresentation to pairings.create,
// so every new link with an outside address carries the action immediately.
//
// WHY IT EXISTS: the Libraries panel kept open_url in its own linked row, but
// Cobb and MCP read the generic pairing. They got the title in notes and no
// address, so a correct answer named a Paperless document with nothing to
// open (#4545).

import { platform, type PlatformPairings } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { Db } from "./matching.js";
import { LIBRARY_ITEM_KIND, LIBRARY_LINK_REL, libraryTargetId } from "@cobblr/platform-contract/library";
import { libraryPairingPresentation } from "./pairing-presentation.js";

export async function healLibraryPairingPresentations(orgId: string, db: Db, since: Date, pairings: PlatformPairings = platform().pairings): Promise<number> {
  const rows = await db
    .selectFrom("core_documents_linked")
    .select(["record_kind", "record_id", "connection_id", "ref", "title", "open_url", "open_label"])
    .where("open_url", "is not", null)
    .where("linked_at", "<", since)
    .execute();
  let updated = 0;
  for (const row of rows) {
    const presentation = libraryPairingPresentation(row);
    if (!presentation) continue;
    const out = await pairings.present({
      orgId,
      sourceKind: row.record_kind,
      sourceId: row.record_id,
      targetKind: LIBRARY_ITEM_KIND,
      targetId: libraryTargetId(row.connection_id, row.ref),
      relationshipKind: LIBRARY_LINK_REL,
      presentation,
    });
    updated += out.updated;
  }
  return updated;
}

export function registerLibraryPairingPresentationHeal(): void {
  registerHealPass({
    name: "core-documents.heal-pairing-presentations",
    since: "2026-10-03T10:11:19Z",
    shim: "modules/core-documents/src/heal-pairing-presentations.ts",
    module: "core-documents",
    visit: ({ orgId, db, since }) => healLibraryPairingPresentations(orgId, db as Db, since),
  });
}
