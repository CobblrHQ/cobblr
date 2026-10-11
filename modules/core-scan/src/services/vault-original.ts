// A personal document's original goes into the Vault (#5331, #5242): the
// folder of the person who brought it, encrypted, readable only by the people
// that folder lists. Filed when it is read; linked to its record (the car)
// when the record is known. The Vault refusing (a folder the person does not
// own, a document past its size) is said, never a failed filing; anything else
// is a fault and is thrown.

import { platform } from "@cobblr/platform-contract";

/** The Vault said no: its refusals carry a 4xx status and a code. */
export function isVaultRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

export type VaultKept = { kept: true; fileId: string; folderName: string } | { kept: false; why: string };

export async function keepInVault(
  orgId: string,
  userId: string,
  doc: { name: string; mimeType: string; bytes: Uint8Array; record?: { kind: string; id: string } | null },
): Promise<VaultKept> {
  try {
    const r = await platform().vault.file(orgId, userId, { name: doc.name, mimeType: doc.mimeType, bytes: doc.bytes, record: doc.record ?? null });
    return { kept: true, fileId: r.fileId, folderName: r.folderName };
  } catch (err) {
    if (!isVaultRefusal(err)) throw err;
    return { kept: false, why: (err as Error).message };
  }
}

/** Link a kept original to its record, once the record is known. False when
 *  the Vault refuses (the person who confirmed is not the folder's owner). */
export async function linkInVault(orgId: string, userId: string, fileId: string, record: { kind: string; id: string }): Promise<boolean> {
  try {
    await platform().vault.link(orgId, userId, fileId, record);
    return true;
  } catch (err) {
    if (!isVaultRefusal(err)) throw err;
    return false;
  }
}
