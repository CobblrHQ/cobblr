// A Paperless-ngx that answers the handful of REST calls Cobblr makes, and a
// person's bridge that carries those calls to it, for the documents tests.
//
// The Paperless is told its address is on a home network (192.168.77.5): the
// api can only reach it through the bridge, which is this test process
// answering the shared relay as that person, as a real bridge does. Every
// request the Paperless sees, and the Authorization it came with, is kept.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { relayPoll, relayRespond, relayTouch } from "../src/platform/edge.js";

export const LAN_ADDRESS = "http://192.168.77.5:8000";

export interface FakeDoc {
  id: number;
  title: string;
  created_date?: string;
  tags?: number[];
  content?: string;
  added?: string;
}

export interface FakePaperless {
  url: string;
  seen: Array<{ method: string; path: string; authorization: string | undefined; body: string }>;
  docs: FakeDoc[];
  patched: Array<{ id: number; body: unknown }>;
  close(): Promise<void>;
}

export async function startFakePaperless(token: string, docs: FakeDoc[], tags: Record<number, string> = {}): Promise<FakePaperless> {
  const seen: FakePaperless["seen"] = [];
  const patched: FakePaperless["patched"] = [];
  const fields: Array<{ id: number; name: string; data_type: string }> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "GET", path: req.url ?? "/", authorization: req.headers.authorization, body });
      const json = (status: number, v: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.setHeader("x-version", "2.15.0");
        res.end(JSON.stringify(v));
      };
      if (req.headers.authorization !== `Token ${token}`) return json(401, { detail: "Invalid token." });
      const u = new URL(req.url ?? "/", "http://x");
      const one = /^\/api\/documents\/(\d+)\/$/.exec(u.pathname);
      if (u.pathname === "/api/documents/" && req.method === "GET") {
        const q = (u.searchParams.get("query") ?? "").toLowerCase().replace(/"/g, "");
        const words = q.split(/\s+/).filter(Boolean);
        const since = u.searchParams.get("added__gt");
        const hits = docs.filter((d) => {
          if (since) return !!d.added && d.added > since;
          if (!words.length) return true;
          const text = `${d.title} ${d.content ?? ""}`.toLowerCase();
          return words.every((w) => text.includes(w));
        });
        return json(200, { count: hits.length, results: hits });
      }
      if (one && req.method === "GET") {
        const d = docs.find((x) => x.id === Number(one[1]));
        return d ? json(200, { ...d, custom_fields: [] }) : json(404, { detail: "Not found." });
      }
      if (one && req.method === "PATCH") {
        patched.push({ id: Number(one[1]), body: JSON.parse(body || "{}") });
        return json(200, { id: Number(one[1]) });
      }
      if (u.pathname === "/api/tags/") {
        const ids = (u.searchParams.get("id__in") ?? "").split(",").map(Number);
        return json(200, { results: ids.filter((i) => tags[i]).map((i) => ({ id: i, name: tags[i] })) });
      }
      if (u.pathname === "/api/custom_fields/" && req.method === "GET") return json(200, { results: fields });
      if (u.pathname === "/api/custom_fields/" && req.method === "POST") {
        const f = { id: fields.length + 1, ...(JSON.parse(body || "{}") as { name: string; data_type: string }) };
        fields.push(f);
        return json(201, f);
      }
      return json(404, { detail: "Not found." });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, docs, patched, close: () => new Promise((r) => server.close(() => r())) };
}

/** Be this person's bridge: carry every call for the home-network address to
 *  the fake library (Paperless, RomM) and bring its answer back. Returns how many calls it
 *  carried, and a stop. */
export async function runBridge(key: string, paperless: { url: string }, lan = LAN_ADDRESS): Promise<{ carried: () => number; stop: () => Promise<void> }> {
  const ac = new AbortController();
  let carried = 0;
  await relayTouch(key);
  const loop = (async () => {
    while (!ac.signal.aborted) {
      const item = await relayPoll(key, { signal: ac.signal }).catch(() => null);
      if (!item) continue;
      const base = item.source?.baseUrl ?? "";
      if (!base.startsWith(lan)) {
        await relayRespond(key, { id: item.id, status: 403, body: { error: "bridge_allowlist" } });
        continue;
      }
      carried++;
      const body = item.body === undefined || item.body === null ? undefined : typeof item.body === "string" ? item.body : JSON.stringify(item.body);
      const res = await fetch(`${paperless.url}${item.path}`, { method: item.method ?? "GET", headers: item.source?.headers ?? {}, ...(body ? { body } : {}) });
      // A picture crosses the relay the way the real bridge sends it.
      const ctype = res.headers.get("content-type") ?? "";
      if (/^image\//.test(ctype)) {
        const data = Buffer.from(await res.arrayBuffer()).toString("base64");
        await relayRespond(key, { id: item.id, status: res.status, body: { __binary: true, contentType: ctype, data_b64: data } });
        continue;
      }
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      await relayRespond(key, { id: item.id, status: res.status, body: parsed, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
    }
  })();
  return {
    carried: () => carried,
    stop: async () => {
      ac.abort();
      await loop;
    },
  };
}

