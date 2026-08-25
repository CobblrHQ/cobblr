// The ONE private/link-local IP predicate, shared by every SSRF guard in the
// platform. It lives in the contract (not in the kernel) because modules cannot
// import api/src, and each place that needed this rule had grown its OWN copy —
// five of them, and they had DRIFTED: the kernel egress guard knew the Tailscale
// CGNAT range (100.64/10) but not multicast; the sandbox guard knew multicast
// but not the tailnet; the scan image guard and the integrations webhook guard
// knew neither. A hostname resolving into 100.64/10 was blocked by one path and
// waved through by another. See docs/history/2026-08-25-prerelease-audit.md B2.
//
// Pure and dependency-free (no node:net — the web bundle imports the contract),
// so it is safe everywhere and unit-testable in isolation. It answers "is this
// IP one we must never let a tenant/user URL reach"; the DNS resolution and the
// connection pinning that feed it live at each fetch site.

/** 4, 6, or 0 (not an IP literal). Pure — deliberately not node:net.isIP, which
 *  is absent in the browser. Accepts the common textual forms; a bracketed IPv6
 *  literal ("[::1]") should have its brackets stripped by the caller first. */
export function ipFamily(host: string): 4 | 6 | 0 {
  if (/^(\d{1,3})(\.\d{1,3}){3}$/.test(host)) {
    if (host.split(".").every((o) => Number(o) <= 255)) return 4;
    return 0;
  }
  // Any colon means IPv6 for our purposes (full, compressed, or v4-mapped).
  if (host.includes(":")) return 6;
  return 0;
}

/**
 * The embedded IPv4 of an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), as a
 * dotted string, or null if `ip` is not such an address.
 *
 * CRITICAL: `new URL(...).hostname` normalises a mapped literal to the HEX form
 * (`::ffff:169.254.169.254` becomes `::ffff:a9fe:a9fe`), and every SSRF guard
 * feeds this predicate `new URL(raw).hostname`. So the dotted form is essentially
 * never seen at runtime — handling ONLY it (the original bug) let
 * `::ffff:169.254.169.254`, `::ffff:127.0.0.1`, `::ffff:10.0.0.1`, `::ffff:100.64.0.1`
 * all slip through as "public". This decodes BOTH the dotted and the two-group
 * hex forms so the mapped v4 is judged on its real value.
 */
function mappedV4(ip: string): string | null {
  const low = ip.toLowerCase();
  if (!low.startsWith("::ffff:")) return null;
  const suffix = low.slice("::ffff:".length);
  if (ipFamily(suffix) === 4) return suffix; // dotted: ::ffff:1.2.3.4
  // Hex two-group form: ::ffff:hhhh:hhhh  → 4 bytes.
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(suffix);
  if (!m) return null;
  const hi = Number.parseInt(m[1]!, 16);
  const lo = Number.parseInt(m[2]!, 16);
  if (Number.isNaN(hi) || Number.isNaN(lo) || hi > 0xffff || lo > 0xffff) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Link-local and cloud-metadata ranges — ALWAYS blocked, on every deployment,
 *  self-host included (169.254.169.254 is the AWS/GCP metadata endpoint). */
export function isLinkLocalIp(ip: string): boolean {
  if (ip.startsWith("169.254.")) return true; // IPv4 link-local incl. metadata
  const low = ip.toLowerCase();
  return (
    low.startsWith("fe8") ||
    low.startsWith("fe9") ||
    low.startsWith("fea") ||
    low.startsWith("feb") // IPv6 link-local fe80::/10
  );
}

/**
 * The ALWAYS-blocked set, on every deployment including self-host: loopback,
 * the unspecified address, link-local + cloud metadata, multicast/reserved, and
 * the IPv6 loopback/ULA/link-local/multicast forms. Deliberately does NOT
 * include RFC1918 or the tailnet — a self-hoster legitimately reaches their own
 * 192.168 OctoPrint, so those are blocked only under the strict (cloud) policy,
 * which is `isPrivateIp`.
 *
 * A non-IP string returns true (fail closed): the caller passes a resolved IP
 * literal, and "I could not tell" must never mean "allowed".
 */
export function isDangerousIp(ip: string): boolean {
  if (!ip) return true;
  const fam = ipFamily(ip);
  if (fam === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
    if (a === 0) return true; //            0.0.0.0/8 "this network"
    if (a === 127) return true; //          loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a >= 224) return true; //           224.0.0.0/4 multicast + 240/4 reserved
    return false;
  }
  if (fam === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true; // loopback / unspecified
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA fc00::/7
    if (isLinkLocalIp(low)) return true; // fe80::/10
    if (low.startsWith("ff")) return true; // multicast ff00::/8
    const v4 = mappedV4(low);
    if (v4) return isDangerousIp(v4);
    return false;
  }
  return true; // not an IP literal — fail closed
}

/**
 * The strict (cloud / multi-tenant) block set: everything dangerous PLUS the
 * RFC1918 private ranges and the CGNAT/tailnet range. This is what a hosted
 * instance uses so a tenant URL can never reach the host's LAN, a co-located
 * stack, or the tailnet. The UNION of every rule the five prior copies had
 * between them, so nothing any one of them blocked can slip through here.
 */
export function isPrivateIp(ip: string): boolean {
  if (isDangerousIp(ip)) return true;
  const fam = ipFamily(ip);
  if (fam === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
    if (a === 10) return true; //           10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (Tailscale)
    return false;
  }
  if (fam === 6) {
    const low = ip.toLowerCase();
    // IPv4-mapped IPv6 (::ffff:a.b.c.d, incl. the hex form URL parsing emits) —
    // judge the embedded v4, so ::ffff:10.0.0.1 / ::ffff:100.64.0.1 / the
    // metadata endpoint are not a bypass.
    const v4 = mappedV4(low);
    if (v4) return isPrivateIp(v4);
    return false;
  }
  return true;
}
