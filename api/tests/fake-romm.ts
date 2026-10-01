// A RomM that answers the calls Cobblr makes (romm.app's REST API), for the
// outside-library tests: its games, its platforms, and a cover for each.
// Every request and the Authorization it came with is kept.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const ROMM_LAN_ADDRESS = "http://192.168.77.6:8080";

export interface FakeRom {
  id: number;
  name: string;
  platform_id: number;
  igdb_id?: number | null;
  first_release_date?: number | null;
  updated_at?: string;
}
export interface FakeRommPlatform {
  id: number;
  slug: string;
  display_name: string;
}

export interface FakeRomm {
  url: string;
  seen: Array<{ path: string; authorization: string | undefined }>;
  roms: FakeRom[];
  close(): Promise<void>;
}

// A one-pixel PNG: the cover RomM keeps for every game here.
const COVER = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export async function startFakeRomm(token: string, platforms: FakeRommPlatform[], roms: FakeRom[]): Promise<FakeRomm> {
  const seen: FakeRomm["seen"] = [];
  const shape = (r: FakeRom) => {
    const p = platforms.find((x) => x.id === r.platform_id)!;
    return {
      id: r.id,
      name: r.name,
      fs_name: `${r.name}.sfc`,
      fs_name_no_tags: r.name,
      igdb_id: r.igdb_id ?? null,
      platform_id: r.platform_id,
      platform_slug: p.slug,
      platform_display_name: p.display_name,
      path_cover_small: `/assets/romm/resources/roms/${r.platform_id}/${r.id}/cover/small.png`,
      url_cover: null,
      summary: null,
      metadatum: { first_release_date: r.first_release_date ?? null },
    };
  };
  const server: Server = createServer((req, res) => {
    seen.push({ path: req.url ?? "/", authorization: req.headers.authorization });
    const json = (status: number, v: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(v));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return json(403, { detail: "Forbidden" });
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/api/platforms") return json(200, platforms.map((p) => ({ ...p, name: p.display_name, fs_slug: p.slug })));
    if (u.pathname === "/api/roms") {
      const term = (u.searchParams.get("search_term") ?? "").toLowerCase();
      const scoped = u.searchParams.getAll("platform_ids").map(Number);
      const since = u.searchParams.get("updated_after");
      const limit = Number(u.searchParams.get("limit") ?? 50);
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const hits = roms.filter(
        (r) =>
          (!term || term.split(/\s+/).every((w) => r.name.toLowerCase().includes(w))) &&
          (!scoped.length || scoped.includes(r.platform_id)) &&
          // RomM stamps every ROM; one a test does not date was there all along.
          (!since || (r.updated_at ?? "2026-01-01T00:00:00Z") > since),
      );
      return json(200, { items: hits.slice(offset, offset + limit).map(shape), total: hits.length, limit, offset });
    }
    const one = /^\/api\/roms\/(\d+)$/.exec(u.pathname);
    if (one) {
      const r = roms.find((x) => x.id === Number(one[1]));
      return r ? json(200, shape(r)) : json(404, { detail: "Not found" });
    }
    if (u.pathname.startsWith("/assets/romm/resources/roms/")) {
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      return res.end(COVER);
    }
    return json(404, { detail: "Not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, roms, close: () => new Promise((r) => server.close(() => r())) };
}
