// A random v4 UUID that works on every page Cobblr serves.
//
// crypto.randomUUID exists only in a secure context: HTTPS, or localhost. A
// self-hoster who opens Cobblr at http://192.168.1.20 has neither, and a record
// page that called it on mount crashed with "crypto.randomUUID is not a
// function". crypto.getRandomValues has no such restriction, so it backs the
// same format. Browser code takes ids from here (capability browser:random-id).
export function randomId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
