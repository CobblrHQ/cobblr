// One-shot heal: put back the Vault file names an upload mangled. Names only: a file's encrypted bytes aren't read.
//
// DONE WHEN: no vault_files row made before `since` has a name that mangledNameRepaired changes. Check prod, app, try
// and staging, then delete this file and its boot call. /healthz reports the count (noteHealShim, through registerHealPass).
//
// BORN WITH: nothing (a new workspace has no old documents, and the upload door now reads a name as UTF-8).
//
// WHY IT EXISTS: a name's UTF-8 bytes were read as Latin-1, so a document called "Résumé.pdf" read "RÃ©sumÃ©.pdf".

import { mangledNameRepaired } from "@cobblr/platform-contract/mangled-name";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { sql } from "kysely";
import { meta } from "../db/meta.js";

export async function healMangledVaultNames(orgId: string, since: Date): Promise<number> {
  let healed = 0;
  const rows = await meta.selectFrom("vault_files").select(["id", "name"]).where("org_id", "=", orgId).where("created_at", "<", since).where(sql<boolean>`name ~ '[^\\x01-\\x7f]'`).execute();
  for (const row of rows) {
    const fixed = mangledNameRepaired(row.name);
    if (!fixed) continue;
    await meta.updateTable("vault_files").set({ name: fixed }).where("id", "=", row.id).where("name", "=", row.name).execute();
    healed++;
  }
  return healed;
}

export function registerMangledVaultNamesHeal(): void {
  registerHealPass({
    name: "vault.mangled-names",
    since: "2026-11-06T02:00:00Z",
    shim: "api/src/platform/heal-mangled-vault-names.ts",
    visit: ({ orgId, since }) => healMangledVaultNames(orgId, since),
  });
}
