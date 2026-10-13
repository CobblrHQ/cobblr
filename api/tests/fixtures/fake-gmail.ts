// A fake Google for the mail-source tests: the token endpoint, the revoke
// endpoint, and the four Gmail calls the source uses (profile, list, get,
// attachment), and the one a workspace's Gmail sender uses (send). It records every call, because what was FETCHED is the
// exposure the tests are about, and answers `q` the way Gmail does for the
// one operator the allowlist uses: `from:(a OR b) after:<epoch>`.
//
// In-process (node:http on an ephemeral port), no Express, no network.

import { createServer, type Server } from "node:http";

export interface FakeMail {
  id: string;
  from: string;
  subject: string;
  /** epoch ms */
  at: number;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; mime: string; bytes: Buffer }>;
}

export interface FakeGmail {
  base: string;
  mails: FakeMail[];
  /** Every message id handed to messages.get, in order. */
  fetched: string[];
  /** Every `q` received by messages.list. */
  queries: string[];
  refreshCalls: number;
  revoked: string[];
  /** Flip to make the token endpoint answer invalid_grant. */
  grantDead: boolean;
  /** Flip to make every Gmail call answer 503. */
  down: boolean;
  /** Every message handed to messages.send, as its raw RFC 5322 text. */
  sent: string[];
  close(): Promise<void>;
}

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString("base64url");
}

function matches(q: string, m: FakeMail): boolean {
  const from = /from:\(([^)]*)\)/.exec(q);
  const after = /after:(\d+)/.exec(q);
  if (!from) return false;
  const domains = from[1]!.split(/\s+OR\s+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const host = m.from.toLowerCase().split("@")[1] ?? "";
  const fromOk = domains.some((d) => host === d || host.endsWith(`.${d}`));
  const afterOk = !after || m.at >= Number(after[1]) * 1000;
  return fromOk && afterOk;
}

function toGmailJson(m: FakeMail) {
  const parts: unknown[] = [];
  if (m.text) parts.push({ mimeType: "text/plain", body: { data: b64url(m.text), size: m.text.length } });
  if (m.html) parts.push({ mimeType: "text/html", body: { data: b64url(m.html), size: m.html.length } });
  for (const [i, a] of (m.attachments ?? []).entries()) {
    parts.push({ mimeType: a.mime, filename: a.filename, body: { attachmentId: `att-${i}`, size: a.bytes.length } });
  }
  return {
    id: m.id,
    internalDate: String(m.at),
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: `Store <${m.from}>` },
        { name: "Subject", value: m.subject },
        { name: "Message-ID", value: `<${m.id}@fake.invalid>` },
      ],
      parts,
    },
  };
}

export async function startFakeGmail(mails: FakeMail[]): Promise<FakeGmail> {
  const state: FakeGmail = {
    base: "",
    mails,
    fetched: [],
    queries: [],
    refreshCalls: 0,
    revoked: [],
    grantDead: false,
    down: false,
    sent: [],
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (url.pathname === "/token" && req.method === "POST") {
        state.refreshCalls += 1;
        const form = new URLSearchParams(raw);
        if (state.grantDead) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        if (form.get("grant_type") === "authorization_code") {
          // An ID token naming the account, as Google sends one for openid email.
          const idToken = ["e30", b64url(JSON.stringify({ email: "person@example.test", email_verified: true })), "sig"].join(".");
          return json(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, id_token: idToken });
        }
        return json(200, { access_token: `access-${state.refreshCalls}`, expires_in: 3600 });
      }
      if (url.pathname === "/revoke" && req.method === "POST") {
        state.revoked.push(url.searchParams.get("token") ?? "");
        return json(200, {});
      }
      if (state.down) return json(503, { error: { message: "backend down" } });
      if (!(req.headers.authorization ?? "").startsWith("Bearer access-")) return json(401, { error: { message: "bad token" } });
      if (url.pathname === "/gmail/v1/users/me/profile") return json(200, { emailAddress: "person@example.test" });
      if (url.pathname === "/gmail/v1/users/me/messages/send" && req.method === "POST") {
        const body = JSON.parse(raw || "{}") as { raw?: string };
        state.sent.push(Buffer.from(body.raw ?? "", "base64url").toString());
        return json(200, { id: `sent-${state.sent.length}`, threadId: `sent-${state.sent.length}` });
      }
      if (url.pathname === "/gmail/v1/users/me/messages") {
        const q = url.searchParams.get("q") ?? "";
        state.queries.push(q);
        const hits = state.mails.filter((m) => matches(q, m)).sort((a, b) => b.at - a.at);
        // One page of two, so pagination is exercised on a three-mail box.
        const page = Number(url.searchParams.get("pageToken") ?? "0");
        const size = 2;
        const slice = hits.slice(page * size, page * size + size);
        const next = hits.length > (page + 1) * size ? String(page + 1) : undefined;
        return json(200, { messages: slice.map((m) => ({ id: m.id, threadId: m.id })), ...(next ? { nextPageToken: next } : {}), resultSizeEstimate: hits.length });
      }
      const att = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
      if (att) {
        const m = state.mails.find((x) => x.id === decodeURIComponent(att[1]!));
        const idx = Number((att[2] ?? "").replace("att-", ""));
        const a = m?.attachments?.[idx];
        if (!m || !a) return json(404, { error: { message: "not found" } });
        return json(200, { data: a.bytes.toString("base64url"), size: a.bytes.length });
      }
      const one = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
      if (one) {
        const id = decodeURIComponent(one[1]!);
        state.fetched.push(id);
        const m = state.mails.find((x) => x.id === id);
        if (!m) return json(404, { error: { message: "not found" } });
        return json(200, toGmailJson(m));
      }
      return json(404, { error: { message: `no route ${url.pathname}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  state.base = `http://127.0.0.1:${port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
