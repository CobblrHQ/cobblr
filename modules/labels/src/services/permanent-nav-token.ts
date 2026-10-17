// The one answer to "which token does this record's permanent label carry",
// for every print door: a wire's print (services/entity-qr.ts) and the label
// page's mint (api/qr-tokens.ts). A permanent label reuses only a token that
// will always open the record: a navigate token for a signed-in person, never
// revoked, never expiring. An expired or expiring token, a public one or a
// revoked one is passed over, so a fresh label never prints a QR that already
// fails, and an old revoked token cannot hide a newer usable one. The oldest
// usable token wins, so a reprint keeps the URL already on the shelf. Two
// prints at once for a record without one mint one token, not two.

import { platform } from "@cobblr/platform-contract";

export interface NavTokenRow {
  token: string;
  mode: string;
  auth: string;
  revoked_at: Date | string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
}

/** The token a permanent label may carry, from a record's navigate tokens; null when none qualifies. Pure. */
export function pickPermanentNavToken<T extends NavTokenRow>(rows: readonly T[]): T | null {
  const usable = rows.filter((r) => r.mode === "navigate" && r.auth === "session" && r.revoked_at == null && r.expires_at == null);
  usable.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.token.localeCompare(b.token));
  return usable[0] ?? null;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The record's permanent label token: reused when one qualifies, else minted
 *  once by `mint` (under a lock named for the record, re-checked inside it). */
export async function permanentNavToken<T extends NavTokenRow>(
  orgId: string,
  entityKind: string,
  entityId: string,
  mint: () => Promise<T>,
): Promise<{ row: T; reused: boolean }> {
  const meta = platform().db.meta as unknown as {
    selectFrom: (t: string) => { selectAll: () => { where: (c: string, o: string, v: unknown) => unknown } };
  };
  const find = async (): Promise<T | null> => {
    let q = meta.selectFrom("core_labels_qr_tokens").selectAll() as unknown as { where: (c: string, o: string, v: unknown) => typeof q; execute: () => Promise<T[]> };
    q = q.where("org_id", "=", orgId).where("entity_kind", "=", entityKind).where("entity_id", "=", entityId).where("mode", "=", "navigate");
    return pickPermanentNavToken(await q.execute());
  };
  for (let attempt = 0; attempt < 50; attempt++) {
    const found = await find();
    if (found) return { row: found, reused: true };
    let made: { row: T; reused: boolean } | null = null;
    const run = await platform().exclusive.run(`labels:permanent-nav:${orgId}:${entityKind}:${entityId}`, async () => {
      const again = await find();
      made = again ? { row: again, reused: true } : { row: await mint(), reused: false };
    });
    if (run.ran && made) return made;
    // Another print for this record holds the lock and is minting: read what it made.
    await pause(100);
  }
  throw new Error("Another print of this label is still minting its QR code. Try again.");
}
