// Password hashing — bcrypt with a deliberately costly factor (12 in prod).
// All password handling funnels through here so it's easy to bump the
// cost factor or swap algorithms.
//
// BCRYPT_COST overrides the factor — set low (e.g. 4) in CI ONLY, where the
// integration suite creates ~110 throwaway orgs and the prod-grade factor is
// pure wasted CPU. `||` (not `??`) so an empty compose value falls back to 12.

import bcrypt from "bcrypt";

const COST = Number(process.env.BCRYPT_COST) || 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
