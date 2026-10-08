export interface StoredSecretField {
  __cobblr_secret: 1;
  ciphertext: string;
  key_id?: string;
  creator_id?: string | null;
  kind?: string;
  base_kind?: string;
  has_value?: boolean;
}

export interface MaskedSecretField {
  secret: true;
  has_value: boolean;
  can_reveal?: boolean;
  kind?: string;
  record_id?: string;
  field?: string;
}

export function isStoredSecret(value: unknown): value is StoredSecretField {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as StoredSecretField).__cobblr_secret === 1
    && typeof (value as StoredSecretField).ciphertext === "string";
}

export function isMaskedSecret(value: unknown): value is MaskedSecretField {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as MaskedSecretField).secret === true
    && typeof (value as MaskedSecretField).has_value === "boolean";
}

export interface SecretReadContext {
  role: string;
  userId: string;
  held: ReadonlySet<string>;
  scopes: ReadonlyMap<string, string>;
  kind?: string;
  recordId?: string;
  field?: string;
}

export function maskSecretValues(value: unknown, context?: SecretReadContext): unknown {
  if (isStoredSecret(value)) {
    const kind = value.kind ?? context?.kind;
    const id = context?.recordId;
    const field = context?.field;
    return { secret: true, has_value: value.has_value !== false, can_reveal: !!(context && kind && id && field && mayRevealSecret({ role: context.role, userId: context.userId, creatorId: value.creator_id, capability: context.scopes.get(`${kind}\0${field}`) ?? context.scopes.get(`${value.base_kind ?? kind}\0${field}`) ?? context.scopes.get(field), held: context.held })), ...(kind && id && field ? { kind, record_id: id, field } : {}) } satisfies MaskedSecretField;
  }
  if (Array.isArray(value)) return value.map((child) => maskSecretValues(child, context));
  if (!value || typeof value !== "object" || value instanceof Date || value instanceof Uint8Array) return value;
  const record = value as Record<string, unknown>;
  const own = context ? { ...context, ...(typeof record.id === "string" ? { recordId: record.id } : {}), ...(typeof record.kind === "string" ? { kind: record.kind } : {}) } : undefined;
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, maskSecretValues(child, own ? { ...own, field: key } : undefined)]));
}

export function omitSecretValues(value: unknown): unknown {
  if (isStoredSecret(value) || isMaskedSecret(value)) return undefined;
  if (Array.isArray(value)) return value.map(omitSecretValues).filter((child) => child !== undefined);
  if (!value || typeof value !== "object" || value instanceof Date || value instanceof Uint8Array) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const safe = omitSecretValues(child);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

export function secretHistoryDiff(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return omitSecretValues(value);
  const diff = value as Record<string, unknown>;
  const safe = omitSecretValues(diff) as Record<string, unknown>;
  if (Array.isArray(diff.changes)) {
    safe.changes = diff.changes.map((change: unknown) => {
      if (!change || typeof change !== "object") return change;
      const c = change as Record<string, unknown>;
      if (isStoredSecret(c.from) || isStoredSecret(c.to) || isMaskedSecret(c.from) || isMaskedSecret(c.to)) {
        const { from: _from, to: _to, ...rest } = c;
        return { ...rest, secret: true };
      }
      return omitSecretValues(c);
    });
  }
  return safe;
}

export function mayRevealSecret(input: {
  role: string;
  userId: string;
  creatorId?: string | null;
  capability?: string | null;
  held: ReadonlySet<string>;
}): boolean {
  // role-gate: exact: secret access is explicitly limited to owner/admin, creator or the configured field capability.
  if (input.role === "owner" || input.role === "admin") return true;
  if (input.capability) return input.held.has(input.capability);
  return !!input.creatorId && input.creatorId === input.userId;
}
