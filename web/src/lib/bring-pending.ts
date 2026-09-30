// A sandbox's file on its way into this deployment: the link from the
// "Continue on Cobblr" button, held through the sign-up or sign-in in between
// (the shape of carry-pending.ts, for a backup file instead of a trial grant).
const KEY = "cobblr.bring.pending";
/** The file lives this long on the box that made it; nothing to hold past it. */
const MAX_AGE_MS = 8 * 86_400_000;

export function holdBring(file: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ file, at: Date.now() }));
  } catch {
    /* private window: the address still carries it */
  }
}

export function pendingBring(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { file?: unknown; at?: unknown };
    if (typeof v.file !== "string" || typeof v.at !== "number") return null;
    if (Date.now() - v.at > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return v.file;
  } catch {
    return null;
  }
}

export function dropBring(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing held */
  }
}

/** The file this page arrived with (held for the sign-up in between), or the
 *  one held from before it. */
export function takeBringFile(search: string): string | null {
  const file = new URLSearchParams(search).get("file");
  if (file) holdBring(file);
  return file ?? pendingBring();
}
