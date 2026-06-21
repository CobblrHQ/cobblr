// Bambu Cloud HTTP client — login, 2FA / email-verify, and printer discovery.
// Plain HTTPS (no MQTT), so it lives in core and powers the "Bambu Lab" connect
// wizard: the user logs in with their Bambu account, we list their printers and
// pull each printer's LAN access code from the account (so they never type it).
//
// Protocol mirrors the Home Assistant integration's pybambu cloud client (the
// API is undocumented + reverse-engineered). The risky, shape-sensitive logic
// (URL/region, response parsing, JWT username) is split into PURE functions so
// it unit-tests without the network; the live client is a thin fetch shell.
//
// ⚠️ Cloudflare: Bambu's API sits behind Cloudflare, which fingerprints clients.
// pybambu uses browser-TLS impersonation. We send the same agent User-Agent and
// detect a Cloudflare block so the wizard can show a clear error rather than a
// mystery 403. Whether Node's TLS clears Cloudflare is the key live-verify risk.

// ── Regions ──────────────────────────────────────────────────────────────────
export const BAMBU_REGIONS = ["North America", "Europe", "Asia Pacific", "China", "Other"] as const;
export type BambuRegion = (typeof BAMBU_REGIONS)[number];

const BAMBU_URLS = {
  login: "https://api.bambulab.com/v1/user-service/user/login",
  tfaLogin: "https://bambulab.com/api/sign-in/tfa",
  emailCode: "https://api.bambulab.com/v1/user-service/user/sendemail/code",
  bind: "https://api.bambulab.com/v1/iot-service/api/user/bind",
  preference: "https://api.bambulab.com/v1/design-user-service/my/preference",
  tasks: "https://api.bambulab.com/v1/user-service/my/tasks",
} as const;
type BambuUrlKey = keyof typeof BAMBU_URLS;

/** Region rewrites the host: China uses the `.cn` mirror, everyone else `.com`. */
export function bambuUrl(key: BambuUrlKey, region: BambuRegion): string {
  const base = BAMBU_URLS[key];
  return region === "China" ? base.replace(".com", ".cn") : base;
}

/** Cloud MQTT broker host for a region (used by the Phase-2 overlay pump). */
export function bambuMqttHost(region: BambuRegion): string {
  return region === "China" ? "cn.mqtt.bambulab.com" : "us.mqtt.bambulab.com";
}

// ── Pure parsers ─────────────────────────────────────────────────────────────
export type BambuLoginResult =
  | { kind: "token"; accessToken: string }
  | { kind: "needEmailCode" }
  | { kind: "needTfa"; tfaKey: string }
  | { kind: "error"; detail: string };

/** Parse the /login response: a token, or a challenge (email code / 2FA). */
export function parseLoginResponse(json: unknown): BambuLoginResult {
  const j = (json ?? {}) as Record<string, unknown>;
  const token = typeof j.accessToken === "string" ? j.accessToken : "";
  if (token) return { kind: "token", accessToken: token };
  const loginType = j.loginType;
  if (loginType === "verifyCode") return { kind: "needEmailCode" };
  if (loginType === "tfa") return { kind: "needTfa", tfaKey: String(j.tfaKey ?? "") };
  return { kind: "error", detail: "Unexpected login response from Bambu" };
}

/** A printer as the account knows it — carries the LAN access code + model. */
export interface BambuCloudDevice {
  dev_id: string;         // serial
  name: string;
  online: boolean;
  print_status?: string;
  model?: string;         // dev_product_name ("A1", "X1 Carbon")
  access_code?: string;   // dev_access_code — the LAN password, auto-discovered
  nozzle_diameter?: number;
}

export function parseDevices(json: unknown): BambuCloudDevice[] {
  const arr = (json as { devices?: unknown })?.devices;
  if (!Array.isArray(arr)) return [];
  return arr.map((d) => {
    const o = (d ?? {}) as Record<string, unknown>;
    return {
      dev_id: String(o.dev_id ?? ""),
      name: String(o.name ?? "Bambu printer"),
      online: o.online === true,
      print_status: typeof o.print_status === "string" ? o.print_status : undefined,
      model: typeof o.dev_product_name === "string" ? o.dev_product_name : (typeof o.dev_model_name === "string" ? o.dev_model_name : undefined),
      access_code: typeof o.dev_access_code === "string" ? o.dev_access_code : undefined,
      nozzle_diameter: typeof o.nozzle_diameter === "number" ? o.nozzle_diameter : undefined,
    };
  }).filter((d) => d.dev_id);
}

/** The MQTT username is `u_<uid>`, encoded in the JWT's 2nd segment as
 *  `username`. Returns null when the token isn't a JWT (caller falls back to the
 *  preference API). */
export function usernameFromToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { username?: unknown };
    return typeof payload.username === "string" ? payload.username : null;
  } catch {
    return null;
  }
}

