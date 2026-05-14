// Password hashing — bcrypt with a deliberately costly factor (12).
// All password handling funnels through here so it's easy to bump the
// cost factor or swap algorithms.

import bcrypt from "bcrypt";

const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
