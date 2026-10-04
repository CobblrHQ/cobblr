const pending = new Map<string, Promise<void>>();

export async function serializeSpoolWrite(key: string, write: () => Promise<void>): Promise<void> {
  const previous = pending.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(write);
  pending.set(key, next);
  try { await next; } finally { if (pending.get(key) === next) pending.delete(key); }
}