/** Pull the `token` cookie value out of Set-Cookie headers (the 2FA path returns
 *  the token there, not in the body). */
export function tokenFromSetCookie(setCookies: string[]): string | null {
  for (const c of setCookies) {
    const m = /(?:^|;\s*)token=([^;]+)/.exec(c);
    if (m) return decodeURIComponent(m[1]!);
  }
  return null;
}

// ── Live client (thin fetch shell) ───────────────────────────────────────────
// Matches pybambu's agent User-Agent; Cloudflare may still block Node's TLS.
const AGENT_UA = "bambu_network_agent/01.09.05.01";

export class BambuCloudError extends Error {
  constructor(message: string, readonly cloudflare = false) { super(message); this.name = "BambuCloudError"; }
}

async function bambuPost(url: string, body: unknown, auth?: string): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": AGENT_UA, "Content-Type": "application/json", Accept: "application/json" };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new BambuCloudError(`Bambu Cloud unreachable: ${(e as Error).message}`);
  }
  if ((res.status === 403 || res.status === 429)) {
    const txt = await res.text().catch(() => "");
    if (/cloudflare/i.test(txt)) throw new BambuCloudError("Blocked by Bambu's Cloudflare protection", true);
  }
  return res;
}

async function bambuGet(url: string, auth: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers: { "User-Agent": AGENT_UA, Accept: "application/json", Authorization: `Bearer ${auth}` } });
  } catch (e) {
    throw new BambuCloudError(`Bambu Cloud unreachable: ${(e as Error).message}`);
  }
  if (res.status === 403 || res.status === 429) {
    const txt = await res.text().catch(() => "");
    if (/cloudflare/i.test(txt)) throw new BambuCloudError("Blocked by Bambu's Cloudflare protection", true);
  }
  return res;
}

export class BambuCloud {
  constructor(private region: BambuRegion) {}

  /** Step 1 — email+password. Returns a token, or a challenge to satisfy. */
  async login(email: string, password: string): Promise<BambuLoginResult> {
    const res = await bambuPost(bambuUrl("login", this.region), { account: email, password, apiError: "" });
    if (res.status >= 500) throw new BambuCloudError(`Bambu login failed (${res.status})`);
    return parseLoginResponse(await res.json().catch(() => ({})));
  }

  /** Ask Bambu to email a fresh verification code (the `verifyCode` path). */
  async requestEmailCode(email: string): Promise<void> {
    await bambuPost(bambuUrl("emailCode", this.region), { email, type: "codeLogin" });
  }

  /** Step 2a — submit the emailed code → access token. */
  async submitEmailCode(email: string, code: string): Promise<string> {
    const res = await bambuPost(bambuUrl("login", this.region), { account: email, code });
    const j = (await res.json().catch(() => ({}))) as { accessToken?: string; code?: number };
    if (res.status === 400) {
      if (j.code === 1) throw new BambuCloudError("That code expired — request a new one");
      if (j.code === 2) throw new BambuCloudError("That code was incorrect");
      throw new BambuCloudError("Verification failed");
    }
    if (!j.accessToken) throw new BambuCloudError("No token returned after code");
    return j.accessToken;
  }

  /** Step 2b — submit the 2FA code (token arrives as a Set-Cookie). */
  async submitTfaCode(tfaKey: string, code: string): Promise<string> {
    const res = await bambuPost(bambuUrl("tfaLogin", this.region), { tfaKey, tfaCode: code });
    const token = tokenFromSetCookie(res.headers.getSetCookie?.() ?? []);
    if (!token) throw new BambuCloudError("2FA accepted but no token returned");
    return token;
  }

  /** List the account's printers (each carries its LAN access code). */
  async listDevices(token: string): Promise<BambuCloudDevice[]> {
    const res = await bambuGet(bambuUrl("bind", this.region), token);
    if (!res.ok) throw new BambuCloudError(`Couldn't list printers (${res.status})`);
    return parseDevices(await res.json().catch(() => ({})));
  }

  /** Raw cloud print-history (model name, cover, weight, time, status, …). Full
   *  JSON kept verbatim — best-effort; returns { error } on a non-ok response. */
  async rawTasks(token: string, limit = 30): Promise<unknown> {
    const res = await bambuGet(`${bambuUrl("tasks", this.region)}?limit=${limit}`, token);
    if (!res.ok) return { error: res.status, where: "tasks" };
    return (await res.json().catch(() => ({}))) as unknown;
  }

  /** Resolve the MQTT username (`u_<uid>`) for the Phase-2 cloud pump. */
  async resolveUsername(token: string): Promise<string | null> {
    const fromJwt = usernameFromToken(token);
    if (fromJwt) return fromJwt;
    const res = await bambuGet(bambuUrl("preference", this.region), token);
    if (!res.ok) return null;
    const uid = ((await res.json().catch(() => ({}))) as { uid?: unknown }).uid;
    return uid != null ? `u_${uid}` : null;
  }
}
