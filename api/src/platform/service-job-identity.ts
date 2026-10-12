import { createHash } from "node:crypto";

export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

/** Which asks are one job: the same work, by the same answerer, on the same
 *  input files, with its result going to the same place. Where the result is
 *  attached is part of what the job does, so the same document copied into a
 *  second record is a second job, never the first record's answer (#5873).
 *  An ask with nowhere to attach keeps the key it always had. */
export function serviceJobIdentity(p: {
  target: string;
  capability: string;
  input: unknown;
  fileHashes: Record<string, string>;
  attachTo?: { kind: string; id: string } | null;
  /** The person whose Vault keeps the outputs (#5871): kept there is never
   *  the same job as one whose output went to shared Files, or a failed
   *  attempt at it would be handed back. */
  vaultUser?: string | null;
  idempotencyKey?: string | null;
}): string {
  const parts: unknown[] = [p.target, p.capability, p.input ?? null, p.fileHashes, p.idempotencyKey ?? null];
  if (p.attachTo) parts.push({ attach_to: { kind: p.attachTo.kind, id: p.attachTo.id } });
  if (p.vaultUser) parts.push({ vault_user: p.vaultUser });
  return createHash("sha256").update(stableJson(parts)).digest("hex");
}
