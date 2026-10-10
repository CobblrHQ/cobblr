// The consented cloud reader of a workspace's personal documents (#5621),
// as the router reads it. Its own file so the router can read it without
// importing the page's view (personal-documents-reader.ts).

import { meta } from "../db/meta.js";

export interface PersonalDocumentsReader {
  connection: string;
  providerId: string;
  /** The personal connection, or null for one of the workspace's own providers. */
  credentialId: string | null;
}

/** The consented cloud reader, or null: read on this machine only. Any error
 *  reads as null, the safe answer. */
export async function personalDocumentsReader(orgId: string): Promise<PersonalDocumentsReader | null> {
  try {
    const row = await meta.selectFrom("org_personal_documents_reader").select(["connection", "provider_id"]).where("org_id", "=", orgId).executeTakeFirst();
    if (!row) return null;
    return { connection: row.connection, providerId: row.provider_id, credentialId: row.connection.startsWith("workspace:") ? null : row.connection };
  } catch {
    return null;
  }
}
